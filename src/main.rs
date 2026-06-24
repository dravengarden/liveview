mod check;
mod cli;
mod config;
mod server;
mod shared;
mod store;
mod sync;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
    Extension, Router,
};
use clap::Parser;
use cli::{Cli, Command};
use config::{auto_discover, implicit_resolved, Config, RenditionKind, Resolved};
use server::catalog::Catalog;
use server::state::{AppState, SharedState};
use shared::{FileContent, FileType, TreeNode, WsMessage};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use store::pg::{PgStore, ProgressEntry};
use sync::objstore::ObjStore;
use tokio::sync::{broadcast, RwLock};
use tracing_subscriber::EnvFilter;

#[cfg(feature = "embedded")]
mod embedded_assets {
    use axum::extract::Path;
    use axum::http::{header, StatusCode};
    use axum::response::{Html, IntoResponse};
    use include_dir::{include_dir, Dir};

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

    fn serve_file(path: &str) -> impl IntoResponse {
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

    pub async fn serve_index() -> impl IntoResponse {
        match index_html() {
            // `no-cache`: the navigation entry point must revalidate so a deploy's
            // new bundle refs (and thus the new SW) reach the device — same reason
            // as `sw.js` in `cache_control_for`.
            Some(html) => (
                [(header::CACHE_CONTROL, "no-cache")],
                Html(html),
            )
                .into_response(),
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
        std::process::exit(check::readaloud::plan_run(&args.paths, &args.lang, args.format));
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
        // `liveview check` / `targets` are handled (and exit) above, before the
        // runtime is built — they never reach this match.
        Some(Command::Check(_)) => unreachable!("check handled before the tokio runtime"),
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
    let targets =
        match check::targets::collect(&resolved, &args.base_url, args.book.as_deref()) {
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
        tts_cmd: args.edge_tts_cmd,
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
        deleted = report.deleted,
        orphans_gc = report.orphans_gc,
        check_warnings = report.check_warnings,
        root = %report.root,
        "sync complete"
    );
    let root_short = &report.root[..report.root.len().min(12)];
    println!(
        "sync: {} books, {} put, {} audio queued, {} skipped, {} deleted, {} gc'd, {} check warnings, root {root_short}",
        report.books,
        report.put,
        report.enqueued,
        report.skipped,
        report.deleted,
        report.orphans_gc,
        report.check_warnings
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
    if let Ok(Some(json)) = state.store.get_site_tree("text").await {
        if let Ok(tree) = serde_json::from_str::<Vec<TreeNode>>(&json) {
            if let Ok(s) = serde_json::to_string(&WsMessage::TreeUpdate { tree }) {
                let _ = state.tx.send(s);
            }
        }
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
    let tts_cmd = env("LIVEVIEW_EDGE_TTS_CMD").unwrap_or_else(|| "edge-tts".to_string());
    let tts_voice =
        env("LIVEVIEW_TTS_VOICE").unwrap_or_else(|| "zh-CN-XiaoxiaoNeural".to_string());

    // Drain the audio task queue in the background (sync only enqueues now).
    crate::server::audio_worker::spawn(worker_pg, worker_obj, tts_cmd.clone(), tx.clone());

    let state: SharedState = Arc::new(AppState {
        tx,
        store,
        obj,
        catalog: RwLock::new(catalog),
        tts_cmd,
        tts_voice,
        book_end_cue: Default::default(),
        audio_synth_locks: Default::default(),
    });

    // Reload the catalog + nudge clients when `liveview sync` issues NOTIFY.
    spawn_reload_listener(state.clone(), conf.database_url.clone());

    let app = build_app(state);
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
        tts_cmd: env("LIVEVIEW_EDGE_TTS_CMD").unwrap_or_else(|| "edge-tts".to_string()),
        tts_voice: env("LIVEVIEW_TTS_VOICE").unwrap_or_else(|| "zh-CN-XiaoxiaoNeural".to_string()),
        book_end_cue: Default::default(),
        audio_synth_locks: Default::default(),
    });

    let app = build_app(state);
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
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
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

/// `GET /api/manifest` — the top-level Merkle manifest: the deploy root + each
/// book's subtree hash (the SW's O(1) "anything changed?" + per-book prune) plus
/// an audio-readiness rollup for the shelf badge.
async fn api_manifest(State(state): State<SharedState>) -> impl IntoResponse {
    let (root, books) = state.store.manifest_books().await.unwrap_or((None, Vec::new()));
    let mut audio: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    for r in state.store.audio_task_rollup().await.unwrap_or_default() {
        if let Some(s) = r.book_slug {
            audio.insert(s, (r.done, r.total));
        }
    }
    let updated: std::collections::HashMap<String, i64> = state
        .store
        .list_books()
        .await
        .unwrap_or_default()
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
    let chapters = state.store.manifest_chapters(&slug).await.unwrap_or_default();
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
/// deploy root + every resource (text / units / spoken / audio / marks / asset)
/// as `{ path, hash, kind, bytes, url }`. `hash` is the content address (cache
/// key); `url` is where to fetch it; `bytes` drives the byte-weighted offline %.
/// One round-trip → the client has the full content-addressed index.
/// `GET /api/root` — just the Merkle deploy root, the CHEAPEST possible "did
/// anything change?" probe. The offline client compares this against its cached
/// manifest's root: if equal, the whole tree is unchanged → reuse everything,
/// skip the full `/api/dag` fetch + the per-resource rescan. One hash, no work.
async fn api_root(State(state): State<SharedState>) -> impl IntoResponse {
    let (root, _) = state.store.manifest_books().await.unwrap_or((None, Vec::new()));
    Json(serde_json::json!({ "root": root })).into_response()
}

async fn api_dag(State(state): State<SharedState>) -> impl IntoResponse {
    let (root, _) = state.store.manifest_books().await.unwrap_or((None, Vec::new()));
    let chapters = state.store.dag_chapters().await.unwrap_or_default();
    let mut resources: Vec<serde_json::Value> = Vec::new();
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
            // Read-along extras exist for the text rendition (derived from the
            // displayed markdown). Keyed off content_hash so they're stable per
            // source; they're tiny, so bytes=0 (audio dominates the % anyway).
            if c.rendition == "text" {
                resources.push(serde_json::json!({
                    "path": format!("{doc}#units"), "hash": format!("{}:units", c.content_hash),
                    "kind": "units", "bytes": 0, "url": format!("/api/units?{q}"),
                }));
                resources.push(serde_json::json!({
                    "path": format!("{doc}#spoken"), "hash": format!("{}:spoken", c.content_hash),
                    "kind": "spoken", "bytes": 0, "url": format!("/api/spoken?{q}"),
                }));
            }
        }
        if let Some(h) = &c.audio_hash {
            // Audio downloads go through /api/audio (NOT the raw /api/blob) — it
            // ALWAYS serves the compressed variant now (MP3 fully sunset), so the
            // device stores the small Opus. `hash` stays the SOURCE audio_hash —
            // the content-address key the player's stream shares — so a downloaded
            // file is found on offline playback. `bytes` ≈ compressed size (×0.33).
            resources.push(serde_json::json!({
                "path": format!("{doc}#audio"), "hash": h, "kind": "audio",
                "bytes": c.audio_size.unwrap_or(0) * 33 / 100,
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
    Json(serde_json::json!({ "root": root, "resources": resources })).into_response()
}

/// `GET /api/sizes` — PRECOMPUTED download totals (per-book + global), keyed by
/// the deploy root, so the Downloads UI gets a TINY response instead of fetching
/// + parsing the ~4 MB `/api/dag` just to sum sizes. Same byte accounting as the
/// dag (audio ≈ source ×0.33 compressed). The client caches this by `root` and
/// re-fetches only when the root changes; the per-device CACHED progress is the
/// client's own index — this endpoint is the denominator, not the numerator.
async fn api_sizes(State(state): State<SharedState>) -> impl IntoResponse {
    let (root, _) = state.store.manifest_books().await.unwrap_or((None, Vec::new()));
    let chapters = state.store.dag_chapters().await.unwrap_or_default();
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
            // Match the dag's compressed estimate (Opus ≈ source ×0.33).
            let b = c.audio_size.unwrap_or(0) * 33 / 100;
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
    Json(serde_json::json!({
        "root": root,
        "audio_bytes": total.audio_bytes, "audio_count": total.audio_count,
        "text_bytes": total.text_bytes, "text_count": total.text_count,
        "books": books_json,
    }))
    .into_response()
}

fn build_app(state: SharedState) -> Router {
    let api_router = Router::new()
        .route("/api/books", get(api_books))
        .route("/api/cover", get(api_cover))
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
        .route("/ws", get(server::ws::ws_handler))
        .with_state(state.clone());

    #[cfg(feature = "embedded")]
    {
        api_router
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
}

/// Save one document's scroll position (debounced by the client).
async fn api_progress_put(
    State(state): State<SharedState>,
    Json(body): Json<ProgressUpdate>,
) -> impl IntoResponse {
    match state.store.progress_upsert(&body.path, body.scroll).await {
        Ok(()) => StatusCode::NO_CONTENT,
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
    match state.store.settings_set(&body.key, &body.value).await {
        Ok(()) => {
            // Broadcast the change so other clients' mirrored stores re-reconcile
            // live (cross-device), mirroring `broadcast_tree`. Clone before the
            // response so the PUT's own return value is unaffected.
            if let Ok(s) = serde_json::to_string(&WsMessage::SettingUpdate {
                key: body.key.clone(),
                value: body.value.clone(),
            }) {
                let _ = state.tx.send(s);
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
    /// Optional shelf grouping key (book.toml top-level `collection`).
    collection: Option<String>,
    /// Whether a cover image is available at `/api/cover?book=<slug>`.
    cover: bool,
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
                collection: b.collection.clone(),
                cover: b.cover_hash.is_some(),
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
    if let Some(h) = hash {
        if let Some(resp) = blob_response(&state, &h, "public, max-age=3600").await {
            return resp;
        }
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
async fn resolve_narration(
    state: &AppState,
    ctx: &ReqCtx,
) -> Option<(store::pg::ChapterRow, String)> {
    if ctx.kind == RenditionKind::Text {
        if let Some(stem) = ctx.rest.strip_suffix(".md") {
            let spoken = format!("{stem}.spoken.md");
            if let Ok(Some(hit)) = state
                .store
                .get_chapter_fallback(&ctx.slug, "text", &ctx.lang, &ctx.default_lang, &spoken)
                .await
            {
                return Some(hit);
            }
        }
    }
    state
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
        .get_chapter_fallback(&ctx.slug, ctx.kind.as_str(), &ctx.lang, &ctx.default_lang, &ctx.rest)
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

/// The single compressed-audio variant. On-the-fly transcode of the source MP3,
/// cached in the obj store under "<cachekey>.<TAG>". Audiobook narration is mono
/// speech, so a low-bitrate speech codec is near-transparent at a fraction of the
/// size (~67% smaller at Opus 16k vs the 48k MP3). iOS AVPlayer MUST support the
/// container — Opus-in-CAF is the default. To change codec/bitrate, edit these
/// four fields (and, to reclaim space, drop the old "*.TAG" obj keys); nothing is
/// re-baked — the next request re-transcodes lazily. Guaranteed-playable fallback
/// if Opus-CAF ever misbehaves: tag "aac24", mime "audio/mp4", ext "m4a",
/// args ["-c:a","aac","-b:a","24k","-ac","1"].
pub struct AudioVariant {
    pub tag: &'static str,
    pub mime: &'static str,
    ext: &'static str,
    args: &'static [&'static str],
}
pub const AUDIO_VARIANT: AudioVariant = AudioVariant {
    tag: "op16c",
    mime: "audio/x-caf",
    ext: "caf",
    args: &["-c:a", "libopus", "-b:a", "16k", "-ac", "1", "-application", "voip"],
};

/// Transcode an MP3 (`src`) per `AUDIO_VARIANT`. ffmpeg reads stdin and writes a
/// temp file (CAF/MP4 muxers need seekable output), which we read back + delete.
pub async fn transcode_audio(src: Vec<u8>) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncWriteExt;
    let mut tmp = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    tmp.push(format!("lvtc-{}-{nanos}.{}", std::process::id(), AUDIO_VARIANT.ext));
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
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&src).await.map_err(|e| e.to_string())?;
        drop(stdin);
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("ffmpeg: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let bytes = tokio::fs::read(&tmp).await.map_err(|e| e.to_string());
    let _ = tokio::fs::remove_file(&tmp).await;
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
            let _ = state.obj.put_if_absent(&key, b.clone(), AUDIO_VARIANT.mime).await;
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
                // ALWAYS the compressed variant — MP3 is fully sunset client-side
                // (the source MP3 is only the internal transcode input). One format.
                Ok(data) => {
                    let (b, mime) = compressed_audio(&state, &audio_hash, data).await;
                    serve_audio_range(b, &headers, mime)
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
    let Some((row, _)) = state
        .store
        .get_chapter_fallback(&ctx.slug, "audio", &ctx.lang, &ctx.default_lang, &ctx.rest)
        .await
        .ok()
        .flatten()
    else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let hash = match ensure_chapter_audio(&state, &row).await {
        Ok((audio_hash, _)) => audio_hash,
        Err(e) => {
            tracing::warn!(error = %e, "on-demand audio synth failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response();
        }
    };
    let Ok(mut data) = state.obj.get(&hash).await else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "read audio").into_response();
    };
    // The book's last chapter carries a spoken "全书完" tail (client sends
    // `tail=bookend` only for that chapter). Bake it into the served bytes so it
    // plays through the same MediaSession element — on the lock screen / in the
    // background, where a client-side cue would be silent. MP3 frames concatenate
    // cleanly (same as `assemble()` joins per-sentence clips). Marks are
    // untouched: the tail sits past the last sentence's end_ms, a silent gap in
    // the read-along. Only the last chapter pays the (tiny) append.
    let is_bookend = query.tail.as_deref() == Some("bookend");
    if is_bookend {
        if let Some(cue) = book_end_cue(&state, &row).await {
            data.extend_from_slice(&cue);
        }
    }
    // ALWAYS the compressed variant — MP3 is fully sunset client-side (one format;
    // the source MP3 is only the internal transcode input). Cached by the source
    // hash (+ ".tail" when the bookend cue is baked in, which differs from the blob).
    let ck = if is_bookend { format!("{hash}.tail") } else { hash.clone() };
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
    let Some((row, _)) = state
        .store
        .get_chapter_fallback(&ctx.slug, "audio", &ctx.lang, &ctx.default_lang, &ctx.rest)
        .await
        .ok()
        .flatten()
    else {
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
    row: &store::pg::ChapterRow,
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
            .unwrap_or_else(|| state.tts_voice.clone())
    };
    let (mp3, marks) = server::audio::synthesize(&state.tts_cmd, &voice, &sentences).await?;
    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    let audio_hash = store_blob(state, mp3, "audio/mpeg").await?;
    let marks_hash = store_blob(state, marks_json, "application/json").await?;
    state
        .store
        .set_chapter_audio(
            &row.book_slug,
            "audio",
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
        .get_chapter_fallback(&ctx.slug, ctx.kind.as_str(), &ctx.lang, &ctx.default_lang, &ctx.rest)
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
        .get_chapter_fallback(&ctx.slug, ctx.kind.as_str(), &ctx.lang, &ctx.default_lang, &ctx.rest)
        .await
    {
        if let (Some(a), Some(m)) = (fresh.audio_hash, fresh.marks_hash) {
            return Ok((a, m));
        }
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
            .unwrap_or_else(|| state.tts_voice.clone())
    };
    let (mp3, marks) = server::audio::synthesize(&state.tts_cmd, &voice, &texts).await?;
    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    let audio_hash = store_blob(state, mp3, "audio/mpeg").await?;
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

/// The spoken "end of the whole book" phrase for a language edition, matched by
/// language prefix (`zh`, `zh-CN`, `en`, `en-US`, …). Returns `None` for a
/// language we have no phrase for — better silence than a wrong-language tail.
fn book_end_phrase(lang: &str) -> Option<&'static str> {
    if lang.starts_with("zh") {
        Some("全书完")
    } else if lang.starts_with("en") {
        Some("The end.")
    } else {
        None
    }
}

/// The synthesized "end of book" cue for this chapter's voice + language,
/// cached in-process (keyed by `"{voice}|{phrase}"`). Returns `None` when the
/// language has no phrase or synthesis fails — the caller then serves the
/// chapter audio with no tail, never an error (a missing cue must not break
/// playback). The voice is the book's audio-rendition voice, mirroring
/// `ensure_chapter_audio`, so the cue matches the narration.
async fn book_end_cue(state: &AppState, row: &store::pg::ChapterRow) -> Option<Vec<u8>> {
    let phrase = book_end_phrase(&row.lang)?;
    let voice = {
        let cat = state.catalog.read().await;
        cat.book(&row.book_slug)
            .and_then(|b| b.rendition(RenditionKind::Audio))
            .and_then(|r| r.voice.clone())
            .unwrap_or_else(|| state.tts_voice.clone())
    };
    let key = format!("{voice}|{phrase}");
    if let Some(cue) = state.book_end_cue.lock().await.get(&key) {
        return Some(cue.as_ref().clone());
    }
    // Synthesize off-lock (a few-KB, ~1s edge-tts call); a rare double-synth
    // race is harmless — both produce the same tiny clip and the last write wins.
    let (mp3, _marks) =
        match server::audio::synthesize(&state.tts_cmd, &voice, &[phrase.to_string()]).await {
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
