use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::config::{BookState, EditionState, RenditionKind};
use crate::server::progress::ProgressStore;
use crate::shared::TreeNode;

pub struct AppState {
    pub tx: broadcast::Sender<String>,
    /// One entry per `[[book]]` declared in the config. Always at least one
    /// (the implicit fallback config supplies a single book over cwd).
    pub books: Vec<BookState>,
    /// Sidebar forest, built from each book's default edition. Editions share
    /// structure, so this is language-independent.
    pub file_tree: RwLock<Vec<TreeNode>>,
    /// Rendered-HTML cache keyed by `"<lang>\u{0}<virtual_path>"`.
    pub rendered_cache: RwLock<HashMap<String, String>>,
    /// Reading-progress store, or `None` when no state dir is configured
    /// (`--state-dir` / `$STATE_DIRECTORY`), in which case progress is disabled
    /// and the API degrades to read-empty / write-noop.
    pub progress: Option<ProgressStore>,
    /// The `edge-tts` executable used for lazy audiobook synthesis. Must be on
    /// the service's PATH (packaged into the unit for deploy).
    pub tts_cmd: String,
    /// Default edge-tts voice; a book's `[spoken].voice` overrides it.
    pub tts_voice: String,
}

pub type SharedState = Arc<AppState>;

pub struct Resolution<'a> {
    pub edition: &'a EditionState,
    pub rest: &'a str,
}

/// Cache key combining language edition + virtual path — distinct editions of
/// the same logical path render to different HTML.
pub fn cache_key(lang: &str, virtual_path: &str) -> String {
    format!("{lang}\u{0}{virtual_path}")
}

impl AppState {
    pub fn book(&self, slug: &str) -> Option<&BookState> {
        self.books.iter().find(|b| b.slug == slug)
    }

    /// Resolve a wire-side virtual path (`<slug>` or `<slug>/<rest>`) plus a
    /// `rendition` kind and optional `lang` to the backing edition + the rest
    /// relative to that edition's source. The book picks `rendition` (else its
    /// default rendition); the rendition picks `lang` (else its default lang).
    /// A requested `rendition`/`lang` the book/rendition doesn't offer returns
    /// `None` (→ 404, which the frontend treats as "fall back").
    pub fn resolve_path<'a>(
        &'a self,
        virtual_path: &'a str,
        rendition: RenditionKind,
        lang: Option<&str>,
    ) -> Option<Resolution<'a>> {
        let (slug, rest) = virtual_path.split_once('/').unwrap_or((virtual_path, ""));
        let book = self.book(slug)?;
        let rendition = book
            .rendition(rendition)
            .unwrap_or(book.default_rendition());
        let edition = match lang {
            Some(l) => rendition.edition(l)?,
            None => rendition.default_edition(),
        };
        Some(Resolution { edition, rest })
    }
}
