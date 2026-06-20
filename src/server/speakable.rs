//! The speech registry: turn one read-along [`Unit`] into the text that is
//! actually spoken, optimized for the "watch + listen" reader (lossy is fine —
//! the listener also sees the page).
//!
//! Two tiers (see `docs/design/read-aloud-narration.md`):
//!   • **Deterministic** — prose verbatim with read-hostile inline spans (URLs,
//!     addresses, phone numbers) normalized, and an image's `alt` spoken as-is.
//!     Computed here, no model, zero tokens.
//!   • **Narrated** — a diagram / table / formula / code block is resolved to
//!     PRE-GENERATED text by a content-addressed key (a skill produces it
//!     offline; see [`crate::server::narration`]). liveview NEVER calls a model.
//!
//! This is the extension point: a new resource type is one arm in [`plan`].
//! [`plan`] is pure (no IO, no store) so the offline evaluator + `narrate-plan`
//! can compute the same keys the runtime resolves — they can never drift.
//!
//! Sync + highlight are unaffected: `plan` only decides a unit's *spoken* text;
//! the unit's `idx`/`blk`/display `text` (what the in-place highlight anchors
//! on) are untouched, so audio marks and the outlined block stay aligned by
//! construction (one clip per unit — see `audio_worker` / `ensure_text_audio`).

use std::sync::LazyLock;

use regex::Regex;

use crate::server::narration::{self, NarrationStore};
use crate::server::spoken::{Unit, UnitKind};

/// An image's `alt` shorter than this is too thin to stand in for the figure
/// when listening; the evaluator flags it so the author writes a fuller one
/// (the "moderate, not too short" target). Advisory only — the runtime still
/// speaks whatever alt exists.
pub const MIN_ALT_CHARS: usize = 16;

/// The spoken-text decision for one unit. Carries a stable `rule` id (namespaced
/// `speak/…`, for the evaluator + tooling) in every arm.
pub enum Speech {
    /// Final text known WITHOUT a model: inline-normalized prose or an authored
    /// image `alt`. Spoken verbatim.
    Ready { rule: &'static str, text: String },
    /// A non-prose resource whose spoken text is PRE-GENERATED, resolved by
    /// `key` against the narration store. `kind` is the narration recipe (also
    /// in the key); `src` is a short preview for `narrate-plan` / the report.
    /// Absent from the store ⇒ a silent step-over until the skill narrates it.
    Narrated {
        rule: &'static str,
        kind: &'static str,
        key: String,
        src: String,
    },
    /// Nothing to say — a brief silent step-over (decorative / unhandled / a
    /// resource we can't describe, e.g. an image with no alt text). The
    /// evaluator surfaces these as warnings so they can be fixed at authoring.
    Silent { rule: &'static str },
}

/// Decide a unit's spoken text. Pure + cheap (no IO, no store): computes the
/// content key for narrated kinds but does not resolve it, so the offline
/// evaluator + `narrate-plan` compute the SAME keys the runtime resolves.
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
        UnitKind::Image => image_plan(unit),
        UnitKind::Math => narrated("speak/math", narration::KIND_MATH, &unit.src, lang),
        UnitKind::Table => {
            if unit.src.trim().is_empty() {
                Speech::Silent { rule: "speak/table-empty" }
            } else {
                narrated("speak/table", narration::KIND_TABLE, &unit.src, lang)
            }
        }
        UnitKind::Code => {
            // ```mermaid is a relationship/flow diagram, not code — narrate what
            // it shows, never the node ids and arrows.
            if unit.info.eq_ignore_ascii_case("mermaid") {
                narrated("speak/diagram", narration::KIND_DIAGRAM, &unit.src, lang)
            } else if unit.src.trim().is_empty() {
                Speech::Silent { rule: "speak/code-empty" }
            } else {
                narrated("speak/code", narration::KIND_CODE, &unit.src, lang)
            }
        }
        UnitKind::Html => html_plan(unit, lang),
    }
}

/// The text spoken for `unit` (runtime synth path). Deterministic plans return
/// their text; a narrated plan resolves its key against the pre-generated store,
/// falling back to a silent step-over when not yet narrated. No model, no IO.
pub fn unit_speech(unit: &Unit, lang: &str, store: &NarrationStore) -> String {
    match plan(unit, lang) {
        Speech::Ready { text, .. } => text,
        Speech::Narrated { key, .. } => store.get(&key).unwrap_or_default().to_string(),
        Speech::Silent { .. } => String::new(),
    }
}

/// The narration keys a chapter's non-prose units resolve against — so the synth
/// can pre-load the whole chapter's narration in one store query, not one per
/// unit. (May contain duplicates; the store query dedups.)
pub fn narration_keys(units: &[Unit], lang: &str) -> Vec<String> {
    units
        .iter()
        .filter_map(|u| match plan(u, lang) {
            Speech::Narrated { key, .. } => Some(key),
            _ => None,
        })
        .collect()
}

/// Build a `Narrated` plan: the content key + a short source preview.
fn narrated(rule: &'static str, kind: &'static str, src: &str, lang: &str) -> Speech {
    let trimmed = src.trim();
    Speech::Narrated {
        rule,
        kind,
        key: narration::key(lang, kind, trimmed),
        src: trimmed.chars().take(160).collect(),
    }
}

/// An image speaks its `alt` text when the author wrote one — the generation-time
/// hook for "give this figure a moderate spoken description" (reviewable,
/// versioned, no model, no narration entry). With no alt there's nothing to say:
/// we can't read a binary/SVG file, so it's a flagged silent step-over (the
/// evaluator tells the author to add alt text).
fn image_plan(unit: &Unit) -> Speech {
    let has_alt = !unit.src.trim().is_empty() && unit.src != unit.info;
    if has_alt {
        Speech::Ready { rule: "speak/image-alt", text: unit.src.clone() }
    } else {
        Speech::Silent { rule: "speak/image-no-alt" }
    }
}

/// Route embedded HTML by what it actually is:
///   • `<svg>` — a hand-drawn diagram; narrate it like a diagram.
///   • `<table>` — a raw-HTML table (not GFM); narrate it like any table.
/// Anything else (disclosure `<details>`, layout `<div>`, …) is scaffolding — a
/// flagged silent step-over rather than a risk of reading markup aloud. New tags
/// graft on as one more arm here.
fn html_plan(unit: &Unit, lang: &str) -> Speech {
    if unit.src.contains("<svg") {
        narrated("speak/diagram", narration::KIND_DIAGRAM, &unit.src, lang)
    } else if unit.src.contains("<table") {
        narrated("speak/table", narration::KIND_TABLE, &unit.src, lang)
    } else {
        Speech::Silent { rule: "speak/html" }
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
            Speech::Ready { rule, .. }
            | Speech::Narrated { rule, .. }
            | Speech::Silent { rule } => rule,
        }
    }

    #[test]
    fn mermaid_routes_to_diagram_not_code() {
        let u = unit("```mermaid\ngraph TD; A-->B;\n```\n", UnitKind::Code);
        match plan(&u, "en") {
            Speech::Narrated { rule, kind, key, src } => {
                assert_eq!(rule, "speak/diagram");
                assert_eq!(kind, narration::KIND_DIAGRAM);
                assert!(src.contains("A-->B"), "source preview lost");
                // Key is stable + matches narration::key for the same inputs.
                assert_eq!(key, narration::key("en", narration::KIND_DIAGRAM, "graph TD; A-->B;"));
            }
            other => panic!("expected Narrated diagram, got {}", rule_of(&other)),
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
            Speech::Narrated { rule, kind, src, .. } => {
                assert_eq!(rule, "speak/table");
                assert_eq!(kind, narration::KIND_TABLE);
                assert!(src.contains("columns: A | B"), "table source preview lost");
            }
            other => panic!("expected Narrated table, got {}", rule_of(&other)),
        }
    }

    #[test]
    fn unit_speech_resolves_from_store_else_silent() {
        let u = unit("```mermaid\ngraph TD; A-->B;\n```\n", UnitKind::Code);
        let k = narration::key("en", narration::KIND_DIAGRAM, "graph TD; A-->B;");
        let store = NarrationStore::from_pairs([(k, "A points to B.".to_string())]);
        assert_eq!(unit_speech(&u, "en", &store), "A points to B.");
        // Not narrated yet → silent step-over (empty), never a model call.
        assert_eq!(unit_speech(&u, "en", &NarrationStore::empty()), "");
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
