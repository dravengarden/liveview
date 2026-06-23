//! Native offline-first data layer (eager mode) for the iOS/Mac shell.
//!
//! The shell loads the REMOTE liveview UI in a WKWebView. With no service worker
//! (unreliable in WKWebView) the web app would have NO offline content. This
//! module gives it one: the remote UI calls the `lv_*` commands over Tauri IPC,
//! which resolve through the shared [`lv_sync::Engine`] — store-first against a
//! filesystem content-addressed cache, fetching + caching on a miss. Once a
//! resource has been read online it replays OFFLINE with zero network.
//!
//! Scope: NON-audio reader content (text html, units, spoken, marks, assets).
//! Audio stays in NativeAudioController (its own AVPlayer + offline cache). The
//! retention planner (lv_sync::retention) decides WHICH audio books to pull; the
//! Swift layer executes that — out of scope here.
//!
//! Manifest lifecycle: load the cached `/api/dag` from disk at startup (so the
//! first launch offline still has the last-known map), then refresh from the
//! network in the background and rewrite the cache. resolve() never blocks on the
//! refresh — an empty/old manifest just means "not resolvable yet", and the web
//! facade falls back to a direct fetch (which is what it did before this layer).

use std::collections::HashMap;
use std::path::PathBuf;

use async_trait::async_trait;
use lv_sync::native::FsBlobStore;
use lv_sync::{Engine, Fetcher, Manifest, Resource};
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

/// The remote liveview origin (same as the loader's REMOTE / tauri.conf devUrl).
const REMOTE: &str = "https://liveview.hawk.thundersparrow.top";

/// reqwest-backed network fetcher. Manifest URLs are origin-relative
/// (`/api/...`); absolute URLs (rare) pass through unchanged.
struct HttpFetcher {
    client: reqwest::Client,
}

#[async_trait]
impl Fetcher for HttpFetcher {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
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
    engine: Engine<FsBlobStore, HttpFetcher>,
    manifest: RwLock<Manifest>,
    by_url: RwLock<HashMap<String, Resource>>,
    /// Where the cached `/api/dag` JSON lives (offline-launch seed).
    manifest_file: PathBuf,
}

impl LvState {
    /// Construct synchronously from the app data dir: open the blob dir, seed the
    /// manifest from the on-disk cache if present (so offline launch has a map).
    fn new(data_dir: &PathBuf) -> Result<Self, String> {
        let blob_dir = data_dir.join("blobs");
        let store = FsBlobStore::new(&blob_dir).map_err(|e| e.to_string())?;
        // verify OFF: a resource hash is a content key (rustfs / source blake3),
        // not blake3 of the SERVED bytes (rendered html) — trust the store key.
        let engine = Engine::new(store, HttpFetcher { client: reqwest::Client::new() }).without_verify();
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
        let json = reqwest::get(format!("{REMOTE}/api/dag"))
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
    m.resources
        .iter()
        .map(|r| (norm(&r.url), r.clone()))
        .collect()
}

/// Percent-decode a URL so the web's `encodeURIComponent`'d reads match the
/// manifest's raw URLs. The app fetches `/api/file?path=slug%2Frel&...` while
/// `/api/dag` emits the equivalent `/api/file?path=slug/rel&...` (ASCII corpus,
/// raw query) — decoding both sides makes them equal. Manifest URLs carry no `%`,
/// so decoding them is a no-op; only the incoming query URLs actually change.
/// `%blob/<hash>` URLs have no `%`, so they pass through unchanged.
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

// ── Tauri commands (called from the remote UI over IPC) ──────────────────────

/// Resolve a content URL → raw bytes (binary IPC response, NOT a JSON number
/// array), offline-safe. A MANIFEST resource resolves store-first by content
/// hash (immutable, instant when cached). Any OTHER content URL — the navigation
/// metadata the manifest doesn't enumerate (`/api/tree`, `/api/books`, covers) —
/// goes through the url-keyed network-first cache so it too works offline. This
/// is the SOLE content path on the shell: the web must NOT fall back to a raw
/// WKWebView `fetch`, which HANGS offline (the whole bug this fixes). Errors
/// `"offline"` when uncached + unreachable.
#[tauri::command]
pub(crate) async fn lv_resolve(state: State<'_, LvState>, url: String) -> Result<tauri::ipc::Response, String> {
    let n = norm(&url);
    let res = state.by_url.read().await.get(&n).cloned();
    let bytes = match res {
        Some(r) => state.engine.resolve(&r).await,
        None => {
            // Non-manifest content (tree/books/cover): cache it keyed by the URL.
            let key = format!("{}{}", lv_sync::URL_KEY_PREFIX, lv_sync::hash_hex(n.as_bytes()));
            state.engine.fetch_keyed(&key, &n).await
        }
    }
    .map_err(|e| match e {
        lv_sync::ResolveError::Offline => "offline".to_string(),
        lv_sync::ResolveError::Integrity => "integrity".to_string(),
    })?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Whether a URL is in the current manifest (the web decides whether to route via
/// `lv_resolve` or fall back to `fetch`).
#[tauri::command]
pub(crate) async fn lv_knows(state: State<'_, LvState>, url: String) -> Result<bool, String> {
    Ok(state.by_url.read().await.contains_key(&norm(&url)))
}

/// The current manifest root + resource count (readiness probe for the web).
#[tauri::command]
pub(crate) async fn lv_status(state: State<'_, LvState>) -> Result<(String, usize), String> {
    let m = state.manifest.read().await;
    Ok((m.root.clone(), m.resources.len()))
}

/// Re-pull the manifest from the network. Returns the new root.
#[tauri::command]
pub(crate) async fn lv_refresh(state: State<'_, LvState>) -> Result<String, String> {
    state.refresh().await
}

/// Byte-weighted offline fraction in [0,1] over the whole corpus.
#[tauri::command]
pub(crate) async fn lv_offline_fraction(state: State<'_, LvState>) -> Result<f64, String> {
    let m = state.manifest.read().await;
    Ok(state.engine.offline_fraction(&m).await)
}

/// Eager-pull a single book's NON-audio resources into the store (text/units/
/// spoken/marks/asset). Audio is the Swift layer's job. Returns bytes cached.
#[tauri::command]
pub(crate) async fn lv_sync_book(state: State<'_, LvState>, slug: String) -> Result<u64, String> {
    // Snapshot the book's non-audio resources, then drop the manifest lock before
    // the (potentially long) fetch loop so a background refresh isn't blocked.
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

/// GC store entries no longer in the manifest. Returns the count dropped.
#[tauri::command]
pub(crate) async fn lv_gc(state: State<'_, LvState>) -> Result<u64, String> {
    let m = state.manifest.read().await;
    Ok(state.engine.gc(&m).await as u64)
}

/// Initialise the data layer on the given app: build the state from the app data
/// dir, manage it, and kick a background manifest refresh. Call from `setup`.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let state = LvState::new(&data_dir)?;
    app.manage(state);
    // Refresh the manifest in the background — never block app start on the net.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<LvState>();
        let _ = state.refresh().await;
    });
    Ok(())
}
