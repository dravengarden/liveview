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
  MyLocation as LocateIcon,
  ArrowBack as BackIcon,
} from "@mui/icons-material";
import type { LangInfo, RenditionInfo, TreeNode } from "@/types";
import { useI18n } from "@/i18n";

/** A single-line label that reveals its full text in a tooltip only when it is
 *  actually truncated (ellipsized). Re-measures on container resize, so it
 *  reacts to the draggable sidebar width. */
function TruncatedLabel({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowed, setOverflowed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => setOverflowed(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  const label = (
    <Typography
      ref={ref}
      variant="body2"
      noWrap
      sx={{ display: "block", minWidth: 0 }}
    >
      {text}
    </Typography>
  );

  // Mount the Tooltip only when truncated, so non-clipped rows don't pop a
  // redundant tooltip on hover.
  return overflowed ? (
    <Tooltip title={text} placement="right" enterDelay={400}>
      {label}
    </Tooltip>
  ) : (
    label
  );
}

interface TreeItemProps {
  node: TreeNode;
  level: number;
  /** "book" mode hides file icons and the root folder; see {@link Sidebar}. */
  bookMode: boolean;
  currentPath: string | null;
  currentLang: string | undefined;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

function TreeItem({
  node,
  level,
  bookMode,
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
        {/* Expand/collapse affordance: a chevron for dirs, an aligning spacer
            for files so their labels line up with sibling group names. */}
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
        {/* Book mode is a clean reading spine — no folder/file icons. Docs mode
            keeps the filesystem-tree icons. */}
        {!bookMode && (
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
        )}
        <ListItemText disableTypography primary={<TruncatedLabel text={label} />} />
      </ListItemButton>
      {node.is_dir && node.children.length > 0 && (
        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
          <List component="div" disablePadding>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                level={level + 1}
                bookMode={bookMode}
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
  /** "book" mode (book.toml-driven) renders a clean titled spine — no file
   *  icons, root folder already dropped upstream. "docs" mode renders the raw
   *  filesystem tree with folder/file icons. */
  bookMode?: boolean;
  langs?: LangInfo[];
  currentLang?: string;
  onSwitchLang?: (lang: string) => void;
  /** Reading modes the active book offers. A segmented toggle appears when >1. */
  renditions?: RenditionInfo[];
  /** Active rendition kind (`"text"` / `"audio"`). */
  currentRendition?: string;
  onSwitchRendition?: (kind: string) => void;
  onSelect: (path: string) => void;
  onBackToLanding: () => void;
}

// The Sidebar is the nav body inside NavShell, which owns the surrounding frame
// (panel width / drawer / collapse) and the top bar (title, settings, launcher,
// the collapse toggle). So this renders only the in-nav controls — back to the
// bookshelf, expand/collapse-all, reveal current — plus the language switcher
// and the tree, filling whatever container NavShell gives it.
export function Sidebar({
  tree,
  currentPath,
  bookMode = false,
  langs = [],
  currentLang,
  onSwitchLang,
  renditions = [],
  currentRendition,
  onSwitchRendition,
  onSelect,
  onBackToLanding,
}: SidebarProps): React.JSX.Element {
  const { t } = useI18n();
  const allDirPaths = useMemo(() => collectAllDirPaths(tree), [tree]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const listContainerRef = useRef<HTMLDivElement>(null);
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

  return (
    <Box
      sx={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
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
        <Tooltip title={t("sidebar.back")}>
          <IconButton size="small" onClick={onBackToLanding}>
            <BackIcon fontSize="small" />
          </IconButton>
        </Tooltip>
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
        </Box>
      </Box>

      {/* Whole-book reading-mode switch (阅读 / 听书). Mirrors the language
          switcher's UI; only shown when the book offers more than one mode. */}
      {renditions.length > 1 && (
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
            {t("sidebar.rendition")}
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={currentRendition ?? null}
            onChange={(_, value: string | null) => {
              if (value && onSwitchRendition) {
                onSwitchRendition(value);
              }
            }}
            sx={{ flexWrap: "wrap" }}
          >
            {renditions.map((r) => (
              <ToggleButton key={r.kind} value={r.kind} sx={{ px: 1, py: 0.25, textTransform: "none" }}>
                {r.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      )}

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
              bookMode={bookMode}
              currentPath={currentPath}
              currentLang={currentLang}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={handleToggle}
            />
          ))}
        </List>
      </Box>
    </Box>
  );
}
