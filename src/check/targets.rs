//! `liveview targets` — enumerate the renderable charts (inline SVG + mermaid)
//! in a book, with where they live + how to reach them in the reader, so the
//! visual-QA loop (the `chart-review` skill) knows what to screenshot.
//!
//! This is the content-authority half of the visual checker: liveview knows
//! which charts exist and where they render; the screenshotting/judging is the
//! skill + Chrome MCP. Chart detection reuses the exact same passes the checker
//! uses — `svg::svg_spans` (raw-source `<svg>` scan, code-excluded) and the
//! mermaid fenced-block walk — so a target is precisely a thing the reader
//! renders.

use comrak::nodes::NodeValue;
use comrak::{parse_document, Arena};
use serde::Serialize;

use crate::check::svg::svg_spans;
use crate::config::{RenditionKind, Resolved};
use crate::server::renderer;

/// The kind of chart, which also tells the skill how to locate it in the DOM:
/// `svg` → the nth content `<svg>` (excluding `.katex` / `.mermaid` subtrees);
/// `mermaid` → the nth `div.mermaid`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartKind {
    Svg,
    Mermaid,
}

/// One chart found in a single markdown source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartHit {
    pub kind: ChartKind,
    /// 1-based source line of the chart's start.
    pub line: u32,
    /// 0-based index among charts of the SAME kind in this file, in document
    /// order — matches the reader's DOM order (`querySelectorAll(...)[nth]`).
    pub nth: u32,
}

/// One chart's full render target, emitted by `liveview targets`.
#[derive(Debug, Clone, Serialize)]
pub struct ChartTarget {
    pub book: String,
    pub lang: String,
    /// Book-relative path of the source file (for display / locating the chart
    /// in the source to regenerate it).
    pub file: String,
    pub line: u32,
    pub kind: ChartKind,
    pub nth: u32,
    /// The reader URL that renders this chart's page (hash route).
    pub page_url: String,
}

/// Every renderable chart in one markdown source, document-ordered by line.
/// `nth` is assigned per kind in document order (so it lines up with the DOM).
pub fn charts_in(source: &str) -> Vec<ChartHit> {
    let mut hits: Vec<ChartHit> = Vec::new();

    // Inline SVG — the same spans the svg validator renders/checks (code fences
    // already excluded); document order, so enumerate gives the DOM nth.
    for (i, span) in svg_spans(source).iter().enumerate() {
        hits.push(ChartHit {
            kind: ChartKind::Svg,
            line: span.line,
            nth: i as u32,
        });
    }

    // Mermaid fenced blocks (```mermaid → the reader's `div.mermaid`).
    let arena = Arena::new();
    let root = parse_document(&arena, source, &renderer::markdown_options());
    let mut m = 0u32;
    for node in root.descendants() {
        let data = node.data.borrow();
        if let NodeValue::CodeBlock(cb) = &data.value {
            if cb.info.split_whitespace().next() == Some("mermaid") {
                hits.push(ChartHit {
                    kind: ChartKind::Mermaid,
                    line: data.sourcepos.start.line as u32,
                    nth: m,
                });
                m += 1;
            }
        }
    }

    // Output in source order; nth (per kind) is preserved for DOM resolution.
    hits.sort_by_key(|h| h.line);
    hits
}

/// Collect every chart target across the resolved corpus' **text** rendition
/// (charts live in the read mode, not the audiobook). `base_url` is the reader
/// origin (e.g. `http://127.0.0.1:4160`); `book_filter` limits to one slug.
pub fn collect(
    resolved: &Resolved,
    base_url: &str,
    book_filter: Option<&str>,
) -> Result<Vec<ChartTarget>, String> {
    let base = base_url.trim_end_matches('/');
    let mut out = Vec::new();
    for book in &resolved.books {
        if book_filter.is_some_and(|f| f != book.slug) {
            continue;
        }
        let Some(text) = book.renditions.iter().find(|r| r.kind == RenditionKind::Text) else {
            continue;
        };
        for ed in &text.editions {
            let mut files: Vec<(String, std::path::PathBuf)> = Vec::new();
            crate::sync::run::walk(&ed.source, &ed.source, ed, &mut files)?;
            files.sort_by(|a, b| a.0.cmp(&b.0));
            for (rel, abs) in files {
                if !rel.ends_with(".md") {
                    continue;
                }
                let source =
                    std::fs::read_to_string(&abs).map_err(|e| format!("read {}: {e}", abs.display()))?;
                let charts = charts_in(&source);
                if charts.is_empty() {
                    continue;
                }
                // Reader hash route: `#<encodeURIComponent(slug/rel)>&lang=<lang>`
                // — mirrors the SPA's buildHash exactly.
                let path = format!("{}/{}", book.slug, rel);
                let page_url =
                    format!("{base}/#{}&lang={}", encode_uri_component(&path), ed.lang);
                for c in charts {
                    out.push(ChartTarget {
                        book: book.slug.clone(),
                        lang: ed.lang.clone(),
                        file: rel.clone(),
                        line: c.line,
                        kind: c.kind,
                        nth: c.nth,
                        page_url: page_url.clone(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// `encodeURIComponent` semantics — the unreserved set the SPA's `buildHash`
/// relies on (`encodeURIComponent`), so the emitted hash decodes back to the
/// exact path the reader expects.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_svg_and_mermaid_with_per_kind_nth() {
        let src = "\
# Doc

<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>

```mermaid
flowchart TD
  A --> B
```

<svg xmlns=\"http://www.w3.org/2000/svg\"><circle/></svg>
";
        let hits = charts_in(src);
        assert_eq!(hits.len(), 3, "got: {hits:?}");
        // Document order by line: svg(nth0), mermaid(nth0), svg(nth1).
        assert_eq!(hits[0].kind, ChartKind::Svg);
        assert_eq!(hits[0].nth, 0);
        assert_eq!(hits[1].kind, ChartKind::Mermaid);
        assert_eq!(hits[1].nth, 0);
        assert_eq!(hits[2].kind, ChartKind::Svg);
        assert_eq!(hits[2].nth, 1);
        // Lines are increasing.
        assert!(hits[0].line < hits[1].line && hits[1].line < hits[2].line);
    }

    #[test]
    fn svg_in_code_fence_is_not_a_target() {
        let src = "```html\n<svg><rect></svg>\n```\n";
        assert!(charts_in(src).is_empty());
    }

    #[test]
    fn no_charts_is_empty() {
        assert!(charts_in("# Just text\n\nNo charts here.\n").is_empty());
    }
}
