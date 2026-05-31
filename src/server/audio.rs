//! Lazy edge-tts narration.
//!
//! On first play of a chapter we synthesize its speakable sentences (from
//! [`crate::server::spoken`]) one at a time via the `edge-tts` CLI, concatenate
//! the per-sentence MP3s, and write `<aid>.mp3` plus a `<aid>.marks.json` of
//! per-sentence time ranges into a writable **cache directory**. Later plays
//! serve straight from that cache. Audio + marks + the read-along `data-sent`
//! spans all derive from the one sentence list, so they align by construction.
//!
//! Cache location: the `.spoken.md` scripts are read-only *source* (they may
//! live on a tree the service can only read — e.g. a git checkout pinned
//! read-only by the systemd sandbox), so the derived mp3/marks are NOT written
//! beside the script. The caller passes a writable `cache_dir` (under the
//! service's state dir); only when no state dir is configured does it fall back
//! to writing beside the script (ad-hoc local runs on a writable tree).
//!
//! Invalidation: a cached chapter is reused only when its mp3/marks are at
//! least as new as the source `.spoken.md`. Re-narrating a chapter (touching
//! the script) makes the next play re-synthesize, so edited scripts never serve
//! stale audio.
//!
//! Timing: edge-tts emits CBR mono MP3 at 48 kbit/s, so a sentence clip's
//! duration ≈ `bytes * 8 / 48000`. That estimate is good enough to drive
//! sentence-level highlight (we don't need sub-sentence precision).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

/// edge-tts default output is `audio-24khz-48kbitrate-mono-mp3`.
const EDGE_TTS_BITRATE_BPS: u64 = 48_000;

/// Per-sentence time range into the concatenated chapter audio.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Mark {
    /// Matches the sentence index in `/api/spoken` and the `data-sent` anchor.
    pub idx: usize,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// `(mp3, marks.json)` cache paths for a chapter stem, under `cache_dir`. The
/// caller decides `cache_dir`: the writable per-book/lang cache subtree under
/// the state dir, or — as a fallback when no state dir is configured — the
/// audio edition source itself (mp3 + marks beside the `<aid>.spoken.md`).
pub fn audio_paths(cache_dir: &Path, stem: &str) -> (PathBuf, PathBuf) {
    (
        cache_dir.join(format!("{stem}.mp3")),
        cache_dir.join(format!("{stem}.marks.json")),
    )
}

/// A cache file is fresh iff it exists and is no older than the source script.
/// With no known source mtime we treat any existing cache as fresh (the old
/// existence-only behavior).
fn cache_fresh(path: &Path, src_mtime: Option<std::time::SystemTime>) -> bool {
    let Some(src) = src_mtime else {
        return path.is_file();
    };
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|m| m >= src)
        .unwrap_or(false)
}

fn estimate_ms(bytes: usize) -> u64 {
    (bytes as u64) * 8 * 1000 / EDGE_TTS_BITRATE_BPS
}

/// Build the concatenated audio + marks from per-sentence MP3 byte blobs.
/// Pure given the synthesized bytes — unit-tested without invoking edge-tts.
fn assemble(clips: &[Vec<u8>]) -> (Vec<u8>, Vec<Mark>) {
    let mut audio = Vec::new();
    let mut marks = Vec::with_capacity(clips.len());
    let mut cursor = 0;
    for (idx, clip) in clips.iter().enumerate() {
        let dur = estimate_ms(clip.len());
        marks.push(Mark {
            idx,
            start_ms: cursor,
            end_ms: cursor + dur,
        });
        cursor += dur;
        audio.extend_from_slice(clip);
    }
    (audio, marks)
}

/// Synthesize one sentence to MP3 bytes via the `edge-tts` CLI (one attempt).
async fn try_synth_once(cmd: &str, voice: &str, text: &str) -> Result<Vec<u8>, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("lv-tts-{}-{n}.mp3", std::process::id()));

    let out = tokio::process::Command::new(cmd)
        .args(["--voice", voice, "--text", text, "--write-media"])
        .arg(&tmp)
        .output()
        .await
        .map_err(|e| format!("spawn {cmd}: {e}"))?;
    if !out.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!(
            "{cmd} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let bytes = tokio::fs::read(&tmp)
        .await
        .map_err(|e| format!("read tts output {}: {e}", tmp.display()))?;
    let _ = tokio::fs::remove_file(&tmp).await;
    Ok(bytes)
}

const SYNTH_ATTEMPTS: u32 = 3;

/// Synthesize one sentence, resilient to two failure modes:
/// - **unspeakable text** (a lone `…` / `」` segmented out as its own sentence)
///   makes edge-tts raise `NoAudioReceived` — emit a zero-length clip so the
///   chapter still synthesizes and sentence indices stay aligned with the marks;
/// - **transient network drops** — retry a few times before giving up.
async fn synth_sentence(cmd: &str, voice: &str, text: &str) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for _ in 0..SYNTH_ATTEMPTS {
        match try_synth_once(cmd, voice, text).await {
            Ok(bytes) if !bytes.is_empty() => return Ok(bytes),
            Ok(_) => last = "empty audio".to_owned(),
            // No audio for this text → it has nothing speakable; skip it.
            Err(e) if e.contains("NoAudioReceived") => {
                tracing::warn!(text, "tts: no audio for sentence; emitting silence");
                return Ok(Vec::new());
            }
            Err(e) => last = e,
        }
    }
    Err(format!(
        "tts failed after {SYNTH_ATTEMPTS} attempts: {last}"
    ))
}

/// Ensure `<stem>.mp3` + `<stem>.marks.json` exist under `cache_dir`,
/// synthesizing them from `sentences` if absent or stale. `src_mtime` is the
/// source `.spoken.md`'s modified time (when known): a cached chapter is reused
/// only when both files are at least that new, so re-narration re-synthesizes.
/// Returns the cache paths. Idempotent: a fresh fully-cached chapter does no
/// synthesis.
pub async fn ensure_audio(
    cache_dir: &Path,
    stem: &str,
    sentences: &[String],
    voice: &str,
    cmd: &str,
    src_mtime: Option<std::time::SystemTime>,
) -> Result<(PathBuf, PathBuf), String> {
    let (mp3, marks) = audio_paths(cache_dir, stem);
    if cache_fresh(&mp3, src_mtime) && cache_fresh(&marks, src_mtime) {
        return Ok((mp3, marks));
    }
    if sentences.is_empty() {
        return Err("no speakable sentences".to_owned());
    }
    if let Some(dir) = mp3.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("create audio dir {}: {e}", dir.display()))?;
    }

    let mut clips = Vec::with_capacity(sentences.len());
    for text in sentences {
        clips.push(synth_sentence(cmd, voice, text).await?);
    }
    let (audio, marklist) = assemble(&clips);

    tokio::fs::write(&mp3, &audio)
        .await
        .map_err(|e| format!("write {}: {e}", mp3.display()))?;
    let json = serde_json::to_vec(&marklist).map_err(|e| format!("encode marks: {e}"))?;
    tokio::fs::write(&marks, json)
        .await
        .map_err(|e| format!("write {}: {e}", marks.display()))?;
    Ok((mp3, marks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assemble_concatenates_and_times_in_order() {
        // 6000 bytes @ 48 kbit/s = 1000 ms; 3000 bytes = 500 ms.
        let clips = vec![vec![0u8; 6000], vec![1u8; 3000]];
        let (audio, marks) = assemble(&clips);
        assert_eq!(audio.len(), 9000);
        assert_eq!(
            marks,
            [
                Mark {
                    idx: 0,
                    start_ms: 0,
                    end_ms: 1000
                },
                Mark {
                    idx: 1,
                    start_ms: 1000,
                    end_ms: 1500
                },
            ]
        );
    }

    #[test]
    fn audio_paths_join_stem_onto_cache_dir() {
        // mp3 + marks are siblings under whatever cache dir the caller passes —
        // the per-book/lang subtree under the state dir, or the edition source
        // as the no-state-dir fallback.
        let (mp3, marks) = audio_paths(Path::new("/var/lib/liveview/audio/eth/zh"), "05-evm");
        assert_eq!(mp3, Path::new("/var/lib/liveview/audio/eth/zh/05-evm.mp3"));
        assert_eq!(
            marks,
            Path::new("/var/lib/liveview/audio/eth/zh/05-evm.marks.json")
        );
    }

    #[test]
    fn cache_fresh_requires_existence_and_not_stale() {
        // Missing file is never fresh, regardless of mtime knowledge.
        assert!(!cache_fresh(Path::new("/no/such/file.mp3"), None));
        assert!(!cache_fresh(
            Path::new("/no/such/file.mp3"),
            Some(std::time::SystemTime::UNIX_EPOCH)
        ));
    }
}
