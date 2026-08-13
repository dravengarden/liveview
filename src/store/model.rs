//! Backend-neutral storage records shared by the server, sync pipeline, and
//! concrete adapters. SQLx can decode these records, but their ownership and
//! semantics do not belong to PostgreSQL.

use serde::Serialize;

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ChapterRecord {
    pub book_slug: String,
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub file_type: String,
    pub html: Option<String>,
    pub markdown: Option<String>,
    pub asset_hash: Option<String>,
    pub audio_hash: Option<String>,
    pub marks_hash: Option<String>,
    pub content_hash: String,
    pub render_version: i32,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct AssetRecord {
    pub content_hash: String,
    pub mime: String,
    pub size: i64,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct LegacyAudioAsset {
    pub content_hash: String,
    pub size: i64,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct BookRecord {
    pub slug: String,
    pub label: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub collection: Option<String>,
    pub author: Option<String>,
    pub cover_hash: Option<String>,
    pub backdrop_hash: Option<String>,
    pub card_backdrop_hash: Option<String>,
    pub default_rendition: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct BookUpsert<'a> {
    pub slug: &'a str,
    pub label: &'a str,
    pub description: Option<&'a str>,
    pub tags: &'a [String],
    pub collection: Option<&'a str>,
    pub author: Option<&'a str>,
    pub cover_hash: Option<&'a str>,
    pub backdrop_hash: Option<&'a str>,
    pub card_backdrop_hash: Option<&'a str>,
    pub default_rendition: &'a str,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct RenditionRecord {
    pub kind: String,
    pub label: String,
    pub default_lang: String,
    pub voice: Option<String>,
    pub manifest: bool,
    pub ord: i32,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct EditionRecord {
    pub lang: String,
    pub label: String,
    pub ord: i32,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct MerkleNode {
    pub node_hash: String,
    pub kind: String,
    pub payload: String,
}

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

pub struct AudioTaskUpsert<'a> {
    pub book_slug: &'a str,
    pub rendition: &'a str,
    pub lang: &'a str,
    pub rel_path: &'a str,
    pub content_hash: &'a str,
    pub leaf_kind: &'a str,
    pub voice: &'a str,
    pub priority: i32,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct AudioTaskRollup {
    pub book_slug: Option<String>,
    pub done: i64,
    pub total: i64,
    pub failed: i64,
    pub pending: i64,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ManifestChapter {
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub content_hash: String,
    pub file_type: String,
    pub audio_hash: Option<String>,
    pub marks_hash: Option<String>,
    pub audio_size: Option<i64>,
    pub audio_mime: Option<String>,
    pub asset_hash: Option<String>,
    pub asset_size: Option<i64>,
    pub status: Option<String>,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct DagChapter {
    pub book_slug: String,
    pub rendition: String,
    pub lang: String,
    pub rel_path: String,
    pub content_hash: String,
    pub file_type: String,
    pub html_bytes: Option<i64>,
    pub audio_hash: Option<String>,
    pub audio_size: Option<i64>,
    pub audio_mime: Option<String>,
    pub marks_hash: Option<String>,
    pub marks_size: Option<i64>,
    pub asset_hash: Option<String>,
    pub asset_size: Option<i64>,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct DagArtwork {
    pub book_slug: String,
    pub cover_hash: Option<String>,
    pub cover_size: Option<i64>,
    pub backdrop_hash: Option<String>,
    pub backdrop_size: Option<i64>,
    pub card_backdrop_hash: Option<String>,
    pub card_backdrop_size: Option<i64>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ProgressEntry {
    pub path: String,
    pub scroll: f64,
    pub updated_at: i64,
}
