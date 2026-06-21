//! The comrak structural Markdown validator.
//!
//! Parses with [`renderer::markdown_options`] — the *same* options the server
//! renders with — so a clean check matches what renders. Rules implemented in
//! P0:
//!
//! - `md/dangling-footnote` (Error): `[^x]` referenced, never defined.
//! - `md/unused-footnote`   (Warning): `[^x]:` defined, never referenced.
//! - `md/broken-reference-link` (Warning): `[t][id]` / `![a][id]` with no
//!   `[id]:` definition.
//! - `md/missing-asset` (Warning): a relative local link/image target that
//!   isn't on disk.
//! - `md/stray-emphasis` (Warning): a literal `**` that survived into inline
//!   text — a bold marker comrak could not pair (the bold broke across a block
//!   boundary, or was left unclosed), so the reader shows `**` instead of bold.
//! - `md/raw-math-delim` (Warning): a raw `\(…\)` / `\[…\]` math delimiter in
//!   prose. liveview renders only `$…$` / `$$…$$`; comrak treats `\(` as a
//!   backslash-escape of `(` and drops it, so the reader sees literal `(\hat f)`
//!   instead of math. Found by scanning raw source (the parsed `Text` no longer
//!   has the backslash), excluding `Code`/`CodeBlock`/`Math` spans.
//!
//! ## What comrak 0.36 actually does (verified empirically, drives the design)
//!
//! comrak is lenient and *rewrites the AST* around broken references, so the
//! naive "diff FootnoteReference vs FootnoteDefinition nodes" plan does NOT
//! work. Measured on 0.36.0:
//!
//! - An **undefined** footnote ref `[^missing]` is NOT kept as a
//!   `FootnoteReference` node — it collapses into literal `Text`. So dangling
//!   refs must be found by scanning inline text, not by walking ref nodes.
//! - An **unreferenced** footnote def `[^x]:` is dropped from the AST
//!   *entirely* (no `FootnoteDefinition` node at all). So unused defs can't be
//!   read off the tree either — we scan the raw source for the definition
//!   syntax and diff against the names actually referenced.
//! - A **broken** reference link `[t][id]` (no `[id]:`) likewise collapses to
//!   literal `Text` (comrak's `broken_link_callback` only fires if you supply
//!   one and choose to resolve; we don't want to resolve, we want to report).
//!   So broken ref-links are also a text scan.
//! - A **resolved** ref link becomes a normal `Link`/`Image` node with the
//!   target URL inlined; the `[id]` form does not survive in the AST.
//!
//! Consequence: footnote/ref-link detection is a hybrid — walk the AST for
//! *resolved* references and for asset URLs (where comrak gives us clean
//! sourcepos), and scan **non-code inline text** for the *broken* forms comrak
//! discarded. Scanning only `Text` nodes (never `Code`/`CodeBlock`) means a
//! literal `` `[^x]` `` in a code span is correctly ignored.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use comrak::nodes::{AstNode, NodeValue, Sourcepos};
use comrak::{parse_document, Arena};
use regex::Regex;

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};
use crate::server::renderer;

pub struct MarkdownValidator;

// A footnote reference / definition name: `[^label]` / `[^label]:`. comrak's
// label grammar excludes whitespace and the closing bracket; we mirror that
// loosely (anything but `]`, `^` start) — good enough to find what comrak
// itself would have parsed as a footnote token.
static FOOTNOTE_DEF_RE: LazyLock<Regex> =
    // Anchored to line start (after up to 3 spaces of indent) — the definition
    // form. Use `[ \t]`, NOT `\s`: `\s` matches `\n` and would let the optional
    // indent swallow a preceding blank line, mis-reporting the match's line.
    LazyLock::new(|| Regex::new(r"(?m)^[ \t]{0,3}\[\^([^\]\s]+)\]:").unwrap());
static FOOTNOTE_REF_RE: LazyLock<Regex> =
    // Inline reference form: `[^label]` NOT immediately followed by `:`.
    LazyLock::new(|| Regex::new(r"\[\^([^\]\s]+)\](?:[^:]|$)").unwrap());

// A reference-style link/image: `[text][id]` or `![alt][id]`. The id is the
// second bracket group; an empty id (`[text][]`) means "use the text as id".
// We only care about the *explicit* id form here.
static REF_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[[^\]]*\]\[([^\]\s][^\]]*)\]").unwrap());
// A link reference *definition*: `[id]: url`. `[ \t]` indent (not `\s`) for the
// same blank-line reason as FOOTNOTE_DEF_RE.
static REF_DEF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^[ \t]{0,3}\[([^\]^]+)\]:[ \t]").unwrap());

// A `\(…\)` / `\[…\]` LaTeX/MathJax math-delimiter PAIR on a single line. Real
// math-delimiter misuse is always *paired*; a lone `\[` is a bracket-escape that
// renders fine (e.g. `\[2ⁱ, 2ⁱ⁺¹)`), not a bug. Lazy `.*?` keeps the pair
// minimal and `.` excludes newlines, so a pair can't span unrelated blocks.
static RAW_MATH_INLINE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\\(.*?\\\)").unwrap());
static RAW_MATH_DISPLAY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\\[.*?\\\]").unwrap());

impl Validator for MarkdownValidator {
    fn check(&self, file: &CheckFile, ctx: &CheckCtx) -> Vec<Diagnostic> {
        let arena = Arena::new();
        // Parse with the renderer's exact options so "checked" == "rendered".
        let root = parse_document(&arena, &file.source, &renderer::markdown_options());

        let mut diags = Vec::new();
        self.check_footnotes(file, root, &mut diags);
        self.check_broken_ref_links(file, root, &mut diags);
        self.check_assets(file, ctx, root, &mut diags);
        self.check_stray_emphasis(file, root, &mut diags);
        self.check_raw_math_delim(file, root, &mut diags);

        // Stable, location-ordered output regardless of which sub-check found
        // a diagnostic first.
        diags.sort_by_key(|d| (d.line, d.col));
        diags
    }
}

impl MarkdownValidator {
    /// `md/dangling-footnote` + `md/unused-footnote`.
    ///
    /// Strategy (see module docs for *why* the AST alone can't do this):
    /// - **Defined** names: regex-scan the raw source for `[^x]:` (orphan defs
    ///   are gone from the AST). Each carries its source span.
    /// - **Referenced** names: the AST's `FootnoteReference` nodes give every
    ///   *resolved* ref with a clean sourcepos; plus we scan non-code inline
    ///   `Text` for `[^x]` tokens to catch refs comrak dropped as undefined.
    fn check_footnotes<'a>(
        &self,
        file: &CheckFile,
        root: &'a AstNode<'a>,
        diags: &mut Vec<Diagnostic>,
    ) {
        // name -> first definition span (1-based line/col of the `[^name]:`).
        let mut defined: HashMap<String, (u32, u32)> = HashMap::new();
        for cap in FOOTNOTE_DEF_RE.captures_iter(&file.source) {
            let name = cap[1].to_string();
            let m = cap.get(0).unwrap();
            let (line, col) = byte_to_line_col(&file.source, m.start());
            defined.entry(name).or_insert((line, col));
        }

        // Referenced names with their spans. Two sources, merged:
        //   (a) AST FootnoteReference nodes — the resolved refs.
        //   (b) `[^x]` tokens inside non-code Text nodes — the refs comrak
        //       dropped because they were undefined (these are our dangling
        //       candidates, but we list them as "referenced" too so a def that
        //       is *only* referenced by a typo'd sibling isn't mis-flagged).
        let mut referenced: HashSet<String> = HashSet::new();
        // Dangling candidates: (name, line, col, matched_text).
        let mut dangling: Vec<(String, u32, u32, String)> = Vec::new();

        for node in root.descendants() {
            let data = node.data.borrow();
            match &data.value {
                NodeValue::FootnoteReference(r) => {
                    referenced.insert(r.name.clone());
                }
                NodeValue::Text(text) => {
                    let base = sourcepos_start(&data.sourcepos);
                    for cap in FOOTNOTE_REF_RE.captures_iter(text) {
                        let name = cap[1].to_string();
                        referenced.insert(name.clone());
                        if !defined.contains_key(&name) {
                            // Column offset of the `[` within this text node.
                            let off = cap.get(0).unwrap().start();
                            let (line, col) = offset_within(base, text, off);
                            dangling.push((name, line, col, format!("[^{}]", &cap[1])));
                        }
                    }
                }
                _ => {}
            }
        }

        // md/dangling-footnote (Error): referenced in prose, never defined.
        for (name, line, col, snippet) in dangling {
            diags.push(Diagnostic {
                file: file.rel.clone(),
                line,
                col,
                end_line: line,
                end_col: col + snippet.chars().count() as u32 - 1,
                severity: Severity::Error,
                source: "markdown",
                rule: "md/dangling-footnote".to_string(),
                message: format!("footnote reference `[^{name}]` has no matching definition"),
                hint: Some(format!("add a definition: `[^{name}]: …`")),
                snippet: Some(snippet),
            });
        }

        // md/unused-footnote (Warning): defined, never referenced anywhere.
        for (name, (line, col)) in &defined {
            if !referenced.contains(name) {
                diags.push(Diagnostic {
                    file: file.rel.clone(),
                    line: *line,
                    col: *col,
                    end_line: *line,
                    end_col: col + name.chars().count() as u32 + 3, // `[^` + name + `]`
                    severity: Severity::Warning,
                    source: "markdown",
                    rule: "md/unused-footnote".to_string(),
                    message: format!("footnote definition `[^{name}]` is never referenced"),
                    hint: Some("remove the unused definition, or reference it".to_string()),
                    snippet: Some(format!("[^{name}]:")),
                });
            }
        }
    }

    /// `md/broken-reference-link` (Warning).
    ///
    /// A broken `[text][id]` collapses to literal `Text` in comrak's AST, so we
    /// scan non-code inline text for the `[..][id]` form and diff `id` against
    /// the link reference definitions (`[id]: url`) found in the raw source.
    /// Resolved ref-links never reach here — comrak already turned them into
    /// `Link`/`Image` nodes.
    fn check_broken_ref_links<'a>(
        &self,
        file: &CheckFile,
        root: &'a AstNode<'a>,
        diags: &mut Vec<Diagnostic>,
    ) {
        // Collect defined link-reference ids (case-insensitive per CommonMark).
        let defined: HashSet<String> = REF_DEF_RE
            .captures_iter(&file.source)
            .map(|c| c[1].trim().to_lowercase())
            .collect();

        for node in root.descendants() {
            let data = node.data.borrow();
            let NodeValue::Text(text) = &data.value else {
                continue;
            };
            let base = sourcepos_start(&data.sourcepos);
            for cap in REF_LINK_RE.captures_iter(text) {
                let id = cap[1].trim().to_lowercase();
                if defined.contains(&id) {
                    continue;
                }
                let m = cap.get(0).unwrap();
                let (line, col) = offset_within(base, text, m.start());
                let matched = m.as_str().to_string();
                diags.push(Diagnostic {
                    file: file.rel.clone(),
                    line,
                    col,
                    end_line: line,
                    end_col: col + matched.chars().count() as u32 - 1,
                    severity: Severity::Warning,
                    source: "markdown",
                    rule: "md/broken-reference-link".to_string(),
                    message: format!(
                        "reference-style link uses undefined reference `[{}]`",
                        &cap[1]
                    ),
                    hint: Some(format!("define it: `[{}]: <url>`", &cap[1])),
                    snippet: Some(matched),
                });
            }
        }
    }

    /// `md/missing-asset` (Warning).
    ///
    /// Walk `Link`/`Image` nodes; for a *relative local* target (not a URL
    /// scheme, not a bare `#anchor`, not a `data:` URI), resolve it against the
    /// file's parent dir and warn if it doesn't exist. A trailing `#fragment`
    /// is stripped before the existence check (`pic.png#only-dark` ⇒ check
    /// `pic.png`).
    fn check_assets<'a>(
        &self,
        file: &CheckFile,
        ctx: &CheckCtx,
        root: &'a AstNode<'a>,
        diags: &mut Vec<Diagnostic>,
    ) {
        for node in root.descendants() {
            let data = node.data.borrow();
            let (url, is_image) = match &data.value {
                NodeValue::Link(l) => (l.url.as_str(), false),
                NodeValue::Image(l) => (l.url.as_str(), true),
                _ => continue,
            };
            if !is_relative_local(url) {
                continue;
            }
            // Strip a `#fragment` (and any `?query`) before hitting the fs.
            let path_part = url.split(['#', '?']).next().unwrap_or(url);
            if path_part.is_empty() {
                continue; // pure `#anchor` — handled by is_relative_local, defensive.
            }
            let decoded = percent_decode(path_part);
            let target = ctx.dir.join(&decoded);
            if target.exists() {
                continue;
            }
            let (line, col) = sourcepos_start(&data.sourcepos);
            let (end_line, end_col) = sourcepos_end(&data.sourcepos);
            let kind = if is_image { "image" } else { "link" };
            diags.push(Diagnostic {
                file: file.rel.clone(),
                line,
                col,
                end_line,
                end_col,
                severity: Severity::Warning,
                source: "markdown",
                rule: "md/missing-asset".to_string(),
                message: format!("{kind} target `{url}` does not exist on disk"),
                hint: Some(format!("expected at `{}`", target.display())),
                snippet: Some(url.to_string()),
            });
        }
    }

    /// `md/stray-emphasis` (Warning).
    ///
    /// comrak consumes a *matched* `**bold**` into a `Strong` node — the `**`
    /// delimiters are gone from the tree. So a `**` that survives inside an
    /// inline `Text` node is a bold marker comrak could NOT pair, which the
    /// reader renders as a literal `**` instead of bold. Almost always an
    /// authoring slip, two flavours seen in practice:
    ///
    /// - **Bold split across a block boundary.** The classic CJK case: a
    ///   soft-wrapped continuation line begins with `+ ` / `- ` / `* `, which
    ///   CommonMark parses as a *list item that interrupts the paragraph* — the
    ///   `**…**` is cut in two, leaving an unpaired `**` in each half.
    /// - **Unclosed `**`**: the opener was typed, the closer forgotten.
    ///
    /// Scanning only `Text` nodes means a `**` inside a code span/block or a
    /// math span is correctly ignored — those are `Code`/`CodeBlock`/`Math`
    /// nodes, never `Text` (the same property the footnote/ref-link scans rely
    /// on). Known limitation: a *deliberately escaped* `\*\*` (the correct way
    /// to show a literal `**`) collapses to a `**` Text node and is flagged too
    /// — a rare false positive, and warn-only, so a reviewer/skill waves it
    /// through rather than being blocked.
    fn check_stray_emphasis<'a>(
        &self,
        file: &CheckFile,
        root: &'a AstNode<'a>,
        diags: &mut Vec<Diagnostic>,
    ) {
        for node in root.descendants() {
            let data = node.data.borrow();
            let NodeValue::Text(text) = &data.value else {
                continue;
            };
            let base = sourcepos_start(&data.sourcepos);
            // `match_indices` is non-overlapping, so `****` reports at 0 and 2 —
            // fine, both are stray markers either way.
            for (off, _) in text.match_indices("**") {
                let (line, col) = offset_within(base, text, off);
                diags.push(Diagnostic {
                    file: file.rel.clone(),
                    line,
                    col,
                    end_line: line,
                    end_col: col + 1, // spans the two `*` chars.
                    severity: Severity::Warning,
                    source: "markdown",
                    rule: "md/stray-emphasis".to_string(),
                    message: "literal `**` survived rendering — bold emphasis did not pair"
                        .to_string(),
                    hint: Some(
                        "a soft-wrapped line starting with `+`/`-`/`*` is parsed as a list and \
                         splits `**…**`; reflow so the marker isn't at line start, close the \
                         bold, or escape it as `\\*\\*`"
                            .to_string(),
                    ),
                    snippet: Some("**".to_string()),
                });
            }
        }
    }

    /// `md/raw-math-delim` (Warning).
    ///
    /// liveview's renderer enables only comrak's `$…$` / `$$…$$` / ` ```math `
    /// math (`math_dollars` + `math_code`). The MathJax/LaTeX delimiters `\(…\)`
    /// and `\[…\]` have NO comrak option, so they are never parsed as math.
    /// Worse: `(`, `)`, `[`, `]` are ASCII punctuation, so comrak treats `\(` as
    /// a *backslash escape* and silently drops the backslash — the reader sees a
    /// literal `(` (e.g. `\(\hat f\)` ships as `(\hat f)`). `math/parse-error`
    /// can't catch this: the text never becomes a `Math` node.
    ///
    /// Detection therefore can't read the parsed `Text` (the backslash is
    /// already gone there) — we scan the RAW source for `\(…\)` / `\[…\]`
    /// *pairs* and skip any whose opener is inside a `Code`/`CodeBlock`/`Math`
    /// node (those keep the backslash verbatim and aren't prose). Verified
    /// empirically on comrak 0.36: a prose `\(` parses to `Text("(")`, but
    /// `` `\(x\)` `` parses to `Code("\\(x\\)")` and `$…$` to `Math(...)`.
    ///
    /// Two precision guards, learned from a corpus sweep that surfaced both
    /// classes of false positive:
    /// - **Require a pair.** A lone `\[` is a *bracket-escape* (`\[2ⁱ, 2ⁱ⁺¹)`
    ///   renders fine as `[2ⁱ…`), not a math delimiter — only `\[…\]` / `\(…\)`
    ///   pairs are flagged.
    /// - **Skip an escaped opener.** `\\[2ex]` (LaTeX line-spacing inside math)
    ///   is a literal backslash then `[`, not a delimiter; an opener preceded by
    ///   `\` is ignored.
    ///
    /// Both diagnostics of a pair are reported (opener + closer), so `/fix-book`
    /// sees each token to convert. Warn-only.
    fn check_raw_math_delim<'a>(
        &self,
        file: &CheckFile,
        root: &'a AstNode<'a>,
        diags: &mut Vec<Diagnostic>,
    ) {
        // Spans where a literal backslash-bracket is legitimate: code keeps it
        // verbatim, math owns it. Anything outside these is prose, where comrak
        // ate the backslash and shipped a broken literal to the reader.
        let mut protected: Vec<Sourcepos> = Vec::new();
        for node in root.descendants() {
            let data = node.data.borrow();
            if matches!(
                &data.value,
                NodeValue::Code(_) | NodeValue::CodeBlock(_) | NodeValue::Math(_)
            ) {
                protected.push(data.sourcepos);
            }
        }
        // comrak sourcepos columns count raw-source positions the same way
        // `byte_to_line_col` does (1-based, escapes included), so the `(line,
        // col)` of a delimiter is directly comparable to a node's span.
        let inside_protected = |line: u32, col: u32| -> bool {
            protected.iter().any(|sp| {
                let start = (sp.start.line as u32, sp.start.column as u32);
                let end = (sp.end.line as u32, sp.end.column as u32);
                (line, col) >= start && (line, col) <= end
            })
        };

        let bytes = file.source.as_bytes();
        for (re, open, close) in [
            (&*RAW_MATH_INLINE_RE, "\\(", "\\)"),
            (&*RAW_MATH_DISPLAY_RE, "\\[", "\\]"),
        ] {
            for m in re.find_iter(&file.source) {
                let open_off = m.start();
                // `\\(` / `\\[`: the opening `\` is itself escaped → a literal
                // backslash + bracket (e.g. LaTeX `\\[2ex]`), not a delimiter.
                if open_off > 0 && bytes[open_off - 1] == b'\\' {
                    continue;
                }
                let (oline, ocol) = byte_to_line_col(&file.source, open_off);
                if inside_protected(oline, ocol) {
                    continue;
                }
                let close_off = m.end() - 2; // the 2-byte `\)` / `\]`.
                let (cline, ccol) = byte_to_line_col(&file.source, close_off);
                for (line, col, snippet) in [(oline, ocol, open), (cline, ccol, close)] {
                    diags.push(Diagnostic {
                        file: file.rel.clone(),
                        line,
                        col,
                        end_line: line,
                        end_col: col + 1, // spans the `\` and the bracket.
                        severity: Severity::Warning,
                        source: "markdown",
                        rule: "md/raw-math-delim".to_string(),
                        message:
                            "raw LaTeX math delimiter does not render — `\\(…\\)` / `\\[…\\]` is not math here"
                                .to_string(),
                        hint: Some(
                            "liveview renders `$…$` (inline) and `$$…$$` (display) only; convert the \
                             delimiters — `\\(…\\)` / `\\[…\\]` ship as literal text"
                                .to_string(),
                        ),
                        snippet: Some(snippet.to_string()),
                    });
                }
            }
        }
    }
}

/// Is `url` a relative local path we should resolve on disk? Excludes URL
/// schemes (http/https/mailto/tel/…), protocol-relative (`//host`), bare
/// `#anchor`, and `data:` URIs.
fn is_relative_local(url: &str) -> bool {
    let u = url.trim();
    if u.is_empty() || u.starts_with('#') {
        return false;
    }
    if u.starts_with("//") {
        return false; // protocol-relative → remote.
    }
    // Any `scheme:` prefix (http:, https:, mailto:, tel:, data:, ftp:, …).
    // A Windows-free corpus; a leading `scheme:` is a URL, not a path.
    if let Some(colon) = u.find(':') {
        let scheme = &u[..colon];
        if !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
            && u[..colon]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
        {
            return false;
        }
    }
    true
}

/// Minimal `%XX` percent-decoding for asset paths (book images sometimes carry
/// encoded spaces / CJK). Leaves anything malformed untouched. We avoid pulling
/// in a `percent-encoding` crate for this one use.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `(start.line, start.column)` as u32.
fn sourcepos_start(sp: &Sourcepos) -> (u32, u32) {
    (sp.start.line as u32, sp.start.column as u32)
}
fn sourcepos_end(sp: &Sourcepos) -> (u32, u32) {
    (sp.end.line as u32, sp.end.column as u32)
}

/// Map a byte offset in the *whole source* to a 1-based (line, col).
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

/// Given a text node's start position and a *character-naive byte* offset
/// within that node's text, compute the absolute (line, col). comrak text
/// nodes are single-line in practice for inline content, but we handle embedded
/// newlines defensively (soft-wrapped prose).
fn offset_within(base: (u32, u32), text: &str, byte_off: usize) -> (u32, u32) {
    let (mut line, mut col) = base;
    for (i, ch) in text.char_indices() {
        if i >= byte_off {
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

    /// Run the markdown validator over `source` with `dir` as the asset root.
    fn check_with_dir(source: &str, dir: PathBuf) -> Vec<Diagnostic> {
        let file = CheckFile {
            path: dir.join("test.md"),
            rel: "test.md".to_string(),
            source: source.to_string(),
            file_type: FileType::Markdown,
        };
        let ctx = CheckCtx { dir };
        MarkdownValidator.check(&file, &ctx)
    }

    fn check(source: &str) -> Vec<Diagnostic> {
        check_with_dir(source, PathBuf::from("/nonexistent-asset-root"))
    }

    fn rules(diags: &[Diagnostic]) -> Vec<&str> {
        diags.iter().map(|d| d.rule.as_str()).collect()
    }

    // --- md/dangling-footnote ------------------------------------------------
    // comrak drops an undefined `[^x]` to literal Text, so we scan inline text.

    #[test]
    fn dangling_footnote_flagged() {
        let d = check("Hello[^missing] world.\n");
        assert_eq!(rules(&d), ["md/dangling-footnote"]);
        // The `[` of `[^missing]` is the 6th char on line 1.
        assert_eq!((d[0].line, d[0].col), (1, 6));
        assert_eq!(d[0].severity, Severity::Error);
    }

    #[test]
    fn defined_footnote_not_flagged() {
        // A properly defined+referenced footnote yields nothing.
        let d = check("Hello[^a].\n\n[^a]: the note.\n");
        assert!(d.is_empty(), "unexpected: {:?}", rules(&d));
    }

    #[test]
    fn footnote_in_code_span_ignored() {
        // `[^x]` inside a code span is literal, not a reference — no dangling.
        let d = check("Use `[^x]` literally here.\n");
        assert!(d.is_empty(), "code-span footnote leaked: {:?}", rules(&d));
    }

    // --- md/unused-footnote --------------------------------------------------
    // comrak drops an unreferenced def from the AST entirely → raw-source scan.

    #[test]
    fn unused_footnote_flagged() {
        let d = check("No refs in this prose.\n\n[^orphan]: never used\n");
        assert_eq!(rules(&d), ["md/unused-footnote"]);
        assert_eq!(d[0].severity, Severity::Warning);
        assert_eq!(d[0].line, 3);
    }

    // --- md/broken-reference-link --------------------------------------------

    #[test]
    fn broken_reference_link_flagged() {
        let d = check("See [text][missingid] here.\n");
        assert_eq!(rules(&d), ["md/broken-reference-link"]);
        assert_eq!(d[0].severity, Severity::Warning);
        assert_eq!((d[0].line, d[0].col), (1, 5));
    }

    #[test]
    fn defined_reference_link_not_flagged() {
        let d = check("See [text][good] here.\n\n[good]: https://example.com\n");
        assert!(d.is_empty(), "unexpected: {:?}", rules(&d));
    }

    // --- md/missing-asset ----------------------------------------------------

    #[test]
    fn missing_asset_flagged() {
        let d = check("![pic](images/nope.png)\n");
        assert_eq!(rules(&d), ["md/missing-asset"]);
        assert_eq!(d[0].severity, Severity::Warning);
    }

    #[test]
    fn existing_asset_not_flagged() {
        let dir = std::env::temp_dir().join(format!("lvcheck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("here.png"), b"x").unwrap();
        let d = check_with_dir("![pic](here.png)\n", dir.clone());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(d.is_empty(), "existing asset flagged: {:?}", rules(&d));
    }

    #[test]
    fn remote_and_anchor_links_skipped() {
        // http(s), mailto, and bare #anchor targets are never asset-checked.
        let d = check("[a](https://x.com) [b](mailto:x@y.z) [c](#section) [d](tel:+1)\n");
        assert!(d.is_empty(), "remote/anchor flagged: {:?}", rules(&d));
    }

    #[test]
    fn asset_fragment_stripped_before_check() {
        // `pic.png#only-dark` must check `pic.png`, not the literal w/ fragment.
        let dir = std::env::temp_dir().join(format!("lvcheck-frag-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pic.png"), b"x").unwrap();
        let d = check_with_dir("![p](pic.png#only-dark)\n", dir.clone());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(d.is_empty(), "fragment not stripped: {:?}", rules(&d));
    }

    // --- md/stray-emphasis ---------------------------------------------------
    // comrak consumes a matched `**bold**` into a Strong node, so any `**` left
    // in a Text node is an unpaired marker the reader shows literally.

    #[test]
    fn matched_bold_not_flagged() {
        // Correctly paired bold leaves no `**` in the tree.
        let d = check("This is **bold** text.\n");
        assert!(d.is_empty(), "matched bold flagged: {:?}", rules(&d));
    }

    #[test]
    fn unclosed_emphasis_flagged() {
        let d = check("This is **not closed.\n");
        assert_eq!(rules(&d), ["md/stray-emphasis"]);
        assert_eq!(d[0].severity, Severity::Warning);
        // The `**` is the 9th char on line 1.
        assert_eq!((d[0].line, d[0].col), (1, 9));
    }

    #[test]
    fn bold_split_by_list_interrupt_flagged() {
        // The real-world bug: a soft-wrapped continuation line starting with
        // `+ ` is parsed as a list item that interrupts the paragraph, cutting
        // the bold in two — an unpaired `**` is left in each half.
        let d = check("combo:**evict\n+ consolidate**.\n");
        let r = rules(&d);
        assert_eq!(r, ["md/stray-emphasis", "md/stray-emphasis"], "got {r:?}");
        assert!(d.iter().all(|x| x.severity == Severity::Warning));
    }

    #[test]
    fn emphasis_in_code_span_ignored() {
        // `**` inside a code span is literal markup, not an emphasis marker.
        let d = check("Write `**` to show two asterisks.\n");
        assert!(d.is_empty(), "code-span `**` leaked: {:?}", rules(&d));
    }

    #[test]
    fn emphasis_in_code_block_ignored() {
        let d = check("```python\nx = 2 ** 8\n```\n");
        assert!(d.is_empty(), "code-block `**` leaked: {:?}", rules(&d));
    }

    // --- md/raw-math-delim ---------------------------------------------------
    // `\(`,`\)`,`\[`,`\]` are NOT liveview math; comrak eats the backslash so
    // the reader sees literal `(\hat f)`. Detection scans raw source (the
    // parsed Text has already lost the backslash), skipping code/math spans.

    #[test]
    fn raw_math_delim_flagged() {
        // Inline `\(…\)` (two tokens) + display `\[…\]` (two tokens) in prose.
        let d = check("Pick \\(\\hat f\\).\n\nThen \\[ E = mc^2 \\] holds.\n");
        let r = rules(&d);
        assert_eq!(
            r,
            [
                "md/raw-math-delim",
                "md/raw-math-delim",
                "md/raw-math-delim",
                "md/raw-math-delim"
            ],
            "got {r:?}"
        );
        assert!(d.iter().all(|x| x.severity == Severity::Warning));
        // First hit is the `\(` — the 6th char on line 1 (`Pick ` = 5 chars).
        assert_eq!((d[0].line, d[0].col), (1, 6));
        assert_eq!(d[0].snippet.as_deref(), Some("\\("));
    }

    #[test]
    fn valid_math_and_code_not_flagged() {
        // Real `$…$` / `$$…$$` / ```math``` math, plus `\(`/`\[` inside inline
        // code and a fenced code block — none of these is a prose delimiter.
        let src = "Inline $\\hat f$ and display $$E = mc^2$$ work.\n\n\
                   ```math\n\\hat f\n```\n\n\
                   Code `\\(not math\\)` stays.\n\n\
                   ```rust\nlet x = arr\\[0\\];\n```\n";
        let d = check(src);
        let raw: Vec<_> = d.iter().filter(|x| x.rule == "md/raw-math-delim").collect();
        assert!(raw.is_empty(), "false positives: {raw:?}");
    }

    #[test]
    fn bracket_escape_and_double_backslash_not_flagged() {
        // Two real corpus false positives this rule must NOT flag:
        // - a lone `\[` escaping a literal `[` in prose (no closing `\]`);
        // - `\\[2ex]` (LaTeX line-spacing) where the `[` is in a `\\` pair.
        let src = "distance falls in \\[2ⁱ, 2ⁱ⁺¹)). Near buckets...\n\n\
                   $$g, & \\|g\\|\\le c\\\\[1ex]$$\n";
        let raw: Vec<_> = check(src)
            .into_iter()
            .filter(|x| x.rule == "md/raw-math-delim")
            .collect();
        assert!(raw.is_empty(), "false positives: {raw:?}");
    }
}
