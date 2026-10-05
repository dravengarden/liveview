//! Narration audio over HTTP: the canonical encoding, on-demand synthesis,
//! read-along marks, and the optional spoken book-end tail.

use super::*;

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
    for a in AUDIO_VARIANT.args {
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
async fn transcode_audio_with_tail(caf: &[u8], cue_mp3: &[u8]) -> Result<Vec<u8>, String> {
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

const AUDIO_CACHE_CONTROL: &str = "public, max-age=3600";

/// Whether stored audio predates the canonical representation. Every writer
/// stores `AUDIO_VARIANT`; only an asset row recording another MIME is legacy,
/// so a missing row or store hiccup still serves the bytes.
async fn is_legacy_audio(state: &AppState, hash: &str) -> bool {
    matches!(
        state.store.get_asset(hash).await,
        Ok(Some(asset)) if asset.mime != AUDIO_VARIANT.mime
    )
}

/// Legacy MP3 pointers are migrated offline by `liveview audio-optimize`; the
/// server no longer transcodes them per request.
fn legacy_audio_response(hash: &str) -> Response {
    tracing::warn!(
        audio_hash = hash,
        "legacy audio pointer; run `liveview audio-optimize`"
    );
    (
        StatusCode::CONFLICT,
        "legacy audio: run `liveview audio-optimize`",
    )
        .into_response()
}

/// Serve canonical stored audio straight from the blob store, reading only the
/// requested range so a seek does not load the whole chapter.
async fn serve_stored_audio(state: &AppState, key: &str, headers: &HeaderMap) -> Response {
    stored_blob_response(state, key, headers, AUDIO_VARIANT.mime, AUDIO_CACHE_CONTROL)
        .await
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "read audio").into_response())
}

/// Chapter narration audio from rustfs, with `Content-Length` + HTTP Range
/// support (seeking). Stored audio is read per range; the derived book-end tail
/// loads the whole chapter once to build its cached variant.
pub(crate) async fn api_audio(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    // Text rendition → read-aloud for an ordinary document (units-driven synth).
    if query.rendition.as_deref() == Some("text") {
        return match ensure_text_audio(&state, &query).await {
            Ok((audio_hash, _)) => {
                if is_legacy_audio(&state, &audio_hash).await {
                    legacy_audio_response(&audio_hash)
                } else {
                    serve_stored_audio(&state, &audio_hash, &headers).await
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "text read-aloud synth failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response()
            }
        };
    }
    let Some(ctx) = resolve_audio(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "audio not available").into_response();
    };
    let row = match resolve_narration(&state, &ctx).await {
        Ok(Some((row, _))) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => return store_unavailable("resolve_narration", error),
    };
    let hash = match ensure_chapter_audio(&state, &row).await {
        Ok((audio_hash, _)) => audio_hash,
        Err(e) => {
            tracing::warn!(error = %e, "on-demand audio synth failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response();
        }
    };
    // A book's last chapter may carry an operator-configured spoken tail (the
    // client sends `tail=bookend` only for that chapter). Bake it into the served bytes so it
    // plays through the same MediaSession element — on the lock screen / in the
    // background, where a client-side cue would be silent. MP3 frames concatenate
    // cleanly (same as `assemble()` joins per-sentence clips). Marks are
    // untouched: the tail sits past the last sentence's end_ms, a silent gap in
    // the read-along. Only the last chapter pays the (tiny) append.
    if is_legacy_audio(&state, &hash).await {
        return legacy_audio_response(&hash);
    }
    let is_bookend = query.tail.as_deref() == Some("bookend");
    if is_bookend && let Some(phrase) = book_end_phrase(&state.book_end_phrases, &row.lang) {
        // Include the configured phrase in the derived cache identity so a
        // configuration change can never replay an older deployment's cue.
        let phrase_hash = blake3::hash(phrase.as_bytes()).to_hex();
        let tail_key = format!("{hash}.tail.{}.{phrase_hash}", AUDIO_VARIANT.tag);
        if let Ok(tail) = stored_blob_response(
            &state,
            &tail_key,
            &headers,
            AUDIO_VARIANT.mime,
            AUDIO_CACHE_CONTROL,
        )
        .await
        {
            return tail;
        }
        if let Some(cue) = book_end_cue(&state, &row).await {
            let Ok(data) = state.obj.get(&hash).await else {
                return (StatusCode::INTERNAL_SERVER_ERROR, "read audio").into_response();
            };
            match transcode_audio_with_tail(&data, &cue).await {
                Ok(tail) => {
                    if let Err(error) = state
                        .obj
                        .put_if_absent(&tail_key, tail.clone(), AUDIO_VARIANT.mime)
                        .await
                    {
                        tracing::warn!(%error, "store canonical book-end tail failed");
                    }
                    return ranged_bytes_response(
                        tail,
                        &headers,
                        AUDIO_VARIANT.mime,
                        AUDIO_CACHE_CONTROL,
                    );
                }
                Err(error) => {
                    tracing::warn!(audio_hash = hash, %error, "build canonical book-end tail failed");
                }
            }
        }
    }
    serve_stored_audio(&state, &hash, &headers).await
}

/// Per-sentence time marks for the chapter audio (drives read-along highlight).
pub(crate) async fn api_marks(
    State(state): State<SharedState>,
    Query(query): Query<FileQuery>,
) -> impl IntoResponse {
    // Text rendition → units-driven read-aloud marks (idx aligns with /api/units
    // for the in-place highlight). Additive: the audiobook path below is unchanged.
    if query.rendition.as_deref() == Some("text") {
        return match ensure_text_audio(&state, &query).await {
            Ok((_, marks_hash)) => match state.obj.get(&marks_hash).await {
                Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
                Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read marks").into_response(),
            },
            Err(e) => {
                tracing::warn!(error = %e, "text read-aloud synth failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response()
            }
        };
    }
    let Some(ctx) = resolve_audio(&state, &query).await else {
        return (StatusCode::NOT_FOUND, "audio not available").into_response();
    };
    let row = match resolve_narration(&state, &ctx).await {
        Ok(Some((row, _))) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
        Err(error) => return store_unavailable("resolve_narration", error),
    };
    let hash = match ensure_chapter_audio(&state, &row).await {
        Ok((_, marks_hash)) => marks_hash,
        Err(e) => {
            tracing::warn!(error = %e, "on-demand audio synth failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "audio synth").into_response();
        }
    };
    match state.obj.get(&hash).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "read marks").into_response(),
    }
}

/// Per-chapter single-flight lock for on-demand synthesis, keyed by the row's
/// identity. A double-tap, a second client, or the parallel `/api/audio` +
/// `/api/marks` pair then waits on the same lock and finds the just-recorded
/// audio instead of synthesizing (and recording) a second, different pair.
async fn audio_synth_lock(
    state: &AppState,
    row: &ChapterRecord,
) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let key = format!(
        "{}|{}|{}|{}",
        row.book_slug, row.rendition, row.lang, row.rel_path
    );
    let mut map = state.audio_synth_locks.lock().await;
    std::sync::Arc::clone(
        map.entry(key)
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))),
    )
}

/// Re-read a chapter row (after acquiring its synth lock) so the synth works
/// from — and conditions its write on — the content currently deployed.
async fn reload_chapter(state: &AppState, row: &ChapterRecord) -> Result<ChapterRecord, String> {
    state
        .store
        .get_chapter(&row.book_slug, &row.rendition, &row.lang, &row.rel_path)
        .await?
        .ok_or_else(|| "chapter not found".to_string())
}

/// Record a synthesized pair on `row`, conditional on the row still holding
/// the content it was synthesized from. When nothing was written, serve what
/// the row holds now if it is audio for the same content (a concurrent writer
/// won — its pair is the consistent one to serve); otherwise the chapter
/// changed during the synth and this result is discarded.
async fn record_chapter_audio(
    state: &AppState,
    row: &ChapterRecord,
    voice: &str,
    audio_hash: String,
    marks_hash: String,
) -> Result<(String, String), String> {
    let recorded = state
        .store
        .set_chapter_audio(&AudioBake {
            book_slug: &row.book_slug,
            rendition: &row.rendition,
            lang: &row.lang,
            rel_path: &row.rel_path,
            content_hash: &row.content_hash,
            voice,
            audio_hash: &audio_hash,
            marks_hash: &marks_hash,
        })
        .await
        .map_err(|e| format!("record audio: {e}"))?;
    if recorded {
        return Ok((audio_hash, marks_hash));
    }
    let now = reload_chapter(state, row).await?;
    match (
        now.content_hash == row.content_hash,
        now.audio_hash,
        now.marks_hash,
    ) {
        (true, Some(a), Some(m)) => Ok((a, m)),
        _ => Err("chapter changed during synthesis; result discarded".to_string()),
    }
}

/// On-demand audio fallback (ISR-style): if the backfill hasn't pre-generated
/// this chapter's audio yet, synthesize it now (edge-tts) from the stored spoken
/// markdown, store mp3 + marks in rustfs, and record them on the chapter.
/// Already-generated chapters are a no-op. Returns `(audio_hash, marks_hash)`.
async fn ensure_chapter_audio(
    state: &AppState,
    row: &ChapterRecord,
) -> Result<(String, String), String> {
    if let (Some(a), Some(m)) = (&row.audio_hash, &row.marks_hash) {
        return Ok((a.clone(), m.clone()));
    }
    let lock = audio_synth_lock(state, row).await;
    let _guard = lock.lock().await;
    // Re-check after acquiring: a prior holder may have just filled the hashes.
    let row = reload_chapter(state, row).await?;
    if let (Some(a), Some(m)) = (&row.audio_hash, &row.marks_hash) {
        return Ok((a.clone(), m.clone()));
    }
    let md = row.markdown.clone().unwrap_or_default();
    let sentences = server::spoken::spoken_sentences(&md);
    let voice = {
        let cat = state.catalog.read().await;
        cat.book(&row.book_slug)
            .and_then(|b| b.rendition(RenditionKind::Audio))
            .and_then(|r| r.voice.clone())
            .or_else(|| state.tts_voice.clone())
            .ok_or("speech voice is not configured")?
    };
    let command = state
        .tts_cmd
        .as_deref()
        .ok_or("speech synthesis is not configured")?;
    let (mp3, marks) = server::audio::synthesize(command, &voice, &sentences).await?;
    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    let caf = transcode_audio(mp3).await?;
    let audio_hash = store_blob(state, caf, AUDIO_VARIANT.mime).await?;
    let marks_hash = store_blob(state, marks_json, "application/json").await?;
    record_chapter_audio(state, &row, &voice, audio_hash, marks_hash).await
}

/// Read-aloud for the TEXT rendition (any document, not a curated audiobook).
/// Synthesizes from the chapter's `spoken_units` so each clip is one unit, in
/// order — the marks are therefore indexed by UNIT, matching `/api/units` and the
/// in-place highlight. Result is content-addressed in rustfs and recorded on the
/// TEXT chapter row's (until-now-unused) audio/marks hashes, so it's generated
/// once and a re-sync (which resets those hashes) regenerates it. Never touches
/// the `audio` rendition path. Returns `(audio_hash, marks_hash)`.
async fn ensure_text_audio(
    state: &AppState,
    query: &FileQuery,
) -> Result<(String, String), String> {
    let ctx = resolve_req(state, query).await.ok_or("unknown book")?;
    // Resolve the DISPLAYED chapter (like /api/file), NOT resolve_narration's
    // `.spoken.md` overlay — so the synthesized audio + its marks are derived
    // from the very text the reader sees and the in-place highlight anchors line
    // up. (The overlay is the audiobook rendition's own curated script.)
    let (row, served) = state
        .store
        .get_chapter_fallback(
            &ctx.slug,
            ctx.kind.as_str(),
            &ctx.lang,
            &ctx.default_lang,
            &ctx.rest,
        )
        .await
        .ok()
        .flatten()
        .ok_or("chapter not found")?;
    if let (Some(a), Some(m)) = (&row.audio_hash, &row.marks_hash) {
        return Ok((a.clone(), m.clone()));
    }
    // Single-flight: serialize synth per chapter so a double-tap / second client
    // waits rather than redoing the expensive edge-tts (+ narration) run.
    let lock = audio_synth_lock(state, &row).await;
    let _guard = lock.lock().await;
    // Re-check after acquiring: a prior holder may have just filled the hashes.
    let row = reload_chapter(state, &row).await?;
    if let (Some(a), Some(m)) = (&row.audio_hash, &row.marks_hash) {
        return Ok((a.clone(), m.clone()));
    }
    let md = row.markdown.clone().unwrap_or_default();
    let units = server::spoken::spoken_units(&md);
    if units.is_empty() {
        return Err("no speakable content".to_string());
    }
    // One clip per unit (empty-text units → a silent dwell in `assemble`), so the
    // mark index equals the unit index the highlight anchors on. The speech
    // registry decides each unit's spoken text: prose is normalized for the ear
    // (URLs/addresses/phone numbers → a short stand-in), tables / diagrams /
    // formulas / code are resolved from PRE-GENERATED narration (made offline by
    // a skill, ingested into pg by `sync`), and anything unhandled / not-yet-
    // narrated stays a brief silent step-over. No model call. Runs once per
    // chapter (the whole result is cached).
    let keys = server::speakable::narration_keys(&units, &served);
    let store =
        server::narration::NarrationStore::from_pairs(state.store.load_narration(&keys).await?);
    let texts: Vec<String> = units
        .iter()
        .map(|u| server::speakable::unit_speech(u, &served, &store))
        .collect();
    let voice = {
        let cat = state.catalog.read().await;
        cat.book(&row.book_slug)
            .and_then(|b| b.rendition(RenditionKind::Audio))
            .and_then(|r| r.voice.clone())
            .or_else(|| state.tts_voice.clone())
            .ok_or("speech voice is not configured")?
    };
    let command = state
        .tts_cmd
        .as_deref()
        .ok_or("speech synthesis is not configured")?;
    let (mp3, marks) = server::audio::synthesize(command, &voice, &texts).await?;
    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    let caf = transcode_audio(mp3).await?;
    let audio_hash = store_blob(state, caf, AUDIO_VARIANT.mime).await?;
    let marks_hash = store_blob(state, marks_json, "application/json").await?;
    record_chapter_audio(state, &row, &voice, audio_hash, marks_hash).await
}

/// Parse operator-defined end-of-book phrases. No language or wording is built
/// into the reader; an absent or invalid map disables this optional cue.
fn parse_book_end_phrases(value: &str) -> Result<HashMap<String, String>, String> {
    let phrases: HashMap<String, String> = serde_json::from_str(value)
        .map_err(|error| format!("LIVEVIEW_BOOK_END_PHRASES must be a JSON object: {error}"))?;
    Ok(phrases
        .into_iter()
        .filter_map(|(lang, phrase)| {
            let lang = lang.trim().to_ascii_lowercase();
            let phrase = phrase.trim().to_string();
            (!lang.is_empty() && !phrase.is_empty()).then_some((lang, phrase))
        })
        .collect())
}

pub(crate) fn load_book_end_phrases() -> HashMap<String, String> {
    let Ok(value) = std::env::var("LIVEVIEW_BOOK_END_PHRASES") else {
        return HashMap::new();
    };
    match parse_book_end_phrases(&value) {
        Ok(phrases) => phrases,
        Err(error) => {
            tracing::warn!(%error, "end-of-book audio cue disabled");
            HashMap::new()
        }
    }
}

/// Look up an exact BCP 47 tag first, then its primary language subtag.
fn book_end_phrase<'a>(phrases: &'a HashMap<String, String>, lang: &str) -> Option<&'a str> {
    let lang = lang.trim().to_ascii_lowercase();
    phrases
        .get(&lang)
        .or_else(|| {
            lang.split_once('-')
                .and_then(|(primary, _)| phrases.get(primary))
        })
        .map(String::as_str)
}

/// The synthesized "end of book" cue for this chapter's voice + language,
/// cached in-process (keyed by `"{voice}|{phrase}"`). Returns `None` when the
/// language has no phrase or synthesis fails — the caller then serves the
/// chapter audio with no tail, never an error (a missing cue must not break
/// playback). The voice is the book's audio-rendition voice, mirroring
/// `ensure_chapter_audio`, so the cue matches the narration.
async fn book_end_cue(state: &AppState, row: &ChapterRecord) -> Option<Vec<u8>> {
    let phrase = book_end_phrase(&state.book_end_phrases, &row.lang)?;
    let voice = {
        let cat = state.catalog.read().await;
        cat.book(&row.book_slug)
            .and_then(|b| b.rendition(RenditionKind::Audio))
            .and_then(|r| r.voice.clone())
            .or_else(|| state.tts_voice.clone())?
    };
    let key = format!("{voice}|{phrase}");
    if let Some(cue) = state.book_end_cue.lock().await.get(&key) {
        return Some(cue.as_ref().clone());
    }
    // Synthesize off-lock; a rare double-synth
    // race is harmless — both produce the same tiny clip and the last write wins.
    let (mp3, _marks) =
        match server::audio::synthesize(state.tts_cmd.as_deref()?, &voice, &[phrase.to_string()])
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, voice, "book-end cue synth failed");
                return None;
            }
        };
    let arc = std::sync::Arc::new(mp3);
    state.book_end_cue.lock().await.insert(key, arc.clone());
    Some(arc.as_ref().clone())
}

/// Hash + `put_if_absent` a blob to rustfs and record the asset row. Returns the
/// content hash (the rustfs key).
async fn store_blob(state: &AppState, bytes: Vec<u8>, mime: &str) -> Result<String, String> {
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let size = bytes.len() as i64;
    // Register first: it refreshes the orphan-GC grace window, so a concurrent
    // `liveview sync` cannot collect the blob before the chapter references it.
    state
        .store
        .upsert_asset(&hash, mime, size)
        .await
        .map_err(|e| format!("upsert asset: {e}"))?;
    state.obj.put_if_absent(&hash, bytes, mime).await?;
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_end_phrases_are_explicit_and_language_aware() {
        let phrases = parse_book_end_phrases(
            r#"{"en":"The end.","zh":"全书完","fr-CA":" Fin. ","empty":" "}"#,
        )
        .unwrap();
        assert_eq!(book_end_phrase(&phrases, "en-US"), Some("The end."));
        assert_eq!(book_end_phrase(&phrases, "ZH-Hans"), Some("全书完"));
        assert_eq!(book_end_phrase(&phrases, "fr-CA"), Some("Fin."));
        assert_eq!(book_end_phrase(&phrases, "fr-FR"), None);
        assert_eq!(book_end_phrase(&HashMap::new(), "en"), None);
    }

    #[test]
    fn invalid_book_end_phrase_config_is_rejected() {
        assert!(parse_book_end_phrases(r#"["not", "an", "object"]"#).is_err());
    }

    #[tokio::test]
    async fn canonical_audio_variant_is_muxable_by_ffmpeg() {
        let source = tokio::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.1",
                "-f",
                "mp3",
                "pipe:1",
            ])
            .output()
            .await
            .expect("ffmpeg should generate the MP3 fixture");
        assert!(
            source.status.success(),
            "fixture ffmpeg failed: {}",
            String::from_utf8_lossy(&source.stderr)
        );

        let canonical = transcode_audio(source.stdout)
            .await
            .expect("canonical audio configuration must be supported by ffmpeg");
        assert!(canonical.starts_with(b"caff"));
    }
}
