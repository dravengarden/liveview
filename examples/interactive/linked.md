# Linked charts — cross-filtering & global signals

A dashboard isn't a pile of separate charts — it's charts that **move
together**. Interactive View expresses that with two sound primitives:

- a **derived dataset** — `filter(base, …)` over other datasets & signals —
  which the kernel recomputes whenever a referenced signal changes, so every
  chart reading it re-filters live; and
- a **chart selection** — a `from` signal that a categorical chart writes on
  click, so *clicking one chart drives the others*.

Because the whole reactive graph (signals **and** derived datasets) is checked
to be acyclic before it renders, these compose without ever looping — a global
selector can feed ten charts, and a click can update a chart plus a row of KPIs,
with no scheduler and no risk of an update storm.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "byQuarter": {
      "columns": {"region": "string", "quarter": "string", "revenue": "number", "units": "number"},
      "values": [
        {"region": "North", "quarter": "Q1", "revenue": 120, "units": 40},
        {"region": "North", "quarter": "Q2", "revenue": 135, "units": 45},
        {"region": "North", "quarter": "Q3", "revenue": 128, "units": 43},
        {"region": "North", "quarter": "Q4", "revenue": 150, "units": 50},
        {"region": "South", "quarter": "Q1", "revenue": 80, "units": 30},
        {"region": "South", "quarter": "Q2", "revenue": 96, "units": 34},
        {"region": "South", "quarter": "Q3", "revenue": 110, "units": 38},
        {"region": "South", "quarter": "Q4", "revenue": 132, "units": 44},
        {"region": "East", "quarter": "Q1", "revenue": 60, "units": 22},
        {"region": "East", "quarter": "Q2", "revenue": 72, "units": 26},
        {"region": "East", "quarter": "Q3", "revenue": 85, "units": 30},
        {"region": "East", "quarter": "Q4", "revenue": 100, "units": 36},
        {"region": "West", "quarter": "Q1", "revenue": 90, "units": 33},
        {"region": "West", "quarter": "Q2", "revenue": 88, "units": 32},
        {"region": "West", "quarter": "Q3", "revenue": 105, "units": 37},
        {"region": "West", "quarter": "Q4", "revenue": 120, "units": 41}
      ]
    },
    "byProduct": {
      "columns": {"region": "string", "product": "string", "revenue": "number"},
      "values": [
        {"region": "North", "product": "Hardware", "revenue": 60},
        {"region": "North", "product": "Services", "revenue": 40},
        {"region": "North", "product": "Cloud", "revenue": 25},
        {"region": "North", "product": "Support", "revenue": 18},
        {"region": "South", "product": "Hardware", "revenue": 35},
        {"region": "South", "product": "Services", "revenue": 30},
        {"region": "South", "product": "Cloud", "revenue": 20},
        {"region": "South", "product": "Support", "revenue": 12},
        {"region": "East", "product": "Hardware", "revenue": 25},
        {"region": "East", "product": "Services", "revenue": 18},
        {"region": "East", "product": "Cloud", "revenue": 15},
        {"region": "East", "product": "Support", "revenue": 10},
        {"region": "West", "product": "Hardware", "revenue": 40},
        {"region": "West", "product": "Services", "revenue": 28},
        {"region": "West", "product": "Cloud", "revenue": 22},
        {"region": "West", "product": "Support", "revenue": 14}
      ]
    },
    "byRegion": {
      "columns": {"region": "string", "revenue": "number"},
      "values": [
        {"region": "North", "revenue": 533},
        {"region": "South", "revenue": 418},
        {"region": "East", "revenue": 317},
        {"region": "West", "revenue": 403}
      ]
    },
    "qByRegion": {"derived": "filter(byQuarter, region == rgn)"},
    "pByRegion": {"derived": "filter(byProduct, region == rgn)"},
    "qByPick": {"derived": "filter(byQuarter, region == pick)"},
    "qByPeriod": {"derived": "filter(byQuarter, quarter == period)"}
  },
  "signals": {
    "rgn": {
      "type": "enum",
      "init": "North",
      "widget": {"type": "segmented", "label": "Region",
        "options": [
          {"label": "North", "value": "North"},
          {"label": "South", "value": "South"},
          {"label": "East", "value": "East"},
          {"label": "West", "value": "West"}
        ]}
    },
    "pick": {"type": "string", "init": "North", "from": {"chart": "regionRank", "select": "region"}},
    "pickRevenue": {"type": "number", "derived": "sum(qByPick.revenue)"},
    "pickUnits": {"type": "number", "derived": "sum(qByPick.units)"},
    "period": {
      "type": "enum",
      "init": "Q1",
      "widget": {"type": "segmented", "label": "Quarter",
        "options": [
          {"label": "Q1", "value": "Q1"},
          {"label": "Q2", "value": "Q2"},
          {"label": "Q3", "value": "Q3"},
          {"label": "Q4", "value": "Q4"}
        ]}
    }
  },
  "view": [
    {"block": "section", "md": "## Global filter — one selector, every chart follows\n\nPick a **region**. Both charts below read *derived* datasets (`filter(byQuarter, region == rgn)` and `filter(byProduct, region == rgn)`), so they re-filter the instant you change the control — one signal, many views."},
    {"block": "input", "signal": "rgn"},
    {"block": "chart", "data": "qByRegion", "title": "Revenue by quarter",
      "mark": {"chart": "bar", "x": {"column": "quarter"}, "y": [{"column": "revenue"}]}},
    {"block": "chart", "data": "pByRegion", "title": "Product mix",
      "mark": {"chart": "pie", "category": {"column": "product"}, "value": {"column": "revenue"}}},

    {"block": "section", "md": "## Click to cross-filter\n\n**Click a region** in the ranking below. The click writes the `pick` signal (a chart *selection*), which drives the KPI row and the detail chart at once — the picked bar stays highlighted, everything else dims."},
    {"block": "chart", "id": "regionRank", "data": "byRegion", "title": "Regions — click one",
      "mark": {"chart": "barHorizontal", "category": {"column": "region"}, "value": {"column": "revenue"}}},
    {"block": "metricGroup", "items": [
      {"label": "Region", "value": "{{pick}}"},
      {"label": "Revenue", "value": "{{pickRevenue}}"},
      {"label": "Units", "value": "{{pickUnits}}"}
    ]},
    {"block": "chart", "data": "qByPick", "title": "Selected region — by quarter",
      "mark": {"chart": "bar", "x": {"column": "quarter"}, "y": [{"column": "revenue"}]}},

    {"block": "section", "md": "## Global time — a shared period\n\nA second global dimension. Choose a **quarter** and the ranking re-scopes to that period (`filter(byQuarter, quarter == period)`). Multiple global signals coexist because the checker proved the dependency graph is a DAG."},
    {"block": "input", "signal": "period"},
    {"block": "chart", "data": "qByPeriod", "title": "Regions in the selected quarter",
      "mark": {"chart": "barHorizontal", "category": {"column": "region"}, "value": {"column": "revenue"}}},

    {"block": "callout", "kind": "tip", "md": "**Why this can't loop:** a derived dataset or signal may only read things *upstream* of it. If you wrote `filtered = filter(sales, x > s)` **and** `s = count(filtered)`, the checker rejects it — `reactive dependency cycle: s → dataset filtered → s` — before it ever renders."}
  ]
}
```
