//! Baseline-aware production gate for a book or shelf.
//!
//! Legacy corpus debt is recorded per book and rule. The gate always rejects
//! renderer errors and rejects warning counts that exceed the checked-in
//! baseline, so old warnings can be ratcheted down without allowing regressions.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::cli::{GateArgs, OutputFormat};

const BASELINE_VERSION: u32 = 1;

#[derive(Debug, Default, Deserialize, Serialize)]
struct Baseline {
    version: u32,
    #[serde(default)]
    profiles: BTreeMap<String, Profile>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct Profile {
    /// book slug -> diagnostic rule -> maximum accepted warning count.
    #[serde(default)]
    warnings: BTreeMap<String, BTreeMap<String, u64>>,
}

#[derive(Debug, Default)]
struct Snapshot {
    books: usize,
    files: usize,
    resources: usize,
    warnings: BTreeMap<String, BTreeMap<String, u64>>,
    errors: Vec<Diagnostic>,
}

#[derive(Debug, Serialize)]
struct GateResult {
    profile: String,
    books: usize,
    files: usize,
    resources: usize,
    warnings: u64,
    errors: usize,
    regressions: Vec<Regression>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct Regression {
    book: String,
    rule: String,
    current: u64,
    allowed: u64,
}

pub fn run(args: &GateArgs) -> i32 {
    let snapshot = match collect_snapshot(&args.paths) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("gate: {error}");
            return 2;
        }
    };

    if args.write_baseline {
        if !snapshot.errors.is_empty() {
            eprintln!(
                "gate: refusing to baseline {} renderer error(s)",
                snapshot.errors.len()
            );
            return 1;
        }
        if let Err(error) = write_baseline(&args.baseline, &args.profile, &snapshot.warnings) {
            eprintln!("gate: {error}");
            return 2;
        }
        eprintln!(
            "gate: wrote {} ({} book(s), {} warning(s))",
            args.baseline.display(),
            snapshot.books,
            warning_total(&snapshot.warnings),
        );
        return 0;
    }

    let baseline = match load_baseline(&args.baseline) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("gate: {error}");
            return 2;
        }
    };
    let Some(profile) = baseline.profiles.get(&args.profile) else {
        eprintln!("gate: profile {:?} is absent from baseline", args.profile);
        return 2;
    };
    let regressions = compare(&snapshot.warnings, &profile.warnings);
    let result = GateResult {
        profile: args.profile.clone(),
        books: snapshot.books,
        files: snapshot.files,
        resources: snapshot.resources,
        warnings: warning_total(&snapshot.warnings),
        errors: snapshot.errors.len(),
        regressions,
    };

    match args.format {
        OutputFormat::Json => println!(
            "{}",
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".into())
        ),
        OutputFormat::Human => render_human(&result, &snapshot.errors),
    }

    if result.errors > 0 || !result.regressions.is_empty() {
        1
    } else {
        0
    }
}

fn collect_snapshot(paths: &[PathBuf]) -> Result<Snapshot, String> {
    let roots = discover_books(paths)?;
    if roots.is_empty() {
        return Err("no book.toml found under the requested paths".into());
    }
    let mut out = Snapshot {
        books: roots.len(),
        ..Snapshot::default()
    };
    for root in roots {
        let slug = manifest_slug(&root)?;
        let (files, checks) = super::collect(std::slice::from_ref(&root))?;
        let (narrated_files, narration) = super::readaloud::collect(std::slice::from_ref(&root))?;
        out.files += files.len().max(narrated_files.len());
        out.resources += narration.len();
        for diagnostic in checks.into_iter().chain(narration) {
            match diagnostic.severity {
                Severity::Error => out.errors.push(diagnostic),
                Severity::Warning => {
                    *out.warnings
                        .entry(slug.clone())
                        .or_default()
                        .entry(diagnostic.rule)
                        .or_default() += 1;
                }
                Severity::Info => {}
            }
        }
    }
    out.errors
        .sort_by_key(|d| (d.file.clone(), d.line, d.col, d.rule.clone()));
    Ok(out)
}

fn discover_books(paths: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let mut roots = BTreeSet::new();
    for path in paths {
        if !path.exists() {
            return Err(format!("path not found: {}", path.display()));
        }
        if path.is_file() {
            if let Some(root) = path.ancestors().find(|p| p.join("book.toml").is_file()) {
                roots.insert(root.to_path_buf());
            }
            continue;
        }
        if path.join("book.toml").is_file() {
            roots.insert(path.clone());
            continue;
        }
        for entry in WalkDir::new(path)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(super::should_walk)
        {
            let entry = entry.map_err(|e| format!("walk {}: {e}", path.display()))?;
            if entry.file_type().is_file()
                && entry.file_name() == "book.toml"
                && let Some(parent) = entry.path().parent()
            {
                roots.insert(parent.to_path_buf());
            }
        }
    }
    Ok(roots.into_iter().collect())
}

fn manifest_slug(root: &Path) -> Result<String, String> {
    let path = root.join("book.toml");
    let source =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let value: toml::Value =
        toml::from_str(&source).map_err(|e| format!("parse {}: {e}", path.display()))?;
    value
        .get("slug")
        .and_then(toml::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{} has no string slug", path.display()))
}

fn load_baseline(path: &Path) -> Result<Baseline, String> {
    let source = std::fs::read_to_string(path)
        .map_err(|e| format!("read baseline {}: {e}", path.display()))?;
    let baseline: Baseline = serde_json::from_str(&source)
        .map_err(|e| format!("parse baseline {}: {e}", path.display()))?;
    if baseline.version != BASELINE_VERSION {
        return Err(format!(
            "unsupported baseline version {} (expected {BASELINE_VERSION})",
            baseline.version
        ));
    }
    Ok(baseline)
}

fn write_baseline(
    path: &Path,
    profile_name: &str,
    warnings: &BTreeMap<String, BTreeMap<String, u64>>,
) -> Result<(), String> {
    let mut baseline = if path.is_file() {
        load_baseline(path)?
    } else {
        Baseline {
            version: BASELINE_VERSION,
            ..Baseline::default()
        }
    };
    baseline.profiles.insert(
        profile_name.to_string(),
        Profile {
            warnings: warnings.clone(),
        },
    );
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create baseline dir {}: {e}", parent.display()))?;
    let json =
        serde_json::to_string_pretty(&baseline).map_err(|e| format!("encode baseline: {e}"))?;
    std::fs::write(path, format!("{json}\n"))
        .map_err(|e| format!("write baseline {}: {e}", path.display()))
}

fn compare(
    current: &BTreeMap<String, BTreeMap<String, u64>>,
    allowed: &BTreeMap<String, BTreeMap<String, u64>>,
) -> Vec<Regression> {
    let mut out = Vec::new();
    for (book, rules) in current {
        for (rule, count) in rules {
            let budget = allowed
                .get(book)
                .and_then(|rules| rules.get(rule))
                .copied()
                .unwrap_or(0);
            if *count > budget {
                out.push(Regression {
                    book: book.clone(),
                    rule: rule.clone(),
                    current: *count,
                    allowed: budget,
                });
            }
        }
    }
    out
}

fn warning_total(warnings: &BTreeMap<String, BTreeMap<String, u64>>) -> u64 {
    warnings.values().flat_map(BTreeMap::values).sum()
}

fn render_human(result: &GateResult, errors: &[Diagnostic]) {
    for error in errors {
        println!(
            "{}:{}:{}: error[{}]: {}",
            error.file, error.line, error.col, error.rule, error.message
        );
    }
    for regression in &result.regressions {
        println!(
            "{}: warning budget exceeded for {}: {} > {}",
            regression.book, regression.rule, regression.current, regression.allowed
        );
    }
    eprintln!(
        "gate[{}]: {} book(s), {} file(s), {} resource finding(s), {} warning(s), \
         {} error(s), {} regression(s)",
        result.profile,
        result.books,
        result.files,
        result.resources,
        result.warnings,
        result.errors,
        result.regressions.len(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(book: &str, rule: &str, count: u64) -> BTreeMap<String, BTreeMap<String, u64>> {
        BTreeMap::from([(book.into(), BTreeMap::from([(rule.into(), count)]))])
    }

    #[test]
    fn unchanged_or_reduced_warning_budget_passes() {
        assert!(compare(&counts("book", "md/rule", 2), &counts("book", "md/rule", 3)).is_empty());
    }

    #[test]
    fn increase_and_new_rule_are_regressions() {
        let increased = compare(&counts("book", "md/rule", 4), &counts("book", "md/rule", 3));
        assert_eq!(increased[0].allowed, 3);
        let new_rule = compare(&counts("book", "md/new", 1), &BTreeMap::new());
        assert_eq!(new_rule[0].allowed, 0);
    }
}
