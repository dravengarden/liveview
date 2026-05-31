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

    let initial_tree =
        server::tree::build_virtual_tree(&resolved.books, config::RenditionKind::Text);

    let (tx, _rx) = broadcast::channel::<String>(64);

    let state_dir = resolve_state_dir(&cli);
    let progress = open_progress_store(state_dir.as_deref()).await;
    // Derived audiobook cache lives under the writable state dir, never in the
    // (possibly read-only) source tree. `None` → fall back to beside-the-script.
    let audio_cache_dir = state_dir.as_ref().map(|d| d.join("audio"));

    let state: SharedState = Arc::new(AppState {
        tx,
        books: resolved.books,
        file_tree: RwLock::new(initial_tree),
        rendered_cache: RwLock::new(HashMap::new()),
        progress,
        tts_cmd: cli
            .edge_tts_cmd
            .clone()
            .unwrap_or_else(|| "edge-tts".to_owned()),
        tts_voice: cli
            .tts_voice
            .clone()
            .unwrap_or_else(|| "zh-CN-XiaoxiaoNeural".to_owned()),
        audio_cache_dir,
    });

    server::watcher::start_watcher(state.clone(), resolved.debounce_ms);

    for b in &state.books {
        for r in &b.renditions {
            for e in &r.editions {
                tracing::info!(
                    "book /{:<16} [{:<5}/{:<6}]  =>  {}",
                    b.slug,
                    r.kind.as_str(),
                    e.lang,
                    e.source.display()
                );
            }
        }
    }

    let api_router = Router::new()
        .route("/api/books", get(api_books))
        .route("/api/cover", get(api_cover))
        .route("/api/artwork", get(api_artwork))
        .route("/api/tree", get(api_tree))
        .route("/api/file", get(api_file))
        .route("/api/raw", get(api_raw))
        .route("/api/spoken", get(api_spoken))
        .route("/api/audio", get(api_audio))
        .route("/api/marks", get(api_marks))
        .route("/api/progress", get(api_progress_get).put(api_progress_put))
        .route("/api/progress/recent", get(api_progress_recent))
        .route("/api/settings", get(api_settings_get).put(api_settings_put))
        .route("/version.json", get(api_version))
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

#[derive(serde::Deserialize)]
struct TreeQuery {
    /// Reading mode whose spine to return. Omitted/unknown ⇒ `text`.
    rendition: Option<String>,
}

/// The sidebar forest for a rendition. The default (text) tree is served from
/// the cached `file_tree`; other renditions are built on demand (books lacking
/// that rendition are omitted).
async fn api_tree(
    State(state): State<SharedState>,
    Query(q): Query<TreeQuery>,
) -> impl IntoResponse {
    use crate::config::RenditionKind;
    let kind = q
        .rendition
        .as_deref()
        .and_then(RenditionKind::parse)
        .unwrap_or(RenditionKind::Text);
    if kind == RenditionKind::Text {
        let tree = state.file_tree.read().await;
        return axum::Json(tree.clone());
    }
    let tree = server::tree::build_virtual_tree(&state.books, kind);
    axum::Json(tree)
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

#[derive(serde::Deserialize)]
struct SettingPut {
    key: String,
    value: String,
}

/// Player settings (playback rate, sleep-timer, …) for cross-device sync.
/// Returns `{}` when settings are disabled (no state dir).
async fn api_settings_get(State(state): State<SharedState>) -> impl IntoResponse {
    let Some(store) = &state.progress else {
        return Json(HashMap::<String, String>::new()).into_response();
    };
    match store.settings_all().await {
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

/// Save one player setting. No-op 204 when settings are disabled.
async fn api_settings_put(
    State(state): State<SharedState>,
    Json(body): Json<SettingPut>,
) -> impl IntoResponse {
    let Some(store) = &state.progress else {
        return StatusCode::NO_CONTENT;
    };
    match store.settings_set(&body.key, &body.value).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::warn!(error = %e, "settings write failed");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// Resolve the writable state dir: `--state-dir`, else `$STATE_DIRECTORY` from
/// systemd (a colon-separated list, first entry wins). `None` when neither is
/// set. Backs both the reading-progress db and the audiobook cache.
fn resolve_state_dir(cli: &Cli) -> Option<PathBuf> {
    cli.state_dir.clone().or_else(|| {
        std::env::var_os("STATE_DIRECTORY").and_then(|v| {
            std::env::split_paths(&v)
                .next()
                .filter(|p| !p.as_os_str().is_empty())
        })
    })
}

/// Open the reading-progress db under `state_dir`. `None` (no dir configured, or
/// open failed) disables reading-progress.
async fn open_progress_store(state_dir: Option<&Path>) -> Option<ProgressStore> {
    let dir = state_dir?;
    if let Err(e) = std::fs::create_dir_all(dir) {
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
}

/// The deployed build id the atlantis portal polls to raise an update banner
/// over a kept-alive iframe running a stale bundle (atlantis README → "Update
/// notifications"). The flake injects the app's commit SHA at build time; a
/// plain `cargo build` falls back to the crate version.
async fn api_version() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "version": option_env!("ATLANTIS_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
    }))
}

/// Lightweight list of books for the landing page ("bookshelf"): the curated
/// label, its slug (entry path), an optional blurb, and the available
/// language editions for the in-book language switcher.
async fn api_books(State(state): State<SharedState>) -> impl IntoResponse {
    let lang_infos = |r: &crate::config::RenditionState| -> Vec<LangInfo> {
        r.editions
            .iter()
            .map(|e| LangInfo {
                lang: e.lang.clone(),
                label: e.label.clone(),
            })
            .collect()
    };
    let books: Vec<BookInfo> = state
        .books
        .iter()
        .map(|b| {
            let default = b.default_rendition();
            BookInfo {
                label: b.label.clone(),
                slug: b.slug.clone(),
                description: b.description.clone(),
                cover: b.cover.is_some(),
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
            }
        })
        .collect();
    axum::Json(books)
}

#[derive(serde::Deserialize)]
struct CoverQuery {
    book: String,
}

/// Serve a book's cover image (resolved at config time to an abs path under the
/// book dir). 404 when the book is unknown or has no cover. Streams the file
/// with a `Content-Type` guessed from its extension — same pattern as /api/raw.
async fn api_cover(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let Some(cover) = state.book(&q.book).and_then(|b| b.cover.clone()) else {
        return (StatusCode::NOT_FOUND, "no cover").into_response();
    };
    let file = match tokio::fs::File::open(&cover).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "no cover").into_response(),
    };
    let mime_type = mime_guess::from_path(&cover)
        .first_or_octet_stream()
        .to_string();
    let body = Body::from_stream(ReaderStream::new(file));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(body)
        .unwrap()
        .into_response()
}

/// Media Session artwork for a book — the lock-screen / Control Center "Now
/// Playing" tile on iOS/iPadOS/macOS. Unlike /api/cover (which 404s when a book
/// has no cover image), this NEVER 404s for a known book: it serves the real
/// cover when one exists, otherwise a deterministic gradient PNG keyed off the
/// slug (the same hue the bookshelf uses for its CSS fallback). A real image URL
/// is required because iOS Safari won't reliably render data:/blob: artwork on
/// the lock screen, so a blank tile is the only alternative.
async fn api_artwork(
    State(state): State<SharedState>,
    Query(q): Query<CoverQuery>,
) -> impl IntoResponse {
    let Some(book) = state.book(&q.book) else {
        return (StatusCode::NOT_FOUND, "no such book").into_response();
    };
    if let Some(cover) = book.cover.clone() {
        if let Ok(file) = tokio::fs::File::open(&cover).await {
            let mime_type = mime_guess::from_path(&cover)
                .first_or_octet_stream()
                .to_string();
            let body = Body::from_stream(ReaderStream::new(file));
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime_type)
                .header(header::CACHE_CONTROL, "public, max-age=3600")
                .body(body)
                .unwrap()
                .into_response();
        }
    }
    // No (readable) cover: synthesize the slug's gradient as a PNG.
    let png = gradient_png(&q.book);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        // Deterministic per slug and never changes — cache hard.
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
}

impl FileQuery {
    /// The rendition kind for this request, defaulting per the book's own
    /// default. Resolved against the book named by the path's slug; an unknown
    /// book or unknown token falls back to the book default (or `Text`).
    fn rendition_kind(&self, state: &AppState) -> crate::config::RenditionKind {
        use crate::config::RenditionKind;
        if let Some(tok) = self.rendition.as_deref() {
            if let Some(k) = RenditionKind::parse(tok) {
                return k;
            }
        }
        let slug = self.path.split('/').next().unwrap_or("");
        state
            .book(slug)
            .map_or(RenditionKind::Text, |b| b.default_rendition)
    }
}

/// Resolve a virtual-path request (plus optional `lang`) to an on-disk path
/// using **overlay → base** fallback: try the requested `lang` edition first,
/// then the book's default (base) edition. Returns the canonical path plus the
/// language actually served. `Ok(None)` is "not found in any edition" (404);
/// `Err(())` is "outside an edition source" (403, traversal/symlink escape).
fn resolve_with_fallback(
    state: &AppState,
    virtual_path: &str,
    rendition: crate::config::RenditionKind,
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
        let Some(res) = state.resolve_path(virtual_path, rendition, cand) else {
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
    let rendition = query.rendition_kind(&state);
    let (full_path, served_lang) =
        match resolve_with_fallback(&state, &query.path, rendition, query.lang.as_deref()) {
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

/// Resolve a chapter's **narration source**: prefer the LLM-distilled
/// `<id>.spoken.md` track (an audiobook is a rewrite for the ear, not a strip);
/// fall back to the raw `<id>.md`, which is then mechanically stripped at
/// runtime. Both go through overlay → base resolution. Returns
/// `(path, served_lang)`; `Ok(None)` = neither exists.
fn resolve_narration(
    state: &AppState,
    virtual_path: &str,
    rendition: crate::config::RenditionKind,
    lang: Option<&str>,
) -> Result<Option<(PathBuf, String)>, ()> {
    use crate::config::RenditionKind;
    // The audio rendition's chapters ARE `<aid>.spoken.md` scripts — resolve
    // the path as given, no `.md` fallback. Only the text rendition's read-along
    // tries the distilled `.spoken.md` overlay before the raw `.md`.
    if rendition == RenditionKind::Text {
        if let Some(stem) = virtual_path.strip_suffix(".md") {
            let spoken = format!("{stem}.spoken.md");
            if let Some(hit) = resolve_with_fallback(state, &spoken, rendition, lang)? {
                return Ok(Some(hit));
            }
        }
    }
    resolve_with_fallback(state, virtual_path, rendition, lang)
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
    let rendition = query.rendition_kind(&state);

    let (full_path, served_lang) =
        match resolve_narration(&state, &query.path, rendition, query.lang.as_deref()) {
            Ok(Some(x)) => x,
            Ok(None) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
            Err(()) => return (StatusCode::FORBIDDEN, "Access denied").into_response(),
        };

    match tokio::fs::read_to_string(&full_path).await {
        Ok(source) => Json(SpokenContent {
            lang: served_lang,
            sentences: server::spoken::spoken_sentences(&source),
        })
        .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

/// Gate + resolve + lazily synthesize a chapter's audio. Returns the cached
/// `(mp3, marks.json)` paths, or an error response (404 no-audio-rendition /
/// not-found, 403 traversal, 500 synth failure). Gated on the book having an
/// `audio` rendition; the mp3 + marks are cached under the writable state-dir
/// (`<state_dir>/audio/<slug>/<lang>/`), not in the read-only source tree.
async fn prepare_audio(
    state: &AppState,
    query: &FileQuery,
) -> Result<(PathBuf, PathBuf), (StatusCode, String)> {
    use crate::config::RenditionKind;
    let (slug, file) = query
        .path
        .split_once('/')
        .unwrap_or((query.path.as_str(), ""));
    let book = state
        .book(slug)
        .ok_or((StatusCode::NOT_FOUND, "unknown book".to_owned()))?;
    let audio = book.rendition(RenditionKind::Audio).ok_or((
        StatusCode::NOT_FOUND,
        "audio not available for this book".to_owned(),
    ))?;

    // The audio chapter's wire file is `<aid>.spoken.md`; the cache stem is
    // `<aid>` (strip the `.spoken.md` suffix so we write `<aid>.mp3`, not
    // `<aid>.spoken.mp3`).
    let stem = file
        .strip_suffix(".spoken.md")
        .or_else(|| Path::new(file).file_stem().and_then(|s| s.to_str()))
        .unwrap_or("");

    let (md_path, served_lang) = match resolve_narration(
        state,
        &query.path,
        RenditionKind::Audio,
        query.lang.as_deref(),
    ) {
        Ok(Some(x)) => x,
        Ok(None) => return Err((StatusCode::NOT_FOUND, "File not found".to_owned())),
        Err(()) => return Err((StatusCode::FORBIDDEN, "Access denied".to_owned())),
    };
    let edition = audio.edition(&served_lang).ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "served edition missing".to_owned(),
    ))?;
    let md_meta = tokio::fs::metadata(&md_path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("stat chapter: {e}")))?;
    let src_mtime = md_meta.modified().ok();
    let source = tokio::fs::read_to_string(&md_path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, format!("read chapter: {e}")))?;
    let sentences = server::spoken::spoken_sentences(&source);
    let voice = audio.voice.as_deref().unwrap_or(&state.tts_voice);

    // Write the derived mp3/marks under the writable state-dir cache
    // (`<root>/<slug>/<lang>/`), keeping the source tree read-only. Without a
    // state dir, fall back to beside the script (the edition source).
    let cache_dir = match &state.audio_cache_dir {
        Some(root) => root.join(slug).join(&served_lang),
        None => edition.source.clone(),
    };
    server::audio::ensure_audio(
        &cache_dir,
        stem,
        &sentences,
        voice,
        &state.tts_cmd,
        src_mtime,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
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

/// Chapter narration audio (lazy-synth-on-first-play, then cached). MP3 with a
/// `Content-Length` (so the player can show total duration) and HTTP Range
/// support (so seeking works). Files are small (a few MB) → read the whole
/// cached mp3 per request.
async fn api_audio(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let mp3 = match prepare_audio(&state, &query).await {
        Ok((mp3, _)) => mp3,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let Ok(data) = tokio::fs::read(&mp3).await else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "open audio").into_response();
    };
    let total = data.len() as u64;
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, total));

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, "audio/mpeg")
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

/// Per-sentence time marks for the chapter audio (drives read-along highlight).
async fn api_marks(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    match prepare_audio(&state, &query).await {
        Ok((_, marks)) => match tokio::fs::read(&marks).await {
            Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
            Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read marks").into_response(),
        },
        Err((code, msg)) => (code, msg).into_response(),
    }
}

async fn api_raw(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let rendition = query.rendition_kind(&state);
    let full_path =
        match resolve_with_fallback(&state, &query.path, rendition, query.lang.as_deref()) {
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
    use crate::config::{build_globset, BookState, EditionState, RenditionKind, RenditionState};
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
            tts_cmd: "edge-tts".to_string(),
            tts_voice: "zh-CN-XiaoxiaoNeural".to_string(),
            audio_cache_dir: None,
        }
    }

    /// A single-`text`-rendition book over `source`.
    fn mk_mount(slug: &str, source: PathBuf) -> BookState {
        BookState {
            label: slug.to_string(),
            slug: slug.to_string(),
            description: None,
            cover: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![RenditionState {
                kind: RenditionKind::Text,
                label: "text".to_string(),
                default_lang: "default".to_string(),
                voice: None,
                layout: None,
                manifest: false,
                editions: vec![EditionState {
                    lang: "default".to_string(),
                    label: "default".to_string(),
                    source,
                    include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
                    exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
                }],
            }],
        }
    }

    /// A book with a single `text` rendition wrapping the given editions;
    /// `default_lang` opens first.
    fn mk_book_text(slug: &str, default_lang: &str, editions: Vec<EditionState>) -> BookState {
        BookState {
            label: slug.to_string(),
            slug: slug.to_string(),
            description: None,
            cover: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![RenditionState {
                kind: RenditionKind::Text,
                label: "text".to_string(),
                default_lang: default_lang.to_string(),
                voice: None,
                layout: None,
                manifest: false,
                editions,
            }],
        }
    }

    #[test]
    fn resolve_splits_on_first_slash() {
        let tmp = TempDir::new("lv-resolve");
        let state = mk_state(vec![mk_mount("docs", tmp.path().to_path_buf())]);
        let r = state
            .resolve_path("docs/foo/bar.md", RenditionKind::Text, None)
            .unwrap();
        assert_eq!(r.edition.source, tmp.path());
        assert_eq!(r.rest, "foo/bar.md");
    }

    #[test]
    fn resolve_mount_root_no_slash() {
        let tmp = TempDir::new("lv-resolve");
        let state = mk_state(vec![mk_mount("docs", tmp.path().to_path_buf())]);
        let r = state
            .resolve_path("docs", RenditionKind::Text, None)
            .unwrap();
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
        let book = mk_book_text(
            "docs",
            "en",
            vec![
                mk_ed("en", tmp_en.path().to_path_buf()),
                mk_ed("zh", tmp_zh.path().to_path_buf()),
            ],
        );
        let state = mk_state(vec![book]);

        // Explicit lang selects that edition.
        assert_eq!(
            state
                .resolve_path("docs/x.md", RenditionKind::Text, Some("zh"))
                .unwrap()
                .edition
                .source,
            tmp_zh.path()
        );
        // No lang falls back to the default edition.
        assert_eq!(
            state
                .resolve_path("docs/x.md", RenditionKind::Text, None)
                .unwrap()
                .edition
                .source,
            tmp_en.path()
        );
        // A lang the book doesn't offer resolves to None (→ 404 → frontend fallback).
        assert!(state
            .resolve_path("docs/x.md", RenditionKind::Text, Some("ja"))
            .is_none());
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
        let book = mk_book_text(
            "docs",
            "en",
            vec![
                mk_ed("en", tmp_en.path().canonicalize().unwrap()),
                mk_ed("zh", tmp_zh.path().canonicalize().unwrap()),
            ],
        );
        let state = mk_state(vec![book]);

        // a.md is absent from the zh overlay → served from the en base.
        let (_p, served) =
            resolve_with_fallback(&state, "docs/a.md", RenditionKind::Text, Some("zh"))
                .unwrap()
                .unwrap();
        assert_eq!(served, "en");
        // b.md exists in the zh overlay → served from zh.
        let (_p, served) =
            resolve_with_fallback(&state, "docs/b.md", RenditionKind::Text, Some("zh"))
                .unwrap()
                .unwrap();
        assert_eq!(served, "zh");
    }

    #[test]
    fn resolve_returns_none_on_unknown_slug() {
        let tmp = TempDir::new("lv-resolve");
        let state = mk_state(vec![mk_mount("docs", tmp.path().to_path_buf())]);
        assert!(state
            .resolve_path("nope/x.md", RenditionKind::Text, None)
            .is_none());
    }

    #[test]
    fn resolve_picks_right_mount_among_many() {
        let tmp_a = TempDir::new("lv-a");
        let tmp_b = TempDir::new("lv-b");
        let state = mk_state(vec![
            mk_mount("docs", tmp_a.path().to_path_buf()),
            mk_mount("tasks", tmp_b.path().to_path_buf()),
        ]);
        let r = state
            .resolve_path("tasks/x.md", RenditionKind::Text, None)
            .unwrap();
        assert_eq!(r.edition.source, tmp_b.path());
    }

    #[test]
    fn resolve_safe_unknown_slug_is_not_found() {
        let tmp = TempDir::new("lv-safe");
        let state = mk_state(vec![mk_mount("docs", tmp.path().canonicalize().unwrap())]);
        // Ok(None) maps to 404 at the handler layer.
        assert!(matches!(
            resolve_with_fallback(&state, "bogus/x.md", RenditionKind::Text, None),
            Ok(None)
        ));
    }

    #[test]
    fn resolve_safe_missing_file_is_not_found() {
        let tmp = TempDir::new("lv-safe");
        let state = mk_state(vec![mk_mount("docs", tmp.path().canonicalize().unwrap())]);
        assert!(matches!(
            resolve_with_fallback(&state, "docs/missing.md", RenditionKind::Text, None),
            Ok(None)
        ));
    }

    #[test]
    fn resolve_safe_accepts_legit_file() {
        let tmp = TempDir::new("lv-safe");
        fs::write(tmp.path().join("README.md"), b"hi").unwrap();
        let state = mk_state(vec![mk_mount("docs", tmp.path().canonicalize().unwrap())]);
        let (out, served) =
            resolve_with_fallback(&state, "docs/README.md", RenditionKind::Text, None)
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
            resolve_with_fallback(&state, &virtual_path, RenditionKind::Text, None),
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
            resolve_with_fallback(&state, "docs/link.md", RenditionKind::Text, None),
            Err(())
        ));
    }
}
