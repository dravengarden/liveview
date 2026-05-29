import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  IconButton,
  Collapse,
  Tooltip,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import {
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Description as FileIcon,
  ChevronRight as ChevronRightIcon,
  ExpandMore as ExpandMoreIcon,
  UnfoldMore as ExpandAllIcon,
  UnfoldLess as CollapseAllIcon,
  ChevronLeft as ChevronLeftIcon,
  Close as CloseIcon,
  Settings as SettingsIcon,
  MyLocation as LocateIcon,
  ArrowBack as BackIcon,
} from "@mui/icons-material";
import type { LangInfo, TreeNode } from "@/types";
import { useI18n } from "@/i18n";

interface TreeItemProps {
  node: TreeNode;
  level: number;
  currentPath: string | null;
  currentLang: string | undefined;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

function TreeItem({
  node,
  level,
  currentPath,
  currentLang,
  expandedPaths,
  onSelect,
  onToggle,
}: TreeItemProps): React.JSX.Element {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = currentPath === node.path;
  // Book-spine chapters carry per-language titles; show the current edition's,
  // falling back to `name` (the default edition's title) for untranslated
  // chapters and for plain file-tree nodes that have no `titles`.
  const label =
    (currentLang && node.titles?.[currentLang]) || node.name;

  const handleClick = useCallback(() => {
    if (node.is_dir) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  }, [node.is_dir, node.path, onSelect, onToggle]);

  return (
    <>
      <ListItemButton
        data-path={node.path}
        onClick={handleClick}
        selected={isSelected}
        sx={{
          pl: 1 + level * 2,
          // Taller, finger-friendly rows on touch screens; compact on desktop.
          py: { xs: 0.75, md: 0.5 },
          minHeight: { xs: 44, md: 32 },
          "&.Mui-selected": {
            bgcolor: "action.selected",
          },
        }}
      >
        {node.is_dir ? (
          <ListItemIcon sx={{ minWidth: 24 }}>
            {isExpanded ? (
              <ExpandMoreIcon fontSize="small" />
            ) : (
              <ChevronRightIcon fontSize="small" />
            )}
          </ListItemIcon>
        ) : (
          <ListItemIcon sx={{ minWidth: 24 }} />
        )}
        <ListItemIcon sx={{ minWidth: 28 }}>
          {node.is_dir ? (
            isExpanded ? (
              <FolderOpenIcon fontSize="small" color="primary" />
            ) : (
              <FolderIcon fontSize="small" color="primary" />
            )
          ) : (
            <FileIcon fontSize="small" color="action" />
          )}
        </ListItemIcon>
        <ListItemText
          primary={label}
          primaryTypographyProps={{
            variant: "body2",
            noWrap: true,
          }}
        />
      </ListItemButton>
      {node.is_dir && node.children.length > 0 && (
        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
          <List component="div" disablePadding>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                level={level + 1}
                currentPath={currentPath}
                currentLang={currentLang}
                expandedPaths={expandedPaths}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
          </List>
        </Collapse>
      )}
    </>
  );
}

function collectAllDirPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  function walk(node: TreeNode): void {
    if (node.is_dir) {
      paths.push(node.path);
      node.children.forEach(walk);
    }
  }
  nodes.forEach(walk);
  return paths;
}

function findParentPaths(nodes: TreeNode[], targetPath: string): string[] {
  const parentPaths: string[] = [];

  function search(node: TreeNode, ancestors: string[]): boolean {
    if (node.path === targetPath) {
      parentPaths.push(...ancestors);
      return true;
    }
    if (node.is_dir) {
      for (const child of node.children) {
        if (search(child, [...ancestors, node.path])) {
          return true;
        }
      }
    }
    return false;
  }

  for (const node of nodes) {
    if (search(node, [])) {
      break;
    }
  }

  return parentPaths;
}

interface SidebarProps {
  tree: TreeNode[];
  currentPath: string | null;
  width: number;
  isMobile?: boolean;
  bookLabel?: string;
  langs?: LangInfo[];
  currentLang?: string;
  onSwitchLang?: (lang: string) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onBackToLanding: () => void;
  onWidthChange: (width: number) => void;
}

export function Sidebar({
  tree,
  currentPath,
  width,
  isMobile = false,
  bookLabel,
  langs = [],
  currentLang,
  onSwitchLang,
  onSelect,
  onClose,
  onOpenSettings,
  onBackToLanding,
  onWidthChange,
}: SidebarProps): React.JSX.Element {
  const { t } = useI18n();
  const allDirPaths = useMemo(() => collectAllDirPaths(tree), [tree]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const resizeRef = useRef<HTMLDivElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const prevCurrentPathRef = useRef<string | null>(null);

  // Auto-expand parent directories only when currentPath actually changes
  useEffect(() => {
    if (currentPath && currentPath !== prevCurrentPathRef.current && tree.length > 0) {
      const parentPaths = findParentPaths(tree, currentPath);
      if (parentPaths.length > 0) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          for (const p of parentPaths) {
            next.add(p);
          }
          return next;
        });
      }
    }
    prevCurrentPathRef.current = currentPath;
  }, [currentPath, tree]);

  const isAllExpanded = allDirPaths.length > 0 && allDirPaths.every((p) => expandedPaths.has(p));

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    if (isAllExpanded) {
      setExpandedPaths(new Set());
    } else {
      setExpandedPaths(new Set(allDirPaths));
    }
  }, [isAllExpanded, allDirPaths]);

  const handleRevealCurrentFile = useCallback(() => {
    if (!currentPath || !listContainerRef.current) return;

    // Expand parent directories
    const parentPaths = findParentPaths(tree, currentPath);
    if (parentPaths.length > 0) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        for (const p of parentPaths) {
          next.add(p);
        }
        return next;
      });
    }

    // Scroll to the element after a short delay to allow expansion animation
    setTimeout(() => {
      const element = listContainerRef.current?.querySelector(`[data-path="${CSS.escape(currentPath)}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
  }, [currentPath, tree]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDraggingRef.current) return;
      const newWidth = Math.min(Math.max(e.clientX, 180), 600);
      onWidthChange(newWidth);
    };

    const handleMouseUp = (): void => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onWidthChange]);

  const handleResizeStart = useCallback(() => {
    isDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  return (
    <Box
      sx={{
        // In the mobile Drawer the paper sets the width and height; fill it.
        width: isMobile ? "100%" : width,
        minWidth: isMobile ? 0 : width,
        height: isMobile ? "100%" : "100dvh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderRight: isMobile ? 0 : 1,
        borderColor: "divider",
        position: "relative",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 1,
          py: 0.5,
          // Clear the iPhone status bar / notch when shown as a drawer.
          pt: isMobile ? "calc(env(safe-area-inset-top, 0px) + 4px)" : 0.5,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", minWidth: 0, flex: 1 }}>
          <Tooltip title={t("sidebar.back")}>
            <IconButton size="small" onClick={onBackToLanding}>
              <BackIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {bookLabel && (
            <Typography
              variant="subtitle2"
              noWrap
              title={bookLabel}
              sx={{ ml: 0.5, fontWeight: 600, minWidth: 0 }}
            >
              {bookLabel}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: "flex", flexShrink: 0 }}>
          <Tooltip title={t(isAllExpanded ? "sidebar.collapseAll" : "sidebar.expandAll")}>
            <IconButton size="small" onClick={handleToggleAll}>
              {isAllExpanded ? (
                <CollapseAllIcon fontSize="small" />
              ) : (
                <ExpandAllIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title={t("sidebar.reveal")}>
            <span>
              <IconButton size="small" onClick={handleRevealCurrentFile} disabled={!currentPath}>
                <LocateIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t("sidebar.settings")}>
            <IconButton size="small" onClick={onOpenSettings}>
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("sidebar.close")}>
            <IconButton size="small" onClick={onClose}>
              {/* ✕ reads as "close overlay" on mobile; ‹ as "collapse" on desktop. */}
              {isMobile ? <CloseIcon fontSize="small" /> : <ChevronLeftIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {langs.length > 1 && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1,
            py: 0.75,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {t("sidebar.language")}
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={currentLang ?? null}
            onChange={(_, value: string | null) => {
              if (value && onSwitchLang) {
                onSwitchLang(value);
              }
            }}
            sx={{ flexWrap: "wrap" }}
          >
            {langs.map((l) => (
              <ToggleButton key={l.lang} value={l.lang} sx={{ px: 1, py: 0.25, textTransform: "none" }}>
                {l.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      )}

      <Box ref={listContainerRef} sx={{ flex: 1, overflow: "auto" }}>
        <List dense disablePadding>
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              level={0}
              currentPath={currentPath}
              currentLang={currentLang}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={handleToggle}
            />
          ))}
        </List>
      </Box>

      {!isMobile && (
        <Box
          ref={resizeRef}
          onMouseDown={handleResizeStart}
          sx={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: 4,
            cursor: "col-resize",
            "&:hover": {
              bgcolor: "primary.main",
            },
          }}
        />
      )}
    </Box>
  );
}
