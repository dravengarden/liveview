//! Live end-to-end test of the NATIVE path (FsBlobStore + a real HTTP Fetcher +
//! Engine) against the running liveview backend. Mirrors the offline guarantee:
//! resolve online → bytes land on disk by hash → resolve again with a DEAD
//! fetcher (simulating offline) still returns the cached bytes, while an uncached
//! resource errors. `#[ignore]`d so the default suite stays hermetic; run with:
//!   cargo test --test native_e2e -- --ignored --nocapture
//! (requires `liveview` serving on http://127.0.0.1:4160).

use async_trait::async_trait;
use lv_sync::native::FsBlobStore;
use lv_sync::{Engine, Fetcher, Manifest};

const BASE: &str = "http://127.0.0.1:4160";

/// Real network fetcher (test-only; the shell has its own).
struct HttpFetcher;
#[async_trait]
impl Fetcher for HttpFetcher {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        let full = format!("{BASE}{url}");
        let r = reqwest::get(&full).await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("{full} -> {}", r.status()));
        }
        Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }
}

/// A fetcher that always fails — stands in for "offline".
struct DeadFetcher;
#[async_trait]
impl Fetcher for DeadFetcher {
    async fn fetch(&self, _url: &str) -> Result<Vec<u8>, String> {
        Err("offline".into())
    }
}

#[tokio::test]
#[ignore = "needs the liveview backend on :4160"]
async fn native_resolve_caches_then_serves_offline() {
    let json = reqwest::get(format!("{BASE}/api/dag"))
        .await
        .expect("GET /api/dag")
        .text()
        .await
        .expect("dag body");
    let manifest = Manifest::from_json(&json).expect("parse manifest");
    println!("manifest: {} resources", manifest.resources.len());

    let audios: Vec<_> = manifest
        .resources
        .iter()
        .filter(|r| r.kind == "audio")
        .cloned()
        .collect();
    assert!(audios.len() >= 2, "need ≥2 audio resources to test");
    let a = &audios[0];
    let b = &audios[1];

    let mut dir = std::env::temp_dir();
    dir.push(format!("lvsync-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);

    // ONLINE: resolve A → bytes, cached to the FS store by hash.
    let online_len = {
        let store = FsBlobStore::new(&dir).unwrap();
        let engine = Engine::new(store, HttpFetcher).without_verify();
        let bytes = engine
            .resolve_path(&manifest, &a.path)
            .await
            .expect("online resolve A");
        assert!(!bytes.is_empty());
        println!("online A: {} bytes ({})", bytes.len(), a.path);
        bytes.len()
    };
    // The blob is on disk under its hash (with the `:` encoding applied).
    let on_disk = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(on_disk, 1, "exactly one blob cached");

    // OFFLINE: reopen the SAME dir with a dead fetcher.
    {
        let store = FsBlobStore::new(&dir).unwrap();
        let engine = Engine::new(store, DeadFetcher).without_verify();
        // A is cached → resolves from disk with no network, same bytes.
        let bytes = engine
            .resolve_path(&manifest, &a.path)
            .await
            .expect("offline resolve A (cached)");
        assert_eq!(bytes.len(), online_len, "offline bytes match online");
        println!("offline A: {} bytes (from disk, dead fetcher)", bytes.len());
        // B is uncached + fetcher dead → Offline error.
        let err = engine.resolve_path(&manifest, &b.path).await;
        assert!(err.is_err(), "uncached resolve must fail offline");
        println!("offline B (uncached): correctly errored {err:?}");
    }

    let _ = std::fs::remove_dir_all(&dir);
    println!("NATIVE E2E: PASS");
}
