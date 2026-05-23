use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::config::MountState;
use crate::shared::TreeNode;

pub struct AppState {
    pub tx: broadcast::Sender<String>,
    /// One entry per `[[mount]]` declared in the config. Always at least one
    /// (the implicit fallback config supplies a single mount over cwd).
    pub mounts: Vec<MountState>,
    pub file_tree: RwLock<Vec<TreeNode>>,
    pub rendered_cache: RwLock<HashMap<String, String>>,
}

pub type SharedState = Arc<AppState>;

pub struct MountResolution<'a> {
    pub mount: &'a MountState,
    pub rest: &'a str,
}

impl AppState {
    /// Resolve a wire-side virtual path (`<slug>` or `<slug>/<rest>`) to its
    /// backing mount + the rest relative to the mount's source. Returns
    /// `None` if no mount claims the slug.
    pub fn resolve_path<'a>(&'a self, virtual_path: &'a str) -> Option<MountResolution<'a>> {
        let (slug, rest) = virtual_path.split_once('/').unwrap_or((virtual_path, ""));
        let mount = self.mounts.iter().find(|m| m.slug == slug)?;
        Some(MountResolution { mount, rest })
    }
}
