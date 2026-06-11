//! The JSON validator.
//!
//! The reader's JSON viewer does `JSON.stringify(JSON.parse(content))` — strict
//! JSON, no JSON5/JSONC leniency — and falls back to raw text on a parse error.
//! We match that exactly with `serde_json` (already a dependency): a file that
//! won't `JSON.parse` is `json/parse-error`, Error. serde_json hands us the
//! 1-based line/column of the failure, which we surface directly.
//!
//! This is Error severity (not Warning like the soft content checks): a `.json`
//! that doesn't parse is unambiguously broken, the same way KaTeX-broken math is
//! "wrong but renders" — here there is no graceful degradation worth tolerating.

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};

pub struct JsonValidator;

impl Validator for JsonValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        match serde_json::from_str::<serde_json::Value>(&file.source) {
            Ok(_) => Vec::new(),
            Err(e) => vec![Diagnostic {
                file: file.rel.clone(),
                line: e.line() as u32,
                col: e.column() as u32,
                end_line: e.line() as u32,
                end_col: e.column() as u32,
                severity: Severity::Error,
                source: "json",
                rule: "json/parse-error".to_string(),
                message: clean_message(&e.to_string()),
                hint: Some("strict JSON only — no comments, trailing commas, or single quotes".to_string()),
                snippet: None,
            }],
        }
    }
}

/// serde_json appends " at line L column C" to its messages; we already carry
/// the location in the diagnostic span, so drop the redundant tail.
fn clean_message(raw: &str) -> String {
    match raw.find(" at line ") {
        Some(i) => raw[..i].to_string(),
        None => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::FileType;
    use std::path::PathBuf;

    fn check(source: &str) -> Vec<Diagnostic> {
        let file = CheckFile {
            path: PathBuf::from("test.json"),
            rel: "test.json".to_string(),
            source: source.to_string(),
            file_type: FileType::Json,
        };
        let ctx = CheckCtx {
            dir: PathBuf::from("."),
        };
        JsonValidator.check(&file, &ctx)
    }

    #[test]
    fn valid_json_passes() {
        let d = check("{\"a\": [1, 2, 3], \"b\": {\"c\": true}}\n");
        assert!(d.is_empty(), "valid json flagged: {d:?}");
    }

    #[test]
    fn trailing_comma_flagged() {
        let d = check("{\n  \"a\": 1,\n}\n");
        assert_eq!(d.len(), 1, "got: {d:?}");
        assert_eq!(d[0].rule, "json/parse-error");
        assert_eq!(d[0].severity, Severity::Error);
        assert!(!d[0].message.contains("at line"), "redundant tail kept");
    }

    #[test]
    fn reports_failure_location() {
        let d = check("{\n  \"a\": 1\n  \"b\": 2\n}\n");
        assert_eq!(d.len(), 1, "got: {d:?}");
        // The missing comma is on line 3.
        assert_eq!(d[0].line, 3);
    }
}
