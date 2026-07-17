//! Background audio-generation worker — the engine behind the async task queue.
//!
//! Runs INSIDE the live server (not in `liveview sync`, which now only enqueues,
//! and not inline in the HTTP request). A small pool of loops drains
//! `audio_tasks` by priority, synthesizes each chapter's audio from the stored
//! markdown (the same `spoken` + `audio` engines the on-demand fallback uses),
//! stores the mp3 + marks as content-addressed blobs, records them on the
//! chapter, commits the Merkle leaf node (so `liveview sync` prunes the chapter
//! next run — node present ⇔ audio generated), marks the task done, and pushes a
//! `chapter-ready` event to WS clients so the UI flips listenable live.
//!
//! Reuses the concrete `PgStore` + `ObjStore` (the queue + Merkle commit are
//! pg-specific), so it's spawned only on the deployed (postgres) path; the
//! filesystem `preview` backend has no queue and no worker.

use tokio::sync::broadcast;

use crate::server::{audio, narration, speakable, spoken};
use crate::store::pg::{AudioTask, PgStore};
use crate::sync::merkle;
use crate::sync::objstore::ObjStore;

/// Concurrent synth slots. edge-tts is network-bound (Azure), so a few in flight
/// keeps the backfill moving without hammering; one is implicitly reserved for an
/// interactive (priority) task since a tap promotes its row to the queue head.
const SLOTS: usize = 3;
/// Give up on a task after this many failures (then it shows in the Sync sheet
/// as failed, retryable via `liveview tasks retry`).
const MAX_ATTEMPTS: i32 = 4;
/// Poll interval when the queue is empty.
const IDLE_POLL_MS: u64 = 1500;

/// Spawn the worker pool. Re-queues any `running` rows a prior server left behind
/// (crash/restart reaper) before the loops start claiming.
pub fn spawn(pg: PgStore, obj: ObjStore, tts_cmd: String, tx: broadcast::Sender<String>) {
    tokio::spawn(async move {
        match pg.requeue_running_audio_tasks().await {
            Ok(n) if n > 0 => tracing::info!("audio worker: re-queued {n} interrupted task(s)"),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "audio worker: reaper failed"),
        }
        for slot in 0..SLOTS {
            let (pg, obj, tts_cmd, tx) = (pg.clone(), obj.clone(), tts_cmd.clone(), tx.clone());
            tokio::spawn(async move { run_loop(slot, pg, obj, tts_cmd, tx).await });
        }
    });
}

async fn run_loop(
    slot: usize,
    pg: PgStore,
    obj: ObjStore,
    tts_cmd: String,
    tx: broadcast::Sender<String>,
) {
    tracing::debug!(slot, "audio worker slot started");
    loop {
        let claim = pg.claim_audio_task().await;
        match claim {
            Ok(Some(task)) => process(&pg, &obj, &tts_cmd, &tx, task).await,
            // Queue drained — poll. (A NOTIFY-driven wake is a later optimization;
            // a ~1.5s poll is cheap and an interactive tap tolerates it.)
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(IDLE_POLL_MS)).await,
            Err(e) => {
                tracing::warn!(error = %e, "audio worker: claim failed");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}

async fn process(
    pg: &PgStore,
    obj: &ObjStore,
    tts_cmd: &str,
    tx: &broadcast::Sender<String>,
    task: AudioTask,
) {
    match generate(pg, obj, tts_cmd, &task).await {
        Ok(produced) => {
            commit_leaf_node(pg, &task).await;
            if let Err(e) = pg
                .finish_audio_task(&task.book_slug, &task.rendition, &task.lang, &task.rel_path)
                .await
            {
                tracing::warn!(error = %e, "audio worker: finish failed");
            }
            // Tell live clients this chapter is now listenable (only when it
            // actually produced audio — a pure-code chapter is done-but-silent).
            if produced {
                let _ = tx.send(
                    serde_json::json!({
                        "type": "chapter-ready",
                        "book": task.book_slug,
                        "rendition": task.rendition,
                        "lang": task.lang,
                        "path": task.rel_path,
                    })
                    .to_string(),
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                book = %task.book_slug, rel = %task.rel_path, error = %e,
                "audio worker: synth failed"
            );
            let _ = pg
                .fail_audio_task(
                    &task.book_slug,
                    &task.rendition,
                    &task.lang,
                    &task.rel_path,
                    &e,
                    MAX_ATTEMPTS,
                )
                .await;
        }
    }
}

/// Synthesize + store one chapter's audio. `Ok(true)` produced audio; `Ok(false)`
/// means the chapter had nothing speakable (e.g. pure code) — still a success,
/// the task completes silently so it isn't retried forever.
async fn generate(
    pg: &PgStore,
    obj: &ObjStore,
    tts_cmd: &str,
    task: &AudioTask,
) -> Result<bool, String> {
    let Some(row) = pg
        .get_chapter(&task.book_slug, &task.rendition, &task.lang, &task.rel_path)
        .await
        .map_err(|e| e.to_string())?
    else {
        // Chapter deleted out from under the task — nothing to do.
        return Ok(false);
    };
    // Another path (the on-demand fallback) may have just filled it.
    if row.audio_hash.is_some() && row.marks_hash.is_some() {
        return Ok(true);
    }
    let md = row.markdown.unwrap_or_default();

    let (mp3, marks) = if task.rendition == "audio" {
        // Audiobook: the curated `.spoken.md` script, sentence by sentence.
        let sentences = spoken::spoken_sentences(&md);
        if sentences.is_empty() {
            return Ok(false);
        }
        audio::synthesize(tts_cmd, &task.voice, &sentences).await?
    } else {
        // Text read-aloud: one clip per UNIT of the displayed markdown, so the
        // mark index = `/api/units`. Each unit's SPOKEN text is decided by the
        // speech registry (prose normalized for the ear; tables/diagrams/math/
        // code resolved from PRE-GENERATED narration; unhandled / not-yet-narrated
        // → a silent step-over). No model call — the narration was made offline by
        // a skill and ingested into pg by `sync`; we just resolve it by key.
        let units = spoken::spoken_units(&md);
        if units.is_empty() {
            return Ok(false);
        }
        let keys = speakable::narration_keys(&units, &task.lang);
        let store = narration::NarrationStore::from_pairs(
            pg.load_narration(&keys).await.map_err(|e| e.to_string())?,
        );
        let texts: Vec<String> = units
            .iter()
            .map(|u| speakable::unit_speech(u, &task.lang, &store))
            .collect();
        audio::synthesize(tts_cmd, &task.voice, &texts).await?
    };

    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    // CAF is the canonical audio asset: its blake3 is both the database pointer
    // and the exact byte hash clients mirror through /api/dag. The synthesized
    // MP3 exists only as an in-memory encoder input and is never persisted.
    let caf = crate::transcode_audio(mp3).await?;
    let audio_hash = put_blob(pg, obj, caf, crate::AUDIO_VARIANT.mime).await?;
    let marks_hash = put_blob(pg, obj, marks_json, "application/json").await?;
    pg.set_chapter_audio(
        &task.book_slug,
        &task.rendition,
        &task.lang,
        &task.rel_path,
        &audio_hash,
        &marks_hash,
    )
    .await
    .map_err(|e| format!("record audio: {e}"))?;
    Ok(true)
}

/// Commit the Merkle leaf node for this chapter, so the next `liveview sync`
/// prunes it (node present ⇔ audio generated). Best-effort: a missing node just
/// means the next sync re-enqueues an already-done task (a no-op via the
/// idempotent enqueue).
async fn commit_leaf_node(pg: &PgStore, task: &AudioTask) {
    let leaf = merkle::Leaf {
        path: crate::sync::run::leaf_path(
            &task.book_slug,
            &task.rendition,
            &task.lang,
            &task.rel_path,
        ),
        kind: task.leaf_kind.clone(),
        content_hash: task.content_hash.clone(),
    };
    let node_hash = merkle::leaf_hash(&leaf);
    let payload = serde_json::json!({
        "path": leaf.path, "kind": leaf.kind, "content_hash": leaf.content_hash
    })
    .to_string();
    if let Err(e) = pg.put_merkle_node(&node_hash, "leaf", &payload).await {
        tracing::warn!(error = %e, "audio worker: commit leaf node failed");
    }
}

/// Upload bytes content-addressed (skip if present) + record the asset row.
async fn put_blob(
    pg: &PgStore,
    obj: &ObjStore,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<String, String> {
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let size = bytes.len() as i64;
    obj.put_if_absent(&hash, bytes, mime).await?;
    pg.upsert_asset(&hash, mime, size)
        .await
        .map_err(|e| format!("upsert asset {hash}: {e}"))?;
    Ok(hash)
}
