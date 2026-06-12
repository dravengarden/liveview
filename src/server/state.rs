use std::sync::Arc;

use tokio::sync::{broadcast, RwLock};

use crate::server::catalog::Catalog;
use crate::store::content::{BlobStore, ContentStore};

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
    /// edge-tts executable + default voice for on-demand (lazy) audio synthesis
    /// when the backfill hasn't pre-generated a chapter yet.
    pub tts_cmd: String,
    pub tts_voice: String,
}

pub type SharedState = std::sync::Arc<AppState>;
