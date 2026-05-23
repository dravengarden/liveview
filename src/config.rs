//! Config file — virtual mounts + global defaults.
//!
//! A mount is a (label, source-dir, glob filters) tuple that appears as a
//! top-level folder in the sidebar. The on-the-wire path of any file under
//! a mount is `<slug>/<rel-path-under-source>`; the slug is derived from
//! `label` (lower-kebab) unless explicitly overridden.
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
    #[serde(rename = "mount")]
    pub mounts: Vec<MountCfg>,
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
pub struct MountCfg {
    pub label: String,
    pub slug: Option<String>,
    pub source: PathBuf,
    pub includes: Option<Vec<String>>,
    pub excludes: Option<Vec<String>>,
    pub layout: Option<Layout>,
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

/// Resolved mount — canonical source path + compiled globsets.
#[derive(Clone)]
pub struct MountState {
    pub label: String,
    pub slug: String,
    pub source: PathBuf,
    pub include_set: GlobSet,
    pub exclude_set: GlobSet,
    pub layout: Option<Layout>,
}

/// Fully resolved server config: per-process state extracted from `Config`
/// plus mount-level globsets compiled and source paths canonicalized.
pub struct Resolved {
    pub host: String,
    pub port: Option<u16>,
    pub debounce_ms: u64,
    pub open: bool,
    pub mounts: Vec<MountState>,
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
        if self.mounts.is_empty() {
            return Err("config: at least one [[mount]] required".to_string());
        }
        let mut seen = HashSet::new();
        for m in &self.mounts {
            let slug = m.slug.clone().unwrap_or_else(|| slugify(&m.label));
            if slug.is_empty() {
                return Err(format!(
                    "mount {:?}: label produced empty slug — set `slug = \"...\"` explicitly",
                    m.label
                ));
            }
            if slug.contains('/') {
                return Err(format!(
                    "mount {:?}: slug {:?} must not contain '/'",
                    m.label, slug
                ));
            }
            if !seen.insert(slug.clone()) {
                return Err(format!("duplicate mount slug {:?}", slug));
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

        let mut mounts = Vec::with_capacity(self.mounts.len());
        for m in self.mounts {
            let abs_source = if m.source.is_absolute() {
                m.source.clone()
            } else {
                config_dir.join(&m.source)
            };
            let source = abs_source.canonicalize().map_err(|e| {
                format!(
                    "mount {:?}: source {} not found: {e}",
                    m.label,
                    abs_source.display()
                )
            })?;
            if !source.is_dir() {
                return Err(format!(
                    "mount {:?}: source {} is not a directory",
                    m.label,
                    source.display()
                ));
            }

            let includes = m.includes.unwrap_or_else(|| default_includes.clone());
            let mut excludes = default_excludes.clone();
            if let Some(extra) = m.excludes {
                excludes.extend(extra);
            }
            let include_set = build_globset(&includes)
                .map_err(|e| format!("mount {:?}: bad include glob: {e}", m.label))?;
            let exclude_set = build_globset(&excludes)
                .map_err(|e| format!("mount {:?}: bad exclude glob: {e}", m.label))?;
            let slug = m.slug.clone().unwrap_or_else(|| slugify(&m.label));

            mounts.push(MountState {
                label: m.label,
                slug,
                source,
                include_set,
                exclude_set,
                layout: m.layout,
            });
        }

        Ok(Resolved {
            host: self.server.host,
            port: self.server.port,
            debounce_ms: self.server.debounce_ms,
            open: self.server.open,
            mounts,
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

/// Implicit config — single mount over `dir` using built-in defaults. Used
/// when no `--config` is given and no `liveview.*` is auto-discovered.
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
        mounts: vec![MountState {
            label,
            slug,
            source,
            include_set,
            exclude_set,
            layout: None,
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

    #[test]
    fn validate_rejects_empty_mounts() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            mounts: vec![],
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_dup_slug() {
        let mk = |label: &str| MountCfg {
            label: label.to_string(),
            slug: None,
            source: PathBuf::from("."),
            includes: None,
            excludes: None,
            layout: None,
        };
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            mounts: vec![mk("Docs"), mk("DOCS")],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("duplicate"), "got: {err}");
    }

    #[test]
    fn validate_rejects_empty_slug() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            mounts: vec![MountCfg {
                label: "!!!".to_string(),
                slug: None,
                source: PathBuf::from("."),
                includes: None,
                excludes: None,
                layout: None,
            }],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("empty slug"), "got: {err}");
    }

    #[test]
    fn validate_rejects_slug_with_slash() {
        let cfg = Config {
            server: ServerCfg::default(),
            defaults: Defaults::default(),
            mounts: vec![MountCfg {
                label: "Docs".to_string(),
                slug: Some("foo/bar".to_string()),
                source: PathBuf::from("."),
                includes: None,
                excludes: None,
                layout: None,
            }],
        };
        let err = cfg.validate().unwrap_err();
        assert!(err.contains("must not contain '/'"), "got: {err}");
    }

    const TOML_SAMPLE: &str = r#"
        [server]
        port = 4160

        [[mount]]
        label = "Docs"
        source = "docs"

        [[mount]]
        label = "Tasks"
        source = "tasks/active"
        excludes = ["**/.scratch/**"]

        [mount.layout]
        order = ["README.md", "active/"]
    "#;

    const YAML_SAMPLE: &str = r#"
server:
  port: 4160
mount:
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
        "mount": [
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
        assert_eq!(cfg.mounts.len(), 2);
        assert_eq!(cfg.mounts[0].label, "Docs");
        assert_eq!(cfg.mounts[1].label, "Tasks");
        assert_eq!(
            cfg.mounts[1].excludes.as_deref().unwrap(),
            &["**/.scratch/**"]
        );
        assert_eq!(
            cfg.mounts[1].layout.as_ref().unwrap().order,
            vec!["README.md".to_string(), "active/".to_string()]
        );
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
