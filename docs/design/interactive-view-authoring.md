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
