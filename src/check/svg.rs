//! The inline-SVG validator.
//!
//! Books embed raw `<svg>…</svg>` blocks directly in markdown (67 files in the
//! corpus — hand/AI-authored diagrams); the reader passes them through as raw
//! HTML and the browser renders them. A malformed SVG silently fails to draw,
//! so we parse each embedded `<svg>` as XML with `roxmltree` (a small pure-Rust
//! XML parser — no rendering, no fonts). Ill-formed markup is `svg/parse-error`,
//! Warning.
//!
//! We scan the **raw source** for `<svg>…</svg>` rather than comrak's HTML
//! nodes, because a type-7 HTML block ends at the first blank line: an SVG with
//! an internal blank line is split across several AST nodes even though the
//! server emits them back-to-back and the browser reconstitutes one SVG (so the
//! per-node view would false-positive with "root never closed"). The raw span is
//! exactly what the browser sees. We still parse markdown — but only to find
//! fenced/inline **code** ranges, which the server escapes rather than renders,
//! so an `<svg>` shown as a code example is correctly ignored.

use std::ops::Range;

use comrak::nodes::NodeValue;
use comrak::{parse_document, Arena};

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};
use crate::server::renderer;

pub struct SvgValidator;

impl Validator for SvgValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        let src = &file.source;
        if !src.contains("<svg") {
            return Vec::new();
        }

        // Parse only to find code regions to exclude (code is escaped, not
        // rendered, so an `<svg>` inside a fence is not a live SVG).
        let arena = Arena::new();
        let root = parse_document(&arena, src, &renderer::markdown_options());
        let starts = line_starts(src);
        let code = collect_code_ranges(root, &starts, src.len());

        let mut diags = Vec::new();
        for (off, svg) in extract_svgs(src) {
            if code.iter().any(|r| r.contains(&off)) {
                continue;
            }
            let Err(err) = roxmltree::Document::parse(svg) else {
                continue;
            };
            // Anchor at the `<svg`, then offset by roxmltree's 1-based row/col
            // within the svg substring.
            let (svg_line, svg_col) = byte_to_line_col(src, off);
            let pos = err.pos();
            let line = svg_line + pos.row.saturating_sub(1);
            let col = if pos.row <= 1 {
                svg_col + pos.col.saturating_sub(1)
            } else {
                pos.col
            };
            diags.push(Diagnostic {
                file: file.rel.clone(),
                line,
                col,
                end_line: line,
                end_col: col,
                severity: Severity::Warning,
                source: "svg",
                rule: "svg/parse-error".to_string(),
                message: format!("malformed inline SVG: {err}"),
                hint: Some(
                    "inline SVG must be well-formed XML — check for unclosed \
                     tags or unescaped `<`/`&`"
                        .to_string(),
                ),
                snippet: Some(svg.chars().take(48).collect()),
            });
        }
        diags
    }
}

/// Every `<svg>…</svg>` span in `src`, as `(byte_offset, substring)`. A `<svg`
/// with no closing `</svg>` hands the rest of the string to the parser (which
/// then reports the unexpected EOF — a real "unclosed SVG" error).
fn extract_svgs(src: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut search = 0;
    while let Some(rel) = src[search..].find("<svg") {
        let start = search + rel;
        let end = match src[start..].find("</svg>") {
            Some(e) => start + e + "</svg>".len(),
            None => src.len(),
        };
        out.push((start, &src[start..end]));
        search = end;
    }
    out
}

/// Byte offset of the start of each line (1-based line `n` → `starts[n - 1]`).
fn line_starts(src: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// Byte ranges covered by code blocks and inline code, line-granular (whole
/// lines, so no fragile column/byte math on CJK content). An `<svg>` starting
/// inside one of these is a code example, not a rendered SVG.
fn collect_code_ranges<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    starts: &[usize],
    src_len: usize,
) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        if !matches!(data.value, NodeValue::CodeBlock(_) | NodeValue::Code(_)) {
            continue;
        }
        let sp = data.sourcepos;
        let begin = starts
            .get(sp.start.line.saturating_sub(1))
            .copied()
            .unwrap_or(0);
        // End at the start of the line *after* the node's last line (or EOF).
        let end = starts.get(sp.end.line).copied().unwrap_or(src_len);
        ranges.push(begin..end);
    }
    ranges
}

/// Map a byte offset in `src` to a 1-based (line, col).
fn byte_to_line_col(src: &str, offset: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut col = 1u32;
    for (i, ch) in src.char_indices() {
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
            path: PathBuf::from("test.md"),
            rel: "test.md".to_string(),
            source: source.to_string(),
            file_type: FileType::Markdown,
        };
        let ctx = CheckCtx {
            dir: PathBuf::from("."),
        };
        SvgValidator.check(&file, &ctx)
    }

    #[test]
    fn wellformed_svg_passes() {
        let d = check(
            "Diagram:\n\n\
             <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\">\n\
             <rect x=\"1\" y=\"1\" width=\"8\" height=\"8\"/>\n\
             </svg>\n",
        );
        assert!(d.is_empty(), "well-formed svg flagged: {d:?}");
    }

    #[test]
    fn svg_with_internal_blank_line_passes() {
        // comrak splits this into multiple HTML blocks, but the browser sees one
        // contiguous SVG — the raw-source scan must too.
        let d = check(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\">\n\
             <rect x=\"1\" y=\"1\" width=\"8\" height=\"8\"/>\n\
             \n\
             <text x=\"2\" y=\"2\">hi</text>\n\
             </svg>\n",
        );
        assert!(d.is_empty(), "blank-line svg flagged: {d:?}");
    }

    #[test]
    fn unclosed_tag_flagged() {
        let d = check(
            "<svg xmlns=\"http://www.w3.org/2000/svg\">\n<rect x=\"1\">\n</svg>\n",
        );
        assert_eq!(d.len(), 1, "got: {d:?}");
        assert_eq!(d[0].rule, "svg/parse-error");
        assert_eq!(d[0].severity, Severity::Warning);
    }

    #[test]
    fn unescaped_ampersand_flagged() {
        let d = check(
            "<svg xmlns=\"http://www.w3.org/2000/svg\">\n<text>A & B</text>\n</svg>\n",
        );
        assert_eq!(d.len(), 1, "unescaped & not flagged: {d:?}");
    }

    #[test]
    fn svg_inside_code_fence_ignored() {
        // A malformed SVG shown as a fenced code example is escaped by the
        // renderer, not drawn — so it must not be flagged.
        let d = check("```html\n<svg><rect>\n```\n");
        assert!(d.is_empty(), "code-fenced svg flagged: {d:?}");
    }

    #[test]
    fn non_svg_html_ignored() {
        let d = check("<div class=\"note\">\njust html, no svg\n</div>\n");
        assert!(d.is_empty(), "non-svg html flagged: {d:?}");
    }
}
