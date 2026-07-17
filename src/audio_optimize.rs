//! Resumable promotion of legacy MP3-backed chapter audio to canonical Opus/CAF.
//!
//! The legacy layout kept the database pointer on the MP3 and stored the bytes
//! actually served to clients under `<mp3-hash>.op16c`. That broke the core
//! content-address invariant. This migration stores those CAF bytes under their
//! own blake3 hash, registers them as an asset, verifies the object, then rewrites
//! every chapter reference. Source MP3 assets remain for ordinary sync GC.

use futures_util::{StreamExt, TryStreamExt, stream};

use crate::store::pg::{LegacyAudioAsset, PgStore};
use crate::sync::objstore::ObjStore;

const CONCURRENCY: usize = 8;

#[derive(Default, Debug)]
pub struct Report {
    pub promoted: u64,
    pub chapters: u64,
    pub source_bytes: u64,
    pub canonical_bytes: u64,
    pub retranscoded: u64,
    pub tails: u64,
}

struct Promoted {
    chapters: u64,
    source_bytes: u64,
    canonical_bytes: u64,
    retranscoded: bool,
    tail: bool,
}

pub async fn run(pg: &PgStore, obj: &ObjStore) -> Result<Report, String> {
    let assets = pg
        .legacy_audio_assets()
        .await
        .map_err(|e| format!("list legacy audio: {e}"))?;
    let total = assets.len();
    if total == 0 {
        return Ok(Report::default());
    }

    let results = stream::iter(assets.into_iter().enumerate().map(|(index, asset)| {
        let pg = pg.clone();
        let obj = obj.clone();
        async move {
            let result = promote_one(&pg, &obj, asset).await;
            if result.is_ok() && ((index + 1) % 100 == 0 || index + 1 == total) {
                eprintln!("audio-optimize: {}/{}", index + 1, total);
            }
            result
        }
    }))
    .buffer_unordered(CONCURRENCY)
    .try_collect::<Vec<_>>()
    .await?;

    let mut report = Report::default();
    for item in results {
        report.promoted += 1;
        report.chapters += item.chapters;
        report.source_bytes += item.source_bytes;
        report.canonical_bytes += item.canonical_bytes;
        report.retranscoded += u64::from(item.retranscoded);
        report.tails += u64::from(item.tail);
    }
    Ok(report)
}

async fn promote_one(
    pg: &PgStore,
    obj: &ObjStore,
    asset: LegacyAudioAsset,
) -> Result<Promoted, String> {
    let derived_key = format!("{}.{}", asset.content_hash, crate::AUDIO_VARIANT.tag);
    let (caf, retranscoded) = match obj.get(&derived_key).await {
        Ok(bytes) => (bytes, false),
        Err(_) => {
            let mp3 = obj
                .get(&asset.content_hash)
                .await
                .map_err(|e| format!("read source {}: {e}", asset.content_hash))?;
            (crate::transcode_audio(mp3).await?, true)
        }
    };
    let canonical_hash = blake3::hash(&caf).to_hex().to_string();
    let canonical_bytes = caf.len() as u64;
    obj.put_if_absent(&canonical_hash, caf, crate::AUDIO_VARIANT.mime)
        .await?;

    // Verify the immutable object before any database pointer moves.
    let stored = obj.get(&canonical_hash).await?;
    let stored_hash = blake3::hash(&stored).to_hex().to_string();
    if stored_hash != canonical_hash {
        return Err(format!(
            "canonical audio integrity mismatch: expected {canonical_hash}, got {stored_hash}"
        ));
    }
    pg.upsert_asset(
        &canonical_hash,
        crate::AUDIO_VARIANT.mime,
        canonical_bytes as i64,
    )
    .await
    .map_err(|e| format!("register canonical audio: {e}"))?;

    // Preserve the seven small prebuilt book-end variants under the new key.
    // They remain an optional streaming derivative, not a DAG resource.
    let old_tail = format!("{}.tail.{}", asset.content_hash, crate::AUDIO_VARIANT.tag);
    let new_tail = format!("{canonical_hash}.tail.{}", crate::AUDIO_VARIANT.tag);
    let tail = if let Ok(bytes) = obj.get(&old_tail).await {
        obj.put_if_absent(&new_tail, bytes, crate::AUDIO_VARIANT.mime)
            .await?;
        true
    } else {
        false
    };

    let chapters = pg
        .replace_audio_hash(&asset.content_hash, &canonical_hash)
        .await
        .map_err(|e| format!("replace audio hash: {e}"))?;

    // These URL-keyed derivatives are now redundant. Deletion is best-effort:
    // a failure only wastes space and can be cleaned by a later inventory pass.
    if let Err(error) = obj.delete(&derived_key).await {
        tracing::warn!(key = derived_key, %error, "delete legacy audio derivative failed");
    }
    if tail && let Err(error) = obj.delete(&old_tail).await {
        tracing::warn!(key = old_tail, %error, "delete legacy tail derivative failed");
    }

    Ok(Promoted {
        chapters,
        source_bytes: asset.size.max(0) as u64,
        canonical_bytes,
        retranscoded,
        tail,
    })
}
