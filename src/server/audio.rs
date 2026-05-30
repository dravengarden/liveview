//! Lazy edge-tts narration.
//!
//! On first play of a chapter we synthesize its speakable sentences (from
//! [`crate::server::spoken`]) one at a time via the `edge-tts` CLI, concatenate
//! the per-sentence MP3s, and write `<lang>/audio/<stem>.mp3` plus a
//! `<stem>.marks.json` of per-sentence time ranges. Later plays serve straight
//! from that cache. Audio + marks + the read-along `data-sent` spans all derive
//! from the one sentence list, so they align by construction.
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

/// `(mp3, marks.json)` cache paths for a chapter stem under an edition source.
pub fn audio_paths(edition_source: &Path, stem: &str) -> (PathBuf, PathBuf) {
    let dir = edition_source.join("audio");
    (
        dir.join(format!("{stem}.mp3")),
        dir.join(format!("{stem}.marks.json")),
    )
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

/// Ensure `<stem>.mp3` + `<stem>.marks.json` exist under the edition's
/// `audio/` dir, synthesizing them from `sentences` if absent. Returns the
/// cache paths. Idempotent: a fully-cached chapter does no synthesis.
pub async fn ensure_audio(
    edition_source: &Path,
    stem: &str,
    sentences: &[String],
    voice: &str,
    cmd: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let (mp3, marks) = audio_paths(edition_source, stem);
    if mp3.is_file() && marks.is_file() {
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
    fn audio_paths_live_under_audio_dir() {
        let (mp3, marks) = audio_paths(Path::new("/books/eth/zh"), "05-evm");
        assert_eq!(mp3, Path::new("/books/eth/zh/audio/05-evm.mp3"));
        assert_eq!(marks, Path::new("/books/eth/zh/audio/05-evm.marks.json"));
    }
}
