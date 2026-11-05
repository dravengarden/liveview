use comrak::nodes::{AstNode, NodeValue};
use comrak::{Arena, Options, format_html, parse_document};

use crate::shared::FileType;

/// The single source of truth for how we parse/render Markdown.
///
/// Why a shared builder: the `check` subcommand parses with the *exact same*
/// options as the server renders with, so a clean check matches what actually
/// renders (a footnote/link/table that comrak resolves here is one the checker
/// won't flag, and vice-versa). Keep every extension/render flag here — never
/// re-derive options in the checker or the two will silently diverge.
pub fn markdown_options() -> Options<'static> {
    let mut options = Options::default();

    // GFM extensions
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;

    // Additional extensions
    options.extension.header_ids = Some(String::new());
    options.extension.description_lists = true;
    options.extension.multiline_block_quotes = true;

    // Enable math delimiters for KaTeX
    options.extension.math_dollars = true;
    options.extension.math_code = true;

    // Render options
    options.render.unsafe_ = true;
    options.render.github_pre_lang = true;
    options.render.full_info_string = true;

    options
}

/// Render file content based on file type.
pub fn render_file(source: &str, file_type: &FileType) -> String {
    match file_type {
        FileType::Markdown => render_markdown(source),
        // For these types, frontend handles rendering, just return raw content
        FileType::Html
        | FileType::Csv
        | FileType::Json
        | FileType::Excalidraw
        | FileType::Latex
        | FileType::Typst
        // Interactive View is rendered entirely client-side (reactive kernel +
        // chart renderer); the server serves the raw JSON document verbatim.
        | FileType::InteractiveView => source.to_string(),
        // Binary types should not reach here
        FileType::Image | FileType::Pdf | FileType::Unknown => source.to_string(),
    }
}

/// Render markdown source to HTML.
///
/// `render.sourcepos` is enabled so every block element carries
/// `data-sourcepos="startline:col-endline:col"` — the STABLE anchor the
/// read-along highlight maps each spoken unit to (`Unit::line`), instead of the
/// client counting `body.children` (which desyncs when one source block renders
/// to ≠ 1 top-level element, e.g. a multi-part inline `<svg>`). Anchoring by id
/// is position-independent: a block with no wrapper (raw HTML) simply has no
/// anchor and is skipped, without shifting any other block. See
/// `docs/design/read-aloud-narration.md`.
///
/// A soft line break between two CJK characters is dropped before rendering.
/// CommonMark turns every soft break into whitespace, which browsers draw as a
/// visible space — right between Latin words, wrong inside a hard-wrapped
/// Chinese or Japanese paragraph ("同时扮演 了三个角色"). The read-along
/// highlight matches text whitespace-insensitively, so this does not move it.
pub fn render_markdown(source: &str) -> String {
    let mut options = markdown_options();
    options.render.sourcepos = true;
    let arena = Arena::new();
    let root = parse_document(&arena, source, &options);
    join_cjk_soft_breaks(root);
    let mut html = Vec::new();
    format_html(root, &options, &mut html).expect("writing HTML to a Vec cannot fail");
    String::from_utf8(html).expect("comrak emits UTF-8")
}

fn join_cjk_soft_breaks<'a>(root: &'a AstNode<'a>) {
    let breaks: Vec<_> = root
        .descendants()
        .filter(|node| matches!(node.data.borrow().value, NodeValue::SoftBreak))
        .collect();
    for node in breaks {
        let before = node.previous_sibling().and_then(|n| edge_char(n, true));
        let after = node.next_sibling().and_then(|n| edge_char(n, false));
        if before.is_some_and(is_cjk) && after.is_some_and(is_cjk) {
            node.detach();
        }
    }
}

/// The last (`last`) or first visible character of an inline run, looking
/// through emphasis and links. Code, math, and raw HTML end the search, so a
/// break next to them keeps its space.
fn edge_char<'a>(node: &'a AstNode<'a>, last: bool) -> Option<char> {
    match &node.data.borrow().value {
        NodeValue::Text(text) => {
            if last {
                text.chars().next_back()
            } else {
                text.chars().next()
            }
        }
        NodeValue::Emph | NodeValue::Strong | NodeValue::Strikethrough | NodeValue::Link(_) => {
            let child = if last {
                node.last_child()
            } else {
                node.first_child()
            };
            child.and_then(|c| edge_char(c, last))
        }
        _ => None,
    }
}

/// Scripts written without inter-word spaces, plus their full-width
/// punctuation. Hangul is excluded: Korean separates words with spaces.
fn is_cjk(c: char) -> bool {
    matches!(
        c,
        '\u{2E80}'..='\u{2FDF}'   // CJK radicals, Kangxi radicals
            | '\u{3000}'..='\u{303F}' // CJK symbols and punctuation
            | '\u{3040}'..='\u{30FF}' // Hiragana, Katakana
            | '\u{3100}'..='\u{312F}' // Bopomofo
            | '\u{3190}'..='\u{31FF}' // Kanbun, Bopomofo ext, Katakana ext
            | '\u{3400}'..='\u{4DBF}' // CJK extension A
            | '\u{4E00}'..='\u{9FFF}' // CJK unified ideographs
            | '\u{F900}'..='\u{FAFF}' // CJK compatibility ideographs
            | '\u{FE30}'..='\u{FE4F}' // CJK compatibility forms
            | '\u{FF00}'..='\u{FF60}' // full-width forms
            | '\u{FFE0}'..='\u{FFE6}'
            | '\u{20000}'..='\u{3FFFF}' // CJK extensions B and later
    )
}

#[cfg(test)]
mod tests {
    use super::render_markdown;

    fn body(md: &str) -> String {
        let html = render_markdown(md);
        let start = html.find('>').unwrap() + 1;
        html[start..html.rfind("</p>").unwrap()].to_string()
    }

    #[test]
    fn soft_break_between_cjk_characters_is_dropped() {
        assert_eq!(
            body("它的全部\n灵魂只有一条等式"),
            "它的全部灵魂只有一条等式"
        );
        assert_eq!(body("无论谁来交易，\n交易后"), "无论谁来交易，交易后");
        assert_eq!(
            body("一个\n**自动做市商**"),
            "一个<strong>自动做市商</strong>"
        );
        assert_eq!(body("ひらがな\nカタカナ"), "ひらがなカタカナ");
    }

    #[test]
    fn soft_break_next_to_latin_code_or_hangul_keeps_its_space() {
        assert_eq!(body("the pool\nholds"), "the pool\nholds");
        assert_eq!(body("一个\nERC-20"), "一个\nERC-20");
        assert_eq!(body("调用\n`approve`"), "调用\n<code>approve</code>");
        assert_eq!(body("한국어\n문장"), "한국어\n문장");
    }
}
