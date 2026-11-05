//! Server bootstrap: environment and credential loading, application state
//! construction for the deployed server and the filesystem preview, the
//! PostgreSQL reload listener, and `[server]` config resolution.

use super::*;

/// Server-side content-store connection params, from the env the systemd unit
/// sets. There is no filesystem fallback — `DATABASE_URL` is required.
pub(crate) struct StoreConfig {
    pub(crate) database_url: String,
    pub(crate) s3_endpoint: String,
    pub(crate) s3_bucket: String,
    pub(crate) s3_access_key: String,
    pub(crate) s3_secret_key: String,
}

pub(crate) fn store_config_from_env() -> Result<StoreConfig, String> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let database_url = env("DATABASE_URL").ok_or("DATABASE_URL not set")?;
    let s3_endpoint = env("LIVEVIEW_S3_ENDPOINT").unwrap_or_else(|| "http://127.0.0.1:9001".into());
    let s3_bucket = env("LIVEVIEW_S3_BUCKET").unwrap_or_else(|| "liveview".into());
    let access_file = env("LIVEVIEW_S3_ACCESS_KEY_FILE");
    let secret_file = env("LIVEVIEW_S3_SECRET_KEY_FILE");
    let s3_access_key = read_cred(
        "access",
        env("LIVEVIEW_S3_ACCESS_KEY"),
        access_file.as_deref().map(Path::new),
    )?;
    let s3_secret_key = read_cred(
        "secret",
        env("LIVEVIEW_S3_SECRET_KEY"),
        secret_file.as_deref().map(Path::new),
    )?;
    Ok(StoreConfig {
        database_url,
        s3_endpoint,
        s3_bucket,
        s3_access_key,
        s3_secret_key,
    })
}

/// Build the optional APM ingest sink. Telemetry is disabled unless an operator
/// explicitly supplies a VictoriaLogs-compatible endpoint. An authenticated
/// token is required unless unauthenticated ingest is separately opted into.
pub(crate) fn build_apm_sink() -> Option<ApmSink> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let base = env("LIVEVIEW_APM_VL_URL")?;
    let allow_unauthenticated = env("LIVEVIEW_APM_ALLOW_UNAUTHENTICATED")
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    let vl_url =
        format!("{base}?_msg_field=_msg&_time_field=client_ts&_stream_fields=device_id,event_type");
    let token = match env("LIVEVIEW_APM_TOKEN_FILE") {
        Some(f) => match std::fs::read_to_string(&f) {
            Ok(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
            Err(e) => {
                tracing::warn!(error = %e, file = %f, "apm disabled because token file is unreadable");
                return None;
            }
        },
        None => env("LIVEVIEW_APM_TOKEN"),
    };
    if token.is_none() && !allow_unauthenticated {
        tracing::warn!(
            "apm disabled without a token; explicitly allow unauthenticated ingest to override"
        );
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| tracing::warn!(error = %e, "apm http client build failed"))
        .ok()?;
    Some(ApmSink {
        client,
        vl_url,
        token,
    })
}

/// Listen for `liveview sync`'s `NOTIFY liveview_reload`; on each, reload the
/// catalog and broadcast the new sidebar tree so open readers refresh. Survives
/// connection drops (reconnect loop) so a postgres restart doesn't kill it.
///
/// NOTIFY is not durable: a sync that finishes while the listener is
/// disconnected is never delivered. So the connection loss is observed
/// explicitly (`try_recv` → `None`) and, once `LISTEN` is re-established, the
/// catalog is reloaded unconditionally to pick up anything missed meanwhile.
pub(crate) fn spawn_reload_listener(state: SharedState, database_url: String) {
    tokio::spawn(async move {
        let mut reconnecting = false;
        loop {
            let mut listener = match sqlx::postgres::PgListener::connect(&database_url).await {
                Ok(listener) => listener,
                Err(e) => {
                    tracing::warn!(error = %e, "reload listener connect failed");
                    reconnecting = true;
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            if let Err(e) = listener.listen("liveview_reload").await {
                tracing::warn!(error = %e, "reload listener LISTEN failed");
                reconnecting = true;
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
            // LISTEN is active again before this reload, so no notification can
            // fall into the gap between the reload and the subscription.
            if reconnecting {
                reload_catalog(&state, "catalog reloaded after listener reconnect").await;
            }
            reconnecting = true;
            loop {
                match listener.try_recv().await {
                    Ok(Some(_)) => reload_catalog(&state, "catalog reloaded after sync").await,
                    Ok(None) => {
                        tracing::warn!("reload listener connection lost; reconnecting");
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "reload listener receive failed");
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        break;
                    }
                }
            }
        }
    });
}

pub(crate) async fn reload_catalog(state: &AppState, reason: &'static str) {
    match Catalog::load(state.store.as_ref()).await {
        Ok(cat) => {
            *state.catalog.write().await = cat;
            broadcast_tree(state).await;
            tracing::info!("{reason}");
        }
        Err(e) => tracing::warn!(error = %e, "catalog reload failed"),
    }
}

/// Broadcast the current text sidebar tree as a `TreeUpdate` (the same shape
/// the old file-watcher sent) so connected clients refresh after a sync.
pub(crate) async fn broadcast_tree(state: &AppState) {
    if let Some(frame) = crate::server::ws::current_tree_message(state).await {
        let _ = state.tx.send(frame);
    }
}

pub(crate) async fn run(cli: Cli, server: config::ServerCfg) {
    // The config's [server] block supplies host/port/open; content comes from
    // the stores, not the filesystem.
    let host = cli.host.clone().unwrap_or(server.host);
    let port = cli.port.or(server.port);
    let should_open = cli.open || server.open;

    // Connect the content stores (env-configured; the systemd unit sets these).
    let conf = match store_config_from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("content store config error: {e}");
            std::process::exit(2);
        }
    };
    let pg = match PgStore::open(&conf.database_url).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("connect postgres: {e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = pg.migrate().await {
        eprintln!("migrate: {e}");
        std::process::exit(2);
    }
    // Concrete handles for the audio worker (the task queue + Merkle commit are
    // pg-specific, so the worker holds these rather than the trait objects).
    let worker_pg = pg.clone();
    let store: Arc<dyn crate::store::content::ContentStore> = Arc::new(pg);
    let objstore = ObjStore::connect(
        &conf.s3_endpoint,
        &conf.s3_access_key,
        &conf.s3_secret_key,
        &conf.s3_bucket,
    );
    if let Err(e) = objstore.ensure_bucket().await {
        eprintln!("rustfs bucket: {e}");
        std::process::exit(2);
    }
    let worker_obj = objstore.clone();
    let obj: Arc<dyn crate::store::content::BlobStore> = Arc::new(objstore);
    let catalog = match Catalog::load(store.as_ref()).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("load catalog: {e}");
            std::process::exit(2);
        }
    };
    tracing::info!(books = catalog.books.len(), "catalog loaded from postgres");

    let (tx, _rx) = broadcast::channel::<String>(64);
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let tts_cmd = env("LIVEVIEW_EDGE_TTS_CMD")
        .or_else(|| env("LIVEVIEW_KOKORO_TTS_CMD").map(|_| String::new()));
    let tts_voice = env("LIVEVIEW_TTS_VOICE");
    let book_end_phrases = load_book_end_phrases();

    // Drain the audio task queue only when an operator enabled a speech adapter.
    if let Some(command) = tts_cmd.clone() {
        crate::server::speech_worker::spawn(
            worker_pg.clone(),
            worker_obj.clone(),
            command.clone(),
            tx.clone(),
        );
        crate::server::audio_worker::spawn(worker_pg, worker_obj, command, tx.clone());
    } else {
        tracing::info!("speech synthesis disabled (no adapter is configured)");
    }

    let state: SharedState = Arc::new(AppState {
        tx,
        store,
        obj,
        catalog: RwLock::new(catalog),
        dag_cache: Default::default(),
        sizes_cache: Default::default(),
        contents_durations: Default::default(),
        tts_cmd,
        tts_voice,
        book_end_phrases,
        book_end_cue: Default::default(),
        audio_synth_locks: Default::default(),
        apm: build_apm_sink(),
    });

    // Reload the catalog + nudge clients when `liveview sync` issues NOTIFY.
    spawn_reload_listener(state.clone(), conf.database_url.clone());

    let app = match build_app(state) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("http policy: {error}");
            std::process::exit(2);
        }
    };
    serve_app(app, host, port, should_open).await;
}

/// `liveview preview` — serve ONE local corpus from the filesystem (no
/// pg/rustfs, no `sync`), rendering each chapter on demand with the SAME engines
/// as the deployed server. The reader URLs `liveview targets` emits resolve
/// here, so the chart-review visual QA needs no deploy.
pub(crate) async fn run_preview(args: cli::PreviewArgs) -> Result<(), String> {
    let resolved = resolve_config(args.config.as_deref())?;
    let host = args.host.clone().unwrap_or_else(|| resolved.host.clone());
    let book_count = resolved.books.len();

    // One FsStore instance backs BOTH traits: as `ContentStore` it renders
    // chapters + builds the catalog/tree; as `BlobStore` it serves the in-memory
    // assets it cached — so api_raw fetches the same bytes api_file referenced.
    let fs = Arc::new(crate::store::fs::FsStore::new(resolved.books));
    let store: Arc<dyn crate::store::content::ContentStore> = fs.clone();
    let obj: Arc<dyn crate::store::content::BlobStore> = fs;

    let catalog = Catalog::load(store.as_ref()).await?;
    tracing::info!(books = book_count, "filesystem preview — corpus resolved");

    let (tx, _rx) = broadcast::channel::<String>(64);
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let state: SharedState = Arc::new(AppState {
        tx,
        store,
        obj,
        catalog: RwLock::new(catalog),
        dag_cache: Default::default(),
        sizes_cache: Default::default(),
        contents_durations: Default::default(),
        tts_cmd: env("LIVEVIEW_EDGE_TTS_CMD"),
        tts_voice: env("LIVEVIEW_TTS_VOICE"),
        book_end_phrases: load_book_end_phrases(),
        book_end_cue: Default::default(),
        audio_synth_locks: Default::default(),
        // No VL to forward to in local preview — /api/ingest no-ops (accept + drop).
        apm: None,
    });

    let app = build_app(state)?;
    serve_app(app, host, args.port, args.open).await;
    Ok(())
}

/// Load the `[server]` settings (host/port/open) from the config WITHOUT
/// resolving the corpus — the server is filesystem-free (no /home access under
/// `ProtectHome`). Any load error falls back to defaults; the systemd unit
/// passes `--host`/`--port` explicitly anyway.
pub(crate) fn load_server_cfg(config: Option<&Path>) -> config::ServerCfg {
    let path = match config {
        Some(p) => Some(p.to_path_buf()),
        None => std::env::current_dir().ok().and_then(|d| auto_discover(&d)),
    };
    let Some(path) = path else {
        return config::ServerCfg::default();
    };
    match Config::load(&path) {
        Ok(c) => c.server,
        Err(e) => {
            tracing::warn!(error = %e, "config load failed; using server defaults");
            config::ServerCfg::default()
        }
    }
}

/// Resolve a corpus config: explicit path → cwd auto-discovery → implicit
/// single-mount fallback. Used by `liveview sync` (which needs the full corpus).
pub(crate) fn resolve_config(config: Option<&Path>) -> Result<Resolved, String> {
    if let Some(path) = config {
        return load_explicit(path);
    }
    let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
    if let Some(path) = auto_discover(&cwd) {
        tracing::info!("auto-discovered config: {}", path.display());
        return load_explicit(&path);
    }
    tracing::info!("no config found — falling back to implicit single-mount over cwd");
    implicit_resolved(&cwd)
}

pub(crate) fn load_explicit(path: &Path) -> Result<Resolved, String> {
    let cfg = Config::load(path)?;
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let dir = abs
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    cfg.resolve(&dir)
}
