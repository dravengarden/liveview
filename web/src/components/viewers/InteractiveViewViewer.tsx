// Top-level viewer for a `*.interactive-view.json` document. Parses the content,
// refuses an unknown schema major, builds the reactive kernel once, and renders
// the view in the same centred reading column the other viewers use. Every block
// is individually error-bounded (see blocks.tsx §9), and a parse failure shows a
// graceful notice rather than crashing the reader.

import { useMemo, type JSX } from "react";
import { Alert, Box } from "@mui/material";
import { READING_COLUMN_MAX, type Theme } from "@/types";
import { renderView } from "./interactive-view/blocks";
import { Kernel } from "./interactive-view/kernel";
import { SUPPORTED_MAJOR, type Document } from "./interactive-view/types";

interface InteractiveViewViewerProps {
  content: string | null;
  // Accepted for parity with the other viewers' signatures; theming comes from
  // the app's MUI provider, so this viewer needs no per-render theme branching.
  theme: Theme;
}

type ParseState =
  | { ok: true; doc: Document; kernel: Kernel }
  | { ok: false; message: string };

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
  return { ok: true, doc, kernel: new Kernel(doc) };
}

export function InteractiveViewViewer({ content }: InteractiveViewViewerProps): JSX.Element {
  // Rebuild only when the source changes; a new IR resets signals to their
  // `init` (the documented mid-interaction-update behaviour, §11).
  const state = useMemo(() => build(content), [content]);

  return (
    <Box sx={{ flex: 1, overflow: "auto" }}>
      <Box sx={{ maxWidth: `${READING_COLUMN_MAX}px`, mx: "auto", px: 2, py: 3 }}>
        {state.ok ? (
          renderView(state.doc.view ?? [], state.doc.signals ?? {}, state.kernel)
        ) : (
          <Alert severity="warning">{state.message}</Alert>
        )}
      </Box>
    </Box>
  );
}
