//! sqlx-postgres store: schema migration, content CRUD (books / renditions /
//! editions / chapters / assets), the Merkle deploy state, and the
//! reading-progress + settings tables ported from the old SQLite store.
//!
//! All queries are runtime-checked (`sqlx::query*`, no macros) so the build
//! needs no `DATABASE_URL`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::postgres::{PgPool, PgPoolOptions};

/// The schema, embedded so migration needs no file at runtime.
const SCHEMA: &str = include_str!("schema.sql");

#[derive(Clone)]
pub struct PgStore {
    pool: PgPool,
}

// ── Row types ────────────────────────────────────────────────────────────────

/// A content leaf. Text-ish rows carry `html`+`markdown`; binary rows carry
/// `asset_hash` (bytes live in rustfs, described by an `AssetRow`).
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ChapterRow {
    pub book_slug: String,
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub file_type: String,
    pub html: Option<String>,
    pub markdown: Option<String>,
    pub asset_hash: Option<String>,
    /// audio rendition only — mp3 / sentence-marks blobs in rustfs (→ assets).
    pub audio_hash: Option<String>,
    pub marks_hash: Option<String>,
    pub content_hash: String,
    pub render_version: i32,
}

/// A content-addressed binary blob stored in rustfs (key = `content_hash`).
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct AssetRow {
    pub content_hash: String,
    pub mime: String,
    pub size: i64,
}

/// Book structure rows (for the server's catalog / `/api/books`).
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct BookRow {
    pub slug: String,
    pub label: String,
    pub description: Option<String>,
    pub collection: Option<String>,
    pub author: Option<String>,
    pub cover_hash: Option<String>,
    pub default_rendition: String,
    /// Deploy-time stamps (unix ms); 0 when never stamped. See `mark_book`.
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct RenditionRow {
    pub kind: String,
    pub label: String,
    pub default_lang: String,
    pub voice: Option<String>,
    pub manifest: bool,
    pub ord: i32,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct EditionRow {
    pub lang: String,
    pub label: String,
    pub ord: i32,
}

/// A Merkle node: a `leaf` (points at content) or a `tree` (sorted children).
/// `payload` is an opaque serialized body owned by the sync layer.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct MerkleNode {
    pub node_hash: String,
    pub kind: String,
    pub payload: String,
}

/// A claimed audio-generation task — one chapter leaf the worker must synth.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct AudioTask {
    pub book_slug: String,
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub content_hash: String,
    pub leaf_kind: String,
    pub voice: String,
    pub status: String,
    pub priority: i32,
    pub attempts: i32,
    pub error: Option<String>,
    pub enqueued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

/// Per-book (NULL slug = global) audio-task counts for the status surface.
#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct AudioTaskRollup {
    pub book_slug: Option<String>,
    pub done: i64,
    pub total: i64,
    pub failed: i64,
    pub pending: i64,
}

/// One chapter's heavy-blob + audio-readiness row for `/api/manifest/<slug>` —
/// the content-addressed index the SW prefetches (Lane B) and the readiness UX
/// reads. Text/HTML is Lane A (standard PWA cache), so it isn't here.
#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ManifestChapter {
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    /// blake3 of the chapter's source (the Merkle leaf identity, salted by
    /// render-version). The client content-addresses TEXT by this: cache the
    /// /api/file response keyed by content_hash, refetch only when it changes —
    /// the text equivalent of the audio/asset blob hashes.
    pub content_hash: String,
    /// 'markdown'|'image'|'pdf'|'html'|'data'|… — lets the client know how to
    /// fetch/render the leaf without a second round-trip.
    pub file_type: String,
    pub audio_hash: Option<String>,
    pub marks_hash: Option<String>,
    pub audio_size: Option<i64>,
    pub asset_hash: Option<String>,
    pub asset_size: Option<i64>,
    /// Audio task status (queued/running/done/failed) — `None` ⇒ no audio / never
    /// queued.
    pub status: Option<String>,
}

/// One chapter's full resource row for `/api/dag` (the WHOLE corpus, every book).
/// The client (lv-sync) turns each row into content-addressed resources (text /
/// units / spoken / audio / marks / asset) with byte sizes + fetch URLs.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct DagChapter {
    pub book_slug: String,
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub content_hash: String,
    pub file_type: String,
    /// Rendered-HTML byte length (text resources' size; units/spoken are tiny).
    pub html_bytes: Option<i64>,
    pub audio_hash: Option<String>,
    pub audio_size: Option<i64>,
    pub marks_hash: Option<String>,
    pub marks_size: Option<i64>,
    pub asset_hash: Option<String>,
    pub asset_size: Option<i64>,
}

/// One document's saved scroll position (0..1 ratio). Wire-compatible with the
/// old SQLite `ProgressEntry`.
#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ProgressEntry {
    pub path: String,
    pub scroll: f64,
    pub updated_at: i64,
}

impl PgStore {
    /// Open a pool against `database_url` (e.g.
    /// `postgres://liveview@127.0.0.1:5433/liveview`). Does not migrate.
    pub async fn open(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    /// Apply the schema idempotently (all statements are `IF NOT EXISTS`).
    ///
    /// Guarded by a session advisory lock: `CREATE TABLE IF NOT EXISTS` is NOT
    /// race-free under concurrent DDL (two callers collide on `pg_catalog` with
    /// a 23505), and the server + `liveview sync` may both migrate at startup.
    /// The whole batch runs on one pooled connection, so lock/unlock pair up.
    pub async fn migrate(&self) -> Result<(), sqlx::Error> {
        // Arbitrary fixed key — namespaces this lock to liveview migration.
        let sql =
            format!("SELECT pg_advisory_lock(8147);\n{SCHEMA}\nSELECT pg_advisory_unlock(8147);");
        self.pool.execute_many_str(&sql).await
    }

    // ── Books / renditions / editions ───────────────────────────────────────

    pub async fn upsert_book(
        &self,
        slug: &str,
        label: &str,
        description: Option<&str>,
        collection: Option<&str>,
        author: Option<&str>,
        cover_hash: Option<&str>,
        default_rendition: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO books (slug, label, description, collection, author, cover_hash, default_rendition)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (slug) DO UPDATE SET
                 label = EXCLUDED.label,
                 description = EXCLUDED.description,
                 collection = EXCLUDED.collection,
                 author = EXCLUDED.author,
                 cover_hash = EXCLUDED.cover_hash,
                 default_rendition = EXCLUDED.default_rendition",
        )
        .bind(slug)
        .bind(label)
        .bind(description)
        .bind(collection)
        .bind(author)
        .bind(cover_hash)
        .bind(default_rendition)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Stamp a book's deploy-time `created_at` / `updated_at` (unix ms).
    ///
    /// `created_at` is set once, the first time the book is stamped (still 0),
    /// then preserved. `updated_at` moves to `now` when the book's content
    /// changed this sync (`changed`), and is also backfilled from 0 on the
    /// first stamp so pre-existing books don't read as epoch. `upsert_book`
    /// deliberately leaves both columns alone; this is the only writer.
    pub async fn mark_book(&self, slug: &str, now: i64, changed: bool) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE books SET
                 created_at = CASE WHEN created_at = 0 THEN $2 ELSE created_at END,
                 updated_at = CASE WHEN $3 OR updated_at = 0 THEN $2 ELSE updated_at END
             WHERE slug = $1",
        )
        .bind(slug)
        .bind(now)
        .bind(changed)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Delete a book and (via ON DELETE CASCADE) its renditions/editions. Its
    /// chapters are removed separately by `delete_chapters_for_book`.
    pub async fn delete_book(&self, slug: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM books WHERE slug = $1")
            .bind(slug)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    // Flat columns map 1:1 to the renditions table; a wrapper struct for one
    // call site would just add indirection.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_rendition(
        &self,
        book_slug: &str,
        kind: &str,
        label: &str,
        default_lang: &str,
        voice: Option<&str>,
        manifest: bool,
        ord: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO renditions
                 (book_slug, kind, label, default_lang, voice, manifest, ord)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (book_slug, kind) DO UPDATE SET
                 label = EXCLUDED.label,
                 default_lang = EXCLUDED.default_lang,
                 voice = EXCLUDED.voice,
                 manifest = EXCLUDED.manifest,
                 ord = EXCLUDED.ord",
        )
        .bind(book_slug)
        .bind(kind)
        .bind(label)
        .bind(default_lang)
        .bind(voice)
        .bind(manifest)
        .bind(ord)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    pub async fn upsert_edition(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        label: &str,
        ord: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO editions (book_slug, rendition, lang, label, ord)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (book_slug, rendition, lang) DO UPDATE SET
                 label = EXCLUDED.label,
                 ord = EXCLUDED.ord",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(label)
        .bind(ord)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    // ── Catalog readers (server side) ────────────────────────────────────────

    pub async fn list_books(&self) -> Result<Vec<BookRow>, sqlx::Error> {
        sqlx::query_as::<_, BookRow>(
            "SELECT slug, label, description, collection, author, cover_hash, default_rendition, created_at, updated_at
             FROM books ORDER BY slug",
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_renditions(&self, book_slug: &str) -> Result<Vec<RenditionRow>, sqlx::Error> {
        sqlx::query_as::<_, RenditionRow>(
            "SELECT kind, label, default_lang, voice, manifest, ord
             FROM renditions WHERE book_slug = $1 ORDER BY ord",
        )
        .bind(book_slug)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_editions(
        &self,
        book_slug: &str,
        rendition: &str,
    ) -> Result<Vec<EditionRow>, sqlx::Error> {
        sqlx::query_as::<_, EditionRow>(
            "SELECT lang, label, ord FROM editions
             WHERE book_slug = $1 AND rendition = $2 ORDER BY ord",
        )
        .bind(book_slug)
        .bind(rendition)
        .fetch_all(&self.pool)
        .await
    }

    /// Get a chapter with overlay → base fallback: try `lang`, then
    /// `default_lang`. Returns the row + the lang actually served.
    pub async fn get_chapter_fallback(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        default_lang: &str,
        rel_path: &str,
    ) -> Result<Option<(ChapterRow, String)>, sqlx::Error> {
        if let Some(c) = self
            .get_chapter(book_slug, rendition, lang, rel_path)
            .await?
        {
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

    // ── Site tree (pre-built sidebar forest per rendition) ────────────────────

    pub async fn set_site_tree(&self, rendition: &str, json: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO site_tree (rendition, json) VALUES ($1, $2)
             ON CONFLICT (rendition) DO UPDATE SET json = EXCLUDED.json",
        )
        .bind(rendition)
        .bind(json)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    pub async fn get_site_tree(&self, rendition: &str) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, String>("SELECT json FROM site_tree WHERE rendition = $1")
            .bind(rendition)
            .fetch_optional(&self.pool)
            .await
    }

    // ── Chapters ──────────────────────────────────────────────────────────────

    pub async fn upsert_chapter(&self, c: &ChapterRow) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO chapters
                 (book_slug, rendition, lang, rel_path, file_type,
                  html, markdown, asset_hash, audio_hash, marks_hash,
                  content_hash, render_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (book_slug, rendition, lang, rel_path) DO UPDATE SET
                 file_type = EXCLUDED.file_type,
                 html = EXCLUDED.html,
                 markdown = EXCLUDED.markdown,
                 asset_hash = EXCLUDED.asset_hash,
                 -- Preserve existing audio when a re-render carries none (the
                 -- apply pass always sets these NULL; the audio worker fills them
                 -- later). COALESCE keeps the prior mp3/marks so a re-render — esp.
                 -- a content change that DIDN'T touch the spoken prose (e.g. only a
                 -- mermaid label) — doesn't blank read-aloud until a needless
                 -- re-synth. A genuinely changed audio leaf is re-enqueued and the
                 -- worker overwrites these.
                 audio_hash = COALESCE(EXCLUDED.audio_hash, chapters.audio_hash),
                 marks_hash = COALESCE(EXCLUDED.marks_hash, chapters.marks_hash),
                 content_hash = EXCLUDED.content_hash,
                 render_version = EXCLUDED.render_version",
        )
        .bind(&c.book_slug)
        .bind(&c.rendition)
        .bind(&c.lang)
        .bind(&c.rel_path)
        .bind(&c.file_type)
        .bind(&c.html)
        .bind(&c.markdown)
        .bind(&c.asset_hash)
        .bind(&c.audio_hash)
        .bind(&c.marks_hash)
        .bind(&c.content_hash)
        .bind(c.render_version)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    pub async fn get_chapter(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
    ) -> Result<Option<ChapterRow>, sqlx::Error> {
        sqlx::query_as::<_, ChapterRow>(
            "SELECT book_slug, rendition, lang, rel_path, file_type,
                    html, markdown, asset_hash, audio_hash, marks_hash,
                    content_hash, render_version
             FROM chapters
             WHERE book_slug = $1 AND rendition = $2 AND lang = $3 AND rel_path = $4",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(rel_path)
        .fetch_optional(&self.pool)
        .await
    }

    /// Record lazily-generated audio blobs onto an existing chapter (the
    /// on-demand fallback when the backfill hasn't reached it yet).
    pub async fn set_chapter_audio(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
        audio_hash: &str,
        marks_hash: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE chapters SET audio_hash = $5, marks_hash = $6
             WHERE book_slug = $1 AND rendition = $2 AND lang = $3 AND rel_path = $4",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(rel_path)
        .bind(audio_hash)
        .bind(marks_hash)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    pub async fn delete_chapter(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM chapters
             WHERE book_slug = $1 AND rendition = $2 AND lang = $3 AND rel_path = $4",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(rel_path)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    // ── Assets ──────────────────────────────────────────────────────────────

    pub async fn upsert_asset(
        &self,
        content_hash: &str,
        mime: &str,
        size: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO assets (content_hash, mime, size)
             VALUES ($1, $2, $3)
             ON CONFLICT (content_hash) DO UPDATE SET
                 mime = EXCLUDED.mime, size = EXCLUDED.size",
        )
        .bind(content_hash)
        .bind(mime)
        .bind(size)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Upsert one content-addressed narration entry (idempotent — re-syncing the
    /// same sidecar is a no-op; a regenerated text overwrites). Called by `sync`.
    pub async fn upsert_narration(
        &self,
        key: &str,
        kind: &str,
        lang: &str,
        text: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO narration (key, kind, lang, text)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (key) DO UPDATE SET
                 kind = EXCLUDED.kind, lang = EXCLUDED.lang, text = EXCLUDED.text",
        )
        .bind(key)
        .bind(kind)
        .bind(lang)
        .bind(text)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Resolve `key → text` for the narration keys present. Missing keys are
    /// simply absent (a silent step-over). One indexed `= ANY` query.
    pub async fn load_narration(
        &self,
        keys: &[String],
    ) -> Result<std::collections::HashMap<String, String>, sqlx::Error> {
        if keys.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT key, text FROM narration WHERE key = ANY($1)")
                .bind(keys)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().collect())
    }

    pub async fn get_asset(&self, content_hash: &str) -> Result<Option<AssetRow>, sqlx::Error> {
        sqlx::query_as::<_, AssetRow>(
            "SELECT content_hash, mime, size FROM assets WHERE content_hash = $1",
        )
        .bind(content_hash)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn delete_asset(&self, content_hash: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM assets WHERE content_hash = $1")
            .bind(content_hash)
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    // ── Merkle deploy state ───────────────────────────────────────────────────

    pub async fn get_merkle_node(
        &self,
        node_hash: &str,
    ) -> Result<Option<MerkleNode>, sqlx::Error> {
        sqlx::query_as::<_, MerkleNode>(
            "SELECT node_hash, kind, payload FROM merkle_nodes WHERE node_hash = $1",
        )
        .bind(node_hash)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn put_merkle_node(
        &self,
        node_hash: &str,
        kind: &str,
        payload: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO merkle_nodes (node_hash, kind, payload)
             VALUES ($1, $2, $3)
             ON CONFLICT (node_hash) DO NOTHING",
        )
        .bind(node_hash)
        .bind(kind)
        .bind(payload)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Every stored Merkle node — used to reconstruct the last-deployed DAG for
    /// diffing. Node count is ~proportional to the corpus (hundreds), so a full
    /// load is cheap.
    pub async fn all_merkle_nodes(&self) -> Result<Vec<MerkleNode>, sqlx::Error> {
        sqlx::query_as::<_, MerkleNode>("SELECT node_hash, kind, payload FROM merkle_nodes")
            .fetch_all(&self.pool)
            .await
    }

    /// All book slugs currently in pg — to prune books dropped from the corpus.
    pub async fn book_slugs(&self) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar::<_, String>("SELECT slug FROM books")
            .fetch_all(&self.pool)
            .await
    }

    /// Asset hashes referenced by no chapter (any of asset/audio/marks). These
    /// are orphaned blobs to delete from pg + rustfs after a reconcile.
    pub async fn orphan_asset_hashes(&self) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar::<_, String>(
            "SELECT content_hash FROM assets a
             WHERE NOT EXISTS (
                 SELECT 1 FROM chapters c
                 WHERE c.asset_hash = a.content_hash
                    OR c.audio_hash = a.content_hash
                    OR c.marks_hash = a.content_hash
             )
             AND NOT EXISTS (
                 SELECT 1 FROM books b WHERE b.cover_hash = a.content_hash
             )",
        )
        .fetch_all(&self.pool)
        .await
    }

    /// Current deployed Merkle root, or `None` before the first sync.
    pub async fn deploy_root(&self) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, Option<String>>("SELECT root_hash FROM deploy_root WHERE id = 1")
            .fetch_optional(&self.pool)
            .await
            .map(Option::flatten)
    }

    pub async fn set_deploy_root(&self, root_hash: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO deploy_root (id, root_hash, updated_at)
             VALUES (1, $1, $2)
             ON CONFLICT (id) DO UPDATE SET
                 root_hash = EXCLUDED.root_hash, updated_at = EXCLUDED.updated_at",
        )
        .bind(root_hash)
        .bind(now_millis())
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Notify the running server (LISTEN on `liveview_reload`) that content
    /// changed, so it reloads its catalog. Best-effort.
    pub async fn notify_reload(&self) -> Result<(), sqlx::Error> {
        sqlx::query("NOTIFY liveview_reload")
            .execute(&self.pool)
            .await
            .map(|_| ())
    }

    // ── Audio task queue ──────────────────────────────────────────────────────

    /// Enqueue (or refresh) the audio task for a chapter leaf. Idempotent: if a
    /// task already exists, a CHANGED `content_hash` re-queues it (new source →
    /// regenerate); an UNCHANGED one leaves a `running`/`done` task alone (so a
    /// re-sync doesn't redo finished work) but only refreshes `priority` upward
    /// (an interactive request can promote a queued backfill task).
    pub async fn enqueue_audio_task(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
        content_hash: &str,
        leaf_kind: &str,
        voice: &str,
        priority: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO audio_tasks
                 (book_slug, rendition, lang, rel_path, content_hash, leaf_kind,
                  voice, status, priority, attempts, enqueued_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,0,$9)
             ON CONFLICT (book_slug, rendition, lang, rel_path) DO UPDATE SET
                 leaf_kind   = EXCLUDED.leaf_kind,
                 voice       = EXCLUDED.voice,
                 priority    = GREATEST(audio_tasks.priority, EXCLUDED.priority),
                 -- new source ⇒ re-queue from scratch; same source ⇒ keep status.
                 content_hash = EXCLUDED.content_hash,
                 status      = CASE WHEN audio_tasks.content_hash <> EXCLUDED.content_hash
                                    THEN 'queued' ELSE audio_tasks.status END,
                 attempts    = CASE WHEN audio_tasks.content_hash <> EXCLUDED.content_hash
                                    THEN 0 ELSE audio_tasks.attempts END,
                 error       = CASE WHEN audio_tasks.content_hash <> EXCLUDED.content_hash
                                    THEN NULL ELSE audio_tasks.error END",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(rel_path)
        .bind(content_hash)
        .bind(leaf_kind)
        .bind(voice)
        .bind(priority)
        .bind(now_millis())
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Atomically claim the next runnable task (highest priority, oldest first),
    /// flipping it to `running`. `FOR UPDATE SKIP LOCKED` lets multiple worker
    /// slots claim distinct rows without racing. Returns `None` when the queue is
    /// drained.
    pub async fn claim_audio_task(&self) -> Result<Option<AudioTask>, sqlx::Error> {
        sqlx::query_as::<_, AudioTask>(
            "UPDATE audio_tasks SET status = 'running', started_at = $1, attempts = attempts + 1
             WHERE (book_slug, rendition, lang, rel_path) = (
                 SELECT book_slug, rendition, lang, rel_path FROM audio_tasks
                 WHERE status = 'queued'
                 ORDER BY priority DESC, enqueued_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
             )
             RETURNING book_slug, rendition, lang, rel_path, content_hash,
                       leaf_kind, voice, status, priority, attempts, error,
                       enqueued_at, started_at, finished_at",
        )
        .bind(now_millis())
        .fetch_optional(&self.pool)
        .await
    }

    /// Mark a claimed task done.
    pub async fn finish_audio_task(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE audio_tasks SET status = 'done', finished_at = $5, error = NULL
             WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(rel_path)
        .bind(now_millis())
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Mark a claimed task failed (or re-queue for another attempt, capped).
    pub async fn fail_audio_task(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
        error: &str,
        max_attempts: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE audio_tasks SET
                 status = CASE WHEN attempts >= $6 THEN 'failed' ELSE 'queued' END,
                 error = $5, finished_at = $7
             WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(rel_path)
        .bind(error)
        .bind(max_attempts)
        .bind(now_millis())
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    /// Startup reaper: a `running` task left by a crashed/restarted server is
    /// re-queued so the worker picks it up again.
    pub async fn requeue_running_audio_tasks(&self) -> Result<u64, sqlx::Error> {
        sqlx::query("UPDATE audio_tasks SET status = 'queued', started_at = NULL WHERE status = 'running'")
            .execute(&self.pool)
            .await
            .map(|r| r.rows_affected())
    }

    /// Re-queue all `failed` tasks (the `liveview tasks retry` path); scope to one
    /// book when `book_slug` is `Some`.
    pub async fn retry_failed_audio_tasks(
        &self,
        book_slug: Option<&str>,
    ) -> Result<u64, sqlx::Error> {
        let q = match book_slug {
            Some(_) => "UPDATE audio_tasks SET status='queued', attempts=0, error=NULL WHERE status='failed' AND book_slug=$1",
            None => "UPDATE audio_tasks SET status='queued', attempts=0, error=NULL WHERE status='failed'",
        };
        let mut query = sqlx::query(q);
        if let Some(s) = book_slug {
            query = query.bind(s);
        }
        query.execute(&self.pool).await.map(|r| r.rows_affected())
    }

    /// Per-book + global audio-task rollup for the status surface (the Sync sheet
    /// + the manifest readiness rollup). Returns `(book_slug, done, total,
    /// failed)` rows; a NULL `book_slug` row carries the global totals.
    pub async fn audio_task_rollup(&self) -> Result<Vec<AudioTaskRollup>, sqlx::Error> {
        sqlx::query_as::<_, AudioTaskRollup>(
            "SELECT book_slug,
                    COUNT(*) FILTER (WHERE status='done')                       AS done,
                    COUNT(*)                                                    AS total,
                    COUNT(*) FILTER (WHERE status='failed')                     AS failed,
                    COUNT(*) FILTER (WHERE status IN ('queued','running'))      AS pending
             FROM audio_tasks GROUP BY book_slug",
        )
        .fetch_all(&self.pool)
        .await
    }

    /// The audio task status for one chapter, if any (drives the per-chapter
    /// readiness UX). Returns the `status` string or `None` (no task = no audio
    /// or never queued).
    pub async fn audio_task_status(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM audio_tasks
             WHERE book_slug=$1 AND rendition=$2 AND lang=$3 AND rel_path=$4",
        )
        .bind(book_slug)
        .bind(rendition)
        .bind(lang)
        .bind(rel_path)
        .fetch_optional(&self.pool)
        .await
    }

    // ── Merkle manifest (exposed DAG for the SW) ──────────────────────────────

    /// The deploy root + its per-book child subtree hashes — the top-level
    /// manifest the SW diffs (root unchanged ⇒ nothing to sync; a changed book
    /// subtree ⇒ fetch that book's sub-manifest). Empty before the first sync.
    pub async fn manifest_books(&self) -> Result<(Option<String>, Vec<(String, String)>), sqlx::Error> {
        let root = self.deploy_root().await?;
        let children = match &root {
            Some(r) => match self.get_merkle_node(r).await? {
                Some(n) if n.kind == "tree" => {
                    serde_json::from_str::<Vec<(String, String)>>(&n.payload).unwrap_or_default()
                }
                _ => Vec::new(),
            },
            None => Vec::new(),
        };
        Ok((root, children))
    }

    /// One book's content-addressed chapters (audio + assets) with blob sizes and
    /// audio-task status, for `/api/manifest/<slug>`.
    pub async fn manifest_chapters(&self, slug: &str) -> Result<Vec<ManifestChapter>, sqlx::Error> {
        sqlx::query_as::<_, ManifestChapter>(
            "SELECT c.rendition, c.lang, c.rel_path,
                    c.content_hash, c.file_type,
                    c.audio_hash, c.marks_hash, aa.size AS audio_size,
                    c.asset_hash, ab.size AS asset_size, t.status
             FROM chapters c
             LEFT JOIN assets aa ON aa.content_hash = c.audio_hash
             LEFT JOIN assets ab ON ab.content_hash = c.asset_hash
             LEFT JOIN audio_tasks t
               ON t.book_slug = c.book_slug AND t.rendition = c.rendition
              AND t.lang = c.lang AND t.rel_path = c.rel_path
             WHERE c.book_slug = $1
             ORDER BY c.rendition, c.lang, c.rel_path",
        )
        .bind(slug)
        .fetch_all(&self.pool)
        .await
    }

    /// Every chapter in the corpus (all books) with content/audio/marks/asset
    /// hashes + sizes — the rows behind `/api/dag`, the client's full manifest.
    pub async fn dag_chapters(&self) -> Result<Vec<DagChapter>, sqlx::Error> {
        sqlx::query_as::<_, DagChapter>(
            "SELECT c.book_slug, c.rendition, c.lang, c.rel_path,
                    c.content_hash, c.file_type,
                    length(c.html)::bigint AS html_bytes,
                    c.audio_hash, aa.size AS audio_size,
                    c.marks_hash, am.size AS marks_size,
                    c.asset_hash, ab.size AS asset_size
             FROM chapters c
             LEFT JOIN assets aa ON aa.content_hash = c.audio_hash
             LEFT JOIN assets am ON am.content_hash = c.marks_hash
             LEFT JOIN assets ab ON ab.content_hash = c.asset_hash
             ORDER BY c.book_slug, c.rendition, c.lang, c.rel_path",
        )
        .fetch_all(&self.pool)
        .await
    }

    // ── Reading progress + settings (ported 1:1 from the SQLite store) ────────

    pub async fn progress_for_book(&self, slug: &str) -> Result<Vec<ProgressEntry>, sqlx::Error> {
        sqlx::query_as::<_, ProgressEntry>(
            "SELECT path, scroll, updated_at FROM progress
             WHERE path = $1 OR path LIKE $2
             ORDER BY updated_at DESC",
        )
        .bind(slug)
        .bind(format!("{slug}/%"))
        .fetch_all(&self.pool)
        .await
    }

    /// The most-recently-read chapter per (book, rendition), newest first —
    /// dedup happens in Rust. A text+audio book keeps BOTH its newest text
    /// chapter and its newest audio (`.spoken.md`) chapter, so the shelf card
    /// can show reading AND listening progress side by side; deduping by slug
    /// alone dropped whichever rendition was touched less recently. Paths may be
    /// a bare `<slug>` (no chapter), which classifies as the text rendition.
    pub async fn progress_recent_per_rendition(
        &self,
    ) -> Result<Vec<ProgressEntry>, sqlx::Error> {
        let rows = sqlx::query_as::<_, ProgressEntry>(
            "SELECT path, scroll, updated_at FROM progress ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut seen = std::collections::HashSet::new();
        Ok(rows
            .into_iter()
            .filter(|r| {
                let slug = r.path.split('/').next().unwrap_or("").to_string();
                let is_audio = r.path.ends_with(".spoken.md");
                seen.insert((slug, is_audio))
            })
            .collect())
    }

    /// Upsert one doc's scroll with last-write-wins on `ts` (client edit time;
    /// `None` ⇒ `now`). Returns `true` iff the row was written — the conditional
    /// `WHERE … < EXCLUDED.updated_at` makes a CONFLICT a no-op (0 rows) when the
    /// stored value is newer, so a stale offline replay can't clobber a fresher
    /// cross-device edit.
    pub async fn progress_upsert(
        &self,
        path: &str,
        scroll: f64,
        ts: Option<i64>,
    ) -> Result<bool, sqlx::Error> {
        let r = sqlx::query(
            "INSERT INTO progress (path, scroll, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (path) DO UPDATE SET
                 scroll = EXCLUDED.scroll, updated_at = EXCLUDED.updated_at
             WHERE progress.updated_at <= EXCLUDED.updated_at",
        )
        .bind(path)
        .bind(scroll.clamp(0.0, 1.0))
        .bind(ts.unwrap_or_else(now_millis))
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected() > 0)
    }

    pub async fn settings_all(&self) -> Result<Vec<(String, String)>, sqlx::Error> {
        sqlx::query_as::<_, (String, String)>("SELECT key, value FROM settings")
            .fetch_all(&self.pool)
            .await
    }

    /// Upsert one setting with last-write-wins on `ts` (see `progress_upsert`).
    /// Returns `true` iff the row was written (so the caller broadcasts only a real
    /// change, never a stale replay that lost the LWW comparison).
    pub async fn settings_set(
        &self,
        key: &str,
        value: &str,
        ts: Option<i64>,
    ) -> Result<bool, sqlx::Error> {
        let r = sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET
                 value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
             WHERE settings.updated_at <= EXCLUDED.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(ts.unwrap_or_else(now_millis))
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected() > 0)
    }
}

/// Run a multi-statement SQL script over a pool via the simple-query protocol.
/// sqlx's prepared path is one-statement-at-a-time; the raw connection's
/// `execute` accepts a whole script, which is what migration needs.
trait ExecuteManyStr {
    async fn execute_many_str(&self, sql: &str) -> Result<(), sqlx::Error>;
}

impl ExecuteManyStr for PgPool {
    async fn execute_many_str(&self, sql: &str) -> Result<(), sqlx::Error> {
        use sqlx::Executor;
        self.execute(sql).await.map(|_| ())
    }
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Open + migrate against `$DATABASE_URL`, or `None` to skip when unset so
    /// the default `cargo test` (and `harness hook verify`) stay hermetic. Run
    /// with: `createdb liveview_test &&
    /// DATABASE_URL=postgres:///liveview_test cargo test store::`.
    async fn store() -> Option<PgStore> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let s = PgStore::open(&url).await.expect("open");
        s.migrate().await.expect("migrate");
        Some(s)
    }

    #[tokio::test]
    async fn migrate_is_idempotent() {
        let Some(s) = store().await else { return };
        // A second migrate over an already-migrated db is a no-op, not an error.
        s.migrate().await.expect("re-migrate");
    }

    #[tokio::test]
    async fn book_rendition_edition_roundtrip() {
        let Some(s) = store().await else { return };
        s.delete_book("t-book").await.unwrap();
        s.upsert_book("t-book", "T Book", Some("blurb"), None, None, None, "text")
            .await
            .unwrap();
        s.upsert_rendition("t-book", "text", "阅读", "zh", None, true, 0)
            .await
            .unwrap();
        s.upsert_edition("t-book", "text", "zh", "中文", 0)
            .await
            .unwrap();
        // Re-upsert (idempotent) then cascade-delete.
        s.upsert_book("t-book", "T Book v2", None, None, None, None, "text")
            .await
            .unwrap();
        s.delete_book("t-book").await.unwrap();
    }

    #[tokio::test]
    async fn chapter_and_asset_roundtrip() {
        let Some(s) = store().await else { return };
        let c = ChapterRow {
            book_slug: "t-book".into(),
            rendition: "text".into(),
            lang: "zh".into(),
            rel_path: "00.md".into(),
            file_type: "markdown".into(),
            html: Some("<p>hi</p>".into()),
            markdown: Some("hi".into()),
            asset_hash: None,
            audio_hash: None,
            marks_hash: None,
            content_hash: "h0".into(),
            render_version: 1,
        };
        s.upsert_chapter(&c).await.unwrap();
        let got = s
            .get_chapter("t-book", "text", "zh", "00.md")
            .await
            .unwrap();
        assert_eq!(got.unwrap().html.as_deref(), Some("<p>hi</p>"));

        s.upsert_asset("habc", "image/png", 123).await.unwrap();
        assert_eq!(s.get_asset("habc").await.unwrap().unwrap().size, 123);

        s.delete_chapter("t-book", "text", "zh", "00.md")
            .await
            .unwrap();
        assert!(s
            .get_chapter("t-book", "text", "zh", "00.md")
            .await
            .unwrap()
            .is_none());
        s.delete_asset("habc").await.unwrap();
        assert!(s.get_asset("habc").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn merkle_and_deploy_root_roundtrip() {
        let Some(s) = store().await else { return };
        s.put_merkle_node("n1", "tree", r#"{"children":[]}"#)
            .await
            .unwrap();
        assert_eq!(s.get_merkle_node("n1").await.unwrap().unwrap().kind, "tree");
        s.set_deploy_root("root-abc").await.unwrap();
        assert_eq!(s.deploy_root().await.unwrap().as_deref(), Some("root-abc"));
    }

    #[tokio::test]
    async fn progress_and_settings_roundtrip() {
        let Some(s) = store().await else { return };
        s.progress_upsert("bk/01", 0.42, Some(1000)).await.unwrap();
        s.progress_upsert("bk/01", 0.55, Some(2000)).await.unwrap(); // newer ts wins
        // A STALE replay (older ts) must NOT clobber the newer value — last-write-
        // wins is what lets an offline device flush without overwriting a fresher
        // edit made on another device meanwhile.
        let stale = s.progress_upsert("bk/01", 0.10, Some(1500)).await.unwrap();
        assert!(!stale, "an older-ts progress write must be rejected");
        let rows = s.progress_for_book("bk").await.unwrap();
        assert!(rows
            .iter()
            .any(|r| r.path == "bk/01" && (r.scroll - 0.55).abs() < 1e-9));
        // A text + audio chapter for the same book must BOTH survive the
        // per-rendition dedup (the shelf shows reading and listening progress
        // side by side), while two text chapters collapse to the newest.
        s.progress_upsert("bk/02", 0.30, None).await.unwrap();
        s.progress_upsert("bk/00.spoken.md", 0.20, None)
            .await
            .unwrap();
        let recent = s.progress_recent_per_rendition().await.unwrap();
        assert!(recent.iter().any(|r| r.path == "bk/00.spoken.md"));
        assert_eq!(
            recent.iter().filter(|r| !r.path.ends_with(".spoken.md")
                && r.path.split('/').next() == Some("bk"))
                .count(),
            1,
            "the book's text chapters must dedup to one row",
        );

        s.settings_set("ui.rate", "1.5", Some(2000)).await.unwrap();
        let stale_set = s.settings_set("ui.rate", "1.0", Some(1000)).await.unwrap();
        assert!(!stale_set, "an older-ts setting write must be rejected");
        let all = s.settings_all().await.unwrap();
        assert!(all.iter().any(|(k, v)| k == "ui.rate" && v == "1.5"));
    }
}
