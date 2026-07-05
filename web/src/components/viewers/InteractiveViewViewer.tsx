// Top-level viewer for a `*.interactive-view.json` document — and the inline
// mount used by a markdown ` ```interactive-view ` fence. Parses the content,
// refuses an unknown schema major, and renders the reactive view. Every block is
// individually error-bounded (see blocks.tsx §9), and a parse failure shows a
// graceful notice rather than crashing the reader.

import { useMemo, type JSX } from "react";
import { Alert, Box } from "@mui/material";
import { READING_COLUMN_MAX, type Theme } from "@/types";
import { renderView } from "./interactive-view/blocks";
import { useKernel } from "./interactive-view/kernel";
import { SUPPORTED_MAJOR, type Document } from "./interactive-view/types";

interface InteractiveViewViewerProps {
  content: string | null;
  // Accepted for parity with the other viewers' signatures; theming comes from
  // the app's MUI provider, so this viewer needs no per-render theme branching.
  theme: Theme;
}

type ParseState = { ok: true; doc: Document } | { ok: false; message: string };

function build(content: string | null): ParseState {
  if (content === null || content.trim() === "") {
    return { ok: false, message: "This interactive view is empty." };
  }
  let doc: Document;
  try {
    doc = JSON.parse(content) as Document;
  } catch {
    return { ok: false, message: "This interactive view could not be parsed (invalid JSON)." };
  }
  if (typeof doc !== "object" || doc === null) {
    return { ok: false, message: "This interactive view is malformed." };
  }
  const major = doc.interactiveView;
  if (typeof major !== "number" || major > SUPPORTED_MAJOR) {
    return {
      ok: false,
      message: `This interactive view needs a newer reader (schema v${String(major)}).`,
    };
  }
  return { ok: true, doc };
}

/** The reactive body — one mounted document. `useKernel` seeds React-owned signal
 *  state here; a widget's `set` re-renders this subtree with fresh values (§reactivity).
 *  Mounted fresh per `content` (the caller keys on it), so signals reset on a
 *  content change without any in-render reset dance. */
function InteractiveViewBody({ doc }: { doc: Document }): JSX.Element {
  const kernel = useKernel(doc);
  return <Box sx={{ my: 2 }}>{renderView(doc.view ?? [], doc.signals ?? {}, kernel)}</Box>;
}

/** The bare interactive view — just the reactive blocks, no page chrome. Used
 *  both by the standalone viewer (wrapped in a reading column) and by the
 *  markdown ` ```interactive-view ` fence (mounted inline in the prose flow, so
 *  the surrounding `.markdown-body` already provides the column + padding).
 *
 *  `key={content}` on the body forces a clean remount when the document changes,
 *  so `useKernel`'s state re-seeds from the new document's `init`s. */
export function InteractiveViewInline({ content }: { content: string | null }): JSX.Element {
  const parsed = useMemo(() => build(content), [content]);
  if (!parsed.ok) return <Alert severity="warning">{parsed.message}</Alert>;
  return <InteractiveViewBody key={content ?? ""} doc={parsed.doc} />;
}

export function InteractiveViewViewer({ content }: InteractiveViewViewerProps): JSX.Element {
  return (
    <Box sx={{ flex: 1, overflow: "auto" }}>
      <Box sx={{ maxWidth: `${READING_COLUMN_MAX}px`, mx: "auto", px: 2, py: 3 }}>
        <InteractiveViewInline content={content} />
      </Box>
    </Box>
  );
}
