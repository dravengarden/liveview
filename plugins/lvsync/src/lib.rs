//! Native offline-first data layer (eager mode) for the iOS/Mac shell. The
//! bundled SPA reaches it through the `lvsync://` custom scheme because Tauri's
//! webview-to-plugin IPC is unreliable on iOS.
//!
//! Requests resolve through the shared [`lv_sync::Engine`] — store-first against a SQLite
//! content-addressed cache, fetching + caching on a miss. Once read online, a
//! resource replays OFFLINE with zero network. Scope: NON-audio reader content
//! (covers/backdrops/text/units/spoken/marks/assets) + navigation metadata (tree/books,
//! url-keyed). Audio stays in NativeAudioController (its own AVPlayer cache).
//!
//! Manifest lifecycle: seed from the on-disk `/api/dag` cache at startup
//! (offline-launch safe), refresh from the network in the background, never block
//! app start. resolve() never blocks on the refresh.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use lv_sync::sqlite::SqliteBlobStore;
use lv_sync::{BlobStore, Engine, Fetcher, Manifest, Resource};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::RwLock;

/// Comma-separated backend origins baked into the native shell. Deployments can
/// provide public + LAN routes with `LIVEVIEW_REMOTE_ORIGINS`; a public checkout
/// defaults to the local development server and contains no private endpoints.
const DEFAULT_REMOTE_ORIGINS: &str = "http://127.0.0.1:4160";

fn remote_origins() -> Vec<&'static str> {
    option_env!("LIVEVIEW_REMOTE_ORIGINS")
        .unwrap_or(DEFAULT_REMOTE_ORIGINS)
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .collect()
}

/// Safety cap on the APM outbox: a device that never gets a flushable network
/// can't grow the buffer without bound. Normal operation acks + deletes rows, so
/// this only bites offline-forever. ~5k tiny event rows ≈ low single-digit MB.
const APM_MAX_ROWS: i64 = 5000;

/// Debug airplane mode: when set, the fetcher fails immediately so the OFFLINE
/// cache path can be exercised in the simulator (which has no per-app network
/// switch). Toggled via the `lvsync://localhost/offline?on=1` scheme. Cache-first
/// resolves still serve hits; only network misses are forced to fail fast.
static FORCE_OFFLINE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// AUTO fast-fail window (unix-ms; 0 = online). After a real connect/timeout
/// failure we treat the network as down until this instant, so a BURST of
/// network-first reads (e.g. opening the audiobook fires several) pays the connect
/// timeout AT MOST ONCE instead of once per request — the rest fail instantly.
/// Cleared the moment any fetch succeeds. This is the reliable backstop for when
/// the web's connectivity signal (navigator.onLine / NWPathMonitor poll) hasn't
/// flipped the FORCE_OFFLINE flag yet.
static OFFLINE_UNTIL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug)]
struct FetchFailure {
    message: String,
    connectivity: bool,
}

impl std::fmt::Display for FetchFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn successful_response(
    result: Result<reqwest::Response, reqwest::Error>,
) -> Result<reqwest::Response, FetchFailure> {
    let response = result.map_err(|error| FetchFailure {
        connectivity: error.is_connect() || error.is_timeout(),
        message: error.to_string(),
    })?;
    response.error_for_status().map_err(|error| FetchFailure {
        message: error.to_string(),
        connectivity: false,
    })
}

/// Race every configured route and return the first successful HTTP response.
/// Fast failures do not hide a slower healthy route.
async fn send_remote<F>(
    client: &reqwest::Client,
    path: &str,
    configure: F,
) -> Result<reqwest::Response, FetchFailure>
where
    F: Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
{
    use futures_util::stream::{FuturesUnordered, StreamExt as _};

    let mut pending = FuturesUnordered::new();
    for origin in remote_origins() {
        let label = origin.to_string();
        let request = configure(client.get(format!("{origin}{path}"))).send();
        pending.push(async move { (label, request.await) });
    }
    let mut errors = Vec::new();
    let mut connectivity = true;
    while let Some((origin, result)) = pending.next().await {
        match successful_response(result) {
            Ok(response) => return Ok(response),
            Err(error) => {
                connectivity &= error.connectivity;
                errors.push(format!("{origin}: {error}"));
            }
        }
    }
    Err(FetchFailure {
        connectivity,
        message: if errors.is_empty() {
            "no backend origins configured".into()
        } else {
            errors.join("; ")
        },
    })
}

/// reqwest-backed network fetcher. Manifest URLs are origin-relative
/// (`/api/...`); absolute URLs (rare) pass through unchanged.
struct HttpFetcher {
    client: reqwest::Client,
}

#[async_trait]
impl Fetcher for HttpFetcher {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        use std::sync::atomic::Ordering::Relaxed;
        if FORCE_OFFLINE.load(Relaxed) {
            return Err("forced offline".into());
        }
        // Within the auto fast-fail window (a recent connect failure) → fail instantly,
        // no network attempt. Collapses a burst of offline misses to one timeout.
        if OFFLINE_UNTIL_MS.load(Relaxed) > now_ms() {
            return Err("offline (recent failure)".into());
        }
        let result = if url.starts_with("http") {
            successful_response(self.client.get(url).send().await)
        } else {
            send_remote(&self.client, url, |request| request).await
        };
        match result {
            Ok(r) => {
                OFFLINE_UNTIL_MS.store(0, Relaxed); // a response ⇒ network is up
                Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
            }
            Err(error) => {
                // A connect/timeout failure = offline → open the fast-fail window so
                // the rest of this screen's reads don't each wait the connect timeout.
                if error.connectivity {
                    OFFLINE_UNTIL_MS.store(now_ms() + 5000, Relaxed);
                }
                Err(error.to_string())
            }
        }
    }
}

/// Managed state: the engine (store + fetcher) + the current manifest (hot-swapped
/// on refresh) + a `url → Resource` index for O(1) command lookups.
/// The OTA web-bundle manifest served at `/app-dist/manifest.json`.
#[derive(serde::Deserialize)]
struct WebManifest {
    version: String,
    files: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RootResponse {
    #[serde(default = "default_protocol_version")]
    protocol_version: u32,
    root: String,
}

fn default_protocol_version() -> u32 {
    lv_sync::MANIFEST_PROTOCOL_VERSION
}

impl RootResponse {
    fn from_json(json: &str) -> Result<Self, String> {
        let response: Self =
            serde_json::from_str(json).map_err(|error| format!("root parse: {error}"))?;
        if response.protocol_version > lv_sync::MANIFEST_PROTOCOL_VERSION {
            return Err(format!(
                "manifest protocol {} is newer than supported {}",
                response.protocol_version,
                lv_sync::MANIFEST_PROTOCOL_VERSION
            ));
        }
        Ok(response)
    }
}

pub struct LvState {
    engine: Engine<SqliteBlobStore, HttpFetcher>,
    manifest: RwLock<Manifest>,
    by_url: RwLock<HashMap<String, Resource>>,
    /// Where the cached `/api/dag` JSON lives (offline-launch seed).
    manifest_file: PathBuf,
    /// OTA web base dir (`<data>/web/`): the content-addressed app-bundle store that
    /// overrides the embedded SPA so the web hot-updates without an app reinstall.
    /// Layout:
    ///   web/files/<path>          every asset by path (Vite hashes the filename, so
    ///                             unchanged chunks are shared across versions)
    ///   web/roots/<v>/index.html  the (un-hashed) entry, per version
    ///   web/roots/<v>/manifest.json  {version, assets:[...]} for that version
    ///   web/current               the live version string
    ///   web/versions              newline list, newest last (retention order)
    /// Empty until an OTA download; the `/app/` handler then falls back to the embedded
    /// bundle, so a fresh install / offline always works.
    web_root: PathBuf,
}

impl LvState {
    /// Construct synchronously from the app data dir: open the blob dir, seed the
    /// manifest from the on-disk cache if present (so offline launch has a map).
    fn new(data_dir: &Path) -> Result<Self, String> {
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
        // hang on TCP connects to unreachable backend routes for a long OS
        // timeout — so a card tap's `await contentFetch` froze with no navigation
        // until the network came back ("needs network to jump"). A short connect
        // timeout fails fast → the engine returns Offline → lvsync:// 504 → the web
        // enters the book at a cached page or the offline placeholder immediately.
        // (Cached resources are store-first and never hit the network at all.)
        let client = reqwest::Client::builder()
            // 1.5s (was 4s): the floor on how long the FIRST offline miss blocks
            // before the auto fast-fail window (OFFLINE_UNTIL_MS) makes the rest
            // instant. A real connect on the tunnel completes well under this.
            .connect_timeout(Duration::from_millis(1500))
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
            web_root: data_dir.join("web"),
        })
    }

    /// Sanitize an OTA version string (the entry filename, which has `/` and `.`) into
    /// a single safe path component for `web/roots/<v>/`.
    fn ver_dir(version: &str) -> String {
        version
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    }

    /// An OTA web-bundle file for the CURRENT version, or None (→ the `/app/` handler
    /// serves the embedded bundle). `index.html` comes from the current version's root
    /// dir; every other path from the shared content-addressed `web/files/`.
    async fn web_get(&self, rel: &str) -> Option<Vec<u8>> {
        if cfg!(debug_assertions) {
            return None;
        }
        let rel = rel.trim_start_matches('/');
        if rel.is_empty() || rel.contains("..") {
            return None;
        }
        let current = std::fs::read_to_string(self.web_root.join("current")).ok()?;
        let current = current.trim();
        if current.is_empty() {
            return None;
        }
        if rel == "index.html" {
            return std::fs::read(
                self.web_root
                    .join("roots")
                    .join(Self::ver_dir(current))
                    .join("index.html"),
            )
            .ok();
        }
        std::fs::read(self.web_root.join("files").join(rel)).ok()
    }

    /// OTA update check + INCREMENTAL download (content-addressed). Cheap ETag probe,
    /// then download only the assets this device doesn't already have, make the new
    /// version `current`, and retain the last 3 versions. Best-effort + never throws:
    /// any failure leaves the current/embedded bundle serving. Returns a status string;
    /// "updated:<version>" means a new version is live (the web shows the banner + reloads).
    async fn web_ota_check(&self) -> String {
        // Debug shells are the authoritative local UI validation target. Letting a
        // production OTA bundle replace the just-built frontend makes a successful
        // simulator build silently exercise stale code. Release/device builds keep
        // the normal OTA path; debug keeps WebSocket/content sync but serves the
        // embedded dist-app deterministically.
        if cfg!(debug_assertions) {
            return "debug-embedded".into();
        }

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_default();
        let current = std::fs::read_to_string(self.web_root.join("current"))
            .unwrap_or_default()
            .trim()
            .to_string();
        // Cheap conditional probe: If-None-Match the current version → 304 = no update.
        let resp = match send_remote(&client, "/app-dist/manifest.json", |request| {
            request.header("If-None-Match", current.clone())
        })
        .await
        {
            Ok(r) => r,
            Err(e) => return format!("check-err: {e}"),
        };
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return "uptodate".into();
        }
        let manifest: WebManifest = match resp.text().await {
            // reqwest has no `json` feature here; parse via serde_json.
            Ok(t) => match serde_json::from_str::<WebManifest>(&t) {
                Ok(m) => m,
                Err(e) => return format!("manifest-parse-err: {e}"),
            },
            Err(e) => return format!("manifest-read-err: {e}"),
        };
        if manifest.version.is_empty() || manifest.files.is_empty() {
            return "manifest-empty".into();
        }
        if manifest.version == current && self.web_get("index.html").await.is_some() {
            return "uptodate".into();
        }

        let files_dir = self.web_root.join("files");
        let root_dir = self
            .web_root
            .join("roots")
            .join(Self::ver_dir(&manifest.version));
        if let Err(e) = std::fs::create_dir_all(&root_dir) {
            return format!("mkdir-err: {e}");
        }
        // INCREMENTAL: download each asset only when it's not already on disk. Vite's
        // content-hashed filenames make "same path ⇒ same bytes", so unchanged chunks
        // (already present from a prior version) are skipped — a typical update fetches
        // index.html + the few changed chunks.
        let mut assets: Vec<String> = Vec::new();
        let mut fetched = 0usize;
        for f in &manifest.files {
            if f.contains("..") {
                continue;
            }
            if f == "index.html" {
                // The entry is per-version (not content-hashed); always fetch it.
                let bytes = match Self::dl(&client, f).await {
                    Ok(b) => b,
                    Err(e) => return e,
                };
                if let Err(e) = std::fs::write(root_dir.join("index.html"), &bytes) {
                    return format!("write-index-err: {e}");
                }
                continue;
            }
            assets.push(f.clone());
            let dest = files_dir.join(f);
            if dest.is_file() {
                continue; // already have this exact (hashed) asset
            }
            let bytes = match Self::dl(&client, f).await {
                Ok(b) => b,
                Err(e) => return e,
            };
            if let Some(p) = dest.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            if let Err(e) = std::fs::write(&dest, &bytes) {
                return format!("write-err {f}: {e}");
            }
            fetched += 1;
        }
        // Record this version's asset list (for serving + retention GC), then flip
        // `current` — atomically last, so a partial download never goes live.
        let root_json = serde_json::json!({ "version": manifest.version, "assets": assets });
        if let Err(e) = std::fs::write(root_dir.join("manifest.json"), root_json.to_string()) {
            return format!("write-manifest-err: {e}");
        }
        if !root_dir.join("index.html").is_file() {
            return "no-index".into();
        }
        let _ = std::fs::write(self.web_root.join("current"), &manifest.version);
        self.web_record_version(&manifest.version);
        self.web_gc();
        format!("updated:{} ({} fetched)", manifest.version, fetched)
    }

    /// Download one OTA bundle file → bytes, or an error string.
    async fn dl(client: &reqwest::Client, path: &str) -> Result<Vec<u8>, String> {
        match send_remote(client, &format!("/app-dist/{path}"), |request| request).await {
            Ok(r) => r
                .bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(|e| format!("dl-body {path}: {e}")),
            Err(e) => Err(format!("dl {path}: {e}")),
        }
    }

    /// Append `version` to the newest-last retention list (dedup, move-to-end).
    fn web_record_version(&self, version: &str) {
        let p = self.web_root.join("versions");
        let mut vs: Vec<String> = std::fs::read_to_string(&p)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty() && *l != version)
            .map(str::to_string)
            .collect();
        vs.push(version.to_string());
        let _ = std::fs::write(&p, vs.join("\n"));
    }

    /// Retain the last 3 versions: drop older root dirs + any `web/files/` asset not
    /// referenced by a kept version (content-addressed → shared assets stay). Enables
    /// rollback to any of the 3 and bounds storage.
    fn web_gc(&self) {
        let vs: Vec<String> = std::fs::read_to_string(self.web_root.join("versions"))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();
        let keep: std::collections::HashSet<&String> = vs.iter().rev().take(3).collect();
        let roots = self.web_root.join("roots");
        // Remove root dirs for dropped versions + collect kept versions' assets.
        let mut keep_assets: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(entries) = std::fs::read_dir(&roots) {
            for e in entries.flatten() {
                let vdir = e.file_name().to_string_lossy().to_string();
                let kept = keep.iter().any(|v| Self::ver_dir(v) == vdir);
                if !kept {
                    let _ = std::fs::remove_dir_all(e.path());
                    continue;
                }
                if let Ok(t) = std::fs::read_to_string(e.path().join("manifest.json"))
                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(&t)
                    && let Some(arr) = v.get("assets").and_then(|a| a.as_array())
                {
                    for a in arr {
                        if let Some(s) = a.as_str() {
                            keep_assets.insert(s.to_string());
                        }
                    }
                }
            }
        }
        // Prune unreferenced assets (recurse web/files/, compare bundle-relative path).
        let files = self.web_root.join("files");
        Self::prune_files(&files, &files, &keep_assets);
        // Trim the versions list to the kept set (newest-last order preserved).
        let trimmed: Vec<String> = vs.iter().filter(|v| keep.contains(v)).cloned().collect();
        let _ = std::fs::write(self.web_root.join("versions"), trimmed.join("\n"));
    }

    fn prune_files(base: &PathBuf, dir: &PathBuf, keep: &std::collections::HashSet<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                Self::prune_files(base, &p, keep);
            } else if let Ok(rel) = p.strip_prefix(base)
                && !keep.contains(&rel.to_string_lossy().to_string())
            {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    /// Probe `/api/root`, then pull `/api/dag` only when the deploy root changed.
    /// On success swap the manifest + index and rewrite the on-disk cache.
    /// Best-effort: offline keeps the old map.
    async fn refresh(&self) -> Result<String, String> {
        // Timeout so a background refresh can't hang forever offline (mirrors the
        // engine fetcher's timeouts).
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let current = self.manifest.read().await.root.clone();
        let root_response = send_remote(&client, "/api/root", |request| {
            if current.is_empty() {
                request
            } else {
                request.header("If-None-Match", current.clone())
            }
        })
        .await;
        match root_response {
            Ok(response) if response.status() == reqwest::StatusCode::NOT_MODIFIED => {
                return Ok(current);
            }
            Ok(response) => {
                let root = response
                    .text()
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|body| RootResponse::from_json(&body).map(|root| root.root))?;
                if !current.is_empty() && root == current {
                    return Ok(current);
                }
            }
            Err(_) => {
                // Older servers may not expose /api/root. Fall through to the
                // full DAG request so compatibility and self-healing win.
            }
        }

        let response = send_remote(&client, "/api/dag", |request| {
            if current.is_empty() {
                request
            } else {
                request.header("If-None-Match", current.clone())
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(current);
        }
        let json = response.text().await.map_err(|e| e.to_string())?;
        let m = Manifest::from_json(&json)?;
        let root = m.root.clone();
        let idx = index(&m);
        // Swift's audio coordinator reads this same durable manifest off-main.
        // Publish atomically so it can never observe a partially-written DAG.
        let temporary = self.manifest_file.with_extension("json.tmp");
        if std::fs::write(&temporary, &json).is_ok() {
            let _ = std::fs::rename(&temporary, &self.manifest_file);
        }
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

// ── Plugin commands (kept for desktop/debug IPC callers) ─────────────────────

/// Resolve a content URL → its content as a UTF-8 STRING, offline-safe. A
/// MANIFEST resource resolves store-first by content hash; any OTHER content URL
/// (navigation metadata: /api/tree, /api/books) goes through the url-keyed
/// network-first cache so it too works offline. Errors `"offline"` when uncached
/// + unreachable.
///
/// Returns a String, NOT raw `ipc::Response` bytes: the shell loads a REMOTE
/// origin, where Tauri's custom-protocol IPC is blocked (cross-origin/CSP) and
/// falls back to the postMessage channel — which is JSON/string only, so raw
/// bytes come back CORRUPTED (serialized as a number array). A String survives
/// BOTH IPC transports intact. Every command caller routes text here; binary
/// artwork uses the custom URL scheme dispatcher below, while audio uses the
/// native AVPlayer.
#[tauri::command]
async fn resolve(state: State<'_, LvState>, url: String) -> Result<String, String> {
    let n = norm(&url);
    let res = state.by_url.read().await.get(&n).cloned();
    let bytes = match res {
        Some(r) => state.engine.resolve(&r).await,
        None => {
            let key = format!(
                "{}{}",
                lv_sync::URL_KEY_PREFIX,
                lv_sync::hash_hex(n.as_bytes())
            );
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
        m.resources
            .iter()
            .filter(|r| r.kind != "audio")
            .cloned()
            .collect()
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
        m.resources
            .iter()
            .filter(|r| r.kind != "audio")
            .cloned()
            .collect()
    };
    // CONCURRENT (was sequential): the text store has ~12k tiny resources; resolving
    // them one-at-a-time over the high-latency remote tunnel took MINUTES, so a
    // device that added new resources (e.g. audio `spoken` transcripts) often went
    // offline before the fill finished → chapters stayed blank offline. Already-
    // cached resources resolve instantly (store hit); only the missing few hit the
    // network, now up to 24 in flight, so a full fill completes in seconds.
    use futures_util::StreamExt as _;
    // Capture a Copy reference to the engine (moving `state` per-call would be E0507)
    // and move OWNED `Resource`s into each future (borrowing the iterator item trips
    // a higher-ranked-lifetime error with buffer_unordered).
    let engine = &state.engine;
    let done = futures_util::stream::iter(resources)
        .map(|r| async move {
            if engine.resolve(&r).await.is_ok() {
                r.bytes
            } else {
                0
            }
        })
        .buffer_unordered(24)
        .fold(0u64, |acc, b| async move { acc.saturating_add(b) })
        .await;
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

/// Guess a response Content-Type from the body's magic bytes. Images MUST carry
/// a real image/* type to render in an `<img>` over the custom scheme; everything
/// else is read as text/bytes by the web and doesn't care, so it falls through to
/// octet-stream.
fn sniff_content_type(body: &[u8]) -> &'static str {
    match body {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        // WEBP: "RIFF" .... "WEBP"
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => "image/webp",
        // SVG (text) — match a leading "<?xml" or "<svg" after optional BOM/space.
        _ if {
            let s = &body[..body.len().min(64)];
            let t = std::str::from_utf8(s).unwrap_or("").trim_start();
            t.starts_with("<svg")
                || (t.starts_with("<?xml") && body.windows(4).take(256).any(|w| w == b"<svg"))
        } =>
        {
            "image/svg+xml"
        }
        _ => "application/octet-stream",
    }
}

/// Response Content-Type for a served path: by EXTENSION for web-bundle assets
/// (a JS module MUST be `text/javascript` to import over a custom scheme — there's
/// no browser MIME-sniff fallback there), falling back to magic-byte sniffing for
/// extensionless / dynamic content (e.g. /resolve covers).
fn content_type_for(path: &str, body: &[u8]) -> &'static str {
    if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".html") {
        "text/html"
    } else if path.ends_with(".json") || path.ends_with(".webmanifest") {
        "application/json"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else {
        sniff_content_type(body)
    }
}

/// Bytes already cached + total, for non-audio content: (cached, total, cb, tb).
async fn stats_inner(state: &LvState) -> (u64, u64, u64, u64) {
    let resources: Vec<Resource> = {
        let m = state.manifest.read().await;
        m.resources
            .iter()
            .filter(|r| r.kind != "audio")
            .cloned()
            .collect()
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
        "/origins" => match serde_json::to_vec(&remote_origins()) {
            Ok(body) => (200, body),
            Err(error) => (500, error.to_string().into_bytes()),
        },
        "/resolve" => {
            let Some(raw) = query_get(query, "u") else {
                return (400, b"missing u".to_vec());
            };
            let url = decode_all(&raw);
            // cf=1 ⇒ CACHE-FIRST for a url-keyed read. The url-keyed path is
            // network-first by default (right for live reads), but a DEPLOY-STABLE
            // map like /api/manifest/<slug> is on the audio-playback HOT PATH:
            // audioHash AWAITS it before the native player loads, so a network-first
            // fetch that stalls = the audio switch hangs on "loading" even though the
            // manifest (and the audio blob) are already on disk. With cf=1 we serve
            // the cached copy instantly and only hit the network on a true miss —
            // STORAGE-FIRST, as offline-first demands. The download driver still
            // refreshes these manifests network-first on launch.
            let cache_first = query.split('&').any(|kv| kv == "cf=1");
            let res = state.by_url.read().await.get(&url).cloned();
            let bytes = match res {
                Some(r) => state.engine.resolve(&r).await,
                None => {
                    let key = format!(
                        "{}{}",
                        lv_sync::URL_KEY_PREFIX,
                        lv_sync::hash_hex(url.as_bytes())
                    );
                    match if cache_first {
                        state.engine.store().get(&key).await
                    } else {
                        None
                    } {
                        Some(b) => Ok(b),
                        None => state.engine.fetch_keyed(&key, &url).await,
                    }
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
        "/ota-check" => {
            // The web's updater calls this (timer + on load): cheap ETag probe, then
            // INCREMENTAL download + make the new version current. "updated:<v>" ⇒ the
            // web shows the "更新将在 3s 后生效" banner and reloads into the new bundle.
            let msg = state.web_ota_check().await;
            (200, msg.into_bytes())
        }
        "/refresh" => {
            // Probe /api/root and, when changed, re-pull /api/dag → swap the
            // manifest + by_url index. The web driver
            // calls this on EVERY app open + foreground (not just cold launch, which
            // is the only other time setup_state refreshes). Without it, a device
            // that warm-resumes never learns about resources ADDED to the corpus
            // after its last cold launch (e.g. the audio-rendition `spoken`
            // transcripts) — so `total` never grows, the cached<total sync never
            // fires, and those chapters stay blank offline forever. With it, the
            // manifest is always current and the pump downloads whatever's new.
            match state.refresh().await {
                Ok(root) => (200, root.into_bytes()),
                Err(e) => (504, e.into_bytes()),
            }
        }
        "/audio-index" => {
            // The web audio driver needs only audio + marks resources. Serving
            // this subset from the already-refreshed in-memory manifest avoids a
            // second multi-megabyte /api/dag network request on every foreground.
            let manifest = state.manifest.read().await;
            let resources: Vec<&Resource> = manifest
                .resources
                .iter()
                .filter(|resource| resource.kind == "audio" || resource.kind == "marks")
                .collect();
            match serde_json::to_vec(&serde_json::json!({
                "protocol_version": manifest.protocol_version,
                "root": manifest.root,
                "resources": resources,
            })) {
                Ok(body) => (200, body),
                Err(error) => (500, error.to_string().into_bytes()),
            }
        }
        "/sync_all" => {
            let resources: Vec<Resource> = {
                let m = state.manifest.read().await;
                m.resources
                    .iter()
                    .filter(|r| r.kind != "audio")
                    .cloned()
                    .collect()
            };
            let mut done = 0u64;
            for r in &resources {
                if state.engine.resolve(r).await.is_ok() {
                    done = done.saturating_add(r.bytes);
                }
            }
            (200, format!("{done}").into_bytes())
        }
        // ── APM outbox: the web logs client events here (offline-durable in the
        // SqliteBlobStore), then flushes them to the server when the network is
        // good. The store is schema-dumb — the web owns the event JSON shape; this
        // only lifts out `event_id` (dedup/ack) + `client_ts` (prune order).
        "/apm/log" => {
            let Some(raw) = query_get(query, "e") else {
                return (400, b"missing e".to_vec());
            };
            let body = decode_all(&raw);
            let (id, ts) = match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => (
                    v.get("event_id")
                        .and_then(|x| x.as_str())
                        .map(str::to_string),
                    v.get("client_ts")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or_else(|| now_ms() as i64),
                ),
                Err(_) => (None, now_ms() as i64),
            };
            let Some(id) = id else {
                return (400, b"missing event_id".to_vec());
            };
            let store = state.engine.store();
            store.apm_log(&id, ts, &body);
            store.apm_prune(APM_MAX_ROWS);
            (200, b"ok".to_vec())
        }
        "/apm/drain" => {
            let limit = query_get(query, "limit")
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(50)
                .clamp(1, 500);
            // Each stored body is already a JSON object; splice them into an array
            // without re-parsing (the web POSTs this verbatim to /api/ingest).
            let bodies = state.engine.store().apm_drain(limit);
            let mut out =
                String::with_capacity(bodies.iter().map(|b| b.len() + 1).sum::<usize>() + 2);
            out.push('[');
            for (i, b) in bodies.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(b);
            }
            out.push(']');
            (200, out.into_bytes())
        }
        "/apm/ack" => {
            let ids: Vec<String> = query_get(query, "ids")
                .map(|s| {
                    decode_all(&s)
                        .split(',')
                        .filter(|x| !x.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            state.engine.store().apm_ack(&ids);
            (200, b"ok".to_vec())
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
    // The WEB drives the app-bundle OTA: it calls lvsync://localhost/ota-check on load
    // + on a timer, and on "updated:<v>" shows the banner and reloads (web_ota_check
    // does the ETag probe + incremental download + flips `current`).
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
                // ── OTA web bundle: `lvsync://localhost/app/<path>` ──────────────
                // Serve the SPA itself from here so it can hot-update: the OTA store
                // overlay (downloaded from the server) wins, else the EMBEDDED bundle
                // (the app's own dist-app, via Tauri's asset resolver) — so a fresh
                // install / offline always works. The app keeps the tauri://localhost
                // origin (IPC intact); a bootstrap loads from /app/. index.html is
                // no-store (a new bundle is never masked), hashed assets immutable.
                let app_rel = match path.as_str() {
                    "/" | "/index.html" | "/app" | "/app/" => Some("index.html"),
                    _ => path.strip_prefix("/app/"),
                };
                if let Some(rel0) = app_rel {
                    let rel = if rel0.is_empty() { "index.html" } else { rel0 };
                    let state = app.state::<LvState>();
                    let body = state
                        .web_get(rel)
                        .await
                        .or_else(|| app.asset_resolver().get(rel.to_string()).map(|a| a.bytes));
                    let (status, bytes) = match body {
                        Some(b) => (200u16, b),
                        None => (404u16, b"not found".to_vec()),
                    };
                    let cache = if rel == "index.html" {
                        "no-store"
                    } else {
                        "public, max-age=31536000, immutable"
                    };
                    let resp = tauri::http::Response::builder()
                        .status(status)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Content-Type", content_type_for(rel, &bytes))
                        .header("Cache-Control", cache)
                        .body(std::borrow::Cow::<[u8]>::Owned(bytes))
                        .unwrap_or_else(|_| {
                            tauri::http::Response::new(std::borrow::Cow::Owned(Vec::new()))
                        });
                    responder.respond(resp);
                    return;
                }
                let (status, body) = {
                    let state = app.state::<LvState>();
                    scheme_dispatch(&state, &path, &query).await
                };
                let resp = tauri::http::Response::builder()
                    .status(status)
                    .header("Access-Control-Allow-Origin", "*")
                    // Content-Type by path extension for web-bundle assets (a JS
                    // module needs text/javascript to import over the scheme), else
                    // magic-byte sniff for dynamic content (covers via /resolve).
                    .header("Content-Type", content_type_for(&path, &body))
                    .body(std::borrow::Cow::<[u8]>::Owned(body))
                    .unwrap_or_else(|_| {
                        tauri::http::Response::new(std::borrow::Cow::Owned(Vec::new()))
                    });
                responder.respond(resp);
            });
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(kind: &str, path: &str) -> Resource {
        Resource {
            path: path.into(),
            hash: format!("hash-{kind}"),
            kind: kind.into(),
            bytes: 1,
            url: format!("/api/{kind}"),
        }
    }

    #[test]
    fn url_normalization_and_content_types_are_stable() {
        assert_eq!(norm("/api/file?path=a%2Fb%20c"), "/api/file?path=a/b c");
        assert_eq!(content_type_for("assets/app.js", b""), "text/javascript");
        assert_eq!(content_type_for("assets/font.woff2", b""), "font/woff2");
        assert_eq!(LvState::ver_dir("assets/index-a.b/c"), "assets_index_a_b_c");
    }

    #[test]
    fn root_protocol_defaults_legacy_and_rejects_future() {
        let legacy = RootResponse::from_json(r#"{"root":"r"}"#).unwrap();
        assert_eq!(legacy.protocol_version, lv_sync::MANIFEST_PROTOCOL_VERSION);

        let future = format!(
            r#"{{"protocol_version":{},"root":"r"}}"#,
            lv_sync::MANIFEST_PROTOCOL_VERSION + 1
        );
        assert!(
            RootResponse::from_json(&future)
                .unwrap_err()
                .contains("newer than supported")
        );
    }

    #[tokio::test]
    async fn audio_index_exposes_only_audio_and_marks() {
        let unique = format!(
            "liveview-lvsync-test-audio-{}-{}",
            std::process::id(),
            now_ms()
        );
        let root = std::env::temp_dir().join(unique);
        let data = root.join("plugin");
        std::fs::create_dir_all(&data).unwrap();
        let state = LvState::new(&data).unwrap();
        *state.manifest.write().await = Manifest {
            root: "root".into(),
            resources: vec![
                resource("text", "book/text/en/a.md"),
                resource("audio", "book/audio/en/a.md#audio"),
                resource("marks", "book/audio/en/a.md#marks"),
            ],
            ..Manifest::default()
        };

        let (status, body) = scheme_dispatch(&state, "/audio-index", "").await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let resources = json["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 2);
        assert!(
            resources
                .iter()
                .all(|resource| { matches!(resource["kind"].as_str(), Some("audio" | "marks")) })
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn origins_exposes_the_native_backend_configuration() {
        let unique = format!(
            "liveview-lvsync-test-origins-{}-{}",
            std::process::id(),
            now_ms()
        );
        let root = std::env::temp_dir().join(unique);
        let data = root.join("plugin");
        std::fs::create_dir_all(&data).unwrap();
        let state = LvState::new(&data).unwrap();

        let (status, body) = scheme_dispatch(&state, "/origins", "").await;
        assert_eq!(status, 200);
        let origins: Vec<String> = serde_json::from_slice(&body).unwrap();
        assert_eq!(origins, remote_origins());

        std::fs::remove_dir_all(root).unwrap();
    }
}
