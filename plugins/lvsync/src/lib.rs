//! Native offline-first data layer (eager mode) for the iOS/Mac shell, as a
//! Tauri PLUGIN so the REMOTE web UI can reach it (app commands can't be invoked
//! from a remote origin in Tauri 2 — see capabilities/remote-sync.json).
//!
//! The remote UI calls `plugin:lvsync|resolve` etc. over IPC; each resolves
//! through the shared [`lv_sync::Engine`] — store-first against a filesystem
//! content-addressed cache, fetching + caching on a miss. Once read online, a
//! resource replays OFFLINE with zero network. Scope: NON-audio reader content
//! (text/units/spoken/marks/assets) + navigation metadata (tree/books/covers,
//! url-keyed). Audio stays in NativeAudioController (its own AVPlayer cache).
//!
//! Manifest lifecycle: seed from the on-disk `/api/dag` cache at startup
//! (offline-launch safe), refresh from the network in the background, never block
//! app start. resolve() never blocks on the refresh.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use lv_sync::sqlite::SqliteBlobStore;
use lv_sync::{BlobStore, Engine, Fetcher, Manifest, Resource};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::RwLock;

/// The remote liveview origin (same as the loader's REMOTE / tauri.conf devUrl).
const REMOTE: &str = "https://liveview.hawk.thundersparrow.top";

/// Debug airplane mode: when set, the fetcher fails immediately so the OFFLINE
/// cache path can be exercised in the simulator (which has no per-app network
/// switch). Toggled via the `lvsync://localhost/offline?on=1` scheme. Cache-first
/// resolves still serve hits; only network misses are forced to fail fast.
static FORCE_OFFLINE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// reqwest-backed network fetcher. Manifest URLs are origin-relative
/// (`/api/...`); absolute URLs (rare) pass through unchanged.
struct HttpFetcher {
    client: reqwest::Client,
}

#[async_trait]
impl Fetcher for HttpFetcher {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        if FORCE_OFFLINE.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("forced offline".into());
        }
        let full = if url.starts_with("http") {
            url.to_string()
        } else {
            format!("{REMOTE}{url}")
        };
        let r = self.client.get(&full).send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("{full} -> {}", r.status()));
        }
        Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }
}

/// Managed state: the engine (store + fetcher) + the current manifest (hot-swapped
/// on refresh) + a `url → Resource` index for O(1) command lookups.
pub struct LvState {
    engine: Engine<SqliteBlobStore, HttpFetcher>,
    manifest: RwLock<Manifest>,
    by_url: RwLock<HashMap<String, Resource>>,
    /// Where the cached `/api/dag` JSON lives (offline-launch seed).
    manifest_file: PathBuf,
}

impl LvState {
    /// Construct synchronously from the app data dir: open the blob dir, seed the
    /// manifest from the on-disk cache if present (so offline launch has a map).
    fn new(data_dir: &PathBuf) -> Result<Self, String> {
        // One SQLite DB (blobs + bytes + LRU index) instead of a file-per-hash dir
        // — O(1) stats + SQL eviction, and the same store compiles for every native
        // platform (iOS/macOS/Android). Cross-compiles to aarch64-apple-ios via
        // rusqlite's bundled SQLite (verified).
        let store = SqliteBlobStore::open(data_dir.join("lvsync.sqlite"))?;
        // Reclaim the RETIRED Swift content store: LvSyncController cached text under
        // `<Application Support>/lvcontent` (a sibling of this plugin's data dir).
        // The Swift content layer is gone (all content is Rust + SQLite now), so that
        // dir is dead weight — delete it once. Cheap no-op after the first launch.
        if let Some(parent) = data_dir.parent() {
            let _ = std::fs::remove_dir_all(parent.join("lvcontent"));
        }
        // verify OFF: a resource hash is a content key (rustfs / source blake3),
        // not blake3 of the SERVED bytes (rendered html) — trust the store key.
        // TIMEOUTS ARE CRITICAL: without them, an OFFLINE resolve miss makes reqwest
        // hang on the TCP connect to the (unreachable tailnet) REMOTE for a long OS
        // timeout — so a card tap's `await contentFetch` froze with no navigation
        // until the network came back ("needs network to jump"). A short connect
        // timeout fails fast → the engine returns Offline → lvsync:// 504 → the web
        // enters the book at a cached page or the offline placeholder immediately.
        // (Cached resources are store-first and never hit the network at all.)
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let engine = Engine::new(store, HttpFetcher { client }).without_verify();
        let manifest_file = data_dir.join("dag.json");
        let manifest = std::fs::read_to_string(&manifest_file)
            .ok()
            .and_then(|s| Manifest::from_json(&s).ok())
            .unwrap_or_default();
        let by_url = index(&manifest);
        Ok(Self {
            engine,
            manifest: RwLock::new(manifest),
            by_url: RwLock::new(by_url),
            manifest_file,
        })
    }

    /// Re-pull `/api/dag` from the network; on success swap the manifest + index
    /// and rewrite the on-disk cache. Best-effort: offline keeps the old map.
    async fn refresh(&self) -> Result<String, String> {
        // Timeout so a background refresh can't hang forever offline (mirrors the
        // engine fetcher's timeouts).
        let json = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
            .get(format!("{REMOTE}/api/dag"))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        let m = Manifest::from_json(&json)?;
        let root = m.root.clone();
        let idx = index(&m);
        let _ = std::fs::write(&self.manifest_file, &json);
        *self.by_url.write().await = idx;
        *self.manifest.write().await = m;
        Ok(root)
    }
}

fn index(m: &Manifest) -> HashMap<String, Resource> {
    m.resources.iter().map(|r| (norm(&r.url), r.clone())).collect()
}

/// Percent-decode a URL so the web's `encodeURIComponent`'d reads match the
/// manifest's raw URLs (e.g. `/api/file?path=slug%2Frel` ⇄ `…path=slug/rel`).
/// Manifest URLs carry no `%`, so decoding them is a no-op; `/api/blob/<hash>`
/// URLs have no `%` either, so they pass through unchanged.
fn norm(url: &str) -> String {
    let bytes = url.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Plugin commands (invoked from the remote UI as `plugin:lvsync|<name>`) ────

/// Resolve a content URL → its content as a UTF-8 STRING, offline-safe. A
/// MANIFEST resource resolves store-first by content hash; any OTHER content URL
/// (navigation metadata: /api/tree, /api/books, covers) goes through the url-keyed
/// network-first cache so it too works offline. Errors `"offline"` when uncached
/// + unreachable.
///
/// Returns a String, NOT raw `ipc::Response` bytes: the shell loads a REMOTE
/// origin, where Tauri's custom-protocol IPC is blocked (cross-origin/CSP) and
/// falls back to the postMessage channel — which is JSON/string only, so raw
/// bytes come back CORRUPTED (serialized as a number array). A String survives
/// BOTH IPC transports intact. Every URL routed here is text (JSON/HTML), so
/// UTF-8 is lossless; binary resources (audio/images) are NOT routed through this
/// (audio is the native AVPlayer; images load via <img src>).
#[tauri::command]
async fn resolve(state: State<'_, LvState>, url: String) -> Result<String, String> {
    let n = norm(&url);
    let res = state.by_url.read().await.get(&n).cloned();
    let bytes = match res {
        Some(r) => state.engine.resolve(&r).await,
        None => {
            let key = format!("{}{}", lv_sync::URL_KEY_PREFIX, lv_sync::hash_hex(n.as_bytes()));
            state.engine.fetch_keyed(&key, &n).await
        }
    }
    .map_err(|e| match e {
        lv_sync::ResolveError::Offline => "offline".to_string(),
        lv_sync::ResolveError::Integrity => "integrity".to_string(),
    })?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether a URL is a known MANIFEST resource (non-manifest content is still
/// resolvable via `resolve`'s url-keyed path; this just reports manifest membership).
#[tauri::command]
async fn knows(state: State<'_, LvState>, url: String) -> Result<bool, String> {
    Ok(state.by_url.read().await.contains_key(&norm(&url)))
}

/// The current manifest root + resource count (readiness probe).
#[tauri::command]
async fn status(state: State<'_, LvState>) -> Result<(String, usize), String> {
    let m = state.manifest.read().await;
    Ok((m.root.clone(), m.resources.len()))
}

/// Re-pull the manifest from the network. Returns the new root.
#[tauri::command]
async fn refresh(state: State<'_, LvState>) -> Result<String, String> {
    state.refresh().await
}

/// Byte-weighted offline fraction in [0,1] over the whole corpus.
#[tauri::command]
async fn offline_fraction(state: State<'_, LvState>) -> Result<f64, String> {
    let m = state.manifest.read().await;
    Ok(state.engine.offline_fraction(&m).await)
}

/// Eager-pull a single book's NON-audio resources into the store. Bytes cached.
#[tauri::command]
async fn sync_book(state: State<'_, LvState>, slug: String) -> Result<u64, String> {
    let to_fetch: Vec<Resource> = {
        let m = state.manifest.read().await;
        let prefix = format!("{slug}/");
        m.resources
            .iter()
            .filter(|r| r.kind != "audio" && r.path.starts_with(&prefix))
            .cloned()
            .collect()
    };
    let mut done = 0u64;
    for r in &to_fetch {
        if state.engine.resolve(r).await.is_ok() {
            done = done.saturating_add(r.bytes);
        }
    }
    Ok(done)
}

/// GC store entries no longer in the manifest (preserves url-keyed metadata).
#[tauri::command]
async fn gc(state: State<'_, LvState>) -> Result<u64, String> {
    let m = state.manifest.read().await;
    Ok(state.engine.gc(&m).await as u64)
}

/// Offline cache stats for the NON-audio reader content (audio is the native
/// AVPlayer's separate cache, so excluding it makes the number meaningful):
/// `(cached_count, total_count, cached_bytes, total_bytes)`. Drives the
/// "downloaded for offline" indicator.
#[tauri::command]
async fn cache_stats(state: State<'_, LvState>) -> Result<(u64, u64, u64, u64), String> {
    let resources: Vec<Resource> = {
        let m = state.manifest.read().await;
        m.resources.iter().filter(|r| r.kind != "audio").cloned().collect()
    };
    let (mut cc, mut cb) = (0u64, 0u64);
    let total = resources.len() as u64;
    let total_bytes: u64 = resources.iter().map(|r| r.bytes).sum();
    for r in &resources {
        if state.engine.store().has(&r.hash).await {
            cc += 1;
            cb = cb.saturating_add(r.bytes);
        }
    }
    Ok((cc, total, cb, total_bytes))
}

/// Eager-pull the WHOLE corpus's NON-audio content into the store (every book's
/// text/units/spoken/marks/asset). Returns bytes cached. The UI fires this and
/// polls `cache_stats` for live progress (both can run concurrently).
#[tauri::command]
async fn sync_all(state: State<'_, LvState>) -> Result<u64, String> {
    let resources: Vec<Resource> = {
        let m = state.manifest.read().await;
        m.resources.iter().filter(|r| r.kind != "audio").cloned().collect()
    };
    let mut done = 0u64;
    for r in &resources {
        if state.engine.resolve(r).await.is_ok() {
            done = done.saturating_add(r.bytes);
        }
    }
    Ok(done)
}

// ── Custom URI scheme `lvsync://` ─────────────────────────────────────────────
// The webview→plugin IPC is unreliable on iOS (the custom-protocol channel trips
// and PERMANENTLY falls back to postMessage → the Swift PluginManager, which has
// no native lvsync → "Plugin lvsync not initialized"). A registered URL scheme is
// handled by WKWebView's URLSchemeHandler and reaches Rust DIRECTLY from any
// origin, sidestepping that. The web fetches `lvsync://localhost/<path>?<query>`.

/// Raw value of query param `k` (`k=value&…`), or None.
fn query_get(query: &str, k: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let mut it = kv.splitn(2, '=');
        if it.next() == Some(k) {
            it.next().map(str::to_string)
        } else {
            None
        }
    })
}

/// Percent-decode until stable — undoes BOTH the query's `encodeURIComponent` and
/// the app URL's own path encoding, yielding the manifest's raw URL key.
fn decode_all(s: &str) -> String {
    let mut cur = s.to_string();
    loop {
        let next = norm(&cur);
        if next == cur {
            return cur;
        }
        cur = next;
    }
}

/// Bytes already cached + total, for non-audio content: (cached, total, cb, tb).
async fn stats_inner(state: &LvState) -> (u64, u64, u64, u64) {
    let resources: Vec<Resource> = {
        let m = state.manifest.read().await;
        m.resources.iter().filter(|r| r.kind != "audio").cloned().collect()
    };
    let (mut cc, mut cb) = (0u64, 0u64);
    let total = resources.len() as u64;
    let total_bytes: u64 = resources.iter().map(|r| r.bytes).sum();
    for r in &resources {
        if state.engine.store().has(&r.hash).await {
            cc += 1;
            cb = cb.saturating_add(r.bytes);
        }
    }
    (cc, total, cb, total_bytes)
}

/// Dispatch a `lvsync://localhost/<path>?<query>` request → (HTTP status, body).
async fn scheme_dispatch(state: &LvState, path: &str, query: &str) -> (u16, Vec<u8>) {
    match path {
        "/resolve" => {
            let Some(raw) = query_get(query, "u") else {
                return (400, b"missing u".to_vec());
            };
            let url = decode_all(&raw);
            let res = state.by_url.read().await.get(&url).cloned();
            let bytes = match res {
                Some(r) => state.engine.resolve(&r).await,
                None => {
                    let key =
                        format!("{}{}", lv_sync::URL_KEY_PREFIX, lv_sync::hash_hex(url.as_bytes()));
                    state.engine.fetch_keyed(&key, &url).await
                }
            };
            match bytes {
                Ok(b) => (200, b),
                Err(_) => (504, Vec::new()),
            }
        }
        "/stats" => {
            let (c, t, cb, tb) = stats_inner(state).await;
            (200, format!("[{c},{t},{cb},{tb}]").into_bytes())
        }
        "/offline" => {
            // Debug airplane mode for the Rust fetcher (sim has no network switch).
            let on = query.contains("on=1");
            FORCE_OFFLINE.store(on, std::sync::atomic::Ordering::Relaxed);
            (200, format!("offline={on}").into_bytes())
        }
        "/sync_all" => {
            let resources: Vec<Resource> = {
                let m = state.manifest.read().await;
                m.resources.iter().filter(|r| r.kind != "audio").cloned().collect()
            };
            let mut done = 0u64;
            for r in &resources {
                if state.engine.resolve(r).await.is_ok() {
                    done = done.saturating_add(r.bytes);
                }
            }
            (200, format!("{done}").into_bytes())
        }
        _ => (404, b"not found".to_vec()),
    }
}

/// Build the state from the app data dir, manage it, and kick a background
/// manifest refresh. Best-effort — a failure here must not stop the shell.
fn setup_state<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let state = LvState::new(&data_dir)?;
    app.manage(state);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<LvState>();
        let _ = state.refresh().await;
    });
    Ok(())
}

/// The plugin entry point — register with `.plugin(tauri_plugin_lvsync::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lvsync")
        .invoke_handler(tauri::generate_handler![
            resolve,
            knows,
            status,
            refresh,
            offline_fraction,
            sync_book,
            sync_all,
            cache_stats,
            gc,
        ])
        .setup(|app, _api| {
            if let Err(e) = setup_state(app) {
                eprintln!("lvsync init failed: {e}");
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("lvsync", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let query = request.uri().query().unwrap_or("").to_string();
            tauri::async_runtime::spawn(async move {
                let (status, body) = {
                    let state = app.state::<LvState>();
                    scheme_dispatch(&state, &path, &query).await
                };
                let resp = tauri::http::Response::builder()
                    .status(status)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Content-Type", "application/octet-stream")
                    .body(std::borrow::Cow::<[u8]>::Owned(body))
                    .unwrap_or_else(|_| {
                        tauri::http::Response::new(std::borrow::Cow::Owned(Vec::new()))
                    });
                responder.respond(resp);
            });
        })
        .build()
}
