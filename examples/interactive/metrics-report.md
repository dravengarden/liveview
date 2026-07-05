# The Sharpe ratio, interactively

The **Sharpe ratio** measures risk-adjusted return — excess return per unit of
volatility. Instead of a static screenshot, the panel below is *live*: drag the
risk-free rate and every number recomputes, because the report is a small
reactive document embedded right in this chapter.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "returns": {
      "columns": { "day": "integer", "ret": "number" },
      "values": [
        { "day": 1, "ret": 0.012 }, { "day": 2, "ret": -0.004 },
        { "day": 3, "ret": 0.008 }, { "day": 4, "ret": 0.015 },
        { "day": 5, "ret": -0.010 }, { "day": 6, "ret": 0.006 },
        { "day": 7, "ret": 0.003 }, { "day": 8, "ret": -0.002 },
        { "day": 9, "ret": 0.011 }, { "day": 10, "ret": 0.007 }
      ]
    }
  },
  "signals": {
    "rf": { "type": "number", "init": 0.02,
      "widget": { "type": "slider", "min": 0, "max": 0.1, "step": 0.005, "label": "Risk-free rate" } },
    "horizon": { "type": "enum", "init": 252,
      "widget": { "type": "segmented", "label": "Annualization",
        "options": [ { "label": "Daily", "value": 1 }, { "label": "Weekly", "value": 52 }, { "label": "Annual", "value": 252 } ] } },
    "meanRet": { "type": "number", "derived": "mean(returns.ret)" },
    "vol": { "type": "number", "derived": "std(returns.ret) * sqrt(252)" },
    "sharpe": { "type": "number", "derived": "mean(returns.ret - rf) / std(returns.ret) * sqrt(252)" }
  },
  "view": [
    { "block": "section", "md": "At a risk-free rate of **{{rf | round(3)}}**, the annualized Sharpe ratio is **{{sharpe | round(2)}}** (annualization factor {{horizon}})." },
    { "block": "metricGroup", "items": [
      { "label": "Sharpe ratio", "value": "{{sharpe}}", "format": "0.00", "audio": { "narrate": true } },
      { "label": "Mean daily return", "value": "{{meanRet}}", "format": "0.0%" },
      { "label": "Annualized volatility", "value": "{{vol}}", "format": "0.0%" }
    ] },
    { "block": "input", "signal": "rf" },
    { "block": "input", "signal": "horizon" },
    { "block": "chart", "id": "perf", "data": "returns",
      "vega": { "mark": { "type": "bar" }, "encoding": {
        "x": { "field": "day", "type": "ordinal" }, "y": { "field": "ret", "type": "quantitative" } } } }
  ]
}
```

As the risk-free rate falls, more of the return counts as *excess* — so the
Sharpe ratio rises. Try dragging it to zero, then switch the annualization
factor. Everything above (and this book chapter's title in the sidebar) is
ordinary markdown; only the panel is the embedded reactive component.
