use notify_debouncer_mini::new_debouncer;
use notify_debouncer_mini::notify::RecursiveMode;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::server::renderer::render_file;
use crate::server::state::SharedState;
use crate::server::tree::build_file_tree;
use crate::shared::{FileType, WsMessage};

#[derive(Debug)]
enum FileEvent {
    ContentChanged(PathBuf),
    StructureChanged,
}

pub fn start_watcher(state: SharedState, debounce_ms: u64) {
    let (tx, rx) = mpsc::channel::<FileEvent>(256);

    spawn_notify_thread(state.clone(), tx, debounce_ms);
    tokio::spawn(process_events(state, rx));
}

fn spawn_notify_thread(state: SharedState, tx: mpsc::Sender<FileEvent>, debounce_ms: u64) {
    let root = state.canonical_root.clone();
    let include_set = state.include_set.clone();
    let exclude_set = state.exclude_set.clone();

    std::thread::spawn(move || {
        let tx_clone = tx.clone();
        let root_clone = root.clone();
        let include_clone = include_set.clone();
        let exclude_clone = exclude_set.clone();

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
                    let rel_path = path.strip_prefix(&root_clone).unwrap_or(path);

                    if exclude_clone.is_match(rel_path) {
                        continue;
                    }

                    if path.is_file() && include_clone.is_match(rel_path) {
                        let _ = tx_clone.blocking_send(FileEvent::ContentChanged(path.clone()));
                    } else {
                        structure_changed = true;
                    }
                }

                if structure_changed {
                    let _ = tx_clone.blocking_send(FileEvent::StructureChanged);
                }
            },
        )
        .expect("Failed to create file watcher");

        debouncer
            .watcher()
            .watch(root.as_path(), RecursiveMode::Recursive)
            .expect("Failed to start watching");

        // Keep thread alive - debouncer must not be dropped
        loop {
            std::thread::park();
        }
    });
}

async fn process_events(state: SharedState, mut rx: mpsc::Receiver<FileEvent>) {
    while let Some(event) = rx.recv().await {
        match event {
            FileEvent::ContentChanged(path) => {
                handle_content_change(&state, &path).await;
            }
            FileEvent::StructureChanged => {
                handle_structure_change(&state).await;
            }
        }
    }
}

async fn handle_content_change(state: &SharedState, path: &PathBuf) {
    let rel_path = path
        .strip_prefix(&state.canonical_root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();

    let file_type = FileType::from_path(&rel_path);

    // For binary files (images, PDFs), just notify - frontend will use raw endpoint
    if matches!(file_type, FileType::Image | FileType::Pdf) {
        let msg = WsMessage::ContentUpdate {
            path: rel_path,
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
        cache.insert(rel_path.clone(), content.clone());
    }

    let msg = WsMessage::ContentUpdate {
        path: rel_path,
        file_type,
        content,
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = state.tx.send(json);
    }
}

async fn handle_structure_change(state: &SharedState) {
    let root = state.canonical_root.clone();
    let include = state.include_set.clone();
    let exclude = state.exclude_set.clone();

    let new_tree = tokio::task::spawn_blocking(move || build_file_tree(&root, &include, &exclude))
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
