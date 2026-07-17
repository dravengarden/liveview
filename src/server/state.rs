use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock, broadcast};

use crate::server::catalog::Catalog;
use crate::store::content::{BlobStore, ContentStore};

#[derive(Clone)]
pub struct CachedJson {
    pub root: String,
    pub body: axum::body::Bytes,
}

/// APM ingest sink: forwards batched client events (POST /api/ingest) to the host
/// VictoriaLogs as jsonline, where they're queried/debugged with LogsQL. `None`
/// when no VL is configured (e.g. `liveview preview`) — /api/ingest then no-ops.
#[derive(Clone)]
pub struct ApmSink {
    pub client: reqwest::Client,
    /// Full VictoriaLogs `/insert/jsonline` URL, incl. `_msg`/`_time`/`_stream`
    /// query params.
    pub vl_url: String,
    /// Shared secret the client must present as `Authorization: Bearer <token>`.
    /// `None` = auth disabled (dev/local): the endpoint accepts unauthenticated.
    pub token: Option<String>,
}

/// Server state for the reader, abstracted over its content backend: postgres +
/// rustfs (deployed) or the filesystem (`liveview preview`). The in-memory
/// catalog (books → renditions → editions) is reloaded after each `liveview
/// sync` via pg LISTEN/NOTIFY (deployed) or built once at startup (preview).
pub struct AppState {
    /// Live-reload broadcast (a serialized `WsMessage` per send).
    pub tx: broadcast::Sender<String>,
    pub store: Arc<dyn ContentStore>,
    pub obj: Arc<dyn BlobStore>,
    pub catalog: RwLock<Catalog>,
    /// Whole-corpus responses are immutable for a deploy root but expensive to
    /// rebuild. Cache their serialized bytes and replace them lazily when the
    /// content store reports a new root.
    pub dag_cache: Mutex<Option<CachedJson>>,
    pub sizes_cache: Mutex<Option<CachedJson>>,
    /// edge-tts executable + default voice for on-demand (lazy) audio synthesis
    /// when the backfill hasn't pre-generated a chapter yet.
    pub tts_cmd: String,
    pub tts_voice: String,
    /// Cache of the synthesized "end of the whole book" cue, keyed by
    /// `"{voice}|{phrase}"`. Appended to the last chapter's audio when the client
    /// requests `&tail=bookend`, so the spoken "全书完" plays through the same
    /// MediaSession `<audio>` element — i.e. on the lock screen / in the
    /// background, where a client-side Web Audio cue would be silent. In-memory
    /// only: regenerated cheaply (one short edge-tts call per voice) on the first
    /// book-end play after a restart.
    pub book_end_cue: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    /// Per-chapter single-flight locks for on-demand TEXT read-aloud synth, keyed
    /// by `"{book}|{rendition}|{lang}|{path}"`. A double-tap or a second client
    /// then waits on the same lock and finds the just-cached audio instead of
    /// re-running the expensive edge-tts (+ narration) synth. In-memory; entries
    /// are tiny and bounded by chapters ever read aloud. (The audiobook path keeps
    /// its own simpler lazy fallback — untouched.)
    pub audio_synth_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// APM ingest forwarder (client events → VictoriaLogs). `None` in preview.
    pub apm: Option<ApmSink>,
}

pub type SharedState = std::sync::Arc<AppState>;
