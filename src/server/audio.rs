//! edge-tts narration synthesis (deploy-time).
//!
//! `liveview sync` synthesizes a chapter's speakable sentences (from
//! [`crate::server::spoken`]) one at a time via the `edge-tts` CLI, concatenates
//! the per-sentence MP3s, and pairs them with a `marks` list of per-sentence
//! time ranges. Audio + marks + the read-along `data-sent` spans all derive
//! from the one sentence list, so they align by construction. The bytes are
//! stored as content-addressed assets in rustfs; the server only reads them.
//!
//! Timing: a clip's duration is summed from its real MP3 frame headers — the
//! exact timebase the browser decodes against — NOT estimated from byte length.
//! (A byte estimate counts any non-audio bytes — a Xing/Info or ID3 frame
//! edge-tts may prepend, a partial trailing frame — as playable time, so the
//! per-clip error accumulates across a 200-sentence chapter and the read-along
//! highlight drifts ahead of the audio. Frame-summing has zero cumulative drift.)

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;

/// Per-sentence time range into the concatenated chapter audio.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Mark {
    /// Matches the sentence index in `/api/spoken` and the `data-sent` anchor.
    pub idx: usize,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Sum the durations (ms) of every MPEG audio frame in `data`. Returns 0 when no
/// frame sync is found (an empty/silent clip). Walks frame-by-frame using each
/// header's bitrate/samplerate/padding to find the next frame, resyncing one
/// byte at a time past any leading tag or corruption. Layer III — what edge-tts
/// emits (`audio-24khz-48kbitrate-mono-mp3`) — is computed exactly; other layers
/// are skipped (edge-tts never emits them).
fn mp3_duration_ms(data: &[u8]) -> u64 {
    // Sample rate (Hz) by version id [2.5, reserved, 2, 1] × samplerate index.
    const SAMPLE_RATE: [[u32; 3]; 4] = [
        [11_025, 12_000, 8_000],  // MPEG 2.5
        [0, 0, 0],                // reserved
        [22_050, 24_000, 16_000], // MPEG 2
        [44_100, 48_000, 32_000], // MPEG 1
    ];
    // Layer III bitrate (kbit/s) by bitrate index (0 = free, 15 = bad).
    const BITRATE_MPEG1_L3: [u32; 16] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ];
    const BITRATE_MPEG2_L3: [u32; 16] = [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
    ];

    let mut total_us: u64 = 0;
    let mut i = 0;
    while i + 4 <= data.len() {
        // Frame sync = 11 set bits (0xFF then top 3 bits of the next byte).
        if data[i] != 0xFF || (data[i + 1] & 0xE0) != 0xE0 {
            i += 1;
            continue;
        }
        let version = (data[i + 1] >> 3) & 0x03; // 0=2.5 1=reserved 2=2 3=1
        let layer = (data[i + 1] >> 1) & 0x03; // 1=LIII 2=LII 3=LI
        let br_idx = ((data[i + 2] >> 4) & 0x0F) as usize;
        let sr_idx = ((data[i + 2] >> 2) & 0x03) as usize;
        let padding = u32::from((data[i + 2] >> 1) & 0x01);
        // Only Layer III; reject reserved version/samplerate and free/bad bitrate.
        if version == 1 || layer != 1 || sr_idx == 3 || br_idx == 0 || br_idx == 15 {
            i += 1;
            continue;
        }
        let sr = SAMPLE_RATE[version as usize][sr_idx];
        let is_mpeg1 = version == 3;
        let bitrate = 1000
            * if is_mpeg1 {
                BITRATE_MPEG1_L3[br_idx]
            } else {
                BITRATE_MPEG2_L3[br_idx]
            };
        // Layer III samples/frame: 1152 (MPEG 1) or 576 (MPEG 2 / 2.5).
        let samples = if is_mpeg1 { 1152u32 } else { 576u32 };
        // Frame length in bytes: samples/8 × bitrate / samplerate + padding.
        let frame_len = ((samples / 8) * bitrate / sr + padding) as usize;
        if frame_len == 0 {
            i += 1;
            continue;
        }
        total_us += u64::from(samples) * 1_000_000 / u64::from(sr);
        i += frame_len;
    }
    total_us / 1000
}

/// A clip with no audible frames (a lone-punctuation segment edge-tts can't
/// voice → empty bytes) is given this much dwell + matching real silence, so the
/// read-along highlight still visibly steps over that sentence — a zero-width
/// mark can never be the `markIndex` hit — while audio and marks stay in lock.
const MIN_SILENT_DWELL_MS: u64 = 350;
/// One 24 kHz / 48 kbit/s mono Layer III frame = 576/24000 s = 24 ms, matching
/// edge-tts's own output format so inserted silence concatenates seamlessly.
const SILENT_FRAME_MS: u64 = 24;
const SILENT_FRAME_LEN: usize = 144; // 576/8 × 48000 / 24000, no padding

/// `frames` silent MPEG-2 Layer III frames in edge-tts's exact format. A zeroed
/// frame body (side info all zero ⇒ no granules) decodes to silence.
fn silence_mp3(frames: usize) -> Vec<u8> {
    let mut out = vec![0u8; frames * SILENT_FRAME_LEN];
    for f in 0..frames {
        let h = f * SILENT_FRAME_LEN;
        out[h] = 0xFF; // sync
        out[h + 1] = 0xF3; // MPEG 2, Layer III, no CRC
        out[h + 2] = 0x64; // 48 kbit/s, 24 kHz, no padding
        out[h + 3] = 0xC0; // mono
    }
    out
}

/// Build the concatenated audio + marks from per-sentence MP3 byte blobs.
/// Pure given the synthesized bytes — unit-tested without invoking edge-tts.
fn assemble(clips: &[Vec<u8>]) -> (Vec<u8>, Vec<Mark>) {
    let mut audio = Vec::new();
    let mut marks = Vec::with_capacity(clips.len());
    let mut cursor = 0;
    for (idx, clip) in clips.iter().enumerate() {
        let dur = mp3_duration_ms(clip);
        let dur = if dur == 0 {
            // Silent/empty sentence: insert real silence so the audio timeline
            // grows by exactly the mark window (no drift), and the sentence is
            // briefly highlightable instead of being skipped entirely.
            let frames = MIN_SILENT_DWELL_MS.div_ceil(SILENT_FRAME_MS).max(1);
            audio.extend_from_slice(&silence_mp3(frames as usize));
            frames * SILENT_FRAME_MS
        } else {
            audio.extend_from_slice(clip);
            dur
        };
        marks.push(Mark {
            idx,
            start_ms: cursor,
            end_ms: cursor + dur,
        });
        cursor += dur;
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
    // A non-prose unit with no narration (or a lone-punctuation segment) has
    // nothing to voice — emit silence directly instead of a wasted edge-tts
    // round-trip (which would `NoAudioReceived` anyway). `assemble` then gives it
    // a short dwell so the read-along still steps over it.
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
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

    /// `n` real 24 ms edge-tts-format frames (24 kHz / 48 kbit/s mono L3).
    fn frames(n: usize) -> Vec<u8> {
        silence_mp3(n)
    }

    #[test]
    fn mp3_duration_sums_frames_exactly() {
        // Each frame is 24 ms; byte length is irrelevant to the timing.
        assert_eq!(mp3_duration_ms(&frames(1)), 24);
        assert_eq!(mp3_duration_ms(&frames(10)), 240);
        // A leading ID3-ish junk prefix must NOT inflate the duration: the
        // walker resyncs to the first real frame (this is the drift the byte
        // estimate caused).
        let mut padded = vec![0x49, 0x44, 0x33, 0x00, 0x00]; // "ID3"…
        padded.extend_from_slice(&frames(5));
        assert_eq!(mp3_duration_ms(&padded), 120);
        // No sync at all → 0 (treated as silent by `assemble`).
        assert_eq!(mp3_duration_ms(&[0u8; 6000]), 0);
    }

    #[test]
    fn assemble_concatenates_and_times_by_true_duration() {
        // 2 frames = 48 ms, 5 frames = 120 ms.
        let a = frames(2);
        let b = frames(5);
        let (audio, marks) = assemble(&[a.clone(), b.clone()]);
        assert_eq!(audio.len(), a.len() + b.len());
        assert_eq!(
            marks,
            [
                Mark {
                    idx: 0,
                    start_ms: 0,
                    end_ms: 48
                },
                Mark {
                    idx: 1,
                    start_ms: 48,
                    end_ms: 168
                },
            ]
        );
    }

    #[test]
    fn silent_sentence_stays_highlightable_and_in_sync() {
        // An empty clip (edge-tts emitted no audio) must still get a non-zero
        // mark window AND append matching real silence, so the highlight steps
        // over it and the audio timeline grows by exactly the window.
        let (audio, marks) = assemble(&[Vec::new(), frames(3)]);
        assert!(
            marks[0].end_ms > marks[0].start_ms,
            "silent sentence must be highlightable: {marks:?}"
        );
        // The inserted silence decodes to exactly the recorded window.
        assert_eq!(mp3_duration_ms(&audio[..]), marks[1].end_ms);
        // Second sentence starts right where the silence ended (no drift).
        assert_eq!(marks[1].start_ms, marks[0].end_ms);
    }
}
