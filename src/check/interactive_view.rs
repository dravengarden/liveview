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
use comrak::{Arena, parse_document};

use crate::check::diagnostic::{Diagnostic, Severity};
use crate::check::{CheckCtx, CheckFile, Validator};
use crate::interactive_view::expr::{self, ExprEnv};
use crate::interactive_view::model::{
    Block, ChartField, ChartMark, ColumnType, Document, Overlay, SelectionSource, SignalType,
    Widget,
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
/// Histogram bucket cap: more bars than this can't be told apart on a phone,
/// and the renderer clamps to the same bound.
const MAX_HISTOGRAM_BINS: u32 = 100;
/// The interpolation filters the renderer implements (`interpolate.ts`).
const INTERPOLATION_FILTERS: [&str; 3] = ["round", "join", "date"];

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
        widget_signals: BTreeSet::new(),
        datasets: BTreeMap::new(),
        chart_meta: BTreeMap::new(),
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
    /// Signals that declare a `widget` — the only ones an `input` block or a
    /// docked chart control can render.
    widget_signals: BTreeSet<String>,
    datasets: BTreeMap<String, BTreeMap<String, crate::interactive_view::model::ColumnType>>,
    /// Chart `id` → its selection metadata (dataset + mark kind), so a signal's
    /// `from` (click-to-select) can be validated against the target chart.
    chart_meta: BTreeMap<String, ChartSel>,
}

/// What a selectable chart exposes to a `from` signal: the dataset its rows come
/// from (whose column types validate the emitted value) and its mark kind (only
/// the categorical marks — bar/barHorizontal/pie — are clickable selectors).
struct ChartSel {
    data: String,
    kind: &'static str,
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

        // ── signal symbol table first (derived datasets type against signal
        //    types; charts/interpolations resolve against it) ──
        for (name, sig) in &doc.signals {
            self.signals.insert(name.clone(), sig.ty);
            if sig.widget.is_some() {
                self.widget_signals.insert(name.clone());
            }
        }

        // The unified reactive DAG (S7): a node is a derived signal (`sig:x`) or a
        // derived dataset (`data:x`); its edges are the signals/datasets it reads.
        // Widget/selection signals are external INPUTS, never derivations, so they
        // can't form an evaluation cycle and are not nodes here.
        let mut edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

        // ── datasets: register static (source/values) schemas + validate;
        //    collect derived datasets to resolve once every static schema is in ──
        let mut pending: Vec<(&String, &str)> = Vec::new();
        for (name, ds) in &doc.data {
            if self.signals.contains_key(name) {
                self.err(
                    "interactive-view/name-collision",
                    format!("`{name}` names both a signal and a dataset; names must be distinct"),
                    Some("an expression can't tell which one `{name}` means".into()),
                    self.locate(name),
                );
            }
            let sources = [
                ds.source.is_some(),
                ds.values.is_some(),
                ds.derived.is_some(),
            ];
            match sources.iter().filter(|b| **b).count() {
                0 => {
                    self.err(
                        "interactive-view/data-empty",
                        format!("dataset `{name}` has no `source`, `values`, or `derived`"),
                        None,
                        self.locate(name),
                    );
                    continue;
                }
                1 => {}
                _ => {
                    self.err(
                        "interactive-view/data-ambiguous-source",
                        format!(
                            "dataset `{name}` has more than one of `source`/`values`/`derived`; pick one"
                        ),
                        None,
                        self.locate(name),
                    );
                    continue;
                }
            }
            if let Some(src) = &ds.source {
                self.datasets.insert(name.clone(), ds.columns.clone());
                self.require_columns(name, &ds.columns);
                self.check_data_source(name, src);
            } else if let Some(values) = &ds.values {
                self.datasets.insert(name.clone(), ds.columns.clone());
                self.require_columns(name, &ds.columns);
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
            } else if let Some(expr_src) = &ds.derived {
                pending.push((name, expr_src.as_str()));
            }
        }

        // ── resolve derived-dataset schemas to a fixpoint. `self.datasets` only
        //    ever holds fully-typed schemas, so a derived dataset built on another
        //    just retries until its input resolves (a DAG converges in ≤ N passes).
        //    A dataset that never resolves references an unknown name or forms a
        //    cycle — reported after the loop. ──
        let mut last_err: BTreeMap<String, String> = BTreeMap::new();
        while !pending.is_empty() {
            let mut progressed = false;
            let mut still = Vec::new();
            for (name, src) in pending.drain(..) {
                let res = {
                    let env = ExprEnv {
                        signals: &self.signals,
                        datasets: &self.datasets,
                    };
                    expr::check(src, &env)
                };
                match res {
                    Ok(res) => match res.dataset_columns {
                        Some(cols) => {
                            self.datasets.insert(name.clone(), cols);
                            let mut deps = BTreeSet::new();
                            for s in &res.signal_refs {
                                deps.insert(format!("sig:{s}"));
                            }
                            for d in &res.dataset_refs {
                                deps.insert(format!("data:{d}"));
                            }
                            edges.insert(format!("data:{name}"), deps);
                            progressed = true;
                        }
                        None => {
                            self.err(
                                "interactive-view/derived-data-not-dataset",
                                format!(
                                    "derived dataset `{name}` must be a dataset expression (e.g. `filter(base, …)`), but yields {}",
                                    res.ty_desc
                                ),
                                Some("a derived dataset filters/transforms another dataset".into()),
                                self.locate(name),
                            );
                            progressed = true;
                        }
                    },
                    Err(e) => {
                        last_err.insert(name.clone(), e.message);
                        still.push((name, src));
                    }
                }
            }
            pending = still;
            if !progressed {
                break;
            }
        }
        for (name, _) in &pending {
            let why = last_err
                .get(*name)
                .cloned()
                .unwrap_or_else(|| "unresolved".to_string());
            self.err(
                "interactive-view/derived-data-error",
                format!("derived dataset `{name}`: {why}"),
                Some("it references an unknown dataset/signal or forms a dependency cycle".into()),
                self.locate(name),
            );
        }

        // ── gather chart ids + selection metadata (selection targets) ──
        Self::collect_chart_meta(&doc.view, &mut self.chart_meta);

        // ── signals: S2 one-source, S4/S6 typing, selection & widget bounds ──
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
            self.check_init(name, sig);
            if let Some(from) = &sig.from {
                self.check_selection(name, sig.ty, from);
            }
            if let Some(src) = &sig.derived {
                let res = {
                    let env = ExprEnv {
                        signals: &self.signals,
                        datasets: &self.datasets,
                    };
                    expr::check(src, &env)
                };
                match res {
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
                        let mut deps = BTreeSet::new();
                        for s in &res.signal_refs {
                            deps.insert(format!("sig:{s}"));
                        }
                        for d in &res.dataset_refs {
                            deps.insert(format!("data:{d}"));
                        }
                        edges.insert(format!("sig:{name}"), deps);
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

        // ── S7: the unified reactive graph (signals ∪ datasets) must be a DAG ──
        if let Some(cycle) = find_cycle(&edges) {
            let pretty: Vec<String> = cycle.iter().map(|n| prettify_node(n)).collect();
            let first = strip_node(&cycle[0]);
            self.err(
                "interactive-view/reactive-cycle",
                format!("reactive dependency cycle: {}", pretty.join(" → ")),
                Some(
                    "derived signals/datasets must not depend on themselves, directly or transitively"
                        .into(),
                ),
                self.locate(first),
            );
        }

        // ── final view pass: block validation (S3/S5, V2/V3/V4) ──
        for b in &doc.view {
            self.check_block(doc, b, 1);
        }
    }

    /// Gather every chart `id` and, for the categorical marks, the metadata a
    /// `from` (click-to-select) signal validates against.
    fn collect_chart_meta(blocks: &[Block], out: &mut BTreeMap<String, ChartSel>) {
        for b in blocks {
            match b {
                Block::Chart {
                    id: Some(id),
                    data,
                    mark,
                    ..
                } => {
                    out.insert(
                        id.clone(),
                        ChartSel {
                            data: data.clone(),
                            kind: mark.kind_tag(),
                        },
                    );
                }
                Block::ChartGroup { charts, .. } => {
                    // A grouped chart's `id` is a selection target exactly like a
                    // top-level chart's — collect each member that carries one.
                    for gc in charts {
                        if let Some(id) = &gc.id {
                            out.insert(
                                id.clone(),
                                ChartSel {
                                    data: gc.data.clone(),
                                    kind: gc.mark.kind_tag(),
                                },
                            );
                        }
                    }
                }
                Block::Panel { children, .. }
                | Block::Stack { children }
                | Block::Columns { children, .. } => Self::collect_chart_meta(children, out),
                Block::Tabs { items } => {
                    for t in items {
                        Self::collect_chart_meta(&t.children, out)
                    }
                }
                _ => {}
            }
        }
    }

    /// A `from` signal (chart click-to-select): the target chart must exist, be a
    /// categorical mark (bar/barHorizontal/pie — the clickable selectors), and the
    /// emitted column must exist with a type matching the signal's.
    fn check_selection(&mut self, owner: &str, ty: SignalType, from: &SelectionSource) {
        let Some(sel) = self.chart_meta.get(&from.chart) else {
            self.err(
                "interactive-view/unknown-chart",
                format!(
                    "signal `{owner}` reads a selection from unknown chart `{}`",
                    from.chart
                ),
                Some("give the target chart an `id` matching `from.chart`".into()),
                self.locate(owner),
            );
            return;
        };
        if !matches!(sel.kind, "bar" | "barHorizontal" | "pie") {
            self.err(
                "interactive-view/selection-unsupported",
                format!(
                    "signal `{owner}` selects from a {} chart; only bar/barHorizontal/pie charts are clickable selectors",
                    sel.kind
                ),
                Some("click-to-select needs a categorical mark".into()),
                self.locate(owner),
            );
            return;
        }
        let (data, select) = (sel.data.clone(), from.select.clone());
        let col_ty = self
            .datasets
            .get(&data)
            .and_then(|c| c.get(&select))
            .copied();
        match col_ty {
            None => self.err(
                "interactive-view/unknown-column",
                format!(
                    "signal `{owner}` selects column `{select}` not in chart `{}`'s dataset `{data}`",
                    from.chart
                ),
                None,
                self.locate(&select),
            ),
            Some(ct) if !selection_type_compatible(ct, ty) => self.err(
                "interactive-view/selection-type-mismatch",
                format!(
                    "signal `{owner}` is {} but selects a {} column `{select}`",
                    ty.label(),
                    col_label(ct)
                ),
                Some(
                    "the selected column's type must match the signal (a category is string/enum)"
                        .into(),
                ),
                self.locate(owner),
            ),
            Some(_) => {}
        }
    }

    fn require_columns(
        &mut self,
        name: &str,
        cols: &BTreeMap<String, crate::interactive_view::model::ColumnType>,
    ) {
        if cols.is_empty() {
            self.err(
                "interactive-view/data-no-columns",
                format!("dataset `{name}` declares no columns"),
                None,
                self.locate(name),
            );
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
                controls,
                readouts,
                highlight,
                spotlight,
                ..
            } => {
                self.check_chart(data, mark, overlays, title.as_deref());
                // Docked controls validate exactly like a standalone `input`
                // block; docked readouts exactly like a `metric` tile — the
                // renderer draws them in the chart card, so the same soundness
                // obligations (S3 refs resolve, V4 label bounds) apply.
                for ctl in controls {
                    self.check_input(ctl.signal.as_deref(), ctl.widget.as_ref());
                }
                for m in readouts {
                    self.check_metric(m);
                }
                if let Some(sig) = highlight {
                    self.check_highlight(sig, mark);
                }
                if let Some(sig) = spotlight {
                    self.check_spotlight(sig, mark);
                }
            }
            Block::ChartGroup {
                title,
                charts,
                controls,
                readouts,
            } => {
                if let Some(t) = title
                    && t.chars().count() > MAX_LABEL_LEN
                {
                    self.warn(
                        "interactive-view/label-long",
                        format!("chart group title exceeds {MAX_LABEL_LEN} chars"),
                        None,
                        self.locate(t),
                    );
                }
                if charts.is_empty() {
                    self.err(
                        "interactive-view/chart-group-empty",
                        "chartGroup needs at least one chart".into(),
                        Some("a chartGroup unifies several linked charts in one card".into()),
                        (1, 1),
                    );
                }
                // Each member validates exactly like a standalone `chart` (data
                // resolves, columns/types line up, overlays + highlight sound);
                // the group's controls/readouts are shared, checked once here.
                for gc in charts {
                    self.check_chart(&gc.data, &gc.mark, &gc.overlays, gc.title.as_deref());
                    if let Some(sig) = &gc.highlight {
                        self.check_highlight(sig, &gc.mark);
                    }
                    if let Some(sig) = &gc.spotlight {
                        self.check_spotlight(sig, &gc.mark);
                    }
                }
                for ctl in controls {
                    self.check_input(ctl.signal.as_deref(), ctl.widget.as_ref());
                }
                for m in readouts {
                    self.check_metric(m);
                }
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
            Block::Panel { title, children } => {
                if let Some(t) = title
                    && t.chars().count() > MAX_LABEL_LEN
                {
                    self.warn(
                        "interactive-view/label-long",
                        format!("panel title exceeds {MAX_LABEL_LEN} chars"),
                        None,
                        self.locate(t),
                    );
                }
                self.check_container(doc, children, depth);
            }
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
        if let Some(t) = title
            && t.chars().count() > MAX_LABEL_LEN
        {
            self.warn(
                "interactive-view/label-long",
                format!("chart title exceeds {MAX_LABEL_LEN} chars"),
                None,
                self.locate(t),
            );
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
                self.check_field(
                    &cols,
                    data,
                    kind,
                    "x",
                    x,
                    col_ordered,
                    "temporal, numeric, or categorical",
                );
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
            ChartMark::Scatter { x, y, size, series } => {
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
                if let Some(n) = bins
                    && !(1..=MAX_HISTOGRAM_BINS).contains(n)
                {
                    self.err(
                        "interactive-view/chart-bins",
                        format!(
                            "{kind} chart `bins` must be between 1 and {MAX_HISTOGRAM_BINS} (got {n})"
                        ),
                        None,
                        self.locate(&value.column),
                    );
                }
            }
            ChartMark::Candlestick {
                x,
                open,
                high,
                low,
                close,
                ma,
            } => {
                self.check_field(
                    &cols,
                    data,
                    kind,
                    "x",
                    x,
                    col_ordered,
                    "temporal, numeric, or categorical",
                );
                self.check_field(&cols, data, kind, "open", open, col_numeric, "numeric");
                self.check_field(&cols, data, kind, "high", high, col_numeric, "numeric");
                self.check_field(&cols, data, kind, "low", low, col_numeric, "numeric");
                self.check_field(&cols, data, kind, "close", close, col_numeric, "numeric");
                for m in ma {
                    self.check_field(&cols, data, kind, "ma", m, col_numeric, "numeric");
                }
            }
            ChartMark::Volume {
                x,
                value,
                open,
                close,
            } => {
                self.check_field(
                    &cols,
                    data,
                    kind,
                    "x",
                    x,
                    col_ordered,
                    "temporal, numeric, or categorical",
                );
                self.check_field(&cols, data, kind, "value", value, col_numeric, "numeric");
                if let Some(o) = open {
                    self.check_field(&cols, data, kind, "open", o, col_numeric, "numeric");
                }
                if let Some(c) = close {
                    self.check_field(&cols, data, kind, "close", c, col_numeric, "numeric");
                }
            }
            ChartMark::Depth { price, bid, ask } => {
                self.check_field(&cols, data, kind, "price", price, col_numeric, "numeric");
                self.check_field(&cols, data, kind, "bid", bid, col_numeric, "numeric");
                self.check_field(&cols, data, kind, "ask", ask, col_numeric, "numeric");
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
        // Continuous-value marks carry overlays freely. barHorizontal is a
        // special case: its VALUE axis is horizontal (numeric X), so a vertical
        // rule/band (vLine/vBand) at x = threshold is meaningful (a cutoff line
        // across a ranking); only hLine/hBand — which would land on its category
        // axis — are rejected below. bar/pie/histogram/volume have no continuous
        // value axis to anchor a reference on.
        let is_bar_h = matches!(mark, ChartMark::BarHorizontal { .. });
        let supports = is_bar_h
            || matches!(
                mark,
                ChartMark::Line { .. }
                    | ChartMark::Area { .. }
                    | ChartMark::Scatter { .. }
                    | ChartMark::Candlestick { .. }
                    | ChartMark::Depth { .. }
            );
        if !supports {
            self.err(
                "interactive-view/overlay-unsupported",
                format!(
                    "{} chart does not support overlays; use \
                     line/area/scatter/candlestick/depth/barHorizontal",
                    mark.kind_tag()
                ),
                Some("reference lines/bands need a continuous value axis".into()),
                (1, 1),
            );
            return;
        }
        // The renderer draws a numeric x as a continuous axis but a temporal x as
        // categorical, so an x-axis rule/band (vLine/vBand) can only align on a
        // numeric x. A y-axis rule/band (hLine/hBand) is always fine — the value
        // axis is numeric-continuous for every supported mark. Every overlay
        // position is therefore numeric. barHorizontal's horizontal axis is its
        // numeric value axis, so a vLine there is numeric too.
        let x_numeric = match mark {
            ChartMark::Line { x, .. }
            | ChartMark::Area { x, .. }
            | ChartMark::Candlestick { x, .. } => {
                matches!(
                    cols.get(&x.column),
                    Some(ColumnType::Number | ColumnType::Integer)
                )
            }
            // scatter x, depth's price axis, and barHorizontal's value axis are numeric.
            ChartMark::Scatter { .. }
            | ChartMark::Depth { .. }
            | ChartMark::BarHorizontal { .. } => true,
            _ => false,
        };

        for ov in overlays {
            // On barHorizontal the category axis is vertical, so an hLine/hBand
            // (which sits on that axis) is nonsensical — only vLine/vBand map to
            // the numeric value axis.
            if is_bar_h && ov.is_vertical_axis() {
                self.err(
                    "interactive-view/overlay-unsupported",
                    format!(
                        "{} overlay would sit on barHorizontal's category axis; \
                         use vLine/vBand on its value axis",
                        ov.overlay_tag()
                    ),
                    None,
                    (1, 1),
                );
                continue;
            }
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
        // The renderer reads `name` or `name[0]` / `name[1]` only; anything
        // else would silently hide the overlay, so it is an error here.
        let Some((name, index)) = parse_accessor(acc) else {
            self.err(
                "interactive-view/overlay-bad-accessor",
                format!(
                    "{tag} overlay ref `{acc}` must be a signal name or an interval endpoint `name[0]` / `name[1]`"
                ),
                None,
                self.locate(acc),
            );
            return;
        };
        if index.is_some_and(|i| i > 1) {
            self.err(
                "interactive-view/overlay-bad-accessor",
                format!("{tag} overlay ref `{acc}` may only index endpoint 0 or 1"),
                None,
                self.locate(acc),
            );
            return;
        }
        let indexed = index.is_some();
        let Some(&ty) = self.signals.get(name) else {
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

    /// A chart's `highlight` names a signal whose value picks the emphasised
    /// series. It must resolve, be a category-naming scalar (enum/string — the
    /// only signal kinds whose value can equal a series column/label), and sit
    /// on a multi-series mark (line/area/bar/scatter) where dimming means
    /// something. Anything else is an author mistake worth flagging, not a
    /// silent no-op.
    fn check_highlight(&mut self, sig: &str, mark: &ChartMark) {
        let Some(&ty) = self.signals.get(sig) else {
            self.err(
                "interactive-view/unknown-signal",
                format!("chart highlight references unknown signal `{sig}`"),
                None,
                self.locate(sig),
            );
            return;
        };
        if !matches!(ty, SignalType::Enum | SignalType::String) {
            self.err(
                "interactive-view/highlight-type",
                format!(
                    "chart highlight signal `{sig}` is {}; it must be enum or string \
                     (its value names the series to emphasise)",
                    ty.label()
                ),
                None,
                self.locate(sig),
            );
        }
        let multi = matches!(
            mark,
            ChartMark::Line { .. }
                | ChartMark::Area { .. }
                | ChartMark::Bar { .. }
                | ChartMark::Scatter { .. }
        );
        if !multi {
            self.err(
                "interactive-view/highlight-unsupported",
                format!(
                    "{} chart has no series to highlight; use line/area/bar/scatter",
                    mark.kind_tag()
                ),
                Some("highlight emphasises one of several series".into()),
                (1, 1),
            );
        }
    }

    /// A chart's `spotlight` names a signal whose value selects one x-CATEGORY;
    /// non-matching categories dim. Like `highlight` it must resolve and be an
    /// enum/string (its value equals a category cell), but it sits on the
    /// CATEGORICAL marks (bar/barHorizontal/pie/candlestick) whose x is a
    /// category — the widget-driven counterpart of click-to-select.
    fn check_spotlight(&mut self, sig: &str, mark: &ChartMark) {
        let Some(&ty) = self.signals.get(sig) else {
            self.err(
                "interactive-view/unknown-signal",
                format!("chart spotlight references unknown signal `{sig}`"),
                None,
                self.locate(sig),
            );
            return;
        };
        if !matches!(ty, SignalType::Enum | SignalType::String) {
            self.err(
                "interactive-view/spotlight-type",
                format!(
                    "chart spotlight signal `{sig}` is {}; it must be enum or string \
                     (its value names the category to spotlight)",
                    ty.label()
                ),
                None,
                self.locate(sig),
            );
        }
        let categorical = matches!(
            mark,
            ChartMark::Bar { .. }
                | ChartMark::BarHorizontal { .. }
                | ChartMark::Pie { .. }
                | ChartMark::Candlestick { .. }
        );
        if !categorical {
            self.err(
                "interactive-view/spotlight-unsupported",
                format!(
                    "{} chart has no category axis to spotlight; use bar/barHorizontal/pie/candlestick",
                    mark.kind_tag()
                ),
                Some("spotlight emphasises one category (a bar/candle), dimming the rest".into()),
                (1, 1),
            );
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
                } else if !self.widget_signals.contains(sig) {
                    // A derived/selection signal has no control to draw; the
                    // renderer would show an empty "This input has no widget." tile.
                    self.err(
                        "interactive-view/input-no-widget",
                        format!("input references signal `{sig}`, which declares no widget"),
                        Some(
                            "show a derived/selection value with a metric or an interpolation instead"
                                .into(),
                        ),
                        self.locate(sig),
                    );
                }
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
                if let Some(s) = step
                    && *s <= 0.0
                {
                    self.err(
                        "interactive-view/slider-step",
                        format!("slider `{owner}` step must be > 0"),
                        None,
                        self.locate(owner),
                    );
                }
            }
            _ => {}
        }

        if let Some(label) = widget_label(w)
            && label.chars().count() > MAX_LABEL_LEN
        {
            self.warn(
                "interactive-view/label-long",
                format!("widget label exceeds {MAX_LABEL_LEN} chars"),
                None,
                self.locate(label),
            );
        }
    }

    /// S3: every `{{accessor | filter(args) …}}` interpolation parses exactly as
    /// the renderer (`interpolate.ts`) reads it: the accessor is a declared
    /// signal (optionally indexed), and every filter is one it implements.
    /// Anything else would render a silent "—" or pass the value through.
    fn check_interpolations(&mut self, template: &str) {
        for inner in interpolation_tokens(template) {
            let at = self.locate(&format!("{{{{{inner}}}}}"));
            if let Err((rule, msg)) = self.check_interpolation(inner) {
                self.err(rule, msg, None, at);
            }
        }
    }

    fn check_interpolation(&self, inner: &str) -> Result<(), (&'static str, String)> {
        let parts = split_top(inner, '|');
        let accessor = parts[0].trim();
        let Some((name, index)) = parse_accessor(accessor) else {
            return Err((
                "interactive-view/interpolation-syntax",
                format!(
                    "interpolation `{{{{{inner}}}}}` must start with a signal name (optionally `name[0]`)"
                ),
            ));
        };
        let Some(&ty) = self.signals.get(name) else {
            return Err((
                "interactive-view/unknown-signal",
                format!("interpolation references unknown signal `{name}`"),
            ));
        };
        if let Some(i) = index {
            let ok = match ty {
                SignalType::IntervalNumber | SignalType::IntervalTemporal => i <= 1,
                SignalType::ArrayEnum => true,
                _ => false,
            };
            if !ok {
                return Err((
                    "interactive-view/interpolation-index",
                    format!(
                        "interpolation `{accessor}`: a {} signal {}",
                        ty.label(),
                        if ty.is_interval() {
                            "has only endpoints [0] and [1]"
                        } else {
                            "cannot be indexed"
                        }
                    ),
                ));
            }
        }
        for raw in &parts[1..] {
            let spec = raw.trim();
            let Some((filter, args)) = parse_filter(spec) else {
                return Err((
                    "interactive-view/interpolation-syntax",
                    format!("interpolation filter `{spec}` must be `name` or `name(args)`"),
                ));
            };
            if !INTERPOLATION_FILTERS.contains(&filter) {
                return Err((
                    "interactive-view/unknown-filter",
                    format!(
                        "unknown interpolation filter `{filter}`; use one of {}",
                        INTERPOLATION_FILTERS.join(", ")
                    ),
                ));
            }
            let arg_ok = matches!(
                (filter, args.as_slice()),
                (_, []) | ("round", [FilterArg::Num]) | ("join" | "date", [FilterArg::Str])
            );
            if !arg_ok {
                let want = if filter == "round" {
                    "one number (digits)"
                } else {
                    "one string"
                };
                return Err((
                    "interactive-view/interpolation-filter-args",
                    format!("interpolation filter `{spec}`: `{filter}` takes at most {want}"),
                ));
            }
        }
        Ok(())
    }

    /// A signal's `init` seeds the renderer's state verbatim (and is what a
    /// reset button snaps back to), so it must be a value of the signal's type
    /// and one its widget can display: within slider/stepper bounds, one of the
    /// declared options, no longer than `maxLength`. A `derived` signal ignores
    /// `init`, so it is not checked there.
    fn check_init(&mut self, name: &str, sig: &crate::interactive_view::model::Signal) {
        let Some(init) = &sig.init else {
            return;
        };
        if sig.derived.is_some() {
            return;
        }
        if let Err(why) = init_matches_type(init, sig.ty) {
            self.err(
                "interactive-view/init-type-mismatch",
                format!(
                    "signal `{name}` is {} but its init {init} {why}",
                    sig.ty.label()
                ),
                None,
                self.locate(name),
            );
            return;
        }
        if let Some(w) = &sig.widget
            && let Err(why) = init_fits_widget(init, w)
        {
            self.err(
                "interactive-view/init-out-of-range",
                format!("signal `{name}` init {init} {why}"),
                Some("the initial value must be one the widget can show and produce".into()),
                self.locate(name),
            );
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
        self.diags
            .push(diag(self.rel, at.0, at.1, Severity::Error, rule, msg, hint));
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

/// Whether a chart-selected column's type can feed a `from` signal of `ty`. The
/// click writes the raw cell value into the signal, so the kinds must line up (a
/// clicked category is a string → an `enum`/`string` signal).
fn selection_type_compatible(ct: ColumnType, ty: SignalType) -> bool {
    match ct {
        ColumnType::String => matches!(ty, SignalType::String | SignalType::Enum),
        ColumnType::Temporal => matches!(ty, SignalType::Temporal),
        ColumnType::Integer => matches!(ty, SignalType::Integer | SignalType::Number),
        ColumnType::Number => matches!(ty, SignalType::Number),
        ColumnType::Boolean => matches!(ty, SignalType::Boolean),
    }
}

/// A DAG node key (`sig:x` / `data:x`) rendered for a human. A dataset node is
/// tagged so a cycle path reads `region → dataset filtered → region`.
fn prettify_node(node: &str) -> String {
    match node.split_once(':') {
        Some(("data", n)) => format!("dataset {n}"),
        Some((_, n)) => n.to_string(),
        None => node.to_string(),
    }
}

/// The bare name behind a DAG node key (`sig:region` → `region`), for `locate`.
fn strip_node(node: &str) -> &str {
    node.split_once(':').map(|(_, n)| n).unwrap_or(node)
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

/// Parse a signal accessor exactly as the renderer's
/// `^([A-Za-z_]\w*)(?:\[(\d+)\])?$` does (after trimming): `band[0]` →
/// `("band", Some(0))`, `sharpe` → `("sharpe", None)`. `None` when malformed.
/// An index too large for `u64` saturates (it is out of range either way).
fn parse_accessor(acc: &str) -> Option<(&str, Option<u64>)> {
    let acc = acc.trim();
    let name_end = acc
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '_'))
        .map_or(acc.len(), |(i, _)| i);
    let name = &acc[..name_end];
    if !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    let rest = &acc[name_end..];
    if rest.is_empty() {
        return Some((name, None));
    }
    let digits = rest.strip_prefix('[')?.strip_suffix(']')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((name, Some(digits.parse().unwrap_or(u64::MAX))))
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

/// The inner text of each `{{ … }}` interpolation, found exactly as the
/// renderer's global `/\{\{([^}]*)\}\}/` regex finds them: the inner text holds
/// no `}`, and a `{{` that isn't closed that way is literal text.
fn interpolation_tokens(template: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            let start = i + 2;
            let end = template[start..]
                .find('}')
                .map_or(bytes.len(), |off| start + off);
            if end + 1 < bytes.len() && bytes[end + 1] == b'}' {
                out.push(&template[start..end]);
                i = end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Split on top-level `sep`, ignoring separators inside `'…'` / `"…"` — the
/// renderer's `splitTop`.
fn split_top(s: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let mut quote: Option<char> = None;
    let mut start = 0;
    for (i, ch) in s.char_indices() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch == sep => {
                out.push(&s[start..i]);
                start = i + ch.len_utf8();
            }
            None => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// One interpolation-filter argument as the renderer's `parseArgs` classifies
/// it: a quoted literal or a non-numeric bare word is a string; a finite
/// number is a number.
#[derive(Debug, PartialEq)]
enum FilterArg {
    Num,
    Str,
}

/// Parse a filter spec as the renderer's `^([A-Za-z_]\w*)\s*(?:\((.*)\))?$`
/// (where `.` excludes line terminators) into its name and arguments.
fn parse_filter(spec: &str) -> Option<(&str, Vec<FilterArg>)> {
    let name_end = spec
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(spec.len());
    let name = &spec[..name_end];
    if !name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    let rest = spec[name_end..].trim_start();
    if rest.is_empty() {
        return Some((name, Vec::new()));
    }
    let inside = rest.strip_prefix('(')?.strip_suffix(')')?;
    if inside.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let inside = inside.trim();
    if inside.is_empty() {
        return Some((name, Vec::new()));
    }
    let args = split_top(inside, ',')
        .into_iter()
        .map(|raw| {
            let a = raw.trim();
            let quoted = a.len() >= 2
                && ((a.starts_with('\'') && a.ends_with('\''))
                    || (a.starts_with('"') && a.ends_with('"')));
            match a.parse::<f64>() {
                Ok(n) if !quoted && n.is_finite() => FilterArg::Num,
                _ => FilterArg::Str,
            }
        })
        .collect();
    Some((name, args))
}

/// Whether a JSON `init` is a value of signal type `ty` (the shape the
/// renderer's widgets and expression evaluator read). The error completes the
/// sentence "its init X …".
fn init_matches_type(v: &serde_json::Value, ty: SignalType) -> Result<(), String> {
    use serde_json::Value;
    let temporal = |v: &Value| match v.as_str() {
        // An empty string is the renderer's "no date chosen yet".
        Some(s) => s.is_empty() || expr::iso_instant(s).is_some(),
        None => false,
    };
    let ok = match ty {
        SignalType::Number => v.is_number(),
        SignalType::Integer => v.as_f64().is_some_and(|n| n.fract() == 0.0),
        SignalType::Boolean => v.is_boolean(),
        SignalType::String => v.is_string(),
        SignalType::Temporal => temporal(v),
        SignalType::Enum => v.is_string() || v.is_number() || v.is_boolean(),
        SignalType::IntervalNumber => match v.as_array().map(Vec::as_slice) {
            Some([Value::Number(a), Value::Number(b)]) => {
                if a.as_f64() > b.as_f64() {
                    return Err("has its endpoints out of order".into());
                }
                true
            }
            _ => false,
        },
        SignalType::IntervalTemporal => match v.as_array().map(Vec::as_slice) {
            Some([a, b]) if temporal(a) && temporal(b) => {
                let (lo, hi) = (
                    a.as_str().and_then(expr::iso_instant),
                    b.as_str().and_then(expr::iso_instant),
                );
                if let (Some(lo), Some(hi)) = (lo, hi)
                    && lo > hi
                {
                    return Err("has its endpoints out of order".into());
                }
                true
            }
            _ => false,
        },
        SignalType::ArrayEnum => v.as_array().is_some_and(|xs| {
            xs.iter()
                .all(|x| x.is_string() || x.is_number() || x.is_boolean())
        }),
    };
    if ok {
        Ok(())
    } else {
        Err(match ty {
            SignalType::Temporal => {
                "is not an ISO-8601 date (YYYY-MM-DD, optionally with a time)".into()
            }
            SignalType::IntervalNumber => "is not a [lo, hi] pair of numbers".into(),
            SignalType::IntervalTemporal => "is not a [from, to] pair of ISO-8601 dates".into(),
            SignalType::ArrayEnum => "is not an array of option values".into(),
            other => format!("is not a {} value", other.label()),
        })
    }
}

/// Option-value equality as the renderer keys options (`JSON.stringify`), so
/// `1` and `1.0` are the same value.
fn option_value_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

/// Whether a type-correct `init` is a value widget `w` can show — within its
/// numeric/date bounds, among its options, within its length limit. The error
/// completes the sentence "signal `x` init X …".
fn init_fits_widget(v: &serde_json::Value, w: &Widget) -> Result<(), String> {
    let within = |n: f64, min: Option<f64>, max: Option<f64>| -> Result<(), String> {
        if min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m) {
            let show = |b: Option<f64>| b.map_or_else(|| "…".to_string(), |b| b.to_string());
            Err(format!(
                "is outside the widget's range {}..{}",
                show(min),
                show(max)
            ))
        } else {
            Ok(())
        }
    };
    let within_dates =
        |s: &str, min: &Option<String>, max: &Option<String>| -> Result<(), String> {
            let Some(t) = expr::iso_instant(s) else {
                return Ok(()); // "" (unset) — nothing to bound
            };
            let bound = |b: &Option<String>| b.as_deref().and_then(expr::iso_instant);
            if bound(min).is_some_and(|m| t < m) || bound(max).is_some_and(|m| t > m) {
                Err(format!(
                    "is outside the widget's date range {}..{}",
                    min.as_deref().unwrap_or("…"),
                    max.as_deref().unwrap_or("…")
                ))
            } else {
                Ok(())
            }
        };
    let in_options = |x: &serde_json::Value| -> Result<(), String> {
        if w.options().iter().any(|o| option_value_eq(&o.value, x)) {
            Ok(())
        } else {
            Err(format!("is not one of the widget's option values ({x})"))
        }
    };
    let pair = |v: &serde_json::Value| -> Vec<serde_json::Value> {
        v.as_array().cloned().unwrap_or_default()
    };
    match w {
        Widget::Slider { min, max, .. } => {
            within(v.as_f64().unwrap_or(0.0), Some(*min), Some(*max))
        }
        Widget::NumberInput { min, max, .. } => within(v.as_f64().unwrap_or(0.0), *min, *max),
        Widget::Stepper { min, max, .. } => within(
            v.as_f64().unwrap_or(0.0),
            min.map(|m| m as f64),
            max.map(|m| m as f64),
        ),
        Widget::RangeSlider { min, max, .. } => pair(v)
            .iter()
            .try_for_each(|e| within(e.as_f64().unwrap_or(0.0), Some(*min), Some(*max))),
        Widget::Segmented { .. } | Widget::RadioGroup { .. } | Widget::Select { .. } => {
            in_options(v)
        }
        Widget::MultiSelect { .. } | Widget::CheckboxGroup { .. } => {
            pair(v).iter().try_for_each(in_options)
        }
        Widget::TextInput { max_length, .. } => {
            // `maxLength` counts UTF-16 code units in the browser.
            let len = v.as_str().map_or(0, |s| s.encode_utf16().count());
            match max_length {
                Some(max) if len > *max as usize => {
                    Err(format!("is longer than the widget's maxLength {max}"))
                }
                _ => Ok(()),
            }
        }
        Widget::DatePicker { min, max, .. } => within_dates(v.as_str().unwrap_or(""), min, max),
        Widget::DateRange { min, max, .. } => pair(v)
            .iter()
            .try_for_each(|e| within_dates(e.as_str().unwrap_or(""), min, max)),
        Widget::Toggle { .. } | Widget::Button { .. } => Ok(()),
    }
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
    fn candlestick_valid_with_ma_and_alert_passes() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"ohlc":{"columns":{"t":"integer","open":"number","high":"number",
                 "low":"number","close":"number","ma":"number"},"values":[]}},
               "signals":{"alert":{"type":"number","init":100,
                 "widget":{"type":"slider","min":0,"max":200}}},
               "view":[{"block":"chart","data":"ohlc",
                 "mark":{"chart":"candlestick","x":{"column":"t"},"open":{"column":"open"},
                   "high":{"column":"high"},"low":{"column":"low"},"close":{"column":"close"},
                   "ma":[{"column":"ma","label":"MA20"}]},
                 "overlays":[{"overlay":"hLine","value":"alert","label":"alert"}]}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn candlestick_non_numeric_ohlc_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"ohlc":{"columns":{"t":"integer","open":"string","high":"number",
                 "low":"number","close":"number"},"values":[]}},
               "view":[{"block":"chart","data":"ohlc",
                 "mark":{"chart":"candlestick","x":{"column":"t"},"open":{"column":"open"},
                   "high":{"column":"high"},"low":{"column":"low"},"close":{"column":"close"}}}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/chart-type-mismatch"),
            "{d:?}"
        );
    }

    #[test]
    fn depth_valid_passes() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"book":{"columns":{"price":"number","bid":"number","ask":"number"},"values":[]}},
               "view":[{"block":"chart","data":"book",
                 "mark":{"chart":"depth","price":{"column":"price"},"bid":{"column":"bid"},"ask":{"column":"ask"}}}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn derived_dataset_cross_filter_passes() {
        // A global selector feeds a derived dataset that a chart reads — the
        // canonical "one signal filters every chart" linkage.
        let d = check(
            r#"{"interactiveView":1,
               "data":{
                 "sales":{"columns":{"region":"string","amount":"number"},
                   "values":[{"region":"North","amount":10},{"region":"South","amount":5}]},
                 "filtered":{"derived":"filter(sales, region == sel)"}},
               "signals":{"sel":{"type":"enum","init":"North",
                 "widget":{"type":"select","options":[
                   {"label":"North","value":"North"},{"label":"South","value":"South"}]}}},
               "view":[{"block":"chart","data":"filtered",
                 "mark":{"chart":"bar","x":{"column":"region"},"y":[{"column":"amount"}]}}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn derived_dataset_bad_column_rejected() {
        // A chart on a derived dataset validates against its INFERRED schema.
        let d = check(
            r#"{"interactiveView":1,
               "data":{
                 "sales":{"columns":{"region":"string","amount":"number"},"values":[]},
                 "filtered":{"derived":"filter(sales, amount > 0)"}},
               "view":[{"block":"chart","data":"filtered",
                 "mark":{"chart":"bar","x":{"column":"region"},"y":[{"column":"nope"}]}}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/unknown-column"),
            "{d:?}"
        );
    }

    #[test]
    fn derived_dataset_not_a_dataset_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"sales":{"columns":{"amount":"number"},"values":[]},
                 "bad":{"derived":"mean(sales.amount)"}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/derived-data-not-dataset"),
            "{d:?}"
        );
    }

    #[test]
    fn mixed_signal_dataset_cycle_rejected() {
        // signal s = count(d); dataset d = filter(base, x > s) — a cross-linkage
        // cycle spanning a signal and a dataset. Caught by the unified DAG.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"base":{"columns":{"x":"number"},"values":[]},
                 "d":{"derived":"filter(base, x > s)"}},
               "signals":{"s":{"type":"number","derived":"count(d)"}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/reactive-cycle"),
            "{d:?}"
        );
    }

    #[test]
    fn dataset_dataset_cycle_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"a":{"derived":"filter(b, x > 0)"},
                 "b":{"derived":"filter(a, x > 0)"}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/derived-data-error"),
            "{d:?}"
        );
    }

    #[test]
    fn name_collision_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"x":{"columns":{"v":"number"},"values":[]}},
               "signals":{"x":{"type":"number","init":0,
                 "widget":{"type":"slider","min":0,"max":1}}},"view":[]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/name-collision"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_selection_valid_passes() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"sales":{"columns":{"region":"string","amount":"number"},"values":[]}},
               "signals":{"sel":{"type":"string","from":{"chart":"bars","select":"region"}}},
               "view":[{"block":"chart","id":"bars","data":"sales",
                 "mark":{"chart":"bar","x":{"column":"region"},"y":[{"column":"amount"}]}}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn chart_selection_type_mismatch_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"sales":{"columns":{"region":"string","amount":"number"},"values":[]}},
               "signals":{"sel":{"type":"number","from":{"chart":"bars","select":"region"}}},
               "view":[{"block":"chart","id":"bars","data":"sales",
                 "mark":{"chart":"bar","x":{"column":"region"},"y":[{"column":"amount"}]}}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/selection-type-mismatch"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_selection_unsupported_mark_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "signals":{"sel":{"type":"number","from":{"chart":"ln","select":"t"}}},
               "view":[{"block":"chart","id":"ln","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]}}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/selection-unsupported"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_docked_controls_and_readouts_pass() {
        // A chart with its inputs (controls) and KPI chips (readouts) docked into
        // its own card — the widget⇄chart co-action in one block.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "signals":{"th":{"type":"number","init":10,
                 "widget":{"type":"slider","min":0,"max":100,"label":"threshold"}},
                 "hits":{"type":"number","derived":"count(filter(px, v > th).v)"}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]},
                 "overlays":[{"overlay":"hLine","value":"th"}],
                 "controls":[{"signal":"th"}],
                 "readouts":[{"label":"hits","value":"{{hits}}"}]}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn chart_docked_control_unknown_signal_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]},
                 "controls":[{"signal":"nope"}]}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/unknown-signal"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_docked_readout_unknown_signal_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]},
                 "readouts":[{"label":"x","value":"{{nope}}"}]}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/unknown-signal"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_highlight_enum_signal_passes() {
        // A segmented control's enum signal emphasises the matching series.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","a":"number","b":"number"},"values":[]}},
               "signals":{"pick":{"type":"enum","init":"a",
                 "widget":{"type":"segmented","options":[
                   {"label":"a","value":"a"},{"label":"b","value":"b"}]}}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},
                   "y":[{"column":"a"},{"column":"b"}]},
                 "controls":[{"signal":"pick"}],
                 "highlight":"pick"}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn chart_highlight_unknown_signal_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]},
                 "highlight":"nope"}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/unknown-signal"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_highlight_numeric_signal_rejected() {
        // A numeric signal can't name a series — must be enum/string.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "signals":{"n":{"type":"number","init":0,
                 "widget":{"type":"slider","min":0,"max":1}}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]},
                 "highlight":"n"}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/highlight-type"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_highlight_on_pie_rejected() {
        // pie has no series to dim.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"c":"string","v":"number"},"values":[]}},
               "signals":{"pick":{"type":"enum","init":"x",
                 "widget":{"type":"segmented","options":[{"label":"x","value":"x"}]}}},
               "view":[{"block":"chart","data":"px",
                 "mark":{"chart":"pie","category":{"column":"c"},"value":{"column":"v"}},
                 "highlight":"pick"}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/highlight-unsupported"),
            "{d:?}"
        );
    }

    #[test]
    fn bar_horizontal_vline_overlay_passes() {
        // A threshold vLine on a barHorizontal ranking — the value axis is
        // horizontal, so x = threshold is a cutoff line across the bars.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"rank":{"columns":{"name":"string","mom":"number"},"values":[]}},
               "signals":{"thr":{"type":"number","init":0,
                 "widget":{"type":"slider","min":-5,"max":15,"label":"threshold"}}},
               "view":[{"block":"chart","data":"rank",
                 "mark":{"chart":"barHorizontal","category":{"column":"name"},"value":{"column":"mom"}},
                 "overlays":[{"overlay":"vLine","value":"thr","label":"long cutoff"}],
                 "controls":[{"signal":"thr"}]}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn bar_horizontal_hline_overlay_rejected() {
        // hLine would land on barHorizontal's category axis — nonsensical.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"rank":{"columns":{"name":"string","mom":"number"},"values":[]}},
               "signals":{"thr":{"type":"number","init":0,
                 "widget":{"type":"slider","min":-5,"max":15}}},
               "view":[{"block":"chart","data":"rank",
                 "mark":{"chart":"barHorizontal","category":{"column":"name"},"value":{"column":"mom"}},
                 "overlays":[{"overlay":"hLine","value":"thr"}]}]}"#,
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

    #[test]
    fn chart_group_valid_passes() {
        // Two linked charts (price + obv) share one window range-slider control
        // and two readouts — the whole group validates like two charts + an input.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"bars":{"columns":{"t":"integer","price":"number","obv":"number"},
                 "values":[{"t":1,"price":100,"obv":0},{"t":2,"price":101,"obv":12}]},
                 "sel":{"derived":"filter(bars, t >= win[0] && t <= win[1])"}},
               "signals":{"win":{"type":"interval<number>","init":[1,2],
                 "widget":{"type":"rangeSlider","min":1,"max":2,"step":1}},
                 "net":{"type":"number","derived":"sum(sel.price)"}},
               "view":[{"block":"chartGroup","title":"OBV divergence","charts":[
                 {"data":"bars","title":"Price",
                  "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"price"}]},
                  "overlays":[{"overlay":"vBand","from":"win[0]","to":"win[1]"}]},
                 {"data":"bars","title":"OBV",
                  "mark":{"chart":"area","x":{"column":"t"},"y":[{"column":"obv"}]},
                  "overlays":[{"overlay":"vBand","from":"win[0]","to":"win[1]"}]}],
                 "controls":[{"signal":"win"}],
                 "readouts":[{"label":"net","value":"{{net}}"}]}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn panel_groups_children_and_validates_them() {
        // a panel wraps linked blocks in a card; its children still validate (an
        // unknown-signal interpolation inside is caught).
        let ok = check(
            r#"{"interactiveView":1,
               "signals":{"g":{"type":"enum","init":"a",
                 "widget":{"type":"segmented","options":[{"label":"a","value":"a"}]}}},
               "view":[{"block":"panel","title":"pick","children":[
                 {"block":"input","signal":"g"},
                 {"block":"section","md":"picked {{g}}"}]}]}"#,
        );
        assert!(ok.is_empty(), "unexpected: {ok:?}");
        let bad = check(
            r#"{"interactiveView":1,"view":[{"block":"panel","children":[
                 {"block":"section","md":"{{nope}}"}]}]}"#,
        );
        assert!(
            rules(&bad).contains(&"interactive-view/unknown-signal"),
            "{bad:?}"
        );
    }

    #[test]
    fn chart_spotlight_on_candlestick_passes() {
        // a select drives which candle lights up (category spotlight on candlestick).
        let d = check(
            r#"{"interactiveView":1,
               "data":{"c":{"columns":{"t":"string","open":"number","high":"number","low":"number","close":"number"},"values":[]}},
               "signals":{"pick":{"type":"enum","init":"a",
                 "widget":{"type":"select","options":[{"label":"a","value":"a"}]}}},
               "view":[{"block":"chart","data":"c","spotlight":"pick",
                 "mark":{"chart":"candlestick","x":{"column":"t"},"open":{"column":"open"},
                   "high":{"column":"high"},"low":{"column":"low"},"close":{"column":"close"}}}]}"#,
        );
        assert!(d.is_empty(), "unexpected: {d:?}");
    }

    #[test]
    fn chart_spotlight_on_line_rejected() {
        // a line has no category axis to spotlight.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"integer","v":"number"},"values":[]}},
               "signals":{"pick":{"type":"string","init":"a",
                 "widget":{"type":"textInput","maxLength":4}}},
               "view":[{"block":"chart","data":"px","spotlight":"pick",
                 "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]}}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/spotlight-unsupported"),
            "{d:?}"
        );
    }

    #[test]
    fn chart_group_empty_rejected() {
        let d = check(r#"{"interactiveView":1,"view":[{"block":"chartGroup","charts":[]}]}"#);
        assert!(
            rules(&d).contains(&"interactive-view/chart-group-empty"),
            "{d:?}"
        );
    }

    #[test]
    fn input_on_signal_without_widget_rejected() {
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"number","v":"number"},"values":[]}},
               "signals":{"n":{"type":"number","derived":"count(px)"}},
               "view":[{"block":"input","signal":"n"},
                 {"block":"chart","data":"px",
                  "mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"v"}]},
                  "controls":[{"signal":"n"}]}]}"#,
        );
        assert_eq!(
            rules(&d),
            vec![
                "interactive-view/input-no-widget",
                "interactive-view/input-no-widget"
            ],
            "{d:?}"
        );
    }

    fn doc_with_signal(signal: &str) -> Vec<Diagnostic> {
        check(&format!(
            r#"{{"interactiveView":1,"signals":{{"s":{signal}}},"view":[]}}"#
        ))
    }

    #[test]
    fn init_must_match_signal_type() {
        for (sig, ok) in [
            (
                r#"{"type":"number","init":2,"widget":{"type":"slider","min":0,"max":5}}"#,
                true,
            ),
            (
                r#"{"type":"number","init":"2","widget":{"type":"slider","min":0,"max":5}}"#,
                false,
            ),
            (
                r#"{"type":"integer","init":2.5,"widget":{"type":"stepper"}}"#,
                false,
            ),
            (
                r#"{"type":"integer","init":3,"widget":{"type":"stepper"}}"#,
                true,
            ),
            (
                r#"{"type":"boolean","init":"yes","widget":{"type":"toggle"}}"#,
                false,
            ),
            (
                r#"{"type":"temporal","init":"2024-01-05","widget":{"type":"datePicker"}}"#,
                true,
            ),
            (
                r#"{"type":"temporal","init":"","widget":{"type":"datePicker"}}"#,
                true,
            ),
            (
                r#"{"type":"temporal","init":"Jan 5","widget":{"type":"datePicker"}}"#,
                false,
            ),
            (
                r#"{"type":"interval<number>","init":[1,4],"widget":{"type":"rangeSlider","min":0,"max":5}}"#,
                true,
            ),
            (
                r#"{"type":"interval<number>","init":[4,1],"widget":{"type":"rangeSlider","min":0,"max":5}}"#,
                false,
            ),
            (
                r#"{"type":"interval<number>","init":3,"widget":{"type":"rangeSlider","min":0,"max":5}}"#,
                false,
            ),
            (
                r#"{"type":"interval<temporal>","init":["2024-01-01","2024-02-01"],"widget":{"type":"dateRange"}}"#,
                true,
            ),
            (
                r#"{"type":"array<enum>","init":{"a":1},"widget":{"type":"multiSelect","options":[]}}"#,
                false,
            ),
        ] {
            let d = doc_with_signal(sig);
            assert_eq!(d.is_empty(), ok, "{sig}: {d:?}");
            if !ok {
                assert!(
                    rules(&d)
                        .iter()
                        .all(|r| *r == "interactive-view/init-type-mismatch"),
                    "{sig}: {d:?}"
                );
            }
        }
    }

    #[test]
    fn init_must_fit_widget() {
        for (sig, ok) in [
            (
                r#"{"type":"number","init":9,"widget":{"type":"slider","min":0,"max":5}}"#,
                false,
            ),
            (
                r#"{"type":"number","init":-1,"widget":{"type":"numberInput","min":0}}"#,
                false,
            ),
            (
                r#"{"type":"number","init":-1,"widget":{"type":"numberInput"}}"#,
                true,
            ),
            (
                r#"{"type":"integer","init":11,"widget":{"type":"stepper","min":0,"max":10}}"#,
                false,
            ),
            (
                r#"{"type":"interval<number>","init":[1,6],"widget":{"type":"rangeSlider","min":0,"max":5}}"#,
                false,
            ),
            (
                r#"{"type":"enum","init":"c","widget":{"type":"select","options":[{"label":"A","value":"a"}]}}"#,
                false,
            ),
            (
                r#"{"type":"enum","init":1,"widget":{"type":"segmented","options":[{"label":"One","value":1.0}]}}"#,
                true,
            ),
            (
                r#"{"type":"array<enum>","init":["a","z"],"widget":{"type":"checkboxGroup","options":[{"label":"A","value":"a"}]}}"#,
                false,
            ),
            (
                r#"{"type":"array<enum>","init":["a"],"widget":{"type":"checkboxGroup","options":[{"label":"A","value":"a"}]}}"#,
                true,
            ),
            (
                r#"{"type":"string","init":"hello","widget":{"type":"textInput","maxLength":3}}"#,
                false,
            ),
            (
                r#"{"type":"temporal","init":"2023-12-31","widget":{"type":"datePicker","min":"2024-01-01"}}"#,
                false,
            ),
            (
                r#"{"type":"interval<temporal>","init":["2024-01-01","2025-01-01"],"widget":{"type":"dateRange","max":"2024-06-30"}}"#,
                false,
            ),
        ] {
            let d = doc_with_signal(sig);
            assert_eq!(d.is_empty(), ok, "{sig}: {d:?}");
            if !ok {
                assert_eq!(
                    rules(&d),
                    vec!["interactive-view/init-out-of-range"],
                    "{sig}"
                );
            }
        }
    }

    #[test]
    fn overlay_accessor_must_match_renderer_grammar() {
        for (acc, rule) in [
            ("band[0]", None),
            (" band[1] ", None),
            ("band[2]", Some("interactive-view/overlay-bad-accessor")),
            ("band[0]x", Some("interactive-view/overlay-bad-accessor")),
            ("band [0]", Some("interactive-view/overlay-bad-accessor")),
            ("band[a]", Some("interactive-view/overlay-bad-accessor")),
            ("band[0", Some("interactive-view/overlay-bad-accessor")),
            ("1band", Some("interactive-view/overlay-bad-accessor")),
            ("band", Some("interactive-view/overlay-type-mismatch")),
        ] {
            let d = check(&format!(
                r#"{{"interactiveView":1,
                   "data":{{"px":{{"columns":{{"t":"number","v":"number"}},"values":[]}}}},
                   "signals":{{"band":{{"type":"interval<number>","init":[2,8],
                     "widget":{{"type":"rangeSlider","min":0,"max":10}}}}}},
                   "view":[{{"block":"chart","data":"px",
                     "mark":{{"chart":"line","x":{{"column":"t"}},"y":[{{"column":"v"}}]}},
                     "overlays":[{{"overlay":"vLine","value":"{acc}"}}]}}]}}"#
            ));
            assert_eq!(
                rules(&d),
                rule.into_iter().collect::<Vec<_>>(),
                "{acc}: {d:?}"
            );
        }
    }

    #[test]
    fn interpolation_grammar_matches_renderer() {
        let doc = |md: &str| {
            check(&format!(
                r#"{{"interactiveView":1,
                   "signals":{{"x":{{"type":"number","init":1,"widget":{{"type":"slider","min":0,"max":2}}}},
                     "band":{{"type":"interval<number>","init":[0,1],"widget":{{"type":"rangeSlider","min":0,"max":2}}}},
                     "tags":{{"type":"array<enum>","init":[],"widget":{{"type":"multiSelect","options":[]}}}},
                     "day":{{"type":"temporal","init":"2024-01-01","widget":{{"type":"datePicker"}}}}}},
                   "view":[{{"block":"section","md":{md:?}}}]}}"#
            ))
        };
        for (md, rule) in [
            ("{{x}} and {{ x | round(2) }}", None),
            ("{{band[1] | round}} {{tags[3] | join(' / ')}}", None),
            ("{{day | date('YYYY-MM-DD')}} {{day|date}}", None),
            ("{{ x | round(2) | join }}", None),
            ("literal {{a}b}} braces", None),
            ("{{nope}}", Some("interactive-view/unknown-signal")),
            ("{{}}", Some("interactive-view/interpolation-syntax")),
            ("{{x + 1}}", Some("interactive-view/interpolation-syntax")),
            ("{{x.y}}", Some("interactive-view/interpolation-syntax")),
            ("{{x[0]}}", Some("interactive-view/interpolation-index")),
            ("{{band[2]}}", Some("interactive-view/interpolation-index")),
            ("{{x | fmt}}", Some("interactive-view/unknown-filter")),
            (
                "{{x | round(2}}",
                Some("interactive-view/interpolation-syntax"),
            ),
            ("{{x | }}", Some("interactive-view/interpolation-syntax")),
            (
                "{{x | round('a')}}",
                Some("interactive-view/interpolation-filter-args"),
            ),
            (
                "{{x | round(1, 2)}}",
                Some("interactive-view/interpolation-filter-args"),
            ),
            (
                "{{tags | join(2)}}",
                Some("interactive-view/interpolation-filter-args"),
            ),
        ] {
            let d = doc(md);
            assert_eq!(
                rules(&d),
                rule.into_iter().collect::<Vec<_>>(),
                "{md}: {d:?}"
            );
        }
    }

    #[test]
    fn histogram_bins_are_bounded() {
        let doc = |bins: u32| {
            check(&format!(
                r#"{{"interactiveView":1,
                   "data":{{"r":{{"columns":{{"v":"number"}},"values":[]}}}},
                   "view":[{{"block":"chart","data":"r",
                     "mark":{{"chart":"histogram","value":{{"column":"v"}},"bins":{bins}}}}}]}}"#
            ))
        };
        assert!(doc(1).is_empty());
        assert!(doc(100).is_empty());
        assert_eq!(rules(&doc(0)), vec!["interactive-view/chart-bins"]);
        assert_eq!(rules(&doc(101)), vec!["interactive-view/chart-bins"]);
        assert_eq!(
            rules(&doc(4_000_000_000)),
            vec!["interactive-view/chart-bins"]
        );
    }

    #[test]
    fn chart_group_member_bad_column_rejected() {
        // A member chart validates like a standalone chart — a missing column fails.
        let d = check(
            r#"{"interactiveView":1,
               "data":{"px":{"columns":{"t":"integer","v":"number"},"values":[]}},
               "view":[{"block":"chartGroup","charts":[
                 {"data":"px","mark":{"chart":"line","x":{"column":"t"},"y":[{"column":"nope"}]}}]}]}"#,
        );
        assert!(
            rules(&d).contains(&"interactive-view/unknown-column"),
            "{d:?}"
        );
    }
}
