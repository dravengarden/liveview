//! The mermaid validator — a deliberately *shallow* structural check.
//!
//! Unlike math (where we run real KaTeX), we can't run real mermaid: mermaid.js
//! is a browser renderer that manipulates the DOM, so it won't load in a bare JS
//! engine, and the available native-Rust mermaid parsers cover only a subset of
//! diagram types (they'd false-positive on the rest). So this validator checks
//! the one thing that's both high-signal and zero-false-positive: the diagram
//! **type declaration**. A fenced ```mermaid block whose first meaningful line
//! doesn't name a known mermaid diagram type (a typo like `flowcart`, or a
//! stray non-mermaid block) can never render — that's `mermaid/unknown-type`.
//!
//! Everything past the type line (node syntax, edges, labels) is left to the
//! reader's mermaid.js, which is authoritative. Severity is Warning.

use comrak::nodes::NodeValue;
use comrak::{parse_document, Arena};

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};
use crate::server::renderer;

pub struct MermaidValidator;

/// Known mermaid 11.x diagram-type keywords (lowercased, `-beta` suffixes
/// stripped). A real diagram's first token is always one of these; only a typo
/// or a non-mermaid block fails to match. Kept current with the client's
/// bundled mermaid — add new types here when the client's mermaid is upgraded.
const DIAGRAM_TYPES: &[&str] = &[
    "graph",
    "flowchart",
    "sequencediagram",
    "classdiagram",
    "classdiagram-v2",
    "statediagram",
    "statediagram-v2",
    "erdiagram",
    "journey",
    "gantt",
    "pie",
    "quadrantchart",
    "requirementdiagram",
    "gitgraph",
    "c4context",
    "c4container",
    "c4component",
    "c4dynamic",
    "c4deployment",
    "mindmap",
    "timeline",
    "zenuml",
    "sankey",
    "xychart",
    "block",
    "packet",
    "kanban",
    "architecture",
    "radar",
    "treemap",
];

impl Validator for MermaidValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        let arena = Arena::new();
        let root = parse_document(&arena, &file.source, &renderer::markdown_options());

        let mut diags = Vec::new();
        for node in root.descendants() {
            let data = node.data.borrow();
            let NodeValue::CodeBlock(cb) = &data.value else {
                continue;
            };
            // The info string's first token is the language; we only handle
            // ```mermaid fences.
            if cb.info.split_whitespace().next() != Some("mermaid") {
                continue;
            }
            let Some(token) = first_type_token(&cb.literal) else {
                // An empty mermaid block renders as nothing useful, but it isn't
                // a hard error; skip rather than nag.
                continue;
            };
            if is_known_type(&token) {
                continue;
            }
            let sp = data.sourcepos;
            diags.push(Diagnostic {
                file: file.rel.clone(),
                line: sp.start.line as u32,
                col: sp.start.column as u32,
                end_line: sp.end.line as u32,
                end_col: sp.end.column as u32,
                severity: Severity::Warning,
                source: "mermaid",
                rule: "mermaid/unknown-type".to_string(),
                message: format!(
                    "mermaid block does not start with a known diagram type (found `{token}`)"
                ),
                hint: Some(
                    "the first line must name a diagram type, e.g. `flowchart TD`, \
                     `sequenceDiagram`, `classDiagram`"
                        .to_string(),
                ),
                snippet: Some(token),
            });
        }
        diags
    }
}

/// The first meaningful token of a mermaid diagram: skip a leading `--- … ---`
/// frontmatter block, `%%{ init … }%%` directives, `%%` comments, and blank
/// lines, then return the first whitespace-delimited token of the first real
/// line.
fn first_type_token(source: &str) -> Option<String> {
    let mut lines = source.lines().peekable();

    // Optional YAML frontmatter: a line that is exactly `---`, consumed up to
    // the closing `---`.
    if lines.peek().map(|l| l.trim()) == Some("---") {
        lines.next();
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
        }
    }

    for line in lines {
        let t = line.trim();
        if t.is_empty() || t.starts_with("%%") {
            continue; // init directive (`%%{…}%%`) or comment.
        }
        // First whitespace-delimited token; e.g. "flowchart" from "flowchart TD".
        return t.split_whitespace().next().map(str::to_string);
    }
    None
}

/// Is `token` a recognized mermaid diagram type? Case-insensitive; tolerates a
/// trailing `:` (e.g. `gitGraph:`) and a `-beta` / `-v2`-style suffix on the
/// newer diagrams (`sankey-beta`, `xychart-beta`, `block-beta`, …).
fn is_known_type(token: &str) -> bool {
    let t = token.trim_end_matches(':').to_ascii_lowercase();
    let base = t.strip_suffix("-beta").unwrap_or(&t);
    DIAGRAM_TYPES.contains(&base) || DIAGRAM_TYPES.contains(&t.as_str())
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
        MermaidValidator.check(&file, &ctx)
    }

    #[test]
    fn valid_flowchart_passes() {
        let d = check("```mermaid\nflowchart TD\n  A --> B\n```\n");
        assert!(d.is_empty(), "valid mermaid flagged: {d:?}");
    }

    #[test]
    fn sequence_with_frontmatter_and_directive_passes() {
        let d = check(
            "```mermaid\n---\ntitle: Hi\n---\n%%{init: {'theme':'dark'}}%%\n\
             sequenceDiagram\n  A->>B: hi\n```\n",
        );
        assert!(d.is_empty(), "valid mermaid flagged: {d:?}");
    }

    #[test]
    fn beta_diagram_type_passes() {
        let d = check("```mermaid\nxychart-beta\n  title \"x\"\n```\n");
        assert!(d.is_empty(), "beta type flagged: {d:?}");
    }

    #[test]
    fn misspelled_type_flagged() {
        let d = check("```mermaid\nflowcart TD\n  A --> B\n```\n");
        assert_eq!(d.len(), 1, "got: {d:?}");
        assert_eq!(d[0].rule, "mermaid/unknown-type");
        assert_eq!(d[0].severity, Severity::Warning);
        assert!(d[0].message.contains("flowcart"));
    }

    #[test]
    fn non_mermaid_codeblock_ignored() {
        let d = check("```rust\nfn main() {}\n```\n");
        assert!(d.is_empty(), "non-mermaid block flagged: {d:?}");
    }
}
