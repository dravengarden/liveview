//! HTTP-layer regression tests: compression scope, preview path containment,
//! store-error propagation, DAG query encoding, and APM credential routing.

use super::*;
use crate::server::catalog::{BookMeta, EditionMeta, RenditionMeta};
use crate::store::content::{BlobStore, ContentStore};
use crate::store::fs::FsStore;
use crate::store::model::{
    AssetRecord, AudioTaskRollup, BookRecord, DagArtwork, DagChapter, EditionRecord,
    ManifestChapter, RenditionRecord,
};
use tower::ServiceExt;

fn state_over(
    store: Arc<dyn ContentStore>,
    obj: Arc<dyn BlobStore>,
    catalog: Catalog,
    apm: Option<ApmSink>,
) -> SharedState {
    let (tx, _rx) = broadcast::channel::<String>(8);
    Arc::new(AppState {
        tx,
        store,
        obj,
        catalog: RwLock::new(catalog),
        dag_cache: Default::default(),
        sizes_cache: Default::default(),
        tts_cmd: None,
        tts_voice: None,
        book_end_phrases: HashMap::new(),
        book_end_cue: Default::default(),
        audio_synth_locks: Default::default(),
        apm,
    })
}

fn app(state: SharedState) -> Router {
    build_app_with_policy(state, HttpPolicy::parse(None, None).unwrap())
}

async fn get(app: &Router, uri: &str, headers: &[(HeaderName, &str)]) -> Response {
    let mut request = axum::http::Request::get(uri);
    for (name, value) in headers {
        request = request.header(name, *value);
    }
    app.clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn body_bytes(response: Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

// ── Compression scope ────────────────────────────────────────────────────────

#[tokio::test]
async fn blob_keeps_length_and_ranges_when_client_accepts_gzip() {
    let fs = Arc::new(FsStore::new(Vec::new()));
    let payload = vec![7u8; 4096];
    fs.put_if_absent("audiohash", payload.clone(), "audio/x-caf")
        .await
        .unwrap();
    let state = state_over(fs.clone(), fs, Catalog::default(), None);
    let app = app(state);

    let full = get(
        &app,
        "/api/blob/audiohash",
        &[(header::ACCEPT_ENCODING, "gzip")],
    )
    .await;
    assert_eq!(full.status(), StatusCode::OK);
    assert!(full.headers().get(header::CONTENT_ENCODING).is_none());
    assert_eq!(full.headers()[header::CONTENT_LENGTH], "4096");
    assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(
        full.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(body_bytes(full).await, payload);

    let partial = get(
        &app,
        "/api/blob/audiohash",
        &[
            (header::ACCEPT_ENCODING, "gzip"),
            (header::RANGE, "bytes=10-19"),
        ],
    )
    .await;
    assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
    assert!(partial.headers().get(header::CONTENT_ENCODING).is_none());
    assert_eq!(partial.headers()[header::CONTENT_LENGTH], "10");
    assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 10-19/4096");
    assert_eq!(body_bytes(partial).await, vec![7u8; 10]);
}

#[test]
fn only_textual_api_bodies_are_compressible() {
    let with_type = |content_type: &str| {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
        headers
    };
    let ok = |status, headers: &HeaderMap| {
        api_response_is_compressible(
            status,
            axum::http::Version::HTTP_11,
            headers,
            &axum::http::Extensions::new(),
        )
    };
    assert!(ok(StatusCode::OK, &with_type("application/json")));
    assert!(ok(StatusCode::OK, &with_type("text/html; charset=utf-8")));
    for media in [
        "audio/x-caf",
        "audio/mpeg",
        "application/octet-stream",
        "image/png",
        "video/mp4",
        "application/pdf",
    ] {
        assert!(!ok(StatusCode::OK, &with_type(media)), "{media}");
    }
    assert!(!ok(StatusCode::OK, &HeaderMap::new()));
    assert!(!ok(
        StatusCode::PARTIAL_CONTENT,
        &with_type("application/json")
    ));
}

// ── Preview path containment ─────────────────────────────────────────────────

#[test]
fn request_paths_reject_traversal_and_absolute_components() {
    assert_eq!(
        split_request_path("book/part/01.md"),
        Some(("book", "part/01.md"))
    );
    for bad in [
        "book",
        "book/",
        "/book/a.md",
        "book//etc/passwd",
        "book/../secret.md",
        "book/part/../../secret.md",
        "book/./a.md",
        "book/a.md/..",
        "book/a\0.md",
    ] {
        assert_eq!(split_request_path(bad), None, "{bad:?}");
    }
}

#[tokio::test]
async fn preview_cannot_read_files_outside_the_book() {
    let root = std::env::temp_dir().join(format!(
        "liveview-traversal-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let book_dir = root.join("book");
    std::fs::create_dir_all(&book_dir).unwrap();
    std::fs::write(book_dir.join("inside.md"), "# Inside\n").unwrap();
    std::fs::write(root.join("secret.md"), "# Secret\n").unwrap();

    let resolved = implicit_resolved(&book_dir).unwrap();
    let slug = resolved.books[0].slug.clone();
    let fs = Arc::new(FsStore::new(resolved.books));
    let catalog = Catalog::load(fs.as_ref()).await.unwrap();
    let app = app(state_over(fs.clone(), fs, catalog, None));

    let inside = get(&app, &format!("/api/file?path={slug}/inside.md"), &[]).await;
    assert_eq!(inside.status(), StatusCode::OK);

    let secret_abs = root.join("secret.md");
    for path in [
        format!("{slug}/../secret.md"),
        format!("{slug}/{}", secret_abs.display()),
    ] {
        let uri = format!("/api/file?path={}", encode_query_value(&path));
        let response = get(&app, &uri, &[]).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        let raw = format!("/api/raw?path={}", encode_query_value(&path));
        assert_eq!(get(&app, &raw, &[]).await.status(), StatusCode::NOT_FOUND);
    }
    std::fs::remove_dir_all(&root).unwrap();
}

// ── Store errors are 5xx, never a cacheable degraded answer ─────────────────

struct FailingStore;

fn down<T>() -> Result<T, String> {
    Err("database unavailable".into())
}

#[async_trait::async_trait]
impl ContentStore for FailingStore {
    async fn list_books(&self) -> Result<Vec<BookRecord>, String> {
        down()
    }
    async fn list_renditions(&self, _: &str) -> Result<Vec<RenditionRecord>, String> {
        down()
    }
    async fn list_editions(&self, _: &str, _: &str) -> Result<Vec<EditionRecord>, String> {
        down()
    }
    async fn get_chapter(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Option<ChapterRecord>, String> {
        down()
    }
    async fn get_asset(&self, _: &str) -> Result<Option<AssetRecord>, String> {
        down()
    }
    async fn upsert_asset(&self, _: &str, _: &str, _: i64) -> Result<(), String> {
        down()
    }
    async fn load_narration(&self, _: &[String]) -> Result<HashMap<String, String>, String> {
        down()
    }
    async fn get_site_tree(&self, _: &str) -> Result<Option<String>, String> {
        down()
    }
    async fn set_chapter_audio(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<(), String> {
        down()
    }
    async fn progress_for_book(&self, _: &str) -> Result<Vec<ProgressEntry>, String> {
        down()
    }
    async fn progress_recent_per_rendition(&self) -> Result<Vec<ProgressEntry>, String> {
        down()
    }
    async fn progress_upsert(&self, _: &str, _: f64, _: Option<i64>) -> Result<bool, String> {
        down()
    }
    async fn settings_all(&self) -> Result<Vec<(String, String)>, String> {
        down()
    }
    async fn settings_set(&self, _: &str, _: &str, _: Option<i64>) -> Result<bool, String> {
        down()
    }
    async fn audio_task_rollup(&self) -> Result<Vec<AudioTaskRollup>, String> {
        down()
    }
    async fn manifest_books(&self) -> Result<(Option<String>, Vec<(String, String)>), String> {
        down()
    }
    async fn manifest_chapters(&self, _: &str) -> Result<Vec<ManifestChapter>, String> {
        down()
    }
    async fn dag_chapters(&self) -> Result<Vec<DagChapter>, String> {
        down()
    }
    async fn dag_artwork(&self) -> Result<Vec<DagArtwork>, String> {
        down()
    }
}

fn one_book_catalog() -> Catalog {
    let rendition = |kind: RenditionKind| RenditionMeta {
        kind,
        label: kind.as_str().to_string(),
        default_lang: "en".into(),
        voice: None,
        manifest: false,
        editions: vec![EditionMeta {
            lang: "en".into(),
            label: "English".into(),
        }],
    };
    Catalog {
        books: vec![BookMeta {
            slug: "book".into(),
            label: "Book".into(),
            description: None,
            tags: Vec::new(),
            collection: None,
            author: None,
            cover_hash: None,
            backdrop_hash: None,
            card_backdrop_hash: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![
                rendition(RenditionKind::Text),
                rendition(RenditionKind::Audio),
            ],
            created_at: 0,
            updated_at: 0,
        }],
    }
}

#[tokio::test]
async fn store_errors_surface_as_service_unavailable() {
    let blobs = Arc::new(FsStore::new(Vec::new()));
    blobs
        .put_if_absent("somehash", vec![1u8; 64], "audio/x-caf")
        .await
        .unwrap();
    let state = state_over(Arc::new(FailingStore), blobs, one_book_catalog(), None);
    let app = app(state);
    for uri in [
        "/api/tree",
        "/api/tree?rendition=audio",
        "/api/settings",
        "/api/blob/somehash",
        "/api/spoken?path=book/01.md",
        "/api/units?path=book/01.md",
        "/api/raw?path=book/cover.png",
        "/api/audio?path=book/01.spoken.md&rendition=audio",
        "/api/marks?path=book/01.spoken.md&rendition=audio",
    ] {
        let response = get(&app, uri, &[]).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "{uri} must not degrade to a success or 404"
        );
        let cache = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(!cache.contains("immutable"), "{uri}: {cache}");
    }
}

// ── DAG query encoding ───────────────────────────────────────────────────────

#[test]
fn dag_query_values_round_trip_through_the_query_extractor() {
    let path = "book/Q&A + notes #1 100%/章节 a=b.md";
    let q = format!(
        "path={}&lang={}&rendition={}",
        encode_query_value(path),
        encode_query_value("zh-Hans"),
        encode_query_value("text")
    );
    let uri: axum::http::Uri = format!("/api/file?{q}").parse().unwrap();
    let Query(parsed) = Query::<FileQuery>::try_from_uri(&uri).unwrap();
    assert_eq!(parsed.path, path);
    assert_eq!(parsed.lang.as_deref(), Some("zh-Hans"));
    assert_eq!(parsed.rendition.as_deref(), Some("text"));
}

#[test]
fn ordinary_dag_urls_are_unchanged_by_encoding() {
    assert_eq!(
        encode_query_value("field-guide/part_1/01.intro~v2.md"),
        "field-guide/part_1/01.intro~v2.md"
    );
    assert_eq!(encode_query_value("a+b&c#d%e f"), "a%2Bb%26c%23d%25e%20f");
    let resource = artwork_resource("a&b", "cover", "h", 1);
    assert_eq!(resource["url"], "/api/cover?book=a%26b");
}

// ── APM credential routing ───────────────────────────────────────────────────

fn one_event() -> Vec<serde_json::Map<String, serde_json::Value>> {
    let mut event = serde_json::Map::new();
    event.insert("event_type".into(), serde_json::json!("x"));
    vec![event]
}

#[test]
fn apm_token_is_accepted_from_dedicated_header_or_bearer() {
    let mut dedicated = HeaderMap::new();
    dedicated.insert(APM_TOKEN_HEADER, "apm".parse().unwrap());
    dedicated.insert(header::AUTHORIZATION, "Bearer proxy".parse().unwrap());
    assert!(apm_token_matches(&dedicated, "apm"));

    let mut bearer = HeaderMap::new();
    bearer.insert(header::AUTHORIZATION, "Bearer apm".parse().unwrap());
    assert!(apm_token_matches(&bearer, "apm"));

    let mut wrong = HeaderMap::new();
    wrong.insert(APM_TOKEN_HEADER, "nope".parse().unwrap());
    wrong.insert(header::AUTHORIZATION, "Bearer proxy".parse().unwrap());
    assert!(!apm_token_matches(&wrong, "apm"));
    assert!(!apm_token_matches(&HeaderMap::new(), "apm"));
}

/// Behind the access-token proxy, `Authorization` carries the proxy token; the
/// APM token rides in its own header and both checks pass. The forward target
/// is unreachable, so an accepted batch yields 502 (auth passed), not 401.
#[tokio::test]
async fn apm_ingest_works_behind_the_access_token_proxy() {
    let fs = Arc::new(FsStore::new(Vec::new()));
    let sink = ApmSink {
        client: reqwest::Client::builder().build().unwrap(),
        vl_url: "http://127.0.0.1:1/unused".into(),
        token: Some("apm".into()),
    };
    let state = state_over(fs.clone(), fs, Catalog::default(), Some(sink));
    let policy = HttpPolicy::parse(None, Some("proxy".into())).unwrap();
    let app = build_app_with_policy(state, policy);
    let ingest = |apm_token: Option<&'static str>| {
        let mut request = axum::http::Request::post("/api/ingest")
            .header(header::AUTHORIZATION, "Bearer proxy")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = apm_token {
            request = request.header(APM_TOKEN_HEADER, token);
        }
        request
            .body(Body::from(serde_json::to_vec(&one_event()).unwrap()))
            .unwrap()
    };
    let rejected = app.clone().oneshot(ingest(None)).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    let accepted = app.oneshot(ingest(Some("apm"))).await.unwrap();
    assert_eq!(accepted.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn cors_preflight_allows_apm_header_and_is_cacheable() {
    let fs = Arc::new(FsStore::new(Vec::new()));
    let app = app(state_over(fs.clone(), fs, Catalog::default(), None));
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/ingest")
                .header(header::ORIGIN, "lvsync://localhost")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, APM_TOKEN_HEADER)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let allowed = response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    assert!(allowed.contains(APM_TOKEN_HEADER), "{allowed}");
    assert_eq!(response.headers()[header::ACCESS_CONTROL_MAX_AGE], "3600");
}
