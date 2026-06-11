//! `liveview check` — a standalone content checker for the book corpus.
//!
//! P0 is pure-Rust and offline: it parses each Markdown file with the *same*
//! comrak options the server renders with (`renderer::markdown_options`) and
//! reports structural problems comrak silently swallows — dangling/unused
//! footnotes, broken reference links, and missing local assets.
//!
//! Design: a tiny [`Validator`] trait + a registry keyed by [`FileType`]. P0
//! ships one validator (Markdown); future sources (math, mermaid, typst, dead
//! external links) register here without touching the orchestrator. Every
//! validator emits the unified [`Diagnostic`], so `--format json` is one stable
//! schema across all of them.

pub mod diagnostic;
pub mod excalidraw;
pub mod json;
pub mod markdown;
pub mod math;
pub mod mermaid;
pub mod svg;
pub mod typst;

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::check::diagnostic::{render_human, render_json, worst_severity, Diagnostic, Severity};
use crate::cli::OutputFormat;
use crate::shared::FileType;

/// A markdown (or other) file loaded for checking.
pub struct CheckFile {
    /// Absolute / as-resolved path on disk (used to load + to derive `ctx`).
    pub path: PathBuf,
    /// Path as it should appear in diagnostics (what the user passed / a
    /// book-relative form). For P0 this is the path as given on the CLI.
    pub rel: String,
    pub source: String,
    pub file_type: FileType,
}

/// Per-file context a validator needs beyond the source text. Today: the
/// parent dir, for resolving relative asset paths.
pub struct CheckCtx {
    pub dir: PathBuf,
}

/// A content checker for one kind of file. Stateless; the registry holds one
/// instance per source.
pub trait Validator {
    fn check(&self, file: &CheckFile, ctx: &CheckCtx) -> Vec<Diagnostic>;
}

/// Select the validators that apply to a given file type. Trivially extensible:
/// a new validator is one more arm / push here.
fn validators_for(file_type: &FileType) -> Vec<Box<dyn Validator>> {
    match file_type {
        // Markdown carries prose structure, embedded math, and mermaid fences —
        // each gets its own validator over the same source.
        FileType::Markdown => vec![
            Box::new(markdown::MarkdownValidator),
            Box::new(math::MathValidator),
            Box::new(mermaid::MermaidValidator),
            // Inline `<svg>` blocks are embedded raw in markdown (67 corpus
            // files); validate they're well-formed XML.
            Box::new(svg::SvgValidator),
        ],
        // `.typ` files: validate that the source parses as well-formed typst
        // (the reader highlights them; a future renderer would compile them).
        FileType::Typst => vec![Box::new(typst::TypstValidator)],
        // `.json` (.jsonc/.json5 too): strict parse, matching the reader's
        // `JSON.parse`.
        FileType::Json => vec![Box::new(json::JsonValidator)],
        // `.excalidraw`: valid JSON + the load-bearing schema fields.
        FileType::Excalidraw => vec![Box::new(excalidraw::ExcalidrawValidator)],
        // CSV and HTML get no validator: the reader's CSV parser is a lenient
        // hand-rolled split (almost nothing is "malformed"), and raw HTML is
        // rendered by the browser, which tolerates ill-formed markup — neither
        // has a meaningful "won't render" check, and the corpus has none of
        // either. Image/Pdf are binary.
        _ => Vec::new(),
    }
}

/// Check one already-loaded file and return its diagnostics (never errors).
///
/// The `sync` deploy reuses this with the bytes it already read, so a broken
/// footnote / reference / asset surfaces in the deploy log without a second
/// disk read. `dir` is the directory the source lives in (for relative-asset
/// resolution); `rel` is what appears in each diagnostic's `file` field.
pub fn check_source(rel: &str, source: &str, dir: &Path, file_type: FileType) -> Vec<Diagnostic> {
    let file = CheckFile {
        path: dir.join(rel),
        rel: rel.to_string(),
        source: source.to_string(),
        file_type,
    };
    let ctx = CheckCtx {
        dir: dir.to_path_buf(),
    };
    let mut diags = Vec::new();
    for validator in validators_for(&file.file_type) {
        diags.extend(validator.check(&file, &ctx));
    }
    diags.sort_by_key(|d| (d.line, d.col));
    diags
}

/// Run the checker over `paths` and return the process exit code.
///
/// - A path that is a file is checked as-is; a directory is recursed for
///   `*.md` / `*.markdown`.
/// - Exit code: `2` if any `Error`; `1` if `deny_warnings` and any `Warning`;
///   `0` otherwise. (Distinct codes so CI can treat warnings as soft unless
///   asked.)
pub fn run(paths: &[PathBuf], format: OutputFormat, deny_warnings: bool) -> i32 {
    let files = match collect_files(paths) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("check: {e}");
            return 2;
        }
    };

    let mut diags: Vec<Diagnostic> = Vec::new();
    for file in &files {
        let ctx = CheckCtx {
            dir: file
                .path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
        };
        for validator in validators_for(&file.file_type) {
            diags.extend(validator.check(file, &ctx));
        }
    }

    match format {
        OutputFormat::Json => println!("{}", render_json(&diags)),
        OutputFormat::Human => {
            let report = render_human(&diags);
            if report.is_empty() {
                let n = files.len();
                eprintln!("check: {n} file(s) checked, no issues found");
            } else {
                print!("{report}");
                eprintln!("\ncheck: {} diagnostic(s)", diags.len());
            }
        }
    }

    match worst_severity(&diags) {
        Some(Severity::Error) => 2,
        Some(Severity::Warning) if deny_warnings => 1,
        _ => 0,
    }
}

/// Expand the CLI paths into the set of markdown `CheckFile`s to check.
fn collect_files(paths: &[PathBuf]) -> Result<Vec<CheckFile>, String> {
    let mut out = Vec::new();
    for p in paths {
        if p.is_file() {
            if let Some(f) = load_file(p, p)? {
                out.push(f);
            }
        } else if p.is_dir() {
            // Recurse; sort entries for deterministic output across runs.
            for entry in WalkDir::new(p).sort_by_file_name() {
                let entry = entry.map_err(|e| format!("walk {}: {e}", p.display()))?;
                let path = entry.path();
                if path.is_file() && is_checkable(path) {
                    if let Some(f) = load_file(path, path)? {
                        out.push(f);
                    }
                }
            }
        } else {
            return Err(format!("path not found: {}", p.display()));
        }
    }
    Ok(out)
}

/// Does this path have any validator? The single source of truth is the
/// registry — when a new file type gets a validator, directory recursion picks
/// it up automatically.
fn is_checkable(path: &Path) -> bool {
    !validators_for(&FileType::from_path(&path.to_string_lossy())).is_empty()
}

/// Load one file into a `CheckFile`. Returns `Ok(None)` for a file type with no
/// validator (nothing to check); errors only on a read failure.
fn load_file(path: &Path, rel: &Path) -> Result<Option<CheckFile>, String> {
    let file_type = FileType::from_path(&path.to_string_lossy());
    if validators_for(&file_type).is_empty() {
        return Ok(None);
    }
    let source =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(Some(CheckFile {
        path: path.to_path_buf(),
        rel: rel.to_string_lossy().into_owned(),
        source,
        file_type,
    }))
}
