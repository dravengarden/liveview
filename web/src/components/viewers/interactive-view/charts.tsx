// The chart renderer — one recharts chart per `ChartMark`, via an exhaustive
// `switch` (with a `never` default) so a new mark is a compile error. Lazy-loaded
// (recharts is heavy) so only chapters with a chart pull the chunk.
//
// Soundness/resilience contract (mirrors widgets/blocks):
//   • Colours come from the MUI THEME palette — no author colour/CSS field — so
//     every chart is legible in light AND dark, no visual review needed.
//   • The container is responsive (width 100%, fixed height); axes/grid/tooltip
//     are themed so nothing is invisible in dark mode; layout adapts to phone
//     width automatically.
//   • Unavailable/empty data renders a small "no data" tile, never a crash (the
//     block boundary in blocks.tsx is the outer net; this is the inner one).
//   • Overlays (reference lines/bands) read signals via the kernel, so they move
//     reactively as widgets change — the checker guarantees the refs resolve.

import { type JSX, type ReactNode, useEffect, useState } from "react";
import { Box, Typography, useTheme } from "@mui/material";
import type { Theme } from "@mui/material";
import { renderWidget } from "./widgets";
import { evalMetric } from "./interpolate";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type {
  Block,
  ChartControl,
  ChartField,
  Metric,
  Overlay,
  Signal,
} from "./types";
import type { Kernel } from "./kernel";
import { isUnavailable } from "./expr";

type ChartBlockT = Extract<Block, { block: "chart" }>;

const CHART_HEIGHT = 300;

// recharts' default hover tooltip is unusable on touch: it activates on
// touchMove (so merely SCROLLING past a chart spawns it), never clears on
// touchEnd, and mis-positions on a single touch render — leaving a card stuck
// mid-screen that reads as a frozen image. Two coupled props fix it on a coarse
// pointer, both source-verified against recharts 3.9:
//   • trigger:"click" — the tooltip then reads itemInteraction.click, set ONLY
//     by a real tap/click, never by touchMove (combineTooltipInteractionState).
//     So a scroll no longer spawns it; only a deliberate tap does.
//   • position — a numeric position short-circuits ALL of recharts' cursor +
//     size-measurement + viewport-clamp math (translate.js returns position[key]
//     verbatim), so the tapped readout always lands cleanly top-left in-plot.
// Mouse pointers keep the empty object → default hover-follow. No author knob.
const COARSE_POINTER = typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;
const TOOLTIP_PIN:
  | { position: { x: number; y: number }; trigger: "click" }
  | Record<string, never> = COARSE_POINTER
    ? { position: { x: 8, y: 8 }, trigger: "click" }
    : {};

/** The categorical series palette, drawn from the theme so it tracks light/dark
 *  and any theme change — authors never pick a colour. */
function palette(theme: Theme): string[] {
  const p = theme.palette;
  return [
    p.primary.main,
    p.secondary.main,
    p.success.main,
    p.warning.main,
    p.info.main,
    p.error.main,
    p.primary.light,
    p.secondary.light,
  ];
}

/** A guaranteed colour for series index `i` (the palette is non-empty; the
 *  fallback satisfies the type checker and never actually triggers). */
function colorAt(colors: string[], i: number): string {
  return colors[i % colors.length] ?? "#888888";
}

function labelOf(f: ChartField): string {
  return f.label ?? f.column;
}

function numColumn(rows: Record<string, unknown>[], col: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = Number(r[col]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

// A data-fit numeric domain (with headroom) for a value axis. recharts' default
// y-domain is `[0, 'auto']`, which forces zero into view — so a tightly-clustered
// high-value series (e.g. prices around 100) collapses into a flat ribbon at the
// top of the plot and its structure (crossings, swings) becomes invisible. We
// instead fit the axis to the data extent ±8% headroom. Because the returned
// domain already contains all data and recharts keeps `allowDataOverflow` off,
// a reactive overlay (a threshold line/band with `ifOverflow="extendDomain"`)
// still pushes the axis outward to stay visible. Used for line & scatter (bar
// keeps a zero baseline — a bar's length must be read from zero).
function fitDomain(values: number[]): [number, number] | ["auto", "auto"] {
  if (values.length === 0) return ["auto", "auto"];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) {
    const p = Math.abs(lo) * 0.05 || 1;
    return [lo - p, hi + p];
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

/** Read an overlay signal accessor (`name` or `name[0]`) to a raw axis value
 *  (number or temporal string), or null when unavailable — so a not-yet-set or
 *  UNAVAILABLE signal simply hides the overlay rather than drawing garbage. */
function readAxis(kernel: Kernel, acc: string): number | string | null {
  const m = /^([A-Za-z_]\w*)(?:\[(\d+)\])?$/.exec(acc.trim());
  if (!m) return null;
  let v: unknown = kernel.get(m[1] ?? "");
  if (m[2] !== undefined) v = Array.isArray(v) ? v[Number(m[2])] : undefined;
  if (v == null || isUnavailable(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v;
  return null;
}

// recharts' ResponsiveContainer sizes itself from a ResizeObserver on its
// parent. When the chart first lays out while the document is HIDDEN — an iOS
// PWA resumed from the background, a bfcache page restore, a tab shown after
// being rendered in the background — the parent measures 0×0, recharts caches
// that, and no resize event fires on return, so the chart stays collapsed into a
// flat sliver (the "it turned into a static image" bug). There is no prop that
// forces a re-measure, so we remount the sizing container: this counter bumps on
// every visibility→visible and pageshow, changing the container's `key` so React
// mounts a fresh ResponsiveContainer that re-measures the now-visible column.
// Cheap (charts are few, animations are off) and it only fires on a real
// resume, so no steady-state churn.
function useRemountOnVisible(): number {
  const [gen, setGen] = useState(0);
  useEffect(() => {
    const bump = (): void => setGen((g) => g + 1);
    const onVis = (): void => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVis);
    globalThis.addEventListener("pageshow", bump);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      globalThis.removeEventListener("pageshow", bump);
    };
  }, []);
  return gen;
}

// ── framing + empty state ─────────────────────────────────────────────────────

function ChartFrame({
  title,
  selectable,
  remountKey,
  children,
}: {
  title?: string | undefined;
  selectable?: boolean;
  remountKey?: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <Box sx={{ my: 1 }}>
      {title
        ? (
          <Typography
            variant="subtitle2"
            sx={{ mb: 1, color: "text.secondary" }}
          >
            {title}
          </Typography>
        )
        : null}
      <Box
        key={remountKey}
        sx={{
          width: "100%",
          height: CHART_HEIGHT,
          cursor: selectable ? "pointer" : "default",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

// ── chart panel: controls + plot + readouts as ONE card ───────────────────────

/** One docked readout — a compact KPI chip (label over value), a denser take on
 *  the `metric` tile so several fit inline under a plot. */
function ReadoutChip(
  { metric, kernel }: { metric: Metric; kernel: Kernel },
): JSX.Element {
  const value = evalMetric(metric.value, metric.format, kernel);
  return (
    <Box sx={{ minWidth: "5.5rem", flex: "0 1 auto" }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", lineHeight: 1.3 }}
      >
        {metric.label}
      </Typography>
      <Typography
        variant="subtitle2"
        sx={{ fontWeight: 700, lineHeight: 1.3, wordBreak: "break-word" }}
      >
        {value}
      </Typography>
    </Box>
  );
}

/** Resolve a docked control to its widget (standalone `widget`, or the widget
 *  declared on the referenced `signal`) and render it. Mirrors the `input`
 *  block's resolution so a chart control behaves identically — just docked. */
function DockedControl({
  control,
  signals,
  kernel,
}: {
  control: ChartControl;
  signals: Record<string, Signal>;
  kernel: Kernel;
}): JSX.Element | null {
  const declared = control.signal ? signals[control.signal] : undefined;
  const widget = control.widget ?? declared?.widget;
  if (!widget) return null;
  return <>{renderWidget(widget, control.signal ?? null, kernel)}</>;
}

// A SMART, self-optimising layout — the author lists `controls`/`readouts` and
// never thinks about placement, columns, or breakpoints; the container decides.
// Sound by construction (no visual review), and correct on every screen:
//   • Controls sit BELOW the plot (the preferred reading order — you look at the
//     chart, then reach the tunables under it; on a phone they land under your
//     thumb while the chart stays in view). Readouts sit below the controls.
//   • Placement is CONTAINER-RELATIVE, not viewport-relative. The panel lives in
//     the reader's content column (~358px iPhone / ~788px iPad / ~900px desktop),
//     which is NOT the viewport, so MUI `xs/md` breakpoints would mislay it. We
//     use a CSS Grid `auto-fit` track — `repeat(auto-fit, minmax(min(100%,B),1fr))`
//     — which packs as many equal columns of ≥ B as the real column width fits
//     and stretches them to fill, then wraps. One knob (the min basis) yields
//     1 column on a phone, 2–3 on a tablet, 3+ on desktop, for ANY number of
//     controls/readouts, with zero media queries. `min(100%,B)` guarantees a
//     single control never overflows a narrow column.
const CONTROL_MIN = "240px"; // a slider/segmented stays usable at this width
const READOUT_MIN = "140px"; // a KPI chip is compact; more fit per row

function autoGrid(min: string): object {
  return {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}), 1fr))`,
    alignItems: "end",
  };
}

/** Wrap a chart in a unified card WHEN it declares docked `controls`/`readouts`
 *  — the plot on top, a self-arranging controls grid below it, then a readout
 *  chip grid — so the tunable and its visual effect read as one unit. A chart
 *  with neither renders frameless, exactly as before (no corpus-wide restyle). */
function ChartPanel({
  block,
  signals,
  kernel,
  children,
}: {
  block: ChartBlockT;
  signals: Record<string, Signal>;
  kernel: Kernel;
  children: ReactNode;
}): JSX.Element {
  const controls = block.controls ?? [];
  const readouts = block.readouts ?? [];
  if (controls.length === 0 && readouts.length === 0) return <>{children}</>;
  return (
    <Box
      sx={{
        my: 1,
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        bgcolor: "background.paper",
        overflow: "hidden",
      }}
    >
      <Box sx={{ px: 1, pt: 1 }}>{children}</Box>
      {controls.length > 0
        ? (
          <Box
            sx={{
              ...autoGrid(CONTROL_MIN),
              columnGap: 2,
              rowGap: 1,
              px: 2,
              py: 1.5,
              borderTop: 1,
              borderColor: "divider",
            }}
          >
            {controls.map((c, i) => (
              <Box key={i} sx={{ minWidth: 0 }}>
                <DockedControl control={c} signals={signals} kernel={kernel} />
              </Box>
            ))}
          </Box>
        )
        : null}
      {readouts.length > 0
        ? (
          <Box
            sx={{
              ...autoGrid(READOUT_MIN),
              columnGap: 2.5,
              rowGap: 1,
              px: 2,
              py: 1.25,
              borderTop: 1,
              borderColor: "divider",
              bgcolor: "action.hover",
            }}
          >
            {readouts.map((m, i) => (
              <ReadoutChip key={i} metric={m} kernel={kernel} />
            ))}
          </Box>
        )
        : null}
    </Box>
  );
}

function ChartEmpty(
  { title, msg }: { title?: string | undefined; msg: string },
): JSX.Element {
  return (
    <Box
      sx={{
        my: 1,
        p: 3,
        minHeight: "8rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 1,
        border: 1,
        borderStyle: "dashed",
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Typography variant="body2" color="text.secondary">
        {title ? `${title}: ${msg}` : msg}
      </Typography>
    </Box>
  );
}

// ── themed axis/tooltip props (dark-mode legible) ─────────────────────────────

function axisStroke(theme: Theme): string {
  return theme.palette.text.secondary;
}
function tooltipProps(theme: Theme): {
  contentStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  itemStyle: React.CSSProperties;
} {
  return {
    contentStyle: {
      background: theme.palette.background.paper,
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: 8,
      color: theme.palette.text.primary,
      fontSize: 12,
    },
    labelStyle: { color: theme.palette.text.secondary },
    itemStyle: { color: theme.palette.text.primary },
  };
}

const AXIS_TICK = { fontSize: 12 } as const;
const LEGEND_STYLE = { fontSize: 12 } as const;

// ── reactive overlays ─────────────────────────────────────────────────────────

/** Reference lines/bands as recharts children. Colours from the theme; a null
 *  (unavailable) signal simply omits the overlay. */
function overlayElements(
  overlays: Overlay[] | undefined,
  kernel: Kernel,
  theme: Theme,
): ReactNode[] {
  if (!overlays) return [];
  const line = theme.palette.warning.main;
  const band = theme.palette.primary.main;
  const out: ReactNode[] = [];
  // Only include `label` when the overlay names one (exactOptionalPropertyTypes
  // forbids passing `undefined` to recharts' label prop).
  const lbl = (
    text: string | undefined,
  ): {
    label: {
      value: string;
      position: "insideTopRight";
      fill: string;
      fontSize: number;
    };
  } | Record<string, never> =>
    text
      ? {
        label: {
          value: text,
          position: "insideTopRight",
          fill: theme.palette.text.secondary,
          fontSize: 11,
        },
      }
      : {};
  // extendDomain: a signal-driven line/band set beyond the current data range
  // rescales the axis to stay visible (the point of a reactive threshold/alert).
  overlays.forEach((ov, i) => {
    if (ov.overlay === "hLine") {
      const y = readAxis(kernel, ov.value);
      if (y !== null) {
        out.push(
          <ReferenceLine
            key={`o${i}`}
            y={y}
            stroke={line}
            strokeDasharray="4 3"
            ifOverflow="extendDomain"
            {...lbl(ov.label)}
          />,
        );
      }
    } else if (ov.overlay === "vLine") {
      const x = readAxis(kernel, ov.value);
      if (x !== null) {
        out.push(
          <ReferenceLine
            key={`o${i}`}
            x={x}
            stroke={line}
            strokeDasharray="4 3"
            ifOverflow="extendDomain"
            {...lbl(ov.label)}
          />,
        );
      }
    } else if (ov.overlay === "hBand") {
      const y1 = readAxis(kernel, ov.from);
      const y2 = readAxis(kernel, ov.to);
      if (y1 !== null && y2 !== null) {
        out.push(
          <ReferenceArea
            key={`o${i}`}
            y1={y1}
            y2={y2}
            fill={band}
            fillOpacity={0.12}
            ifOverflow="extendDomain"
            {...lbl(ov.label)}
          />,
        );
      }
    } else {
      const x1 = readAxis(kernel, ov.from);
      const x2 = readAxis(kernel, ov.to);
      if (x1 !== null && x2 !== null) {
        out.push(
          <ReferenceArea
            key={`o${i}`}
            x1={x1}
            x2={x2}
            fill={band}
            fillOpacity={0.12}
            ifOverflow="extendDomain"
            {...lbl(ov.label)}
          />,
        );
      }
    }
  });
  return out;
}

// ── histogram binning ─────────────────────────────────────────────────────────

function fmtEdge(n: number): string {
  return Math.abs(n) >= 1000 || Number.isInteger(n)
    ? String(Math.round(n))
    : n.toFixed(2);
}

function histogram(
  values: number[],
  bins: number,
): { bin: string; count: number }[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ bin: fmtEdge(min), count: values.length }];
  const width = (max - min) / bins;
  const buckets = new Array<number>(bins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= bins) idx = bins - 1; // the maximum falls in the last bucket
    if (idx < 0) idx = 0;
    buckets[idx] = (buckets[idx] ?? 0) + 1;
  }
  return buckets.map((count, i) => ({
    bin: `${fmtEdge(min + i * width)}–${fmtEdge(min + (i + 1) * width)}`,
    count,
  }));
}

// ── candlestick custom shape ──────────────────────────────────────────────────

interface CandleShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Record<string, unknown>;
}

/** A recharts `Bar` custom shape drawing an OHLC candle. The bar's value is the
 *  `[low, high]` range, so recharts hands us `y` = pixel(high) and `height` =
 *  the pixel span down to `low`; we linearly interpolate the open/close pixels
 *  inside that span (a linear y-axis) and colour up/down from the theme. */
function makeCandle(
  cfg: {
    open: string;
    high: string;
    low: string;
    close: string;
    up: string;
    down: string;
  },
) {
  return function Candle(props: CandleShapeProps): JSX.Element | null {
    const { x, y, width, height, payload } = props;
    if (x == null || y == null || width == null || height == null || !payload) {
      return null;
    }
    const high = Number(payload[cfg.high]);
    const low = Number(payload[cfg.low]);
    const open = Number(payload[cfg.open]);
    const close = Number(payload[cfg.close]);
    if (![high, low, open, close].every((n) => Number.isFinite(n))) return null;
    const span = high - low;
    const pix = (
      v: number,
    ): number => (span === 0 ? y : y + ((high - v) / span) * height);
    const cx = x + width / 2;
    const color = close >= open ? cfg.up : cfg.down;
    const openY = pix(open);
    const closeY = pix(close);
    const bodyTop = Math.min(openY, closeY);
    const bodyH = Math.max(1, Math.abs(closeY - openY));
    const bodyW = Math.max(1, width * 0.6);
    return (
      <g>
        <line
          x1={cx}
          x2={cx}
          y1={y}
          y2={y + height}
          stroke={color}
          strokeWidth={1}
        />
        <rect
          x={cx - bodyW / 2}
          y={bodyTop}
          width={bodyW}
          height={bodyH}
          fill={color}
          stroke={color}
        />
      </g>
    );
  };
}

/** Cumulate order-book sizes outward from the mid: asks sum up from the lowest
 *  price, bids sum down from the highest — the classic depth "valley". */
function depthData(
  rows: Record<string, unknown>[],
  priceCol: string,
  bidCol: string,
  askCol: string,
): Record<string, unknown>[] {
  const sorted = [...rows].sort((a, b) =>
    Number(a[priceCol]) - Number(b[priceCol])
  );
  let ask = 0;
  const out = sorted.map((r) => {
    ask += Math.max(0, Number(r[askCol]) || 0);
    return { ...r, _ask: ask } as Record<string, unknown>;
  });
  let bid = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    bid += Math.max(0, Number(out[i]?.[bidCol]) || 0);
    const row = out[i];
    if (row) row["_bid"] = bid;
  }
  return out;
}

// ── the chart dispatch (exhaustive) ───────────────────────────────────────────

export default function ChartBlock({
  block,
  kernel,
  signals,
}: {
  block: ChartBlockT;
  kernel: Kernel;
  signals: Record<string, Signal>;
}): JSX.Element {
  const theme = useTheme();
  const remountKey = useRemountOnVisible();
  // Legend-click isolation: clicking a series in the legend focuses it (others
  // dim); click again to restore. Pure local UI state — no signal, no author
  // syntax, so it stays sound. The clicked series is keyed by its dataKey.
  const [activeSeries, setActiveSeries] = useState<string | null>(null);
  const legendClick = (o: { dataKey?: unknown; value?: unknown }): void => {
    // Line/area/bar legends carry the series `dataKey` (a column); a scatter
    // legend carries the group `value` (a name). Isolate by whichever is a string.
    const k = typeof o.dataKey === "string"
      ? o.dataKey
      : typeof o.value === "string"
      ? o.value
      : null;
    setActiveSeries((cur) => (cur === k ? null : k));
  };
  // Effective series emphasis: a manual legend click wins; otherwise the
  // optional `highlight` signal (fed by a docked segmented/select control) picks
  // the emphasised series, so the control visibly COMMANDS the plot — not just a
  // readout number below it. A series matches by its column OR its display label,
  // so `highlight` can point at either spelling.
  //
  // Crucially we only dim series that are IN the highlight control's option set
  // (e.g. the three MAs a segmented control offers) — any series NOT among the
  // options (a price/benchmark line the reader compares against) stays bold as
  // the anchor. So picking "SMA5" bolds SMA5, keeps price prominent, and ghosts
  // only the other MAs. With a plain string highlight (no options) there is no
  // anchor set, so it falls back to isolating the picked series.
  const hlRaw = block.highlight ? kernel.get(block.highlight) : undefined;
  const highlightVal =
    typeof hlRaw === "string" && hlRaw !== "" && !isUnavailable(hlRaw)
      ? hlRaw
      : null;
  const hlWidget = block.highlight ? signals[block.highlight]?.widget : undefined;
  const hlOptions: string[] = hlWidget && "options" in hlWidget
    ? hlWidget.options.map((o) => String(o.value))
    : [];
  const inPickSet = (col: string, label?: string): boolean =>
    hlOptions.includes(col) || (label !== undefined && hlOptions.includes(label));
  const emphActive = activeSeries !== null || highlightVal !== null;
  const seriesOpacity = (col: string, label?: string): number => {
    if (!emphActive) return 1;
    // Legend isolation: dim everything but the clicked series.
    if (activeSeries !== null) {
      return activeSeries === col || activeSeries === label ? 1 : 0.16;
    }
    // Highlight: the picked series is bold; a non-pickable anchor (price) stays
    // bold; only the other members of the pick-set ghost.
    if (col === highlightVal || label === highlightVal) return 1;
    if (hlOptions.length > 0 && !inPickSet(col, label)) return 1;
    return 0.16;
  };

  const ds = kernel.data(block.data);
  const rows = ds?.rows ?? null;

  // Click-to-select binding (from a `from` signal): clicking a categorical datum
  // writes `datum[column]` into the bound signal, cross-filtering other charts.
  // The current value also highlights the picked category here.
  const sel = block.id ? kernel.selection(block.id) : null;
  const rawSelected = sel ? kernel.get(sel.signal) : undefined;
  const selectedValue =
    rawSelected != null && !isUnavailable(rawSelected) && rawSelected !== ""
      ? rawSelected
      : null;
  const catOpacity = (
    v: unknown,
  ): number => (selectedValue === null || String(v) === String(selectedValue)
    ? 1
    : 0.28);
  // Emit the bound column from a clicked datum. recharts' Bar/Cell click hands
  // the datum directly (its `payload` is the row) — reliable even for a
  // synthetic click, unlike the chart-level `activeIndex` (only set on hover).
  const onPickDatum = (d: { payload?: Record<string, unknown> }): void => {
    const row = d.payload;
    if (sel && row && Object.hasOwn(row, sel.column)) {
      kernel.set(sel.signal, row[sel.column]);
    }
  };

  if (!rows || rows.length === 0) {
    return (
      <ChartPanel block={block} signals={signals} kernel={kernel}>
        <ChartEmpty title={block.title} msg="no data available" />
      </ChartPanel>
    );
  }
  const colors = palette(theme);
  const stroke = axisStroke(theme);
  const tip = tooltipProps(theme);
  const mark = block.mark;
  const numericX = (col: string): boolean => {
    const t = ds?.columns[col];
    return t === "number" || t === "integer";
  };

  // The plot itself — wrapped by ChartPanel so any docked controls/readouts
  // frame it as one card (frameless when it declares none).
  const renderChart = (): JSX.Element => {
    switch (mark.chart) {
      case "line":
        return (
          <ChartFrame title={block.title} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={rows}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey={mark.x.column}
                  type={numericX(mark.x.column) ? "number" : "category"}
                  stroke={stroke}
                  tick={AXIS_TICK}
                />
                <YAxis
                  stroke={stroke}
                  tick={AXIS_TICK}
                  width={44}
                  domain={fitDomain(
                    mark.y.flatMap((s) => numColumn(rows, s.column)),
                  )}
                />
                <Tooltip {...tip} {...TOOLTIP_PIN} />
                {mark.y.length > 1
                  ? <Legend wrapperStyle={LEGEND_STYLE} onClick={legendClick} />
                  : null}
                {mark.y.map((s, i) => (
                  <Line
                    key={s.column}
                    type={mark.curved ? "monotone" : "linear"}
                    dataKey={s.column}
                    name={labelOf(s)}
                    stroke={colorAt(colors, i)}
                    strokeWidth={2}
                    strokeOpacity={seriesOpacity(s.column, labelOf(s))}
                    dot={false}
                    activeDot={{ r: 5, strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                ))}
                {overlayElements(block.overlays, kernel, theme)}
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>
        );

      case "area":
        return (
          <ChartFrame title={block.title} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={rows}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey={mark.x.column}
                  type={numericX(mark.x.column) ? "number" : "category"}
                  stroke={stroke}
                  tick={AXIS_TICK}
                />
                <YAxis stroke={stroke} tick={AXIS_TICK} width={44} />
                <Tooltip {...tip} {...TOOLTIP_PIN} />
                {mark.y.length > 1
                  ? <Legend wrapperStyle={LEGEND_STYLE} onClick={legendClick} />
                  : null}
                {mark.y.map((s, i) => {
                  const c = colorAt(colors, i);
                  const op = seriesOpacity(s.column, labelOf(s));
                  return (
                    <Area
                      key={s.column}
                      type="monotone"
                      dataKey={s.column}
                      name={labelOf(s)}
                      {...(mark.stacked ? { stackId: "stack" } : {})}
                      stroke={c}
                      fill={c}
                      fillOpacity={0.25 * op}
                      strokeOpacity={op}
                      strokeWidth={2}
                      activeDot={{ r: 5, strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  );
                })}
                {overlayElements(block.overlays, kernel, theme)}
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
        );

      case "bar": {
        const xCol = mark.x.column;
        return (
          <ChartFrame title={block.title} selectable={!!sel} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis dataKey={xCol} stroke={stroke} tick={AXIS_TICK} />
                <YAxis stroke={stroke} tick={AXIS_TICK} width={44} />
                <Tooltip
                  {...tip}
                  {...TOOLTIP_PIN}
                  cursor={{ fill: theme.palette.action.hover }}
                />
                {mark.y.length > 1
                  ? <Legend wrapperStyle={LEGEND_STYLE} onClick={legendClick} />
                  : null}
                {mark.y.map((s, i) => (
                  <Bar
                    key={s.column}
                    dataKey={s.column}
                    name={labelOf(s)}
                    {...(mark.stacked ? { stackId: "stack" } : {})}
                    fill={colorAt(colors, i)}
                    fillOpacity={seriesOpacity(s.column, labelOf(s))}
                    isAnimationActive={false}
                    {...(sel ? { onClick: onPickDatum } : {})}
                  >
                    {sel
                      ? rows.map((r, ri) => (
                        <Cell
                          key={ri}
                          fillOpacity={seriesOpacity(s.column, labelOf(s)) *
                            catOpacity(r[xCol])}
                        />
                      ))
                      : null}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      case "barHorizontal": {
        const catCol = mark.category.column;
        return (
          <ChartFrame title={block.title} selectable={!!sel} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis type="number" stroke={stroke} tick={AXIS_TICK} />
                <YAxis
                  type="category"
                  dataKey={catCol}
                  stroke={stroke}
                  tick={AXIS_TICK}
                  width={96}
                />
                <Tooltip
                  {...tip}
                  {...TOOLTIP_PIN}
                  cursor={{ fill: theme.palette.action.hover }}
                />
                <Bar
                  dataKey={mark.value.column}
                  name={labelOf(mark.value)}
                  fill={colorAt(colors, 0)}
                  isAnimationActive={false}
                  {...(sel ? { onClick: onPickDatum } : {})}
                >
                  {rows.map((r, i) => (
                    <Cell
                      key={i}
                      fill={colorAt(colors, i)}
                      fillOpacity={catOpacity(r[catCol])}
                    />
                  ))}
                </Bar>
                {overlayElements(block.overlays, kernel, theme)}
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      case "pie": {
        const pieData = rows
          .map((r) => ({
            name: String(r[mark.category.column]),
            value: Number(r[mark.value.column]),
            row: r,
          }))
          .filter((d) => Number.isFinite(d.value));
        const pieClick = (
          d: {
            payload?: { row?: Record<string, unknown> };
            row?: Record<string, unknown>;
          },
        ): void => {
          const row = d.payload?.row ?? d.row;
          if (sel && row && Object.hasOwn(row, sel.column)) {
            kernel.set(sel.signal, row[sel.column]);
          }
        };
        return (
          <ChartFrame title={block.title} selectable={!!sel} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={mark.donut ? "55%" : 0}
                  outerRadius="80%"
                  stroke={theme.palette.background.paper}
                  isAnimationActive={false}
                  onClick={pieClick}
                  label={(e: { name?: string }) => e.name ?? ""}
                >
                  {pieData.map((d, i) => (
                    <Cell
                      key={i}
                      fill={colorAt(colors, i)}
                      fillOpacity={catOpacity(d.name)}
                    />
                  ))}
                </Pie>
                <Tooltip {...tip} {...TOOLTIP_PIN} />
                <Legend wrapperStyle={LEGEND_STYLE} />
              </PieChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      case "scatter": {
        const size = mark.size;
        const series = mark.series;
        const groups: { name: string; data: Record<string, unknown>[] }[] =
          series
            ? groupBy(rows, series.column)
            : [{ name: labelOf(mark.y), data: rows }];
        return (
          <ChartFrame title={block.title} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis
                  type="number"
                  dataKey={mark.x.column}
                  name={labelOf(mark.x)}
                  stroke={stroke}
                  tick={AXIS_TICK}
                  domain={fitDomain(numColumn(rows, mark.x.column))}
                />
                <YAxis
                  type="number"
                  dataKey={mark.y.column}
                  name={labelOf(mark.y)}
                  stroke={stroke}
                  tick={AXIS_TICK}
                  width={44}
                  domain={fitDomain(numColumn(rows, mark.y.column))}
                />
                {size
                  ? (
                    <ZAxis
                      type="number"
                      dataKey={size.column}
                      range={[40, 400]}
                      name={labelOf(size)}
                    />
                  )
                  : null}
                <Tooltip
                  {...tip}
                  {...TOOLTIP_PIN}
                  cursor={{ strokeDasharray: "3 3" }}
                />
                {groups.length > 1
                  ? <Legend wrapperStyle={LEGEND_STYLE} onClick={legendClick} />
                  : null}
                {groups.map((g, i) => (
                  <Scatter
                    key={g.name}
                    name={g.name}
                    data={g.data}
                    fill={colorAt(colors, i)}
                    fillOpacity={seriesOpacity(g.name, g.name)}
                    isAnimationActive={false}
                  />
                ))}
                {overlayElements(block.overlays, kernel, theme)}
              </ScatterChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      case "histogram": {
        const data = histogram(
          numColumn(rows, mark.value.column),
          mark.bins ?? 10,
        );
        return (
          <ChartFrame title={block.title} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey="bin"
                  stroke={stroke}
                  tick={{ fontSize: 10 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  stroke={stroke}
                  tick={AXIS_TICK}
                  width={44}
                  allowDecimals={false}
                />
                <Tooltip
                  {...tip}
                  {...TOOLTIP_PIN}
                  cursor={{ fill: theme.palette.action.hover }}
                />
                <Bar
                  dataKey="count"
                  name={labelOf(mark.value)}
                  fill={colorAt(colors, 0)}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      case "candlestick": {
        const lows = numColumn(rows, mark.low.column);
        const highs = numColumn(rows, mark.high.column);
        const lo = lows.length ? Math.min(...lows) : 0;
        const hi = highs.length ? Math.max(...highs) : 1;
        const pad = (hi - lo) * 0.05 || 1;
        const Candle = makeCandle({
          open: mark.open.column,
          high: mark.high.column,
          low: mark.low.column,
          close: mark.close.column,
          up: theme.palette.success.main,
          down: theme.palette.error.main,
        });
        const candleData = rows.map((r) => ({
          ...r,
          _hl: [Number(r[mark.low.column]), Number(r[mark.high.column])],
        }));
        const mas = mark.ma ?? [];
        return (
          <ChartFrame title={block.title} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={candleData}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey={mark.x.column}
                  type={numericX(mark.x.column) ? "number" : "category"}
                  stroke={stroke}
                  tick={AXIS_TICK}
                />
                <YAxis
                  stroke={stroke}
                  tick={AXIS_TICK}
                  width={48}
                  domain={[lo - pad, hi + pad]}
                  allowDataOverflow
                />
                <Tooltip {...tip} {...TOOLTIP_PIN} />
                {mas.length > 0
                  ? <Legend wrapperStyle={LEGEND_STYLE} onClick={legendClick} />
                  : null}
                <Bar
                  dataKey="_hl"
                  shape={Candle}
                  legendType="none"
                  isAnimationActive={false}
                />
                {mas.map((m, i) => (
                  <Line
                    key={m.column}
                    type="monotone"
                    dataKey={m.column}
                    name={labelOf(m)}
                    stroke={colorAt(colors, i)}
                    strokeWidth={1.5}
                    strokeOpacity={seriesOpacity(m.column, labelOf(m))}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
                {overlayElements(block.overlays, kernel, theme)}
              </ComposedChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      case "volume": {
        const openCol = mark.open?.column;
        const closeCol = mark.close?.column;
        const directional = openCol !== undefined && closeCol !== undefined;
        const up = theme.palette.success.main;
        const down = theme.palette.error.main;
        return (
          <ChartFrame title={block.title} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey={mark.x.column}
                  type={numericX(mark.x.column) ? "number" : "category"}
                  stroke={stroke}
                  tick={AXIS_TICK}
                />
                <YAxis stroke={stroke} tick={AXIS_TICK} width={44} />
                <Tooltip
                  {...tip}
                  {...TOOLTIP_PIN}
                  cursor={{ fill: theme.palette.action.hover }}
                />
                <Bar
                  dataKey={mark.value.column}
                  name={labelOf(mark.value)}
                  isAnimationActive={false}
                >
                  {rows.map((r, i) => {
                    const fill = directional
                      ? Number(r[closeCol]) >= Number(r[openCol]) ? up : down
                      : colorAt(colors, 0);
                    return <Cell key={i} fill={fill} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      case "depth": {
        const data = depthData(
          rows,
          mark.price.column,
          mark.bid.column,
          mark.ask.column,
        );
        const up = theme.palette.success.main;
        const down = theme.palette.error.main;
        return (
          <ChartFrame title={block.title} remountKey={remountKey}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
              >
                <CartesianGrid
                  stroke={theme.palette.divider}
                  strokeDasharray="3 3"
                />
                <XAxis
                  type="number"
                  dataKey={mark.price.column}
                  name={labelOf(mark.price)}
                  stroke={stroke}
                  tick={AXIS_TICK}
                  domain={["dataMin", "dataMax"]}
                />
                <YAxis stroke={stroke} tick={AXIS_TICK} width={44} />
                <Tooltip {...tip} {...TOOLTIP_PIN} />
                <Legend wrapperStyle={LEGEND_STYLE} />
                <Area
                  type="stepBefore"
                  dataKey="_bid"
                  name="Bids"
                  stroke={up}
                  fill={up}
                  fillOpacity={0.25}
                  isAnimationActive={false}
                  connectNulls
                />
                <Area
                  type="stepAfter"
                  dataKey="_ask"
                  name="Asks"
                  stroke={down}
                  fill={down}
                  fillOpacity={0.25}
                  isAnimationActive={false}
                  connectNulls
                />
                {overlayElements(block.overlays, kernel, theme)}
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
        );
      }

      default:
        return assertNever(mark);
    }
  };

  return (
    <ChartPanel block={block} signals={signals} kernel={kernel}>
      {renderChart()}
    </ChartPanel>
  );
}

function groupBy(
  rows: Record<string, unknown>[],
  col: string,
): { name: string; data: Record<string, unknown>[] }[] {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const key = String(r[col]);
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return [...map.entries()].map(([name, data]) => ({ name, data }));
}

function assertNever(x: never): never {
  throw new Error(`unhandled chart mark: ${JSON.stringify(x)}`);
}
