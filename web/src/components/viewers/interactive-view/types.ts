// TS mirror of the Rust IR AST (`src/interactive_view/model.rs`). The tag
// strings and field names match the serde attributes exactly, so a document
// that deserializes on the Rust side shapes identically here. Adding a
// widget/block variant is one arm there + one arm in `widgets.tsx`/`blocks.tsx`
// here — the exhaustive dispatch (a `never` default) makes a missing arm a
// compile error, which is the closed-catalog soundness contract.

/** `ColumnType` — serde `rename_all = "lowercase"`. */
export type ColumnType =
  | "number"
  | "integer"
  | "string"
  | "boolean"
  | "temporal";

/** `SignalType` — serde per-variant renames (note the `interval<…>` / `array<…>`
 *  spellings that are literal tag strings, not TS generics). */
export type SignalType =
  | "number"
  | "integer"
  | "boolean"
  | "string"
  | "temporal"
  | "enum"
  | "interval<number>"
  | "interval<temporal>"
  | "array<enum>";

/** A named dataset: rows via `source` (big data), inline `values` (tiny data),
 *  or `derived` (a `filter(...)` transform of other datasets/signals, recomputed
 *  reactively). A derived dataset's `columns` are inferred, so it omits them. */
export interface DataSet {
  columns?: Record<string, ColumnType>;
  source?: string;
  values?: unknown[];
  derived?: string;
}

/** One choice in a `segmented`/`select`/… widget. `value` is a raw JSON value
 *  (number, string, boolean) — the signal stores it verbatim. */
export interface Opt {
  label: string;
  value: unknown;
}

/** A `button`'s declarative action: `reset` snaps the named signals to `init`. */
export interface ButtonAction {
  reset: string[];
}

/** The v1 widget catalog — `#[serde(tag = "type", rename_all = "camelCase")]`. */
export type Widget =
  | { type: "slider"; min: number; max: number; step?: number; label?: string }
  | {
    type: "rangeSlider";
    min: number;
    max: number;
    step?: number;
    label?: string;
  }
  | {
    type: "numberInput";
    min?: number;
    max?: number;
    step?: number;
    label?: string;
  }
  | { type: "stepper"; min?: number; max?: number; label?: string }
  | { type: "toggle"; label?: string }
  | { type: "segmented"; options: Opt[]; label?: string }
  | { type: "radioGroup"; options: Opt[]; label?: string }
  | { type: "select"; options: Opt[]; label?: string }
  | { type: "multiSelect"; options: Opt[]; label?: string }
  | { type: "checkboxGroup"; options: Opt[]; label?: string }
  | { type: "textInput"; maxLength?: number; label?: string }
  | { type: "datePicker"; min?: string; max?: string; label?: string }
  | { type: "dateRange"; min?: string; max?: string; label?: string }
  | { type: "button"; label?: string; action?: ButtonAction };

/** The discriminant strings of {@link Widget}. */
export type WidgetType = Widget["type"];

/** Which chart selection writes a signal (Phase 2 wires it; modelled now). */
export interface SelectionSource {
  chart: string;
  select: string;
}

/** An encoding channel bound to a dataset column, with an optional display
 *  label. No colour/format — colours come from the theme palette (V1). */
export interface ChartField {
  column: string;
  label?: string;
}

/** The v1 chart catalog — `#[serde(tag = "chart", rename_all = "camelCase")]`.
 *  Trend (line/area), comparison (bar/barHorizontal), composition (pie),
 *  correlation (scatter), distribution (histogram). */
export type ChartMark =
  | { chart: "line"; x: ChartField; y: ChartField[]; curved?: boolean }
  | { chart: "area"; x: ChartField; y: ChartField[]; stacked?: boolean }
  | { chart: "bar"; x: ChartField; y: ChartField[]; stacked?: boolean }
  | { chart: "barHorizontal"; category: ChartField; value: ChartField }
  | { chart: "pie"; category: ChartField; value: ChartField; donut?: boolean }
  | {
    chart: "scatter";
    x: ChartField;
    y: ChartField;
    size?: ChartField;
    series?: ChartField;
  }
  | { chart: "histogram"; value: ChartField; bins?: number }
  | {
    chart: "candlestick";
    x: ChartField;
    open: ChartField;
    high: ChartField;
    low: ChartField;
    close: ChartField;
    ma?: ChartField[];
  }
  | {
    chart: "volume";
    x: ChartField;
    value: ChartField;
    open?: ChartField;
    close?: ChartField;
  }
  | { chart: "depth"; price: ChartField; bid: ChartField; ask: ChartField };

/** The discriminant strings of {@link ChartMark}. */
export type ChartKind = ChartMark["chart"];

/** A reactive overlay — a reference line/band whose position tracks a signal
 *  (`value`/`from`/`to` are signal accessors: `name` or `name[0]`/`name[1]`). */
export type Overlay =
  | { overlay: "hLine"; value: string; label?: string }
  | { overlay: "vLine"; value: string; label?: string }
  | { overlay: "hBand"; from: string; to: string; label?: string }
  | { overlay: "vBand"; from: string; to: string; label?: string };

/** A reactive signal: a `type` plus exactly one source (`widget` | `from` |
 *  `derived`), all optional in the shape (the Rust checker enforces "exactly
 *  one"). */
export interface Signal {
  type: SignalType;
  init?: unknown;
  widget?: Widget;
  from?: SelectionSource;
  derived?: string;
}

/** A control docked into a chart card (`chart.controls`). Same shape as an
 *  `input` block: a `signal` (render its declared widget) or a standalone
 *  `widget`. */
export interface ChartControl {
  signal?: string | null;
  widget?: Widget;
}

export type CalloutKind = "note" | "tip" | "warning" | "info";

/** Per-block audio intent (Phase 4 wires it). */
export interface AudioSpec {
  narrate?: boolean;
  skippable?: boolean;
}

/** A KPI tile. `value` is an interpolation template; `format` is a numeral.js
 *  style pattern applied by the renderer. */
export interface Metric {
  label: string;
  value: string;
  format?: string;
  audio?: AudioSpec;
}

/** One tab: a title plus its own nested block list. */
export interface Tab {
  title: string;
  children: Block[];
}

/** The v1 block catalog — `#[serde(tag = "block", rename_all = "camelCase")]`.
 *  `metric` is a newtype variant over {@link Metric}, so its fields sit inline
 *  next to the `block` tag (internally-tagged serde flattening). */
export type Block =
  | { block: "section"; md: string }
  | ({ block: "metric" } & Metric)
  | { block: "metricGroup"; items: Metric[] }
  | { block: "callout"; kind?: CalloutKind; md: string }
  | {
    block: "chart";
    id?: string;
    data: string;
    mark: ChartMark;
    overlays?: Overlay[];
    title?: string;
    controls?: ChartControl[];
    readouts?: Metric[];
  }
  | { block: "table"; data: string; columns?: string[] }
  | { block: "input"; signal?: string | null; widget?: Widget }
  | { block: "stack"; children: Block[] }
  | { block: "columns"; collapse?: boolean; children: Block[] }
  | { block: "tabs"; items: Tab[] };

/** A whole Interactive View document. */
export interface Document {
  interactiveView: number;
  data?: Record<string, DataSet>;
  signals?: Record<string, Signal>;
  view?: Block[];
}

/** The only schema major this renderer understands; a higher major is refused
 *  (forward-compat: an old client must not half-render a newer document). */
export const SUPPORTED_MAJOR = 1;
