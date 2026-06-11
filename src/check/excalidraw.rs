//! The Excalidraw validator.
//!
//! An `.excalidraw` file is JSON with a known shape: the reader's viewer feeds
//! it to Excalidraw, which needs `type: "excalidraw"` and an `elements` array.
//! We check both cheaply with `serde_json` (already a dependency): first that it
//! parses (`excalidraw/parse-error`, Error), then that the two load-bearing
//! fields are present and the right type (`excalidraw/invalid-schema`, Warning —
//! Excalidraw tolerates missing optionals, so this is a soft signal).
//!
//! The corpus has no `.excalidraw` files yet; this is tested infrastructure that
//! activates the moment one is added.

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};

pub struct ExcalidrawValidator;

impl Validator for ExcalidrawValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        let value: serde_json::Value = match serde_json::from_str(&file.source) {
            Ok(v) => v,
            Err(e) => {
                return vec![diag(
                    file,
                    e.line() as u32,
                    e.column() as u32,
                    Severity::Error,
                    "excalidraw/parse-error",
                    clean_message(&e.to_string()),
                    Some("an .excalidraw file must be valid JSON".to_string()),
                )];
            }
        };

        let mut diags = Vec::new();
        // `type` must be the literal "excalidraw".
        if value.get("type").and_then(|t| t.as_str()) != Some("excalidraw") {
            diags.push(diag(
                file,
                1,
                1,
                Severity::Warning,
                "excalidraw/invalid-schema",
                "missing or wrong top-level `\"type\": \"excalidraw\"`".to_string(),
                Some("add `\"type\": \"excalidraw\"` at the top level".to_string()),
            ));
        }
        // `elements` must be an array (the drawing's contents).
        if !value.get("elements").map(|e| e.is_array()).unwrap_or(false) {
            diags.push(diag(
                file,
                1,
                1,
                Severity::Warning,
                "excalidraw/invalid-schema",
                "missing or non-array `elements`".to_string(),
                Some("Excalidraw stores shapes in an `\"elements\": [...]` array".to_string()),
            ));
        }
        diags
    }
}

fn diag(
    file: &CheckFile,
    line: u32,
    col: u32,
    severity: Severity,
    rule: &str,
    message: String,
    hint: Option<String>,
) -> Diagnostic {
    Diagnostic {
        file: file.rel.clone(),
        line,
        col,
        end_line: line,
        end_col: col,
        severity,
        source: "excalidraw",
        rule: rule.to_string(),
        message,
        hint,
        snippet: None,
    }
}

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
            path: PathBuf::from("test.excalidraw"),
            rel: "test.excalidraw".to_string(),
            source: source.to_string(),
            file_type: FileType::Excalidraw,
        };
        let ctx = CheckCtx {
            dir: PathBuf::from("."),
        };
        ExcalidrawValidator.check(&file, &ctx)
    }

    #[test]
    fn valid_excalidraw_passes() {
        let d = check(
            "{\"type\": \"excalidraw\", \"version\": 2, \"elements\": [], \"appState\": {}}\n",
        );
        assert!(d.is_empty(), "valid excalidraw flagged: {d:?}");
    }

    #[test]
    fn broken_json_is_parse_error() {
        let d = check("{not json\n");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].rule, "excalidraw/parse-error");
        assert_eq!(d[0].severity, Severity::Error);
    }

    #[test]
    fn wrong_type_and_missing_elements_flagged() {
        let d = check("{\"type\": \"drawing\"}\n");
        let rules: Vec<&str> = d.iter().map(|x| x.rule.as_str()).collect();
        assert_eq!(rules, ["excalidraw/invalid-schema", "excalidraw/invalid-schema"]);
        assert!(d.iter().all(|x| x.severity == Severity::Warning));
    }
}
