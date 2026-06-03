use tokio::sync::{broadcast, RwLock};

use crate::server::catalog::Catalog;
use crate::store::pg::PgStore;
use crate::sync::objstore::ObjStore;

/// Server state for the thin reader: the postgres content store, the rustfs
/// object store, and an in-memory catalog (books → renditions → editions)
/// reloaded after each `liveview sync` via pg LISTEN/NOTIFY.
pub struct AppState {
    /// Live-reload broadcast (a serialized `WsMessage` per send).
    pub tx: broadcast::Sender<String>,
    pub store: PgStore,
    pub obj: ObjStore,
    pub catalog: RwLock<Catalog>,
    /// edge-tts executable + default voice for on-demand (lazy) audio synthesis
    /// when the backfill hasn't pre-generated a chapter yet.
    pub tts_cmd: String,
    pub tts_voice: String,
}

pub type SharedState = std::sync::Arc<AppState>;
