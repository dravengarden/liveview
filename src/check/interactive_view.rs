//! The Interactive View validator — the soundness core.
//!
//! "checker == renderer" here means: the checker's *accepted language* is
//! exactly the renderer's *total domain*. It parses the document into the same
//! IR the renderer consumes (`crate::interactive_view::model`), then discharges
//! the soundness obligations from `docs/design/interactive-view.md`:
//!
//!   S1/S2  every signal declared once, with exactly one source
//!   S3     every reference (interpolation / derived / input / chart) resolves
//!   S4     widget out-type == signal type; derived result type == signal type
//!   S5     datasets & columns referenced exist
//!   S6     `derived` is total & well-typed (via `interactive_view::expr`)
//!   S7     the reactive signal graph is a DAG (no update cycle)
//!   S9     mobile/widget bounds (segmented ≤5, textInput bounded, no overflow)
//!   S10    audio narrate is skippable (Phase-1 minimal)
//!   V1     no raw pixel/CSS fields exist (structural — the IR has none)
//!   V2     `columns` collapses on narrow (fit invariant)
//!   V3     layout nesting ≤ 4
//!   V4     content bounded (label/option lengths)
//!
//! Chart *internals* (Vega-Lite field/mark/param semantics, the real
//! `vl.compile`) are Phase 2 — this pass validates the chart's *wiring*
//! (`data` resolves, `id` unique, selection targets exist) only.

use std::collections::{BTreeMap, BTreeSet};

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};
use crate::interactive_view::expr::{self, ExprEnv};
use crate::interactive_view::model::{Block, Document, SignalType, Widget};

pub struct InteractiveViewValidator;

const SRC: &str = "interactive-view";

/// Max nesting depth of layout containers (V3).
const MAX_NESTING: usize = 4;
/// Segmented control option cap (S9): more would overflow a phone row.
const MAX_SEGMENTED_OPTIONS: usize = 5;
/// Content-length bounds (V4).
const MAX_LABEL_LEN: usize = 60;
const MAX_METRIC_LABEL_LEN: usize = 40;
const MAX_OPTION_LABEL_LEN: usize = 40;
const MAX_TEXT_INPUT_LEN: u32 = 280;
/// Inline dataset byte budget; larger data must use `source` (a rustfs blob).
const MAX_INLINE_DATA_BYTES: usize = 32 * 1024;

impl Validator for InteractiveViewValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        let doc = match Document::parse(&file.source) {
            Ok(d) => d,
            Err(e) => {
                return vec![diag(
                    file,
                    e.line() as u32,
                    e.column() as u32,
                    Severity::Error,
                    "interactive-view/parse-error",
                    clean(&e.to_string()),
                    Some("must be a well-formed Interactive View document — see docs/design/interactive-view.md".into()),
                )]
            }
        };
        let mut c = Checker {
            file,
            source: &file.source,
            diags: Vec::new(),
            signals: BTreeMap::new(),
            datasets: BTreeMap::new(),
            chart_ids: BTreeSet::new(),
        };
        c.run(&doc);
        c.diags
    }
}

struct Checker<'a> {
    file: &'a CheckFile,
    source: &'a str,
    diags: Vec<Diagnostic>,
    signals: BTreeMap<String, SignalType>,
    datasets: BTreeMap<String, BTreeMap<String, crate::interactive_view::model::ColumnType>>,
    chart_ids: BTreeSet<String>,
}

impl<'a> Checker<'a> {
    fn run(&mut self, doc: &Document) {
        if doc.version != 1 {
            self.err(
                "interactive-view/unsupported-version",
                format!(
                    "unsupported interactiveView version {} (this build supports 1)",
                    doc.version
                ),
                None,
                self.locate("interactiveView"),
            );
        }

        // ── datasets first (signals & charts reference them) ──
        for (name, ds) in &doc.data {
            self.datasets.insert(name.clone(), ds.columns.clone());
            match (&ds.source, &ds.values) {
                (Some(src), None) => self.check_data_source(name, src),
                (None, Some(values)) => {
                    let bytes = serde_json::to_string(values).map(|s| s.len()).unwrap_or(0);
                    if bytes > MAX_INLINE_DATA_BYTES {
                        self.err(
                            "interactive-view/inline-data-too-large",
                            format!(
                                "dataset `{name}` inlines {bytes} bytes (> {MAX_INLINE_DATA_BYTES}); move it to a `source` rustfs blob"
                            ),
                            Some("large data must be a content-addressed `source`, not inline".into()),
                            self.locate(name),
                        );
                    }
                }
                (Some(_), Some(_)) => self.err(
                    "interactive-view/data-ambiguous-source",
                    format!("dataset `{name}` has both `source` and `values`; pick one"),
                    None,
                    self.locate(name),
                ),
                (None, None) => self.err(
                    "interactive-view/data-empty",
                    format!("dataset `{name}` has neither `source` nor `values`"),
                    None,
                    self.locate(name),
                ),
            }
        }

        // ── signal symbol table + per-signal source check ──
        for (name, sig) in &doc.signals {
            self.signals.insert(name.clone(), sig.ty);
        }

        // ── first view pass: gather chart ids (selection targets) ──
        Self::collect_chart_ids(&doc.view, &mut self.chart_ids);

        // ── signals: S2 one-source, S4/S6 typing, S9 widget bounds ──
        // (collect derived edges for the S7 DAG as we go)
        let mut edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (name, sig) in &doc.signals {
            let sources = [
                sig.widget.is_some(),
                sig.from.is_some(),
                sig.derived.is_some(),
            ];
            let n = sources.iter().filter(|b| **b).count();
            if n == 0 {
                self.err(
                    "interactive-view/signal-no-source",
                    format!("signal `{name}` needs exactly one source (widget, from, or derived)"),
                    None,
                    self.locate(name),
                );
            } else if n > 1 {
                self.err(
                    "interactive-view/signal-multi-source",
                    format!("signal `{name}` has {n} sources; a signal has exactly one"),
                    Some("use a widget OR a chart selection OR a derived expression".into()),
                    self.locate(name),
                );
            }

            if let Some(w) = &sig.widget {
                self.check_widget(name, w, Some(sig.ty));
            }
            if let Some(from) = &sig.from {
                if !self.chart_ids.contains(&from.chart) {
                    self.err(
                        "interactive-view/unknown-chart",
                        format!(
                            "signal `{name}` reads a selection from unknown chart `{}`",
                            from.chart
                        ),
                        None,
                        self.locate(name),
                    );
                }
            }
            if let Some(src) = &sig.derived {
                let env = ExprEnv {
                    signals: &self.signals,
                    datasets: &self.datasets,
                };
                match expr::check(src, &env) {
                    Ok(res) => {
                        let want = scalar_label(sig.ty);
                        if Some(res.ty_desc.as_str()) != want {
                            self.err(
                                "interactive-view/derived-type-mismatch",
                                format!(
                                    "signal `{name}` is {} but its derived expression yields {}",
                                    sig.ty.label(),
                                    res.ty_desc
                                ),
                                want.map(|w| {
                                    format!(
                                        "a derived {} signal needs an expression of type {w}",
                                        sig.ty.label()
                                    )
                                }),
                                self.locate(name),
                            );
                        }
                        edges.insert(name.clone(), res.signal_refs);
                    }
                    Err(e) => self.err(
                        "interactive-view/derived-error",
                        format!("signal `{name}`: {}", e.message),
                        None,
                        self.locate(name),
                    ),
                }
            }
        }

        // ── S7: the reactive signal graph must be a DAG ──
        if let Some(cycle) = find_cycle(&edges) {
            self.err(
                "interactive-view/reactive-cycle",
                format!("reactive dependency cycle: {}", cycle.join(" → ")),
                Some(
                    "derived signals must not depend on themselves, directly or transitively"
                        .into(),
                ),
                self.locate(&cycle[0]),
            );
        }

        // ── second view pass: block validation (S3/S5, V2/V3/V4) ──
        for b in &doc.view {
            self.check_block(doc, b, 1);
        }
    }

    fn collect_chart_ids(blocks: &[Block], out: &mut BTreeSet<String>) {
        for b in blocks {
            match b {
                Block::Chart { id: Some(id), .. } => {
                    out.insert(id.clone());
                }
                Block::Stack { children } | Block::Columns { children, .. } => {
                    Self::collect_chart_ids(children, out)
                }
                Block::Tabs { items } => {
                    for t in items {
                        Self::collect_chart_ids(&t.children, out)
                    }
                }
                _ => {}
            }
        }
    }

    fn check_block(&mut self, doc: &Document, b: &Block, depth: usize) {
        match b {
            Block::Section { md } => self.check_interpolations(md),
            Block::Metric(m) => self.check_metric(m),
            Block::MetricGroup { items } => {
                for m in items {
                    self.check_metric(m)
                }
            }
            Block::Callout { md, .. } => self.check_interpolations(md),
            Block::Chart { id, data, .. } => {
                if !self.datasets.contains_key(data) {
                    self.err(
                        "interactive-view/unknown-dataset",
                        format!("chart references unknown dataset `{data}`"),
                        None,
                        self.locate(data),
                    );
                }
                let _ = id; // param-name resolution is Phase 2 (real vl.compile)
            }
            Block::Table { data, columns } => {
                if !self.datasets.contains_key(data) {
                    self.err(
                        "interactive-view/unknown-dataset",
                        format!("table references unknown dataset `{data}`"),
                        None,
                        self.locate(data),
                    );
                } else if let Some(sel) = columns {
                    // Collect missing columns before emitting (the diagnostic push
                    // borrows `self` mutably, the dataset lookup immutably).
                    let missing: Vec<String> = {
                        let cols = &self.datasets[data];
                        sel.iter()
                            .filter(|c| !cols.contains_key(*c))
                            .cloned()
                            .collect()
                    };
                    for col in missing {
                        self.err(
                            "interactive-view/unknown-column",
                            format!("table column `{col}` is not in dataset `{data}`"),
                            None,
                            self.locate(&col),
                        );
                    }
                }
            }
            Block::Input { signal, widget } => self.check_input(signal.as_deref(), widget.as_ref()),
            Block::Stack { children } => self.check_container(doc, children, depth),
            Block::Columns { collapse, children } => {
                if !*collapse {
                    self.err(
                        "interactive-view/columns-no-collapse",
                        "`columns` with collapse:false cannot be proven to fit a phone; \
                         omit collapse or set it true"
                            .into(),
                        Some("narrow screens must be able to stack the columns".into()),
                        self.locate("columns"),
                    );
                }
                self.check_container(doc, children, depth);
            }
            Block::Tabs { items } => {
                for t in items {
                    self.check_container(doc, &t.children, depth);
                }
            }
        }
    }

    fn check_container(&mut self, doc: &Document, children: &[Block], depth: usize) {
        if depth >= MAX_NESTING {
            self.err(
                "interactive-view/nesting-too-deep",
                format!("layout nesting exceeds {MAX_NESTING}; flatten the view"),
                None,
                (1, 1),
            );
            return;
        }
        for b in children {
            self.check_block(doc, b, depth + 1);
        }
    }

    fn check_metric(&mut self, m: &crate::interactive_view::model::Metric) {
        if m.label.chars().count() > MAX_METRIC_LABEL_LEN {
            self.warn(
                "interactive-view/metric-label-long",
                format!("metric label exceeds {MAX_METRIC_LABEL_LEN} chars; it may wrap awkwardly"),
                None,
                self.locate(&m.label),
            );
        }
        self.check_interpolations(&m.value);
    }

    fn check_input(&mut self, signal: Option<&str>, widget: Option<&Widget>) {
        match (signal, widget) {
            (Some(sig), None) => {
                // Render the widget declared on the referenced signal.
                if !self.signals.contains_key(sig) {
                    self.err(
                        "interactive-view/unknown-signal",
                        format!("input references unknown signal `{sig}`"),
                        None,
                        self.locate(sig),
                    );
                }
                // (that the signal actually has a widget is checked at the signal;
                // an input on a derived/from signal has nothing to render)
            }
            (None, Some(w)) => {
                self.check_widget("<input>", w, None);
                // A standalone button's reset targets must be real signals (S3).
                if let Widget::Button {
                    action: Some(action),
                    ..
                } = w
                {
                    for target in &action.reset {
                        if !self.signals.contains_key(target) {
                            self.err(
                                "interactive-view/unknown-signal",
                                format!("button reset targets unknown signal `{target}`"),
                                None,
                                self.locate(target),
                            );
                        }
                    }
                }
            }
            (Some(_), Some(_)) => self.err(
                "interactive-view/input-ambiguous",
                "input has both `signal` and `widget`; provide one".into(),
                None,
                (1, 1),
            ),
            (None, None) => self.err(
                "interactive-view/input-empty",
                "input needs either a `signal` or a `widget`".into(),
                None,
                (1, 1),
            ),
        }
    }

    /// S4 (out-type) + S9 (mobile bounds) + V4 (content bounds) for one widget.
    fn check_widget(&mut self, owner: &str, w: &Widget, signal_ty: Option<SignalType>) {
        // S4: the widget's output type must match the signal it drives.
        if let (Some(out), Some(want)) = (w.output_type(), signal_ty) {
            if !type_compatible(out, want) {
                self.err(
                    "interactive-view/widget-type-mismatch",
                    format!(
                        "signal `{owner}` is {} but its {} widget produces {}",
                        want.label(),
                        w.type_tag(),
                        out.label()
                    ),
                    None,
                    self.locate(owner),
                );
            }
        } else if w.output_type().is_none() {
            // button: only valid as a standalone control, never a signal source
            if signal_ty.is_some() {
                self.err(
                    "interactive-view/button-as-signal",
                    format!("signal `{owner}` cannot use a button (it stores no value)"),
                    Some(
                        "a button is a momentary action; use it in a standalone `input` block"
                            .into(),
                    ),
                    self.locate(owner),
                );
            }
        }

        // labels & options (V4)
        for opt in w.options() {
            if opt.label.chars().count() > MAX_OPTION_LABEL_LEN {
                self.warn(
                    "interactive-view/option-label-long",
                    format!(
                        "option label `{}` exceeds {MAX_OPTION_LABEL_LEN} chars",
                        opt.label
                    ),
                    None,
                    self.locate(&opt.label),
                );
            }
        }

        // per-widget bounds (S9)
        match w {
            Widget::Segmented { options, .. } if options.len() > MAX_SEGMENTED_OPTIONS => {
                self.err(
                    "interactive-view/segmented-too-many",
                    format!(
                        "segmented control has {} options (> {MAX_SEGMENTED_OPTIONS}); use a `select`",
                        options.len()
                    ),
                    Some("a segmented row overflows a phone past 5 options".into()),
                    self.locate(owner),
                );
            }
            Widget::TextInput { max_length, .. } => match max_length {
                None => self.err(
                    "interactive-view/textinput-unbounded",
                    format!("textInput `{owner}` needs a maxLength (bounded input is mobile-safe)"),
                    None,
                    self.locate(owner),
                ),
                Some(n) if *n > MAX_TEXT_INPUT_LEN => self.warn(
                    "interactive-view/textinput-long",
                    format!("textInput maxLength {n} is large (> {MAX_TEXT_INPUT_LEN})"),
                    None,
                    self.locate(owner),
                ),
                _ => {}
            },
            Widget::Slider { min, max, step, .. } | Widget::RangeSlider { min, max, step, .. } => {
                if min >= max {
                    self.err(
                        "interactive-view/slider-range",
                        format!("slider `{owner}` needs min < max (got {min}..{max})"),
                        None,
                        self.locate(owner),
                    );
                }
                if let Some(s) = step {
                    if *s <= 0.0 {
                        self.err(
                            "interactive-view/slider-step",
                            format!("slider `{owner}` step must be > 0"),
                            None,
                            self.locate(owner),
                        );
                    }
                }
            }
            _ => {}
        }

        if let Some(label) = widget_label(w) {
            if label.chars().count() > MAX_LABEL_LEN {
                self.warn(
                    "interactive-view/label-long",
                    format!("widget label exceeds {MAX_LABEL_LEN} chars"),
                    None,
                    self.locate(label),
                );
            }
        }
    }

    /// S3: every `{{signal｜fmt}}` interpolation resolves to a declared signal.
    fn check_interpolations(&mut self, template: &str) {
        for name in extract_interpolation_signals(template) {
            if !self.signals.contains_key(&name) {
                self.err(
                    "interactive-view/unknown-signal",
                    format!("interpolation references unknown signal `{name}`"),
                    None,
                    self.locate(&format!("{{{{{name}")),
                );
            }
        }
    }

    fn check_data_source(&mut self, name: &str, src: &str) {
        let ok = src.starts_with('/') && !src.split('/').any(|seg| seg == "." || seg == "..");
        if !ok {
            self.err(
                "interactive-view/bad-data-path",
                format!(
                    "dataset `{name}` source `{src}` must be an absolute content path (`/`-rooted, no `.`/`..`)"
                ),
                Some("use an absolute content path like `/finance/data/x.arrow`, never a host FS path".into()),
                self.locate(src),
            );
        }
    }

    // ── diagnostic helpers ──

    fn err(&mut self, rule: &str, msg: String, hint: Option<String>, at: (u32, u32)) {
        self.diags.push(diag(
            self.file,
            at.0,
            at.1,
            Severity::Error,
            rule,
            msg,
            hint,
        ));
    }
    fn warn(&mut self, rule: &str, msg: String, hint: Option<String>, at: (u32, u32)) {
        self.diags.push(diag(
            self.file,
            at.0,
            at.1,
            Severity::Warning,
            rule,
            msg,
            hint,
        ));
    }

    /// Best-effort 1-based (line, col) of the first occurrence of `needle` in the
    /// source, so a diagnostic points near the offending name. Falls back to 1:1.
    fn locate(&self, needle: &str) -> (u32, u32) {
        match self.source.find(needle) {
            Some(idx) => {
                let pre = &self.source[..idx];
                let line = pre.matches('\n').count() as u32 + 1;
                let col = (idx - pre.rfind('\n').map(|i| i + 1).unwrap_or(0)) as u32 + 1;
                (line, col)
            }
            None => (1, 1),
        }
    }
}

// ── free helpers ─────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
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
        line: line.max(1),
        col: col.max(1),
        end_line: line.max(1),
        end_col: col.max(1),
        severity,
        source: SRC,
        rule: rule.to_string(),
        message,
        hint,
        snippet: None,
    }
}

fn clean(raw: &str) -> String {
    match raw.find(" at line ") {
        Some(i) => raw[..i].to_string(),
        None => raw.to_string(),
    }
}

/// The scalar type-label a `derived` expression must produce for a given signal
/// type (`None` ⇒ that signal type can't be `derived`).
fn scalar_label(ty: SignalType) -> Option<&'static str> {
    match ty {
        SignalType::Number | SignalType::Integer => Some("number"),
        SignalType::Boolean => Some("boolean"),
        SignalType::String | SignalType::Enum => Some("string"),
        SignalType::Temporal => Some("temporal"),
        // interval/array signals are widget/selection-sourced, not derived
        _ => None,
    }
}

/// Whether a widget output type satisfies a declared signal type (S4).
fn type_compatible(out: SignalType, want: SignalType) -> bool {
    if out == want {
        return true;
    }
    // number/integer interchange for scalars driven by numeric widgets.
    matches!(
        (out, want),
        (SignalType::Number, SignalType::Integer) | (SignalType::Integer, SignalType::Number)
    )
}

fn widget_label(w: &Widget) -> Option<&str> {
    match w {
        Widget::Slider { label, .. }
        | Widget::RangeSlider { label, .. }
        | Widget::NumberInput { label, .. }
        | Widget::Stepper { label, .. }
        | Widget::Toggle { label, .. }
        | Widget::Segmented { label, .. }
        | Widget::RadioGroup { label, .. }
        | Widget::Select { label, .. }
        | Widget::MultiSelect { label, .. }
        | Widget::CheckboxGroup { label, .. }
        | Widget::TextInput { label, .. }
        | Widget::DatePicker { label, .. }
        | Widget::DateRange { label, .. }
        | Widget::Button { label, .. } => label.as_deref(),
    }
}

/// Extract the referenced signal name from each `{{ … }}` interpolation: the
/// leading identifier of the segment before the first `|` filter pipe. E.g.
/// `{{ sharpe | round(2) }}` → `sharpe`; `{{ band[0] }}` → `band`.
fn extract_interpolation_signals(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(end) = template[i + 2..].find("}}") {
                let inner = &template[i + 2..i + 2 + end];
                let head = inner.split('|').next().unwrap_or("").trim();
                let name: String = head
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    out.push(name);
                }
                i = i + 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Find a cycle in the derived-signal dependency graph (S7). Returns the cycle
/// path (a → b → … → a) if any, using an iterative DFS with a recursion stack.
fn find_cycle(edges: &BTreeMap<String, BTreeSet<String>>) -> Option<Vec<String>> {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Visiting,
        Done,
    }
    let mut state: BTreeMap<String, State> = BTreeMap::new();

    // Depth-first from each node, tracking the active path for cycle recovery.
    fn dfs(
        node: &str,
        edges: &BTreeMap<String, BTreeSet<String>>,
        state: &mut BTreeMap<String, State>,
        path: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        state.insert(node.to_string(), State::Visiting);
        path.push(node.to_string());
        if let Some(deps) = edges.get(node) {
            for dep in deps {
                match state.get(dep) {
                    Some(State::Visiting) => {
                        // Found a back-edge: slice the path from `dep` onward.
                        let start = path.iter().position(|n| n == dep).unwrap_or(0);
                        let mut cyc = path[start..].to_vec();
                        cyc.push(dep.clone());
                        return Some(cyc);
                    }
                    Some(State::Done) => {}
                    None => {
                        if let Some(c) = dfs(dep, edges, state, path) {
                            return Some(c);
                        }
                    }
                }
            }
        }
        path.pop();
        state.insert(node.to_string(), State::Done);
        None
    }

    for node in edges.keys() {
        if !matches!(state.get(node), Some(State::Done)) {
            let mut path = Vec::new();
            if let Some(c) = dfs(node, edges, &mut state, &mut path) {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::FileType;
    use std::path::PathBuf;

    fn check(source: &str) -> Vec<Diagnostic> {
        let file = CheckFile {
            path: PathBuf::from("t.interactive-view.json"),
            rel: "t.interactive-view.json".to_string(),
            source: source.to_string(),
            file_type: FileType::InteractiveView,
        };
        InteractiveViewValidator.check(
            &file,
            &CheckCtx {
                dir: PathBuf::from("."),
            },
        )
    }

    fn rules(d: &[Diagnostic]) -> Vec<&str> {
        d.iter().map(|x| x.rule.as_str()).collect()
    }

    #[test]
    fn minimal_valid_doc_passes() {
        let d = check(
            r#"{"interactiveView":1,
                "signals":{"r":{"type":"number","init":0,
                    "widget":{"type":"slider","min":0,"max":1,"step":0.1,"label":"R"}}},
                "view":[{"block":"section","md":"r is {{r}}"}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn unknown_signal_in_interpolation() {
        let d = check(
            r#"{"interactiveView":1,"signals":{},"view":[{"block":"section","md":"x {{nope}}"}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/unknown-signal"),
            "{d:?}"
        );
    }

    #[test]
    fn widget_type_mismatch() {
        let d = check(
            r#"{"interactiveView":1,"signals":{"b":{"type":"boolean",
                "widget":{"type":"slider","min":0,"max":1}}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/widget-type-mismatch"),
            "{d:?}"
        );
    }

    #[test]
    fn segmented_option_cap() {
        let d = check(
            r#"{"interactiveView":1,"signals":{"s":{"type":"enum",
                "widget":{"type":"segmented","options":[
                {"label":"1","value":1},{"label":"2","value":2},{"label":"3","value":3},
                {"label":"4","value":4},{"label":"5","value":5},{"label":"6","value":6}]}}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/segmented-too-many"),
            "{d:?}"
        );
    }

    #[test]
    fn derived_cycle_detected() {
        let d = check(
            r#"{"interactiveView":1,"signals":{
                "a":{"type":"number","derived":"b + 1"},
                "b":{"type":"number","derived":"a + 1"}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/reactive-cycle"),
            "{d:?}"
        );
    }

    #[test]
    fn derived_type_mismatch() {
        let d = check(
            r#"{"interactiveView":1,"data":{"ds":{"columns":{"x":"number"},"values":[]}},
               "signals":{"m":{"type":"boolean","derived":"mean(ds.x)"}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/derived-type-mismatch"),
            "{d:?}"
        );
    }

    #[test]
    fn bad_data_path_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"ds":{"columns":{"x":"number"},"source":"./rel/x.arrow"}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/bad-data-path"),
            "{d:?}"
        );
    }

    #[test]
    fn columns_must_collapse() {
        let d = check(
            r#"{"interactiveView":1,"signals":{},"view":[
               {"block":"columns","collapse":false,"children":[]}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/columns-no-collapse"),
            "{d:?}"
        );
    }
}
