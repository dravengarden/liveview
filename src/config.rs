//! Config file — virtual books + global defaults.
//!
//! A *book* is a curated reading view that appears as a card on the landing
//! "bookshelf" and as a top-level folder in the sidebar. Each book has one
//! or more *editions* — one per language — that share the same logical
//! structure (same chapter/file layout) but live in different source dirs.
//! Switching language keeps your logical position and swaps the edition.
//!
//! The on-the-wire path of any file is `<slug>/<rel-path-under-source>`
//! (edition-independent); the requested `lang` selects the edition. The slug
//! is derived from `label` (lower-kebab) unless explicitly overridden.
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
    #[serde(rename = "book", alias = "mount")]
    pub books: Vec<BookCfg>,
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

/// Resolved language edition — canonical source path + compiled globsets.
#[derive(Clone)]
pub struct EditionState {
    pub lang: String,
    pub label: String,
    pub source: PathBuf,
    pub include_set: GlobSet,
    pub exclude_set: GlobSet,
}

/// Resolved book — metadata plus one or more editions.
#[derive(Clone)]
pub struct BookState {
    pub label: String,
    pub slug: String,
    pub description: Option<String>,
    pub default_lang: String,
    pub layout: Option<Layout>,
    /// Always non-empty. First entry is the declaration order; `default_lang`
    /// names which one opens first.
    pub editions: Vec<EditionState>,
}

impl BookState {
    /// The edition matching `lang`, or `None`.
    pub fn edition(&self, lang: &str) -> Option<&EditionState> {
        self.editions.iter().find(|e| e.lang == lang)
    }

    /// The default edition (by `default_lang`, falling back to the first).
    pub fn default_edition(&self) -> &EditionState {
        self.edition(&self.default_lang)
            .or_else(|| self.editions.first())
            .expect("book always has at least one edition")
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
        if self.books.is_empty() {
            return Err("config: at least one [[book]] required".to_string());
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

            books.push(BookState {
                label: b.label,
                slug,
                description: b.description,
                default_lang,
                layout: b.layout,
                editions,
            });
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
            default_lang: "default".to_string(),
            layout: None,
            editions: vec![EditionState {
                lang: "default".to_string(),
                label: "default".to_string(),
                source,
                include_set,
                exclude_set,
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
            books: vec![],
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_dup_slug() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
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
