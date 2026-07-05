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

import type { JSX, ReactNode } from "react";
import { Box, Typography, useTheme } from "@mui/material";
import type { Theme } from "@mui/material";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import type { Block, ChartField, Overlay } from "./types";
import type { Kernel } from "./kernel";
import { isUnavailable } from "./expr";

type ChartBlockT = Extract<Block, { block: "chart" }>;

const CHART_HEIGHT = 300;

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

// ── framing + empty state ─────────────────────────────────────────────────────

function ChartFrame({ title, children }: { title?: string | undefined; children: ReactNode }): JSX.Element {
  return (
    <Box sx={{ my: 1 }}>
      {title ? (
        <Typography variant="subtitle2" sx={{ mb: 1, color: "text.secondary" }}>
          {title}
        </Typography>
      ) : null}
      <Box sx={{ width: "100%", height: CHART_HEIGHT }}>{children}</Box>
    </Box>
  );
}

function ChartEmpty({ title, msg }: { title?: string | undefined; msg: string }): JSX.Element {
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
function overlayElements(overlays: Overlay[] | undefined, kernel: Kernel, theme: Theme): ReactNode[] {
  if (!overlays) return [];
  const line = theme.palette.warning.main;
  const band = theme.palette.primary.main;
  const out: ReactNode[] = [];
  // Only include `label` when the overlay names one (exactOptionalPropertyTypes
  // forbids passing `undefined` to recharts' label prop).
  const lbl = (text: string | undefined): { label: { value: string; position: "insideTopRight"; fill: string; fontSize: number } } | Record<string, never> =>
    text ? { label: { value: text, position: "insideTopRight", fill: theme.palette.text.secondary, fontSize: 11 } } : {};
  overlays.forEach((ov, i) => {
    if (ov.overlay === "hLine") {
      const y = readAxis(kernel, ov.value);
      if (y !== null) out.push(<ReferenceLine key={`o${i}`} y={y} stroke={line} strokeDasharray="4 3" {...lbl(ov.label)} />);
    } else if (ov.overlay === "vLine") {
      const x = readAxis(kernel, ov.value);
      if (x !== null) out.push(<ReferenceLine key={`o${i}`} x={x} stroke={line} strokeDasharray="4 3" {...lbl(ov.label)} />);
    } else if (ov.overlay === "hBand") {
      const y1 = readAxis(kernel, ov.from);
      const y2 = readAxis(kernel, ov.to);
      if (y1 !== null && y2 !== null) out.push(<ReferenceArea key={`o${i}`} y1={y1} y2={y2} fill={band} fillOpacity={0.12} {...lbl(ov.label)} />);
    } else {
      const x1 = readAxis(kernel, ov.from);
      const x2 = readAxis(kernel, ov.to);
      if (x1 !== null && x2 !== null) out.push(<ReferenceArea key={`o${i}`} x1={x1} x2={x2} fill={band} fillOpacity={0.12} {...lbl(ov.label)} />);
    }
  });
  return out;
}

// ── histogram binning ─────────────────────────────────────────────────────────

function fmtEdge(n: number): string {
  return Math.abs(n) >= 1000 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2);
}

function histogram(values: number[], bins: number): { bin: string; count: number }[] {
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
  return buckets.map((count, i) => ({ bin: `${fmtEdge(min + i * width)}–${fmtEdge(min + (i + 1) * width)}`, count }));
}

// ── the chart dispatch (exhaustive) ───────────────────────────────────────────

export default function ChartBlock({ block, kernel }: { block: ChartBlockT; kernel: Kernel }): JSX.Element {
  const theme = useTheme();
  const ds = kernel.data(block.data);
  const rows = ds?.rows ?? null;
  if (!rows || rows.length === 0) {
    return <ChartEmpty title={block.title} msg="no data available" />;
  }
  const colors = palette(theme);
  const stroke = axisStroke(theme);
  const tip = tooltipProps(theme);
  const mark = block.mark;
  const numericX = (col: string): boolean => {
    const t = ds?.columns[col];
    return t === "number" || t === "integer";
  };

  switch (mark.chart) {
    case "line":
      return (
        <ChartFrame title={block.title}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis dataKey={mark.x.column} type={numericX(mark.x.column) ? "number" : "category"} stroke={stroke} tick={AXIS_TICK} />
              <YAxis stroke={stroke} tick={AXIS_TICK} width={44} />
              <Tooltip {...tip} />
              {mark.y.length > 1 ? <Legend wrapperStyle={LEGEND_STYLE} /> : null}
              {mark.y.map((s, i) => (
                <Line
                  key={s.column}
                  type={mark.curved ? "monotone" : "linear"}
                  dataKey={s.column}
                  name={labelOf(s)}
                  stroke={colorAt(colors, i)}
                  strokeWidth={2}
                  dot={false}
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
        <ChartFrame title={block.title}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis dataKey={mark.x.column} type={numericX(mark.x.column) ? "number" : "category"} stroke={stroke} tick={AXIS_TICK} />
              <YAxis stroke={stroke} tick={AXIS_TICK} width={44} />
              <Tooltip {...tip} />
              {mark.y.length > 1 ? <Legend wrapperStyle={LEGEND_STYLE} /> : null}
              {mark.y.map((s, i) => {
                const c = colorAt(colors, i);
                return (
                  <Area
                    key={s.column}
                    type="monotone"
                    dataKey={s.column}
                    name={labelOf(s)}
                    {...(mark.stacked ? { stackId: "stack" } : {})}
                    stroke={c}
                    fill={c}
                    fillOpacity={0.25}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                );
              })}
              {overlayElements(block.overlays, kernel, theme)}
            </AreaChart>
          </ResponsiveContainer>
        </ChartFrame>
      );

    case "bar":
      return (
        <ChartFrame title={block.title}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis dataKey={mark.x.column} stroke={stroke} tick={AXIS_TICK} />
              <YAxis stroke={stroke} tick={AXIS_TICK} width={44} />
              <Tooltip {...tip} cursor={{ fill: theme.palette.action.hover }} />
              {mark.y.length > 1 ? <Legend wrapperStyle={LEGEND_STYLE} /> : null}
              {mark.y.map((s, i) => (
                <Bar
                  key={s.column}
                  dataKey={s.column}
                  name={labelOf(s)}
                  {...(mark.stacked ? { stackId: "stack" } : {})}
                  fill={colorAt(colors, i)}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      );

    case "barHorizontal":
      return (
        <ChartFrame title={block.title}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis type="number" stroke={stroke} tick={AXIS_TICK} />
              <YAxis type="category" dataKey={mark.category.column} stroke={stroke} tick={AXIS_TICK} width={96} />
              <Tooltip {...tip} cursor={{ fill: theme.palette.action.hover }} />
              <Bar dataKey={mark.value.column} name={labelOf(mark.value)} fill={colorAt(colors, 0)} isAnimationActive={false}>
                {rows.map((_r, i) => (
                  <Cell key={i} fill={colorAt(colors, i)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      );

    case "pie": {
      const pieData = rows
        .map((r) => ({ name: String(r[mark.category.column]), value: Number(r[mark.value.column]) }))
        .filter((d) => Number.isFinite(d.value));
      return (
        <ChartFrame title={block.title}>
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
                label={(e: { name?: string }) => e.name ?? ""}
              >
                {pieData.map((_d, i) => (
                  <Cell key={i} fill={colorAt(colors, i)} />
                ))}
              </Pie>
              <Tooltip {...tip} />
              <Legend wrapperStyle={LEGEND_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        </ChartFrame>
      );
    }

    case "scatter": {
      const size = mark.size;
      const series = mark.series;
      const groups: { name: string; data: Record<string, unknown>[] }[] = series
        ? groupBy(rows, series.column)
        : [{ name: labelOf(mark.y), data: rows }];
      return (
        <ChartFrame title={block.title}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis type="number" dataKey={mark.x.column} name={labelOf(mark.x)} stroke={stroke} tick={AXIS_TICK} />
              <YAxis type="number" dataKey={mark.y.column} name={labelOf(mark.y)} stroke={stroke} tick={AXIS_TICK} width={44} />
              {size ? <ZAxis type="number" dataKey={size.column} range={[40, 400]} name={labelOf(size)} /> : null}
              <Tooltip {...tip} cursor={{ strokeDasharray: "3 3" }} />
              {groups.length > 1 ? <Legend wrapperStyle={LEGEND_STYLE} /> : null}
              {groups.map((g, i) => (
                <Scatter key={g.name} name={g.name} data={g.data} fill={colorAt(colors, i)} isAnimationActive={false} />
              ))}
              {overlayElements(block.overlays, kernel, theme)}
            </ScatterChart>
          </ResponsiveContainer>
        </ChartFrame>
      );
    }

    case "histogram": {
      const data = histogram(numColumn(rows, mark.value.column), mark.bins ?? 10);
      return (
        <ChartFrame title={block.title}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={theme.palette.divider} strokeDasharray="3 3" />
              <XAxis dataKey="bin" stroke={stroke} tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis stroke={stroke} tick={AXIS_TICK} width={44} allowDecimals={false} />
              <Tooltip {...tip} cursor={{ fill: theme.palette.action.hover }} />
              <Bar dataKey="count" name={labelOf(mark.value)} fill={colorAt(colors, 0)} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartFrame>
      );
    }

    default:
      return assertNever(mark);
  }
}

function groupBy(rows: Record<string, unknown>[], col: string): { name: string; data: Record<string, unknown>[] }[] {
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
