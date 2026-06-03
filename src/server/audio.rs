//! edge-tts narration synthesis (deploy-time).
//!
//! `liveview sync` synthesizes a chapter's speakable sentences (from
//! [`crate::server::spoken`]) one at a time via the `edge-tts` CLI, concatenates
//! the per-sentence MP3s, and pairs them with a `marks` list of per-sentence
//! time ranges. Audio + marks + the read-along `data-sent` spans all derive
//! from the one sentence list, so they align by construction. The bytes are
//! stored as content-addressed assets in rustfs; the server only reads them.
//!
//! Timing: edge-tts emits CBR mono MP3 at 48 kbit/s, so a sentence clip's
//! duration ≈ `bytes * 8 / 48000` — good enough for sentence-level highlight.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
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

/// A single sentence's synth must not hang the whole chapter: edge-tts can stall
/// on the Microsoft websocket (waiting for audio that never arrives) WITHOUT
/// erroring, so cap each attempt and kill the child if it overruns.
const SYNTH_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);

/// Synthesize one sentence to MP3 bytes via the `edge-tts` CLI (one attempt).
async fn try_synth_once(cmd: &str, voice: &str, text: &str) -> Result<Vec<u8>, String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("lv-tts-{}-{n}.mp3", std::process::id()));

    let run = tokio::process::Command::new(cmd)
        .args(["--voice", voice, "--text", text, "--write-media"])
        .arg(&tmp)
        // Kill the child when the future drops (i.e. on timeout), so a stalled
        // edge-tts doesn't linger.
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(SYNTH_ATTEMPT_TIMEOUT, run).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("spawn {cmd}: {e}"));
        }
        Err(_) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("{cmd} timed out after {SYNTH_ATTEMPT_TIMEOUT:?}"));
        }
    };
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
    // Persistent failure (a stalled/unspeakable sentence, or a flaky network):
    // emit silence rather than fail the WHOLE chapter on one sentence — the marks
    // stay aligned and the chapter is still playable, the lost sentence just a
    // brief silent gap. Infinite hangs are bounded by the per-attempt timeout.
    tracing::warn!(text, error = %last, "tts: giving up on sentence after retries; emitting silence");
    Ok(Vec::new())
}

/// Synthesize `sentences` into a concatenated MP3 + sentence marks, in memory —
/// no file IO. The deploy-time (`liveview sync`) path: the bytes go straight to
/// rustfs as content-addressed assets.
pub(crate) async fn synthesize(
    cmd: &str,
    voice: &str,
    sentences: &[String],
) -> Result<(Vec<u8>, Vec<Mark>), String> {
    if sentences.is_empty() {
        return Err("no speakable sentences".to_owned());
    }
    // Sequential synth of a 200+-sentence chapter runs for minutes; buffered(N)
    // overlaps the edge-tts round-trips while preserving sentence order.
    const SYNTH_CONCURRENCY: usize = 6;
    let clips: Vec<Vec<u8>> = futures_util::stream::iter(sentences.iter().cloned())
        .map(|text| async move { synth_sentence(cmd, voice, &text).await })
        .buffered(SYNTH_CONCURRENCY)
        .collect::<Vec<Result<Vec<u8>, String>>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, String>>()?;
    Ok(assemble(&clips))
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

}
