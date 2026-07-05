# Charts — an interactive data-analysis gallery

Every chart below is declared as a closed *mark* (line / area / bar / pie /
scatter / histogram) over a dataset — no raw chart spec, no colours in the
document. Colours come from the reader's theme, so each chart is legible in
light **and** dark, and the layout adapts to the phone or the desktop on its
own. Because the checker validates every column, type, and signal reference,
a chart that compiles is a chart that renders.

## Reactive line — widgets drive the chart

Drag the **threshold** to move the dashed reference line, and the **window**
range to shade a band. The mean price *inside the shaded window* recomputes
live — the same signal graph the widgets and metrics share now drives the
chart's overlays.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "prices": {
      "columns": { "session": "integer", "price": "number" },
      "values": [
        { "session": 1, "price": 100 }, { "session": 2, "price": 104 },
        { "session": 3, "price": 102 }, { "session": 4, "price": 109 },
        { "session": 5, "price": 113 }, { "session": 6, "price": 110 },
        { "session": 7, "price": 116 }, { "session": 8, "price": 121 },
        { "session": 9, "price": 118 }, { "session": 10, "price": 125 },
        { "session": 11, "price": 131 }, { "session": 12, "price": 128 },
        { "session": 13, "price": 134 }, { "session": 14, "price": 139 },
        { "session": 15, "price": 136 }, { "session": 16, "price": 143 }
      ]
    }
  },
  "signals": {
    "threshold": { "type": "number", "init": 120,
      "widget": { "type": "slider", "min": 100, "max": 145, "step": 1, "label": "Threshold" } },
    "window": { "type": "interval<number>", "init": [5, 11],
      "widget": { "type": "rangeSlider", "min": 1, "max": 16, "step": 1, "label": "Window (sessions)" } },
    "windowMean": { "type": "number",
      "derived": "mean(filter(prices, session >= window[0] && session <= window[1]).price)" }
  },
  "view": [
    { "block": "input", "signal": "threshold" },
    { "block": "input", "signal": "window" },
    { "block": "metricGroup", "items": [
      { "label": "Threshold", "value": "{{threshold}}" },
      { "label": "Window mean", "value": "{{windowMean | round(2)}}" }
    ] },
    { "block": "chart", "data": "prices", "title": "Session close price",
      "mark": { "chart": "line", "x": { "column": "session" }, "y": [ { "column": "price", "label": "Close" } ] },
      "overlays": [
        { "overlay": "hLine", "value": "threshold", "label": "threshold" },
        { "overlay": "vBand", "from": "window[0]", "to": "window[1]", "label": "window" }
      ] }
  ]
}
```

## Trends — multi-series line & stacked area

A **line** compares several series over an ordered axis; an **area** (stacked)
reads the same data as composition — how each series contributes to the total.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "growth": {
      "columns": { "month": "string", "north": "number", "south": "number", "west": "number" },
      "values": [
        { "month": "Jan", "north": 42, "south": 30, "west": 18 },
        { "month": "Feb", "north": 48, "south": 33, "west": 22 },
        { "month": "Mar", "north": 51, "south": 38, "west": 28 },
        { "month": "Apr", "north": 60, "south": 41, "west": 35 },
        { "month": "May", "north": 66, "south": 47, "west": 44 },
        { "month": "Jun", "north": 72, "south": 52, "west": 51 }
      ]
    }
  },
  "view": [
    { "block": "chart", "data": "growth", "title": "Regional revenue (line)",
      "mark": { "chart": "line", "curved": true, "x": { "column": "month" },
        "y": [ { "column": "north", "label": "North" }, { "column": "south", "label": "South" }, { "column": "west", "label": "West" } ] } },
    { "block": "chart", "data": "growth", "title": "Regional revenue (stacked area)",
      "mark": { "chart": "area", "stacked": true, "x": { "column": "month" },
        "y": [ { "column": "north", "label": "North" }, { "column": "south", "label": "South" }, { "column": "west", "label": "West" } ] } }
  ]
}
```

## Comparison — grouped bar, stacked bar, ranking

**Bars** compare discrete categories; **stack** them to show composition, and
lay them **horizontal** for a clean ranking.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "revenue": {
      "columns": { "quarter": "string", "hardware": "number", "services": "number" },
      "values": [
        { "quarter": "Q1", "hardware": 120, "services": 80 },
        { "quarter": "Q2", "hardware": 135, "services": 96 },
        { "quarter": "Q3", "hardware": 128, "services": 110 },
        { "quarter": "Q4", "hardware": 150, "services": 132 }
      ]
    },
    "ranking": {
      "columns": { "team": "string", "score": "number" },
      "values": [
        { "team": "Atlas", "score": 92 }, { "team": "Borealis", "score": 78 },
        { "team": "Cirrus", "score": 85 }, { "team": "Delta", "score": 69 },
        { "team": "Echo", "score": 88 }, { "team": "Fjord", "score": 74 }
      ]
    }
  },
  "view": [
    { "block": "chart", "data": "revenue", "title": "Revenue by quarter (grouped)",
      "mark": { "chart": "bar", "x": { "column": "quarter" },
        "y": [ { "column": "hardware", "label": "Hardware" }, { "column": "services", "label": "Services" } ] } },
    { "block": "chart", "data": "revenue", "title": "Revenue by quarter (stacked)",
      "mark": { "chart": "bar", "stacked": true, "x": { "column": "quarter" },
        "y": [ { "column": "hardware", "label": "Hardware" }, { "column": "services", "label": "Services" } ] } },
    { "block": "chart", "data": "ranking", "title": "Team score (ranking)",
      "mark": { "chart": "barHorizontal", "category": { "column": "team" }, "value": { "column": "score", "label": "Score" } } }
  ]
}
```

## Composition — pie & donut

A **pie** (or **donut**) reads one categorical field as a share of the whole.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "alloc": {
      "columns": { "asset": "string", "weight": "number" },
      "values": [
        { "asset": "Equities", "weight": 45 },
        { "asset": "Bonds", "weight": 25 },
        { "asset": "Real estate", "weight": 15 },
        { "asset": "Commodities", "weight": 8 },
        { "asset": "Cash", "weight": 7 }
      ]
    }
  },
  "view": [
    { "block": "columns", "children": [
      { "block": "chart", "data": "alloc", "title": "Allocation (pie)",
        "mark": { "chart": "pie", "category": { "column": "asset" }, "value": { "column": "weight" } } },
      { "block": "chart", "data": "alloc", "title": "Allocation (donut)",
        "mark": { "chart": "pie", "donut": true, "category": { "column": "asset" }, "value": { "column": "weight" } } }
    ] }
  ]
}
```

## Correlation & distribution — scatter, histogram, table

A **scatter** plots two numeric fields (coloured by sector, sized by weight);
a **histogram** bins one field to show its shape; the **table** is the raw data.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "assets": {
      "columns": { "risk": "number", "ret": "number", "weight": "number", "sector": "string" },
      "values": [
        { "risk": 4, "ret": 3, "weight": 12, "sector": "Tech" },
        { "risk": 7, "ret": 6, "weight": 18, "sector": "Tech" },
        { "risk": 12, "ret": 9, "weight": 9, "sector": "Tech" },
        { "risk": 3, "ret": 2, "weight": 22, "sector": "Utilities" },
        { "risk": 5, "ret": 3, "weight": 16, "sector": "Utilities" },
        { "risk": 9, "ret": 5, "weight": 11, "sector": "Utilities" },
        { "risk": 15, "ret": 13, "weight": 7, "sector": "Energy" },
        { "risk": 18, "ret": 14, "weight": 6, "sector": "Energy" },
        { "risk": 11, "ret": 8, "weight": 14, "sector": "Energy" }
      ]
    },
    "samples": {
      "columns": { "r": "number" },
      "values": [
        { "r": -3.1 }, { "r": -1.8 }, { "r": -1.2 }, { "r": -0.7 }, { "r": -0.4 },
        { "r": -0.2 }, { "r": 0.1 }, { "r": 0.3 }, { "r": 0.4 }, { "r": 0.6 },
        { "r": 0.7 }, { "r": 0.8 }, { "r": 0.9 }, { "r": 1.0 }, { "r": 1.1 },
        { "r": 1.2 }, { "r": 1.3 }, { "r": 1.4 }, { "r": 1.6 }, { "r": 1.8 },
        { "r": 2.0 }, { "r": 2.3 }, { "r": 2.7 }, { "r": 3.4 }, { "r": -2.4 },
        { "r": 0.2 }, { "r": 0.5 }, { "r": 1.5 }, { "r": -0.9 }, { "r": 0.0 }
      ]
    }
  },
  "view": [
    { "block": "chart", "data": "assets", "title": "Risk vs. return (by sector)",
      "mark": { "chart": "scatter", "x": { "column": "risk", "label": "Risk" }, "y": { "column": "ret", "label": "Return" },
        "size": { "column": "weight" }, "series": { "column": "sector" } } },
    { "block": "chart", "data": "samples", "title": "Return distribution",
      "mark": { "chart": "histogram", "value": { "column": "r", "label": "Daily return" }, "bins": 8 } },
    { "block": "table", "data": "assets", "columns": ["sector", "risk", "ret", "weight"] }
  ]
}
```
