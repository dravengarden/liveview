//! In-memory book catalog, loaded from the postgres content store.
//!
//! Holds the structure the server needs to answer `/api/books` and to resolve a
//! request (slug + rendition token + lang) to a concrete `(rendition, lang)`
//! before fetching content. Reloaded after each `liveview sync`.

use crate::config::RenditionKind;
use crate::store::content::ContentStore;

pub struct EditionMeta {
    pub lang: String,
    pub label: String,
}

pub struct RenditionMeta {
    pub kind: RenditionKind,
    pub label: String,
    pub default_lang: String,
    /// audio rendition only — edge-tts voice for on-demand (lazy) synthesis.
    pub voice: Option<String>,
    pub manifest: bool,
    pub editions: Vec<EditionMeta>,
}

pub struct BookMeta {
    pub slug: String,
    pub label: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub collection: Option<String>,
    pub author: Option<String>,
    pub cover_hash: Option<String>,
    pub backdrop_hash: Option<String>,
    pub card_backdrop_hash: Option<String>,
    pub default_rendition: RenditionKind,
    pub renditions: Vec<RenditionMeta>,
    /// Deploy-time stamps (unix ms), 0 when unstamped. See `PgStore::mark_book`.
    pub created_at: i64,
    pub updated_at: i64,
}

impl BookMeta {
    pub fn rendition(&self, kind: RenditionKind) -> Option<&RenditionMeta> {
        self.renditions.iter().find(|r| r.kind == kind)
    }

    /// The default rendition (by `default_rendition`, else the first).
    pub fn default_rendition(&self) -> &RenditionMeta {
        self.rendition(self.default_rendition)
            .or_else(|| self.renditions.first())
            .expect("a book always has at least one rendition")
    }
}

#[derive(Default)]
pub struct Catalog {
    pub books: Vec<BookMeta>,
}

impl Catalog {
    /// Build the catalog from any content store (postgres or filesystem).
    pub async fn load(store: &dyn ContentStore) -> Result<Self, String> {
        let mut books = Vec::new();
        for b in store.list_books().await.map_err(|e| e.to_string())? {
            let mut renditions = Vec::new();
            for r in store
                .list_renditions(&b.slug)
                .await
                .map_err(|e| e.to_string())?
            {
                let editions = store
                    .list_editions(&b.slug, &r.kind)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .map(|e| EditionMeta {
                        lang: e.lang,
                        label: e.label,
                    })
                    .collect();
                renditions.push(RenditionMeta {
                    kind: RenditionKind::parse(&r.kind).unwrap_or(RenditionKind::Text),
                    label: r.label,
                    default_lang: r.default_lang,
                    voice: r.voice,
                    manifest: r.manifest,
                    editions,
                });
            }
            books.push(BookMeta {
                slug: b.slug,
                label: b.label,
                description: b.description,
                tags: b.tags,
                collection: b.collection,
                author: b.author,
                cover_hash: b.cover_hash,
                backdrop_hash: b.backdrop_hash,
                card_backdrop_hash: b.card_backdrop_hash,
                default_rendition: RenditionKind::parse(&b.default_rendition)
                    .unwrap_or(RenditionKind::Text),
                renditions,
                created_at: b.created_at,
                updated_at: b.updated_at,
            });
        }
        Ok(Self { books })
    }

    pub fn book(&self, slug: &str) -> Option<&BookMeta> {
        self.books.iter().find(|b| b.slug == slug)
    }
}
