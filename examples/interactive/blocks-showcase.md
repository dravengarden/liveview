# Blocks showcase — callouts, panels, grouped & reshaping charts

This chapter demos the newer building blocks: the seven **callout** variants, a
**panel** (a card that groups non-chart widgets), a **chartGroup** (linked charts
in one card), and a chart whose series is **reshaped** live by a slider via
`with(...)`. Every fence here passes `liveview check`, so it renders and reflows
on every screen with no visual review.

## The seven callout variants

Pick the variant by MEANING — a plain explanation is `note`, not a loud
`success`.

```interactive-view
{
  "interactiveView": 1,
  "view": [
    { "block": "callout", "kind": "note", "md": "**note** — a neutral aside / plain explanation. The default." },
    { "block": "callout", "kind": "info", "md": "**info** — a factual, non-urgent aside." },
    { "block": "callout", "kind": "tip", "md": "**tip** — a helpful trick or \"try this\"." },
    { "block": "callout", "kind": "success", "md": "**success** — a genuinely confirmed / correct result." },
    { "block": "callout", "kind": "warning", "md": "**warning** — be careful, a real gotcha." },
    { "block": "callout", "kind": "danger", "md": "**danger** — a trap that will cost you money or data." },
    { "block": "callout", "kind": "quote", "md": "**quote** — a definition or citation, rendered as a blockquote." }
  ]
}
```

## A panel — grouping a control + metric + table in one card

When a control drives a `table`/`metric` with no plot to dock into, a `panel`
keeps them one unit. Pick a tier and the table + count follow.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "coins": {
      "columns": { "tier": "string", "name": "string", "note": "string" },
      "values": [
        { "tier": "L1", "name": "Bitcoin", "note": "the reserve asset" },
        { "tier": "L1", "name": "Ethereum", "note": "the settlement layer" },
        { "tier": "L1", "name": "Solana", "note": "high-throughput monolith" },
        { "tier": "L2", "name": "Arbitrum", "note": "optimistic rollup" },
        { "tier": "L2", "name": "Base", "note": "CB-backed OP-stack rollup" },
        { "tier": "DeFi", "name": "Uniswap", "note": "the AMM standard" },
        { "tier": "DeFi", "name": "Aave", "note": "money-market blue chip" }
      ]
    },
    "picked": { "derived": "filter(coins, tier == tier_sig)" }
  },
  "signals": {
    "tier_sig": { "type": "enum", "init": "L1",
      "widget": { "type": "segmented", "label": "Tier",
        "options": [ { "label": "L1", "value": "L1" }, { "label": "L2", "value": "L2" }, { "label": "DeFi", "value": "DeFi" } ] } },
    "n": { "type": "number", "derived": "count(picked.name)" }
  },
  "view": [
    { "block": "panel", "title": "Pick a tier — the list follows", "children": [
      { "block": "input", "signal": "tier_sig" },
      { "block": "metric", "label": "How many in this tier", "value": "{{n}}" },
      { "block": "table", "data": "picked", "columns": [ "name", "note" ] }
    ] }
  ]
}
```

## A chartGroup — two linked charts, one shared control

A single window slider frames the same stretch on both stacked charts; the Reset
button appears by itself once you move the window.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "series": {
      "columns": { "t": "integer", "price": "number", "flow": "number" },
      "values": [
        { "t": 1, "price": 100, "flow": 0 }, { "t": 2, "price": 101, "flow": 8 },
        { "t": 3, "price": 103, "flow": 15 }, { "t": 4, "price": 104, "flow": 12 },
        { "t": 5, "price": 106, "flow": 6 }, { "t": 6, "price": 107, "flow": -2 },
        { "t": 7, "price": 109, "flow": -5 }, { "t": 8, "price": 110, "flow": -9 }
      ]
    },
    "sel": { "derived": "filter(series, t >= win[0] && t <= win[1])" }
  },
  "signals": {
    "win": { "type": "interval<number>", "init": [5, 8],
      "widget": { "type": "rangeSlider", "min": 1, "max": 8, "step": 1, "label": "Window (bar index)" } },
    "dP": { "type": "number", "derived": "sum(sel.flow)" }
  },
  "view": [
    { "block": "chartGroup", "title": "Price vs flow — stacked, one control",
      "charts": [
        { "data": "series", "title": "Price",
          "mark": { "chart": "line", "x": { "column": "t" }, "y": [ { "column": "price", "label": "Price" } ] },
          "overlays": [ { "overlay": "vBand", "from": "win[0]", "to": "win[1]", "label": "window" } ] },
        { "data": "series", "title": "Flow",
          "mark": { "chart": "area", "x": { "column": "t" }, "y": [ { "column": "flow", "label": "Flow" } ] },
          "overlays": [ { "overlay": "vBand", "from": "win[0]", "to": "win[1]", "label": "window" } ] }
      ],
      "controls": [ { "signal": "win" } ],
      "readouts": [ { "label": "net flow in window", "value": "{{dP}}" } ] }
  ]
}
```

## Reshaping a series live — `with()` computed columns

The `k` slider recomputes the `upper`/`lower` columns per row, so the band on the
chart visibly widens and narrows — a widget changing the SHAPE of a plotted line,
not just a threshold.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "px": {
      "columns": { "t": "integer", "open": "number", "high": "number", "low": "number", "close": "number", "mid": "number", "sigma": "number" },
      "values": [
        { "t": 1, "open": 100, "high": 103, "low": 98, "close": 101, "mid": 100, "sigma": 1.5 },
        { "t": 2, "open": 101, "high": 105, "low": 100, "close": 104, "mid": 101, "sigma": 2.0 },
        { "t": 3, "open": 104, "high": 107, "low": 102, "close": 103, "mid": 102, "sigma": 2.5 },
        { "t": 4, "open": 103, "high": 106, "low": 101, "close": 105, "mid": 103, "sigma": 2.0 },
        { "t": 5, "open": 105, "high": 110, "low": 104, "close": 109, "mid": 105, "sigma": 3.0 },
        { "t": 6, "open": 109, "high": 112, "low": 107, "close": 110, "mid": 107, "sigma": 2.5 }
      ]
    },
    "band": { "derived": "with(px, 'upper', mid + k * sigma, 'lower', mid - k * sigma)" }
  },
  "signals": {
    "k": { "type": "number", "init": 2,
      "widget": { "type": "slider", "min": 1, "max": 3, "step": 0.5, "label": "k (band width in std devs)" } },
    "hw": { "type": "number", "derived": "round(k * 2.5, 2)" }
  },
  "view": [
    { "block": "chart", "data": "band", "title": "Candles + bands that widen with k",
      "mark": { "chart": "candlestick", "x": { "column": "t" },
        "open": { "column": "open" }, "high": { "column": "high" }, "low": { "column": "low" }, "close": { "column": "close" },
        "ma": [ { "column": "upper", "label": "Upper" }, { "column": "mid", "label": "Middle" }, { "column": "lower", "label": "Lower" } ] },
      "controls": [ { "signal": "k" } ],
      "readouts": [ { "label": "latest ±band width (k×σ)", "value": "{{hw}}" } ] },
    { "block": "callout", "kind": "note", "md": "k only scales the ruler — what actually opens the band is that stretch's standard deviation (`sigma`)." }
  ]
}
```
