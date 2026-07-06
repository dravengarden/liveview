// The block renderer — an exhaustive `switch` over `Block` (with a `never`
// default) into MUI. Every block is wrapped in its own error boundary, so a
// failure in one block collapses to a small fallback tile and NEVER white-screens
// the page (§9 runtime resilience). Layout blocks preserve the fit invariant:
// `stack` is full-width, `metricGroup`/`columns` reflow to one column on narrow.

import {
  Component,
  type JSX,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";
import {
  Alert,
  Box,
  CircularProgress,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Typography,
} from "@mui/material";
import type { AlertColor } from "@mui/material";
import type { Block, CalloutKind, Metric, Signal } from "./types";
import type { Kernel } from "./kernel";
import { isUnavailable } from "./expr";
import { evalMetric, interpolate } from "./interpolate";
import { renderWidget } from "./widgets";

// recharts is heavy — code-split it so only chapters with a chart pull the chunk.
const ChartBlock = lazy(() => import("./charts"));
const ChartGroupBlock = lazy(() =>
  import("./charts").then((m) => ({ default: m.ChartGroupBlock }))
);

/** Max table rows rendered inline (a report table is a preview, not a data dump);
 *  a larger dataset is truncated with a note rather than freezing the reader. */
const MAX_TABLE_ROWS = 100;

interface BlockCtx {
  signals: Record<string, Signal>;
  kernel: Kernel;
}

function assertNever(x: never): never {
  throw new Error(`unhandled block: ${JSON.stringify(x)}`);
}

// ── error boundary + fallback ─────────────────────────────────────────────────

function FallbackTile({ msg }: { msg: string }): JSX.Element {
  return (
    <Box
      sx={{
        p: 2,
        my: 1,
        borderRadius: 1,
        border: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Typography variant="body2" color="text.secondary">
        {msg}
      </Typography>
    </Box>
  );
}

class BlockBoundary
  extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed
      ? <FallbackTile msg="This block couldn't render." />
      : this.props.children;
  }
}

/** Render a list of blocks, each in its own boundary (so a sibling failure is
 *  isolated). */
function BlockList(
  { blocks, ctx, depth }: { blocks: Block[]; ctx: BlockCtx; depth: number },
): JSX.Element {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockBoundary key={i}>{blockBody(b, ctx, depth)}</BlockBoundary>
      ))}
    </>
  );
}

/** The public entry: render a document's top-level view. */
export function renderView(
  blocks: Block[],
  signals: Record<string, Signal>,
  kernel: Kernel,
): JSX.Element {
  return <BlockList blocks={blocks} ctx={{ signals, kernel }} depth={0} />;
}

// ── minimal, safe markdown (headings, bold/italic/code, paragraphs) ───────────

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      nodes.push(<code key={key++}>{tok.slice(1, -1)}</code>);
    } else nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function headingVariant(level: number): "h4" | "h5" | "h6" {
  if (level <= 1) return "h4";
  if (level === 2) return "h5";
  return "h6";
}

function MarkdownText({ md }: { md: string }): JSX.Element {
  const lines = md.split("\n");
  const out: JSX.Element[] = [];
  let para: string[] = [];
  let key = 0;
  const flush = (): void => {
    if (para.length > 0) {
      out.push(
        <Typography key={key++} variant="body1" sx={{ my: 1 }}>
          {renderInline(para.join(" "))}
        </Typography>,
      );
      para = [];
    }
  };
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(
        <Typography
          key={key++}
          variant={headingVariant((h[1] ?? "").length)}
          sx={{ mt: 2, mb: 1 }}
        >
          {renderInline(h[2] ?? "")}
        </Typography>,
      );
    } else if (line.trim() === "") {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return <>{out}</>;
}

// ── leaf components that subscribe to the kernel ──────────────────────────────

function SectionBlock(
  { md, kernel }: { md: string; kernel: Kernel },
): JSX.Element {
  return (
    <Box sx={{ my: 1 }}>
      <MarkdownText md={interpolate(md, kernel)} />
    </Box>
  );
}

// Each callout kind maps to a THEME palette channel (never a hardcoded colour),
// an emoji glyph, and — for `note`/`quote` — no MUI Alert at all, so a neutral
// aside doesn't shout like a green success banner. `success` is reserved for a
// genuinely CONFIRMED result; a plain explanation is `note`. `variant:"outlined"`
// keeps even the coloured ones restrained (a tinted left rule, not a filled bar).
const ALERT_STYLE: Record<
  Exclude<CalloutKind, "note" | "quote">,
  { severity: AlertColor; icon: string }
> = {
  info: { severity: "info", icon: "ℹ️" },
  tip: { severity: "success", icon: "💡" },
  success: { severity: "success", icon: "✅" },
  warning: { severity: "warning", icon: "⚠️" },
  danger: { severity: "error", icon: "🚫" },
};

function CalloutBlock(
  { kind, md, kernel }: { kind: CalloutKind; md: string; kernel: Kernel },
): JSX.Element {
  const body = <MarkdownText md={interpolate(md, kernel)} />;
  // `note` — a neutral aside: a subtle bordered card, no colour, no icon. This
  // is the default and the right choice for a plain explanation.
  if (kind === "note") {
    return (
      <Box
        sx={{
          my: 1,
          px: 2,
          py: 1,
          borderRadius: 1,
          border: 1,
          borderColor: "divider",
          bgcolor: "action.hover",
          color: "text.secondary",
        }}
      >
        {body}
      </Box>
    );
  }
  // `quote` — a definition/citation: a blockquote (thick left rule, italic,
  // muted), visually distinct from every alert.
  if (kind === "quote") {
    return (
      <Box
        component="blockquote"
        sx={{
          my: 1,
          ml: 0,
          pl: 2,
          py: 0.5,
          borderLeft: 4,
          borderColor: "primary.main",
          color: "text.secondary",
          fontStyle: "italic",
        }}
      >
        {body}
      </Box>
    );
  }
  const { severity, icon } = ALERT_STYLE[kind];
  return (
    <Alert
      severity={severity}
      variant="outlined"
      icon={<span aria-hidden>{icon}</span>}
      sx={{ my: 1, alignItems: "flex-start" }}
    >
      {body}
    </Alert>
  );
}

function MetricTile(
  { metric, kernel }: { metric: Metric; kernel: Kernel },
): JSX.Element {
  const value = evalMetric(metric.value, metric.format, kernel);
  return (
    <Box
      sx={{
        p: 2,
        borderRadius: 1,
        border: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block" }}
      >
        {metric.label}
      </Typography>
      <Typography variant="h6" sx={{ wordBreak: "break-word" }}>
        {value}
      </Typography>
    </Box>
  );
}

function TabsBlock(
  { items, ctx, depth }: {
    items: { title: string; children: Block[] }[];
    ctx: BlockCtx;
    depth: number;
  },
): JSX.Element {
  const [active, setActive] = useState(0);
  const current = items[active];
  return (
    <Box sx={{ my: 1 }}>
      <Tabs
        value={active}
        onChange={(_e, v: number) => setActive(v)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
      >
        {items.map((t, i) => <Tab key={i} label={t.title} />)}
      </Tabs>
      <Box sx={{ pt: 2 }}>
        {current
          ? <BlockList blocks={current.children} ctx={ctx} depth={depth + 1} />
          : null}
      </Box>
    </Box>
  );
}

/** The fallback while the recharts chunk loads (chart height reserved so the
 *  page doesn't jump when it swaps in). */
function ChartLoading(): JSX.Element {
  return (
    <Box
      sx={{
        my: 1,
        height: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 1,
        bgcolor: "background.paper",
      }}
    >
      <CircularProgress size={28} />
    </Box>
  );
}

/** A dataset table. Columns default to the dataset's declared schema order; a
 *  large dataset is truncated to a preview (never a freeze). Unavailable data
 *  (a `source` blob not loaded in Phase 2) shows a graceful empty tile. */
function TableBlock(
  { block, kernel }: {
    block: Extract<Block, { block: "table" }>;
    kernel: Kernel;
  },
): JSX.Element {
  const ds = kernel.data(block.data);
  const rows = ds?.rows ?? null;
  const cols = block.columns ?? (ds ? Object.keys(ds.columns) : []);
  if (!ds || !rows) {
    return <FallbackTile msg="This table's data is unavailable." />;
  }
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const truncated = rows.length - shown.length;
  return (
    <Box sx={{ my: 1 }}>
      <TableContainer
        sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}
      >
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {cols.map((c) => (
                <TableCell
                  key={c}
                  sx={{ fontWeight: 600, bgcolor: "background.paper" }}
                >
                  {c}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((r, i) => (
              <TableRow key={i} hover>
                {cols.map((c) => <TableCell key={c}>{cellText(r[c])}
                </TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {truncated > 0
        ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 0.5 }}
          >
            + {truncated} more row{truncated === 1 ? "" : "s"}
          </Typography>
        )
        : null}
    </Box>
  );
}

function cellText(v: unknown): string {
  if (v === undefined || v === null || isUnavailable(v)) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// ── the block dispatch (exhaustive) ───────────────────────────────────────────

function blockBody(block: Block, ctx: BlockCtx, depth: number): JSX.Element {
  const { kernel, signals } = ctx;
  switch (block.block) {
    case "section":
      return <SectionBlock md={block.md} kernel={kernel} />;
    case "metric":
      return <MetricTile metric={block} kernel={kernel} />;
    case "metricGroup":
      return (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
            gap: 2,
            my: 1,
          }}
        >
          {block.items.map((it, i) => (
            <MetricTile key={i} metric={it} kernel={kernel} />
          ))}
        </Box>
      );
    case "callout":
      return (
        <CalloutBlock
          kind={block.kind ?? "note"}
          md={block.md}
          kernel={kernel}
        />
      );
    case "chart":
      return (
        <Suspense fallback={<ChartLoading />}>
          <ChartBlock block={block} kernel={kernel} signals={signals} />
        </Suspense>
      );
    case "chartGroup":
      return (
        <Suspense fallback={<ChartLoading />}>
          <ChartGroupBlock block={block} kernel={kernel} signals={signals} />
        </Suspense>
      );
    case "table":
      return <TableBlock block={block} kernel={kernel} />;
    case "input": {
      const declared = block.signal ? signals[block.signal] : undefined;
      const widget = block.widget ?? declared?.widget;
      if (!widget) return <FallbackTile msg="This input has no widget." />;
      return (
        <Box sx={{ my: 1 }}>
          {renderWidget(widget, block.signal ?? null, kernel)}
        </Box>
      );
    }
    case "panel":
      return (
        <Box
          sx={{
            my: 1,
            px: 2,
            py: 1,
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            bgcolor: "background.paper",
          }}
        >
          {block.title
            ? (
              <Typography
                variant="subtitle2"
                sx={{ color: "text.secondary", mt: 0.5, mb: 1 }}
              >
                {block.title}
              </Typography>
            )
            : null}
          <BlockList blocks={block.children} ctx={ctx} depth={depth + 1} />
        </Box>
      );
    case "stack":
      return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, my: 1 }}>
          <BlockList blocks={block.children} ctx={ctx} depth={depth + 1} />
        </Box>
      );
    case "columns": {
      const cols = Math.max(1, block.children.length);
      return (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              md: `repeat(${cols}, minmax(0, 1fr))`,
            },
            gap: 2,
            my: 1,
          }}
        >
          <BlockList blocks={block.children} ctx={ctx} depth={depth + 1} />
        </Box>
      );
    }
    case "tabs":
      return <TabsBlock items={block.items} ctx={ctx} depth={depth} />;
    default:
      return assertNever(block);
  }
}
