// The block renderer — an exhaustive `switch` over `Block` (with a `never`
// default) into MUI. Every block is wrapped in its own error boundary, so a
// failure in one block collapses to a small fallback tile and NEVER white-screens
// the page (§9 runtime resilience). Layout blocks preserve the fit invariant:
// `stack` is full-width, `metricGroup`/`columns` reflow to one column on narrow.

import { Component, type JSX, type ReactNode, useState } from "react";
import { Alert, Box, Tab, Tabs, Typography } from "@mui/material";
import type { AlertColor } from "@mui/material";
import type { Block, CalloutKind, Metric, Signal } from "./types";
import type { Kernel } from "./kernel";
import { evalMetric, interpolate } from "./interpolate";
import { renderWidget } from "./widgets";

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
    <Box sx={{ p: 2, my: 1, borderRadius: 1, border: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Typography variant="body2" color="text.secondary">
        {msg}
      </Typography>
    </Box>
  );
}

class BlockBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <FallbackTile msg="This block couldn't render." /> : this.props.children;
  }
}

/** Render a list of blocks, each in its own boundary (so a sibling failure is
 *  isolated). */
function BlockList({ blocks, ctx, depth }: { blocks: Block[]; ctx: BlockCtx; depth: number }): JSX.Element {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockBoundary key={i}>{blockBody(b, ctx, depth)}</BlockBoundary>
      ))}
    </>
  );
}

/** The public entry: render a document's top-level view. */
export function renderView(blocks: Block[], signals: Record<string, Signal>, kernel: Kernel): JSX.Element {
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
    if (tok.startsWith("**")) nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) nodes.push(<code key={key++}>{tok.slice(1, -1)}</code>);
    else nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
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
        <Typography key={key++} variant={headingVariant((h[1] ?? "").length)} sx={{ mt: 2, mb: 1 }}>
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

function SectionBlock({ md, kernel }: { md: string; kernel: Kernel }): JSX.Element {
  return (
    <Box sx={{ my: 1 }}>
      <MarkdownText md={interpolate(md, kernel)} />
    </Box>
  );
}

const CALLOUT_SEVERITY: Record<CalloutKind, AlertColor> = {
  note: "info",
  tip: "success",
  warning: "warning",
  info: "info",
};

function CalloutBlock({ kind, md, kernel }: { kind: CalloutKind; md: string; kernel: Kernel }): JSX.Element {
  return (
    <Alert severity={CALLOUT_SEVERITY[kind]} sx={{ my: 1 }}>
      <MarkdownText md={interpolate(md, kernel)} />
    </Alert>
  );
}

function MetricTile({ metric, kernel }: { metric: Metric; kernel: Kernel }): JSX.Element {
  const value = evalMetric(metric.value, metric.format, kernel);
  return (
    <Box sx={{ p: 2, borderRadius: 1, border: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        {metric.label}
      </Typography>
      <Typography variant="h6" sx={{ wordBreak: "break-word" }}>
        {value}
      </Typography>
    </Box>
  );
}

function TabsBlock({ items, ctx, depth }: { items: { title: string; children: Block[] }[]; ctx: BlockCtx; depth: number }): JSX.Element {
  const [active, setActive] = useState(0);
  const current = items[active];
  return (
    <Box sx={{ my: 1 }}>
      <Tabs value={active} onChange={(_e, v: number) => setActive(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile>
        {items.map((t, i) => (
          <Tab key={i} label={t.title} />
        ))}
      </Tabs>
      <Box sx={{ pt: 2 }}>{current ? <BlockList blocks={current.children} ctx={ctx} depth={depth + 1} /> : null}</Box>
    </Box>
  );
}

function ChartPlaceholder({ label }: { label: string }): JSX.Element {
  return (
    <Box
      sx={{
        my: 1,
        p: 3,
        minHeight: "8rem",
        display: "flex",
        flexDirection: "column",
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
        {label}
      </Typography>
    </Box>
  );
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
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: 2, my: 1 }}>
          {block.items.map((it, i) => (
            <MetricTile key={i} metric={it} kernel={kernel} />
          ))}
        </Box>
      );
    case "callout":
      return <CalloutBlock kind={block.kind ?? "note"} md={block.md} kernel={kernel} />;
    case "chart":
      return <ChartPlaceholder label={`Chart of “${block.data}” — Phase 2`} />;
    case "table":
      return <ChartPlaceholder label={`Table of “${block.data}” — Phase 3`} />;
    case "input": {
      const declared = block.signal ? signals[block.signal] : undefined;
      const widget = block.widget ?? declared?.widget;
      if (!widget) return <FallbackTile msg="This input has no widget." />;
      return <Box sx={{ my: 1 }}>{renderWidget(widget, block.signal ?? null, kernel)}</Box>;
    }
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
            gridTemplateColumns: { xs: "1fr", md: `repeat(${cols}, minmax(0, 1fr))` },
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
