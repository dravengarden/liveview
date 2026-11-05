//! The reader's HTTP surface: the router, request policy, embedded SPA and
//! OTA bundle delivery, and every `/api` handler (one module per area).

pub(crate) mod apm;
pub(crate) mod audio;
pub(crate) mod chapter;
pub(crate) mod contents;
pub(crate) mod covers;
pub(crate) mod library_api;
pub(crate) mod manifest;
#[cfg(test)]
mod policy_tests;
pub(crate) mod reading;
pub(crate) mod speech_api;
#[cfg(test)]
mod tests;

pub(crate) use apm::*;
pub(crate) use chapter::*;
pub(crate) use covers::*;
pub(crate) use library_api::*;
pub(crate) use manifest::*;
pub(crate) use reading::*;

use crate::config::RenditionKind;
use crate::server::bytes::{ranged_bytes_response, stored_blob_response};
use crate::server::state::{AppState, CachedJson, SharedState};
use crate::shared::{FileContent, FileType, WsMessage};
use crate::store::model::{AudioBake, ChapterRecord, ProgressEntry};
use crate::{artwork, library, server, speech};
use audio::{api_audio, api_marks};
use axum::{
    Extension, Router,
    body::Body,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use std::collections::HashMap;
use std::path::Path;

#[cfg(feature = "embedded")]
pub(crate) mod embedded_assets {
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

    /// `GET /app-dist/manifest.json` — the OTA bundle's `version` (the content-hashed
    /// entry name, so it changes when the web app changes) + the full file list. The
    /// plugin compares `version` to its stored copy and downloads each file when it
    /// differs.
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
pub(crate) async fn version() -> Response {
    match index_html_source().as_deref().and_then(entry_bundle) {
        Some(v) => Json(serde_json::json!({ "version": v })).into_response(),
        None => (StatusCode::NOT_FOUND, "UI not built").into_response(),
    }
}

/// The current embedded app-bundle version, for the WS `AppVersion` push. `None`
/// in non-embedded dev builds (no compiled-in bundle → nothing to OTA).
#[cfg(feature = "embedded")]
pub(crate) fn app_version() -> Option<String> {
    Some(embedded_assets::app_bundle_version())
}
#[cfg(not(feature = "embedded"))]
pub(crate) fn app_version() -> Option<String> {
    None
}

/// Pull Vite's content-hashed entry-bundle name out of index.html. New native
/// OTA builds are flat (`index-D4f8aB2c.js`) so pre-0.1.21 hosts never receive
/// a URL-encoded slash; the PWA keeps the legacy `assets/index-...js` form.
pub(crate) fn entry_bundle(html: &str) -> Option<String> {
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
pub(crate) fn index_html_source() -> Option<String> {
    embedded_assets::index_html().map(str::to_owned)
}

#[cfg(not(feature = "embedded"))]
pub(crate) fn index_html_source() -> Option<String> {
    std::fs::read_to_string("web/dist/index.html").ok()
}

pub(crate) fn store_unavailable(operation: &'static str, error: String) -> Response {
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

#[derive(Clone, Debug, Default)]
pub(crate) struct HttpPolicy {
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

pub(crate) type CompressPredicateFn =
    fn(StatusCode, axum::http::Version, &HeaderMap, &axum::http::Extensions) -> bool;

/// Compress only textual API bodies (JSON, text, JS, SVG). Audio, blobs,
/// images, PDFs and every partial (206 / `Content-Range`) response pass through
/// untouched so they keep their `Content-Length` and `Accept-Ranges`.
pub(crate) fn api_response_is_compressible(
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

/// Build the reader's axum app (API routes + SPA assets) over any backend.
/// Shared by the deployed server (`run`) and the filesystem preview
/// (`run_preview`): one router, two content backends.
pub(crate) fn build_app(state: SharedState) -> Result<Router, String> {
    Ok(build_app_with_policy(state, HttpPolicy::from_env()?))
}

pub(crate) fn build_app_with_policy(state: SharedState, policy: HttpPolicy) -> Router {
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
        .route("/api/contents/{slug}", get(contents::api_contents))
        .route("/api/file", get(api_file))
        .route("/api/raw", get(api_raw))
        .route("/api/spoken", get(api_spoken))
        .route("/api/units", get(api_units))
        .route("/api/audio", get(api_audio))
        .route("/api/marks", get(api_marks))
        .route(
            "/api/speech/{slug}",
            get(speech_api::api_speech_book).put(speech_api::api_set_speech),
        )
        .route("/api/speech", post(speech_api::api_request_speech))
        .route(
            "/api/speech-defaults",
            get(speech_api::api_speech_defaults).put(speech_api::api_set_speech_defaults),
        )
        .route("/api/progress", get(api_progress_get).put(api_progress_put))
        .route("/api/progress/recent", get(api_progress_recent))
        .route("/api/settings", get(api_settings_get).put(api_settings_put))
        // Audio-generation status (per-book + global) for the Sync sheet.
        .route("/api/tasks", get(api_tasks))
        .route(
            "/api/speech-preparation",
            get(speech_api::api_preparation).put(speech_api::api_set_preparation),
        )
        // Content-addressed immutable blob (audio / marks / images) for the SW's
        // offline cache (Lane B), + the Merkle manifest the SW diffs.
        .route("/api/blob/{hash}", get(api_blob))
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
                    let presented = request.headers().get(header::AUTHORIZATION);
                    if presented.is_some_and(|got| secret_eq(got.as_bytes(), expected.as_bytes())) {
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
pub(crate) async fn serve_app(app: Router, host: String, port: Option<u16>, should_open: bool) {
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
