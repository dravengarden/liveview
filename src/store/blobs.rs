//! Content-addressed blob writes shared by `liveview sync`, the audio and
//! speech workers, and on-demand synthesis in the HTTP layer.

use super::content::{BlobStore, ContentStore};

/// Store `bytes` under their blake3 hash and register the asset row; returns
/// the hash. The row is written first: it refreshes the orphan-GC grace
/// window, so a concurrent `liveview sync` cannot collect the object before a
/// chapter references it.
pub async fn put_blob(
    store: &(impl ContentStore + ?Sized),
    obj: &(impl BlobStore + ?Sized),
    bytes: Vec<u8>,
    mime: &str,
) -> Result<String, String> {
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let size = bytes.len() as i64;
    store
        .upsert_asset(&hash, mime, size)
        .await
        .map_err(|e| format!("upsert asset {hash}: {e}"))?;
    obj.put_if_absent(&hash, bytes, mime).await?;
    Ok(hash)
}
