//! Filesystem content backend for `liveview preview` — serves ONE local corpus
//! through the SAME reader + render engines as the deployed server, with no
//! `sync`/postgres/rustfs. Chapters render on demand (same `render_file`),
//! binary assets are content-addressed into an in-memory map, the sidebar comes
//! from the same `build_virtual_tree`. So "looks right in preview" == "looks
//! right deployed" — which is the whole point of the chart-review visual QA.
//!
//! User state (progress/settings) and audio are ephemeral/no-op here: preview
//! is a throwaway QA server, not a reading session.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::config::{BookState, RenditionKind};
use crate::server::tree::build_virtual_tree;
use crate::shared::FileType;
use crate::store::content::{BlobStore, ContentStore};
use crate::store::pg::{
    AssetRow, AudioTaskRollup, BookRow, ChapterRow, DagArtwork, DagChapter, EditionRow,
    ManifestChapter, ProgressEntry, RenditionRow,
};

pub struct FsStore {
    books: Vec<BookState>,
    /// slug → cover blob hash (covers are hashed + cached at construction).
    covers: HashMap<String, String>,
    /// slug → wide LiveView artwork blob hash.
    backdrops: HashMap<String, String>,
    /// slug → compact opaque shelf-card rendition blob hash.
    card_backdrops: HashMap<String, String>,
    /// content_hash → (bytes, mime). Covers preloaded; chapter images + any
    /// on-demand audio land here lazily.
    blobs: Mutex<HashMap<String, (Vec<u8>, String)>>,
    /// rendition kind str → precomputed sidebar forest JSON.
    trees: HashMap<String, String>,
}

fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn mime_for(rel_path: &str) -> String {
    mime_guess::from_path(rel_path)
        .first_or_octet_stream()
        .to_string()
}

fn file_type_str(ft: &FileType) -> &'static str {
    match ft {
        FileType::Markdown => "markdown",
        FileType::Image => "image",
        FileType::Pdf => "pdf",
        FileType::Html => "html",
        FileType::Csv => "csv",
        FileType::Json => "json",
        FileType::Excalidraw => "excalidraw",
        FileType::Latex => "latex",
        FileType::Typst => "typst",
        FileType::InteractiveView => "interactive-view",
        FileType::Unknown => "unknown",
    }
}

impl FsStore {
    /// Build the in-memory backend from a resolved corpus: preload covers and
    /// precompute the per-rendition sidebar trees (cheap; books rarely huge).
    pub fn new(books: Vec<BookState>) -> Self {
        let mut covers = HashMap::new();
        let mut backdrops = HashMap::new();
        let mut card_backdrops = HashMap::new();
        let mut blobs: HashMap<String, (Vec<u8>, String)> = HashMap::new();
        for b in &books {
            if let Some(path) = &b.cover {
                if let Ok(bytes) = std::fs::read(path) {
                    let hash = blake3_hex(&bytes);
                    let mime = mime_guess::from_path(path)
                        .first_or_octet_stream()
                        .to_string();
                    covers.insert(b.slug.clone(), hash.clone());
                    blobs.insert(hash, (bytes, mime));
                }
            }
            if let Some(path) = &b.backdrop {
                if let Ok(bytes) = std::fs::read(path) {
                    let hash = blake3_hex(&bytes);
                    let mime = mime_guess::from_path(path)
                        .first_or_octet_stream()
                        .to_string();
                    backdrops.insert(b.slug.clone(), hash.clone());
                    blobs.insert(hash, (bytes.clone(), mime));
                    if let Ok(card_bytes) = crate::artwork::card_backdrop(&bytes) {
                        let card_hash = blake3_hex(&card_bytes);
                        card_backdrops.insert(b.slug.clone(), card_hash.clone());
                        blobs.insert(card_hash, (card_bytes, "image/jpeg".to_string()));
                    }
                }
            }
        }
        let mut trees = HashMap::new();
        for kind in [RenditionKind::Text, RenditionKind::Audio] {
            let forest = build_virtual_tree(&books, kind);
            if let Ok(json) = serde_json::to_string(&forest) {
                trees.insert(kind.as_str().to_string(), json);
            }
        }
        Self {
            books,
            covers,
            backdrops,
            card_backdrops,
            blobs: Mutex::new(blobs),
            trees,
        }
    }

    fn book(&self, slug: &str) -> Option<&BookState> {
        self.books.iter().find(|b| b.slug == slug)
    }
}

#[async_trait]
impl ContentStore for FsStore {
    async fn list_books(&self) -> Result<Vec<BookRow>, String> {
        Ok(self
            .books
            .iter()
            .map(|b| BookRow {
                slug: b.slug.clone(),
                label: b.label.clone(),
                description: b.description.clone(),
                tags: b.tags.clone(),
                collection: b.collection.clone(),
                author: b.author.clone(),
                cover_hash: self.covers.get(&b.slug).cloned(),
                backdrop_hash: self.backdrops.get(&b.slug).cloned(),
                card_backdrop_hash: self.card_backdrops.get(&b.slug).cloned(),
                default_rendition: b.default_rendition.as_str().to_string(),
                created_at: 0,
                updated_at: 0,
            })
            .collect())
    }

    async fn list_renditions(&self, book_slug: &str) -> Result<Vec<RenditionRow>, String> {
        let Some(b) = self.book(book_slug) else {
            return Ok(vec![]);
        };
        Ok(b.renditions
            .iter()
            .enumerate()
            .map(|(i, r)| RenditionRow {
                kind: r.kind.as_str().to_string(),
                label: r.label.clone(),
                default_lang: r.default_lang.clone(),
                voice: r.voice.clone(),
                manifest: r.manifest,
                ord: i as i32,
            })
            .collect())
    }

    async fn list_editions(
        &self,
        book_slug: &str,
        rendition: &str,
    ) -> Result<Vec<EditionRow>, String> {
        let Some(kind) = RenditionKind::parse(rendition) else {
            return Ok(vec![]);
        };
        let Some(rend) = self.book(book_slug).and_then(|b| b.rendition(kind)) else {
            return Ok(vec![]);
        };
        Ok(rend
            .editions
            .iter()
            .enumerate()
            .map(|(i, e)| EditionRow {
                lang: e.lang.clone(),
                label: e.label.clone(),
                ord: i as i32,
            })
            .collect())
    }

    async fn get_chapter(
        &self,
        book_slug: &str,
        rendition: &str,
        lang: &str,
        rel_path: &str,
    ) -> Result<Option<ChapterRow>, String> {
        let Some(kind) = RenditionKind::parse(rendition) else {
            return Ok(None);
        };
        let Some(ed) = self
            .book(book_slug)
            .and_then(|b| b.rendition(kind))
            .and_then(|r| r.edition(lang))
        else {
            return Ok(None);
        };
        let path = ed.source.join(rel_path);
        if !path.is_file() {
            return Ok(None);
        }
        let ft = FileType::from_path(rel_path);
        let mut row = ChapterRow {
            book_slug: book_slug.to_string(),
            rendition: kind.as_str().to_string(),
            lang: lang.to_string(),
            rel_path: rel_path.to_string(),
            file_type: file_type_str(&ft).to_string(),
            html: None,
            markdown: None,
            asset_hash: None,
            audio_hash: None,
            marks_hash: None,
            content_hash: String::new(),
            render_version: 0,
        };
        if matches!(ft, FileType::Image | FileType::Pdf) {
            // Binary: cache the bytes content-addressed; api_raw fetches them via
            // BlobStore::get(asset_hash) — the same FsStore instance.
            let bytes =
                std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            let hash = blake3_hex(&bytes);
            let mime = mime_for(rel_path);
            self.blobs
                .lock()
                .unwrap()
                .entry(hash.clone())
                .or_insert((bytes, mime));
            row.content_hash = hash.clone();
            row.asset_hash = Some(hash);
        } else {
            let src = std::fs::read_to_string(&path)
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            row.content_hash = blake3_hex(src.as_bytes());
            row.html = Some(crate::server::renderer::render_file(&src, &ft));
            row.markdown = Some(src);
        }
        Ok(Some(row))
    }

    async fn get_asset(&self, content_hash: &str) -> Result<Option<AssetRow>, String> {
        Ok(self
            .blobs
            .lock()
            .unwrap()
            .get(content_hash)
            .map(|(b, m)| AssetRow {
                content_hash: content_hash.to_string(),
                mime: m.clone(),
                size: b.len() as i64,
            }))
    }

    async fn upsert_asset(&self, _hash: &str, _mime: &str, _size: i64) -> Result<(), String> {
        // Metadata already rides with the bytes in the blob map (put_if_absent).
        Ok(())
    }
    async fn load_narration(
        &self,
        _keys: &[String],
    ) -> Result<std::collections::HashMap<String, String>, String> {
        // The filesystem preview has no narration table — non-prose stays a
        // silent step-over (preview is for render/chart QA, not listening).
        Ok(std::collections::HashMap::new())
    }

    async fn get_site_tree(&self, rendition: &str) -> Result<Option<String>, String> {
        Ok(self.trees.get(rendition).cloned())
    }

    async fn set_chapter_audio(
        &self,
        _book_slug: &str,
        _rendition: &str,
        _lang: &str,
        _rel_path: &str,
        _audio_hash: &str,
        _marks_hash: &str,
    ) -> Result<(), String> {
        // Ephemeral preview: on-demand audio re-synthesizes each run, so there's
        // nothing to persist.
        Ok(())
    }

    async fn progress_for_book(&self, _slug: &str) -> Result<Vec<ProgressEntry>, String> {
        Ok(vec![])
    }
    async fn progress_recent_per_rendition(&self) -> Result<Vec<ProgressEntry>, String> {
        Ok(vec![])
    }
    async fn progress_upsert(
        &self,
        _path: &str,
        _scroll: f64,
        _ts: Option<i64>,
    ) -> Result<bool, String> {
        Ok(false) // preview keeps no user state
    }
    async fn settings_all(&self) -> Result<Vec<(String, String)>, String> {
        Ok(vec![])
    }
    async fn settings_set(
        &self,
        _key: &str,
        _value: &str,
        _ts: Option<i64>,
    ) -> Result<bool, String> {
        Ok(false) // preview keeps no user state
    }
    async fn audio_task_rollup(&self) -> Result<Vec<AudioTaskRollup>, String> {
        Ok(Vec::new()) // preview has no task queue
    }
    async fn manifest_books(&self) -> Result<(Option<String>, Vec<(String, String)>), String> {
        Ok((None, Vec::new())) // preview has no deploy/manifest
    }
    async fn manifest_chapters(&self, _slug: &str) -> Result<Vec<ManifestChapter>, String> {
        Ok(Vec::new())
    }
    async fn dag_chapters(&self) -> Result<Vec<DagChapter>, String> {
        Ok(Vec::new()) // preview has no deploy/manifest
    }
    async fn dag_artwork(&self) -> Result<Vec<DagArtwork>, String> {
        Ok(Vec::new()) // preview has no deploy/manifest
    }
}

#[async_trait]
impl BlobStore for FsStore {
    async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        self.blobs
            .lock()
            .unwrap()
            .get(key)
            .map(|(b, _)| b.clone())
            .ok_or_else(|| format!("blob {key} not found"))
    }
    async fn put_if_absent(&self, key: &str, bytes: Vec<u8>, mime: &str) -> Result<(), String> {
        self.blobs
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_insert((bytes, mime.to_string()));
        Ok(())
    }
}
