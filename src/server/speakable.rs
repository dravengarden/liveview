//! The speech registry: turn one read-along [`Unit`] into the text that is
//! actually spoken, optimized for the "watch + listen" reader (lossy is fine —
//! the listener also sees the page).
//!
//! This is the extension point. Every non-prose resource that "can't just be
//! read aloud" — a mermaid/SVG diagram, a table, a formula, a code block, a
//! figure — is routed here to a *handler* that knows how to phrase it for the
//! ear: a deterministic rewrite, an authored description, or a per-kind LLM
//! prompt. Adding a new resource type is one arm in [`plan`] + (if it needs the
//! model) one [`Recipe`]. The list of handled types is meant to grow.
//!
//! Two callers share ONE decision function, [`plan`], so they can never drift:
//!   • runtime synth ([`unit_speech`]) — the text fed to edge-tts, and
//!   • the offline evaluator (`liveview narrate-audit`) — a dry-run report of
//!     what each resource will become / which are still silent.
//!
//! Sync + highlight are unaffected: `plan` only decides a unit's *spoken* text;
//! the unit's `idx`/`blk`/display `text` (what the in-place highlight anchors
//! on) are untouched, so audio marks and the outlined block stay aligned by
//! construction (one clip per unit — see `audio_worker` / `ensure_text_audio`).

use std::sync::LazyLock;

use regex::Regex;

use crate::server::narrate;
use crate::server::spoken::{Unit, UnitKind};

/// Don't ship an enormous block to the model — the gist is in the head.
const MAX_SRC_CHARS: usize = 4000;
/// An image's `alt` shorter than this is too thin to stand in for the figure
/// when listening; the evaluator flags it so the author writes a fuller one
/// (the "moderate, not too short" target). Advisory only — the runtime still
/// speaks whatever alt exists.
pub const MIN_ALT_CHARS: usize = 16;

/// The spoken-text decision for one unit. Carries a stable `rule` id (namespaced
/// `speak/…`, for the evaluator + tooling) in every arm.
pub enum Speech {
    /// Final text known WITHOUT the model: inline-normalized prose, an authored
    /// image description, or a deterministic rewrite. Spoken verbatim.
    Ready { rule: &'static str, text: String },
    /// Needs the LLM: a finished prompt to run. On any failure the caller falls
    /// back to a silent step-over (`source` is a short preview for the report).
    Llm {
        rule: &'static str,
        prompt: String,
        source: String,
    },
    /// Nothing to say — a brief silent step-over (decorative / unhandled / a
    /// resource we can't describe, e.g. an image with no alt text). The
    /// evaluator surfaces these as warnings so they can be fixed at authoring.
    Silent { rule: &'static str },
}

/// Decide a unit's spoken text. Pure + cheap (no IO): builds the prompt but does
/// not run it, so the offline evaluator can call it on a whole corpus. The
/// single source of truth for "what becomes of each resource".
pub fn plan(unit: &Unit, lang: &str) -> Speech {
    match unit.kind {
        // Prose is spoken verbatim, with read-hostile spans (URLs, emails,
        // addresses, phone numbers) normalized to a listenable stand-in. The
        // DISPLAY text (`unit.text`) is untouched, so the highlight still matches.
        UnitKind::Prose => {
            let text = normalize_inline(&unit.text, lang);
            let text = if text.trim().is_empty() { unit.text.clone() } else { text };
            Speech::Ready { rule: "speak/prose", text }
        }
        UnitKind::Image => image_plan(unit, lang),
        UnitKind::Math => llm(Recipe::MATH, &unit.src, lang),
        UnitKind::Table => {
            if unit.src.trim().is_empty() {
                Speech::Silent { rule: "speak/table-empty" }
            } else {
                llm(Recipe::TABLE, &unit.src, lang)
            }
        }
        UnitKind::Code => {
            // ```mermaid is a relationship/flow diagram, not code — describe what
            // it shows, never read node ids and arrows.
            if unit.info.eq_ignore_ascii_case("mermaid") {
                llm(Recipe::DIAGRAM, &unit.src, lang)
            } else if unit.src.trim().is_empty() {
                Speech::Silent { rule: "speak/code-empty" }
            } else {
                llm(Recipe::CODE, &unit.src, lang)
            }
        }
        UnitKind::Html => html_plan(unit, lang),
    }
}

/// The text spoken for `unit` (runtime synth path). Runs the LLM for `Llm`
/// plans; any narration failure degrades to a silent step-over (empty string),
/// exactly as before — narration is additive, never blocking.
pub async fn unit_speech(unit: &Unit, lang: &str) -> String {
    match plan(unit, lang) {
        Speech::Ready { text, .. } => text,
        Speech::Llm { prompt, .. } => narrate::run(&prompt).await.unwrap_or_default(),
        Speech::Silent { .. } => String::new(),
    }
}

/// An image speaks its `alt` text when the author wrote one — that's the
/// generation-time hook for "give this figure a moderate spoken description"
/// (reviewable, versioned, no model call). With no alt there's nothing to say:
/// we can't read a binary/SVG file, so it's a flagged silent step-over (the
/// evaluator tells the author to add alt text).
fn image_plan(unit: &Unit, _lang: &str) -> Speech {
    let has_alt = !unit.src.trim().is_empty() && unit.src != unit.info;
    if has_alt {
        Speech::Ready { rule: "speak/image-alt", text: unit.src.clone() }
    } else {
        Speech::Silent { rule: "speak/image-no-alt" }
    }
}

/// Route embedded HTML by what it actually is:
///   • `<svg>` — a hand-drawn diagram; hand the source to the diagram narrator.
///   • `<table>` — a raw-HTML table (not GFM); narrate it like any table.
/// Anything else (disclosure `<details>`, layout `<div>`, …) is scaffolding — a
/// flagged silent step-over rather than a risk of reading markup aloud. New tags
/// graft on as one more arm here.
fn html_plan(unit: &Unit, lang: &str) -> Speech {
    if unit.src.contains("<svg") {
        llm(Recipe::DIAGRAM, &unit.src, lang)
    } else if unit.src.contains("<table") {
        llm(Recipe::TABLE, &unit.src, lang)
    } else {
        Speech::Silent { rule: "speak/html" }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind LLM recipes — WHAT to say for each resource. Each pairs a stable rule
// id, the noun the prompt uses, and type-specific phrasing guidance (incl. a
// length target: moderate, never one-word). Add a kind = add a Recipe const.
// ─────────────────────────────────────────────────────────────────────────────

struct Recipe {
    rule: &'static str,
    word: &'static str,
    guidance: &'static str,
}

impl Recipe {
    const DIAGRAM: Recipe = Recipe {
        rule: "speak/diagram",
        word: "relationship diagram",
        guidance: "Describe the key relationship(s) or flow this diagram shows in 1 to 3 \
                   natural spoken sentences — the structure and direction, e.g. \"a private \
                   key derives a public key, which hashes to the address\". Never read node \
                   ids, arrows, or syntax literally.",
    };
    const TABLE: Recipe = Recipe {
        rule: "speak/table",
        word: "table",
        guidance: "If the table carries real information, turn it into a natural spoken \
                   enumeration (e.g. \"there are two account types: an EOA, controlled by a \
                   private key with no code; and a contract account, controlled by its \
                   bytecode\"). If it is just a reference grid, state its one-sentence \
                   takeaway. 2 to 4 sentences. Never read it cell by cell and never say the \
                   words \"column\" or \"row\".",
    };
    const MATH: Recipe = Recipe {
        rule: "speak/math",
        word: "formula",
        guidance: "Speak this formula the way a person reads it aloud (10^18 → \"ten to the \
                   eighteenth\", E=mc^2 → \"E equals m c squared\"), or state what it \
                   expresses. One short sentence. Never read LaTeX, backslashes, or dollar \
                   signs.",
    };
    const CODE: Recipe = Recipe {
        rule: "speak/code",
        word: "code block",
        guidance: "In one short spoken sentence, say what this code does or shows — its \
                   purpose or result, not a literal read-out. Never read the code aloud.",
    };
}

/// Build an `Llm` plan from a recipe + the resource source.
fn llm(recipe: Recipe, src: &str, lang: &str) -> Speech {
    let trimmed = src.trim();
    let input: String = trimmed.chars().take(MAX_SRC_CHARS).collect();
    let prompt = format!(
        "You are narrating a document aloud for a listener who is ALSO looking at the page, \
         so a lossy gist is fine and better than reading symbols. Reply in the same language \
         as the document (language code: {lang}). Output ONLY the spoken text — no preamble, \
         no quotes, no markdown.\n\n{guidance}\n\n{word} content:\n{input}",
        lang = lang,
        guidance = recipe.guidance,
        word = recipe.word,
    );
    Speech::Llm {
        rule: recipe.rule,
        prompt,
        source: trimmed.chars().take(120).collect(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline speech normalization — deterministic rewrites of read-hostile spans in
// prose. Lossy by design: the reader sees the real URL/number, the listener
// hears a short stand-in instead of edge-tts spelling out "h-t-t-p-s colon
// slash slash…". Each rule is one (pattern, stand-in) pair; add a hazard = add a
// rule. Applied to the SPOKEN copy only — `unit.text` (the highlight anchor) is
// never altered.
// ─────────────────────────────────────────────────────────────────────────────

fn is_zh(lang: &str) -> bool {
    lang.starts_with("zh")
}

/// (regex, zh stand-in, non-zh stand-in). Order matters: more specific patterns
/// (email, 0x-address, hash) run before the looser phone matcher.
type Rule = (LazyLock<Regex>, &'static str, &'static str);

static URL: Rule = (
    LazyLock::new(|| Regex::new(r"(?:https?://|www\.)\S+").unwrap()),
    "（链接）",
    " (a link) ",
);
static EMAIL: Rule = (
    LazyLock::new(|| Regex::new(r"[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+").unwrap()),
    "（邮箱）",
    " (an email address) ",
);
static ADDR0X: Rule = (
    LazyLock::new(|| Regex::new(r"0x[0-9a-fA-F]{6,}").unwrap()),
    "（某地址）",
    " (an address) ",
);
// Phone-ish: a digit, a real separator (space / paren / + / -), then more phone
// chars. The separator is required by construction so it never eats a plain long
// number (e.g. an 18-digit wei literal) or a range. "." is deliberately NOT a
// separator here, so decimals like 3.14159 are left alone.
static PHONE: Rule = (
    LazyLock::new(|| Regex::new(r"\+?\d{1,4}[ ()+-][\d ()+-]{4,}\d").unwrap()),
    "（电话号码）",
    " (a phone number) ",
);
// Bare hex hash/sha (no 0x) — 16+ hex chars. The matcher is `replace_all` with a
// guard (below) so it only fires when the run contains an a–f letter; a 16+ digit
// DECIMAL (a big token amount) is a number, not a hash, and is left to the TTS.
static HASHHEX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[0-9a-fA-F]{16,}\b").unwrap());

/// Rewrite read-hostile spans in one prose sentence to a short spoken stand-in.
/// Collapses any double spaces the substitutions introduce.
pub fn normalize_inline(text: &str, lang: &str) -> String {
    let pick = |r: &Rule| if is_zh(lang) { r.1 } else { r.2 };
    let mut s = text.to_string();
    for rule in [&URL, &EMAIL, &ADDR0X, &PHONE] {
        s = rule.0.replace_all(&s, pick(rule)).into_owned();
    }
    // Hash only when it's actually hex (has a letter) — a 16+ digit DECIMAL run
    // is a number, so the keep-branch returns the original text unchanged.
    let hash_word = if is_zh(lang) { "（某哈希值）" } else { " (a hash) " };
    s = HASHHEX_RE
        .replace_all(&s, |c: &regex::Captures| {
            if c[0].bytes().any(|b| b.is_ascii_alphabetic()) {
                hash_word.to_string()
            } else {
                c[0].to_string()
            }
        })
        .into_owned();
    // Tidy the spaces the (space-padded, en) stand-ins leave behind.
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::spoken::spoken_units;

    fn unit(md: &str, kind: UnitKind) -> Unit {
        spoken_units(md).into_iter().find(|u| u.kind == kind).unwrap()
    }

    fn rule_of(s: &Speech) -> &'static str {
        match s {
            Speech::Ready { rule, .. } | Speech::Llm { rule, .. } | Speech::Silent { rule } => rule,
        }
    }

    #[test]
    fn mermaid_routes_to_diagram_not_code() {
        let u = unit("```mermaid\ngraph TD; A-->B;\n```\n", UnitKind::Code);
        match plan(&u, "en") {
            Speech::Llm { rule, prompt, .. } => {
                assert_eq!(rule, "speak/diagram");
                assert!(prompt.contains("relationship diagram"));
                assert!(prompt.contains("A-->B"), "source not in prompt");
            }
            other => panic!("expected Llm diagram, got {}", rule_of(&other)),
        }
    }

    #[test]
    fn real_code_routes_to_code() {
        let u = unit("```rust\nfn x() {}\n```\n", UnitKind::Code);
        assert_eq!(rule_of(&plan(&u, "en")), "speak/code");
    }

    #[test]
    fn table_routes_to_table_with_source() {
        let u = unit("| A | B |\n|---|---|\n| 1 | 2 |\n", UnitKind::Table);
        match plan(&u, "zh") {
            Speech::Llm { rule, prompt, .. } => {
                assert_eq!(rule, "speak/table");
                assert!(prompt.contains("columns: A | B"));
            }
            other => panic!("expected Llm table, got {}", rule_of(&other)),
        }
    }

    #[test]
    fn html_routes_svg_to_diagram_table_to_table_else_silent() {
        let svg = unit("<svg><circle/></svg>\n", UnitKind::Html);
        assert_eq!(rule_of(&plan(&svg, "en")), "speak/diagram");
        let table = unit("<table><tr><td>a</td></tr></table>\n", UnitKind::Html);
        assert_eq!(rule_of(&plan(&table, "en")), "speak/table");
        let div = unit("<div class=\"note\">x</div>\n", UnitKind::Html);
        assert_eq!(rule_of(&plan(&div, "en")), "speak/html");
        assert!(matches!(plan(&div, "en"), Speech::Silent { .. }));
    }

    #[test]
    fn image_uses_alt_when_present_else_silent() {
        let described = unit("![a flow from key to address](x.svg)\n", UnitKind::Image);
        match plan(&described, "en") {
            Speech::Ready { rule, text } => {
                assert_eq!(rule, "speak/image-alt");
                assert_eq!(text, "a flow from key to address");
            }
            other => panic!("expected authored alt, got {}", rule_of(&other)),
        }
        // No alt → nothing we can voice from a URL alone.
        let bare = unit("![](x.svg)\n", UnitKind::Image);
        assert_eq!(rule_of(&plan(&bare, "en")), "speak/image-no-alt");
    }

    #[test]
    fn inline_normalization_replaces_hazards_zh_and_en() {
        let s = normalize_inline("see https://example.com/x?y=1 for more", "en");
        assert!(s.contains("(a link)") && !s.contains("http"), "url: {s}");
        let s = normalize_inline("发到 a.b+c@mail.co 或 0xdeadBEEF1234 看", "zh");
        assert!(s.contains("（邮箱）") && !s.contains('@'), "email: {s}");
        assert!(s.contains("（某地址）") && !s.contains("0xdead"), "addr: {s}");
        let s = normalize_inline("call +1 (800) 555-1234 now", "en");
        assert!(s.contains("(a phone number)"), "phone: {s}");
    }

    #[test]
    fn normalization_leaves_plain_prose_and_decimals_alone() {
        let s = normalize_inline("gas price is 3.5 gwei and the EVM nonce is 7.", "en");
        assert_eq!(s, "gas price is 3.5 gwei and the EVM nonce is 7.");
    }

    #[test]
    fn prose_plan_never_empty() {
        let u = unit("纯链接 https://x.io 收尾。", UnitKind::Prose);
        match plan(&u, "zh") {
            Speech::Ready { text, .. } => assert!(!text.trim().is_empty()),
            _ => panic!("prose must be Ready"),
        }
    }
}
