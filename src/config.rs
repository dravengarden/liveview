//! Config file — virtual books + global defaults.
//!
//! A *book* is a curated reading view that appears as a card on the landing
//! "bookshelf" and as a top-level folder in the sidebar. Each book has one or
//! more *renditions* — a whole-book reading mode (`text` to read, `audio` to
//! listen) — and each rendition has one or more *editions* (one per language)
//! that share the same logical structure but live in different source dirs.
//! Switching language keeps your logical position and swaps the edition;
//! switching rendition swaps the whole book (its spine and source roots).
//!
//! The on-the-wire path of any file is `<slug>/<rel-path-under-source>` where
//! `rest` is relative to the *selected rendition's* edition source; the
//! requested `rendition`+`lang` select which edition. The slug is derived from
//! `label` (lower-kebab) unless explicitly overridden.
//!
//! A single-language book is the degenerate case: declare `source` directly
//! on the book and liveview synthesises one implicit edition. `[[mount]]` is
//! accepted as a legacy alias for `[[book]]`.
//!
//! Three on-disk formats are accepted; the format is inferred from the file
//! extension: `.toml`, `.yaml` / `.yml`, `.json`. The harness side feeds
//! liveview by exporting CUE to one of these — liveview itself never
//! touches CUE.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub server: ServerCfg,
    #[serde(default)]
    pub defaults: Defaults,
    /// One entry per `[[book]]` (or the legacy `[[mount]]` alias).
    #[serde(default, rename = "book", alias = "mount")]
    pub books: Vec<BookCfg>,
    /// One entry per `[[shelf]]` — a directory whose immediate subdirectories
    /// are auto-discovered as `book.toml`-driven books (see `BookManifest`).
    #[serde(default, rename = "shelf")]
    pub shelves: Vec<ShelfCfg>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerCfg {
    #[serde(default = "default_host")]
    pub host: String,
    pub port: Option<u16>,
    #[serde(default = "default_debounce")]
    pub debounce_ms: u64,
    #[serde(default)]
    pub open: bool,
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: None,
            debounce_ms: default_debounce(),
            open: false,
        }
    }
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn default_debounce() -> u64 {
    200
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defaults {
    /// Inherited by mounts that don't set their own `includes`. Empty here
    /// means liveview substitutes its built-in include list.
    #[serde(default)]
    pub includes: Vec<String>,
    /// Stacked under every mount's own excludes. Empty here means liveview
    /// substitutes its built-in exclude list.
    #[serde(default)]
    pub excludes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookCfg {
    pub label: String,
    pub slug: Option<String>,
    /// One-line blurb shown on the landing page card. Optional.
    pub description: Option<String>,
    /// Which edition to show first. Defaults to the first edition declared.
    pub default_lang: Option<String>,
    /// Shorthand for a single-edition book: the source dir directly. Mutually
    /// exclusive with `[[book.edition]]`.
    pub source: Option<PathBuf>,
    /// Inherited by editions that don't set their own `includes`.
    pub includes: Option<Vec<String>>,
    /// Inherited by editions that don't set their own `excludes`.
    pub excludes: Option<Vec<String>>,
    /// Shared logical ordering, applied to every edition's tree.
    pub layout: Option<Layout>,
    /// One per language. Order is preserved for the language switcher.
    #[serde(default, rename = "edition")]
    pub editions: Vec<EditionCfg>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditionCfg {
    /// BCP-47-ish language code (`en`, `zh`, `ja`, ...). Used in the API
    /// `lang` param and shown in the switcher unless `label` is set.
    pub lang: String,
    /// Display name in the language switcher. Defaults to `lang`.
    pub label: Option<String>,
    pub source: PathBuf,
    pub includes: Option<Vec<String>>,
    pub excludes: Option<Vec<String>>,
}

/// A `[[shelf]]` source — a directory whose immediate subdirectories are
/// scanned for a `book.toml` manifest. Each manifest-bearing subdir becomes a
/// book rendered as a flat, H1-titled spine (filenames/dirs never surface).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShelfCfg {
    /// Directory to scan, relative to the config file (or absolute).
    pub path: PathBuf,
}

/// `book.toml` — the per-book manifest that lives inside the book directory
/// (cf. books/ARCHITECTURE.md §5). Sections liveview doesn't consume
/// (`[provenance]`, …) are ignored.
///
/// Two shapes are accepted for backward-compat:
///   * **legacy** — top-level `[langs]` (+ optional `[features]`/`[spoken]`),
///     no `[renditions]`: synthesised into a single `text` rendition over
///     `<book>/<lang>/`, exactly as before.
///   * **renditions** — an explicit `[renditions.<kind>]` table per mode. Each
///     rendition picks its own langs and (for `audio`) voice.
#[derive(Debug, Deserialize)]
pub struct BookManifest {
    /// Defaults to the directory name when omitted.
    pub slug: Option<String>,
    pub title: String,
    pub default_lang: String,
    /// Which rendition opens first. Defaults to `text`; must name a declared
    /// (or, in legacy shape, the synthesised) rendition.
    pub default_rendition: Option<RenditionKind>,
    /// Cover image, relative to the book dir. When unset, a `cover.{jpg,png,
    /// webp}` in the book dir is auto-detected.
    pub cover: Option<PathBuf>,
    /// `[langs.<code>]` → label. The default lang is the base edition; every
    /// other language is an overlay that falls back to it (resolved server-side
    /// for raw assets). In the renditions shape these are the book-wide
    /// defaults a rendition inherits when it omits its own `langs`.
    #[serde(default)]
    pub langs: HashMap<String, LangManifest>,
    /// Explicit per-mode renditions. Absent ⇒ legacy single-`text` synthesis.
    #[serde(default)]
    pub renditions: HashMap<RenditionKind, RenditionManifest>,
}

/// One `[renditions.<kind>]` entry.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenditionManifest {
    /// Display name of the mode toggle ("阅读" / "听书"). Defaults to the kind.
    pub label: Option<String>,
    /// Languages this rendition offers. Defaults to the book's top-level
    /// `[langs]` keys when omitted.
    pub langs: Option<Vec<String>>,
    /// Which language opens first. Defaults to the book's `default_lang`.
    pub default_lang: Option<String>,
    /// `audio` only — the edge-tts voice (default: the server's voice).
    pub voice: Option<String>,
    /// Documented/accepted but not consumed: which rendition this one derives
    /// from (e.g. audio narrated `from = "text"`). liveview doesn't act on it.
    #[allow(dead_code)]
    pub from: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LangManifest {
    /// Display name in the switcher; defaults to the language code.
    pub label: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    /// Sibling ordering at THIS level. Each entry matches a child by name;
    /// trailing `/` means "directory named X", no trailing `/` means
    /// "file named X". Entries listed here come first in the given order;
    /// remaining children fall back to dir-then-alpha.
    #[serde(default)]
    pub order: Vec<String>,
    /// Per-child Layout overrides — keyed by direct-child directory name.
    /// Enables curation at arbitrary depth: each `subtree[name]` is the
    /// Layout that applies to the children of the `<name>` directory.
    #[serde(default)]
    pub subtree: HashMap<String, Layout>,
}

/// A reading mode. `text` is read on screen; `audio` is the audiobook track
/// (its spine is the `*.spoken.md` chapters under `<book>/audio/<lang>/`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenditionKind {
    Text,
    Audio,
}

impl RenditionKind {
    /// Wire token, also the default mode label.
    pub fn as_str(self) -> &'static str {
        match self {
            RenditionKind::Text => "text",
            RenditionKind::Audio => "audio",
        }
    }

    /// Parse the `?rendition=` query token. Unknown ⇒ `None` (caller decides).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "text" => Some(RenditionKind::Text),
            "audio" => Some(RenditionKind::Audio),
            _ => None,
        }
    }
}

/// Resolved language edition — canonical source path + compiled globsets.
#[derive(Clone)]
pub struct EditionState {
    pub lang: String,
    pub label: String,
    pub source: PathBuf,
    pub include_set: GlobSet,
    pub exclude_set: GlobSet,
}

/// Resolved rendition — one reading mode of a book, with its own languages and
/// its own spine (the per-language source roots and the spine differ by mode:
/// text reads `<book>/<lang>/`, audio reads `<book>/audio/<lang>/`).
#[derive(Clone)]
pub struct RenditionState {
    pub kind: RenditionKind,
    /// Mode-toggle label ("阅读" / "听书").
    pub label: String,
    /// Which edition opens first (by `default_lang`, falling back to the first).
    pub default_lang: String,
    /// `audio` only — per-book edge-tts voice override (else the server voice).
    pub voice: Option<String>,
    /// Shared logical ordering applied to every edition's tree (text only;
    /// audio spines are explicit `.spoken.md` files in filename order).
    pub layout: Option<Layout>,
    /// `true` for a `book.toml`-driven rendition: the sidebar is a flat list of
    /// section titles (each chapter's H1), filenames/dirs hidden. `false` for a
    /// plain `[[book]]`/`[[mount]]` whose sidebar is the filesystem tree.
    pub manifest: bool,
    /// Always non-empty. `default_lang` names which one opens first.
    pub editions: Vec<EditionState>,
}

impl RenditionState {
    /// The edition matching `lang`, or `None`.
    pub fn edition(&self, lang: &str) -> Option<&EditionState> {
        self.editions.iter().find(|e| e.lang == lang)
    }

    /// The default edition (by `default_lang`, falling back to the first).
    pub fn default_edition(&self) -> &EditionState {
        self.edition(&self.default_lang)
            .or_else(|| self.editions.first())
            .expect("rendition always has at least one edition")
    }
}

/// Resolved book — metadata plus one or more renditions.
#[derive(Clone)]
pub struct BookState {
    pub label: String,
    pub slug: String,
    pub description: Option<String>,
    /// Resolved absolute path to the cover image, when one exists.
    pub cover: Option<PathBuf>,
    /// Which rendition opens first.
    pub default_rendition: RenditionKind,
    /// Always non-empty.
    pub renditions: Vec<RenditionState>,
}

impl BookState {
    /// The rendition of the given `kind`, or `None`.
    pub fn rendition(&self, kind: RenditionKind) -> Option<&RenditionState> {
        self.renditions.iter().find(|r| r.kind == kind)
    }

    /// The default rendition (by `default_rendition`, falling back to the first).
    pub fn default_rendition(&self) -> &RenditionState {
        self.rendition(self.default_rendition)
            .or_else(|| self.renditions.first())
            .expect("book always has at least one rendition")
    }
}

/// Fully resolved server config: per-process state extracted from `Config`
/// plus per-edition globsets compiled and source paths canonicalized.
pub struct Resolved {
    pub host: String,
    pub port: Option<u16>,
    pub debounce_ms: u64,
    pub open: bool,
    pub books: Vec<BookState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Toml,
    Yaml,
    Json,
}

impl Format {
    fn from_path(path: &Path) -> Result<Self, String> {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        match ext.as_deref() {
            Some("toml") => Ok(Format::Toml),
            Some("yaml" | "yml") => Ok(Format::Yaml),
            Some("json") => Ok(Format::Json),
            Some(other) => Err(format!(
                "{}: unsupported extension {:?} (want .toml / .yaml / .yml / .json)",
                path.display(),
                other
            )),
            None => Err(format!(
                "{}: missing extension (want .toml / .yaml / .yml / .json)",
                path.display()
            )),
        }
    }
}

impl Config {
    /// Load + validate from disk. Format is inferred from the extension.
    pub fn load(path: &Path) -> Result<Self, String> {
        let format = Format::from_path(path)?;
        let raw =
            std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let cfg =
            Self::parse(&raw, format).map_err(|e| format!("parse {}: {e}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn parse(raw: &str, format: Format) -> Result<Self, String> {
        match format {
            Format::Toml => toml::from_str(raw).map_err(|e| e.to_string()),
            Format::Yaml => serde_yml::from_str(raw).map_err(|e| e.to_string()),
            Format::Json => serde_json::from_str(raw).map_err(|e| e.to_string()),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.books.is_empty() && self.shelves.is_empty() {
            return Err("config: at least one [[book]] or [[shelf]] required".to_string());
        }
        let mut seen = HashSet::new();
        for b in &self.books {
            let slug = b.slug.clone().unwrap_or_else(|| slugify(&b.label));
            if slug.is_empty() {
                return Err(format!(
                    "book {:?}: label produced empty slug — set `slug = \"...\"` explicitly",
                    b.label
                ));
            }
            if slug.contains('/') {
                return Err(format!(
                    "book {:?}: slug {:?} must not contain '/'",
                    b.label, slug
                ));
            }
            if !seen.insert(slug.clone()) {
                return Err(format!("duplicate book slug {:?}", slug));
            }

            // Exactly one of `source` (shorthand) / `[[book.edition]]`.
            match (b.source.is_some(), b.editions.is_empty()) {
                (true, false) => {
                    return Err(format!(
                        "book {:?}: set EITHER `source` (single edition) OR \
                         [[book.edition]] entries, not both",
                        b.label
                    ));
                }
                (false, true) => {
                    return Err(format!(
                        "book {:?}: needs a `source` or at least one [[book.edition]]",
                        b.label
                    ));
                }
                _ => {}
            }

            // Edition language codes must be unique and non-empty.
            let mut langs = HashSet::new();
            for e in &b.editions {
                if e.lang.is_empty() {
                    return Err(format!("book {:?}: edition with empty `lang`", b.label));
                }
                if !langs.insert(e.lang.clone()) {
                    return Err(format!(
                        "book {:?}: duplicate edition lang {:?}",
                        b.label, e.lang
                    ));
                }
            }

            // `default_lang`, if set, must name a real edition (or, for a
            // shorthand book, it labels the synthesised edition — any value ok).
            if let (Some(dl), false) = (b.default_lang.as_deref(), b.editions.is_empty()) {
                if !b.editions.iter().any(|e| e.lang == dl) {
                    return Err(format!(
                        "book {:?}: default_lang {:?} is not one of its editions",
                        b.label, dl
                    ));
                }
            }
        }
        Ok(())
    }

    /// Resolve relative `source` paths against `config_dir` (the directory
    /// of the config file). Compiles globsets; fails if a source directory
    /// is missing or a glob is invalid.
    pub fn resolve(self, config_dir: &Path) -> Result<Resolved, String> {
        let default_includes = if self.defaults.includes.is_empty() {
            builtin_includes()
        } else {
            self.defaults.includes.clone()
        };
        let default_excludes = if self.defaults.excludes.is_empty() {
            builtin_excludes()
        } else {
            self.defaults.excludes.clone()
        };

        let mut books = Vec::with_capacity(self.books.len());
        for b in self.books {
            let slug = b.slug.clone().unwrap_or_else(|| slugify(&b.label));

            // Normalise to a list of (lang, label, source, includes, excludes).
            // A shorthand `source` becomes a single edition whose lang is
            // `default_lang` (or "default").
            let raw_editions: Vec<EditionCfg> = if let Some(source) = b.source {
                vec![EditionCfg {
                    lang: b
                        .default_lang
                        .clone()
                        .unwrap_or_else(|| "default".to_string()),
                    label: None,
                    source,
                    includes: None,
                    excludes: None,
                }]
            } else {
                b.editions
            };

            let mut editions = Vec::with_capacity(raw_editions.len());
            for e in raw_editions {
                let abs_source = if e.source.is_absolute() {
                    e.source.clone()
                } else {
                    config_dir.join(&e.source)
                };
                let source = abs_source.canonicalize().map_err(|err| {
                    format!(
                        "book {:?} ({}): source {} not found: {err}",
                        b.label,
                        e.lang,
                        abs_source.display()
                    )
                })?;
                if !source.is_dir() {
                    return Err(format!(
                        "book {:?} ({}): source {} is not a directory",
                        b.label,
                        e.lang,
                        source.display()
                    ));
                }

                // includes: edition → book → built-in default.
                let includes = e
                    .includes
                    .or_else(|| b.includes.clone())
                    .unwrap_or_else(|| default_includes.clone());
                // excludes stack: built-in/default → book → edition.
                let mut excludes = default_excludes.clone();
                if let Some(extra) = &b.excludes {
                    excludes.extend(extra.iter().cloned());
                }
                if let Some(extra) = e.excludes {
                    excludes.extend(extra);
                }
                let include_set = build_globset(&includes)
                    .map_err(|err| format!("book {:?}: bad include glob: {err}", b.label))?;
                let exclude_set = build_globset(&excludes)
                    .map_err(|err| format!("book {:?}: bad exclude glob: {err}", b.label))?;

                editions.push(EditionState {
                    label: e.label.unwrap_or_else(|| e.lang.clone()),
                    lang: e.lang,
                    source,
                    include_set,
                    exclude_set,
                });
            }

            let default_lang = b.default_lang.unwrap_or_else(|| editions[0].lang.clone());

            // A `[[book]]`/`[[mount]]` is a single `text` rendition over the
            // filesystem tree — no audio, no manifest spine.
            books.push(BookState {
                label: b.label,
                slug,
                description: b.description,
                cover: None,
                default_rendition: RenditionKind::Text,
                renditions: vec![RenditionState {
                    kind: RenditionKind::Text,
                    label: RenditionKind::Text.as_str().to_string(),
                    default_lang,
                    voice: None,
                    layout: b.layout,
                    manifest: false,
                    editions,
                }],
            });
        }

        // Auto-discover `book.toml` books under each [[shelf]] root.
        let mut seen_slugs: HashSet<String> = books.iter().map(|b| b.slug.clone()).collect();
        for shelf in &self.shelves {
            let root = if shelf.path.is_absolute() {
                shelf.path.clone()
            } else {
                config_dir.join(&shelf.path)
            };
            for book in discover_shelf(&root, &default_includes, &default_excludes)? {
                if !seen_slugs.insert(book.slug.clone()) {
                    return Err(format!("duplicate book slug {:?} (from shelf)", book.slug));
                }
                books.push(book);
            }
        }

        Ok(Resolved {
            host: self.server.host,
            port: self.server.port,
            debounce_ms: self.server.debounce_ms,
            open: self.server.open,
            books,
        })
    }
}

/// Scan `root`'s immediate subdirectories for `book.toml` manifests, turning
/// each into a manifest-driven `BookState`. Subdirs without a `book.toml` are
/// ignored, so a shelf can coexist with non-book content. Results are sorted
/// by slug for a stable bookshelf order.
fn discover_shelf(
    root: &Path,
    default_includes: &[String],
    default_excludes: &[String],
) -> Result<Vec<BookState>, String> {
    let entries = std::fs::read_dir(root).map_err(|e| format!("shelf {}: {e}", root.display()))?;
    let mut books = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("book.toml");
        if !manifest_path.is_file() {
            continue;
        }
        books.push(load_book_manifest(
            &manifest_path,
            &dir,
            default_includes,
            default_excludes,
        )?);
    }
    books.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(books)
}

/// Parse one `book.toml` and resolve it into a `BookState` with one or more
/// renditions. Without a `[renditions]` table the book is a single `text`
/// rendition over `<book_dir>/<lang>/` (legacy shape). With one, each
/// `[renditions.<kind>]` becomes a rendition: `text` editions root at
/// `<book_dir>/<lang>/`, `audio` editions at `<book_dir>/audio/<lang>/`.
fn load_book_manifest(
    manifest_path: &Path,
    book_dir: &Path,
    default_includes: &[String],
    default_excludes: &[String],
) -> Result<BookState, String> {
    let raw = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))?;
    let mut manifest: BookManifest =
        toml::from_str(&raw).map_err(|e| format!("parse {}: {e}", manifest_path.display()))?;

    if manifest.langs.is_empty() {
        return Err(format!(
            "{}: needs at least one [langs.<code>]",
            manifest_path.display()
        ));
    }
    if !manifest.langs.contains_key(&manifest.default_lang) {
        return Err(format!(
            "{}: default_lang {:?} has no [langs.{}] entry",
            manifest_path.display(),
            manifest.default_lang,
            manifest.default_lang
        ));
    }

    let slug = manifest.slug.clone().unwrap_or_else(|| {
        book_dir
            .file_name()
            .and_then(|s| s.to_str())
            .map(slugify)
            .unwrap_or_default()
    });
    if slug.is_empty() || slug.contains('/') {
        return Err(format!(
            "{}: invalid slug {:?}",
            manifest_path.display(),
            slug
        ));
    }

    let include_set = build_globset(default_includes)
        .map_err(|e| format!("{}: bad include glob: {e}", manifest_path.display()))?;
    let exclude_set = build_globset(default_excludes)
        .map_err(|e| format!("{}: bad exclude glob: {e}", manifest_path.display()))?;

    // The book-wide lang labels every rendition draws from.
    let book_langs: Vec<String> = {
        let mut v: Vec<String> = manifest.langs.keys().cloned().collect();
        v.sort();
        v
    };

    // Resolve which renditions to build. Legacy (no `[renditions]`) synthesises
    // a single `text` rendition over the book-wide langs.
    let mut specs: Vec<(RenditionKind, RenditionManifest)> = Vec::new();
    if manifest.renditions.is_empty() {
        specs.push((
            RenditionKind::Text,
            RenditionManifest {
                label: None,
                langs: None,
                default_lang: Some(manifest.default_lang.clone()),
                voice: None,
                from: None,
            },
        ));
    } else {
        // Stable kind order: text first, then audio.
        for kind in [RenditionKind::Text, RenditionKind::Audio] {
            if let Some(rm) = manifest.renditions.remove(&kind) {
                specs.push((kind, rm));
            }
        }
    }

    let mut renditions = Vec::new();
    for (kind, rm) in specs {
        // The rendition's langs default to the book-wide langs; its
        // default_lang defaults to the book's, but must land on a built edition.
        let langs = rm.langs.unwrap_or_else(|| book_langs.clone());
        let default_lang = rm
            .default_lang
            .unwrap_or_else(|| manifest.default_lang.clone());

        // Editions live at <book>/<lang>/ (text) or <book>/audio/<lang>/ (audio).
        // A lang dir missing on disk is skipped, NOT an error — a partially
        // translated audiobook is fine. Default lang first (base edition).
        let mut ordered: Vec<&String> = langs.iter().collect();
        ordered.sort();
        ordered.sort_by_key(|l| **l != default_lang);

        let mut editions = Vec::new();
        for lang in ordered {
            let abs = match kind {
                RenditionKind::Text => book_dir.join(lang),
                RenditionKind::Audio => book_dir.join("audio").join(lang),
            };
            let Ok(source) = abs.canonicalize() else {
                continue; // untranslated/absent for this mode — skip the lang.
            };
            if !source.is_dir() {
                continue;
            }
            let label = manifest
                .langs
                .get(lang)
                .and_then(|l| l.label.clone())
                .unwrap_or_else(|| lang.clone());
            editions.push(EditionState {
                lang: lang.clone(),
                label,
                source,
                include_set: include_set.clone(),
                exclude_set: exclude_set.clone(),
            });
        }

        // A rendition with no existing edition is dropped entirely.
        if editions.is_empty() {
            continue;
        }
        // `default_lang` may have been skipped (no dir); fall back to the first
        // edition that did resolve.
        let default_lang = if editions.iter().any(|e| e.lang == default_lang) {
            default_lang
        } else {
            editions[0].lang.clone()
        };

        renditions.push(RenditionState {
            kind,
            label: rm.label.unwrap_or_else(|| kind.as_str().to_string()),
            default_lang,
            voice: rm.voice,
            layout: None,
            manifest: true,
            editions,
        });
    }

    if renditions.is_empty() {
        return Err(format!(
            "{}: no rendition has any existing edition directory",
            manifest_path.display()
        ));
    }

    // default_rendition must name a built rendition.
    let default_rendition = manifest.default_rendition.unwrap_or(RenditionKind::Text);
    let default_rendition = if renditions.iter().any(|r| r.kind == default_rendition) {
        default_rendition
    } else {
        renditions[0].kind
    };

    let cover = resolve_cover(book_dir, manifest.cover.as_deref());

    Ok(BookState {
        label: manifest.title,
        slug,
        description: None,
        cover,
        default_rendition,
        renditions,
    })
}

/// Resolve a book's cover image: the manifest `cover` if it exists, else the
/// first `cover.{jpg,png,webp}` in the book dir, else `None`.
fn resolve_cover(book_dir: &Path, declared: Option<&Path>) -> Option<PathBuf> {
    if let Some(rel) = declared {
        let abs = if rel.is_absolute() {
            rel.to_path_buf()
        } else {
            book_dir.join(rel)
        };
        if let Ok(p) = abs.canonicalize() {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for name in ["cover.jpg", "cover.png", "cover.webp"] {
        let p = book_dir.join(name);
        if let Ok(c) = p.canonicalize() {
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

/// Look for a config file in `dir` using a fixed precedence order. Returns
/// the first match, or `None` if none of the names exist.
pub fn auto_discover(dir: &Path) -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "liveview.toml",
        "liveview.yaml",
        "liveview.yml",
        "liveview.json",
    ];
    for name in CANDIDATES {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Implicit config — a single-edition book over `dir` using built-in
/// defaults. Used when no `--config` is given and no `liveview.*` is
/// auto-discovered.
pub fn implicit_resolved(dir: &Path) -> Result<Resolved, String> {
    let source = dir
        .canonicalize()
        .map_err(|e| format!("implicit config: {} not found: {e}", dir.display()))?;
    if !source.is_dir() {
        return Err(format!(
            "implicit config: {} is not a directory",
            source.display()
        ));
    }
    let label = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("root")
        .to_string();
    let slug = {
        let s = slugify(&label);
        if s.is_empty() {
            "root".to_string()
        } else {
            s
        }
    };
    let include_set = build_globset(&builtin_includes())
        .map_err(|e| format!("implicit config: bad built-in include glob: {e}"))?;
    let exclude_set = build_globset(&builtin_excludes())
        .map_err(|e| format!("implicit config: bad built-in exclude glob: {e}"))?;
    Ok(Resolved {
        host: default_host(),
        port: None,
        debounce_ms: default_debounce(),
        open: false,
        books: vec![BookState {
            label,
            slug,
            description: None,
            cover: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![RenditionState {
                kind: RenditionKind::Text,
                label: RenditionKind::Text.as_str().to_string(),
                default_lang: "default".to_string(),
                voice: None,
                layout: None,
                manifest: false,
                editions: vec![EditionState {
                    lang: "default".to_string(),
                    label: "default".to_string(),
                    source,
                    include_set,
                    exclude_set,
                }],
            }],
        }],
    })
}

pub fn build_globset(patterns: &[String]) -> Result<GlobSet, globset::Error> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern)?);
    }
    builder.build()
}

/// Lower-kebab slug: ASCII alnum kept, every other run collapses to a
/// single `-`; leading/trailing `-` trimmed.
pub fn slugify(label: &str) -> String {
    let mut s = String::with_capacity(label.len());
    let mut prev_dash = true;
    for c in label.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    if s.ends_with('-') {
        s.pop();
    }
    s
}

pub fn builtin_includes() -> Vec<String> {
    [
        "**/*.md",
        "**/*.markdown",
        "**/*.png",
        "**/*.jpg",
        "**/*.jpeg",
        "**/*.gif",
        "**/*.svg",
        "**/*.webp",
        "**/*.avif",
        "**/*.bmp",
        "**/*.ico",
        "**/*.tiff",
        "**/*.tif",
        "**/*.pdf",
        "**/*.html",
        "**/*.htm",
        "**/*.csv",
        "**/*.tsv",
        "**/*.json",
        "**/*.jsonc",
        "**/*.json5",
        "**/*.excalidraw",
        "**/*.tex",
        "**/*.latex",
        "**/*.typ",
        "**/*.typst",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

pub fn builtin_excludes() -> Vec<String> {
    [
        "**/.git/**",
        "**/.git",
        "**/node_modules/**",
        "**/target/**",
        "**/__pycache__/**",
        "**/.DS_Store",
        "**/vendor/**",
        "**/.venv/**",
        "**/.dioxus/**",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Docs"), "docs");
        assert_eq!(slugify("Project Defs"), "project-defs");
        assert_eq!(slugify("Project   Defs"), "project-defs");
        assert_eq!(slugify("HARNESS-1234"), "harness-1234");
        assert_eq!(slugify("foo/bar baz!"), "foo-bar-baz");
        assert_eq!(slugify("---foo---"), "foo");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn format_from_extension() {
        assert_eq!(
            Format::from_path(Path::new("a.toml")).unwrap(),
            Format::Toml
        );
        assert_eq!(
            Format::from_path(Path::new("a.yaml")).unwrap(),
            Format::Yaml
        );
        assert_eq!(Format::from_path(Path::new("a.YML")).unwrap(), Format::Yaml);
        assert_eq!(
            Format::from_path(Path::new("a.json")).unwrap(),
            Format::Json
        );
        assert!(Format::from_path(Path::new("a.xml")).is_err());
        assert!(Format::from_path(Path::new("noext")).is_err());
    }

    fn book(label: &str, slug: Option<&str>) -> BookCfg {
        BookCfg {
            label: label.to_string(),
            slug: slug.map(str::to_string),
            description: None,
            default_lang: None,
            source: Some(PathBuf::from(".")),
            includes: None,
            excludes: None,
            layout: None,
            editions: vec![],
        }
    }

    #[test]
    fn validate_rejects_empty_books() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![],
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_dup_slug() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![book("Docs", None), book("DOCS", None)],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("duplicate"), "got: {err}");
    }

    #[test]
    fn validate_rejects_empty_slug() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![book("!!!", None)],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("empty slug"), "got: {err}");
    }

    #[test]
    fn validate_rejects_slug_with_slash() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![book("Docs", Some("foo/bar"))],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("must not contain '/'"), "got: {err}");
    }

    #[test]
    fn validate_rejects_source_and_editions_together() {
        let mut b = book("Docs", None);
        b.editions = vec![EditionCfg {
            lang: "en".to_string(),
            label: None,
            source: PathBuf::from("en"),
            includes: None,
            excludes: None,
        }];
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![b],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("not both"), "got: {err}");
    }

    #[test]
    fn validate_rejects_book_without_source_or_edition() {
        let mut b = book("Docs", None);
        b.source = None;
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![b],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("at least one"), "got: {err}");
    }

    #[test]
    fn validate_rejects_dup_edition_lang() {
        let mut b = book("Docs", None);
        b.source = None;
        let ed = |lang: &str| EditionCfg {
            lang: lang.to_string(),
            label: None,
            source: PathBuf::from(lang),
            includes: None,
            excludes: None,
        };
        b.editions = vec![ed("en"), ed("en")];
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![b],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("duplicate edition lang"), "got: {err}");
    }

    #[test]
    fn validate_rejects_unknown_default_lang() {
        let mut b = book("Docs", None);
        b.source = None;
        b.default_lang = Some("zh".to_string());
        b.editions = vec![EditionCfg {
            lang: "en".to_string(),
            label: None,
            source: PathBuf::from("en"),
            includes: None,
            excludes: None,
        }];
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            shelves: vec![],
            books: vec![b],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("default_lang"), "got: {err}");
    }

    const TOML_SAMPLE: &str = r#"
        [server]
        port = 4160

        [[book]]
        label = "Docs"
        source = "docs"

        [[book]]
        label = "Tasks"
        source = "tasks/active"
        excludes = ["**/.scratch/**"]

        [book.layout]
        order = ["README.md", "active/"]
    "#;

    const YAML_SAMPLE: &str = r#"
server:
  port: 4160
book:
  - label: Docs
    source: docs
  - label: Tasks
    source: tasks/active
    excludes:
      - "**/.scratch/**"
    layout:
      order: ["README.md", "active/"]
"#;

    const JSON_SAMPLE: &str = r#"{
        "server": { "port": 4160 },
        "book": [
            { "label": "Docs", "source": "docs" },
            {
                "label": "Tasks",
                "source": "tasks/active",
                "excludes": ["**/.scratch/**"],
                "layout": { "order": ["README.md", "active/"] }
            }
        ]
    }"#;

    fn assert_sample_shape(cfg: &Config) {
        assert_eq!(cfg.server.port, Some(4160));
        assert_eq!(cfg.server.host, "127.0.0.1");
        assert_eq!(cfg.books.len(), 2);
        assert_eq!(cfg.books[0].label, "Docs");
        assert_eq!(cfg.books[1].label, "Tasks");
        assert_eq!(
            cfg.books[1].excludes.as_deref().unwrap(),
            &["**/.scratch/**"]
        );
        assert_eq!(
            cfg.books[1].layout.as_ref().unwrap().order,
            vec!["README.md".to_string(), "active/".to_string()]
        );
    }

    #[test]
    fn parse_accepts_mount_alias() {
        let raw = r#"
            [[mount]]
            label = "Docs"
            source = "docs"
        "#;
        let cfg = Config::parse(raw, Format::Toml).unwrap();
        assert_eq!(cfg.books.len(), 1);
        assert_eq!(cfg.books[0].label, "Docs");
    }

    #[test]
    fn parse_multi_edition_book() {
        let raw = r#"
            [[book]]
            label = "Solidity for Polyglots"
            slug = "solidity"
            default_lang = "en"

            [[book.edition]]
            lang = "en"
            label = "English"
            source = "."

            [[book.edition]]
            lang = "zh"
            label = "中文"
            source = "i18n/zh"

            [book.layout]
            order = ["README.md"]
        "#;
        let cfg = Config::parse(raw, Format::Toml).unwrap();
        assert_eq!(cfg.books.len(), 1);
        let b = &cfg.books[0];
        assert_eq!(b.default_lang.as_deref(), Some("en"));
        assert_eq!(b.editions.len(), 2);
        assert_eq!(b.editions[0].lang, "en");
        assert_eq!(b.editions[1].lang, "zh");
        assert_eq!(b.editions[1].label.as_deref(), Some("中文"));
    }

    #[test]
    fn parse_toml_sample() {
        let cfg = Config::parse(TOML_SAMPLE, Format::Toml).unwrap();
        assert_sample_shape(&cfg);
    }

    #[test]
    fn parse_yaml_sample() {
        let cfg = Config::parse(YAML_SAMPLE, Format::Yaml).unwrap();
        assert_sample_shape(&cfg);
    }

    #[test]
    fn parse_json_sample() {
        let cfg = Config::parse(JSON_SAMPLE, Format::Json).unwrap();
        assert_sample_shape(&cfg);
    }

    #[test]
    fn parse_rejects_unknown_field_toml() {
        let raw = r#"
            [[mount]]
            label = "Docs"
            source = "docs"
            extra_field = true
        "#;
        let err = Config::parse(raw, Format::Toml).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("unknown"), "got: {err}");
    }

    #[test]
    fn parse_rejects_unknown_field_json() {
        let raw = r#"{
            "mount": [
                { "label": "Docs", "source": "docs", "extra_field": true }
            ]
        }"#;
        let err = Config::parse(raw, Format::Json).unwrap_err();
        assert!(err.to_ascii_lowercase().contains("unknown"), "got: {err}");
    }
}
