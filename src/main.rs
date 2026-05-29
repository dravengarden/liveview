mod cli;
mod config;
mod server;
mod shared;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
    Extension, Router,
};
use clap::Parser;
use cli::Cli;
use config::{auto_discover, implicit_resolved, Config, Resolved};
use server::progress::{ProgressEntry, ProgressStore};
use server::state::{AppState, SharedState};
use shared::{FileContent, FileType};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio_util::io::ReaderStream;
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

    fn serve_file(path: &str) -> impl IntoResponse {
        match DIST_DIR.get_file(path) {
            Some(file) => {
                let mime = mime_guess::from_path(path).first_or_octet_stream();
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, mime.as_ref().to_string())],
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
            Some(html) => Html(html).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }
}

fn main() {
    let cli = Cli::parse();

    let filter = if cli.verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let resolved = match build_resolved(&cli) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(2);
        }
    };

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    rt.block_on(run(cli, resolved));
}

async fn run(cli: Cli, resolved: Resolved) {
    let host = cli.host.clone().unwrap_or(resolved.host);
    let port = cli.port.or(resolved.port);
    let should_open = cli.open || resolved.open;

    let initial_tree = server::tree::build_virtual_tree(&resolved.books);

    let (tx, _rx) = broadcast::channel::<String>(64);

    let progress = open_progress_store(&cli).await;

    let state: SharedState = Arc::new(AppState {
        tx,
        books: resolved.books,
        file_tree: RwLock::new(initial_tree),
        rendered_cache: RwLock::new(HashMap::new()),
        progress,
    });

    server::watcher::start_watcher(state.clone(), resolved.debounce_ms);

    for b in &state.books {
        for e in &b.editions {
            tracing::info!(
                "book /{:<16} [{:<6}]  =>  {}",
                b.slug,
                e.lang,
                e.source.display()
            );
        }
    }

    let api_router = Router::new()
        .route("/api/books", get(api_books))
        .route("/api/tree", get(api_tree))
        .route("/api/file", get(api_file))
        .route("/api/raw", get(api_raw))
        .route("/api/progress", get(api_progress_get).put(api_progress_put))
        .route("/api/progress/recent", get(api_progress_recent))
        .route("/ws", get(server::ws::ws_handler))
        .with_state(state.clone());

    #[cfg(feature = "embedded")]
    let app = {
        api_router
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

fn build_resolved(cli: &Cli) -> Result<Resolved, String> {
    if let Some(path) = &cli.config {
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

async fn api_tree(State(state): State<SharedState>) -> impl IntoResponse {
    let tree = state.file_tree.read().await;
    axum::Json(tree.clone())
}

#[derive(serde::Deserialize)]
struct ProgressQuery {
    /// Restrict to one book's chapters (newest first). Omitted ⇒ everything.
    book: Option<String>,
}

/// Reading progress for restoring scroll position / resuming the last-read
/// chapter. Returns `[]` when progress is disabled (no state dir).
async fn api_progress_get(
    State(state): State<SharedState>,
    Query(q): Query<ProgressQuery>,
) -> impl IntoResponse {
    let Some(store) = &state.progress else {
        return Json(Vec::<ProgressEntry>::new()).into_response();
    };
    let Some(slug) = q.book.as_deref() else {
        // `book` is required: the client always restores per-book. Without it,
        // return empty rather than dumping every book's rows.
        return Json(Vec::<ProgressEntry>::new()).into_response();
    };
    match store.for_book(slug).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "progress read failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// The latest-read chapter per book (newest first), for the landing page's
/// "continue reading" indicators. `[]` when progress is disabled.
async fn api_progress_recent(State(state): State<SharedState>) -> impl IntoResponse {
    let Some(store) = &state.progress else {
        return Json(Vec::<ProgressEntry>::new()).into_response();
    };
    match store.recent_per_book().await {
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

/// Save one document's scroll position (debounced by the client). No-op 204
/// when progress is disabled.
async fn api_progress_put(
    State(state): State<SharedState>,
    Json(body): Json<ProgressUpdate>,
) -> impl IntoResponse {
    let Some(store) = &state.progress else {
        return StatusCode::NO_CONTENT;
    };
    match store.upsert(&body.path, body.scroll).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::warn!(error = %e, "progress write failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// Resolve the state dir (`--state-dir`, else `$STATE_DIRECTORY` from systemd —
/// a colon-separated list, first entry wins) and open the progress db there.
/// `None` (no dir configured, or open failed) disables reading-progress.
async fn open_progress_store(cli: &Cli) -> Option<ProgressStore> {
    let dir = cli.state_dir.clone().or_else(|| {
        std::env::var_os("STATE_DIRECTORY").and_then(|v| {
            std::env::split_paths(&v).next().filter(|p| !p.as_os_str().is_empty())
        })
    })?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::error!(dir = %dir.display(), error = %e, "create state dir failed; reading-progress disabled");
        return None;
    }
    let db = dir.join("progress.db");
    match ProgressStore::open(&db).await {
        Ok(store) => {
            tracing::info!("reading-progress db: {}", db.display());
            Some(store)
        }
        Err(e) => {
            tracing::error!(db = %db.display(), error = %e, "open progress db failed; reading-progress disabled");
            None
        }
    }
}

#[derive(serde::Serialize)]
struct LangInfo {
    lang: String,
    label: String,
}

#[derive(serde::Serialize)]
struct BookInfo {
    label: String,
    slug: String,
    description: Option<String>,
    default_lang: String,
    langs: Vec<LangInfo>,
}

/// Lightweight list of books for the landing page ("bookshelf"): the curated
/// label, its slug (entry path), an optional blurb, and the available
/// language editions for the in-book language switcher.
async fn api_books(State(state): State<SharedState>) -> impl IntoResponse {
    let books: Vec<BookInfo> = state
        .books
        .iter()
        .map(|b| BookInfo {
            label: b.label.clone(),
            slug: b.slug.clone(),
            description: b.description.clone(),
            default_lang: b.default_lang.clone(),
            langs: b
                .editions
                .iter()
                .map(|e| LangInfo {
                    lang: e.lang.clone(),
                    label: e.label.clone(),
                })
                .collect(),
        })
        .collect();
    axum::Json(books)
}

#[derive(serde::Deserialize)]
struct FileQuery {
    path: String,
    /// Language edition to read. Omitted ⇒ the book's default edition.
    lang: Option<String>,
}

/// Resolve a virtual-path request (plus optional `lang`) to an on-disk path
/// using **overlay → base** fallback: try the requested `lang` edition first,
/// then the book's default (base) edition. Returns the canonical path plus the
/// language actually served. `Ok(None)` is "not found in any edition" (404);
/// `Err(())` is "outside an edition source" (403, traversal/symlink escape).
fn resolve_with_fallback(
    state: &AppState,
    virtual_path: &str,
    lang: Option<&str>,
) -> Result<Option<(PathBuf, String)>, ()> {
    // Candidate editions in priority order: the requested `lang` overlay, then
    // the book's default (base) edition (`None` ⇒ default). Editions share
    // structure, so a page/asset absent from the overlay is served from base.
    let mut candidates: Vec<Option<&str>> = Vec::new();
    if lang.is_some() {
        candidates.push(lang);
    }
    candidates.push(None);

    for cand in candidates {
        let Some(res) = state.resolve_path(virtual_path, cand) else {
            // Unknown slug, or no such edition for `cand` → try the next one.
            continue;
        };
        let joined = res.edition.source.join(res.rest);
        // Canonicalize fully — this is what makes `..` and symlinks safe. A
        // syntactic `starts_with` check is NOT sufficient because Path::join
        // doesn't normalise components.
        match joined.canonicalize() {
            Ok(p) => {
                if !p.starts_with(&res.edition.source) {
                    return Err(());
                }
                return Ok(Some((p, res.edition.lang.clone())));
            }
            // Missing in this edition → fall through to the next candidate.
            Err(_) => continue,
        }
    }
    Ok(None)
}

async fn api_file(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let (full_path, served_lang) =
        match resolve_with_fallback(&state, &query.path, query.lang.as_deref()) {
            Ok(Some(x)) => x,
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "File not found"})),
                )
                    .into_response();
            }
            Err(()) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({"error": "Access denied"})),
                )
                    .into_response();
            }
        };

    let file_type = FileType::from_path(&query.path);

    // Binary files: return metadata only — frontend will use /api/raw.
    if matches!(file_type, FileType::Image | FileType::Pdf) {
        return Json(FileContent {
            path: query.path,
            lang: served_lang,
            file_type,
            content: String::new(),
        })
        .into_response();
    }

    // Cache keys on the *served* edition lang, so en-fallback and a real zh
    // page never collide.
    let key = server::state::cache_key(&served_lang, &query.path);
    {
        let cache = state.rendered_cache.read().await;
        if let Some(content) = cache.get(&key) {
            return Json(FileContent {
                path: query.path,
                lang: served_lang,
                file_type,
                content: content.clone(),
            })
            .into_response();
        }
    }

    match tokio::fs::read_to_string(&full_path).await {
        Ok(source) => {
            let content = server::renderer::render_file(&source, &file_type);
            {
                let mut cache = state.rendered_cache.write().await;
                cache.insert(key, content.clone());
            }
            Json(FileContent {
                path: query.path,
                lang: served_lang,
                file_type,
                content,
            })
            .into_response()
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "File not found"})),
        )
            .into_response(),
    }
}

async fn api_raw(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let full_path = match resolve_with_fallback(&state, &query.path, query.lang.as_deref()) {
        Ok(Some((p, _served))) => p,
        Ok(None) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(()) => return (StatusCode::FORBIDDEN, "Access denied").into_response(),
    };

    let file = match tokio::fs::File::open(&full_path).await {
        Ok(file) => file,
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let mime_type = mime_guess::from_path(&full_path)
        .first_or_octet_stream()
        .to_string();

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(body)
        .unwrap()
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{build_globset, BookState, EditionState};
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(prefix: &str) -> Self {
            let mut p = std::env::temp_dir();
            let suffix = format!(
                "{prefix}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            p.push(suffix);
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mk_state(books: Vec<BookState>) -> AppState {
        let (tx, _) = broadcast::channel(8);
        AppState {
            tx,
            books,
            file_tree: RwLock::new(Vec::new()),
            rendered_cache: RwLock::new(HashMap::new()),
            progress: None,
        }
    }

    fn mk_mount(slug: &str, source: PathBuf) -> BookState {
        BookState {
            label: slug.to_string(),
            slug: slug.to_string(),
            description: None,
            default_lang: "default".to_string(),
            layout: None,
            manifest: false,
            editions: vec![EditionState {
                lang: "default".to_string(),
                label: "default".to_string(),
                source,
                include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
                exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
            }],
        }
    }

    #[test]
    fn resolve_splits_on_first_slash() {
        let tmp = TempDir::new("lv-resolve");
        let state = mk_state(vec![mk_mount("docs", tmp.path().to_path_buf())]);
        let r = state.resolve_path("docs/foo/bar.md", None).unwrap();
        assert_eq!(r.edition.source, tmp.path());
        assert_eq!(r.rest, "foo/bar.md");
    }

    #[test]
    fn resolve_mount_root_no_slash() {
        let tmp = TempDir::new("lv-resolve");
        let state = mk_state(vec![mk_mount("docs", tmp.path().to_path_buf())]);
        let r = state.resolve_path("docs", None).unwrap();
        assert_eq!(r.edition.source, tmp.path());
        assert_eq!(r.rest, "");
    }

    #[test]
    fn resolve_picks_edition_by_lang() {
        let tmp_en = TempDir::new("lv-en");
        let tmp_zh = TempDir::new("lv-zh");
        let mk_ed = |lang: &str, source: PathBuf| EditionState {
            lang: lang.to_string(),
            label: lang.to_string(),
            source,
            include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
            exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
        };
        let book = BookState {
            label: "Docs".to_string(),
            slug: "docs".to_string(),
            description: None,
            default_lang: "en".to_string(),
            layout: None,
            manifest: false,
            editions: vec![
                mk_ed("en", tmp_en.path().to_path_buf()),
                mk_ed("zh", tmp_zh.path().to_path_buf()),
            ],
        };
        let state = mk_state(vec![book]);

        // Explicit lang selects that edition.
        assert_eq!(
            state
                .resolve_path("docs/x.md", Some("zh"))
                .unwrap()
                .edition
                .source,
            tmp_zh.path()
        );
        // No lang falls back to the default edition.
        assert_eq!(
            state
                .resolve_path("docs/x.md", None)
                .unwrap()
                .edition
                .source,
            tmp_en.path()
        );
        // A lang the book doesn't offer resolves to None (→ 404 → frontend fallback).
        assert!(state.resolve_path("docs/x.md", Some("ja")).is_none());
    }

    #[test]
    fn resolve_falls_back_to_base_when_overlay_missing() {
        let tmp_en = TempDir::new("lv-fb-en");
        let tmp_zh = TempDir::new("lv-fb-zh");
        fs::write(tmp_en.path().join("a.md"), b"en").unwrap(); // only in base
        fs::write(tmp_zh.path().join("b.md"), b"zh").unwrap(); // only in overlay
        let mk_ed = |lang: &str, src: PathBuf| EditionState {
            lang: lang.to_string(),
            label: lang.to_string(),
            source: src,
            include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
            exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
        };
        let book = BookState {
            label: "Docs".to_string(),
            slug: "docs".to_string(),
            description: None,
            default_lang: "en".to_string(),
            layout: None,
            manifest: false,
            editions: vec![
                mk_ed("en", tmp_en.path().canonicalize().unwrap()),
                mk_ed("zh", tmp_zh.path().canonicalize().unwrap()),
            ],
        };
        let state = mk_state(vec![book]);

        // a.md is absent from the zh overlay → served from the en base.
        let (_p, served) = resolve_with_fallback(&state, "docs/a.md", Some("zh"))
            .unwrap()
            .unwrap();
        assert_eq!(served, "en");
        // b.md exists in the zh overlay → served from zh.
        let (_p, served) = resolve_with_fallback(&state, "docs/b.md", Some("zh"))
            .unwrap()
            .unwrap();
        assert_eq!(served, "zh");
    }

    #[test]
    fn resolve_returns_none_on_unknown_slug() {
        let tmp = TempDir::new("lv-resolve");
        let state = mk_state(vec![mk_mount("docs", tmp.path().to_path_buf())]);
        assert!(state.resolve_path("nope/x.md", None).is_none());
    }

    #[test]
    fn resolve_picks_right_mount_among_many() {
        let tmp_a = TempDir::new("lv-a");
        let tmp_b = TempDir::new("lv-b");
        let state = mk_state(vec![
            mk_mount("docs", tmp_a.path().to_path_buf()),
            mk_mount("tasks", tmp_b.path().to_path_buf()),
        ]);
        let r = state.resolve_path("tasks/x.md", None).unwrap();
        assert_eq!(r.edition.source, tmp_b.path());
    }

    #[test]
    fn resolve_safe_unknown_slug_is_not_found() {
        let tmp = TempDir::new("lv-safe");
        let state = mk_state(vec![mk_mount("docs", tmp.path().canonicalize().unwrap())]);
        // Ok(None) maps to 404 at the handler layer.
        assert!(matches!(
            resolve_with_fallback(&state, "bogus/x.md", None),
            Ok(None)
        ));
    }

    #[test]
    fn resolve_safe_missing_file_is_not_found() {
        let tmp = TempDir::new("lv-safe");
        let state = mk_state(vec![mk_mount("docs", tmp.path().canonicalize().unwrap())]);
        assert!(matches!(
            resolve_with_fallback(&state, "docs/missing.md", None),
            Ok(None)
        ));
    }

    #[test]
    fn resolve_safe_accepts_legit_file() {
        let tmp = TempDir::new("lv-safe");
        fs::write(tmp.path().join("README.md"), b"hi").unwrap();
        let state = mk_state(vec![mk_mount("docs", tmp.path().canonicalize().unwrap())]);
        let (out, served) = resolve_with_fallback(&state, "docs/README.md", None)
            .unwrap()
            .unwrap();
        assert!(out.ends_with("README.md"));
        assert_eq!(served, "default");
    }

    #[test]
    fn resolve_safe_rejects_dotdot_escape() {
        // Two adjacent temp dirs A and B; build mount over A and try to
        // reach a file in B via `..`. Must return Err (=> 403).
        let tmp_a = TempDir::new("lv-safe-a");
        let tmp_b = TempDir::new("lv-safe-b");
        fs::write(tmp_b.path().join("secret.md"), b"x").unwrap();

        let a_canon = tmp_a.path().canonicalize().unwrap();
        let state = mk_state(vec![mk_mount("docs", a_canon.clone())]);

        // Path that joins to A but `..`-s out to B once canonicalized.
        let b_name = tmp_b.path().file_name().unwrap().to_str().unwrap();
        let virtual_path = format!("docs/../{b_name}/secret.md");
        assert!(matches!(
            resolve_with_fallback(&state, &virtual_path, None),
            Err(())
        ));
    }

    #[test]
    fn resolve_safe_rejects_symlink_escape() {
        // Plant a symlink inside the mount that points to a file outside
        // the mount; reading via the symlink should be 403.
        let tmp_a = TempDir::new("lv-safe-sym-a");
        let tmp_b = TempDir::new("lv-safe-sym-b");
        let outside = tmp_b.path().join("outside.md");
        fs::write(&outside, b"leak").unwrap();
        let link = tmp_a.path().join("link.md");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let a_canon = tmp_a.path().canonicalize().unwrap();
        let state = mk_state(vec![mk_mount("docs", a_canon)]);
        assert!(matches!(
            resolve_with_fallback(&state, "docs/link.md", None),
            Err(())
        ));
    }
}
