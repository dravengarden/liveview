# Trading & DeFi charts

The price view a stock terminal or a DeFi exchange shows isn't a plain line —
it's a **candlestick** (open / high / low / close per period) with indicator
lines, a **volume** pane coloured by candle direction, and an order-book
**depth** chart. All three are declared here as sound marks: the checker
validates every OHLC column, and up/down colours come from the theme.

## Candlestick + volume — a price terminal

Drag the **alert** to move the dashed price line across the candles. The MA line
is an indicator series; each candle and each volume bar is green on an up close,
red on a down close — the standard trading read.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "ohlc": {
      "columns": { "t": "integer", "open": "number", "high": "number", "low": "number", "close": "number", "ma": "number", "vol": "integer" },
      "values": [
        { "t": 1, "open": 100, "high": 103, "low": 99, "close": 102, "ma": 100, "vol": 1200 },
        { "t": 2, "open": 102, "high": 106, "low": 101, "close": 105, "ma": 101, "vol": 1500 },
        { "t": 3, "open": 105, "high": 107, "low": 103, "close": 104, "ma": 102, "vol": 1100 },
        { "t": 4, "open": 104, "high": 109, "low": 103, "close": 108, "ma": 103, "vol": 1800 },
        { "t": 5, "open": 108, "high": 112, "low": 107, "close": 111, "ma": 105, "vol": 2000 },
        { "t": 6, "open": 111, "high": 113, "low": 108, "close": 109, "ma": 106, "vol": 1600 },
        { "t": 7, "open": 109, "high": 110, "low": 104, "close": 105, "ma": 106, "vol": 2100 },
        { "t": 8, "open": 105, "high": 108, "low": 104, "close": 107, "ma": 106, "vol": 1400 },
        { "t": 9, "open": 107, "high": 113, "low": 106, "close": 112, "ma": 107, "vol": 1900 },
        { "t": 10, "open": 112, "high": 116, "low": 111, "close": 115, "ma": 109, "vol": 2200 },
        { "t": 11, "open": 115, "high": 118, "low": 113, "close": 114, "ma": 110, "vol": 1700 },
        { "t": 12, "open": 114, "high": 119, "low": 112, "close": 118, "ma": 112, "vol": 2000 },
        { "t": 13, "open": 118, "high": 122, "low": 117, "close": 121, "ma": 114, "vol": 2400 },
        { "t": 14, "open": 121, "high": 124, "low": 119, "close": 120, "ma": 116, "vol": 1800 }
      ]
    }
  },
  "signals": {
    "alert": { "type": "number", "init": 115,
      "widget": { "type": "slider", "min": 98, "max": 126, "step": 1, "label": "Price alert" } }
  },
  "view": [
    { "block": "input", "signal": "alert" },
    { "block": "metric", "label": "Alert level", "value": "{{alert}}" },
    { "block": "chart", "data": "ohlc", "title": "Price (candlestick + MA)",
      "mark": { "chart": "candlestick", "x": { "column": "t" },
        "open": { "column": "open" }, "high": { "column": "high" },
        "low": { "column": "low" }, "close": { "column": "close" },
        "ma": [ { "column": "ma", "label": "MA" } ] },
      "overlays": [ { "overlay": "hLine", "value": "alert", "label": "alert" } ] },
    { "block": "chart", "data": "ohlc", "title": "Volume",
      "mark": { "chart": "volume", "x": { "column": "t" }, "value": { "column": "vol" },
        "open": { "column": "open" }, "close": { "column": "close" } } }
  ]
}
```

## Depth — the order book

A **depth** chart cumulates bid and ask liquidity outward from the mid price —
the deeper the wall, the more size resting at that level. Drag the **mid** marker
across the book.

```interactive-view
{
  "interactiveView": 1,
  "data": {
    "book": {
      "columns": { "price": "number", "bid": "integer", "ask": "integer" },
      "values": [
        { "price": 114, "bid": 30, "ask": 0 },
        { "price": 115, "bid": 26, "ask": 0 },
        { "price": 116, "bid": 22, "ask": 0 },
        { "price": 117, "bid": 18, "ask": 0 },
        { "price": 118, "bid": 14, "ask": 0 },
        { "price": 119, "bid": 9, "ask": 0 },
        { "price": 120, "bid": 4, "ask": 0 },
        { "price": 121, "bid": 0, "ask": 5 },
        { "price": 122, "bid": 0, "ask": 10 },
        { "price": 123, "bid": 0, "ask": 16 },
        { "price": 124, "bid": 0, "ask": 21 },
        { "price": 125, "bid": 0, "ask": 27 },
        { "price": 126, "bid": 0, "ask": 33 }
      ]
    }
  },
  "signals": {
    "mid": { "type": "number", "init": 120,
      "widget": { "type": "slider", "min": 114, "max": 126, "step": 1, "label": "Mid price" } }
  },
  "view": [
    { "block": "input", "signal": "mid" },
    { "block": "chart", "data": "book", "title": "Order-book depth",
      "mark": { "chart": "depth", "price": { "column": "price" }, "bid": { "column": "bid" }, "ask": { "column": "ask" } },
      "overlays": [ { "overlay": "vLine", "value": "mid", "label": "mid" } ] }
  ]
}
```
