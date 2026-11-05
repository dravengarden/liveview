//! Content-addressed narration store: the durable link between a non-prose
//! resource and its pre-generated spoken text.
//!
//! liveview does NOT generate narration (that's a skill's job — see
//! `docs/design/read-aloud-narration.md`). It only *resolves* a resource to its
//! spoken text by a key derived from the resource's CONTENT, so the link
//! survives edits to surrounding prose, block reordering, and insertions — it
//! changes only when the resource itself changes (exactly when the narration
//! should be regenerated), and identical resources dedup to one entry.
//!
//! The same `key` function is used to EMIT the to-generate list
//! (`narrate-plan`) and to RESOLVE at synth, so the two can never disagree. The
//! skill never computes a key — it fills text against keys liveview handed it.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Narration kind labels (also the per-type recipe the skill applies). Distinct
/// from `UnitKind` because one `UnitKind::Code` splits into mermaid-`diagram` vs
/// real-`code`, and HTML splits into `diagram`/`table`. Part of the key, so a
/// table and a diagram with coincidentally-equal source never collide.
pub const KIND_DIAGRAM: &str = "diagram";
pub const KIND_TABLE: &str = "table";
pub const KIND_MATH: &str = "math";
pub const KIND_CODE: &str = "code";

/// Whitespace-insensitive form of a resource source, so trivial reformatting
/// (re-indent a mermaid graph, re-wrap a table) doesn't needlessly invalidate
/// the key. Identity only — the real source is still what the skill narrates.
fn normalize_src(src: &str) -> String {
    src.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The content-addressed key for one resource: `blake3(lang · kind ·
/// normalized-source)`, 32 hex chars (128-bit — no collision concern across a
/// corpus). `lang` is included because narration is language-specific; `kind`
/// because the same source can mean different things per type.
pub fn key(lang: &str, kind: &str, src: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(lang.as_bytes());
    h.update(&[0]);
    h.update(kind.as_bytes());
    h.update(&[0]);
    h.update(normalize_src(src).as_bytes());
    h.finalize().to_hex()[..32].to_string()
}

/// One stored narration. `text` is what gets spoken; the rest is for review /
/// provenance and is ignored at resolve time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub src_preview: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub at: String,
}

/// The on-disk authoring surface: `books/<slug>/.narration/<lang>.json`. A flat
/// content-addressed map — append-only, near-conflict-free across parallel books.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sidecar {
    pub schema: u32,
    #[serde(default)]
    pub prompt_version: u32,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
}

impl Sidecar {
    /// The sidecar path for a book root + language.
    pub fn path(book_root: &Path, lang: &str) -> std::path::PathBuf {
        book_root.join(".narration").join(format!("{lang}.json"))
    }

    /// Load `books/<slug>/.narration/<lang>.json`, or an empty sidecar when it's
    /// absent (a book with no narration yet). Errors only on a malformed file.
    pub fn load(book_root: &Path, lang: &str) -> Result<Sidecar, String> {
        let p = Self::path(book_root, lang);
        match std::fs::read_to_string(&p) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| format!("parse {}: {e}", p.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Sidecar {
                schema: 1,
                prompt_version: 1,
                entries: BTreeMap::new(),
            }),
            Err(e) => Err(format!("read {}: {e}", p.display())),
        }
    }
}

/// The resolve-time view: key → spoken text. Built from the pg `narration` table
/// (the server) or a sidecar (offline tools). Resolution is the only operation.
#[derive(Debug, Clone, Default)]
pub struct NarrationStore {
    map: HashMap<String, String>,
}

impl NarrationStore {
    /// Nothing narrated — every non-prose resource resolves to a silent
    /// step-over. The runtime default until the pg table is populated.
    pub fn empty() -> Self {
        Self {
            map: HashMap::new(),
        }
    }

    /// Build from `(key, text)` pairs (pg rows, or a sidecar's entries).
    pub fn from_pairs(pairs: impl IntoIterator<Item = (String, String)>) -> Self {
        Self {
            map: pairs.into_iter().collect(),
        }
    }

    /// Build the resolve view from a loaded sidecar (offline tools).
    pub fn from_sidecar(s: &Sidecar) -> Self {
        Self::from_pairs(s.entries.iter().map(|(k, e)| (k.clone(), e.text.clone())))
    }

    /// The spoken text for a resource key, if narrated.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(String::as_str)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_and_whitespace_insensitive() {
        let a = key("zh", KIND_DIAGRAM, "graph TD; A-->B;");
        let b = key("zh", KIND_DIAGRAM, "graph TD;\n   A-->B;\n");
        assert_eq!(a, b, "reformatting must not change the key");
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn key_separates_lang_kind_and_content() {
        let src = "graph TD; A-->B;";
        assert_ne!(
            key("zh", KIND_DIAGRAM, src),
            key("en", KIND_DIAGRAM, src),
            "lang"
        );
        assert_ne!(
            key("zh", KIND_DIAGRAM, src),
            key("zh", KIND_CODE, src),
            "kind"
        );
        assert_ne!(
            key("zh", KIND_DIAGRAM, "A-->B"),
            key("zh", KIND_DIAGRAM, "A-->C"),
            "content"
        );
    }

    #[test]
    fn store_resolves_and_misses() {
        let k = key("zh", KIND_TABLE, "a | b");
        let store = NarrationStore::from_pairs([(k.clone(), "两列:a 和 b。".to_string())]);
        assert_eq!(store.get(&k), Some("两列:a 和 b。"));
        assert_eq!(store.get("missing"), None);
    }

    #[test]
    fn sidecar_missing_file_is_empty_not_error() {
        let s = Sidecar::load(Path::new("/nonexistent/book"), "zh").unwrap();
        assert!(s.entries.is_empty());
    }
}
