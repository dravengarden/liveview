# Interactive View — authoring reference

The **shipped** guide for writing interactive components in a book. (The sibling
`interactive-view.md` is the original design rationale — parts of it, e.g.
"Vega-Lite", "proposed, no code yet", are historical; this file describes what
actually ships and checks.)

**The contract:** an Interactive View is a *closed, typed* catalog you
**compose**, never a canvas you paint. There is no colour/CSS/pixel field —
series colours come from the theme, layout is mobile-first and auto-responsive.
So **if `liveview check` passes, it renders, looks good, and reflows on every
screen — no visual review needed.** `liveview check <book>` is already in the
book delivery gate; it validates every ` ```interactive-view ` fence (checker ==
renderer).

## When to reach for it (widget vs chart vs prose)

| The chapter needs to… | Use |
|---|---|
| Explain a formula/metric the reader can *feel* by moving an input | an **input widget** bound to a signal, + a `metric`/`section` that interpolates the result |
| Show a trend, comparison, distribution, correlation, or composition of **data** | a **chart** (see the mark table) reading a `data` set |
| Let the reader **filter/scope** several charts at once | a **global signal** (segmented/select/slider) + **derived datasets** (`filter(...)`) that every chart reads |
| Let clicking one chart **drive** others | a **chart selection** (`from`) feeding a signal that derived datasets filter on |
| Mark a reactive threshold/target/range on a chart | a reactive **overlay** (`hLine`/`vLine`/`hBand`/`vBand`) tracking a signal |
| Just static explanatory text / a diagram | plain markdown / mermaid (not this) |

Rule of thumb: **a widget makes ONE number/choice tangible; a chart makes DATA
legible; linkage makes a set of charts move together.** If there's no data table
and no reader-tunable quantity, it's prose — don't reach for an Interactive View.

## Skeleton

Embed a fence in a chapter (it gets a real markdown H1 title + prose around it):

~~~markdown
# Chapter title

Intro prose.

```interactive-view
{ "interactiveView": 1, "data": {…}, "signals": {…}, "view": [ … ] }
```
~~~

Three layers: **data** (datasets) → **signals** (reactive variables) → **view**
(an ordered, mobile-first block list).

## data — datasets

Each dataset declares a `columns` schema (`number`/`integer`/`string`/`boolean`/
`temporal`) and **exactly one** source:

- `"values": [ {…}, … ]` — tiny inline rows (< 32 KB).
- `"source": "/abs/content/path.arrow"` — big data (a rustfs blob).
- `"derived": "filter(base, …)"` — a **reactive transform** of other datasets +
  signals; schema is inferred; recomputed live. This is the cross-filter engine.

## signals — reactive variables

`{ "type": <SignalType>, "init": <value>, <one source> }`. Types: `number`,
`integer`, `boolean`, `string`, `temporal`, `enum`, `interval<number>`,
`interval<temporal>`, `array<enum>`. Exactly one source:

- `"widget": {…}` — the reader controls it (see widget table). Widget out-type
  must match the signal type.
- `"from": { "chart": "<chartId>", "select": "<column>" }` — a **chart
  selection**: clicking a datum in the bar/barHorizontal/pie chart with that
  `id` writes `datum[column]` into this signal. The column's type must match.
- `"derived": "<expr>"` — a computed cell (a total expression over signals &
  datasets). Result type must match the signal type.

**The whole derived graph (signals ∪ derived datasets) is checked to be a DAG.**
A cycle (`s = count(d)` while `d = filter(base, x>s)`) is a compile error.

## The `derived` expression language (total, no crash)

Literals `1`, `'x'`, `true`; operators `+ - * / %`, `&& || !`, `== != < <= > >=`;
`ds.col` (a column); interval index `band[0]`/`band[1]`. Functions:

- `filter(ds, pred)` → dataset. `pred` uses the dataset's columns unqualified
  (SQL-`WHERE`): `filter(sales, region == rgn && amount > 0)`.
- aggregates `mean sum std min max median count` (over a column).
- math `sqrt abs floor ceil round(x[,d]) clamp(x,lo,hi)`, `if(cond, a, b)`.

Any op over a missing/unloaded value yields the SQL-NULL-like *unavailable* — a
metric shows "—", a chart shows "no data" — **never a crash**.

## Widgets (→ signal type)

| widget | signal type | notes |
|---|---|---|
| `slider` / `numberInput` | number | `min`,`max`,`step` |
| `stepper` | integer | |
| `rangeSlider` | interval\<number\> | read `x[0]`/`x[1]` |
| `toggle` | boolean | |
| `segmented` | enum | ≤ 5 `options` (phone row) |
| `radioGroup` / `select` | enum | `options` |
| `multiSelect` / `checkboxGroup` | array\<enum\> | `options` |
| `textInput` | string | `maxLength` required |
| `datePicker` | temporal | |
| `dateRange` | interval\<temporal\> | |
| `button` | — | momentary; `action.reset:[signals]` |

## Charts (`mark.chart`)

| mark | reads | for |
|---|---|---|
| `line` | `x`, `y:[…]`, `curved?` | trends over an ordered x |
| `area` | `x`, `y:[…]`, `stacked?` | composition over x |
| `bar` | `x`(category), `y:[…]`, `stacked?` | compare categories |
| `barHorizontal` | `category`, `value` | rankings / top-N |
| `pie` | `category`, `value`, `donut?` | share of a whole |
| `scatter` | `x`, `y`, `size?`, `series?` | correlation |
| `histogram` | `value`, `bins?` | distribution |
| `candlestick` | `x`,`open`,`high`,`low`,`close`,`ma?:[…]` | OHLC price |
| `volume` | `x`, `value`, `open?`,`close?` | trade volume pane |
| `depth` | `price`, `bid`, `ask` | order-book / AMM depth |

Every column an encoding names must exist with a channel-appropriate type (y is
numeric, a bar x is categorical, …) — else it's a compile error. Colours are
theme-assigned; there is no colour field.

**Built-in interactions (free, no syntax):** hover shows a themed tooltip +
active point; on a multi-series chart, **click a legend item to isolate that
series** (others dim). On a bar/barHorizontal/pie that a `from` signal targets,
**clicking a datum selects it** (it stays lit, others dim) and drives the signal.

## Overlays (reactive reference marks)

On `line`/`area`/`scatter`/`candlestick`/`depth`: `hLine`/`vLine` (a signal
positions the line), `hBand`/`vBand` (a `[from,to]` pair — usually an interval
signal's `x[0]`/`x[1]`). A slider then slides a threshold; a range-slider shades
a region. An out-of-range value rescales the axis to stay visible.

`barHorizontal` also takes overlays, but only `vLine`/`vBand` — its value axis is
horizontal, so a vertical rule at `x = signal` is a **cutoff line across the
ranking** (a long threshold across momentum bars, a price marker across band
rails). `hLine`/`hBand` are rejected there (they'd sit on the category axis).
This is the way to make a slider visibly drive a barHorizontal, which has no
series to reshape.

## Docked controls & readouts (widget ⇄ chart, one card)

A `chart` block may dock its inputs and KPI tiles INTO its own card, so the
tunable and its visual effect read as one unit instead of floating in separate
blocks:

- `"controls"`: an array of inputs, each `{ "signal": "x" }` (render the widget
  declared on signal `x`) or `{ "widget": {…} }` (a standalone control) — same
  shape as an `input` block. Rendered as a self-arranging grid BELOW the plot.
- `"readouts"`: an array of `Metric` tiles (`{ "label": "…", "value": "{{s}}" }`,
  same as a `metricGroup` item) — a KPI-chip grid below the controls.
- `"highlight"`: a signal name (enum/string) whose value **emphasises the
  matching series and dims the others** on a `line`/`area`/`bar`/`scatter`, so a
  docked `segmented`/`select`/`radioGroup` visibly COMMANDS the plot rather than
  only moving a readout number. A series matches by column OR display label; any
  series NOT in the control's option set (a price/benchmark anchor) stays bold.
  Composes with the free legend-click isolation (a manual click overrides it).

```jsonc
{ "block": "chart", "data": "series", "title": "SMA / EMA / HMA",
  "mark": { "chart": "line", "x": {"column":"t"},
            "y": [{"column":"price","label":"Price"},{"column":"sma","label":"SMA"},
                  {"column":"ema","label":"EMA"},{"column":"hma","label":"HMA"}] },
  "controls": [ { "signal": "focus" } ],
  "highlight": "focus",
  "readouts": [ { "label": "avg tracking error", "value": "{{gapval}}" } ] }
```

Prefer this over standalone `input`/`metric` blocks whenever the control tunes
THIS chart (its series via `highlight`, or its overlay). The layout is a **smart,
self-optimising container**: you list controls/readouts and never think about
placement — they sit below the plot and auto-arrange in a CSS `auto-fit` grid
(1 column on a phone, 2–3 on a tablet, 3+ on desktop, for any count, with no
media queries), all container-relative and mobile-first. So — like everything
here — a chart that `liveview check`s passes renders and reflows well with no
visual review. A chart with none of these fields renders frameless as before.

Two more reactive levers that make a control drive the plot without reshaping
data: **overlays** (a slider moves a threshold line — see the Overlays section,
including `vLine` on `barHorizontal` for a cutoff across a ranking) and the
**y-fit**: `line`/`scatter` auto-fit the data extent (no forced zero baseline),
so a tight high-value series (prices ~100) fills the plot instead of collapsing
to a flat ribbon; `bar` keeps a zero baseline.

## Blocks (the `view` array)

`section` (markdown + `{{signal | round(2)}}` interpolation), `metric` /
`metricGroup` (KPI tiles), `callout` (`kind: note|tip|warning|info`), `chart`,
`table` (`columns?`), `input` (`signal` or a standalone `widget`), and layout
`stack` / `columns` (auto-collapse on phone) / `tabs`. Nesting ≤ 4.

## The canonical linkage (copy this shape)

```jsonc
"data": {
  "sales":    { "columns": {"region":"string","q":"string","rev":"number"}, "values": [ … ] },
  "filtered": { "derived": "filter(sales, region == rgn)" }   // ← reactive
},
"signals": {
  "rgn":  { "type":"enum", "init":"North", "widget": {"type":"segmented","options":[ … ]} },
  "pick": { "type":"string", "init":"North", "from": {"chart":"ranks","select":"region"} },
  "total":{ "type":"number", "derived":"sum(filtered.rev)" }   // ← recomputes with rgn
},
"view": [
  { "block":"input", "signal":"rgn" },
  { "block":"chart", "data":"filtered", "mark":{"chart":"bar","x":{"column":"q"},"y":[{"column":"rev"}]} },
  { "block":"chart", "id":"ranks", "data":"sales", "mark":{"chart":"barHorizontal","category":{"column":"region"},"value":{"column":"rev"}} },
  { "block":"metric", "label":"Total", "value":"{{total}}" }
]
```

Full worked demos live in the liveview repo's `examples/interactive/`:
`charts.md` (every mark + reactive overlay), `trading.md` (candlestick/volume/
depth), **`linked.md` (global filter + click-to-cross-filter + a rejected
cycle)**, `all-widgets.md` (every widget).

## Delivery

Nothing special: the book delivery gate's `liveview check <book>` already
validates every fence. If it's clean, ship it (`liveview sync`) — it renders.
