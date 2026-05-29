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

use regex::Regex;

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
}
