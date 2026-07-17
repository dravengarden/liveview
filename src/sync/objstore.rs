//! Thin S3 adapter over the private rustfs instance.
//!
//! Object keys are content hashes (blake3 hex), so a blob is written once and
//! shared by every chapter that references it. `put_if_absent` skips the upload
//! when the hash is already present — the cheap path the Merkle diff relies on.
//!
//! rustfs speaks plain S3 over loopback HTTP, so the client is built with
//! explicit credentials, a dummy region, path-style addressing, and the given
//! `http://…` endpoint (no AWS env/credential-chain scanning).

use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::primitives::ByteStream;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub struct ObjStore {
    client: Client,
    bucket: String,
}

impl ObjStore {
    /// Build a client for `endpoint` (e.g. `http://127.0.0.1:9001`) + `bucket`.
    pub fn connect(endpoint: &str, access_key: &str, secret_key: &str, bucket: &str) -> Self {
        let creds = Credentials::new(access_key, secret_key, None, None, "liveview");
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1")) // rustfs ignores it; required by the SDK
            .endpoint_url(endpoint)
            .credentials_provider(creds)
            .force_path_style(true) // S3-compatible servers need path-style
            .build();
        Self {
            client: Client::from_conf(conf),
            bucket: bucket.to_string(),
        }
    }

    /// Create the bucket if absent. Idempotent: an "already owned/exists" error
    /// is success.
    pub async fn ensure_bucket(&self) -> Result<()> {
        match self
            .client
            .create_bucket()
            .bucket(&self.bucket)
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                // rustfs/S3 returns BucketAlreadyOwnedByYou / BucketAlreadyExists.
                if msg.contains("AlreadyOwned") || msg.contains("AlreadyExists") {
                    Ok(())
                } else if let SdkError::ServiceError(se) = &e {
                    let c = se.err().meta().code().unwrap_or_default();
                    if c.contains("AlreadyOwned") || c.contains("AlreadyExists") {
                        Ok(())
                    } else {
                        Err(format!("create_bucket: {msg}"))
                    }
                } else {
                    Err(format!("create_bucket: {msg}"))
                }
            }
        }
    }

    /// Whether an object with `key` already exists.
    pub async fn exists(&self, key: &str) -> Result<bool> {
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(SdkError::ServiceError(se)) if se.err().is_not_found() => Ok(false),
            Err(e) => Err(format!("head_object {key}: {e}")),
        }
    }

    /// Upload `bytes` under `key` only if not already present (content-addressed
    /// → identical bytes need no re-upload).
    pub async fn put_if_absent(&self, key: &str, bytes: Vec<u8>, mime: &str) -> Result<()> {
        if self.exists(key).await? {
            return Ok(());
        }
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(bytes))
            .content_type(mime)
            .send()
            .await
            .map_err(|e| format!("put_object {key}: {e}"))?;
        Ok(())
    }

    /// Fetch an object's bytes.
    pub async fn get(&self, key: &str) -> Result<Vec<u8>> {
        let out = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("get_object {key}: {e}"))?;
        let data = out
            .body
            .collect()
            .await
            .map_err(|e| format!("read body {key}: {e}"))?;
        let bytes = data.into_bytes().to_vec();
        Ok(bytes)
    }

    /// Remove an object (idempotent — deleting a missing key is not an error).
    pub async fn delete(&self, key: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("delete_object {key}: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gated round-trip against a live rustfs. Skips unless `LIVEVIEW_TEST_S3=1`
    /// with `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` set. Run with e.g.:
    ///   LIVEVIEW_TEST_S3=1 S3_ENDPOINT=http://127.0.0.1:9000 \
    ///   S3_ACCESS_KEY=$(sudo cat /var/lib/rustfs/access_key) \
    ///   S3_SECRET_KEY=$(sudo cat /var/lib/rustfs/secret_key) \
    ///   cargo test sync::objstore -- --ignored --test-threads=1
    #[tokio::test]
    #[ignore = "needs a live rustfs (LIVEVIEW_TEST_S3=1 + S3_* env)"]
    async fn put_get_delete_roundtrip() {
        if std::env::var("LIVEVIEW_TEST_S3").ok().as_deref() != Some("1") {
            return;
        }
        let endpoint = std::env::var("S3_ENDPOINT").expect("S3_ENDPOINT");
        let access = std::env::var("S3_ACCESS_KEY").expect("S3_ACCESS_KEY");
        let secret = std::env::var("S3_SECRET_KEY").expect("S3_SECRET_KEY");
        let s = ObjStore::connect(&endpoint, &access, &secret, "liveview-test");
        s.ensure_bucket().await.expect("ensure_bucket");

        let key = "blake3-test-key";
        s.delete(key).await.ok();
        assert!(!s.exists(key).await.expect("exists"));
        s.put_if_absent(key, b"hello".to_vec(), "text/plain")
            .await
            .expect("put");
        assert!(s.exists(key).await.expect("exists2"));
        assert_eq!(s.get(key).await.expect("get"), b"hello");
        // Second put is a no-op (already present).
        s.put_if_absent(key, b"IGNORED".to_vec(), "text/plain")
            .await
            .expect("put2");
        assert_eq!(s.get(key).await.expect("get2"), b"hello");
        s.delete(key).await.expect("delete");
        assert!(!s.exists(key).await.expect("exists3"));
    }
}
