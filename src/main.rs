mod artwork;
mod audio_http;
mod audio_optimize;
mod check;
mod cli;
mod config;
#[cfg(test)]
mod http_tests;
mod interactive_view;
mod library;
mod server;
mod shared;
mod store;
mod sync;
mod tags;

pub use audio_http::{AUDIO_ENCODING_VERSION, AUDIO_VARIANT, transcode_audio};
use audio_http::{api_audio, api_marks, load_book_end_phrases};
use axum::{
    Extension, Router,
    body::Body,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use clap::Parser;
use cli::{Cli, Command};
use config::{Config, RenditionKind, Resolved, auto_discover, implicit_resolved};
use server::bytes::{ranged_bytes_response, stored_blob_response};
use server::catalog::Catalog;
use server::state::{ApmSink, AppState, CachedJson, SharedState};
use shared::{FileContent, FileType, TreeNode, WsMessage};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use store::model::{AudioBake, ChapterRecord, ProgressEntry};
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

/// Pull Vite's content-hashed entry-bundle name out of index.html. New native
/// OTA builds are flat (`index-D4f8aB2c.js`) so pre-0.1.21 hosts never receive
/// a URL-encoded slash; the PWA keeps the legacy `assets/index-...js` form.
fn entry_bundle(html: &str) -> Option<String> {
    let mut offset = 0;
    while let Some(relative_start) = html[offset..].find("index-") {
        let start = offset + relative_start;
        let tail = &html[start..];
        let relative_end = tail.find(".js")?;
        let bare = &tail[..relative_end + 3];
        if bare
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            let prefix = if html[..start].ends_with("assets/") {
                "assets/"
            } else {
                ""
            };
            return Some(format!("{prefix}{bare}"));
        }
        offset = start + "index-".len();
    }
    None
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
        Some(Command::Dir(args)) => {
            if let Err(error) = rt.block_on(run_dir(args)) {
                eprintln!("dir error: {error}");
                std::process::exit(1);
            }
        }
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
        dangling_audio = report.dangling_audio,
        deleted = report.deleted,
        orphans_gc = report.orphans_gc,
        check_warnings = report.check_warnings,
        root = %report.root,
        "sync complete"
    );
    let root_short = &report.root[..report.root.len().min(12)];
    println!(
        "sync: {} books, {} put, {} audio queued, {} skipped, {} stale-audio re-baked, {} missing-audio re-baked, {} deleted, {} gc'd, {} check warnings, root {root_short}",
        report.books,
        report.put,
        report.enqueued,
        report.skipped,
        report.stale_audio,
        report.dangling_audio,
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
///
/// NOTIFY is not durable: a sync that finishes while the listener is
/// disconnected is never delivered. So the connection loss is observed
/// explicitly (`try_recv` → `None`) and, once `LISTEN` is re-established, the
/// catalog is reloaded unconditionally to pick up anything missed meanwhile.
fn spawn_reload_listener(state: SharedState, database_url: String) {
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

async fn reload_catalog(state: &AppState, reason: &'static str) {
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
    // The bytes are content-addressed, but the MIME type comes from the asset
    // row. A store error is a 503; a missing row (the object is written before
    // its row) serves generic bytes with a short, revalidating cache so a wrong
    // content type is never pinned as `immutable`.
    let (mime, cache_control) = match state.store.get_asset(&hash).await {
        Ok(Some(a)) => (a.mime, "public, max-age=31536000, immutable"),
        Ok(None) => ("application/octet-stream".to_string(), "no-cache"),
        Err(error) => return store_unavailable("get_asset", error),
    };
    stored_blob_response(&state, &hash, &headers, &mime, cache_control)
        .await
        .unwrap_or_else(|_| (StatusCode::NOT_FOUND, "blob not found").into_response())
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
    let root = match state.store.manifest_root().await {
        Ok(value) => value.unwrap_or_default(),
        Err(error) => return store_unavailable("manifest_root", error),
    };
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
    let root = match state.store.manifest_root().await {
        Ok(value) => value.unwrap_or_default(),
        Err(error) => return store_unavailable("manifest_root", error),
    };
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
        // Values are percent-encoded so `&`, `+`, `#`, `%`, spaces and non-ASCII
        // in a rel_path survive the handlers' form-urlencoded query decoding.
        let q = format!(
            "path={}&lang={}&rendition={}",
            encode_query_value(&format!("{}/{}", c.book_slug, c.rel_path)),
            encode_query_value(&c.lang),
            encode_query_value(&c.rendition)
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
            // native cache key, and integrity identity the SAME value.
            resources.push(serde_json::json!({
                "path": format!("{doc}#audio"), "hash": h, "kind": "audio",
                "bytes": c.audio_size.unwrap_or(0),
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
        "url": format!("/api/{kind}?book={}", encode_query_value(slug)),
    })
}

/// Percent-encode one query-string value for the `/api/*` handlers, whose
/// `Query` extractor decodes `application/x-www-form-urlencoded`. Unreserved
/// characters and `/` stay literal so ordinary chapter URLs are byte-identical
/// to the historical unencoded form; everything else (including `+`, which the
/// form decoder would read as a space) is encoded as UTF-8 `%XX`.
fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `GET /api/sizes` — PRECOMPUTED download totals (per-book + global), keyed by
/// the deploy root, so the Downloads UI gets a TINY response instead of fetching
/// + parsing the ~4 MB `/api/dag` just to sum sizes. Same byte accounting as the
///
/// dag (canonical audio uses its exact object size). The client caches this by `root` and
/// re-fetches only when the root changes; the per-device CACHED progress is the
/// client's own index — this endpoint is the denominator, not the numerator.
async fn api_sizes(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let root = match state.store.manifest_root().await {
        Ok(value) => value.unwrap_or_default(),
        Err(error) => return store_unavailable("manifest_root", error),
    };
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
            let b = c.audio_size.unwrap_or(0);
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

/// Dedicated APM credential header. `Authorization` is owned by the optional
/// LIVEVIEW_ACCESS_TOKEN proxy policy (the trusted proxy overwrites it on every
/// upstream request), so a client behind that proxy cannot also carry the APM
/// bearer there. This header carries the APM token independently.
const APM_TOKEN_HEADER: &str = "x-liveview-apm-token";

/// The APM token may arrive in [`APM_TOKEN_HEADER`] or, for existing clients,
/// as `Authorization: Bearer <token>`.
fn apm_token_matches(headers: &HeaderMap, want: &str) -> bool {
    let dedicated = headers
        .get(APM_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    dedicated == Some(want) || bearer == Some(want)
}

async fn api_ingest(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut events): Json<Vec<serde_json::Map<String, serde_json::Value>>>,
) -> impl IntoResponse {
    let Some(apm) = state.apm.as_ref() else {
        // No VL configured (preview) — accept + drop so a dev client doesn't spin.
        return StatusCode::OK;
    };
    // Token auth when a token is configured; an open sink requires explicit
    // LIVEVIEW_APM_ALLOW_UNAUTHENTICATED configuration at startup.
    if let Some(want) = apm.token.as_deref()
        && !apm_token_matches(&headers, want)
    {
        return StatusCode::UNAUTHORIZED;
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
        let mut allowed_origins = allowed_origins;
        // WKWebView document origin after the content store moved to TS fetch.
        for origin in ["lvsync://localhost", "tauri://localhost"] {
            if !allowed_origins.iter().any(|value| value == origin) {
                allowed_origins.push(origin.parse().expect("static origin"));
            }
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

type CompressPredicateFn =
    fn(StatusCode, axum::http::Version, &HeaderMap, &axum::http::Extensions) -> bool;

/// Compress only textual API bodies (JSON, text, JS, SVG). Audio, blobs,
/// images, PDFs and every partial (206 / `Content-Range`) response pass through
/// untouched so they keep their `Content-Length` and `Accept-Ranges`.
fn api_response_is_compressible(
    status: StatusCode,
    _version: axum::http::Version,
    headers: &HeaderMap,
    _extensions: &axum::http::Extensions,
) -> bool {
    if status == StatusCode::PARTIAL_CONTENT || headers.contains_key(header::CONTENT_RANGE) {
        return false;
    }
    let Some(content_type) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence.starts_with("text/")
        || essence == "application/json"
        || essence.ends_with("+json")
        || essence == "application/javascript"
        || essence == "application/x-ndjson"
        || essence == "image/svg+xml"
}

fn build_app(state: SharedState) -> Result<Router, String> {
    Ok(build_app_with_policy(state, HttpPolicy::from_env()?))
}

fn build_app_with_policy(state: SharedState, policy: HttpPolicy) -> Router {
    use tower_http::compression::Predicate as _;
    let mut api_router = Router::new()
        .route("/api/books", get(api_books))
        .route(
            "/api/library",
            get(api_library_get).post(api_library_change),
        )
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
        // Media and blob bytes are NOT: compressing them wastes CPU and, worse,
        // strips `Content-Length` / `Accept-Ranges`, which breaks seeking and
        // download-size accounting. See `api_response_is_compressible`.
        .layer(
            tower_http::compression::CompressionLayer::new().compress_when(
                tower_http::compression::DefaultPredicate::new()
                    .and(api_response_is_compressible as CompressPredicateFn),
            ),
        );

    #[cfg(feature = "embedded")]
    let app = {
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
    };

    #[cfg(not(feature = "embedded"))]
    let app = {
        use tower_http::services::ServeDir;
        let serve_dir = ServeDir::new("web/dist")
            .append_index_html_on_directories(true)
            .fallback(ServeDir::new("web/dist").append_index_html_on_directories(true));
        api_router
            .fallback_service(serve_dir)
            .layer(Extension(state))
    };

    // Native shells always appear in `allowed_origins`. Extra reader hosts are
    // exact opt-in via LIVEVIEW_ALLOWED_ORIGINS; wildcard reflection is rejected.
    // Apply CORS after the embedded/static routes are attached: OTA requests use
    // If-None-Match, so WKWebView preflights /app-dist/manifest.json as well as
    // /api. Layering only the API router makes that preflight fall through to a
    // GET-only asset route and fail with 405 before the updater sees a manifest.
    app.layer(
        tower_http::cors::CorsLayer::new()
            .allow_origin(policy.allowed_origins)
            .allow_methods([Method::GET, Method::POST, Method::PUT])
            .allow_headers([
                header::AUTHORIZATION,
                header::CONTENT_TYPE,
                header::IF_NONE_MATCH,
                HeaderName::from_static(APM_TOKEN_HEADER),
            ])
            // Cache preflights: every conditional DAG/manifest fetch from the
            // native shell is otherwise preceded by an OPTIONS round trip.
            // Browsers clamp this to their own maximum.
            .max_age(std::time::Duration::from_secs(3600)),
    )
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
    // A store error is a 503, not an empty `[]`: an empty spine is a valid,
    // cacheable answer that the offline replica would keep until the next root.
    match state.store.get_site_tree(kind.as_str()).await {
        Ok(json) => (
            [(header::CONTENT_TYPE, "application/json")],
            json.unwrap_or_else(|| "[]".to_string()),
        )
            .into_response(),
        Err(error) => store_unavailable("get_site_tree", error),
    }
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
        // Never answer `{}` on failure: the client would reconcile its local
        // settings against an empty server state.
        Err(error) => store_unavailable("settings_all", error),
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
    // Degraded metadata (store error or missing asset row) ⇒ generic bytes that
    // the client must revalidate, never the caller's long-lived cache policy.
    let (mime, cache) = match state.store.get_asset(hash).await {
        Ok(Some(asset)) => (asset.mime, cache),
        Ok(None) => ("application/octet-stream".to_string(), "no-cache"),
        Err(error) => {
            tracing::warn!(%error, hash, "asset metadata read failed");
            ("application/octet-stream".to_string(), "no-store")
        }
    };
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
    // No (readable) cover: synthesize the slug's gradient as a PNG off the
    // async workers (the deflate pass is CPU-bound).
    let slug = q.book.clone();
    let png = match tokio::task::spawn_blocking(move || artwork::gradient_png(&slug)).await {
        Ok(Ok(png)) => png,
        Ok(Err(error)) => {
            tracing::warn!(%error, "gradient cover synthesis failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "artwork").into_response();
        }
        Err(error) => {
            tracing::warn!(%error, "gradient cover task failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "artwork").into_response();
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(png))
        .unwrap()
        .into_response()
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

/// Split a wire path `<slug>/<rel_path>` and validate `rel_path` as a strictly
/// relative, normalized path under the book. `None` for an empty path, an
/// absolute path, or any empty / `.` / `..` / NUL-bearing segment — the
/// filesystem preview joins `rel_path` onto the book's source directory, so a
/// traversal segment would otherwise escape it.
fn split_request_path(path: &str) -> Option<(&str, &str)> {
    let (slug, rest) = path.split_once('/')?;
    if slug.is_empty() || !is_safe_rel_path(rest) {
        return None;
    }
    Some((slug, rest))
}

fn is_safe_rel_path(rest: &str) -> bool {
    !rest.is_empty()
        && rest
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.contains('\0'))
        && Path::new(rest)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Resolve `(path, rendition token, lang)` against the catalog: the book picks
/// the rendition (the token, else its default); the rendition picks the lang
/// (the query, else its default). `None` ⇒ unknown book or an unsafe path.
async fn resolve_req(state: &AppState, q: &FileQuery) -> Option<ReqCtx> {
    let (slug, rest) = split_request_path(&q.path)?;
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
    let (slug, rest) = split_request_path(&q.path)?;
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
///
/// A store error is propagated, never treated as "absent": silently falling
/// back to the raw `.md` would synthesize (and cache under the chapter's
/// content-addressed key) narration from the wrong source.
async fn resolve_narration(
    state: &AppState,
    ctx: &ReqCtx,
) -> Result<Option<(ChapterRecord, String)>, String> {
    if ctx.kind == RenditionKind::Text
        && let Some(stem) = ctx.rest.strip_suffix(".md")
    {
        let spoken = format!("{stem}.spoken.md");
        if let Some(hit) = state
            .store
            .get_chapter_fallback(&ctx.slug, "text", &ctx.lang, &ctx.default_lang, &spoken)
            .await?
        {
            return Ok(Some(hit));
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
        .await?;
    if direct.is_some() || ctx.kind != RenditionKind::Audio {
        return Ok(direct);
    }

    // Some `book.toml` corpora expose an audiobook spine as virtual
    // `<id>.spoken.md` paths while storing the generated narration on the source
    // text chapter (`<id>.md`). Prefer a real curated audio row above, then map
    // that virtual path back to its text source. Audio, marks, and transcript all
    // use this same fallback so their sentence indexes stay aligned.
    let Some(text_path) = audio_text_fallback_path(&ctx.rest) else {
        return Ok(None);
    };
    state
        .store
        .get_chapter_fallback(&ctx.slug, "text", &ctx.lang, &ctx.default_lang, &text_path)
        .await
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
        Ok(Some((row, served_lang))) => {
            let md = row.markdown.unwrap_or_default();
            Json(SpokenContent {
                lang: served_lang,
                sentences: server::spoken::spoken_sentences(&md),
            })
            .into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => store_unavailable("resolve_narration", error),
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
        Ok(None) => (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => store_unavailable("get_chapter_fallback", error),
    }
}

/// Raw binary (image / PDF) bytes for a chapter, streamed from rustfs.
async fn api_raw(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let Some(ctx) = resolve_req(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let row = match state
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
        Ok(Some((row, _))) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => return store_unavailable("get_chapter_fallback", error),
    };
    let Some(hash) = row.asset_hash else {
        return (StatusCode::NOT_FOUND, "not a binary asset").into_response();
    };
    match blob_response(&state, &hash, "public, max-age=3600").await {
        Some(resp) => resp,
        None => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

async fn api_library_get(State(state): State<SharedState>) -> axum::response::Response {
    match state.store.library_get().await {
        Ok(library) => Json(library).into_response(),
        Err(error) => store_unavailable("library_get", error),
    }
}
async fn api_library_change(
    State(state): State<SharedState>,
    Json(change): Json<library::Change>,
) -> axum::response::Response {
    match state.store.library_change(&change).await {
        Ok(library) => Json(library).into_response(),
        Err(error) => (
            if error.starts_with("Revision conflict") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            error,
        )
            .into_response(),
    }
}

async fn run_dir(args: cli::DirArgs) -> Result<(), String> {
    let mut headers = HeaderMap::new();
    if let Some(token) = args.token {
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}")
                .parse()
                .map_err(|_| "Invalid access token")?,
        );
    }
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/api/library", args.server.trim_end_matches('/'));
    let response = match args.command {
        cli::DirCommand::Tree => client.get(url).send().await,
        cli::DirCommand::Apply { plan, dry_run } => {
            let bytes = std::fs::read(plan).map_err(|e| e.to_string())?;
            let mut change: library::Change = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            change.dry_run |= dry_run;
            client.post(url).header("Content-Type", "application/json").body(serde_json::to_vec(&change).map_err(|e| e.to_string())?).send().await
        }
        cli::DirCommand::Undo { revision, expected_revision } => client.post(url).header("Content-Type", "application/json").body(serde_json::json!({"revision":expected_revision,"operations":[],"undo_revision":revision}).to_string()).send().await,
    }.map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{status}: {body}"));
    }
    println!("{body}");
    Ok(())
}

#[cfg(test)]
mod apm_tests {
    use super::*;
    use crate::store::fs::FsStore;
    use tower::ServiceExt;

    #[test]
    fn entry_bundle_accepts_flat_native_and_nested_pwa_paths() {
        assert_eq!(
            entry_bundle(
                r#"<link href="./index-style.css"><script src="./index-flat.js"></script>"#
            )
            .as_deref(),
            Some("index-flat.js")
        );
        assert_eq!(
            entry_bundle(r#"<script src="/assets/index-pwa.js"></script>"#).as_deref(),
            Some("assets/index-pwa.js")
        );
    }

    #[test]
    fn http_policy_defaults_to_native_shell_origins_without_authentication() {
        let policy = HttpPolicy::parse(None, None).unwrap();
        assert_eq!(policy.allowed_origins.len(), 2);
        assert_eq!(policy.allowed_origins[0], "lvsync://localhost");
        assert_eq!(policy.allowed_origins[1], "tauri://localhost");
        assert!(policy.access_token.is_none());
    }

    #[test]
    fn http_policy_accepts_exact_origins_and_rejects_wildcards() {
        let policy = HttpPolicy::parse(
            Some("tauri://localhost, https://reader.example.org"),
            Some("proxy-secret".into()),
        )
        .unwrap();
        assert_eq!(policy.allowed_origins.len(), 3);
        assert_eq!(policy.allowed_origins[0], "tauri://localhost");
        assert_eq!(policy.allowed_origins[2], "lvsync://localhost");
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
                axum::http::Request::get("/api/books")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let authorized = app
            .oneshot(
                axum::http::Request::get("/api/books")
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

    #[tokio::test]
    async fn cors_allows_lvsync_localhost_and_if_none_match() {
        let policy = HttpPolicy::parse(None, None).unwrap();
        let app = build_app_with_policy(state_with(None).await, policy);
        for path in ["/api/books", "/app-dist/manifest.json"] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method(Method::OPTIONS)
                        .uri(path)
                        .header(header::ORIGIN, "lvsync://localhost")
                        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                        .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "if-none-match")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "preflight path {path}");
            assert_eq!(
                response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                Some(&HeaderValue::from_static("lvsync://localhost")),
                "preflight path {path}"
            );
            let allowed = response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();
            assert!(
                allowed.contains("if-none-match"),
                "preflight path {path} must allow If-None-Match, got {allowed:?}"
            );
        }
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
