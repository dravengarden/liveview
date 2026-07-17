//! lv-sync — the liveview NATIVE (iOS/Mac Tauri) client's Merkle/sync/storage
//! CORE. (The web/PWA stays plain TypeScript, lazy mode — it is NOT a consumer.)
//!
//! The native shell drives this one implementation of:
//!   - the content-addressed model (a resource is addressed by its blake3 hash),
//!   - resolve: serve a resource from the local store, else fetch the origin and
//!     cache it (store-first — the offline-first guarantee),
//!   - eager sync: pull a whole manifest into the store,
//!   - a byte-weighted offline percentage (audio dominates, so counting BYTES not
//!     files is the only honest progress).
//!
//! It does NO platform IO itself: the caller supplies a [`BlobStore`] (the
//! filesystem [`native::FsBlobStore`]) and a [`Fetcher`] (the shell's HTTP
//! client). That trait seam keeps the logic pure + host-unit-testable.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub mod merkle;
pub mod native;
pub mod retention;
pub mod sqlite;

/// Store-key prefix for the url-keyed metadata cache (non-content-addressed,
/// mutable endpoints like `/api/tree`). [`Engine::gc`] preserves these.
pub const URL_KEY_PREFIX: &str = "url:";

/// blake3 hex of `bytes` — the content-address helper, also used by callers to
/// derive a stable store key from a URL string (`url:<hash_hex(url)>`).
pub fn hash_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// One content resource in the corpus manifest. `hash` is the content address
/// (blake3 hex) — the cache key AND the integrity check; `url` is where to fetch
/// it from when absent; `bytes` is its size (drives the byte-weighted progress).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resource {
    /// Logical path (e.g. `slug/text/zh/01.md`) — how the app asks for it.
    pub path: String,
    /// Content address (blake3 hex) — the store key + integrity check.
    pub hash: String,
    /// Resource class: `cover` | `backdrop` | `card-backdrop` | `text` |
    /// `units` | `spoken` | `marks` | `audio` | `asset`.
    pub kind: String,
    /// Byte size of the resource (0 if unknown). Drives `offline_fraction`.
    pub bytes: u64,
    /// Origin URL to fetch when not in the store.
    pub url: String,
}

/// The corpus manifest the client mirrors: the Merkle root (an O(1) "anything
/// changed?" cursor) plus every resource.
pub const MANIFEST_PROTOCOL_VERSION: u32 = 1;

fn default_manifest_protocol_version() -> u32 {
    MANIFEST_PROTOCOL_VERSION
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    /// Wire format version. Missing means v1 for manifests cached by older apps.
    #[serde(default = "default_manifest_protocol_version")]
    pub protocol_version: u32,
    /// Current deploy root hash; when it changes, re-pull the manifest + diff.
    pub root: String,
    pub resources: Vec<Resource>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            protocol_version: MANIFEST_PROTOCOL_VERSION,
            root: String::new(),
            resources: Vec::new(),
        }
    }
}

impl Manifest {
    /// Parse a manifest from the server's JSON.
    pub fn from_json(s: &str) -> Result<Self, String> {
        let manifest: Self = serde_json::from_str(s).map_err(|e| format!("manifest parse: {e}"))?;
        if manifest.protocol_version > MANIFEST_PROTOCOL_VERSION {
            return Err(format!(
                "manifest protocol {} is newer than supported {}",
                manifest.protocol_version, MANIFEST_PROTOCOL_VERSION
            ));
        }
        Ok(manifest)
    }

    /// Total bytes of every resource — the denominator of the offline percentage.
    pub fn total_bytes(&self) -> u64 {
        self.resources.iter().map(|r| r.bytes).sum()
    }

    /// Look up a resource by its logical path.
    pub fn by_path(&self, path: &str) -> Option<&Resource> {
        self.resources.iter().find(|r| r.path == path)
    }
}

/// A content-addressed local blob store. Keys are content hashes; values are the
/// exact bytes. Implemented by [`native::FsBlobStore`] (a file-per-hash dir).
/// All methods are best-effort: an error/None means "not stored", never a panic.
#[async_trait]
pub trait BlobStore {
    /// The bytes for `hash`, or `None` if not stored.
    async fn get(&self, hash: &str) -> Option<Vec<u8>>;
    /// Store `data` under `hash` (idempotent — the hash IS the content).
    async fn put(&self, hash: &str, data: &[u8]);
    /// Whether `hash` is stored (cheaper than `get` when bytes aren't needed).
    async fn has(&self, hash: &str) -> bool;
    /// Every stored hash — for the offline percentage + GC of orphans.
    async fn keys(&self) -> Vec<String>;
    /// Drop `hash` from the store (GC of a hash no longer in the manifest).
    async fn remove(&self, hash: &str);
}

/// The platform's network. Returns the raw bytes, or an error string when the
/// fetch fails (offline / 404 / timeout) — the engine treats any error as "not
/// available from the network right now".
#[async_trait]
pub trait Fetcher {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// Why a resolve failed, so the UI can show the right state (offline placeholder
/// vs a hard error) without guessing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolveError {
    /// Not in the store AND the network fetch failed (offline / unreachable).
    Offline,
    /// Fetched, but the bytes' hash didn't match the manifest (corrupt/MITM).
    Integrity,
}

/// The sync engine — generic over the store + fetcher, so the logic is one piece
/// and the platform IO (filesystem store, HTTP fetcher) plugs in behind traits.
pub struct Engine<S: BlobStore, F: Fetcher> {
    store: S,
    fetcher: F,
    /// Verify fetched bytes against the expected hash before storing. On by
    /// default; the integrity guarantee of content-addressing.
    verify: bool,
}

impl<S: BlobStore, F: Fetcher> Engine<S, F> {
    pub fn new(store: S, fetcher: F) -> Self {
        Self {
            store,
            fetcher,
            verify: true,
        }
    }

    /// Disable fetch-time hash verification (e.g. for resources whose `hash` is a
    /// rustfs key, not blake3 of the served bytes). Default is verify-on.
    pub fn without_verify(mut self) -> Self {
        self.verify = false;
        self
    }

    /// Resolve a resource: STORE-FIRST (offline-instant), else fetch the origin,
    /// verify, and cache it. The offline-first read primitive.
    pub async fn resolve(&self, r: &Resource) -> Result<Vec<u8>, ResolveError> {
        if let Some(bytes) = self.store.get(&r.hash).await {
            return Ok(bytes);
        }
        let bytes = self
            .fetcher
            .fetch(&r.url)
            .await
            .map_err(|_| ResolveError::Offline)?;
        if self.verify && !r.hash.is_empty() {
            let got = blake3::hash(&bytes).to_hex().to_string();
            if got != r.hash {
                return Err(ResolveError::Integrity);
            }
        }
        self.store.put(&r.hash, &bytes).await;
        Ok(bytes)
    }

    /// Resolve by logical path against a manifest.
    pub async fn resolve_path(&self, m: &Manifest, path: &str) -> Result<Vec<u8>, ResolveError> {
        match m.by_path(path) {
            Some(r) => self.resolve(r).await,
            None => Err(ResolveError::Offline),
        }
    }

    /// EAGER sync: ensure every manifest resource is in the store. Fetches only
    /// the missing ones; reports progress via `on_progress(done_bytes, total)`.
    /// Best-effort — a resource that won't fetch is skipped (counted as not done)
    /// so one failure never aborts the sweep. Returns the bytes now cached.
    pub async fn sync_all<P: FnMut(u64, u64)>(&self, m: &Manifest, mut on_progress: P) -> u64 {
        let total = m.total_bytes();
        let mut done = self.cached_bytes(m).await;
        on_progress(done, total);
        for r in &m.resources {
            if self.store.has(&r.hash).await {
                continue;
            }
            if self.resolve(r).await.is_ok() {
                done = done.saturating_add(r.bytes);
                on_progress(done, total);
            }
        }
        done
    }

    /// Bytes of `m`'s resources already in the store (the numerator of the
    /// offline percentage). Reflects the REAL cache, so eviction is honest.
    pub async fn cached_bytes(&self, m: &Manifest) -> u64 {
        let mut sum = 0u64;
        for r in &m.resources {
            if self.store.has(&r.hash).await {
                sum = sum.saturating_add(r.bytes);
            }
        }
        sum
    }

    /// Byte-weighted offline fraction in [0,1] — how much of `m` is saved
    /// offline, weighted by SIZE (so a missing 5 MB audio counts far more than a
    /// missing 50 KB chapter). 1.0 when nothing to store (empty manifest).
    pub async fn offline_fraction(&self, m: &Manifest) -> f64 {
        let total = m.total_bytes();
        if total == 0 {
            return 1.0;
        }
        self.cached_bytes(m).await as f64 / total as f64
    }

    /// Network-first cache for a NON-content-addressed URL — mutable metadata the
    /// manifest doesn't enumerate (the sidebar tree `/api/tree`, the catalog
    /// `/api/books`, covers). Fetch fresh when reachable + cache under `key`; on a
    /// network failure fall back to the cached copy; `Offline` only if neither
    /// works. Use a [`URL_KEY_PREFIX`]-prefixed `key` so [`gc`](Self::gc) keeps it
    /// (it isn't in the manifest). Native `fetch` (reqwest) fails FAST offline, so
    /// network-first never hangs — unlike a WKWebView `fetch`, which is exactly the
    /// offline-hang this layer exists to avoid.
    pub async fn fetch_keyed(&self, key: &str, url: &str) -> Result<Vec<u8>, ResolveError> {
        match self.fetcher.fetch(url).await {
            Ok(bytes) => {
                self.store.put(key, &bytes).await;
                Ok(bytes)
            }
            Err(_) => self.store.get(key).await.ok_or(ResolveError::Offline),
        }
    }

    /// GC: drop any stored entry the manifest no longer references (an old
    /// render-version's orphan). PRESERVES [`URL_KEY_PREFIX`] entries — those are
    /// the url-keyed metadata cache ([`fetch_keyed`](Self::fetch_keyed)), not
    /// manifest content, so they're never orphans. Returns the count removed.
    pub async fn gc(&self, m: &Manifest) -> usize {
        let keep: std::collections::HashSet<&str> =
            m.resources.iter().map(|r| r.hash.as_str()).collect();
        let mut removed = 0;
        for key in self.store.keys().await {
            if key.starts_with(URL_KEY_PREFIX) || keep.contains(key.as_str()) {
                continue;
            }
            self.store.remove(&key).await;
            removed += 1;
        }
        removed
    }

    /// Borrow the underlying store (platform code may need direct access).
    pub fn store(&self) -> &S {
        &self.store
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory store for tests. `Mutex` (not `RefCell`) so the mock is `Sync` —
    /// the `BlobStore` futures must be `Send` (native-only trait).
    #[derive(Default)]
    struct MemStore(Mutex<HashMap<String, Vec<u8>>>);
    #[async_trait]
    impl BlobStore for MemStore {
        async fn get(&self, h: &str) -> Option<Vec<u8>> {
            self.0.lock().unwrap().get(h).cloned()
        }
        async fn put(&self, h: &str, d: &[u8]) {
            self.0.lock().unwrap().insert(h.into(), d.to_vec());
        }
        async fn has(&self, h: &str) -> bool {
            self.0.lock().unwrap().contains_key(h)
        }
        async fn keys(&self) -> Vec<String> {
            self.0.lock().unwrap().keys().cloned().collect()
        }
        async fn remove(&self, h: &str) {
            self.0.lock().unwrap().remove(h);
        }
    }

    /// Fetcher backed by a fixed url→bytes map; `online` gates it (offline = all
    /// fetches fail), so a test can flip connectivity.
    struct MapFetcher {
        online: Mutex<bool>,
        data: HashMap<String, Vec<u8>>,
    }
    #[async_trait]
    impl Fetcher for MapFetcher {
        async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
            if !*self.online.lock().unwrap() {
                return Err("offline".into());
            }
            self.data.get(url).cloned().ok_or_else(|| "404".into())
        }
    }

    fn res(path: &str, body: &[u8], url: &str) -> Resource {
        Resource {
            path: path.into(),
            hash: blake3::hash(body).to_hex().to_string(),
            kind: "text".into(),
            bytes: body.len() as u64,
            url: url.into(),
        }
    }

    #[test]
    fn resolve_caches_then_serves_offline() {
        pollster::block_on(async {
            let body = b"hello chapter";
            let r = res("b/01.md", body, "/api/blob/x");
            let mut data = HashMap::new();
            data.insert("/api/blob/x".to_string(), body.to_vec());
            let fetcher = MapFetcher {
                online: Mutex::new(true),
                data,
            };
            let eng = Engine::new(MemStore::default(), fetcher);

            // First resolve: fetched + cached.
            assert_eq!(eng.resolve(&r).await.unwrap(), body);
            assert!(eng.store().has(&r.hash).await);

            // Go offline → still served from the store.
            *eng.fetcher.online.lock().unwrap() = false;
            assert_eq!(eng.resolve(&r).await.unwrap(), body);
        });
    }

    #[test]
    fn offline_when_uncached_and_no_network() {
        pollster::block_on(async {
            let r = res("b/02.md", b"x", "/api/blob/y");
            let fetcher = MapFetcher {
                online: Mutex::new(false),
                data: HashMap::new(),
            };
            let eng = Engine::new(MemStore::default(), fetcher);
            assert_eq!(eng.resolve(&r).await, Err(ResolveError::Offline));
        });
    }

    #[test]
    fn fetch_keyed_network_first_then_offline_fallback() {
        pollster::block_on(async {
            let url = "/api/tree?rendition=text";
            let key = format!("{URL_KEY_PREFIX}{}", hash_hex(url.as_bytes()));
            let mut data = HashMap::new();
            data.insert(url.to_string(), b"[tree json]".to_vec());
            let fetcher = MapFetcher {
                online: Mutex::new(true),
                data,
            };
            let eng = Engine::new(MemStore::default(), fetcher);

            // Online: fetched fresh + cached under the url key.
            assert_eq!(eng.fetch_keyed(&key, url).await.unwrap(), b"[tree json]");
            assert!(eng.store().has(&key).await);
            // Offline: falls back to the cached copy (no hang, no error).
            *eng.fetcher.online.lock().unwrap() = false;
            assert_eq!(eng.fetch_keyed(&key, url).await.unwrap(), b"[tree json]");
            // gc must PRESERVE the url-keyed entry (it isn't a manifest orphan).
            let empty = Manifest::default();
            assert_eq!(eng.gc(&empty).await, 0);
            assert!(eng.store().has(&key).await);
            // An uncached url offline → Offline.
            assert_eq!(
                eng.fetch_keyed("url:missing", "/api/tree?x").await,
                Err(ResolveError::Offline),
            );
        });
    }

    #[test]
    fn byte_weighted_offline_fraction() {
        pollster::block_on(async {
            // One tiny text (10B) + one big "audio" (990B): caching only the text
            // must read ~1%, not 50% — the whole point of byte-weighting.
            let text = res("b/t.md", &[b't'; 10], "/api/blob/t");
            let mut audio = res("b/a.mp3", &[b'a'; 990], "/api/blob/a");
            audio.kind = "audio".into();
            let m = Manifest {
                root: "r".into(),
                resources: vec![text.clone(), audio],
                ..Manifest::default()
            };

            let mut data = HashMap::new();
            data.insert("/api/blob/t".to_string(), vec![b't'; 10]);
            let fetcher = MapFetcher {
                online: Mutex::new(true),
                data,
            };
            let eng = Engine::new(MemStore::default(), fetcher);

            eng.resolve(&text).await.unwrap(); // cache only the small text
            let pct = eng.offline_fraction(&m).await;
            assert!((pct - 0.01).abs() < 1e-9, "got {pct}");
        });
    }

    #[test]
    fn gc_drops_orphans() {
        pollster::block_on(async {
            let eng = Engine::new(
                MemStore::default(),
                MapFetcher {
                    online: Mutex::new(true),
                    data: HashMap::new(),
                },
            );
            eng.store().put("keep", b"1").await;
            eng.store().put("orphan", b"2").await;
            let m = Manifest {
                root: "r".into(),
                resources: vec![Resource {
                    path: "p".into(),
                    hash: "keep".into(),
                    kind: "text".into(),
                    bytes: 1,
                    url: "u".into(),
                }],
                ..Manifest::default()
            };
            assert_eq!(eng.gc(&m).await, 1);
            assert!(eng.store().has("keep").await);
            assert!(!eng.store().has("orphan").await);
        });
    }

    #[test]
    fn integrity_rejects_tampered_bytes() {
        pollster::block_on(async {
            let r = res("b/03.md", b"real", "/api/blob/z");
            let mut data = HashMap::new();
            data.insert("/api/blob/z".to_string(), b"TAMPERED".to_vec());
            let fetcher = MapFetcher {
                online: Mutex::new(true),
                data,
            };
            let eng = Engine::new(MemStore::default(), fetcher);
            assert_eq!(eng.resolve(&r).await, Err(ResolveError::Integrity));
        });
    }

    #[test]
    fn manifest_protocol_defaults_legacy_and_rejects_future() {
        let legacy = Manifest::from_json(r#"{"root":"r","resources":[]}"#).unwrap();
        assert_eq!(legacy.protocol_version, MANIFEST_PROTOCOL_VERSION);

        let future = format!(
            r#"{{"protocol_version":{},"root":"r","resources":[]}}"#,
            MANIFEST_PROTOCOL_VERSION + 1
        );
        assert!(
            Manifest::from_json(&future)
                .unwrap_err()
                .contains("newer than supported")
        );
    }
}
