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
//! Charts are a closed mark catalog (`ChartMark`), not raw Vega-Lite, so they
//! validate like every other block: `data` resolves, each encoding column
//! exists with a channel-appropriate type, series are non-empty, and reactive
//! overlays reference a signal whose scalar kind matches the axis. Colours are
//! theme-assigned (no author colour field), so a compiling chart renders — the
//! same "checker == renderer" contract the widgets/blocks hold.

use std::collections::{BTreeMap, BTreeSet};

use comrak::nodes::NodeValue;
use comrak::{parse_document, Arena};

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};
use crate::interactive_view::expr::{self, ExprEnv};
use crate::interactive_view::model::{
    Block, ChartField, ChartMark, ColumnType, Document, Overlay, SignalType, Widget,
};
use crate::server::renderer;

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
        check_doc(&file.rel, &file.source, 0)
    }
}

/// Validates ` ```interactive-view ` fences embedded in markdown — the primary
/// way the type is used (a reactive report inline in a book/doc chapter, so it
/// gets a real chapter title). Registered alongside the other markdown
/// validators; walks the same comrak AST the renderer emits (checker ==
/// renderer) and runs the full document check per fence, offset to the fence's
/// line in the `.md`.
pub struct InteractiveViewFenceValidator;

impl Validator for InteractiveViewFenceValidator {
    fn check(&self, file: &CheckFile, _ctx: &CheckCtx) -> Vec<Diagnostic> {
        let arena = Arena::new();
        let root = parse_document(&arena, &file.source, &renderer::markdown_options());
        let mut diags = Vec::new();
        for node in root.descendants() {
            let data = node.data.borrow();
            let NodeValue::CodeBlock(cb) = &data.value else {
                continue;
            };
            if cb.info.split_whitespace().next() != Some("interactive-view") {
                continue;
            }
            // The fence opener sits on `start.line`; the JSON body starts on the
            // next line, so that is the offset added to each diagnostic's line.
            let offset = data.sourcepos.start.line as u32;
            diags.extend(check_doc(&file.rel, &cb.literal, offset));
        }
        diags
    }
}

/// Check one Interactive View document `source`, reporting diagnostics against
/// `rel`. `line_offset` (0 for a standalone file) is added to every diagnostic
/// line so an ` ```interactive-view ` fence embedded in markdown points at the
/// right line in the `.md`. This is the single entry both the standalone file
/// validator and the markdown-fence validator share (checker == renderer: the
/// same IR + checks whether the doc is a whole file or a fence).
pub fn check_doc(rel: &str, source: &str, line_offset: u32) -> Vec<Diagnostic> {
    let doc = match Document::parse(source) {
        Ok(d) => d,
        Err(e) => {
            return vec![diag(
                rel,
                e.line() as u32 + line_offset,
                e.column() as u32,
                Severity::Error,
                "interactive-view/parse-error",
                clean(&e.to_string()),
                Some("must be a well-formed Interactive View document — see docs/design/interactive-view.md".into()),
            )]
        }
    };
    let mut c = Checker {
        rel,
        source,
        diags: Vec::new(),
        signals: BTreeMap::new(),
        datasets: BTreeMap::new(),
        chart_ids: BTreeSet::new(),
    };
    c.run(&doc);
    if line_offset > 0 {
        for d in &mut c.diags {
            d.line += line_offset;
            d.end_line += line_offset;
        }
    }
    c.diags
}

struct Checker<'a> {
    rel: &'a str,
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
            Block::Chart {
                data,
                mark,
                overlays,
                title,
                ..
            } => self.check_chart(data, mark, overlays, title.as_deref()),
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

    /// Chart soundness: `data` resolves, every encoding column exists with a
    /// type the channel accepts, series are non-empty, and each reactive overlay
    /// references a real signal whose scalar kind matches the axis it sits on.
    /// Colours are theme-assigned (no author colour field), so there is nothing
    /// pixel-level left to get wrong — a compiling chart renders.
    fn check_chart(
        &mut self,
        data: &str,
        mark: &ChartMark,
        overlays: &[Overlay],
        title: Option<&str>,
    ) {
        if let Some(t) = title {
            if t.chars().count() > MAX_LABEL_LEN {
                self.warn(
                    "interactive-view/label-long",
                    format!("chart title exceeds {MAX_LABEL_LEN} chars"),
                    None,
                    self.locate(t),
                );
            }
        }

        // Clone the schema so column reads don't borrow `self` while diagnostics
        // push into it (same pattern the table check uses).
        let cols = match self.datasets.get(data) {
            Some(c) => c.clone(),
            None => {
                self.err(
                    "interactive-view/unknown-dataset",
                    format!("chart references unknown dataset `{data}`"),
                    None,
                    self.locate(data),
                );
                return;
            }
        };

        let kind = mark.kind_tag();
        match mark {
            ChartMark::Line { x, y, .. } | ChartMark::Area { x, y, .. } => {
                self.check_field(&cols, data, kind, "x", x, col_ordered, "temporal, numeric, or categorical");
                self.require_series(kind, y);
                for s in y {
                    self.check_field(&cols, data, kind, "y", s, col_numeric, "numeric");
                }
            }
            ChartMark::Bar { x, y, .. } => {
                self.check_field(
                    &cols,
                    data,
                    kind,
                    "x",
                    x,
                    col_category,
                    "categorical (string/temporal/integer/boolean)",
                );
                self.require_series(kind, y);
                for s in y {
                    self.check_field(&cols, data, kind, "y", s, col_numeric, "numeric");
                }
            }
            ChartMark::BarHorizontal { category, value } => {
                self.check_field(
                    &cols,
                    data,
                    kind,
                    "category",
                    category,
                    col_category,
                    "categorical (string/temporal/integer/boolean)",
                );
                self.check_field(&cols, data, kind, "value", value, col_numeric, "numeric");
            }
            ChartMark::Pie {
                category, value, ..
            } => {
                self.check_field(
                    &cols,
                    data,
                    kind,
                    "category",
                    category,
                    col_category,
                    "categorical (string/temporal/integer/boolean)",
                );
                self.check_field(&cols, data, kind, "value", value, col_numeric, "numeric");
            }
            ChartMark::Scatter {
                x,
                y,
                size,
                series,
            } => {
                self.check_field(&cols, data, kind, "x", x, col_numeric, "numeric");
                self.check_field(&cols, data, kind, "y", y, col_numeric, "numeric");
                if let Some(s) = size {
                    self.check_field(&cols, data, kind, "size", s, col_numeric, "numeric");
                }
                if let Some(s) = series {
                    self.check_field(
                        &cols,
                        data,
                        kind,
                        "series",
                        s,
                        col_category,
                        "categorical (string/temporal/integer/boolean)",
                    );
                }
            }
            ChartMark::Histogram { value, bins } => {
                self.check_field(&cols, data, kind, "value", value, col_numeric, "numeric");
                if matches!(bins, Some(0)) {
                    self.err(
                        "interactive-view/chart-bins",
                        format!("{kind} chart `bins` must be > 0"),
                        None,
                        self.locate(&value.column),
                    );
                }
            }
        }

        self.check_overlays(&cols, mark, overlays);
    }

    /// A chart channel's column must exist and satisfy the channel's type
    /// predicate. Returns the resolved column type (for callers that care).
    #[allow(clippy::too_many_arguments)]
    fn check_field(
        &mut self,
        cols: &BTreeMap<String, ColumnType>,
        data: &str,
        kind: &str,
        channel: &str,
        field: &ChartField,
        ok: fn(ColumnType) -> bool,
        expected: &str,
    ) -> Option<ColumnType> {
        match cols.get(&field.column) {
            None => {
                self.err(
                    "interactive-view/unknown-column",
                    format!(
                        "{kind} chart {channel} column `{}` is not in dataset `{data}`",
                        field.column
                    ),
                    None,
                    self.locate(&field.column),
                );
                None
            }
            Some(&t) if !ok(t) => {
                self.err(
                    "interactive-view/chart-type-mismatch",
                    format!(
                        "{kind} chart {channel} column `{}` is {} but must be {expected}",
                        field.column,
                        col_label(t)
                    ),
                    None,
                    self.locate(&field.column),
                );
                Some(t)
            }
            Some(&t) => Some(t),
        }
    }

    fn require_series(&mut self, kind: &str, y: &[ChartField]) {
        if y.is_empty() {
            self.err(
                "interactive-view/chart-empty-series",
                format!("{kind} chart needs at least one `y` series"),
                None,
                (1, 1),
            );
        }
    }

    /// Reactive overlays: only continuous-cartesian marks carry them; each
    /// `value`/`from`/`to` must resolve to a signal whose scalar kind matches the
    /// axis (Y always numeric; X = the mark's x-axis kind).
    fn check_overlays(
        &mut self,
        cols: &BTreeMap<String, ColumnType>,
        mark: &ChartMark,
        overlays: &[Overlay],
    ) {
        if overlays.is_empty() {
            return;
        }
        // Only continuous-cartesian marks carry overlays (bar/pie/barHorizontal
        // have a categorical axis; histogram is binned).
        let supports = matches!(
            mark,
            ChartMark::Line { .. } | ChartMark::Area { .. } | ChartMark::Scatter { .. }
        );
        if !supports {
            self.err(
                "interactive-view/overlay-unsupported",
                format!(
                    "{} chart does not support overlays; use line/area/scatter",
                    mark.kind_tag()
                ),
                Some("reference lines/bands need a continuous x-axis".into()),
                (1, 1),
            );
            return;
        }
        // The renderer draws a numeric x as a continuous axis but a temporal x as
        // categorical, so an x-axis rule/band (vLine/vBand) can only align on a
        // numeric x. A y-axis rule/band (hLine/hBand) is always fine — the value
        // axis is numeric-continuous for every supported mark. Every overlay
        // position is therefore numeric.
        let x_numeric = match mark {
            ChartMark::Line { x, .. } | ChartMark::Area { x, .. } => {
                matches!(cols.get(&x.column), Some(ColumnType::Number | ColumnType::Integer))
            }
            ChartMark::Scatter { .. } => true,
            _ => false,
        };

        for ov in overlays {
            if !ov.is_vertical_axis() && !x_numeric {
                self.err(
                    "interactive-view/overlay-x-not-numeric",
                    format!(
                        "{} overlay needs a numeric x-axis; this chart's x is temporal/categorical",
                        ov.overlay_tag()
                    ),
                    Some("use a numeric x column, or a horizontal (hLine/hBand) overlay".into()),
                    (1, 1),
                );
                continue;
            }
            let refs: [&str; 2] = match ov {
                Overlay::HLine { value, .. } | Overlay::VLine { value, .. } => [value, ""],
                Overlay::HBand { from, to, .. } | Overlay::VBand { from, to, .. } => [from, to],
            };
            for r in refs {
                if r.is_empty() {
                    continue;
                }
                self.check_overlay_ref(ov.overlay_tag(), r, AxisKind::Numeric);
            }
        }
    }

    fn check_overlay_ref(&mut self, tag: &str, acc: &str, want: AxisKind) {
        let (name, indexed) = parse_accessor(acc);
        let Some(&ty) = self.signals.get(&name) else {
            self.err(
                "interactive-view/unknown-signal",
                format!("{tag} overlay references unknown signal `{name}`"),
                None,
                self.locate(acc),
            );
            return;
        };
        match axis_scalar_kind(ty, indexed) {
            Err(msg) => self.err(
                "interactive-view/overlay-type-mismatch",
                format!("{tag} overlay ref `{acc}`: {msg}"),
                None,
                self.locate(acc),
            ),
            Ok(got) if got != want => self.err(
                "interactive-view/overlay-type-mismatch",
                format!(
                    "{tag} overlay ref `{acc}` is {} but the axis is {}",
                    got.label(),
                    want.label()
                ),
                None,
                self.locate(acc),
            ),
            Ok(_) => {}
        }
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
            self.rel,
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
            self.rel,
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
    rel: &str,
    line: u32,
    col: u32,
    severity: Severity,
    rule: &str,
    message: String,
    hint: Option<String>,
) -> Diagnostic {
    Diagnostic {
        file: rel.to_string(),
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

// ── chart channel type predicates ────────────────────────────────────────────

fn col_numeric(t: ColumnType) -> bool {
    matches!(t, ColumnType::Number | ColumnType::Integer)
}
/// A line/area x-axis: continuous (number/temporal) or a categorical axis
/// (string/integer) laid out in the dataset's row order. Not boolean.
fn col_ordered(t: ColumnType) -> bool {
    matches!(
        t,
        ColumnType::Number | ColumnType::Integer | ColumnType::Temporal | ColumnType::String
    )
}
/// A discrete/categorical channel (bar x, pie/scatter grouping).
fn col_category(t: ColumnType) -> bool {
    matches!(
        t,
        ColumnType::String | ColumnType::Boolean | ColumnType::Integer | ColumnType::Temporal
    )
}

fn col_label(t: ColumnType) -> &'static str {
    match t {
        ColumnType::Number => "number",
        ColumnType::Integer => "integer",
        ColumnType::String => "string",
        ColumnType::Boolean => "boolean",
        ColumnType::Temporal => "temporal",
    }
}

/// The scalar kind of an axis — what an overlay reference must produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AxisKind {
    Numeric,
    Temporal,
}
impl AxisKind {
    fn label(self) -> &'static str {
        match self {
            AxisKind::Numeric => "numeric",
            AxisKind::Temporal => "temporal",
        }
    }
}

/// Split an overlay accessor into `(signal_name, is_indexed)` — `band[0]` →
/// `("band", true)`, `sharpe` → `("sharpe", false)`.
fn parse_accessor(acc: &str) -> (String, bool) {
    match acc.find('[') {
        Some(i) => (acc[..i].trim().to_string(), true),
        None => (acc.trim().to_string(), false),
    }
}

/// The scalar axis kind a signal accessor yields, or why it can't be a rule/band
/// position. An interval signal must be indexed (`x[0]`/`x[1]`); a scalar must not.
fn axis_scalar_kind(ty: SignalType, indexed: bool) -> Result<AxisKind, String> {
    match (ty, indexed) {
        (SignalType::Number | SignalType::Integer, false) => Ok(AxisKind::Numeric),
        (SignalType::Temporal, false) => Ok(AxisKind::Temporal),
        (SignalType::IntervalNumber, true) => Ok(AxisKind::Numeric),
        (SignalType::IntervalTemporal, true) => Ok(AxisKind::Temporal),
        (SignalType::IntervalNumber | SignalType::IntervalTemporal, false) => Err(format!(
            "`{}` is an interval; index an endpoint (name[0] / name[1])",
            ty.label()
        )),
        (_, true) => Err(format!("`{}` cannot be indexed", ty.label())),
        (other, false) => Err(format!(
            "`{}` is not a numeric/temporal position",
            other.label()
        )),
    }
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

    #[test]
    fn line_chart_valid_passes() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"day":"temporal","close":"number"},
                 "values":[{"day":"2024-01-01","close":10},{"day":"2024-01-02","close":11}]}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"day"},"y":[{"column":"close"}]}}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn chart_unknown_column_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"day":"temporal","close":"number"},"values":[]}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"day"},"y":[{"column":"nope"}]}}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/unknown-column"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_channel_type_mismatch_rejected() {
        // pie value must be numeric; `name` is a string.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"seg":{"columns":{"name":"string"},"values":[]}},
               "view":[{"block":"chart","data":"seg",
                 "mark":{"chart":"pie","category":{"column":"name"},"value":{"column":"name"}}}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/chart-type-mismatch"),
            "{d:?}"
        );
    }

    #[test]
    fn reactive_overlay_valid_passes() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"day":"temporal","close":"number"},"values":[]}},
               "signals":{"th":{"type":"number","init":10,
                 "widget":{"type":"slider","min":0,"max":100}}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"day"},"y":[{"column":"close"}]},
                 "overlays":[{"overlay":"hLine","value":"th","label":"threshold"}]}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn overlay_axis_type_mismatch_rejected() {
        // a temporal signal cannot position a horizontal (numeric Y) rule.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"day":"temporal","close":"number"},"values":[]}},
               "signals":{"d":{"type":"temporal","init":"2024-01-01",
                 "widget":{"type":"datePicker"}}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"day"},"y":[{"column":"close"}]},
                 "overlays":[{"overlay":"hLine","value":"d"}]}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/overlay-type-mismatch"),
            "{d:?}"
        );
    }

    #[test]
    fn overlay_on_pie_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"seg":{"columns":{"name":"string","v":"number"},"values":[]}},
               "signals":{"th":{"type":"number","init":1,"widget":{"type":"slider","min":0,"max":9}}},
               "view":[{"block":"chart","data":"seg",
                 "mark":{"chart":"pie","category":{"column":"name"},"value":{"column":"v"}},
                 "overlays":[{"overlay":"hLine","value":"th"}]}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/overlay-unsupported"),
            "{d:?}"
        );
    }

    #[test]
    fn range_slider_vband_valid_passes() {
        // a range-slider interval shades a vertical band via indexed endpoints.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "signals":{"band":{"type":"interval<number>","init":[2,8],
                 "widget":{"type":"rangeSlider","min":0,"max":10}}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]},
                 "overlays":[{"overlay":"vBand","from":"band[0]","to":"band[1]"}]}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }
}
