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
  Settings as SettingsIcon,
  MyLocation as LocateIcon,
} from "@mui/icons-material";
import type { TreeNode } from "@/types";

interface TreeItemProps {
  node: TreeNode;
  level: number;
  currentPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

function TreeItem({
  node,
  level,
  currentPath,
  expandedPaths,
  onSelect,
  onToggle,
}: TreeItemProps): React.JSX.Element {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = currentPath === node.path;

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
          py: 0.5,
          minHeight: 32,
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
          primary={node.name}
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
  onSelect: (path: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onWidthChange: (width: number) => void;
}

export function Sidebar({
  tree,
  currentPath,
  width,
  onSelect,
  onClose,
  onOpenSettings,
  onWidthChange,
}: SidebarProps): React.JSX.Element {
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
        width,
        minWidth: width,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderRight: 1,
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
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box>
          <Tooltip title={isAllExpanded ? "Collapse all" : "Expand all"}>
            <IconButton size="small" onClick={handleToggleAll}>
              {isAllExpanded ? (
                <CollapseAllIcon fontSize="small" />
              ) : (
                <ExpandAllIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title="Reveal current file">
            <span>
              <IconButton size="small" onClick={handleRevealCurrentFile} disabled={!currentPath}>
                <LocateIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <Box>
          <Tooltip title="Settings">
            <IconButton size="small" onClick={onOpenSettings}>
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Close sidebar">
            <IconButton size="small" onClick={onClose}>
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Box ref={listContainerRef} sx={{ flex: 1, overflow: "auto" }}>
        <List dense disablePadding>
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              level={0}
              currentPath={currentPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={handleToggle}
            />
          ))}
        </List>
      </Box>

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
    </Box>
  );
}
