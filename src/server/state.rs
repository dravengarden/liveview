use globset::GlobSet;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::shared::TreeNode;

pub struct AppState {
    pub tx: broadcast::Sender<String>,
    pub canonical_root: PathBuf,
    pub include_set: GlobSet,
    pub exclude_set: GlobSet,
    pub file_tree: RwLock<Vec<TreeNode>>,
    pub rendered_cache: RwLock<HashMap<String, String>>,
}

pub type SharedState = Arc<AppState>;
