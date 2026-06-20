//! `liveview narrate-audit` — the read-aloud playability evaluator.
//!
//! A dry-run of the speech registry over the corpus: for every read-along unit
//! it asks [`crate::server::speakable::plan`] — the SAME decision the runtime
//! synth uses — what that resource will be spoken as, and reports it. So it
//! answers, per book, "which resources can't just be read aloud, what will each
//! become, and which are still SILENT (need an author fix)?" — without calling
//! the model or synthesizing any audio.
//!
//! Because it shares `plan` with the runtime, the audit can never drift from
//! what actually plays: a new resource handler shows up here automatically, and
//! a "silent" finding here is exactly a silent step-over there. Output is the
//! same [`Diagnostic`] schema + `--format json|human` as `liveview check`.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::check::diagnostic::{render_human, render_json, Diagnostic, Severity};
use crate::cli::OutputFormat;
use crate::server::speakable::{plan, Speech, MIN_ALT_CHARS};
use crate::server::spoken::{spoken_units, Unit, UnitKind};
use crate::shared::FileType;

/// Walk `paths` (files as-is, dirs recursed for markdown), evaluate each
/// chapter's read-along units, and print the report. Returns the process exit
/// code: `2` on an IO/usage error, else `0` (the audit is informational —
/// "silent" resources are warnings, not failures).
pub fn run(paths: &[PathBuf], format: OutputFormat) -> i32 {
    let files = match collect_markdown(paths) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("narrate-audit: {e}");
            return 2;
        }
    };

    let mut diags: Vec<Diagnostic> = Vec::new();
    let mut silent = 0usize;
    for (rel, source) in &files {
        // Language only tints prose stand-ins / prompt wording in the report;
        // infer it from the conventional `<lang>/` path segment, default zh.
        let lang = if rel.contains("/en/") || rel.contains("\\en\\") { "en" } else { "zh" };
        for unit in spoken_units(source) {
            if let Some(d) = audit_unit(rel, &unit, lang) {
                if d.severity == Severity::Warning {
                    silent += 1;
                }
                diags.push(d);
            }
        }
    }
    diags.sort_by_key(|d| (d.file.clone(), d.line, d.col));

    match format {
        OutputFormat::Json => println!("{}", render_json(&diags)),
        OutputFormat::Human => {
            let report = render_human(&diags);
            if report.is_empty() {
                eprintln!("narrate-audit: {} file(s), no non-prose resources", files.len());
            } else {
                print!("{report}");
                eprintln!(
                    "\nnarrate-audit: {} finding(s) across {} file(s); {silent} still SILENT",
                    diags.len(),
                    files.len(),
                );
            }
        }
    }
    0
}

/// One finding for a unit, or `None` for prose that needs no normalization (the
/// common case — we don't report every plain sentence).
fn audit_unit(rel: &str, unit: &Unit, lang: &str) -> Option<Diagnostic> {
    // `blk` (the rendered top-level block ordinal the highlight anchors on) is
    // the locator the reader navigates by; surface it as the pseudo-line so the
    // human report sorts in document order. (Units carry no source line.)
    let line = unit.blk as u32 + 1;
    let mk = |severity, rule: &str, message: String, snippet, hint| Diagnostic {
        file: rel.to_string(),
        line,
        col: 1,
        end_line: line,
        end_col: 1,
        severity,
        source: "readaloud",
        rule: rule.to_string(),
        message,
        hint,
        snippet,
    };

    match plan(unit, lang) {
        // Prose: only worth a line when the inline normalizer actually rewrote a
        // hazard (a URL/address/phone got a spoken stand-in). Compare against a
        // whitespace-collapsed baseline so the mere double-space left by an
        // inline-math drop is NOT reported as a substitution.
        Speech::Ready { rule: "speak/prose", text } => {
            let baseline = unit.text.split_whitespace().collect::<Vec<_>>().join(" ");
            (text != baseline).then(|| {
                mk(
                    Severity::Info,
                    "speak/inline",
                    "inline normalized for speech".to_string(),
                    Some(preview(&unit.text)),
                    Some(format!("spoken as: {}", preview(&text))),
                )
            })
        }
        Speech::Ready { rule, text } => {
            // A figure described by its alt is good — but flag a too-thin alt so
            // the author lengthens it to a moderate spoken description.
            let thin = unit.kind == UnitKind::Image && text.chars().count() < MIN_ALT_CHARS;
            Some(mk(
                if thin { Severity::Warning } else { Severity::Info },
                rule,
                format!(
                    "{} → spoken from authored text{}",
                    kind_word(unit.kind),
                    if thin { " (alt too short)" } else { "" },
                ),
                Some(preview(&text)),
                thin.then(|| {
                    "alt is thin; write a moderate spoken description of the figure".to_string()
                }),
            ))
        }
        Speech::Llm { rule, source, .. } => Some(mk(
            Severity::Info,
            rule,
            format!("{} → narrated per type at synth ({rule})", kind_word(unit.kind)),
            Some(preview(&source)),
            None,
        )),
        Speech::Silent { rule } => Some(mk(
            Severity::Warning,
            rule,
            format!("{} → SILENT (no spoken text)", kind_word(unit.kind)),
            (!unit.src.is_empty()).then(|| preview(&unit.src)),
            Some(silent_hint(rule).to_string()),
        )),
    }
}

fn kind_word(kind: UnitKind) -> &'static str {
    match kind {
        UnitKind::Prose => "prose",
        UnitKind::Image => "image",
        UnitKind::Math => "formula",
        UnitKind::Code => "code/diagram block",
        UnitKind::Table => "table",
        UnitKind::Html => "embedded HTML",
    }
}

/// What an author should do to make a silent resource speak.
fn silent_hint(rule: &str) -> &'static str {
    match rule {
        "speak/image-no-alt" => "add alt text: a moderate spoken description of the figure",
        "speak/html" => "embedded HTML isn't narrated — draw it as inline <svg> or describe it in prose",
        "speak/table-empty" => "table has no cell text to narrate",
        "speak/code-empty" => "empty code block",
        _ => "no handler for this resource yet",
    }
}

/// First line, clipped — enough to identify the resource in the report.
fn preview(s: &str) -> String {
    let one = s.split('\n').next().unwrap_or("").trim();
    if one.chars().count() > 100 {
        format!("{}…", one.chars().take(100).collect::<String>())
    } else {
        one.to_string()
    }
}

/// Expand the CLI paths into `(rel, source)` markdown pairs. A file is taken
/// as-is; a directory recurses for `*.md` / `*.markdown`.
fn collect_markdown(paths: &[PathBuf]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for p in paths {
        if p.is_file() {
            push_md(p, &mut out)?;
        } else if p.is_dir() {
            for entry in WalkDir::new(p).sort_by_file_name() {
                let entry = entry.map_err(|e| format!("walk {}: {e}", p.display()))?;
                let path = entry.path();
                if path.is_file()
                    && matches!(FileType::from_path(&path.to_string_lossy()), FileType::Markdown)
                {
                    push_md(path, &mut out)?;
                }
            }
        } else {
            return Err(format!("path not found: {}", p.display()));
        }
    }
    Ok(out)
}

fn push_md(path: &Path, out: &mut Vec<(String, String)>) -> Result<(), String> {
    if !matches!(FileType::from_path(&path.to_string_lossy()), FileType::Markdown) {
        return Ok(());
    }
    let source =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    out.push((path.to_string_lossy().into_owned(), source));
    Ok(())
}
