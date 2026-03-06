import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { ThemeProvider, CssBaseline, Box, IconButton, Tooltip } from "@mui/material";
import { Menu as MenuIcon, Settings as SettingsIcon } from "@mui/icons-material";
import { Sidebar, SettingsDialog, ContentViewer } from "@/components";
import { useWebSocket, useTheme, useSettings } from "@/hooks";
import type { TreeNode, FileType, FileContent } from "@/types";

const DEFAULT_SIDEBAR_WIDTH = 280;

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : "";
}

function filterTreeByExtensions(nodes: TreeNode[], enabledExtensions: Set<string>): TreeNode[] {
  return nodes
    .map((node) => {
      if (node.is_dir) {
        const filteredChildren = filterTreeByExtensions(node.children, enabledExtensions);
        if (filteredChildren.length > 0) {
          return { ...node, children: filteredChildren };
        }
        return null;
      }
      const ext = getFileExtension(node.name);
      return enabledExtensions.has(ext) ? node : null;
    })
    .filter((node): node is TreeNode => node !== null);
}

function findReadme(nodes: TreeNode[]): string | null {
  for (const node of nodes) {
    if (!node.is_dir && node.name.toLowerCase() === "readme.md") {
      return node.path;
    }
  }
  for (const node of nodes) {
    if (node.is_dir && node.children.length > 0) {
      const found = findReadme(node.children);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function getPathFromHash(): string | null {
  const hash = window.location.hash;
  if (hash.startsWith("#")) {
    return decodeURIComponent(hash.slice(1)) || null;
  }
  return null;
}

function pushPathToHash(path: string | null): void {
  if (path) {
    window.history.pushState(null, "", `#${encodeURIComponent(path)}`);
  } else {
    window.history.pushState(null, "", window.location.pathname);
  }
}

function replacePathToHash(path: string | null): void {
  if (path) {
    window.history.replaceState(null, "", `#${encodeURIComponent(path)}`);
  } else {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

interface FloatButtonProps {
  position: "left" | "right";
  floatOpacity: number;
  children: React.ReactNode;
}

function FloatButton({ position, floatOpacity, children }: FloatButtonProps): React.JSX.Element {
  const isLeft = position === "left";

  return (
    <Box
      sx={{
        position: "absolute",
        top: 12,
        [position]: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "rgba(128, 128, 128, 0.15)",
        borderRadius: isLeft ? "0 4px 4px 0" : "4px 0 0 4px",
        opacity: floatOpacity,
        transition: "all 0.2s ease",
        width: 20,
        height: 36,
        cursor: "pointer",
        "&:hover": {
          opacity: 1,
          bgcolor: "background.paper",
          boxShadow: isLeft ? "2px 0 8px rgba(0,0,0,0.1)" : "-2px 0 8px rgba(0,0,0,0.1)",
          width: "auto",
          px: 0.5,
          "& .float-arrow": {
            display: "none",
          },
          "& .float-buttons": {
            display: "flex",
          },
        },
      }}
    >
      <Box
        className="float-arrow"
        sx={{
          width: 0,
          height: 0,
          borderTop: "5px solid transparent",
          borderBottom: "5px solid transparent",
          ...(isLeft
            ? { borderLeft: "6px solid rgba(128, 128, 128, 0.5)" }
            : { borderRight: "6px solid rgba(128, 128, 128, 0.5)" }),
        }}
      />
      <Box
        className="float-buttons"
        sx={{
          display: "none",
          alignItems: "center",
          gap: 0,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export function App(): React.JSX.Element {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [currentFileType, setCurrentFileType] = useState<FileType>("markdown");
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initializedRef = useRef(false);

  const { theme, muiTheme, setTheme } = useTheme();
  const {
    menuBarSettings,
    setFloatOpacity,
    extensionSettings,
    toggleExtensionGroup,
    enableAllExtensions,
    disableAllExtensions,
    enabledExtensions,
  } = useSettings();

  const filteredTree = useMemo(
    () => filterTreeByExtensions(tree, enabledExtensions),
    [tree, enabledExtensions]
  );

  const handleContentUpdate = useCallback((path: string, fileType: FileType, content: string) => {
    setCurrentPath((current) => {
      if (current === path) {
        setCurrentFileType(fileType);
        setCurrentContent(content);
      }
      return current;
    });
  }, []);

  const handleTreeUpdate = useCallback((newTree: TreeNode[]) => {
    setTree(newTree);
  }, []);

  useWebSocket({
    onContentUpdate: handleContentUpdate,
    onTreeUpdate: handleTreeUpdate,
  });

  const loadFile = useCallback(async (path: string) => {
    setCurrentPath(path);
    try {
      const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const data = (await response.json()) as FileContent;
      setCurrentFileType(data.file_type);
      setCurrentContent(data.content);
    } catch (e) {
      console.error("Failed to fetch file:", e);
    }
  }, []);

  const handleSelect = useCallback(
    async (path: string) => {
      pushPathToHash(path);
      await loadFile(path);
    },
    [loadFile]
  );

  useEffect(() => {
    if (currentPath) {
      document.title = currentPath;
    } else {
      document.title = "Markdown Live";
    }
  }, [currentPath]);

  useEffect(() => {
    const fetchTree = async (): Promise<void> => {
      try {
        const response = await fetch("/api/tree");
        const data = (await response.json()) as TreeNode[];
        setTree(data);

        if (!initializedRef.current) {
          initializedRef.current = true;
          // First try to restore path from URL hash
          const hashPath = getPathFromHash();
          if (hashPath) {
            replacePathToHash(hashPath);
            void loadFile(hashPath);
          } else {
            // Otherwise find and select README
            const readme = findReadme(data);
            if (readme !== null) {
              replacePathToHash(readme);
              void loadFile(readme);
            }
          }
        }
      } catch (e) {
        console.error("Failed to fetch tree:", e);
      }
    };
    void fetchTree();
  }, [loadFile]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = (): void => {
      const hashPath = getPathFromHash();
      if (hashPath) {
        void loadFile(hashPath);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [loadFile]);

  const handleNavigate = useCallback(
    (path: string) => {
      void handleSelect(path);
    },
    [handleSelect]
  );

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const showFloatButtons = !sidebarOpen;

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <Box sx={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        {sidebarOpen && (
          <Sidebar
            tree={filteredTree}
            currentPath={currentPath}
            width={sidebarWidth}
            onSelect={handleSelect}
            onClose={handleCloseSidebar}
            onOpenSettings={handleOpenSettings}
            onWidthChange={setSidebarWidth}
          />
        )}

        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            bgcolor: "background.default",
            position: "relative",
          }}
        >
          {showFloatButtons && (
            <FloatButton position="left" floatOpacity={menuBarSettings.floatOpacity}>
              <Tooltip title="Open sidebar">
                <IconButton size="small" onClick={handleOpenSidebar}>
                  <MenuIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Settings">
                <IconButton size="small" onClick={handleOpenSettings}>
                  <SettingsIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </FloatButton>
          )}

          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <ContentViewer
              content={currentContent}
              fileType={currentFileType}
              currentPath={currentPath}
              theme={theme}
              onNavigate={handleNavigate}
            />
          </Box>
        </Box>

        <SettingsDialog
          open={settingsOpen}
          theme={theme}
          menuBarSettings={menuBarSettings}
          extensionSettings={extensionSettings}
          onClose={handleCloseSettings}
          onThemeChange={setTheme}
          onFloatOpacityChange={setFloatOpacity}
          onToggleExtensionGroup={toggleExtensionGroup}
          onEnableAllExtensions={enableAllExtensions}
          onDisableAllExtensions={disableAllExtensions}
        />
      </Box>
    </ThemeProvider>
  );
}
