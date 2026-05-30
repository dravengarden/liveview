use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::event::{AccessKind, AccessMode};
use notify_debouncer_full::notify::{EventKind, RecursiveMode};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::server::renderer::render_file;
use crate::server::state::{cache_key, SharedState};
use crate::server::tree::build_virtual_tree;
use crate::shared::{FileType, WsMessage};

#[derive(Debug)]
enum FileEvent {
    ContentChanged {
        book_idx: usize,
        rendition_idx: usize,
        edition_idx: usize,
        path: PathBuf,
    },
    StructureChanged,
}

pub fn start_watcher(state: SharedState, debounce_ms: u64) {
    let (tx, rx) = mpsc::channel::<FileEvent>(256);
    for (book_idx, book) in state.books.iter().enumerate() {
        for (rendition_idx, rendition) in book.renditions.iter().enumerate() {
            for edition_idx in 0..rendition.editions.len() {
                spawn_notify_thread(
                    state.clone(),
                    book_idx,
                    rendition_idx,
                    edition_idx,
                    tx.clone(),
                    debounce_ms,
                );
            }
        }
    }
    tokio::spawn(process_events(state, rx));
}

fn spawn_notify_thread(
    state: SharedState,
    book_idx: usize,
    rendition_idx: usize,
    edition_idx: usize,
    tx: mpsc::Sender<FileEvent>,
    debounce_ms: u64,
) {
    let edition = state.books[book_idx].renditions[rendition_idx].editions[edition_idx].clone();
    let source = edition.source.clone();
    let include_set = edition.include_set.clone();
    let exclude_set = edition.exclude_set.clone();

    std::thread::spawn(move || {
        let source_for_thread = source.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(debounce_ms),
            None,
            move |res: notify_debouncer_full::DebounceEventResult| {
                let Ok(events) = res else { return };

                let mut structure_changed = false;

                for event in events {
                    // Ignore ACCESS events (opens / reads / read-closes). Our own
                    // tree scans and file reads OPEN the watched paths, and the
                    // recursive inotify watch reports those opens — reacting to
                    // them re-triggers the scan forever (the CPU runaway). They are
                    // never a real change. A *write*-close still counts (an editor
                    // saving), so keep Close(Write); everything non-Access
                    // (create/modify/remove/rename) passes through.
                    if matches!(event.kind, EventKind::Access(a)
                        if !matches!(a, AccessKind::Close(AccessMode::Write)))
                    {
                        continue;
                    }

                    for path in &event.paths {
                        let rel_path = path.strip_prefix(&source).unwrap_or(path);

                        if exclude_set.is_match(rel_path) {
                            continue;
                        }

                        if path.is_file() && include_set.is_match(rel_path) {
                            let _ = tx.blocking_send(FileEvent::ContentChanged {
                                book_idx,
                                rendition_idx,
                                edition_idx,
                                path: path.clone(),
                            });
                        } else {
                            structure_changed = true;
                        }
                    }
                }

                if structure_changed {
                    let _ = tx.blocking_send(FileEvent::StructureChanged);
                }
            },
        )
        .expect("Failed to create file watcher");

        debouncer
            .watch(&source_for_thread, RecursiveMode::Recursive)
            .expect("Failed to start watching");

        // Keep thread alive — dropping the debouncer stops the watch.
        loop {
            std::thread::park();
        }
    });
}

async fn process_events(state: SharedState, mut rx: mpsc::Receiver<FileEvent>) {
    // Self-trigger guard. Rebuilding the tree / re-rendering a file OPENS the
    // watched paths, and our recursive inotify watch reports opens (IN_OPEN) —
    // so the work's own filesystem scan re-triggers the same work, forever, at
    // the debounce rate (a CPU runaway that pegs the server). Break the loop by
    // ignoring repeat work on the same target within a short window, with the
    // window starting AFTER the work finishes — so the burst of open-events the
    // scan itself produces lands inside the window and is dropped. A genuine
    // external edit after the window still reloads; live-reload just can't fire
    // more than once per window per target.
    const SELF_TRIGGER_GUARD: Duration = Duration::from_secs(3);
    let mut last_structure: Option<Instant> = None;
    let mut last_content: HashMap<PathBuf, Instant> = HashMap::new();

    while let Some(event) = rx.recv().await {
        match event {
            FileEvent::ContentChanged {
                book_idx,
                rendition_idx,
                edition_idx,
                path,
            } => {
                if last_content
                    .get(&path)
                    .is_some_and(|t| t.elapsed() < SELF_TRIGGER_GUARD)
                {
                    continue;
                }
                handle_content_change(&state, book_idx, rendition_idx, edition_idx, &path).await;
                last_content.insert(path, Instant::now());
            }
            FileEvent::StructureChanged => {
                if last_structure.is_some_and(|t| t.elapsed() < SELF_TRIGGER_GUARD) {
                    continue;
                }
                handle_structure_change(&state).await;
                last_structure = Some(Instant::now());
            }
        }
    }
}

async fn handle_content_change(
    state: &SharedState,
    book_idx: usize,
    rendition_idx: usize,
    edition_idx: usize,
    path: &PathBuf,
) {
    let Some(book) = state.books.get(book_idx) else {
        return;
    };
    let Some(rendition) = book.renditions.get(rendition_idx) else {
        return;
    };
    let Some(edition) = rendition.editions.get(edition_idx) else {
        return;
    };
    let rel = path
        .strip_prefix(&edition.source)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let virtual_path = if rel.is_empty() {
        book.slug.clone()
    } else {
        format!("{}/{}", book.slug, rel)
    };
    let lang = edition.lang.clone();

    let file_type = FileType::from_path(&virtual_path);

    // Binary files: notify only; frontend will refetch via /api/raw.
    if matches!(file_type, FileType::Image | FileType::Pdf) {
        let msg = WsMessage::ContentUpdate {
            path: virtual_path,
            lang,
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
        cache.insert(cache_key(&lang, &virtual_path), content.clone());
    }

    let msg = WsMessage::ContentUpdate {
        path: virtual_path,
        lang,
        file_type,
        content,
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = state.tx.send(json);
    }
}

async fn handle_structure_change(state: &SharedState) {
    let books = state.books.clone();
    // The cached `file_tree` + the `TreeUpdate` broadcast mirror `/api/tree`'s
    // default (text) rendition; other renditions' trees are fetched on demand.
    let new_tree = tokio::task::spawn_blocking(move || {
        build_virtual_tree(&books, crate::config::RenditionKind::Text)
    })
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
