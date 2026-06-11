//! The unified diagnostic contract every validator emits.
//!
//! Why one struct for all sources: the checker is meant to grow far past
//! Markdown (math, mermaid, typst, dead external links, …). Keeping a single
//! `Diagnostic` shape — with a `source` tag and a `rule` string — means the
//! `--format json` output is a stable, AI-consumable array regardless of which
//! validator produced an entry; a downstream agent reads one schema, not one
//! per checker.

use std::collections::BTreeMap;

use serde::Serialize;

/// Severity ordering matters: `Error` is the worst. We derive `Ord` so
/// `worst_severity` is a plain `.max()` fold, and the exit-code logic can ask
/// "is the worst at least an Error?".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    // Order (lowest → highest) is load-bearing for the `Ord` derive.
    // `Info` is part of the stable diagnostic contract (consumers match all
    // three) but no P0 rule emits it yet — future sources (math/mermaid/…)
    // will, so it stays in the enum rather than being added later.
    #[allow(dead_code)]
    Info,
    Warning,
    Error,
}

impl Severity {
    /// The word printed in the human format (`error[rule]: …`).
    fn label(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// One finding, anchored to a 1-based source span.
///
/// All four position fields are 1-based (comrak's `sourcepos` already is), so
/// `file:line:col` lines up with what an editor shows.
#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    /// Path as given on the CLI / book-relative — whatever the caller passed,
    /// so the printed location is something the user can paste back.
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub severity: Severity,
    /// The producing validator: `"markdown"` for P0. Future: `"math"`,
    /// `"mermaid"`, `"typst"`, `"links"`, …
    pub source: &'static str,
    /// Stable machine id, namespaced by source, e.g. `md/dangling-footnote`.
    pub rule: String,
    pub message: String,
    /// A one-line fix suggestion, when we have one.
    pub hint: Option<String>,
    /// The offending text, when cheap to capture.
    pub snippet: Option<String>,
}

/// Pick the worst severity across a batch (for the process exit code). `None`
/// ⇒ no diagnostics at all.
pub fn worst_severity(diags: &[Diagnostic]) -> Option<Severity> {
    diags.iter().map(|d| d.severity).max()
}

/// Serialize the whole batch as a JSON array of `Diagnostic` (the
/// `--format json` path). One array, newline-terminated, nothing else on
/// stdout — so a consumer can `jq` it directly.
pub fn render_json(diags: &[Diagnostic]) -> String {
    // Pretty-print: these are read by humans and agents alike, and the volume
    // is tiny (a corpus has dozens, not millions, of findings).
    serde_json::to_string_pretty(diags).unwrap_or_else(|_| "[]".to_string())
}

/// Render the human format: diagnostics grouped by file, each as
/// `file:line:col: <sev>[rule]: message`, with an indented `hint:` line when
/// present. Returns the full multi-file report as one string.
pub fn render_human(diags: &[Diagnostic]) -> String {
    if diags.is_empty() {
        return String::new();
    }

    // Group by file, preserving a stable (alphabetical) file order so repeated
    // runs diff cleanly. Within a file, keep source order (already sorted by
    // the validator's AST/scan walk).
    let mut by_file: BTreeMap<&str, Vec<&Diagnostic>> = BTreeMap::new();
    for d in diags {
        by_file.entry(d.file.as_str()).or_default().push(d);
    }

    let mut out = String::new();
    for (file, group) in &by_file {
        for d in group {
            out.push_str(&format!(
                "{}:{}:{}: {}[{}]: {}\n",
                file,
                d.line,
                d.col,
                d.severity.label(),
                d.rule,
                d.message,
            ));
            if let Some(hint) = &d.hint {
                out.push_str(&format!("  hint: {hint}\n"));
            }
        }
    }
    out
}
