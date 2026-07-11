//! Native (iOS/Mac) platform IO for the [`Engine`](crate::Engine): a
//! filesystem **file-per-hash** blob store. The hash IS the filename, so the
//! store is content-addressed on disk with no index — `has`/`get` are a single
//! `stat`/`read`, `keys` is one `readdir`, and the OS page cache does the rest.
//! No RocksDB, no DB: a directory of immutable blobs is the simplest thing that
//! survives app restarts and is trivially inspectable.
//!
//! The network half (a `Fetcher`) lives in the Tauri shell, which already has an
//! HTTP client — keeping this crate dependency-light (std only) so its logic is
//! unit-testable on any host (these tests run on Linux in CI/dev).
//!
//! Writes are atomic (tmp + rename) so a crash/kill mid-write can never leave a
//! truncated blob under a hash that then reads back as "present but corrupt".

use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::BlobStore;

/// A content-addressed blob directory: one file per hash.
pub struct FsBlobStore {
    root: PathBuf,
}

/// A manifest hash can carry a `:` suffix (e.g. `<content_hash>:units`), which is
/// a fragile filename on some filesystems — encode it reversibly. Hex hashes
/// never contain `%`, so this round-trips. `.tmp` is reserved for in-flight writes.
fn encode(hash: &str) -> String {
    hash.replace(':', "%3A")
}
fn decode(name: &str) -> String {
    name.replace("%3A", ":")
}

impl FsBlobStore {
    /// Open (creating if needed) the blob directory at `root`.
    pub fn new(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn path(&self, hash: &str) -> PathBuf {
        self.root.join(encode(hash))
    }
}

#[async_trait]
impl BlobStore for FsBlobStore {
    async fn get(&self, hash: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path(hash)).ok()
    }

    async fn put(&self, hash: &str, data: &[u8]) {
        let final_path = self.path(hash);
        // Unique-ish tmp name in the SAME dir (rename is atomic only within a
        // filesystem) — `<name>.<len>.tmp` avoids two writers of different blobs
        // clobbering one tmp; same-blob racers are harmless (identical bytes).
        let tmp = self
            .root
            .join(format!("{}.{}.tmp", encode(hash), data.len()));
        if std::fs::write(&tmp, data).is_ok() {
            // Rename over any existing blob: the hash is the content, so an
            // existing file has identical bytes — overwriting is a no-op in effect.
            let _ = std::fs::rename(&tmp, &final_path);
            // Best-effort cleanup if the rename somehow failed.
            if Path::new(&tmp).exists() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }

    async fn has(&self, hash: &str) -> bool {
        self.path(hash).exists()
    }

    async fn keys(&self) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        rd.filter_map(Result::ok)
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.ends_with(".tmp"))
            .map(|n| decode(&n))
            .collect()
    }

    async fn remove(&self, hash: &str) {
        let _ = std::fs::remove_file(self.path(hash));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pollster::block_on;

    fn tmpdir(tag: &str) -> PathBuf {
        // A unique-per-test dir under the OS temp root; cleaned at the end.
        let mut p = std::env::temp_dir();
        p.push(format!("lvsync-fsstore-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn roundtrip_and_keys() {
        let dir = tmpdir("rt");
        let s = FsBlobStore::new(&dir).unwrap();
        block_on(async {
            assert!(!s.has("abc").await);
            assert_eq!(s.get("abc").await, None);
            s.put("abc", b"hello").await;
            assert!(s.has("abc").await);
            assert_eq!(s.get("abc").await.unwrap(), b"hello");
            // A colon-suffixed key (units/spoken) survives the filename encoding.
            s.put("deadbeef:units", b"{}").await;
            assert!(s.has("deadbeef:units").await);
            let mut keys = s.keys().await;
            keys.sort();
            assert_eq!(keys, vec!["abc".to_string(), "deadbeef:units".to_string()]);
            s.remove("abc").await;
            assert!(!s.has("abc").await);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_tmp_files_leak_into_keys() {
        let dir = tmpdir("tmp");
        let s = FsBlobStore::new(&dir).unwrap();
        block_on(async {
            s.put("x", b"1").await;
            // Simulate a stray tmp file from an interrupted write.
            std::fs::write(dir.join("y.3.tmp"), b"partial").unwrap();
            let keys = s.keys().await;
            assert_eq!(keys, vec!["x".to_string()]);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn put_is_atomic_no_partial_on_reopen() {
        // After put, the final file exists and the tmp is gone (atomic rename).
        let dir = tmpdir("atomic");
        let s = FsBlobStore::new(&dir).unwrap();
        block_on(async { s.put("h", b"payload").await });
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        assert_eq!(entries, vec!["h".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
