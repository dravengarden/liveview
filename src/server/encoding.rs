//! The canonical stored audio encoding and the ffmpeg transcodes that produce it.

/// The canonical audio representation. Audiobook narration is mono
/// speech, so a low-bitrate speech codec is near-transparent at a fraction of the
/// source size. CAF is retained because the native offline cache uses that
/// container; MPEG Layer III is used because FFmpeg's CAF muxer does not support
/// Opus or AAC. The tag names the `audio-optimize` migration's derived keys and
/// the optional book-end derivatives.
pub struct AudioVariant {
    pub tag: &'static str,
    pub mime: &'static str,
    ext: &'static str,
    args: &'static [&'static str],
}
pub const AUDIO_VARIANT: AudioVariant = AudioVariant {
    tag: "mp324c",
    mime: "audio/x-caf",
    ext: "caf",
    args: &["-c:a", "libmp3lame", "-b:a", "24k", "-ac", "1"],
};

/// Folded into audio-capable Merkle leaf kinds. Bump whenever the canonical
/// stored/served representation changes, even if source prose is unchanged.
pub const AUDIO_ENCODING_VERSION: &str = "caf-mp324-v1";

/// Transcode an MP3 (`src`) per `AUDIO_VARIANT`. ffmpeg reads stdin and writes a
/// temp file (CAF/MP4 muxers need seekable output), which we read back + delete.
pub async fn transcode_audio(src: Vec<u8>) -> Result<Vec<u8>, String> {
    encode_audio(src, AUDIO_VARIANT.args).await
}

/// Explicit speech recipes retain the source MP3 quality. Their recipe ID
/// distinguishes these assets from the legacy compact-audio representation.
pub async fn encode_speech_audio(src: Vec<u8>, voice: &str) -> Result<Vec<u8>, String> {
    if voice.starts_with("speech-v1:") || voice.starts_with("kokoro:") {
        let recipe = crate::speech::Recipe::decode(voice)?;
        if recipe.voice.starts_with("kokoro:") {
            encode_audio(src, &["-c:a", "copy"]).await
        } else {
            encode_audio(
                src,
                &[
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    &format!("{}k", recipe.bitrate_kbps),
                    "-ar",
                    "24000",
                    "-ac",
                    "1",
                ],
            )
            .await
        }
    } else {
        transcode_audio(src).await
    }
}

async fn encode_audio(src: Vec<u8>, args: &[&str]) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncWriteExt;
    let mut tmp = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    tmp.push(format!(
        "lvtc-{}-{nanos}.{}",
        std::process::id(),
        AUDIO_VARIANT.ext
    ));
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.arg("-v").arg("error").arg("-y").arg("-i").arg("pipe:0");
    for a in args {
        cmd.arg(a);
    }
    cmd.arg(&tmp)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn ffmpeg: {e}"))?;
    let write_error = if let Some(mut stdin) = child.stdin.take() {
        let result = stdin.write_all(&src).await.err();
        drop(stdin);
        result
    } else {
        None
    };
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(match write_error {
            Some(error) => format!("ffmpeg stdin: {error}; ffmpeg: {stderr}"),
            None => format!("ffmpeg: {stderr}"),
        });
    }
    if let Some(error) = write_error {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("ffmpeg stdin: {error}"));
    }
    let bytes = tokio::fs::read(&tmp).await.map_err(|e| e.to_string());
    let _ = tokio::fs::remove_file(&tmp).await;
    bytes
}

/// Append an MP3 book-end cue to canonical CAF and re-encode one valid CAF.
/// ffmpeg needs two seekable inputs for the concat filter, so this rare path
/// uses private temporary files and removes them before returning.
pub async fn transcode_audio_with_tail(caf: &[u8], cue_mp3: &[u8]) -> Result<Vec<u8>, String> {
    let mut base = std::env::temp_dir();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    base.push(format!("lvtail-{}-{nonce}", std::process::id()));
    let chapter = base.with_extension("chapter.caf");
    let cue = base.with_extension("cue.mp3");
    let output = base.with_extension(AUDIO_VARIANT.ext);
    tokio::fs::write(&chapter, caf)
        .await
        .map_err(|e| format!("write tail chapter: {e}"))?;
    tokio::fs::write(&cue, cue_mp3)
        .await
        .map_err(|e| format!("write tail cue: {e}"))?;
    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.arg("-v")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(&chapter)
        .arg("-i")
        .arg(&cue)
        .arg("-filter_complex")
        .arg("[0:a][1:a]concat=n=2:v=0:a=1[out]")
        .arg("-map")
        .arg("[out]");
    for arg in AUDIO_VARIANT.args {
        cmd.arg(arg);
    }
    let result = cmd.arg(&output).output().await;
    let bytes = match result {
        Ok(out) if out.status.success() => tokio::fs::read(&output)
            .await
            .map_err(|e| format!("read tail audio: {e}")),
        Ok(out) => Err(format!(
            "ffmpeg tail: {}",
            String::from_utf8_lossy(&out.stderr)
        )),
        Err(e) => Err(format!("spawn ffmpeg tail: {e}")),
    };
    for path in [&chapter, &cue, &output] {
        let _ = tokio::fs::remove_file(path).await;
    }
    bytes
}
