mod artwork;
mod audio_optimize;
mod check;
mod cli;
mod config;
mod interactive_view;
mod server;
mod shared;
mod store;
mod sync;
mod tags;

use axum::{
    Extension, Router,
    body::Body,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use clap::Parser;
use cli::{Cli, Command};
use config::{Config, RenditionKind, Resolved, auto_discover, implicit_resolved};
use server::catalog::Catalog;
use server::state::{ApmSink, AppState, CachedJson, SharedState};
use shared::{FileContent, FileType, TreeNode, WsMessage};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use store::model::{ChapterRecord, ProgressEntry};
use store::pg::PgStore;
use sync::objstore::ObjStore;
use tokio::sync::{RwLock, broadcast};
use tracing_subscriber::EnvFilter;

#[cfg(feature = "embedded")]
mod embedded_assets {
    use axum::extract::Path;
    use axum::http::{StatusCode, header};
    use axum::response::{Html, IntoResponse};
    use include_dir::{Dir, include_dir};

    static DIST_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

    pub fn index_html() -> Option<&'static str> {
        DIST_DIR
            .get_file("index.html")
            .and_then(|f| f.contents_utf8())
    }

    /// Cache policy for a static asset. Content-hashed bundles (Vite stamps a
    /// hash into the filename) are immutable for a given name → cache hard.
    /// Everything else — above all `sw.js`, plus `index.html`, the manifest and
    /// icons — MUST revalidate: a stale `sw.js` is THE classic reason an
    /// installed iOS PWA never picks up a deploy. The PWA's `reg.update()`
    /// re-fetches `/sw.js`, but with no `Cache-Control` iOS serves it from its
    /// heuristic HTTP cache, the bytes look unchanged, and the whole
    /// (otherwise-correct) skipWaiting → controllerchange → reload chain never
    /// fires. `no-cache` = may store but must revalidate every time, so a
    /// redeploy is seen immediately.
    fn cache_control_for(path: &str) -> &'static str {
        if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }
    }

    fn serve_file(path: &str) -> impl IntoResponse + use<> {
        match DIST_DIR.get_file(path) {
            Some(file) => {
                let mime = mime_guess::from_path(path).first_or_octet_stream();
                (
                    StatusCode::OK,
                    [
                        (header::CONTENT_TYPE, mime.as_ref().to_string()),
                        (header::CACHE_CONTROL, cache_control_for(path).to_string()),
                    ],
                    file.contents(),
                )
                    .into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    pub async fn serve_assets(Path(path): Path<String>) -> impl IntoResponse {
        serve_file(&format!("assets/{}", path))
    }

    pub async fn serve_root(Path(path): Path<String>) -> impl IntoResponse {
        serve_file(&path)
    }

    // ── OTA web bundle (the iOS/macOS app's no-SW `dist-app`, staged into
    // `dist/app-bundle/` by the web build) ──────────────────────────────────
    // The shell's plugin downloads this on launch when the version changes, so the
    // web hot-updates WITHOUT an app reinstall.

    /// Walk the embedded `app-bundle/` tree → bundle-relative file paths.
    fn app_bundle_paths() -> Vec<String> {
        if let Some(paths) = DIST_DIR
            .get_file("app-bundle/manifest-files.json")
            .and_then(|file| file.contents_utf8())
            .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        {
            return paths;
        }

        fn walk(dir: &Dir, out: &mut Vec<String>) {
            for e in dir.entries() {
                match e {
                    include_dir::DirEntry::File(f) => {
                        if let Some(rel) = f
                            .path()
                            .to_str()
                            .and_then(|p| p.strip_prefix("app-bundle/"))
                        {
                            out.push(rel.to_string());
                        }
                    }
                    include_dir::DirEntry::Dir(d) => walk(d, out),
                }
            }
        }
        let mut out = Vec::new();
        if let Some(d) = DIST_DIR.get_dir("app-bundle") {
            walk(d, &mut out);
        }
        out
    }

    /// `GET /app-dist/manifest.json` — the OTA bundle's `version` (the content-hashed
    /// entry name, so it changes when the web app changes) + the full file list. The
    /// plugin compares `version` to its stored copy and downloads each file when it
    /// differs.
    /// The embedded app-bundle's version = the content-hashed entry-bundle name
    /// Vite stamps into `app-bundle/index.html`. Changes iff the shipped web app
    /// changes. Shared by the OTA manifest endpoint and the WS `AppVersion` push.
    pub fn app_bundle_version() -> String {
        DIST_DIR
            .get_file("app-bundle/index.html")
            .and_then(|f| f.contents_utf8())
            .and_then(super::entry_bundle)
            .unwrap_or_else(|| "0".to_string())
    }

    pub async fn app_dist_manifest(headers: axum::http::HeaderMap) -> impl IntoResponse {
        let version = app_bundle_version();
        // Cheap conditional probe: the client sends its current version as
        // If-None-Match; unchanged → 304 (a few bytes), no manifest body.
        if super::manifest_not_modified(&headers, &version) {
            return super::manifest_not_modified_response(&version);
        }
        let body = serde_json::json!({ "version": version, "files": app_bundle_paths() });
        (
            [
                (header::ETAG, super::manifest_etag(&version)),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
            axum::Json(body),
        )
            .into_response()
    }

    /// `GET /app-dist/<path>` — one OTA bundle file from the embedded `app-bundle/`.
    pub async fn serve_app_dist(Path(path): Path<String>) -> impl IntoResponse {
        let app_path = format!("app-bundle/{path}");
        if DIST_DIR.get_file(&app_path).is_some() {
            serve_file(&app_path).into_response()
        } else {
            // stage-app-bundle omits bytes identical to the PWA build. Serve
            // those from their shared root path while preserving the OTA URL.
            serve_file(&path).into_response()
        }
    }

    pub async fn serve_index() -> impl IntoResponse {
        match index_html() {
            // `no-cache`: the navigation entry point must revalidate so a deploy's
            // new bundle refs (and thus the new SW) reach the device — same reason
            // as `sw.js` in `cache_control_for`.
            Some(html) => ([(header::CACHE_CONTROL, "no-cache")], Html(html)).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }
}

/// `GET /api/version` — a build id the SPA polls after each WS reconnect (and when
/// the tab returns to the foreground) to notice a redeploy. We return the
/// content-hashed entry-bundle name Vite stamps into index.html
/// (`assets/index-<hash>.js`): it changes iff the shipped UI changes, so a tab
/// can compare it against the one it loaded with and, on a mismatch, surface the
/// blue "new version" banner that force-reloads on confirm. No hashing of our
/// own — the bundle name already IS a content hash. Mirrors cowboy's `/version`.
async fn version() -> Response {
    match index_html_source().as_deref().and_then(entry_bundle) {
        Some(v) => Json(serde_json::json!({ "version": v })).into_response(),
        None => (StatusCode::NOT_FOUND, "UI not built").into_response(),
    }
}

/// The current embedded app-bundle version, for the WS `AppVersion` push. `None`
/// in non-embedded dev builds (no compiled-in bundle → nothing to OTA).
#[cfg(feature = "embedded")]
fn app_version() -> Option<String> {
    Some(embedded_assets::app_bundle_version())
}
#[cfg(not(feature = "embedded"))]
fn app_version() -> Option<String> {
    None
}

/// Pull Vite's content-hashed entry-bundle name out of index.html. Returns e.g.
/// `assets/index-D4f8aB2c.js`.
fn entry_bundle(html: &str) -> Option<String> {
    let start = html.find("assets/index-")?;
    let end = html[start..].find(".js")?;
    Some(html[start..start + end + 3].to_owned())
}

/// Read the current index.html so `/version` can extract the bundle id. Embedded
/// builds (the deployed binary) read it from the compiled-in dist; dev builds
/// (`cargo run` without the `embedded` feature, behind `vite dev`) read it off
/// disk — there the bundle id only changes after a `vite build`, but the
/// endpoint stays well-defined in both modes.
#[cfg(feature = "embedded")]
fn index_html_source() -> Option<String> {
    embedded_assets::index_html().map(str::to_owned)
}

#[cfg(not(feature = "embedded"))]
fn index_html_source() -> Option<String> {
    std::fs::read_to_string("web/dist/index.html").ok()
}

fn main() {
    let cli = Cli::parse();

    let filter = if cli.verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(filter).init();

    // `liveview check` is fully synchronous + offline — handle it before
    // spinning up the tokio runtime, then exit with its status code.
    if let Some(Command::Check(args)) = cli.command.clone() {
        let code = check::run(&args.paths, args.format, args.deny_warnings);
        std::process::exit(code);
    }

    // `liveview gate` — offline production policy over checker + narration
    // diagnostics. It runs before Tokio like the underlying deterministic passes.
    if let Some(Command::Gate(args)) = cli.command.clone() {
        std::process::exit(check::gate::run(&args));
    }

    // `liveview targets` is likewise synchronous (resolve corpus → list charts).
    if let Some(Command::Targets(args)) = cli.command.clone() {
        std::process::exit(run_targets(&args));
    }

    // `liveview narrate-audit` — offline read-aloud playability dry-run (no model
    // calls, no synth), so it runs before the tokio runtime like `check`.
    if let Some(Command::NarrateAudit(args)) = cli.command.clone() {
        std::process::exit(check::readaloud::run(&args.paths, args.format));
    }

    // `liveview narrate-plan` — offline; emit the skill's to-generate narration list.
    if let Some(Command::NarratePlan(args)) = cli.command.clone() {
        std::process::exit(check::readaloud::plan_run(
            &args.paths,
            &args.lang,
            args.format,
        ));
    }

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");

    match cli.command.clone() {
        // `liveview sync` — reconcile the corpus into pg + rustfs.
        Some(Command::Sync(args)) => {
            if let Err(e) = rt.block_on(run_sync(args)) {
                eprintln!("sync error: {e}");
                std::process::exit(1);
            }
        }
        Some(Command::AudioOptimize(args)) => {
            if let Err(e) = rt.block_on(run_audio_optimize(args)) {
                eprintln!("audio-optimize error: {e}");
                std::process::exit(1);
            }
        }
        // `liveview check` / `targets` are handled (and exit) above, before the
        // runtime is built — they never reach this match.
        Some(Command::Check(_)) => unreachable!("check handled before the tokio runtime"),
        Some(Command::Gate(_)) => unreachable!("gate handled before the tokio runtime"),
        Some(Command::Targets(_)) => unreachable!("targets handled before the tokio runtime"),
        Some(Command::NarrateAudit(_)) => {
            unreachable!("narrate-audit handled before the tokio runtime")
        }
        Some(Command::NarratePlan(_)) => {
            unreachable!("narrate-plan handled before the tokio runtime")
        }
        // `liveview preview` — serve ONE local corpus from the filesystem (no
        // pg/rustfs, no sync), rendering on demand. For local QA / chart-review.
        Some(Command::Preview(args)) => {
            if let Err(e) = rt.block_on(run_preview(args)) {
                eprintln!("preview error: {e}");
                std::process::exit(2);
            }
        }
        // `liveview tasks` — inspect / retry the async audio queue.
        Some(Command::Tasks(args)) => {
            if let Err(e) = rt.block_on(run_tasks(args)) {
                eprintln!("tasks error: {e}");
                std::process::exit(1);
            }
        }
        // Default — run the server. It reads only the `[server]` block (host /
        // port / open) from the config; content comes from pg + rustfs, so it
        // never resolves or touches the corpus filesystem.
        None => {
            let server = load_server_cfg(cli.config.as_deref());
            rt.block_on(run(cli, server));
        }
    }
}

/// `liveview targets` entry point: resolve the corpus, emit each chart's render
/// target. Returns the process exit code (2 on resolve/read failure, else 0).
fn run_targets(args: &cli::TargetsArgs) -> i32 {
    let resolved = match resolve_config(args.config.as_deref()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("targets: {e}");
            return 2;
        }
    };
    let targets = match check::targets::collect(&resolved, &args.base_url, args.book.as_deref()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("targets: {e}");
            return 2;
        }
    };
    match args.format {
        cli::OutputFormat::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&targets).unwrap_or_else(|_| "[]".to_string())
            );
        }
        cli::OutputFormat::Human => {
            for t in &targets {
                let kind = serde_json::to_value(t.kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_default();
                println!(
                    "{}/{} {}:{}  {}#{}  {}",
                    t.book, t.lang, t.file, t.line, kind, t.nth, t.page_url
                );
            }
            eprintln!("targets: {} chart(s)", targets.len());
        }
    }
    0
}

/// `liveview sync` entry point: resolve the corpus, gather connection params,
/// reconcile into pg + rustfs.
async fn run_sync(args: cli::SyncArgs) -> Result<(), String> {
    let resolved = resolve_config(args.config.as_deref())?;
    let s3_access_key = read_cred(
        "access",
        args.s3_access_key.clone(),
        args.s3_access_key_file.as_deref(),
    )?;
    let s3_secret_key = read_cred(
        "secret",
        args.s3_secret_key.clone(),
        args.s3_secret_key_file.as_deref(),
    )?;
    let cfg = sync::run::SyncCfg {
        database_url: args.database_url,
        s3_endpoint: args.s3_endpoint,
        s3_access_key,
        s3_secret_key,
        s3_bucket: args.s3_bucket,
        tts_voice: args.tts_voice,
        text_audio: args.pregen_text_audio,
        render_version: args.render_version,
        repair: args.repair,
        no_audio: args.no_audio,
    };
    let report = sync::run::run(&resolved, &cfg).await?;
    tracing::info!(
        books = report.books,
        put = report.put,
        enqueued = report.enqueued,
        skipped = report.skipped,
        stale_audio = report.stale_audio,
        deleted = report.deleted,
        orphans_gc = report.orphans_gc,
        check_warnings = report.check_warnings,
        root = %report.root,
        "sync complete"
    );
    let root_short = &report.root[..report.root.len().min(12)];
    println!(
        "sync: {} books, {} put, {} audio queued, {} skipped, {} stale-audio re-baked, {} deleted, {} gc'd, {} check warnings, root {root_short}",
        report.books,
        report.put,
        report.enqueued,
        report.skipped,
        report.stale_audio,
        report.deleted,
        report.orphans_gc,
        report.check_warnings
    );
    Ok(())
}

async fn run_audio_optimize(args: cli::AudioOptimizeArgs) -> Result<(), String> {
    let access = read_cred(
        "access",
        args.s3_access_key,
        args.s3_access_key_file.as_deref(),
    )?;
    let secret = read_cred(
        "secret",
        args.s3_secret_key,
        args.s3_secret_key_file.as_deref(),
    )?;
    let pg = PgStore::open(&args.database_url)
        .await
        .map_err(|e| format!("connect postgres: {e}"))?;
    pg.migrate().await.map_err(|e| format!("migrate: {e}"))?;
    let obj = ObjStore::connect(&args.s3_endpoint, &access, &secret, &args.s3_bucket);
    let report = audio_optimize::run(&pg, &obj).await?;
    println!(
        "audio-optimize: {} assets / {} chapter refs promoted, {:.2} GiB MP3 -> {:.2} GiB canonical CAF ({} retranscoded, {} tails preserved); run sync to publish the new root and GC source MP3",
        report.promoted,
        report.chapters,
        report.source_bytes as f64 / 1_073_741_824.0,
        report.canonical_bytes as f64 / 1_073_741_824.0,
        report.retranscoded,
        report.tails,
    );
    Ok(())
}

/// `liveview tasks` entry point: print the audio-generation rollup, or `--retry`
/// re-queues failed tasks.
async fn run_tasks(args: cli::TasksArgs) -> Result<(), String> {
    let pg = PgStore::open(&args.database_url)
        .await
        .map_err(|e| format!("connect postgres: {e}"))?;
    pg.migrate().await.map_err(|e| format!("migrate: {e}"))?;
    if args.retry {
        let n = pg
            .retry_failed_audio_tasks(args.book.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        println!("tasks: re-queued {n} failed task(s)");
        return Ok(());
    }
    let mut rows = pg.audio_task_rollup().await.map_err(|e| e.to_string())?;
    rows.sort_by(|a, z| a.book_slug.cmp(&z.book_slug));
    for r in &rows {
        let who = r.book_slug.as_deref().unwrap_or("(global)");
        println!(
            "  {who:32}  {:>4}/{:<4} done   {:>3} pending   {:>3} failed",
            r.done, r.total, r.pending, r.failed
        );
    }
    if rows.is_empty() {
        println!("tasks: queue empty");
    }
    Ok(())
}

/// Resolve an S3 credential: a key file (rustfs writes its keys to files) wins
/// over a direct value; error if neither is given.
fn read_cred(which: &str, direct: Option<String>, file: Option<&Path>) -> Result<String, String> {
    if let Some(f) = file {
        return std::fs::read_to_string(f)
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("read s3 {which} key file {}: {e}", f.display()));
    }
    direct.ok_or_else(|| {
        format!("missing s3 {which} key (set --s3-{which}-key or --s3-{which}-key-file)")
    })
}

/// Server-side content-store connection params, from the env the systemd unit
/// sets. There is no filesystem fallback — `DATABASE_URL` is required.
struct StoreConfig {
    database_url: String,
    s3_endpoint: String,
    s3_bucket: String,
    s3_access_key: String,
    s3_secret_key: String,
}

fn store_config_from_env() -> Result<StoreConfig, String> {
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
fn build_apm_sink() -> Option<ApmSink> {
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
fn spawn_reload_listener(state: SharedState, database_url: String) {
    tokio::spawn(async move {
        loop {
            match sqlx::postgres::PgListener::connect(&database_url).await {
                Ok(mut listener) => {
                    if listener.listen("liveview_reload").await.is_ok() {
                        while listener.recv().await.is_ok() {
                            match Catalog::load(state.store.as_ref()).await {
                                Ok(cat) => {
                                    *state.catalog.write().await = cat;
                                    broadcast_tree(&state).await;
                                    tracing::info!("catalog reloaded after sync");
                                }
                                Err(e) => tracing::warn!(error = %e, "catalog reload failed"),
                            }
                        }
                    }
                }
                Err(e) => tracing::warn!(error = %e, "reload listener connect failed"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

/// Broadcast the current text sidebar tree as a `TreeUpdate` (the same shape
/// the old file-watcher sent) so connected clients refresh after a sync.
async fn broadcast_tree(state: &AppState) {
    if let Ok(Some(json)) = state.store.get_site_tree("text").await
        && let Ok(tree) = serde_json::from_str::<Vec<TreeNode>>(&json)
        && let Ok(s) = serde_json::to_string(&WsMessage::TreeUpdate { tree })
    {
        let _ = state.tx.send(s);
    }
}

async fn run(cli: Cli, server: config::ServerCfg) {
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
    let tts_cmd = env("LIVEVIEW_EDGE_TTS_CMD");
    let tts_voice = env("LIVEVIEW_TTS_VOICE");
    let book_end_phrases = load_book_end_phrases();

    // Drain the audio task queue only when an operator enabled a speech adapter.
    if let Some(command) = tts_cmd.clone() {
        crate::server::audio_worker::spawn(worker_pg, worker_obj, command, tx.clone());
    } else {
        tracing::info!("speech synthesis disabled (LIVEVIEW_EDGE_TTS_CMD is unset)");
    }

    let state: SharedState = Arc::new(AppState {
        tx,
        store,
        obj,
        catalog: RwLock::new(catalog),
        dag_cache: Default::default(),
        sizes_cache: Default::default(),
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
async fn run_preview(args: cli::PreviewArgs) -> Result<(), String> {
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

/// Build the reader's axum app (API routes + SPA assets) over any backend.
/// Shared by the deployed server (`run`) and the filesystem preview
/// (`run_preview`): one router, two content backends.
/// `GET /api/tasks` — the audio-generation rollup (per-book + a NULL-slug global
/// row) the Sync sheet renders: `{done, total, failed, pending}` per book.
async fn api_tasks(State(state): State<SharedState>) -> impl IntoResponse {
    match state.store.audio_task_rollup().await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "audio task rollup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "rollup").into_response()
        }
    }
}

/// `GET /api/blob/<content_hash>` — an immutable content-addressed blob (audio,
/// marks, image bytes) from rustfs, for the SW's offline cache. `immutable` ⇒
/// the SW caches forever, never revalidates; Range supports audio seeking.
async fn api_blob(
    State(state): State<SharedState>,
    axum::extract::Path(hash): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let mime = match state.store.get_asset(&hash).await {
        Ok(Some(a)) => a.mime,
        _ => "application/octet-stream".to_string(),
    };
    let Ok(data) = state.obj.get(&hash).await else {
        return (StatusCode::NOT_FOUND, "blob not found").into_response();
    };
    let total = data.len() as u64;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, total));
    let base = Response::builder()
        .header(header::CONTENT_TYPE, &mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    match range {
        Some((start, end)) => base
            .status(StatusCode::PARTIAL_CONTENT)
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            )
            .header(header::CONTENT_LENGTH, end - start + 1)
            .body(Body::from(data[start as usize..=end as usize].to_vec()))
            .unwrap()
            .into_response(),
        None => base
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, total)
            .body(Body::from(data))
            .unwrap()
            .into_response(),
    }
}

fn store_unavailable(operation: &'static str, error: String) -> Response {
    tracing::error!(operation, %error, "content store unavailable");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "content store unavailable",
            "operation": operation,
        })),
    )
        .into_response()
}

/// `GET /api/manifest` — the top-level Merkle manifest: the deploy root + each
/// book's subtree hash (the SW's O(1) "anything changed?" + per-book prune) plus
/// an audio-readiness rollup for the shelf badge.
async fn api_manifest(State(state): State<SharedState>) -> impl IntoResponse {
    let (root, books) = match state.store.manifest_books().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("manifest_books", error),
    };
    let mut audio: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    let audio_rollup = match state.store.audio_task_rollup().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("audio_task_rollup", error),
    };
    for r in audio_rollup {
        if let Some(s) = r.book_slug {
            audio.insert(s, (r.done, r.total));
        }
    }
    let books_updated = match state.store.list_books().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("list_books", error),
    };
    let updated: std::collections::HashMap<String, i64> = books_updated
        .into_iter()
        .map(|b| (b.slug, b.updated_at))
        .collect();
    let arr: Vec<_> = books
        .iter()
        .map(|(slug, hash)| {
            let (done, total) = audio.get(slug).copied().unwrap_or((0, 0));
            serde_json::json!({
                "slug": slug,
                "subtree_hash": hash,
                "updated_at": updated.get(slug).copied().unwrap_or(0),
                "audio": {"done": done, "total": total},
            })
        })
        .collect();
    Json(serde_json::json!({ "root": root, "books": arr })).into_response()
}

/// `GET /api/manifest/<slug>` — one book's content-addressed chapters (audio +
/// assets) with blob sizes + audio-task status (the SW's Lane-B prefetch index +
/// the per-chapter readiness signal). Text/HTML is Lane A, not here.
async fn api_manifest_book(
    State(state): State<SharedState>,
    axum::extract::Path(slug): axum::extract::Path<String>,
) -> impl IntoResponse {
    let chapters = match state.store.manifest_chapters(&slug).await {
        Ok(value) => value,
        Err(error) => return store_unavailable("manifest_chapters", error),
    };
    let arr: Vec<_> = chapters
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": format!("{}/{}/{}", c.rendition, c.lang, c.rel_path),
                // TEXT content-addressing: the source hash (+ file type) so the
                // client caches /api/file by hash and refetches only on change.
                "content_hash": c.content_hash,
                "file_type": c.file_type,
                "audio": {
                    "status": c.status,
                    "hash": c.audio_hash,
                    "marks_hash": c.marks_hash,
                    "bytes": c.audio_size,
                    "mime": c.audio_mime,
                },
                "asset": c.asset_hash.as_ref().map(|h| serde_json::json!({
                    "hash": h, "bytes": c.asset_size,
                })),
            })
        })
        .collect();
    Json(serde_json::json!({ "slug": slug, "chapters": arr })).into_response()
}

/// `GET /api/dag` — the WHOLE-corpus manifest the lv-sync client mirrors: the
/// deploy root + every resource (artwork / text / units / spoken / audio / marks / asset)
/// as `{ path, hash, kind, bytes, url }`. `hash` is the content address (cache
/// key); `url` is where to fetch it; `bytes` drives the byte-weighted offline %.
/// One round-trip → the client has the full content-addressed index.
/// `GET /api/root` — just the Merkle deploy root, the CHEAPEST possible "did
/// anything change?" probe. The offline client compares this against its cached
/// manifest's root: if equal, the whole tree is unchanged → reuse everything,
/// skip the full `/api/dag` fetch + the per-resource rescan. One hash, no work.
const MANIFEST_PROTOCOL_VERSION: u32 = 1;

fn manifest_etag(root: &str) -> String {
    format!("\"{root}\"")
}

fn manifest_not_modified(headers: &HeaderMap, root: &str) -> bool {
    !root.is_empty()
        && headers
            .get(header::IF_NONE_MATCH)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|candidate| {
                    let candidate = candidate.trim();
                    candidate == "*"
                        || candidate
                            .strip_prefix("W/")
                            .unwrap_or(candidate)
                            .trim_matches('"')
                            == root
                })
            })
}

fn manifest_json_response(root: &str, body: axum::body::Bytes) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-cache");
    if !root.is_empty() {
        response = response.header(header::ETAG, manifest_etag(root));
    }
    response
        .body(Body::from(body))
        .expect("valid manifest response")
}

fn manifest_not_modified_response(root: &str) -> Response {
    Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ETAG, manifest_etag(root))
        .body(Body::empty())
        .expect("valid manifest response")
}

async fn api_root(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let (root, _) = match state.store.manifest_books().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("manifest_books", error),
    };
    let root = root.unwrap_or_default();
    if manifest_not_modified(&headers, &root) {
        return manifest_not_modified_response(&root);
    }
    let body = axum::body::Bytes::from(
        serde_json::json!({
            "protocol_version": MANIFEST_PROTOCOL_VERSION,
            "root": root,
        })
        .to_string(),
    );
    manifest_json_response(&root, body)
}

async fn api_dag(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let (root, _) = match state.store.manifest_books().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("manifest_books", error),
    };
    let root = root.unwrap_or_default();
    if manifest_not_modified(&headers, &root) {
        return manifest_not_modified_response(&root);
    }

    let mut cache = state.dag_cache.lock().await;
    if let Some(cached) = cache.as_ref().filter(|cached| cached.root == root) {
        return manifest_json_response(&root, cached.body.clone());
    }
    let chapters = match state.store.dag_chapters().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("dag_chapters", error),
    };
    let artwork = match state.store.dag_artwork().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("dag_artwork", error),
    };
    let mut resources: Vec<serde_json::Value> = Vec::new();
    for book in &artwork {
        if let Some(hash) = &book.cover_hash {
            resources.push(artwork_resource(
                &book.book_slug,
                "cover",
                hash,
                book.cover_size.unwrap_or(0),
            ));
        }
        if let Some(hash) = &book.backdrop_hash {
            resources.push(artwork_resource(
                &book.book_slug,
                "backdrop",
                hash,
                book.backdrop_size.unwrap_or(0),
            ));
        }
        if let Some(hash) = &book.card_backdrop_hash {
            resources.push(artwork_resource(
                &book.book_slug,
                "card-backdrop",
                hash,
                book.card_backdrop_size.unwrap_or(0),
            ));
        }
    }
    for c in &chapters {
        let doc = format!("{}/{}/{}/{}", c.book_slug, c.rendition, c.lang, c.rel_path);
        // Wire path /api/file expects `<slug>/<rel_path>` + lang/rendition query.
        // Slugs/rel_paths/langs are ASCII filenames, so a raw query is safe here.
        let q = format!(
            "path={}/{}&lang={}&rendition={}",
            c.book_slug, c.rel_path, c.lang, c.rendition
        );
        if c.file_type == "markdown" || c.file_type == "html" {
            resources.push(serde_json::json!({
                "path": doc, "hash": c.content_hash, "kind": "text",
                "bytes": c.html_bytes.unwrap_or(0), "url": format!("/api/file?{q}"),
            }));
            // Read-along extras, keyed off content_hash so they're stable per
            // source; tiny, so bytes=0 (audio dominates the % anyway).
            //
            // `spoken` (the sentence transcript) backs the read-along for BOTH the
            // text read-aloud AND the AUDIOBOOK page, so cache it for EVERY
            // rendition. It was text-only before — so navigating offline to an
            // un-played audiobook chapter left /api/spoken?rendition=audio uncached
            // (504) and the AudiobookPlayer showed a blank skeleton forever. The
            // native text-sync pulls every non-audio dag resource, so listing it
            // here is all it takes to make the transcript available offline.
            resources.push(serde_json::json!({
                "path": format!("{doc}#spoken"), "hash": format!("{}:spoken", c.content_hash),
                "kind": "spoken", "bytes": 0, "url": format!("/api/spoken?{q}"),
            }));
            // `units` (word-level tap-to-seek) is a text-read-aloud feature only.
            if c.rendition == "text" {
                resources.push(serde_json::json!({
                    "path": format!("{doc}#units"), "hash": format!("{}:units", c.content_hash),
                    "kind": "units", "bytes": 0, "url": format!("/api/units?{q}"),
                }));
            }
        }
        if let Some(h) = &c.audio_hash {
            // Canonical CAF makes the manifest hash, stored object, served bytes,
            // native cache key, and integrity identity the SAME value. The legacy
            // estimate remains only for a migration interrupted mid-run.
            let canonical = c.audio_mime.as_deref() == Some(AUDIO_VARIANT.mime);
            let bytes = if canonical {
                c.audio_size.unwrap_or(0)
            } else {
                c.audio_size.unwrap_or(0) * 33 / 100
            };
            resources.push(serde_json::json!({
                "path": format!("{doc}#audio"), "hash": h, "kind": "audio",
                "bytes": bytes,
                "url": format!("/api/audio?{q}"),
            }));
        }
        if let Some(h) = &c.marks_hash {
            resources.push(serde_json::json!({
                "path": format!("{doc}#marks"), "hash": h, "kind": "marks",
                "bytes": c.marks_size.unwrap_or(0), "url": format!("/api/blob/{h}"),
            }));
        }
        if let Some(h) = &c.asset_hash {
            resources.push(serde_json::json!({
                "path": format!("{doc}#asset"), "hash": h, "kind": "asset",
                "bytes": c.asset_size.unwrap_or(0), "url": format!("/api/blob/{h}"),
            }));
        }
    }
    // List/spine endpoints — REQUIRED for offline book-OPEN, not just offline read.
    // The chapter bytes above let a cached chapter render, but opening a book from
    // the shelf first resolves its rendition SPINE (`/api/tree?rendition=…`, the
    // ordered chapter list) and the shelf itself needs `/api/books`. Those are live
    // (not content-addressed) and were absent from the dag, so the native cache had
    // every chapter yet a card tap did nothing offline (spine resolve → 504 → the
    // book couldn't be entered). Cache them like everything else, keyed on the
    // merkle `root` so they refresh on every corpus change. These are the exact URLs
    // the client requests via contentFetch (App.tsx enterBook/backToLanding + the
    // shelf load), so the offline cache-first hit matches. Bytes 0 (tiny; the size
    // accounting is dominated by audio anyway).
    let root_key = root.clone();
    for u in [
        "/api/books",
        "/api/tree",
        "/api/tree?rendition=text",
        "/api/tree?rendition=audio",
    ] {
        resources.push(serde_json::json!({
            "path": u, "hash": format!("{root_key}:{u}"), "kind": "list",
            "bytes": 0, "url": u,
        }));
    }
    let body = axum::body::Bytes::from(
        serde_json::json!({
            "protocol_version": MANIFEST_PROTOCOL_VERSION,
            "root": root,
            "resources": resources,
        })
        .to_string(),
    );
    *cache = Some(CachedJson {
        root: root.clone(),
        body: body.clone(),
    });
    manifest_json_response(&root, body)
}

fn artwork_resource(slug: &str, kind: &str, hash: &str, bytes: i64) -> serde_json::Value {
    serde_json::json!({
        "path": format!("{slug}/@{kind}"),
        "hash": hash,
        "kind": kind,
        "bytes": bytes.max(0),
        "url": format!("/api/{kind}?book={slug}"),
    })
}

/// `GET /api/sizes` — PRECOMPUTED download totals (per-book + global), keyed by
/// the deploy root, so the Downloads UI gets a TINY response instead of fetching
/// + parsing the ~4 MB `/api/dag` just to sum sizes. Same byte accounting as the
///
/// dag (canonical audio uses its exact object size). The client caches this by `root` and
/// re-fetches only when the root changes; the per-device CACHED progress is the
/// client's own index — this endpoint is the denominator, not the numerator.
async fn api_sizes(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let (root, _) = match state.store.manifest_books().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("manifest_books", error),
    };
    let root = root.unwrap_or_default();
    if manifest_not_modified(&headers, &root) {
        return manifest_not_modified_response(&root);
    }

    let mut cache = state.sizes_cache.lock().await;
    if let Some(cached) = cache.as_ref().filter(|cached| cached.root == root) {
        return manifest_json_response(&root, cached.body.clone());
    }
    let chapters = match state.store.dag_chapters().await {
        Ok(value) => value,
        Err(error) => return store_unavailable("dag_chapters", error),
    };
    #[derive(Default)]
    struct Agg {
        audio_bytes: i64,
        audio_count: i64,
        text_bytes: i64,
        text_count: i64,
    }
    let mut books: std::collections::BTreeMap<String, Agg> = std::collections::BTreeMap::new();
    let mut total = Agg::default();
    for c in &chapters {
        let e = books.entry(c.book_slug.clone()).or_default();
        if c.file_type == "markdown" || c.file_type == "html" {
            let b = c.html_bytes.unwrap_or(0);
            e.text_bytes += b;
            e.text_count += 1;
            total.text_bytes += b;
            total.text_count += 1;
        }
        if c.audio_hash.is_some() {
            let b = if c.audio_mime.as_deref() == Some(AUDIO_VARIANT.mime) {
                c.audio_size.unwrap_or(0)
            } else {
                c.audio_size.unwrap_or(0) * 33 / 100
            };
            e.audio_bytes += b;
            e.audio_count += 1;
            total.audio_bytes += b;
            total.audio_count += 1;
        }
    }
    let books_json: Vec<serde_json::Value> = books
        .into_iter()
        .map(|(slug, a)| {
            serde_json::json!({
                "slug": slug,
                "audio_bytes": a.audio_bytes, "audio_count": a.audio_count,
                "text_bytes": a.text_bytes, "text_count": a.text_count,
            })
        })
        .collect();
    let body = axum::body::Bytes::from(
        serde_json::json!({
            "protocol_version": MANIFEST_PROTOCOL_VERSION,
            "root": root,
            "audio_bytes": total.audio_bytes, "audio_count": total.audio_count,
            "text_bytes": total.text_bytes, "text_count": total.text_count,
            "books": books_json,
        })
        .to_string(),
    );
    *cache = Some(CachedJson {
        root: root.clone(),
        body: body.clone(),
    });
    manifest_json_response(&root, body)
}

/// Batched client APM events → an explicitly configured VictoriaLogs sink. The native app buffers operation /
/// perf / error events offline and POSTs them here in batches when the network is
/// good; we stamp each with `received_at` + a `_msg` summary and forward the batch
/// as jsonline to the host VL, where it's queried/debugged with LogsQL. Auth: a
/// shared bearer token when configured (else open, for dev). We return 200 ONLY
/// when VL accepted the batch — a VL hiccup returns 502 so the client keeps the
/// events and retries (at-least-once; `event_id` dedups a re-send at query time).
const APM_MAX_EVENTS: usize = 1_000;
const APM_MAX_BODY_BYTES: usize = 256 * 1024;

async fn api_ingest(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut events): Json<Vec<serde_json::Map<String, serde_json::Value>>>,
) -> impl IntoResponse {
    let Some(apm) = state.apm.as_ref() else {
        // No VL configured (preview) — accept + drop so a dev client doesn't spin.
        return StatusCode::OK;
    };
    // Bearer auth when a token is configured; an open sink requires explicit
    // LIVEVIEW_APM_ALLOW_UNAUTHENTICATED configuration at startup.
    if let Some(want) = apm.token.as_deref() {
        let got = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        if got != want {
            return StatusCode::UNAUTHORIZED;
        }
    }
    if events.is_empty() {
        return StatusCode::OK;
    }
    // Reject rather than silently truncate: a successful response makes the
    // client acknowledge the WHOLE batch, so truncation would lose the tail.
    if events.len() > APM_MAX_EVENTS {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    let received_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // NDJSON: one enriched event object per line.
    let mut body = String::new();
    for ev in &mut events {
        if !ev.contains_key("received_at") {
            ev.insert("received_at".to_string(), serde_json::json!(received_at));
        }
        // VL's default message column: the event type, for readable log rows.
        let msg = ev
            .get("event_type")
            .and_then(|v| v.as_str())
            .unwrap_or("event")
            .to_string();
        ev.insert("_msg".to_string(), serde_json::json!(msg));
        if let Ok(line) = serde_json::to_string(ev) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    match apm
        .client
        .post(&apm.vl_url)
        .header("content-type", "application/x-ndjson")
        .body(body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => StatusCode::OK,
        Ok(r) => {
            tracing::warn!(status = %r.status(), "apm forward to VictoriaLogs rejected");
            StatusCode::BAD_GATEWAY
        }
        Err(e) => {
            tracing::warn!(error = %e, "apm forward to VictoriaLogs failed");
            StatusCode::BAD_GATEWAY
        }
    }
}

#[derive(Clone, Debug, Default)]
struct HttpPolicy {
    allowed_origins: Vec<HeaderValue>,
    access_token: Option<String>,
}

impl HttpPolicy {
    fn parse(allowed_origins: Option<&str>, access_token: Option<String>) -> Result<Self, String> {
        let allowed_origins = allowed_origins
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(|origin| {
                if origin == "*" {
                    return Err(
                        "LIVEVIEW_ALLOWED_ORIGINS requires explicit origins; '*' is not allowed"
                            .to_string(),
                    );
                }
                let uri = origin
                    .parse::<axum::http::Uri>()
                    .map_err(|error| format!("invalid allowed origin {origin:?}: {error}"))?;
                if uri.scheme().is_none()
                    || uri.authority().is_none()
                    || uri.query().is_some()
                    || !matches!(uri.path(), "" | "/")
                {
                    return Err(format!(
                        "invalid allowed origin {origin:?}: expected scheme and authority without a path or query"
                    ));
                }
                origin
                    .parse::<HeaderValue>()
                    .map_err(|error| format!("invalid allowed origin {origin:?}: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let access_token = access_token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty());
        if let Some(token) = &access_token {
            format!("Bearer {token}")
                .parse::<HeaderValue>()
                .map_err(|error| format!("invalid access token: {error}"))?;
        }
        Ok(Self {
            allowed_origins,
            access_token,
        })
    }

    fn from_env() -> Result<Self, String> {
        let env = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
        let token =
            match env("LIVEVIEW_ACCESS_TOKEN_FILE") {
                Some(path) => Some(std::fs::read_to_string(&path).map_err(|error| {
                    format!("read LIVEVIEW_ACCESS_TOKEN_FILE {path:?}: {error}")
                })?),
                None => env("LIVEVIEW_ACCESS_TOKEN"),
            };
        Self::parse(env("LIVEVIEW_ALLOWED_ORIGINS").as_deref(), token)
    }
}

fn build_app(state: SharedState) -> Result<Router, String> {
    Ok(build_app_with_policy(state, HttpPolicy::from_env()?))
}

fn build_app_with_policy(state: SharedState, policy: HttpPolicy) -> Router {
    let mut api_router = Router::new()
        .route("/api/books", get(api_books))
        .route("/api/cover", get(api_cover))
        .route("/api/backdrop", get(api_backdrop))
        .route("/api/card-backdrop", get(api_card_backdrop))
        .route("/api/artwork", get(api_artwork))
        .route("/api/tree", get(api_tree))
        .route("/api/file", get(api_file))
        .route("/api/raw", get(api_raw))
        .route("/api/spoken", get(api_spoken))
        .route("/api/units", get(api_units))
        .route("/api/audio", get(api_audio))
        .route("/api/marks", get(api_marks))
        .route("/api/progress", get(api_progress_get).put(api_progress_put))
        .route("/api/progress/recent", get(api_progress_recent))
        .route("/api/settings", get(api_settings_get).put(api_settings_put))
        // Audio-generation status (per-book + global) for the Sync sheet.
        .route("/api/tasks", get(api_tasks))
        // Content-addressed immutable blob (audio / marks / images) for the SW's
        // offline cache (Lane B), + the Merkle manifest the SW diffs.
        .route("/api/blob/{hash}", get(api_blob))
        .route("/api/manifest", get(api_manifest))
        .route("/api/manifest/{slug}", get(api_manifest_book))
        .route("/api/root", get(api_root))
        .route("/api/dag", get(api_dag))
        .route("/api/sizes", get(api_sizes))
        // Under /api/ so the service worker treats it network-first (sw.js):
        // a top-level /version would fall into the cache-first bucket and serve
        // a stale build id right after a deploy, defeating the whole check.
        .route("/api/version", get(version))
        // Batched client APM events → forwarded to VictoriaLogs (see api_ingest).
        .route(
            "/api/ingest",
            post(api_ingest).layer(DefaultBodyLimit::max(APM_MAX_BODY_BYTES)),
        )
        .route("/ws", get(server::ws::ws_handler))
        .with_state(state.clone());

    // Optional defense in depth for a trusted reverse proxy. The proxy injects
    // the bearer header on every upstream request, including media and WebSocket
    // requests that browser APIs cannot decorate themselves.
    if let Some(token) = &policy.access_token {
        let expected: HeaderValue = format!("Bearer {token}")
            .parse()
            .expect("HttpPolicy validates the authorization header");
        api_router = api_router.route_layer(axum::middleware::from_fn(
            move |request: axum::http::Request<Body>, next: axum::middleware::Next| {
                let expected = expected.clone();
                async move {
                    if request.headers().get(header::AUTHORIZATION) == Some(&expected) {
                        next.run(request).await
                    } else {
                        StatusCode::UNAUTHORIZED.into_response()
                    }
                }
            },
        ));
    }

    api_router = api_router
        // Large whole-corpus metadata responses are highly compressible (the
        // current DAG shrinks by roughly an order of magnitude with gzip).
        .layer(tower_http::compression::CompressionLayer::new());

    // Same-origin is the secure default. Native shells and separately hosted
    // frontends opt into exact origins; wildcard reflection is never implicit.
    if !policy.allowed_origins.is_empty() {
        api_router = api_router.layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(policy.allowed_origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        );
    }

    #[cfg(feature = "embedded")]
    {
        api_router
            // OTA web bundle for the native shell (more specific than /{*path}).
            .route(
                "/app-dist/manifest.json",
                get(embedded_assets::app_dist_manifest),
            )
            .route("/app-dist/{*path}", get(embedded_assets::serve_app_dist))
            .route("/", get(embedded_assets::serve_index))
            .route("/assets/{*path}", get(embedded_assets::serve_assets))
            .route("/{*path}", get(embedded_assets::serve_root))
            .fallback(get(embedded_assets::serve_index))
            .layer(Extension(state))
    }

    #[cfg(not(feature = "embedded"))]
    {
        use tower_http::services::ServeDir;
        let serve_dir = ServeDir::new("web/dist")
            .append_index_html_on_directories(true)
            .fallback(ServeDir::new("web/dist").append_index_html_on_directories(true));
        api_router
            .fallback_service(serve_dir)
            .layer(Extension(state))
    }
}

/// Bind (auto-picking a free port from 4159 upward when unspecified) and serve.
async fn serve_app(app: Router, host: String, port: Option<u16>, should_open: bool) {
    const DEFAULT_PORT: u16 = 4159;
    let listener = if let Some(port) = port {
        let addr = format!("{host}:{port}");
        tokio::net::TcpListener::bind(&addr)
            .await
            .unwrap_or_else(|e| panic!("Failed to bind {addr} - {e}"))
    } else {
        let mut port = DEFAULT_PORT;
        loop {
            let addr = format!("{host}:{port}");
            match tokio::net::TcpListener::bind(&addr).await {
                Ok(listener) => break listener,
                Err(_) => {
                    tracing::info!("Port {port} in use, trying {}", port + 1);
                    port = port.checked_add(1).expect("No available ports found");
                }
            }
        }
    };

    let local_addr = listener.local_addr().expect("Failed to get local address");
    let url = format!("http://{local_addr}");

    if should_open {
        let url_clone = url.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let _ = open::that(&url_clone);
        });
    }

    tracing::info!("Server running at {url}");

    axum::serve(listener, app.into_make_service())
        .await
        .expect("Server error");
}

/// Load the `[server]` settings (host/port/open) from the config WITHOUT
/// resolving the corpus — the server is filesystem-free (no /home access under
/// `ProtectHome`). Any load error falls back to defaults; the systemd unit
/// passes `--host`/`--port` explicitly anyway.
fn load_server_cfg(config: Option<&Path>) -> config::ServerCfg {
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
fn resolve_config(config: Option<&Path>) -> Result<Resolved, String> {
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

fn load_explicit(path: &Path) -> Result<Resolved, String> {
    let cfg = Config::load(path)?;
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let dir = abs
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    cfg.resolve(&dir)
}

#[derive(serde::Deserialize)]
struct TreeQuery {
    /// Reading mode whose spine to return. Omitted/unknown ⇒ `text`.
    rendition: Option<String>,
}

/// The sidebar forest for a rendition — the JSON `liveview sync` precomputed
/// and stored in `site_tree`, returned verbatim. Empty `[]` when absent.
async fn api_tree(
    State(state): State<SharedState>,
    Query(q): Query<TreeQuery>,
) -> impl IntoResponse {
    let kind = q
        .rendition
        .as_deref()
        .and_then(RenditionKind::parse)
        .unwrap_or(RenditionKind::Text);
    let json = state
        .store
        .get_site_tree(kind.as_str())
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "[]".to_string());
    ([(header::CONTENT_TYPE, "application/json")], json)
}

#[derive(serde::Deserialize)]
struct ProgressQuery {
    /// Restrict to one book's chapters (newest first). Omitted ⇒ everything.
    book: Option<String>,
}

/// Reading progress for restoring scroll position / resuming the last-read
/// chapter.
async fn api_progress_get(
    State(state): State<SharedState>,
    Query(q): Query<ProgressQuery>,
) -> impl IntoResponse {
    let Some(slug) = q.book.as_deref() else {
        // `book` is required: the client always restores per-book. Without it,
        // return empty rather than dumping every book's rows.
        return Json(Vec::<ProgressEntry>::new()).into_response();
    };
    match state.store.progress_for_book(slug).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "progress read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// The latest-read chapter per book (newest first), for the landing page's
/// "continue reading" indicators.
async fn api_progress_recent(State(state): State<SharedState>) -> impl IntoResponse {
    match state.store.progress_recent_per_rendition().await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "progress recent read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(serde::Deserialize)]
struct ProgressUpdate {
    path: String,
    /// Scroll position as a 0..1 ratio of the document's scrollable height.
    scroll: f64,
    /// Client edit time (unix ms). Drives last-write-wins: a stale offline replay
    /// carries the OLD edit time, so the server keeps a newer value written by
    /// another device meanwhile. Absent (legacy/PWA clients) ⇒ stamped `now`, which
    /// always wins — same as the previous unconditional upsert.
    #[serde(default)]
    ts: Option<i64>,
}

/// Save one document's scroll position (debounced by the client).
async fn api_progress_put(
    State(state): State<SharedState>,
    Json(body): Json<ProgressUpdate>,
) -> impl IntoResponse {
    match state
        .store
        .progress_upsert(&body.path, body.scroll, body.ts)
        .await
    {
        // 204 whether or not the LWW guard kept our value — the write was DELIVERED;
        // the client drops it from its queue either way (a rejected stale write is
        // superseded, not retried). Only the network-failure path retries.
        Ok(_applied) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::warn!(error = %e, "progress write failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(serde::Deserialize)]
struct SettingPut {
    key: String,
    value: String,
    /// Client edit time (unix ms) — last-write-wins, see `ProgressUpdate::ts`.
    #[serde(default)]
    ts: Option<i64>,
}

/// Player settings (playback rate, sleep-timer, …) for cross-device sync.
async fn api_settings_get(State(state): State<SharedState>) -> impl IntoResponse {
    match state.store.settings_all().await {
        Ok(rows) => {
            let map: HashMap<String, String> = rows.into_iter().collect();
            Json(map).into_response()
        }
        Err(e) => {
            tracing::warn!(error = %e, "settings read failed");
            Json(HashMap::<String, String>::new()).into_response()
        }
    }
}

/// Save one player setting.
async fn api_settings_put(
    State(state): State<SharedState>,
    Json(body): Json<SettingPut>,
) -> impl IntoResponse {
    match state
        .store
        .settings_set(&body.key, &body.value, body.ts)
        .await
    {
        // Broadcast ONLY when the LWW guard actually accepted our value — a stale
        // replay that lost to a newer cross-device edit changed nothing, so pushing
        // it would make peers re-reconcile to an older value. `applied=false` ⇒
        // silent 204 (delivered, superseded).
        Ok(applied) => {
            if applied {
                // Mirror `broadcast_tree`: clone before the response so the PUT's
                // own return value is unaffected.
                if let Ok(s) = serde_json::to_string(&WsMessage::SettingUpdate {
                    key: body.key.clone(),
                    value: body.value.clone(),
                }) {
                    let _ = state.tx.send(s);
                }
            }
            StatusCode::NO_CONTENT
        }
        Err(e) => {
            tracing::warn!(error = %e, "settings write failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(serde::Serialize)]
struct LangInfo {
    lang: String,
    label: String,
}

/// One reading mode of a book, for the rendition toggle.
#[derive(serde::Serialize)]
struct RenditionInfo {
    /// `"text"` / `"audio"`.
    kind: String,
    /// Mode-toggle label ("阅读" / "听书").
    label: String,
    default_lang: String,
    langs: Vec<LangInfo>,
}

#[derive(serde::Serialize)]
struct BookInfo {
    label: String,
    slug: String,
    description: Option<String>,
    /// Author-defined keywords used for local search and faceted discovery.
    tags: Vec<String>,
    /// Optional shelf grouping key (book.toml top-level `collection`).
    collection: Option<String>,
    /// Optional credit line shown on the shelf card (book.toml top-level `author`).
    author: Option<String>,
    /// Whether a cover image is available at `/api/cover?book=<slug>`.
    cover: bool,
    /// Whether wide LiveView artwork is available at `/api/backdrop?book=<slug>`.
    backdrop: bool,
    /// Which rendition the book opens in.
    default_rendition: String,
    /// Every reading mode the book offers (always ≥1).
    renditions: Vec<RenditionInfo>,
    /// Mirrors the default rendition's languages, for clients that still read
    /// the flat language list.
    default_lang: String,
    langs: Vec<LangInfo>,
    /// `true` for a `book.toml`-driven book (the sidebar is a clean, titled
    /// spine — "book" mode); `false` for a plain `[[book]]`/`[[mount]]` whose
    /// sidebar is the raw filesystem tree ("docs" mode). Mirrors the default
    /// rendition. The frontend renders the two modes differently.
    manifest: bool,
    /// Deploy-time stamps (unix ms): when the book first appeared on the shelf
    /// and the last sync that changed its content. 0 ⇒ never stamped (hide in
    /// the UI). NOT git times.
    created_at: i64,
    updated_at: i64,
}

/// Lightweight list of books for the landing page ("bookshelf"): the curated
/// label, its slug (entry path), an optional blurb, and the available
/// language editions for the in-book language switcher.
async fn api_books(State(state): State<SharedState>) -> impl IntoResponse {
    use crate::server::catalog::RenditionMeta;
    let lang_infos = |r: &RenditionMeta| -> Vec<LangInfo> {
        r.editions
            .iter()
            .map(|e| LangInfo {
                lang: e.lang.clone(),
                label: e.label.clone(),
            })
            .collect()
    };
    let cat = state.catalog.read().await;
    let books: Vec<BookInfo> = cat
        .books
        .iter()
        .map(|b| {
            let default = b.default_rendition();
            BookInfo {
                label: b.label.clone(),
                slug: b.slug.clone(),
                description: b.description.clone(),
                tags: b.tags.clone(),
                collection: b.collection.clone(),
                author: b.author.clone(),
                cover: b.cover_hash.is_some(),
                backdrop: b.backdrop_hash.is_some(),
                default_rendition: b.default_rendition.as_str().to_string(),
                renditions: b
                    .renditions
                    .iter()
                    .map(|r| RenditionInfo {
                        kind: r.kind.as_str().to_string(),
                        label: r.label.clone(),
                        default_lang: r.default_lang.clone(),
                        langs: lang_infos(r),
                    })
                    .collect(),
                // Mirror the default rendition for back-compat clients.
                default_lang: default.default_lang.clone(),
                langs: lang_infos(default),
                manifest: default.manifest,
                created_at: b.created_at,
                updated_at: b.updated_at,
            }
        })
        .collect();
    axum::Json(books)
}

#[derive(serde::Deserialize)]
struct CoverQuery {
    book: String,
}

/// Stream a content-addressed blob from rustfs with its stored MIME.
async fn blob_response(state: &AppState, hash: &str, cache: &str) -> Option<Response> {
    let bytes = state.obj.get(hash).await.ok()?;
    let mime = state
        .store
        .get_asset(hash)
        .await
        .ok()
        .flatten()
        .map(|a| a.mime)
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, cache)
            .body(Body::from(bytes))
            .unwrap()
            .into_response(),
    )
}

/// A book's cover image (from rustfs). 404 when the book is unknown or coverless.
async fn api_cover(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        cat.book(&q.book).and_then(|b| b.cover_hash.clone())
    };
    match hash {
        Some(h) => match blob_response(&state, &h, "public, max-age=3600").await {
            Some(resp) => resp,
            None => (StatusCode::NOT_FOUND, "no cover").into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no cover").into_response(),
    }
}

/// A book's wide LiveView card/hero artwork. 404 when absent; callers use a
/// deterministic gradient rather than cropping the portrait cover.
async fn api_backdrop(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        cat.book(&q.book).and_then(|b| b.backdrop_hash.clone())
    };
    match hash {
        Some(h) => match blob_response(&state, &h, "public, max-age=3600").await {
            Some(resp) => resp,
            None => (StatusCode::NOT_FOUND, "no backdrop").into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no backdrop").into_response(),
    }
}

/// A compact, opaque rendition of the wide artwork for scrolling shelf cards.
/// It is generated at deploy time, content-addressed, and mirrored by native
/// clients through `/api/dag`; the original backdrop remains available for
/// larger hero surfaces.
async fn api_card_backdrop(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        cat.book(&q.book).and_then(|b| b.card_backdrop_hash.clone())
    };
    match hash {
        Some(h) => match blob_response(&state, &h, "public, max-age=3600").await {
            Some(resp) => resp,
            None => (StatusCode::NOT_FOUND, "no card backdrop").into_response(),
        },
        None => (StatusCode::NOT_FOUND, "no card backdrop").into_response(),
    }
}

/// Media Session artwork — never 404s for a known book: the real cover from
/// rustfs, else a deterministic slug-keyed gradient PNG (iOS lock-screen tiles
/// need a real raster URL, not CSS/data:).
async fn api_artwork(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let hash = {
        let cat = state.catalog.read().await;
        match cat.book(&q.book) {
            Some(b) => b.cover_hash.clone(),
            None => return (StatusCode::NOT_FOUND, "no such book").into_response(),
        }
    };
    if let Some(h) = hash
        && let Some(resp) = blob_response(&state, &h, "public, max-age=3600").await
    {
        return resp;
    }
    // No (readable) cover: synthesize the slug's gradient as a PNG.
    let png = gradient_png(&q.book);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(png))
        .unwrap()
        .into_response()
}

// ── Deterministic gradient cover synthesis (dependency-free PNG) ───────────
// A cover-less book shows a slug-keyed CSS gradient on the bookshelf
// (web/.../Landing.tsx `coverGradient`). The Media Session lock-screen tile
// can't use CSS — it needs a real raster URL — so we render the SAME gradient
// to a PNG here. Hand-rolled (uncompressed zlib + manual chunks) to avoid
// pulling an image/PNG crate into the Nix-vendored build for one gradient.

/// Slug → hue 0–359. Mirrors Landing.tsx `slugHue` exactly (int32 wrapping over
/// UTF-16 code units) so the PNG matches the shelf's colour for the same book.
fn slug_hue(slug: &str) -> f64 {
    let mut h: i32 = 0;
    for c in slug.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(i32::from(c));
    }
    f64::from(h.unsigned_abs() % 360)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h / 60.0;
    let x = c * (1.0 - ((hp % 2.0) - 1.0).abs());
    let (r, g, b) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c / 2.0;
    let to = |v: f64| (((v + m) * 255.0).round()).clamp(0.0, 255.0) as u8;
    (to(r), to(g), to(b))
}

fn lerp(a: u8, b: u8, t: f64) -> u8 {
    (f64::from(a) + (f64::from(b) - f64::from(a)) * t).round() as u8
}

/// 512×512 PNG of the slug's two-stop 135° gradient (top-left → bottom-right),
/// matching Landing.tsx `coverGradient`.
fn gradient_png(slug: &str) -> Vec<u8> {
    const SIZE: usize = 512;
    let hue = slug_hue(slug);
    let (r0, g0, b0) = hsl_to_rgb(hue, 0.52, 0.52);
    let (r1, g1, b1) = hsl_to_rgb((hue + 38.0) % 360.0, 0.48, 0.42);
    let denom = (2 * (SIZE - 1)) as f64;
    let mut raw = Vec::with_capacity(SIZE * (1 + SIZE * 3));
    for y in 0..SIZE {
        raw.push(0); // per-scanline filter byte: None
        for x in 0..SIZE {
            let t = (x + y) as f64 / denom;
            raw.push(lerp(r0, r1, t));
            raw.push(lerp(g0, g1, t));
            raw.push(lerp(b0, b1, t));
        }
    }
    encode_png_rgb(SIZE as u32, SIZE as u32, &raw)
}

fn encode_png_rgb(width: u32, height: u32, raw: &[u8]) -> Vec<u8> {
    let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10]; // PNG signature
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit, truecolour RGB, no interlace
    png_chunk(&mut out, b"IHDR", &ihdr);
    png_chunk(&mut out, b"IDAT", &zlib_stored(raw));
    png_chunk(&mut out, b"IEND", &[]);
    out
}

fn png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(tag);
    out.extend_from_slice(data);
    out.extend_from_slice(&png_crc(tag, data).to_be_bytes());
}

/// zlib stream wrapping deflate *stored* (uncompressed) blocks — no compressor
/// needed. The gradient PNG is ~770 KB this way, but it's generated once per
/// slug and served `immutable`, so size is a non-issue.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01]; // zlib header: deflate, no preset dict
    let mut i = 0;
    while i < data.len() {
        let n = (data.len() - i).min(0xFFFF);
        let last = i + n >= data.len();
        out.push(u8::from(last)); // BFINAL bit, BTYPE=00 (stored)
        let len = n as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(&data[i..i + n]);
        i += n;
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + u32::from(byte)) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn png_crc(tag: &[u8; 4], data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in tag.iter().chain(data) {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xFFFF_FFFF
}

#[derive(serde::Deserialize)]
struct FileQuery {
    path: String,
    /// Language edition to read. Omitted ⇒ the book's default edition.
    lang: Option<String>,
    /// Reading mode (`"text"` / `"audio"`). Omitted ⇒ the book's default
    /// rendition. An unknown value is treated as the default (text-ish) mode.
    rendition: Option<String>,
    /// Audio only: `"bookend"` asks `/api/audio` to append the spoken
    /// "end of the whole book" cue to this chapter's MP3. The client sets it only
    /// for the LAST chapter in the book's queue (it knows the spine order), so
    /// the server needs no spine knowledge. Ignored by the other handlers.
    tail: Option<String>,
}

/// A resolved request: the concrete rendition + the `(lang, default_lang)` pair
/// for overlay→base, plus the slug and the rest-of-path under the book.
struct ReqCtx {
    kind: RenditionKind,
    lang: String,
    default_lang: String,
    slug: String,
    rest: String,
}

/// Resolve `(path, rendition token, lang)` against the catalog: the book picks
/// the rendition (the token, else its default); the rendition picks the lang
/// (the query, else its default). `None` ⇒ unknown book.
async fn resolve_req(state: &AppState, q: &FileQuery) -> Option<ReqCtx> {
    let (slug, rest) = q.path.split_once('/').unwrap_or((q.path.as_str(), ""));
    let cat = state.catalog.read().await;
    let book = cat.book(slug)?;
    let kind = q
        .rendition
        .as_deref()
        .and_then(RenditionKind::parse)
        .unwrap_or(book.default_rendition);
    let rend = book.rendition(kind).unwrap_or(book.default_rendition());
    Some(ReqCtx {
        kind: rend.kind,
        lang: q.lang.clone().unwrap_or_else(|| rend.default_lang.clone()),
        default_lang: rend.default_lang.clone(),
        slug: slug.to_string(),
        rest: rest.to_string(),
    })
}

/// Resolve specifically against a book's `audio` rendition (for /api/audio +
/// /api/marks), independent of the request's rendition token. `None` ⇒ unknown
/// book or no audio rendition.
async fn resolve_audio(state: &AppState, q: &FileQuery) -> Option<ReqCtx> {
    let (slug, rest) = q.path.split_once('/').unwrap_or((q.path.as_str(), ""));
    let cat = state.catalog.read().await;
    let book = cat.book(slug)?;
    let rend = book.rendition(RenditionKind::Audio)?;
    Some(ReqCtx {
        kind: RenditionKind::Audio,
        lang: q.lang.clone().unwrap_or_else(|| rend.default_lang.clone()),
        default_lang: rend.default_lang.clone(),
        slug: slug.to_string(),
        rest: rest.to_string(),
    })
}

async fn api_file(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let not_found = || {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "File not found"})),
        )
            .into_response()
    };
    let Some(ctx) = resolve_req(&state, &query).await else {
        return not_found();
    };
    let chapter = state
        .store
        .get_chapter_fallback(
            &ctx.slug,
            ctx.kind.as_str(),
            &ctx.lang,
            &ctx.default_lang,
            &ctx.rest,
        )
        .await;
    let (row, served_lang) = match chapter {
        Ok(Some(x)) => x,
        Ok(None) => return not_found(),
        Err(e) => {
            tracing::warn!(error = %e, "chapter read failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "read failed").into_response();
        }
    };

    let file_type = FileType::from_path(&query.path);
    // Binary files: metadata only — frontend uses /api/raw for the bytes.
    let content = if matches!(file_type, FileType::Image | FileType::Pdf) {
        String::new()
    } else {
        // HTML was pre-rendered at sync time and stored in pg.
        row.html.unwrap_or_default()
    };
    Json(FileContent {
        path: query.path,
        lang: served_lang,
        file_type,
        content,
    })
    .into_response()
}

/// Resolve a chapter's **narration source** over pg: for the text rendition,
/// prefer the distilled `<id>.spoken.md` chapter, else the raw `<id>.md`; for
/// audio, the `<aid>.spoken.md` chapter IS the script. Returns the chapter +
/// the served lang (overlay → base).
async fn resolve_narration(state: &AppState, ctx: &ReqCtx) -> Option<(ChapterRecord, String)> {
    if ctx.kind == RenditionKind::Text
        && let Some(stem) = ctx.rest.strip_suffix(".md")
    {
        let spoken = format!("{stem}.spoken.md");
        if let Ok(Some(hit)) = state
            .store
            .get_chapter_fallback(&ctx.slug, "text", &ctx.lang, &ctx.default_lang, &spoken)
            .await
        {
            return Some(hit);
        }
    }
    let direct = state
        .store
        .get_chapter_fallback(
            &ctx.slug,
            ctx.kind.as_str(),
            &ctx.lang,
            &ctx.default_lang,
            &ctx.rest,
        )
        .await
        .ok()
        .flatten();
    if direct.is_some() || ctx.kind != RenditionKind::Audio {
        return direct;
    }

    // Some `book.toml` corpora expose an audiobook spine as virtual
    // `<id>.spoken.md` paths while storing the generated narration on the source
    // text chapter (`<id>.md`). Prefer a real curated audio row above, then map
    // that virtual path back to its text source. Audio, marks, and transcript all
    // use this same fallback so their sentence indexes stay aligned.
    let text_path = audio_text_fallback_path(&ctx.rest)?;
    state
        .store
        .get_chapter_fallback(&ctx.slug, "text", &ctx.lang, &ctx.default_lang, &text_path)
        .await
        .ok()
        .flatten()
}

fn audio_text_fallback_path(path: &str) -> Option<String> {
    path.strip_suffix(".spoken.md")
        .map(|stem| format!("{stem}.md"))
}

#[derive(serde::Serialize)]
struct SpokenContent {
    /// Edition actually served (overlay → base fallback).
    lang: String,
    /// Ordered speakable sentences. Index = the `data-sent` anchor the player
    /// highlights and the marks.json index — one shared segmentation.
    sentences: Vec<String>,
}

/// Read-along narration text segmented into sentences. For the **audio**
/// rendition the chapter's `<aid>.spoken.md` IS the script — read it directly.
/// For the **text** rendition, prefer the distilled `<id>.spoken.md` overlay,
/// else the raw `<id>.md` mechanically stripped. Same overlay → base resolution
/// as /api/file.
async fn api_spoken(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    if !matches!(FileType::from_path(&query.path), FileType::Markdown) {
        return (StatusCode::BAD_REQUEST, "not a markdown chapter").into_response();
    }
    let Some(ctx) = resolve_req(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    match resolve_narration(&state, &ctx).await {
        Some((row, served_lang)) => {
            let md = row.markdown.unwrap_or_default();
            Json(SpokenContent {
                lang: served_lang,
                sentences: server::spoken::spoken_sentences(&md),
            })
            .into_response()
        }
        None => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

#[derive(serde::Serialize)]
struct SpokenUnitsContent {
    /// Edition actually served (overlay → base fallback).
    lang: String,
    /// Ordered read-along units: prose sentences + classified non-prose blocks
    /// (code/image/math/table/html), each carrying a `blk` anchor. `idx` matches
    /// the audio-mark index and the `data-sent` anchor.
    units: Vec<server::spoken::Unit>,
}

/// Read-along units for the in-place highlight (the richer sibling of
/// /api/spoken), derived from the chapter markdown on the fly (a cheap comrak
/// parse — no storage, no schema).
///
/// CRUCIAL: this resolves the **displayed** chapter exactly like `/api/file`
/// (the rendered `.md`), NOT via `resolve_narration` (which prefers a
/// `<id>.spoken.md` audiobook-script overlay). The highlight ranges + `blk`
/// anchors must match the HTML the reader actually shows; an overlay is a
/// different, rewritten document with a different block structure, so using it
/// would land every anchor on the wrong block → whole-block mis-highlighting.
async fn api_units(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    if !matches!(FileType::from_path(&query.path), FileType::Markdown) {
        return (StatusCode::BAD_REQUEST, "not a markdown chapter").into_response();
    }
    let Some(ctx) = resolve_req(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    match state
        .store
        .get_chapter_fallback(
            &ctx.slug,
            ctx.kind.as_str(),
            &ctx.lang,
            &ctx.default_lang,
            &ctx.rest,
        )
        .await
    {
        Ok(Some((row, served_lang))) => {
            let md = row.markdown.unwrap_or_default();
            Json(SpokenUnitsContent {
                lang: served_lang,
                units: server::spoken::spoken_units(&md),
            })
            .into_response()
        }
        _ => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

/// Parse an HTTP `Range: bytes=…` value into an inclusive `(start, end)` within
/// `total`. Supports `start-`, `start-end`, and `-suffix`; `None` if malformed
/// or unsatisfiable (caller then serves the full body).
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let (s, e) = value.strip_prefix("bytes=")?.split_once('-')?;
    let (start, end) = if s.is_empty() {
        let suffix: u64 = e.parse().ok()?;
        (total.saturating_sub(suffix), total.checked_sub(1)?)
    } else {
        let start: u64 = s.parse().ok()?;
        let end = if e.is_empty() {
            total.checked_sub(1)?
        } else {
            e.parse().ok()?
        };
        (start, end)
    };
    (start <= end && end < total).then_some((start, end))
}

/// The canonical audio representation. Audiobook narration is mono
/// speech, so a low-bitrate speech codec is near-transparent at a fraction of the
/// source size. CAF is retained because the native offline cache uses that
/// container; MPEG Layer III is used because FFmpeg's CAF muxer does not support
/// Opus or AAC. The legacy cache tag remains only for resumable migration and
/// optional book-end derivatives.
pub struct AudioVariant {
    pub tag: &'static str,
    pub mime: &'static str,
    ext: &'static str,
    args: &'static [&'static str],
}
pub const AUDIO_VARIANT: AudioVariant = AudioVariant {
    tag: "mp324c",
    mime: "audio/x-caf",
    ext: "caf",
    args: &["-c:a", "libmp3lame", "-b:a", "24k", "-ac", "1"],
};

/// Folded into audio-capable Merkle leaf kinds. Bump whenever the canonical
/// stored/served representation changes, even if source prose is unchanged.
pub const AUDIO_ENCODING_VERSION: &str = "caf-mp324-v1";

/// Transcode an MP3 (`src`) per `AUDIO_VARIANT`. ffmpeg reads stdin and writes a
/// temp file (CAF/MP4 muxers need seekable output), which we read back + delete.
pub async fn transcode_audio(src: Vec<u8>) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncWriteExt;
    let mut tmp = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    tmp.push(format!(
        "lvtc-{}-{nanos}.{}",
        std::process::id(),
        AUDIO_VARIANT.ext
    ));
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.arg("-v").arg("error").arg("-y").arg("-i").arg("pipe:0");
    for a in AUDIO_VARIANT.args {
        cmd.arg(a);
    }
    cmd.arg(&tmp)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    let write_error = if let Some(mut stdin) = child.stdin.take() {
        let result = stdin.write_all(&src).await.err();
        drop(stdin);
        result
    } else {
        None
    };
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(match write_error {
            Some(error) => format!("ffmpeg stdin: {error}; ffmpeg: {stderr}"),
            None => format!("ffmpeg: {stderr}"),
        });
    }
    if let Some(error) = write_error {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("ffmpeg stdin: {error}"));
    }
    let bytes = tokio::fs::read(&tmp).await.map_err(|e| e.to_string());
    let _ = tokio::fs::remove_file(&tmp).await;
    bytes
}

/// Append an MP3 book-end cue to canonical CAF and re-encode one valid CAF.
/// ffmpeg needs two seekable inputs for the concat filter, so this rare path
/// uses private temporary files and removes them before returning.
async fn transcode_audio_with_tail(caf: &[u8], cue_mp3: &[u8]) -> Result<Vec<u8>, String> {
    let mut base = std::env::temp_dir();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    base.push(format!("lvtail-{}-{nonce}", std::process::id()));
    let chapter = base.with_extension("chapter.caf");
    let cue = base.with_extension("cue.mp3");
    let output = base.with_extension(AUDIO_VARIANT.ext);
    tokio::fs::write(&chapter, caf)
        .await
        .map_err(|e| format!("write tail chapter: {e}"))?;
    tokio::fs::write(&cue, cue_mp3)
        .await
        .map_err(|e| format!("write tail cue: {e}"))?;
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.arg("-v")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(&chapter)
        .arg("-i")
        .arg(&cue)
        .arg("-filter_complex")
        .arg("[0:a][1:a]concat=n=2:v=0:a=1[out]")
        .arg("-map")
        .arg("[out]");
    for arg in AUDIO_VARIANT.args {
        cmd.arg(arg);
    }
    let result = cmd.arg(&output).output().await;
    let bytes = match result {
        Ok(out) if out.status.success() => tokio::fs::read(&output)
            .await
            .map_err(|e| format!("read tail audio: {e}")),
        Ok(out) => Err(format!(
            "ffmpeg tail: {}",
            String::from_utf8_lossy(&out.stderr)
        )),
        Err(e) => Err(format!("spawn ffmpeg tail: {e}")),
    };
    for path in [&chapter, &cue, &output] {
        let _ = tokio::fs::remove_file(path).await;
    }
    bytes
}

/// Cache-first compressed audio for already-assembled `data`, keyed by `cache_key`
/// (`<hash>` or `<hash>.tail`). Returns (bytes, mime). On transcode failure it
/// gracefully serves the original MP3 so playback never hard-fails.
async fn compressed_audio(
    state: &SharedState,
    cache_key: &str,
    data: Vec<u8>,
) -> (Vec<u8>, &'static str) {
    let key = format!("{cache_key}.{}", AUDIO_VARIANT.tag);
    if let Ok(b) = state.obj.get(&key).await {
        return (b, AUDIO_VARIANT.mime);
    }
    match transcode_audio(data.clone()).await {
        Ok(b) => {
            let _ = state
                .obj
                .put_if_absent(&key, b.clone(), AUDIO_VARIANT.mime)
                .await;
            (b, AUDIO_VARIANT.mime)
        }
        Err(e) => {
            tracing::warn!(error = %e, "audio transcode failed; serving source mp3");
            (data, "audio/mpeg")
        }
    }
}

/// Serve audio `data` with an explicit content-type, `Content-Length`,
/// `Accept-Ranges` and HTTP Range support (seeking). Audio is always the compressed
/// variant now (Opus-in-CAF); the MP3 fallback path only triggers on a transcode
/// failure. AVPlayer infers the format from this
/// header when the URL has no extension.
fn serve_audio_range(
    data: Vec<u8>,
    headers: &axum::http::HeaderMap,
    mime: &'static str,
) -> axum::response::Response {
    let total = data.len() as u64;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, total));
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=3600");
    match range {
        Some((start, end)) => builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            )
            .header(header::CONTENT_LENGTH, end - start + 1)
            .body(Body::from(data[start as usize..=end as usize].to_vec()))
            .unwrap()
            .into_response(),
        None => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, total)
            .body(Body::from(data))
            .unwrap()
            .into_response(),
    }
}

/// Chapter narration audio — the pre-generated MP3 from rustfs, with
/// `Content-Length` + HTTP Range support (seeking). A few MB → fetch the whole
/// blob and slice for Range.
async fn api_audio(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    // Text rendition → read-aloud for an ordinary document (units-driven synth).
    // Additive: the audiobook (`audio` rendition) path below is byte-for-byte
    // unchanged.
    if query.rendition.as_deref() == Some("text") {
        return match ensure_text_audio(&state, &query).await {
            Ok((audio_hash, _)) => match state.obj.get(&audio_hash).await {
                Ok(data) => {
                    let mime = state
                        .store
                        .get_asset(&audio_hash)
                        .await
                        .ok()
                        .flatten()
                        .map(|a| a.mime);
                    if mime.as_deref() == Some(AUDIO_VARIANT.mime) {
                        serve_audio_range(data, &headers, AUDIO_VARIANT.mime)
                    } else {
                        let (b, mime) = compressed_audio(&state, &audio_hash, data).await;
                        serve_audio_range(b, &headers, mime)
                    }
                }
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read audio").into_response(),
            },
            Err(e) => {
                tracing::warn!(error = %e, "text read-aloud synth failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response()
            }
        };
    }
    let Some(ctx) = resolve_audio(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "audio not available").into_response();
    };
    let Some((row, _)) = resolve_narration(&state, &ctx).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let hash = match ensure_chapter_audio(&state, &row).await {
        Ok((audio_hash, _)) => audio_hash,
        Err(e) => {
            tracing::warn!(error = %e, "on-demand audio synth failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response();
        }
    };
    let Ok(data) = state.obj.get(&hash).await else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "read audio").into_response();
    };
    // A book's last chapter may carry an operator-configured spoken tail (the
    // client sends `tail=bookend` only for that chapter). Bake it into the served bytes so it
    // plays through the same MediaSession element — on the lock screen / in the
    // background, where a client-side cue would be silent. MP3 frames concatenate
    // cleanly (same as `assemble()` joins per-sentence clips). Marks are
    // untouched: the tail sits past the last sentence's end_ms, a silent gap in
    // the read-along. Only the last chapter pays the (tiny) append.
    let is_bookend = query.tail.as_deref() == Some("bookend");
    let asset_mime = state
        .store
        .get_asset(&hash)
        .await
        .ok()
        .flatten()
        .map(|a| a.mime);
    if asset_mime.as_deref() == Some(AUDIO_VARIANT.mime) {
        if is_bookend && let Some(phrase) = book_end_phrase(&state.book_end_phrases, &row.lang) {
            // Include the configured phrase in the derived cache identity so a
            // configuration change can never replay an older deployment's cue.
            let phrase_hash = blake3::hash(phrase.as_bytes()).to_hex();
            let tail_key = format!("{hash}.tail.{}.{phrase_hash}", AUDIO_VARIANT.tag);
            if let Ok(tail) = state.obj.get(&tail_key).await {
                return serve_audio_range(tail, &headers, AUDIO_VARIANT.mime);
            }
            if let Some(cue) = book_end_cue(&state, &row).await {
                match transcode_audio_with_tail(&data, &cue).await {
                    Ok(tail) => {
                        if let Err(error) = state
                            .obj
                            .put_if_absent(&tail_key, tail.clone(), AUDIO_VARIANT.mime)
                            .await
                        {
                            tracing::warn!(%error, "store canonical book-end tail failed");
                        }
                        return serve_audio_range(tail, &headers, AUDIO_VARIANT.mime);
                    }
                    Err(error) => {
                        tracing::warn!(audio_hash = hash, %error, "build canonical book-end tail failed");
                    }
                }
            }
        }
        return serve_audio_range(data, &headers, AUDIO_VARIANT.mime);
    }

    // Backward-compatible legacy path while an interrupted migration still has
    // MP3 chapter pointers.
    let mut data = data;
    if is_bookend && let Some(cue) = book_end_cue(&state, &row).await {
        data.extend_from_slice(&cue);
    }
    // ALWAYS the compressed variant — MP3 is fully sunset client-side (one format;
    // the source MP3 is only the internal transcode input). Cached by the source
    // hash (+ ".tail" when the bookend cue is baked in, which differs from the blob).
    let ck = if is_bookend {
        format!("{hash}.tail")
    } else {
        hash.clone()
    };
    let (bytes, mime) = compressed_audio(&state, &ck, data).await;
    serve_audio_range(bytes, &headers, mime)
}

/// Per-sentence time marks for the chapter audio (drives read-along highlight).
async fn api_marks(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    // Text rendition → units-driven read-aloud marks (idx aligns with /api/units
    // for the in-place highlight). Additive: the audiobook path below is unchanged.
    if query.rendition.as_deref() == Some("text") {
        return match ensure_text_audio(&state, &query).await {
            Ok((_, marks_hash)) => match state.obj.get(&marks_hash).await {
                Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read marks").into_response(),
            },
            Err(e) => {
                tracing::warn!(error = %e, "text read-aloud synth failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response()
            }
        };
    }
    let Some(ctx) = resolve_audio(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "audio not available").into_response();
    };
    let Some((row, _)) = resolve_narration(&state, &ctx).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let hash = match ensure_chapter_audio(&state, &row).await {
        Ok((_, marks_hash)) => marks_hash,
        Err(e) => {
            tracing::warn!(error = %e, "on-demand audio synth failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response();
        }
    };
    match state.obj.get(&hash).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read marks").into_response(),
    }
}

/// On-demand audio fallback (ISR-style): if the backfill hasn't pre-generated
/// this chapter's audio yet, synthesize it now (edge-tts) from the stored spoken
/// markdown, store mp3 + marks in rustfs, and record them on the chapter.
/// Already-generated chapters are a no-op. Returns `(audio_hash, marks_hash)`.
async fn ensure_chapter_audio(
    state: &AppState,
    row: &ChapterRecord,
) -> Result<(String, String), String> {
    if let (Some(a), Some(m)) = (&row.audio_hash, &row.marks_hash) {
        return Ok((a.clone(), m.clone()));
    }
    let md = row.markdown.clone().unwrap_or_default();
    let sentences = server::spoken::spoken_sentences(&md);
    let voice = {
        let cat = state.catalog.read().await;
        cat.book(&row.book_slug)
            .and_then(|b| b.rendition(RenditionKind::Audio))
            .and_then(|r| r.voice.clone())
            .or_else(|| state.tts_voice.clone())
            .ok_or("speech voice is not configured")?
    };
    let command = state
        .tts_cmd
        .as_deref()
        .ok_or("speech synthesis is not configured")?;
    let (mp3, marks) = server::audio::synthesize(command, &voice, &sentences).await?;
    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    let caf = transcode_audio(mp3).await?;
    let audio_hash = store_blob(state, caf, AUDIO_VARIANT.mime).await?;
    let marks_hash = store_blob(state, marks_json, "application/json").await?;
    state
        .store
        .set_chapter_audio(
            &row.book_slug,
            &row.rendition,
            &row.lang,
            &row.rel_path,
            &audio_hash,
            &marks_hash,
        )
        .await
        .map_err(|e| format!("record audio: {e}"))?;
    Ok((audio_hash, marks_hash))
}

/// Read-aloud for the TEXT rendition (any document, not a curated audiobook).
/// Synthesizes from the chapter's `spoken_units` so each clip is one unit, in
/// order — the marks are therefore indexed by UNIT, matching `/api/units` and the
/// in-place highlight. Result is content-addressed in rustfs and recorded on the
/// TEXT chapter row's (until-now-unused) audio/marks hashes, so it's generated
/// once and a re-sync (which resets those hashes) regenerates it. Never touches
/// the `audio` rendition path. Returns `(audio_hash, marks_hash)`.
async fn ensure_text_audio(
    state: &AppState,
    query: &FileQuery,
) -> Result<(String, String), String> {
    let ctx = resolve_req(state, query).await.ok_or("unknown book")?;
    // Resolve the DISPLAYED chapter (like /api/file), NOT resolve_narration's
    // `.spoken.md` overlay — so the synthesized audio + its marks are derived
    // from the very text the reader sees and the in-place highlight anchors line
    // up. (The overlay is the audiobook rendition's own curated script.)
    let (row, served) = state
        .store
        .get_chapter_fallback(
            &ctx.slug,
            ctx.kind.as_str(),
            &ctx.lang,
            &ctx.default_lang,
            &ctx.rest,
        )
        .await
        .ok()
        .flatten()
        .ok_or("chapter not found")?;
    if let (Some(a), Some(m)) = (&row.audio_hash, &row.marks_hash) {
        return Ok((a.clone(), m.clone()));
    }
    // Single-flight: serialize synth per chapter so a double-tap / second client
    // waits rather than redoing the expensive edge-tts (+ narration) run.
    let key = format!(
        "{}|{}|{}|{}",
        row.book_slug,
        ctx.kind.as_str(),
        row.lang,
        row.rel_path
    );
    let lock = {
        let mut map = state.audio_synth_locks.lock().await;
        std::sync::Arc::clone(
            map.entry(key)
                .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))),
        )
    };
    let _guard = lock.lock().await;
    // Re-check after acquiring: a prior holder may have just filled the hashes.
    if let Ok(Some((fresh, _))) = state
        .store
        .get_chapter_fallback(
            &ctx.slug,
            ctx.kind.as_str(),
            &ctx.lang,
            &ctx.default_lang,
            &ctx.rest,
        )
        .await
        && let (Some(a), Some(m)) = (fresh.audio_hash, fresh.marks_hash)
    {
        return Ok((a, m));
    }
    let md = row.markdown.clone().unwrap_or_default();
    let units = server::spoken::spoken_units(&md);
    if units.is_empty() {
        return Err("no speakable content".to_string());
    }
    // One clip per unit (empty-text units → a silent dwell in `assemble`), so the
    // mark index equals the unit index the highlight anchors on. The speech
    // registry decides each unit's spoken text: prose is normalized for the ear
    // (URLs/addresses/phone numbers → a short stand-in), tables / diagrams /
    // formulas / code are resolved from PRE-GENERATED narration (made offline by
    // a skill, ingested into pg by `sync`), and anything unhandled / not-yet-
    // narrated stays a brief silent step-over. No model call. Runs once per
    // chapter (the whole result is cached).
    let keys = server::speakable::narration_keys(&units, &served);
    let store =
        server::narration::NarrationStore::from_pairs(state.store.load_narration(&keys).await?);
    let texts: Vec<String> = units
        .iter()
        .map(|u| server::speakable::unit_speech(u, &served, &store))
        .collect();
    let voice = {
        let cat = state.catalog.read().await;
        cat.book(&row.book_slug)
            .and_then(|b| b.rendition(RenditionKind::Audio))
            .and_then(|r| r.voice.clone())
            .or_else(|| state.tts_voice.clone())
            .ok_or("speech voice is not configured")?
    };
    let command = state
        .tts_cmd
        .as_deref()
        .ok_or("speech synthesis is not configured")?;
    let (mp3, marks) = server::audio::synthesize(command, &voice, &texts).await?;
    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    let caf = transcode_audio(mp3).await?;
    let audio_hash = store_blob(state, caf, AUDIO_VARIANT.mime).await?;
    let marks_hash = store_blob(state, marks_json, "application/json").await?;
    state
        .store
        .set_chapter_audio(
            &row.book_slug,
            ctx.kind.as_str(),
            &row.lang,
            &row.rel_path,
            &audio_hash,
            &marks_hash,
        )
        .await
        .map_err(|e| format!("record text audio: {e}"))?;
    Ok((audio_hash, marks_hash))
}

/// Parse operator-defined end-of-book phrases. No language or wording is built
/// into the reader; an absent or invalid map disables this optional cue.
fn parse_book_end_phrases(value: &str) -> Result<HashMap<String, String>, String> {
    let phrases: HashMap<String, String> = serde_json::from_str(value)
        .map_err(|error| format!("LIVEVIEW_BOOK_END_PHRASES must be a JSON object: {error}"))?;
    Ok(phrases
        .into_iter()
        .filter_map(|(lang, phrase)| {
            let lang = lang.trim().to_ascii_lowercase();
            let phrase = phrase.trim().to_string();
            (!lang.is_empty() && !phrase.is_empty()).then_some((lang, phrase))
        })
        .collect())
}

fn load_book_end_phrases() -> HashMap<String, String> {
    let Ok(value) = std::env::var("LIVEVIEW_BOOK_END_PHRASES") else {
        return HashMap::new();
    };
    match parse_book_end_phrases(&value) {
        Ok(phrases) => phrases,
        Err(error) => {
            tracing::warn!(%error, "end-of-book audio cue disabled");
            HashMap::new()
        }
    }
}

/// Look up an exact BCP 47 tag first, then its primary language subtag.
fn book_end_phrase<'a>(phrases: &'a HashMap<String, String>, lang: &str) -> Option<&'a str> {
    let lang = lang.trim().to_ascii_lowercase();
    phrases
        .get(&lang)
        .or_else(|| {
            lang.split_once('-')
                .and_then(|(primary, _)| phrases.get(primary))
        })
        .map(String::as_str)
}

/// The synthesized "end of book" cue for this chapter's voice + language,
/// cached in-process (keyed by `"{voice}|{phrase}"`). Returns `None` when the
/// language has no phrase or synthesis fails — the caller then serves the
/// chapter audio with no tail, never an error (a missing cue must not break
/// playback). The voice is the book's audio-rendition voice, mirroring
/// `ensure_chapter_audio`, so the cue matches the narration.
async fn book_end_cue(state: &AppState, row: &ChapterRecord) -> Option<Vec<u8>> {
    let phrase = book_end_phrase(&state.book_end_phrases, &row.lang)?;
    let voice = {
        let cat = state.catalog.read().await;
        cat.book(&row.book_slug)
            .and_then(|b| b.rendition(RenditionKind::Audio))
            .and_then(|r| r.voice.clone())
            .or_else(|| state.tts_voice.clone())?
    };
    let key = format!("{voice}|{phrase}");
    if let Some(cue) = state.book_end_cue.lock().await.get(&key) {
        return Some(cue.as_ref().clone());
    }
    // Synthesize off-lock; a rare double-synth
    // race is harmless — both produce the same tiny clip and the last write wins.
    let (mp3, _marks) =
        match server::audio::synthesize(state.tts_cmd.as_deref()?, &voice, &[phrase.to_string()])
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, voice, "book-end cue synth failed");
                return None;
            }
        };
    let arc = std::sync::Arc::new(mp3);
    state.book_end_cue.lock().await.insert(key, arc.clone());
    Some(arc.as_ref().clone())
}

/// Hash + `put_if_absent` a blob to rustfs and record the asset row. Returns the
/// content hash (the rustfs key).
async fn store_blob(state: &AppState, bytes: Vec<u8>, mime: &str) -> Result<String, String> {
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let size = bytes.len() as i64;
    state.obj.put_if_absent(&hash, bytes, mime).await?;
    state
        .store
        .upsert_asset(&hash, mime, size)
        .await
        .map_err(|e| format!("upsert asset: {e}"))?;
    Ok(hash)
}

/// Raw binary (image / PDF) bytes for a chapter, streamed from rustfs.
async fn api_raw(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let Some(ctx) = resolve_req(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let Some((row, _)) = state
        .store
        .get_chapter_fallback(
            &ctx.slug,
            ctx.kind.as_str(),
            &ctx.lang,
            &ctx.default_lang,
            &ctx.rest,
        )
        .await
        .ok()
        .flatten()
    else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let Some(hash) = row.asset_hash else {
        return (StatusCode::NOT_FOUND, "not a binary asset").into_response();
    };
    match blob_response(&state, &hash, "public, max-age=3600").await {
        Some(resp) => resp,
        None => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

#[cfg(test)]
mod apm_tests {
    use super::*;
    use crate::store::fs::FsStore;
    use tower::ServiceExt;

    #[test]
    fn http_policy_defaults_to_same_origin_without_authentication() {
        let policy = HttpPolicy::parse(None, None).unwrap();
        assert!(policy.allowed_origins.is_empty());
        assert!(policy.access_token.is_none());
    }

    #[test]
    fn http_policy_accepts_exact_origins_and_rejects_wildcards() {
        let policy = HttpPolicy::parse(
            Some("tauri://localhost, https://reader.example.org"),
            Some("proxy-secret".into()),
        )
        .unwrap();
        assert_eq!(policy.allowed_origins.len(), 2);
        assert_eq!(policy.allowed_origins[0], "tauri://localhost");
        assert_eq!(policy.access_token.as_deref(), Some("proxy-secret"));
        assert!(HttpPolicy::parse(Some("*"), None).is_err());
        assert!(HttpPolicy::parse(Some("reader.example.org"), None).is_err());
        assert!(HttpPolicy::parse(Some("https://reader.example.org/path"), None).is_err());
    }

    #[tokio::test]
    async fn access_token_protects_api_routes() {
        let policy = HttpPolicy::parse(None, Some("proxy-secret".into())).unwrap();
        let app = build_app_with_policy(state_with(None).await, policy);
        let unauthorized = app
            .clone()
            .oneshot(
                axum::http::Request::get("/api/version")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let authorized = app
            .oneshot(
                axum::http::Request::get("/api/version")
                    .header(header::AUTHORIZATION, "Bearer proxy-secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cors_returns_only_an_explicit_allowed_origin() {
        let policy = HttpPolicy::parse(Some("https://reader.example.org"), None).unwrap();
        let app = build_app_with_policy(state_with(None).await, policy);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/progress")
                    .header(header::ORIGIN, "https://reader.example.org")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("https://reader.example.org"))
        );
    }

    #[test]
    fn book_end_phrases_are_explicit_and_language_aware() {
        let phrases = parse_book_end_phrases(
            r#"{"en":"The end.","zh":"全书完","fr-CA":" Fin. ","empty":" "}"#,
        )
        .unwrap();
        assert_eq!(book_end_phrase(&phrases, "en-US"), Some("The end."));
        assert_eq!(book_end_phrase(&phrases, "ZH-Hans"), Some("全书完"));
        assert_eq!(book_end_phrase(&phrases, "fr-CA"), Some("Fin."));
        assert_eq!(book_end_phrase(&phrases, "fr-FR"), None);
        assert_eq!(book_end_phrase(&HashMap::new(), "en"), None);
    }

    #[test]
    fn invalid_book_end_phrase_config_is_rejected() {
        assert!(parse_book_end_phrases(r#"["not", "an", "object"]"#).is_err());
    }

    #[tokio::test]
    async fn canonical_audio_variant_is_muxable_by_ffmpeg() {
        let source = tokio::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.1",
                "-f",
                "mp3",
                "pipe:1",
            ])
            .output()
            .await
            .expect("ffmpeg should generate the MP3 fixture");
        assert!(
            source.status.success(),
            "fixture ffmpeg failed: {}",
            String::from_utf8_lossy(&source.stderr)
        );

        let canonical = transcode_audio(source.stdout)
            .await
            .expect("canonical audio configuration must be supported by ffmpeg");
        assert!(canonical.starts_with(b"caff"));
    }

    #[test]
    fn virtual_audio_path_maps_back_to_text_chapter() {
        assert_eq!(
            audio_text_fallback_path("01-why.spoken.md").as_deref(),
            Some("01-why.md")
        );
        assert_eq!(
            audio_text_fallback_path("part/01-why.spoken.md").as_deref(),
            Some("part/01-why.md")
        );
        assert_eq!(audio_text_fallback_path("01-why.md"), None);
    }

    #[test]
    fn manifest_etag_accepts_strong_weak_and_lists() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            r#""old", W/"current""#.parse().unwrap(),
        );
        assert!(manifest_not_modified(&headers, "current"));
        assert!(!manifest_not_modified(&headers, "other"));
        assert!(!manifest_not_modified(&HeaderMap::new(), "current"));
    }

    #[test]
    fn artwork_resource_is_content_addressed_and_book_scoped() {
        let resource = artwork_resource("field-guide", "backdrop", "abc123", 4096);
        assert_eq!(resource["path"], "field-guide/@backdrop");
        assert_eq!(resource["hash"], "abc123");
        assert_eq!(resource["kind"], "backdrop");
        assert_eq!(resource["bytes"], 4096);
        assert_eq!(resource["url"], "/api/backdrop?book=field-guide");

        let card = artwork_resource("field-guide", "card-backdrop", "def456", 1024);
        assert_eq!(card["path"], "field-guide/@card-backdrop");
        assert_eq!(card["hash"], "def456");
        assert_eq!(card["kind"], "card-backdrop");
        assert_eq!(card["bytes"], 1024);
        assert_eq!(card["url"], "/api/card-backdrop?book=field-guide");
    }

    /// Minimal AppState over an empty in-memory FsStore (no pg/rustfs, no audio
    /// worker) with the given APM sink — enough to exercise `api_ingest` directly.
    async fn state_with(apm: Option<ApmSink>) -> SharedState {
        let fs = Arc::new(FsStore::new(Vec::new()));
        let store: Arc<dyn crate::store::content::ContentStore> = fs.clone();
        let obj: Arc<dyn crate::store::content::BlobStore> = fs;
        let catalog = Catalog::load(store.as_ref()).await.unwrap();
        let (tx, _rx) = broadcast::channel::<String>(8);
        Arc::new(AppState {
            tx,
            store,
            obj,
            catalog: RwLock::new(catalog),
            dag_cache: Default::default(),
            sizes_cache: Default::default(),
            tts_cmd: Some("edge-tts".into()),
            tts_voice: Some("x".into()),
            book_end_phrases: HashMap::new(),
            book_end_cue: Default::default(),
            audio_synth_locks: Default::default(),
            apm,
        })
    }

    fn one_event(device: &str, ty: &str) -> Vec<serde_json::Map<String, serde_json::Value>> {
        let mut m = serde_json::Map::new();
        m.insert("event_type".into(), serde_json::json!(ty));
        m.insert("device_id".into(), serde_json::json!(device));
        m.insert("client_ts".into(), serde_json::json!(1_783_000_000_000i64));
        vec![m]
    }

    fn sink(vl_url: &str, token: Option<&str>) -> ApmSink {
        ApmSink {
            client: reqwest::Client::builder().build().unwrap(),
            vl_url: vl_url.to_string(),
            token: token.map(str::to_string),
        }
    }

    /// Auth is enforced BEFORE any forward — a missing/wrong bearer is 401 and never
    /// touches VL (so this needs no network).
    #[tokio::test]
    async fn ingest_rejects_missing_or_wrong_token() {
        let st = state_with(Some(sink("http://127.0.0.1:1/unused", Some("s3cr3t")))).await;

        let missing = api_ingest(
            State(st.clone()),
            HeaderMap::new(),
            Json(one_event("d", "x")),
        )
        .await
        .into_response();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);

        let mut wrong = HeaderMap::new();
        wrong.insert(header::AUTHORIZATION, "Bearer nope".parse().unwrap());
        let bad = api_ingest(State(st.clone()), wrong, Json(one_event("d", "x")))
            .await
            .into_response();
        assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    }

    /// With no token configured the endpoint is open (dev/LAN); an empty batch is a
    /// no-op 200 without any forward.
    #[tokio::test]
    async fn ingest_open_when_no_token_and_empty_is_ok() {
        let st = state_with(Some(sink("http://127.0.0.1:1/unused", None))).await;
        let empty: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
        let r = api_ingest(State(st), HeaderMap::new(), Json(empty))
            .await
            .into_response();
        assert_eq!(r.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn ingest_rejects_oversized_event_batch_without_forwarding() {
        let st = state_with(Some(sink("http://127.0.0.1:1/unused", None))).await;
        let events = (0..=APM_MAX_EVENTS)
            .map(|_| one_event("d", "x").pop().unwrap())
            .collect();
        let r = api_ingest(State(st), HeaderMap::new(), Json(events))
            .await
            .into_response();
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// Live end-to-end: a good-token batch is forwarded to the real host VictoriaLogs
    /// and accepted (200). Needs VL up on :6302 → `#[ignore]`d in normal runs; run with
    /// `cargo test --ignored ingest_forwards_to_live_vl`.
    #[tokio::test]
    #[ignore = "needs a live VictoriaLogs on 127.0.0.1:6302"]
    async fn ingest_forwards_to_live_vl() {
        let vl = "http://127.0.0.1:6302/insert/jsonline\
                  ?_msg_field=_msg&_time_field=client_ts&_stream_fields=device_id,event_type";
        let st = state_with(Some(sink(vl, Some("s3cr3t")))).await;
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer s3cr3t".parse().unwrap());
        let r = api_ingest(State(st), h, Json(one_event("apmtest-integ", "audio_play")))
            .await
            .into_response();
        assert_eq!(r.status(), StatusCode::OK);
    }
}
