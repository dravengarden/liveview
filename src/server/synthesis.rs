//! Chapter narration synthesis shared by the audio and speech workers and the
//! on-demand HTTP fallback: which texts a rendition speaks, and the
//! synthesize → encode → store pipeline that turns them into an audio + marks
//! pair of content-addressed blobs.

use crate::config::RenditionKind;
use crate::content::{narration, speakable, spoken};
use crate::server::encoding::{AUDIO_VARIANT, encode_speech_audio};
use crate::store::blobs::put_blob;
use crate::store::content::{BlobStore, ContentStore};

/// The texts to synthesize for a chapter, one clip each. An audiobook speaks
/// its curated `.spoken.md` script sentence by sentence. Text read-aloud speaks
/// one clip per UNIT of the displayed markdown, so the mark index equals the
/// `/api/units` index the in-place highlight anchors on; the speech registry
/// decides each unit's spoken text (prose normalized for the ear; tables,
/// diagrams, math and code resolved from pre-generated narration; anything
/// unhandled is a silent step-over). No model call is made here.
pub async fn speech_texts(
    store: &(impl ContentStore + ?Sized),
    kind: RenditionKind,
    markdown: &str,
    lang: &str,
) -> Result<Vec<String>, String> {
    match kind {
        RenditionKind::Audio => Ok(spoken::spoken_sentences(markdown)),
        RenditionKind::Text => {
            let units = spoken::spoken_units(markdown);
            if units.is_empty() {
                return Ok(Vec::new());
            }
            let keys = speakable::narration_keys(&units, lang);
            let narration =
                narration::NarrationStore::from_pairs(store.load_narration(&keys).await?);
            Ok(units
                .iter()
                .map(|u| speakable::unit_speech(u, lang, &narration))
                .collect())
        }
    }
}

/// Synthesize `texts` with `voice`, encode the canonical CAF, and store audio
/// and marks as content-addressed blobs. Returns `(audio_hash, marks_hash)`.
/// The synthesized MP3 is only an encoder input and is never persisted.
pub async fn synthesize_chapter(
    store: &(impl ContentStore + ?Sized),
    obj: &(impl BlobStore + ?Sized),
    command: &str,
    voice: &str,
    texts: &[String],
) -> Result<(String, String), String> {
    let (mp3, marks) = crate::server::audio::synthesize(command, voice, texts).await?;
    let marks_json = serde_json::to_vec(&marks).map_err(|e| format!("encode marks: {e}"))?;
    let caf = encode_speech_audio(mp3, voice).await?;
    let audio_hash = put_blob(store, obj, caf, AUDIO_VARIANT.mime).await?;
    let marks_hash = put_blob(store, obj, marks_json, "application/json").await?;
    Ok((audio_hash, marks_hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::fs::FsStore;

    const MD: &str =
        "# Title\n\nFirst sentence. Second sentence.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

    #[tokio::test]
    async fn audiobook_speaks_its_script_sentence_by_sentence() {
        let store = FsStore::new(Vec::new());
        let texts = speech_texts(&store, RenditionKind::Audio, MD, "en")
            .await
            .unwrap();
        assert_eq!(texts, spoken::spoken_sentences(MD));
    }

    #[tokio::test]
    async fn text_read_aloud_speaks_one_clip_per_unit() {
        let store = FsStore::new(Vec::new());
        let texts = speech_texts(&store, RenditionKind::Text, MD, "en")
            .await
            .unwrap();
        assert_eq!(texts.len(), spoken::spoken_units(MD).len());
        assert!(!texts.is_empty());
    }

    #[tokio::test]
    async fn empty_markdown_has_nothing_to_speak() {
        let store = FsStore::new(Vec::new());
        for kind in [RenditionKind::Audio, RenditionKind::Text] {
            assert!(
                speech_texts(&store, kind, "", "en")
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
    }
}
