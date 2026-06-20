//! Strip + segment markdown into speakable sentences.
//!
//! Mirrors the strip policy of `narrate-book/helpers/narrate.py` in the
//! columbus harness (keep the two in sync) and adds zh+en sentence
//! segmentation. The single ordered list this produces feeds BOTH the
//! read-along view's `<span data-sent=N>` spans and the edge-tts time marks, so
//! audio, marks, and highlighted text align by construction.
//!
//! Dropped: fenced code (``` / ~~~, incl. mermaid), display math (`$$…$$`), GFM
//! tables, footnote definitions, raw-HTML lines, images, inline math, footnote
//! refs. Rewritten: `[text](url)` → `text`. Markdown markers (heading `#`, list
//! bullets, blockquote `>`, emphasis `* _ ~ \``) are stripped to plain prose.

use std::sync::LazyLock;

use comrak::nodes::{AstNode, NodeValue};
use comrak::{parse_document, Arena};
use regex::Regex;
use serde::Serialize;

use crate::server::renderer::markdown_options;

// Block-level structure detectors.
static TABLE_DELIM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$").unwrap());
static FOOTNOTE_DEF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[\^[^\]]+\]:").unwrap());
static HTML_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*</?[a-zA-Z][^>]*>\s*$").unwrap());

// Inline detectors. (Rust's regex crate has no lookaround, so inline math is a
// plain `$…$` with no inner `$`; a rare mid-line `$$…$$` is close enough.)
static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]*\)").unwrap());
static FOOTNOTE_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\^[^\]]+\]").unwrap());
static INLINE_MATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$[^$\n]+\$").unwrap());

// Leading block markers to drop, leaving the prose.
static LEADING_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)").unwrap());
static EMPHASIS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*|__|~~|[*`]").unwrap());
static MULTISPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {2,}").unwrap());

const MIN_DISPLAY_MATH_LEN: usize = 4;
/// zh + en sentence terminators. The en ones (`.!?;`) only end a sentence when
/// followed by whitespace or end-of-block, so decimals like `3.5` don't split.
const ZH_TERMINATORS: &[char] = &['。', '！', '？', '；', '…'];
const EN_TERMINATORS: &[char] = &['.', '!', '?', ';'];

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

fn is_math_delim(line: &str) -> bool {
    line.trim() == "$$"
}

fn is_table_row(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('|') && t.ends_with('|') && t.len() > 1
}

/// If a droppable block starts at `lines[i]`, return the index just past it.
fn consume_block(lines: &[&str], i: usize) -> Option<usize> {
    let line = lines[i];
    let n = lines.len();

    if is_fence(line) {
        let marker = if line.trim_start().starts_with("```") {
            "```"
        } else {
            "~~~"
        };
        let mut j = i + 1;
        while j < n && !lines[j].trim_start().starts_with(marker) {
            j += 1;
        }
        return Some(j + 1);
    }

    if is_math_delim(line) {
        let mut j = i + 1;
        while j < n && !is_math_delim(lines[j]) {
            j += 1;
        }
        return Some(j + 1);
    }
    let t = line.trim();
    if t.starts_with("$$") && t.ends_with("$$") && t.len() > MIN_DISPLAY_MATH_LEN {
        return Some(i + 1);
    }

    if is_table_row(line) && i + 1 < n && TABLE_DELIM.is_match(lines[i + 1]) {
        let mut j = i + 2;
        while j < n && is_table_row(lines[j]) {
            j += 1;
        }
        return Some(j);
    }

    if FOOTNOTE_DEF.is_match(line) {
        let mut j = i + 1;
        while j < n && !lines[j].trim().is_empty() {
            j += 1;
        }
        return Some(j);
    }

    if HTML_BLOCK.is_match(line) {
        return Some(i + 1);
    }

    None
}

/// Reduce one kept line to plain prose: drop inline images/math/footnote-refs,
/// links→text, leading block markers, emphasis markers; collapse spaces.
fn clean_line(line: &str) -> String {
    let s = IMAGE.replace_all(line, "");
    let s = INLINE_MATH.replace_all(&s, "");
    let s = FOOTNOTE_REF.replace_all(&s, "");
    let s = LINK.replace_all(&s, "$1");
    let s = LEADING_MARKER.replace(&s, "");
    let s = EMPHASIS.replace_all(&s, "");
    MULTISPACE.replace_all(s.trim(), " ").into_owned()
}

/// Join soft-wrapped lines of one block: no space between two CJK chars, a
/// single space otherwise (so English words keep their separator).
fn join_wrapped(lines: &[String]) -> String {
    let mut out = String::new();
    for line in lines {
        if out.is_empty() {
            out.push_str(line);
            continue;
        }
        let prev = out.chars().next_back();
        let next = line.chars().next();
        let both_cjk = matches!((prev, next), (Some(a), Some(b)) if !a.is_ascii() && !b.is_ascii());
        if !both_cjk {
            out.push(' ');
        }
        out.push_str(line);
    }
    out
}

/// Segment one prose block into sentences on zh/en terminators.
fn segment_block(block: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = block.chars().collect();
    let mut buf = String::new();
    for (i, &c) in chars.iter().enumerate() {
        buf.push(c);
        let flush = if ZH_TERMINATORS.contains(&c) {
            true
        } else if EN_TERMINATORS.contains(&c) {
            chars.get(i + 1).is_none_or(|n| n.is_whitespace())
        } else {
            false
        };
        if flush {
            push_sentence(&mut buf, out);
        }
    }
    push_sentence(&mut buf, out);
}

fn push_sentence(buf: &mut String, out: &mut Vec<String>) {
    let s = buf.trim();
    if !s.is_empty() {
        out.push(s.to_owned());
    }
    buf.clear();
}

/// Turn chapter markdown into an ordered list of speakable sentences.
pub fn spoken_sentences(markdown: &str) -> Vec<String> {
    let lines: Vec<&str> = markdown.lines().collect();
    let n = lines.len();

    // Pass 1: strip droppable blocks; clean kept lines; group into
    // blank-line-separated blocks of plain prose.
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut i = 0;
    while i < n {
        if let Some(skip_to) = consume_block(&lines, i) {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
            i = skip_to;
            continue;
        }
        if lines[i].trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else {
            let cleaned = clean_line(lines[i]);
            if !cleaned.is_empty() {
                current.push(cleaned);
            }
        }
        i += 1;
    }
    if !current.is_empty() {
        blocks.push(current);
    }

    // Pass 2: join each block's wrapped lines, then segment into sentences.
    let mut sentences = Vec::new();
    for block in &blocks {
        segment_block(&join_wrapped(block), &mut sentences);
    }
    sentences
}

// ─────────────────────────────────────────────────────────────────────────────
// AST-based units (the read-aloud / in-place-highlight path).
//
// Why a second extractor instead of patching `spoken_sentences`: this walks the
// SAME comrak parse the server renders with (`renderer::markdown_options`), so
// "what's speakable" is decided by the real parser — currency `$5`, indented
// code, multiline HTML, GFM tables etc. are classified exactly as they render,
// not by parallel regexes. It also yields a `blk` anchor (the top-level rendered
// block ordinal) so the read-along highlight can locate each unit in the DOM.
// `spoken_sentences` above is left byte-for-byte unchanged so the existing
// audiobook path is unaffected; this is purely additive.
// ─────────────────────────────────────────────────────────────────────────────

/// Kind of a chapter unit. Non-prose kinds carry no spoken text yet (a one-line
/// narration is filled in later, or the unit is skipped); they exist so the
/// read-along can still step over / outline the block in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitKind {
    Prose,
    Image,
    Math,
    Code,
    Table,
    Html,
}

/// One speakable/anchorable unit: a sentence of prose, or a non-prose block.
/// `blk` is the ordinal of the top-level rendered block it belongs to (the
/// highlight anchor); `idx` is its position in the chapter's ordered unit list
/// and matches the audio mark index + the `data-sent` anchor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Unit {
    pub idx: usize,
    pub kind: UnitKind,
    pub blk: usize,
    /// 1-based source line of the unit's top-level block — the STABLE highlight
    /// anchor. Matches the `data-sourcepos="<line>:…"` the renderer emits on that
    /// block (`render.sourcepos`), so the client finds the element by id, not by
    /// counting `body.children`. All units in one block share its line (like `blk`).
    pub line: usize,
    pub text: String,
    /// Raw source of a non-prose block — the input for spoken narration:
    /// code/math literal, image alt-or-URL, the table's linearized cells, the
    /// raw HTML literal. Empty for prose. Server-internal: never sent to the
    /// client (it's the narration input, not display text).
    #[serde(skip)]
    pub src: String,
    /// Resource discriminator the speech registry routes on, beyond the coarse
    /// `kind`: a code block's fence language (`mermaid`, `julia`, …), or an
    /// image's URL (for an `.svg` figure). Empty when `kind` alone suffices.
    /// Server-internal. Lets one `UnitKind::Code` split into mermaid-diagram vs
    /// real-code narration without a new highlight class (see `speakable`).
    #[serde(skip)]
    pub info: String,
}

/// Collect inline prose from `node`'s children into soft-wrap fragments,
/// skipping inline images / math / raw HTML / footnote refs; inline code and
/// link/emphasis text ARE spoken (matching `spoken_sentences`' policy).
fn collect_inline<'a>(node: &'a AstNode<'a>, frags: &mut Vec<String>, cur: &mut String) {
    for child in node.children() {
        match &child.data.borrow().value {
            NodeValue::Text(t) => cur.push_str(t),
            NodeValue::Code(c) => cur.push_str(&c.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => frags.push(std::mem::take(cur)),
            NodeValue::Image(_)
            | NodeValue::Math(_)
            | NodeValue::HtmlInline(_)
            | NodeValue::FootnoteReference(_) => {}
            // Emphasis / links / strikethrough / … — recurse for their text.
            _ => collect_inline(child, frags, cur),
        }
    }
}

/// The plain prose of one leaf block (paragraph/heading), soft-wraps joined.
fn leaf_prose<'a>(node: &'a AstNode<'a>) -> String {
    let mut frags = Vec::new();
    let mut cur = String::new();
    collect_inline(node, &mut frags, &mut cur);
    frags.push(cur);
    join_wrapped(&frags)
}

/// If a leaf block carries an image, display-math, or only inline raw HTML but no
/// prose, return its kind + source + info — the input for narration. Such a
/// paragraph renders as a figure / formula / embedded diagram, so it's an
/// Image / Math / Html unit. `info` carries the image URL (so the speech registry
/// can spot an `.svg` figure and describe its relations rather than read alt
/// text), empty otherwise. Image/Math win over inline HTML when both are present.
fn non_prose_block<'a>(node: &'a AstNode<'a>) -> Option<(UnitKind, String, String)> {
    let mut html = String::new();
    for d in node.descendants() {
        match &d.data.borrow().value {
            NodeValue::Image(link) => {
                // Alt text = the image node's inline children; fall back to URL.
                let mut frags = Vec::new();
                let mut cur = String::new();
                collect_inline(d, &mut frags, &mut cur);
                frags.push(cur);
                let alt = join_wrapped(&frags);
                let src = if alt.trim().is_empty() { link.url.clone() } else { alt };
                return Some((UnitKind::Image, src, link.url.clone()));
            }
            NodeValue::Math(m) => return Some((UnitKind::Math, m.literal.clone(), String::new())),
            // A single-line `<svg>…</svg>` (or other raw markup) renders as inline
            // HTML inside a paragraph, not an HtmlBlock — gather it so an inline
            // diagram still becomes an Html unit the registry can describe.
            NodeValue::HtmlInline(h) => html.push_str(h),
            _ => {}
        }
    }
    (!html.trim().is_empty()).then_some((UnitKind::Html, html, String::new()))
}

/// Linearize a GFM table into one narration-input string: header cells, then
/// each data row, cells joined by `" | "` and rows by `" || "`, the header row
/// tagged so the speech registry can phrase it as "columns A, B, C; row 1 …".
/// (A screen reader reads cell-by-cell with header context; for read-along we
/// hand the whole grid to the narrator, which turns it into a spoken enumeration
/// or a one-line takeaway — see `speakable`.) Empty if the table has no cells.
fn table_source<'a>(table: &'a AstNode<'a>) -> String {
    let mut rows: Vec<String> = Vec::new();
    for row in table.children() {
        let is_header = matches!(row.data.borrow().value, NodeValue::TableRow(true));
        let mut cells: Vec<String> = Vec::new();
        for cell in row.children() {
            if matches!(cell.data.borrow().value, NodeValue::TableCell) {
                cells.push(leaf_prose(cell).trim().to_string());
            }
        }
        if cells.iter().all(String::is_empty) {
            continue;
        }
        let joined = cells.join(" | ");
        rows.push(if is_header {
            format!("columns: {joined}")
        } else {
            joined
        });
    }
    rows.join(" || ")
}

/// A unit before its chapter-wide `idx` is assigned (set in `spoken_units`).
fn mk(kind: UnitKind, blk: usize, line: usize, text: String, src: String, info: String) -> Unit {
    Unit { idx: 0, kind, blk, line, text, src, info }
}

/// Emit the unit(s) for one block at top-level ordinal `blk` (source `line`),
/// recursing into containers (lists/quotes) so nested paragraphs share the
/// container's anchor + line.
fn emit_block<'a>(node: &'a AstNode<'a>, blk: usize, line: usize, out: &mut Vec<Unit>) {
    match &node.data.borrow().value {
        NodeValue::CodeBlock(nc) => {
            // Keep the fence language (first info-string token) so the registry
            // can route ```mermaid to the diagram narrator, not generic code.
            let lang = nc.info.split_whitespace().next().unwrap_or("").to_string();
            out.push(mk(UnitKind::Code, blk, line, String::new(), nc.literal.clone(), lang));
        }
        NodeValue::Table(_) => {
            out.push(mk(UnitKind::Table, blk, line, String::new(), table_source(node), String::new()));
        }
        NodeValue::HtmlBlock(nh) => {
            // Carry the raw HTML so the registry can describe an inline <svg>
            // diagram (else it stays a silent step-over, as before).
            out.push(mk(UnitKind::Html, blk, line, String::new(), nh.literal.clone(), String::new()));
        }
        // Structural / non-spoken — no unit, but the block ordinal still advances.
        NodeValue::ThematicBreak | NodeValue::FootnoteDefinition(_) | NodeValue::FrontMatter(_) => {}
        NodeValue::Paragraph | NodeValue::Heading(_) => {
            let prose = leaf_prose(node);
            if prose.trim().is_empty() {
                if let Some((kind, src, info)) = non_prose_block(node) {
                    out.push(mk(kind, blk, line, String::new(), src, info));
                }
            } else {
                let mut sentences = Vec::new();
                segment_block(&prose, &mut sentences);
                for s in sentences {
                    out.push(mk(UnitKind::Prose, blk, line, s, String::new(), String::new()));
                }
            }
        }
        // Containers: recurse, keeping the same top-level block anchor + line.
        NodeValue::BlockQuote
        | NodeValue::MultilineBlockQuote(_)
        | NodeValue::List(_)
        | NodeValue::Item(_)
        | NodeValue::TaskItem(_)
        | NodeValue::DescriptionList
        | NodeValue::DescriptionItem(_)
        | NodeValue::DescriptionTerm
        | NodeValue::DescriptionDetails => {
            for child in node.children() {
                emit_block(child, blk, line, out);
            }
        }
        // Anything else: best-effort prose extraction.
        _ => {
            let prose = leaf_prose(node);
            if !prose.trim().is_empty() {
                let mut sentences = Vec::new();
                segment_block(&prose, &mut sentences);
                for s in sentences {
                    out.push(mk(UnitKind::Prose, blk, line, s, String::new(), String::new()));
                }
            }
        }
    }
}

/// Turn chapter markdown into an ordered list of units (prose sentences + the
/// non-prose blocks between them), each anchored to its top-level block ordinal
/// + source line (the `data-sourcepos` the renderer emits).
pub fn spoken_units(markdown: &str) -> Vec<Unit> {
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &markdown_options());
    let mut raw: Vec<Unit> = Vec::new();
    for (blk, node) in root.children().enumerate() {
        let line = node.data.borrow().sourcepos.start.line;
        emit_block(node, blk, line, &mut raw);
    }
    for (idx, unit) in raw.iter_mut().enumerate() {
        unit.idx = idx;
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_unreadable_blocks() {
        let md = "# 标题\n\n这是第一句。这是第二句！\n\n\
                  ```rust\nfn drop_me() {}\n```\n\n\
                  | a | b |\n|---|---|\n| 1 | 2 |\n\n\
                  $$\nE=mc^2\n$$\n\n看 ![图](a.png) 还有 [链接](http://x) 收尾。\n\n\
                  [^n]: footnote def.\n";
        let s = spoken_sentences(md);
        let joined = s.join("\n");
        assert!(!joined.contains("drop_me"), "code leaked: {joined}");
        assert!(!joined.contains('|'), "table leaked: {joined}");
        assert!(!joined.contains("E=mc"), "math leaked: {joined}");
        assert!(!joined.contains("a.png"), "image leaked: {joined}");
        assert!(!joined.contains("http"), "link url leaked: {joined}");
        assert!(
            !joined.contains("footnote def"),
            "footnote leaked: {joined}"
        );
    }

    #[test]
    fn splits_zh_and_en_sentences() {
        let s = spoken_sentences("这是第一句。这是第二句！第三句？\n\nA sentence. Another one!");
        assert_eq!(
            s,
            [
                "这是第一句。",
                "这是第二句！",
                "第三句？",
                "A sentence.",
                "Another one!"
            ]
        );
    }

    #[test]
    fn keeps_english_terms_and_strips_markup() {
        // emphasis + heading markers gone; English terms and link text kept.
        let s = spoken_sentences("## The **EVM** model\n\n用 `STF(state, tx)` 计算 [新状态](x)。");
        assert_eq!(s[0], "The EVM model");
        assert!(
            s[1].contains("STF(state, tx)"),
            "inline code text lost: {:?}",
            s
        );
        assert!(
            s[1].contains("新状态") && !s[1].contains('['),
            "link not unwrapped: {:?}",
            s
        );
    }

    #[test]
    fn joins_wrapped_cjk_without_spaces() {
        // A soft-wrapped Chinese paragraph becomes one sentence, no stray spaces.
        let s = spoken_sentences("以太坊是一个全局\n复制的状态机。");
        assert_eq!(s, ["以太坊是一个全局复制的状态机。"]);
    }

    #[test]
    fn decimals_do_not_split() {
        let s = spoken_sentences("gas price is 3.5 gwei here.");
        assert_eq!(s, ["gas price is 3.5 gwei here."]);
    }

    #[test]
    fn units_keep_currency_and_classify_blocks() {
        let md = "看价格 $5 and $10 这里。\n\n\
                  ```rust\nfn x() {}\n```\n\n\
                  | a | b |\n|---|---|\n| 1 | 2 |\n\n\
                  ![图](a.png)\n";
        let u = spoken_units(md);
        // First block: prose, and the regex extractor's currency bug is gone —
        // comrak's real `$`-math rule leaves "$5 and $10" as text.
        assert_eq!(u[0].kind, UnitKind::Prose);
        assert!(
            u[0].text.contains("$5") && u[0].text.contains("$10"),
            "currency lost: {:?}",
            u[0]
        );
        assert_eq!(u[0].blk, 0);
        let kinds: Vec<_> = u.iter().map(|x| x.kind).collect();
        assert!(kinds.contains(&UnitKind::Code), "no code unit: {kinds:?}");
        assert!(kinds.contains(&UnitKind::Table), "no table unit: {kinds:?}");
        assert!(kinds.contains(&UnitKind::Image), "no image unit: {kinds:?}");
        // blk is the top-level block ordinal: para=0, code=1, table=2, image=3.
        assert_eq!(u.iter().find(|x| x.kind == UnitKind::Code).unwrap().blk, 1);
        assert_eq!(u.iter().find(|x| x.kind == UnitKind::Image).unwrap().blk, 3);
    }

    #[test]
    fn units_segment_prose_with_shared_block_anchor() {
        let u = spoken_units("第一句。第二句！\n\n第三段。");
        let prose: Vec<_> = u.iter().filter(|x| x.kind == UnitKind::Prose).collect();
        assert_eq!(prose.len(), 3);
        assert_eq!(prose[0].blk, 0);
        assert_eq!(prose[1].blk, 0); // same paragraph → same anchor
        assert_eq!(prose[2].blk, 1); // next paragraph → next anchor
        assert!(u.iter().enumerate().all(|(i, x)| x.idx == i));
    }

    #[test]
    fn units_capture_table_html_and_code_lang_source() {
        let md = "```mermaid\ngraph TD; A-->B;\n```\n\n\
                  | Name | Role |\n|---|---|\n| Ada | dev |\n| Bo | ops |\n\n\
                  <svg><circle/></svg>\n";
        let u = spoken_units(md);
        let code = u.iter().find(|x| x.kind == UnitKind::Code).unwrap();
        assert_eq!(code.info, "mermaid", "fence lang lost: {code:?}");
        assert!(code.src.contains("A-->B"), "code literal lost: {code:?}");
        let table = u.iter().find(|x| x.kind == UnitKind::Table).unwrap();
        assert!(table.src.contains("columns: Name | Role"), "header lost: {table:?}");
        assert!(table.src.contains("Ada | dev") && table.src.contains(" || "), "rows lost: {table:?}");
        let html = u.iter().find(|x| x.kind == UnitKind::Html).unwrap();
        assert!(html.src.contains("<svg"), "html literal lost: {html:?}");
    }

    #[test]
    fn units_carry_block_source_line_for_anchoring() {
        // line 1 = paragraph, line 3 = code fence (1-based, matching data-sourcepos).
        let u = spoken_units("first para.\n\n```rust\nfn x() {}\n```\n");
        assert_eq!(u.iter().find(|x| x.kind == UnitKind::Prose).unwrap().line, 1);
        assert_eq!(u.iter().find(|x| x.kind == UnitKind::Code).unwrap().line, 3);
    }

    #[test]
    fn units_carry_image_url_in_info() {
        let u = spoken_units("![a diagram of the flow](pipeline.svg)\n");
        let img = u.iter().find(|x| x.kind == UnitKind::Image).unwrap();
        assert_eq!(img.src, "a diagram of the flow");
        assert_eq!(img.info, "pipeline.svg", "image url not in info: {img:?}");
    }

    #[test]
    fn units_keep_inline_code_drop_image_and_math() {
        let u = spoken_units("用 `STF(s,t)` 计算 $x^2$ 和 ![图](a.png) 收尾。");
        let p = u.iter().find(|x| x.kind == UnitKind::Prose).unwrap();
        assert!(p.text.contains("STF(s,t)"), "inline code lost: {p:?}");
        assert!(
            !p.text.contains("x^2") && !p.text.contains("a.png"),
            "math/image leaked into prose: {p:?}"
        );
    }
}
