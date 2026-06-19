//! The content seam: `ContentStore` + `BlobStore` traits so the reader's HTTP
//! handlers run over ANY backend.
//!
//! Two adapters implement them:
//!   - postgres + rustfs (`PgStore` / `ObjStore`) — the deployed, pre-rendered,
//!     filesystem-free server.
//!   - the filesystem (`fs::FsStore`) — `liveview preview`, which renders a
//!     local book on demand with the SAME engines, no `sync`/deploy.
//!
//! Errors are stringified at this boundary: a filesystem backend has no
//! `sqlx::Error` to fabricate, and every server call site already consumes
//! these via `.ok()` / `%e` / `.map_err(|e| e.to_string())`, so `String` keeps
//! the handlers untouched.

use async_trait::async_trait;

use crate::store::pg::{
    AssetRow, AudioTaskRollup, BookRow, ChapterRow, EditionRow, ProgressEntry, RenditionRow,
};

/// Catalog structure + chapter/asset access the reader needs. The deployed
/// backend serves rows pre-rendered at `sync` time; the filesystem backend
/// renders on demand. Object-safe (`Arc<dyn ContentStore>`).
#[async_trait]
pub trait ContentStore: Send + Sync {
    async fn list_books(&self) -> Result<Vec<BookRow>, String>;
    async fn list_renditions(&self, book_slug: &str) -> Result<Vec<RenditionRow>, String>;
    async fn list_editions(
        &self,
        book_slug: &str,
        rendition: &str,
    ) -> Result<Vec<EditionRow>, String>;

    async fn get_chapter(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
    ) -> Result<Option<ChapterRow>, String>;

    /// Overlay → base fallback: try `lang`, then `default_lang`. Shared default
    /// — both backends only implement the single-lang `get_chapter`.
    async fn get_chapter_fallback(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        default_lang: &str,
        rel_path: &str,
    ) -> Result<Option<(ChapterRow, String)>, String> {
        if let Some(c) = self.get_chapter(book_slug, rendition, lang, rel_path).await? {
            return Ok(Some((c, lang.to_string())));
        }
        if lang != default_lang {
            if let Some(c) = self
                .get_chapter(book_slug, rendition, default_lang, rel_path)
                .await?
            {
                return Ok(Some((c, default_lang.to_string())));
            }
        }
        Ok(None)
    }

    async fn get_asset(&self, content_hash: &str) -> Result<Option<AssetRow>, String>;

    /// Register an asset's metadata (mime/size) — used by on-demand audio
    /// synthesis when it stores a freshly generated blob.
    async fn upsert_asset(&self, content_hash: &str, mime: &str, size: i64)
        -> Result<(), String>;

    /// The pre-built sidebar forest JSON for a rendition (`"[]"` when absent).
    async fn get_site_tree(&self, rendition: &str) -> Result<Option<String>, String>;

    /// Record lazily-synthesized audio onto a chapter (deployed: persists to pg;
    /// preview: in-memory, fine for an ephemeral session).
    async fn set_chapter_audio(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
        audio_hash: &str,
        marks_hash: &str,
    ) -> Result<(), String>;

    // ── Reading progress + player settings (user state) ──────────────────────
    // Orthogonal to content; the filesystem backend keeps these in memory.
    async fn progress_for_book(&self, slug: &str) -> Result<Vec<ProgressEntry>, String>;
    async fn progress_recent_per_rendition(&self) -> Result<Vec<ProgressEntry>, String>;
    async fn progress_upsert(&self, path: &str, scroll: f64) -> Result<(), String>;
    async fn settings_all(&self) -> Result<Vec<(String, String)>, String>;
    async fn settings_set(&self, key: &str, value: &str) -> Result<(), String>;

    /// Per-book + global audio-generation rollup for the status surface (the Sync
    /// sheet). The filesystem `preview` backend has no queue → empty.
    async fn audio_task_rollup(&self) -> Result<Vec<AudioTaskRollup>, String>;
}

/// Content-addressed blob bytes: rustfs (deployed) or an in-memory map (preview).
#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn get(&self, key: &str) -> Result<Vec<u8>, String>;
    async fn put_if_absent(&self, key: &str, bytes: Vec<u8>, mime: &str) -> Result<(), String>;
}

// ── Adapter: postgres `PgStore` → ContentStore ───────────────────────────────

use crate::store::pg::PgStore;
use crate::sync::objstore::ObjStore;

#[async_trait]
impl ContentStore for PgStore {
    async fn list_books(&self) -> Result<Vec<BookRow>, String> {
        PgStore::list_books(self).await.map_err(|e| e.to_string())
    }
    async fn list_renditions(&self, book_slug: &str) -> Result<Vec<RenditionRow>, String> {
        PgStore::list_renditions(self, book_slug)
            .await
            .map_err(|e| e.to_string())
    }
    async fn list_editions(
        &self,
        book_slug: &str,
        rendition: &str,
    ) -> Result<Vec<EditionRow>, String> {
        PgStore::list_editions(self, book_slug, rendition)
            .await
            .map_err(|e| e.to_string())
    }
    async fn get_chapter(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
    ) -> Result<Option<ChapterRow>, String> {
        PgStore::get_chapter(self, book_slug, rendition, lang, rel_path)
            .await
            .map_err(|e| e.to_string())
    }
    async fn get_asset(&self, content_hash: &str) -> Result<Option<AssetRow>, String> {
        PgStore::get_asset(self, content_hash)
            .await
            .map_err(|e| e.to_string())
    }
    async fn upsert_asset(
        &self,
        content_hash: &str,
        mime: &str,
        size: i64,
    ) -> Result<(), String> {
        PgStore::upsert_asset(self, content_hash, mime, size)
            .await
            .map_err(|e| e.to_string())
    }
    async fn get_site_tree(&self, rendition: &str) -> Result<Option<String>, String> {
        PgStore::get_site_tree(self, rendition)
            .await
            .map_err(|e| e.to_string())
    }
    async fn set_chapter_audio(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
        audio_hash: &str,
        marks_hash: &str,
    ) -> Result<(), String> {
        PgStore::set_chapter_audio(
            self, book_slug, rendition, lang, rel_path, audio_hash, marks_hash,
        )
        .await
        .map_err(|e| e.to_string())
    }
    async fn progress_for_book(&self, slug: &str) -> Result<Vec<ProgressEntry>, String> {
        PgStore::progress_for_book(self, slug)
            .await
            .map_err(|e| e.to_string())
    }
    async fn progress_recent_per_rendition(&self) -> Result<Vec<ProgressEntry>, String> {
        PgStore::progress_recent_per_rendition(self)
            .await
            .map_err(|e| e.to_string())
    }
    async fn progress_upsert(&self, path: &str, scroll: f64) -> Result<(), String> {
        PgStore::progress_upsert(self, path, scroll)
            .await
            .map_err(|e| e.to_string())
    }
    async fn settings_all(&self) -> Result<Vec<(String, String)>, String> {
        PgStore::settings_all(self).await.map_err(|e| e.to_string())
    }
    async fn settings_set(&self, key: &str, value: &str) -> Result<(), String> {
        PgStore::settings_set(self, key, value)
            .await
            .map_err(|e| e.to_string())
    }
    async fn audio_task_rollup(&self) -> Result<Vec<AudioTaskRollup>, String> {
        PgStore::audio_task_rollup(self)
            .await
            .map_err(|e| e.to_string())
    }
}

#[async_trait]
impl BlobStore for ObjStore {
    async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        ObjStore::get(self, key).await.map_err(|e| e.to_string())
    }
    async fn put_if_absent(&self, key: &str, bytes: Vec<u8>, mime: &str) -> Result<(), String> {
        ObjStore::put_if_absent(self, key, bytes, mime)
            .await
            .map_err(|e| e.to_string())
    }
}
