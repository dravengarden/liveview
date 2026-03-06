mod cli;
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
use server::state::{AppState, SharedState};
use shared::{FileContent, FileType};
use std::collections::HashMap;
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

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    rt.block_on(async move {
        let root = cli.path.canonicalize().unwrap_or_else(|_| {
            std::env::current_dir().expect("Cannot determine current directory")
        });

        let include_set =
            build_globset(&cli.effective_includes()).expect("Invalid include patterns");
        let exclude_set =
            build_globset(&cli.effective_excludes()).expect("Invalid exclude patterns");

        let initial_tree = server::tree::build_file_tree(&root, &include_set, &exclude_set);

        let (tx, _rx) = broadcast::channel::<String>(64);

        let state: SharedState = Arc::new(AppState {
            tx,
            canonical_root: root.clone(),
            include_set,
            exclude_set,
            file_tree: RwLock::new(initial_tree),
            rendered_cache: RwLock::new(HashMap::new()),
        });

        server::watcher::start_watcher(state.clone(), cli.debounce_ms);

        tracing::info!("Watching: {}", root.display());

        let api_router = Router::new()
            .route("/api/tree", get(api_tree))
            .route("/api/file", get(api_file))
            .route("/api/raw", get(api_raw))
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
        let listener = if let Some(port) = cli.port {
            let addr = format!("{}:{}", cli.host, port);
            tokio::net::TcpListener::bind(&addr)
                .await
                .unwrap_or_else(|e| panic!("Failed to bind {}:{} - {}", cli.host, port, e))
        } else {
            let mut port = DEFAULT_PORT;
            loop {
                let addr = format!("{}:{}", cli.host, port);
                match tokio::net::TcpListener::bind(&addr).await {
                    Ok(listener) => break listener,
                    Err(_) => {
                        tracing::info!("Port {} in use, trying {}", port, port + 1);
                        port = port.checked_add(1).expect("No available ports found");
                    }
                }
            }
        };

        let local_addr = listener.local_addr().expect("Failed to get local address");
        let url = format!("http://{local_addr}");

        if cli.open {
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
    });
}

fn build_globset(patterns: &[String]) -> Result<globset::GlobSet, globset::Error> {
    use globset::{Glob, GlobSetBuilder};
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern)?);
    }
    builder.build()
}

async fn api_tree(State(state): State<SharedState>) -> impl IntoResponse {
    let tree = state.file_tree.read().await;
    axum::Json(tree.clone())
}

#[derive(serde::Deserialize)]
struct FileQuery {
    path: String,
}

async fn api_file(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let full_path = state.canonical_root.join(&query.path);

    if !full_path.starts_with(&state.canonical_root) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Access denied"}))).into_response();
    }

    let file_type = FileType::from_path(&query.path);

    // For binary files, return metadata only - frontend will use /api/raw
    if matches!(file_type, FileType::Image | FileType::Pdf) {
        return Json(FileContent {
            path: query.path,
            file_type,
            content: String::new(),
        }).into_response();
    }

    // Check cache first
    {
        let cache = state.rendered_cache.read().await;
        if let Some(content) = cache.get(&query.path) {
            return Json(FileContent {
                path: query.path,
                file_type,
                content: content.clone(),
            }).into_response();
        }
    }

    // Read and process file
    match tokio::fs::read_to_string(&full_path).await {
        Ok(source) => {
            let content = server::renderer::render_file(&source, &file_type);
            {
                let mut cache = state.rendered_cache.write().await;
                cache.insert(query.path.clone(), content.clone());
            }
            Json(FileContent {
                path: query.path,
                file_type,
                content,
            }).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "File not found"}))).into_response(),
    }
}

/// Serve raw file content (for images, PDFs, etc.)
async fn api_raw(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    let full_path = state.canonical_root.join(&query.path);

    if !full_path.starts_with(&state.canonical_root) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

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
