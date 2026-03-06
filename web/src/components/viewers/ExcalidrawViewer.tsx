import { useEffect, useRef, useMemo } from "react";
import { Box, Typography } from "@mui/material";
import type { Theme } from "@/types";

declare global {
  interface Window {
    ExcalidrawLib?: {
      Excalidraw: React.ComponentType<{
        initialData: {
          elements: unknown[];
          appState: { viewBackgroundColor: string; theme: string };
        };
        viewModeEnabled: boolean;
        zenModeEnabled: boolean;
        gridModeEnabled: boolean;
      }>;
    };
    React?: typeof import("react");
    ReactDOM?: {
      createRoot: (container: Element) => {
        render: (element: React.ReactNode) => void;
        unmount: () => void;
      };
    };
  }
}

interface ExcalidrawViewerProps {
  content: string | null;
  theme: Theme;
}

interface ExcalidrawData {
  elements?: unknown[];
  appState?: {
    viewBackgroundColor?: string;
  };
}

function isDarkTheme(theme: Theme): boolean {
  return !theme.includes("light");
}

export function ExcalidrawViewer({
  content,
  theme,
}: ExcalidrawViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<ReturnType<NonNullable<typeof window.ReactDOM>["createRoot"]> | null>(null);

  const parsedData = useMemo<ExcalidrawData | null>(() => {
    if (!content) return null;
    try {
      return JSON.parse(content) as ExcalidrawData;
    } catch {
      return null;
    }
  }, [content]);

  useEffect(() => {
    if (!containerRef.current || !parsedData) return;

    const loadExcalidraw = async () => {
      if (!window.ExcalidrawLib || !window.React || !window.ReactDOM) {
        return;
      }

      const dark = isDarkTheme(theme);
      const { Excalidraw } = window.ExcalidrawLib;

      const element = window.React.createElement(Excalidraw, {
        initialData: {
          elements: parsedData.elements ?? [],
          appState: {
            viewBackgroundColor: parsedData.appState?.viewBackgroundColor ?? (dark ? "#1e1e1e" : "#ffffff"),
            theme: dark ? "dark" : "light",
          },
        },
        viewModeEnabled: true,
        zenModeEnabled: true,
        gridModeEnabled: false,
      });

      if (!rootRef.current) {
        rootRef.current = window.ReactDOM.createRoot(containerRef.current!);
      }
      rootRef.current.render(element);
    };

    void loadExcalidraw();

    return () => {
      if (rootRef.current) {
        rootRef.current.unmount();
        rootRef.current = null;
      }
    };
  }, [parsedData, theme]);

  if (!content) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        Loading...
      </Box>
    );
  }

  if (!parsedData) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "error.main",
        }}
      >
        <Typography>Failed to parse Excalidraw file</Typography>
      </Box>
    );
  }

  // Fallback if Excalidraw is not loaded
  if (!window.ExcalidrawLib) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
          gap: 2,
        }}
      >
        <Typography>Excalidraw viewer not loaded</Typography>
        <Typography variant="body2">
          {parsedData.elements?.length ?? 0} elements in diagram
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        overflow: "hidden",
        "& .excalidraw": {
          width: "100%",
          height: "100%",
        },
      }}
    />
  );
}
