//! The Interactive View IR — the serde AST for a `*.interactive-view.json`
//! document (or a ` ```interactive-view ` fence).
//!
//! Parse-don't-validate: **structural** validity is whatever deserializes into
//! these types. Everything *semantic* (references resolve, types line up, the
//! reactive graph is a DAG, layout preserves the fit invariant) is the
//! `InteractiveViewValidator`'s job — see `crate::check::interactive_view` and
//! `docs/design/interactive-view.md`. The renderer consumes the same shape, so
//! "the checker's accepted language == the renderer's domain" holds by keeping
//! this one AST authoritative (TS types are generated from it).
//!
//! The catalog is a **closed set** of tagged enums (`Widget`, `Block`,
//! `SignalType`): adding a widget/block is one variant here + one checker arm +
//! one web component, and nothing else moves. That closedness is what makes the
//! soundness guarantee tractable.

use std::collections::BTreeMap;

use serde::Deserialize;

/// A whole Interactive View document.
#[derive(Debug, Clone, Deserialize)]
pub struct Document {
    /// Schema major version; the renderer refuses an unknown major.
    #[serde(rename = "interactiveView")]
    pub version: u32,
    /// Named datasets (small schema here; big rows live in rustfs by `source`).
    #[serde(default)]
    pub data: BTreeMap<String, DataSet>,
    /// The reactive signal graph — the single source of mutable state.
    #[serde(default)]
    pub signals: BTreeMap<String, Signal>,
    /// The ordered, Block-Kit-style view. Mobile-first single column.
    #[serde(default)]
    pub view: Vec<Block>,
}

impl Document {
    /// Parse a document from its JSON source. A structural parse error is the
    /// first thing the checker reports (it means the file is not even shaped
    /// like an Interactive View).
    pub fn parse(source: &str) -> Result<Document, serde_json::Error> {
        serde_json::from_str(source)
    }
}

// ── data ────────────────────────────────────────────────────────────────────

/// A named dataset. Declares its column schema (checked against, and — at sync
/// — verified to match the real bytes). Rows come from `source` (an absolute
/// content path, big data) or inline `values` (tiny data, byte-budgeted).
#[derive(Debug, Clone, Deserialize)]
pub struct DataSet {
    pub columns: BTreeMap<String, ColumnType>,
    /// Absolute *content* path (`/`-rooted, no `.`/`..`), never a host FS path.
    #[serde(default)]
    pub source: Option<String>,
    /// Inline rows (each an object keyed by column name). Only allowed under a
    /// small byte budget; large data must use `source`.
    #[serde(default)]
    pub values: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    Number,
    Integer,
    String,
    Boolean,
    Temporal,
}

// ── signals ──────────────────────────────────────────────────────────────────

/// A reactive signal. Declared once with a `type` and — semantically (checked,
/// not enforced by serde) — **exactly one** source: a `widget`, a chart
/// selection (`from`), or a `derived` expression.
#[derive(Debug, Clone, Deserialize)]
pub struct Signal {
    #[serde(rename = "type")]
    pub ty: SignalType,
    #[serde(default)]
    pub init: Option<serde_json::Value>,
    #[serde(default)]
    pub widget: Option<Widget>,
    /// Written by a chart selection (brush/click).
    #[serde(default)]
    pub from: Option<SelectionSource>,
    /// A total expression over other signals & datasets (a Pluto cell). Source
    /// text; parsed & type-checked by `crate::interactive_view::expr`.
    #[serde(default)]
    pub derived: Option<String>,
}

/// The closed set of signal types. `enum` carries no inline value-type here —
/// its domain is the widget's `options`. `interval<T>` is a `[lo, hi]` pair;
/// `array<T>` a multi-select list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum SignalType {
    #[serde(rename = "number")]
    Number,
    #[serde(rename = "integer")]
    Integer,
    #[serde(rename = "boolean")]
    Boolean,
    #[serde(rename = "string")]
    String,
    #[serde(rename = "temporal")]
    Temporal,
    #[serde(rename = "enum")]
    Enum,
    #[serde(rename = "interval<number>")]
    IntervalNumber,
    #[serde(rename = "interval<temporal>")]
    IntervalTemporal,
    #[serde(rename = "array<enum>")]
    ArrayEnum,
}

impl SignalType {
    pub fn is_numeric(self) -> bool {
        matches!(self, SignalType::Number | SignalType::Integer)
    }
    /// `true` when the signal reads as an ordered pair `x[0]`, `x[1]`.
    pub fn is_interval(self) -> bool {
        matches!(
            self,
            SignalType::IntervalNumber | SignalType::IntervalTemporal
        )
    }
    pub fn label(self) -> &'static str {
        match self {
            SignalType::Number => "number",
            SignalType::Integer => "integer",
            SignalType::Boolean => "boolean",
            SignalType::String => "string",
            SignalType::Temporal => "temporal",
            SignalType::Enum => "enum",
            SignalType::IntervalNumber => "interval<number>",
            SignalType::IntervalTemporal => "interval<temporal>",
            SignalType::ArrayEnum => "array<enum>",
        }
    }
}

/// Which chart selection writes a signal.
#[derive(Debug, Clone, Deserialize)]
pub struct SelectionSource {
    /// The `id` of the target `chart` block.
    pub chart: String,
    /// The Vega `param` name (a `select` param) that drives it.
    pub select: String,
}

// ── widgets (open registry, closed enum) ─────────────────────────────────────

/// The v1 widget catalog. Adding a widget = one variant here + one checker arm
/// (`output_type` + bounds) + one web component. `#[serde(tag = "type")]` keys
/// each on its `type` string.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Widget {
    Slider {
        min: f64,
        max: f64,
        #[serde(default)]
        step: Option<f64>,
        #[serde(default)]
        label: Option<String>,
    },
    RangeSlider {
        min: f64,
        max: f64,
        #[serde(default)]
        step: Option<f64>,
        #[serde(default)]
        label: Option<String>,
    },
    NumberInput {
        #[serde(default)]
        min: Option<f64>,
        #[serde(default)]
        max: Option<f64>,
        #[serde(default)]
        step: Option<f64>,
        #[serde(default)]
        label: Option<String>,
    },
    Stepper {
        #[serde(default)]
        min: Option<i64>,
        #[serde(default)]
        max: Option<i64>,
        #[serde(default)]
        label: Option<String>,
    },
    Toggle {
        #[serde(default)]
        label: Option<String>,
    },
    Segmented {
        options: Vec<Opt>,
        #[serde(default)]
        label: Option<String>,
    },
    RadioGroup {
        options: Vec<Opt>,
        #[serde(default)]
        label: Option<String>,
    },
    Select {
        options: Vec<Opt>,
        #[serde(default)]
        label: Option<String>,
    },
    MultiSelect {
        options: Vec<Opt>,
        #[serde(default)]
        label: Option<String>,
    },
    CheckboxGroup {
        options: Vec<Opt>,
        #[serde(default)]
        label: Option<String>,
    },
    TextInput {
        #[serde(rename = "maxLength", default)]
        max_length: Option<u32>,
        #[serde(default)]
        label: Option<String>,
    },
    DatePicker {
        #[serde(default)]
        min: Option<String>,
        #[serde(default)]
        max: Option<String>,
        #[serde(default)]
        label: Option<String>,
    },
    DateRange {
        #[serde(default)]
        min: Option<String>,
        #[serde(default)]
        max: Option<String>,
        #[serde(default)]
        label: Option<String>,
    },
    Button {
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        action: Option<ButtonAction>,
    },
}

impl Widget {
    /// The kebab `type` tag, for diagnostics.
    pub fn type_tag(&self) -> &'static str {
        match self {
            Widget::Slider { .. } => "slider",
            Widget::RangeSlider { .. } => "rangeSlider",
            Widget::NumberInput { .. } => "numberInput",
            Widget::Stepper { .. } => "stepper",
            Widget::Toggle { .. } => "toggle",
            Widget::Segmented { .. } => "segmented",
            Widget::RadioGroup { .. } => "radioGroup",
            Widget::Select { .. } => "select",
            Widget::MultiSelect { .. } => "multiSelect",
            Widget::CheckboxGroup { .. } => "checkboxGroup",
            Widget::TextInput { .. } => "textInput",
            Widget::DatePicker { .. } => "datePicker",
            Widget::DateRange { .. } => "dateRange",
            Widget::Button { .. } => "button",
        }
    }

    /// The signal type this widget writes — the heart of the S4 type check.
    /// `None` for a momentary control (`button`) that stores no value.
    pub fn output_type(&self) -> Option<SignalType> {
        Some(match self {
            Widget::Slider { .. } | Widget::NumberInput { .. } => SignalType::Number,
            Widget::Stepper { .. } => SignalType::Integer,
            Widget::Toggle { .. } => SignalType::Boolean,
            Widget::TextInput { .. } => SignalType::String,
            Widget::DatePicker { .. } => SignalType::Temporal,
            Widget::RangeSlider { .. } => SignalType::IntervalNumber,
            Widget::DateRange { .. } => SignalType::IntervalTemporal,
            Widget::Segmented { .. } | Widget::RadioGroup { .. } | Widget::Select { .. } => {
                SignalType::Enum
            }
            Widget::MultiSelect { .. } | Widget::CheckboxGroup { .. } => SignalType::ArrayEnum,
            Widget::Button { .. } => return None,
        })
    }

    /// Options, for the widgets that carry a choice list (else empty).
    pub fn options(&self) -> &[Opt] {
        match self {
            Widget::Segmented { options, .. }
            | Widget::RadioGroup { options, .. }
            | Widget::Select { options, .. }
            | Widget::MultiSelect { options, .. }
            | Widget::CheckboxGroup { options, .. } => options,
            _ => &[],
        }
    }
}

/// One choice in a `segmented`/`select`/… widget.
#[derive(Debug, Clone, Deserialize)]
pub struct Opt {
    pub label: String,
    pub value: serde_json::Value,
}

/// A `button`'s declarative action. Kept total & side-effect-free: `reset`
/// snaps the named signals back to their `init`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ButtonAction {
    #[serde(default)]
    pub reset: Vec<String>,
}

// ── view blocks (open registry, closed enum) ─────────────────────────────────

/// The v1 block catalog, keyed on `block`. Layout blocks (`stack`, `columns`,
/// `tabs`) nest `children`; display/input blocks are leaves.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "block", rename_all = "camelCase")]
pub enum Block {
    /// Markdown prose with `{{signal | fmt}}` interpolation.
    Section { md: String },
    /// A single KPI tile.
    Metric(Metric),
    /// An auto-fit grid of KPI tiles.
    MetricGroup { items: Vec<Metric> },
    /// A callout/admonition.
    Callout {
        #[serde(default)]
        kind: CalloutKind,
        md: String,
    },
    /// A Vega-Lite chart (Phase 2 renders it; the AST models it now). `vega`
    /// stays a raw value until the profile subset is modelled.
    Chart {
        #[serde(default)]
        id: Option<String>,
        data: String,
        vega: serde_json::Value,
    },
    /// A data table over a dataset (Phase 3).
    Table {
        data: String,
        #[serde(default)]
        columns: Option<Vec<String>>,
    },
    /// An input control: render the widget declared on `signal`, or a standalone
    /// `widget` (e.g. a `button`, whose `signal` is null).
    Input {
        #[serde(default)]
        signal: Option<String>,
        #[serde(default)]
        widget: Option<Widget>,
    },
    /// Vertical layout; children always get full width (always P-safe).
    Stack { children: Vec<Block> },
    /// Multi-column on wide screens; auto-collapses to a stack on narrow when
    /// `collapse` (the default). The checker forbids `collapse:false` unless the
    /// columns provably fit `W_min`.
    Columns {
        #[serde(default = "default_true")]
        collapse: bool,
        children: Vec<Block>,
    },
    /// Tabs on wide, accordion/swipe on narrow (renderer decides).
    Tabs { items: Vec<Tab> },
}

fn default_true() -> bool {
    true
}

impl Block {
    pub fn block_tag(&self) -> &'static str {
        match self {
            Block::Section { .. } => "section",
            Block::Metric(_) => "metric",
            Block::MetricGroup { .. } => "metricGroup",
            Block::Callout { .. } => "callout",
            Block::Chart { .. } => "chart",
            Block::Table { .. } => "table",
            Block::Input { .. } => "input",
            Block::Stack { .. } => "stack",
            Block::Columns { .. } => "columns",
            Block::Tabs { .. } => "tabs",
        }
    }
}

/// A KPI tile. `value` is an interpolation template (`"{{sharpe}}"`); `format`
/// is a numeral.js-style pattern applied by the renderer.
#[derive(Debug, Clone, Deserialize)]
pub struct Metric {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub audio: Option<AudioSpec>,
}

/// Per-block audio intent. `narrate` asks sync to pre-generate read-aloud;
/// unreachable/ungeneratable audio is `skippable` (never blocks the block).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AudioSpec {
    #[serde(default)]
    pub narrate: bool,
    #[serde(default)]
    pub skippable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CalloutKind {
    #[default]
    Note,
    Tip,
    Warning,
    Info,
}

/// One tab: a title plus its own nested block list.
#[derive(Debug, Clone, Deserialize)]
pub struct Tab {
    pub title: String,
    pub children: Vec<Block>,
}
