use super::*;
use crate::server::catalog::Catalog;
use crate::server::state::ApmSink;
use crate::store::fs::FsStore;
use std::sync::Arc;
use tokio::sync::{RwLock, broadcast};
use tower::ServiceExt;

#[test]
fn entry_bundle_accepts_flat_native_and_nested_pwa_paths() {
    assert_eq!(
        entry_bundle(r#"<link href="./index-style.css"><script src="./index-flat.js"></script>"#)
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
fn derived_text_hashes_move_with_renderer_and_overlay() {
    let v1 = derived_text_hashes("abc", 1, None);
    assert_eq!(
        (v1.text.as_str(), v1.spoken.as_str(), v1.units.as_str()),
        ("abc", "abc:spoken", "abc:units")
    );
    let v2 = derived_text_hashes("abc", 2, None);
    assert_eq!(v2.text, "abc:r2");
    assert_eq!(v2.units, "abc:r2:units");
    assert_eq!(
        derived_text_hashes("abc", 2, Some("ov")).spoken,
        "abc:r2:spoken:ov"
    );
    assert_ne!(
        derived_text_hashes("abc", 2, Some("ov")).spoken,
        derived_text_hashes("abc", 2, Some("ov2")).spoken
    );
}

#[test]
fn secret_eq_requires_the_exact_secret() {
    assert!(secret_eq(b"Bearer s3cret", b"Bearer s3cret"));
    assert!(!secret_eq(b"Bearer s3creT", b"Bearer s3cret"));
    assert!(!secret_eq(b"Bearer s3cre", b"Bearer s3cret"));
    assert!(!secret_eq(b"", b"Bearer s3cret"));
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
        contents_durations: Default::default(),
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
