//! The typst syntax validator.
//!
//! The reader only *syntax-highlights* `.typ` files (highlight.js) — it does
//! not compile them — so the property that matches "what renders" is the
//! cheaper one: does the source **parse** as well-formed typst? We use
//! `typst-syntax`, typst's parser alone (no compiler, no `World`, no fonts), and
//! report every syntax error it finds. `errors()` hands back each error's
//! message, the author-facing hints typst itself writes, and a span we map to
//! line/col.
//!
//! Severity is Warning — a syntax error means the source is malformed, but the
//! reader still highlights it; this is a stronger "is it valid typst" guarantee
//! than the current viewer strictly needs, and exactly what a future real-typst
//! renderer would require.

use typst_syntax::Source;

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};

pub struct TypstValidator;

impl Validator for TypstValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        // A detached source still numbers spans, so `range()` maps each error
        // back to a byte range we can turn into line/col.
        let source = Source::detached(file.source.clone());

        let mut diags = Vec::new();
        for err in source.root().errors() {
            let (line, col, end_line, end_col) = match source.range(err.span) {
                Some(r) => {
                    let (l, c) = byte_to_line_col(&file.source, r.start);
                    let (el, ec) = byte_to_line_col(&file.source, r.end);
                    (l, c, el, ec)
                }
                // A span the source can't place (shouldn't happen for a detached
                // parse) — anchor at the top rather than drop the error.
                None => (1, 1, 1, 1),
            };
            let hint = if err.hints.is_empty() {
                None
            } else {
                Some(
                    err.hints
                        .iter()
                        .map(|h| h.as_str())
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            };
            diags.push(Diagnostic {
                file: file.rel.clone(),
                line,
                col,
                end_line,
                end_col,
                severity: Severity::Warning,
                source: "typst",
                rule: "typst/syntax-error".to_string(),
                message: err.message.to_string(),
                hint,
                snippet: None,
            });
        }
        diags
    }
}

/// Map a byte offset in `source` to a 1-based (line, col).
fn byte_to_line_col(source: &str, offset: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut col = 1u32;
    for (i, ch) in source.char_indices() {
        if i >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::FileType;
    use std::path::PathBuf;

    fn check(source: &str) -> Vec<Diagnostic> {
        let file = CheckFile {
            path: PathBuf::from("test.typ"),
            rel: "test.typ".to_string(),
            source: source.to_string(),
            file_type: FileType::Typst,
        };
        let ctx = CheckCtx {
            dir: PathBuf::from("."),
        };
        TypstValidator.check(&file, &ctx)
    }

    #[test]
    fn valid_typst_passes() {
        let d = check("= Title\n\nSome *bold* text with math $x^2 + y^2$.\n\n#let a = 1\n");
        assert!(d.is_empty(), "valid typst flagged: {d:?}");
    }

    #[test]
    fn unclosed_call_paren_flagged() {
        // `#calc.max(1, 2` never closes its argument list — a syntax error.
        let d = check("#calc.max(1, 2\n");
        assert!(!d.is_empty(), "unclosed paren not flagged");
        assert_eq!(d[0].rule, "typst/syntax-error");
        assert_eq!(d[0].severity, Severity::Warning);
        assert_eq!(d[0].source, "typst");
    }

    #[test]
    fn unclosed_code_block_flagged() {
        let d = check("#{\n  let x = 1\n");
        assert!(!d.is_empty(), "unclosed code block not flagged: {d:?}");
        assert_eq!(d[0].rule, "typst/syntax-error");
    }
}
