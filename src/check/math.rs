//! The KaTeX math validator.
//!
//! Runs the **real** KaTeX (the bundled `katex.min.js`, executed in an
//! in-process quick-js engine — not deno, no DOM) over every math node, with
//! `throwOnError` on. A formula that KaTeX rejects here is exactly one the
//! reader's KaTeX would render as a red error, so "checked clean" provably
//! renders. We tried a pure-Rust LaTeX parser (`pulldown-latex`) first; it
//! rejected 14% of the corpus's *valid* KaTeX (`\tag`, `\operatorname`,
//! `\boldsymbol`, `\phantom`, …) as false positives, which is why we pay for a
//! JS engine instead.
//!
//! Math is found via comrak's `Math` nodes (the `$…$` / `$$…$$` and math-code
//! forms the server renders into `[data-math-style]` / `code.language-math`) —
//! the same parse the renderer uses, so the checker sees exactly what ships.
//! Each node carries `display_math`, which we pass through as KaTeX's
//! `displayMode` (so a display-only construct like `\tag` isn't mis-flagged in
//! an inline context).
//!
//! Severity is **Warning**, not Error: the reader renders with
//! `throwOnError:false`, so a broken formula degrades to an inline red box
//! rather than breaking the page — it's wrong, not fatal.

use comrak::nodes::NodeValue;
use comrak::{parse_document, Arena};
use regex::Regex;
use std::sync::LazyLock;

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};
use crate::server::renderer;

pub struct MathValidator;

impl Validator for MathValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        let arena = Arena::new();
        // Parse with the renderer's exact options so the math we see is the math
        // that ships.
        let root = parse_document(&arena, &file.source, &renderer::markdown_options());

        let mut diags = Vec::new();
        for node in root.descendants() {
            let data = node.data.borrow();
            let NodeValue::Math(m) = &data.value else {
                continue;
            };
            let Some((message, hint)) = validate_formula(&m.literal, m.display_math) else {
                continue;
            };
            let sp = data.sourcepos;
            diags.push(Diagnostic {
                file: file.rel.clone(),
                line: sp.start.line as u32,
                col: sp.start.column as u32,
                end_line: sp.end.line as u32,
                end_col: sp.end.column as u32,
                severity: Severity::Warning,
                source: "math",
                rule: "math/parse-error".to_string(),
                message,
                hint,
                snippet: Some(m.literal.trim().chars().take(80).collect()),
            });
        }
        diags
    }
}

/// Render one formula through KaTeX. `None` if it renders cleanly; otherwise the
/// cleaned `(message, hint)`.
fn validate_formula(literal: &str, display: bool) -> Option<(String, Option<String>)> {
    // An empty / whitespace-only node isn't a formula; KaTeX is fine with it and
    // so are we.
    if literal.trim().is_empty() {
        return None;
    }
    let opts = katex::Opts::builder()
        .throw_on_error(true)
        .display_mode(display)
        .build()
        .ok()?;
    match katex::render_with_opts(literal, &opts) {
        Ok(_) => None,
        Err(e) => Some(clean_katex_error(&e.to_string())),
    }
}

// The KaTeX JS exception, as surfaced by the `katex` crate, looks like:
//   …KaTeX parse error: <message> at position <N>: <caret-context>"))
// We keep `<message> at position <N>` and drop the caret-context dump (which is
// full of combining-underline marks), then unescape the doubled backslashes the
// debug wrapper introduced.
static POSITION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" at position \d+:").unwrap());

/// Turn a raw `katex::Error` string into a concise `(message, hint)`.
fn clean_katex_error(raw: &str) -> (String, Option<String>) {
    // Everything after KaTeX's own marker; fall back to the whole string (it
    // still names the failure) if the marker is absent.
    let body = raw.split("KaTeX parse error: ").nth(1).unwrap_or(raw);

    // Cut the caret-context that follows " at position N:", keeping the position
    // itself (it tells the author where in the formula to look).
    let trimmed = match POSITION_RE.find(body) {
        Some(m) => body[..m.end()].trim_end_matches(':'),
        // No position marker (e.g. "\tag works only in display equations"): drop
        // the debug wrapper's trailing `"))` / quotes.
        None => body.trim_end_matches(['"', ')']).trim_end_matches('\\'),
    };
    let message = trimmed.replace("\\\\", "\\").trim().to_string();
    let hint = hint_for(&message);
    (message, hint)
}

/// A one-line fix suggestion for the common KaTeX failure shapes.
fn hint_for(message: &str) -> Option<String> {
    let m = message.to_ascii_lowercase();
    if m.contains("undefined control sequence") {
        Some("unknown command — check the spelling or use a KaTeX-supported macro".to_string())
    } else if m.contains("expected '}'") || m.contains("unexpected end of input") {
        Some("unbalanced braces — every `{` needs a matching `}`".to_string())
    } else if m.contains("only in display") {
        Some("use display math (`$$…$$`) for this construct".to_string())
    } else if m.contains("expected 'eof'") || m.contains("got '") {
        Some("unexpected token — a stray `}`, `$`, or `&` may be unescaped".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::FileType;
    use std::path::PathBuf;

    fn check(source: &str) -> Vec<Diagnostic> {
        let file = CheckFile {
            path: PathBuf::from("test.md"),
            rel: "test.md".to_string(),
            source: source.to_string(),
            file_type: FileType::Markdown,
        };
        let ctx = CheckCtx {
            dir: PathBuf::from("."),
        };
        MathValidator.check(&file, &ctx)
    }

    #[test]
    fn valid_inline_and_display_math_pass() {
        // All of these are valid KaTeX (and were false-positives under
        // pulldown-latex). They must produce zero diagnostics.
        let d = check(
            "Inline $\\operatorname{rank}_s = \\sum_i^n x_i$ and display:\n\n\
             $$\\boldsymbol{z}(t) = \\left\\langle x \\right\\rangle \\tag{1}$$\n",
        );
        assert!(d.is_empty(), "valid KaTeX flagged: {d:?}");
    }

    #[test]
    fn undefined_command_flagged() {
        let d = check("Broken: $\\notarealcommand{x}$\n");
        assert_eq!(d.len(), 1, "got: {d:?}");
        assert_eq!(d[0].rule, "math/parse-error");
        assert_eq!(d[0].severity, Severity::Warning);
        assert_eq!(d[0].source, "math");
        assert!(
            d[0].message
                .to_lowercase()
                .contains("undefined control sequence"),
            "message was: {}",
            d[0].message
        );
        // No caret-context noise leaked into the message.
        assert!(!d[0].message.contains('\u{332}'), "combining marks leaked");
    }

    #[test]
    fn unbalanced_brace_flagged() {
        let d = check("Display: $$\\frac{1}{2$$\n");
        assert_eq!(d.len(), 1, "got: {d:?}");
        assert!(d[0].hint.is_some());
    }

    #[test]
    fn plain_prose_with_currency_is_not_math() {
        // `$100` … `$200` is comrak currency, not a Math node — never checked.
        let d = check("It cost between $100 and $200 in total.\n");
        assert!(d.is_empty(), "currency treated as math: {d:?}");
    }
}
