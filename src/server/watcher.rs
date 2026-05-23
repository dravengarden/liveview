use notify_debouncer_mini::new_debouncer;
use notify_debouncer_mini::notify::RecursiveMode;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::server::renderer::render_file;
use crate::server::state::SharedState;
use crate::server::tree::build_virtual_tree;
use crate::shared::{FileType, WsMessage};

#[derive(Debug)]
enum FileEvent {
    ContentChanged { mount_idx: usize, path: PathBuf },
    StructureChanged,
}

pub fn start_watcher(state: SharedState, debounce_ms: u64) {
    let (tx, rx) = mpsc::channel::<FileEvent>(256);
    for idx in 0..state.mounts.len() {
        spawn_notify_thread(state.clone(), idx, tx.clone(), debounce_ms);
    }
    tokio::spawn(process_events(state, rx));
}

fn spawn_notify_thread(
    state: SharedState,
    mount_idx: usize,
    tx: mpsc::Sender<FileEvent>,
    debounce_ms: u64,
) {
    let mount = state.mounts[mount_idx].clone();
    let source = mount.source.clone();
    let include_set = mount.include_set.clone();
    let exclude_set = mount.exclude_set.clone();

    std::thread::spawn(move || {
        let source_for_thread = source.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(debounce_ms),
            move |res: Result<
                Vec<notify_debouncer_mini::DebouncedEvent>,
                notify_debouncer_mini::notify::Error,
            >| {
                let Ok(events) = res else { return };

                let mut structure_changed = false;

                for event in events {
                    let path = &event.path;
                    let rel_path = path.strip_prefix(&source).unwrap_or(path);

                    if exclude_set.is_match(rel_path) {
                        continue;
                    }

                    if path.is_file() && include_set.is_match(rel_path) {
                        let _ = tx.blocking_send(FileEvent::ContentChanged {
                            mount_idx,
                            path: path.clone(),
                        });
                    } else {
                        structure_changed = true;
                    }
                }

                if structure_changed {
                    let _ = tx.blocking_send(FileEvent::StructureChanged);
                }
            },
        )
        .expect("Failed to create file watcher");

        debouncer
            .watcher()
            .watch(&source_for_thread, RecursiveMode::Recursive)
            .expect("Failed to start watching");

        // Keep thread alive — dropping the debouncer stops the watch.
        loop {
            std::thread::park();
        }
    });
}

async fn process_events(state: SharedState, mut rx: mpsc::Receiver<FileEvent>) {
    while let Some(event) = rx.recv().await {
        match event {
            FileEvent::ContentChanged { mount_idx, path } => {
                handle_content_change(&state, mount_idx, &path).await;
            }
            FileEvent::StructureChanged => {
                handle_structure_change(&state).await;
            }
        }
    }
}

async fn handle_content_change(state: &SharedState, mount_idx: usize, path: &PathBuf) {
    let mount = match state.mounts.get(mount_idx) {
        Some(m) => m,
        None => return,
    };
    let rel = path
        .strip_prefix(&mount.source)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let virtual_path = if rel.is_empty() {
        mount.slug.clone()
    } else {
        format!("{}/{}", mount.slug, rel)
    };

    let file_type = FileType::from_path(&virtual_path);

    // Binary files: notify only; frontend will refetch via /api/raw.
    if matches!(file_type, FileType::Image | FileType::Pdf) {
        let msg = WsMessage::ContentUpdate {
            path: virtual_path,
            file_type,
            content: String::new(),
        };
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = state.tx.send(json);
        }
        return;
    }

    let Ok(source) = tokio::fs::read_to_string(path).await else {
        return;
    };

    let content = render_file(&source, &file_type);

    {
        let mut cache = state.rendered_cache.write().await;
        cache.insert(virtual_path.clone(), content.clone());
    }

    let msg = WsMessage::ContentUpdate {
        path: virtual_path,
        file_type,
        content,
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = state.tx.send(json);
    }
}

async fn handle_structure_change(state: &SharedState) {
    let mounts = state.mounts.clone();
    let new_tree = tokio::task::spawn_blocking(move || build_virtual_tree(&mounts))
        .await
        .unwrap_or_default();

    {
        let mut tree = state.file_tree.write().await;
        *tree = new_tree.clone();
    }

    let msg = WsMessage::TreeUpdate { tree: new_tree };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = state.tx.send(json);
    }
}
