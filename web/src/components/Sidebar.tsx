import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ArrowBack as BackIcon,
  ChevronRight as ChevronRightIcon,
  Description as FileIcon,
  ExpandMore as ExpandMoreIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  GraphicEq as PlayingIcon,
  MyLocation as LocateIcon,
  UnfoldLess as CollapseAllIcon,
  UnfoldMore as ExpandAllIcon,
} from "@mui/icons-material";
import type { LangInfo, TreeNode } from "@/types";
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
  return overflowed
    ? (
      <Tooltip title={text} placement="right" enterDelay={400}>
        {label}
      </Tooltip>
    )
    : label;
}

interface TreeItemProps {
  node: TreeNode;
  level: number;
  /** "book" mode hides file icons and the root folder; see {@link Sidebar}. */
  bookMode: boolean;
  currentPath: string | null;
  /** The chapter the audio engine is playing (this book), marked distinctly and
   *  treated as selected — see {@link Sidebar}. Null when nothing plays here. */
  playingPath: string | null;
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
  playingPath,
  currentLang,
  expandedPaths,
  onSelect,
  onToggle,
}: TreeItemProps): React.JSX.Element {
  const isExpanded = expandedPaths.has(node.path);
  const isPlaying = playingPath === node.path;
  // Highlight the VIEWED chapter, plus the PLAYING one — which is what the
  // read-along reader shows, and can differ from `currentPath` once the
  // engine→view sync lapses (see Sidebar `playingPath`).
  const isSelected = currentPath === node.path || isPlaying;
  // Book-spine chapters carry per-language titles; show the current edition's,
  // falling back to `name` (the default edition's title) for untranslated
  // chapters and for plain file-tree nodes that have no `titles`.
  const label = (currentLang && node.titles?.[currentLang]) || node.name;

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
        {
          /* Expand/collapse affordance: a chevron for dirs, an aligning spacer
            for files so their labels line up with sibling group names. */
        }
        {node.is_dir
          ? (
            <ListItemIcon sx={{ minWidth: 24 }}>
              {isExpanded
                ? <ExpandMoreIcon fontSize="medium" />
                : <ChevronRightIcon fontSize="medium" />}
            </ListItemIcon>
          )
          : <ListItemIcon sx={{ minWidth: 24 }} />}
        {
          /* Book mode is a clean reading spine — no folder/file icons. Docs mode
            keeps the filesystem-tree icons. */
        }
        {!bookMode && (
          <ListItemIcon sx={{ minWidth: 28 }}>
            {node.is_dir
              ? (
                isExpanded
                  ? <FolderOpenIcon fontSize="medium" color="primary" />
                  : <FolderIcon fontSize="medium" color="primary" />
              )
              : <FileIcon fontSize="medium" color="action" />}
          </ListItemIcon>
        )}
        <ListItemText
          disableTypography
          primary={<TruncatedLabel text={label} />}
        />
        {
          /* Now-playing marker: the audiobook reader is a window onto the engine,
            so the list must show WHICH chapter is playing even when `currentPath`
            (the viewed chapter) has drifted off it. */
        }
        {isPlaying && (
          <ListItemIcon sx={{ minWidth: 0, ml: 1 }}>
            <PlayingIcon fontSize="small" color="primary" />
          </ListItemIcon>
        )}
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
                playingPath={playingPath}
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
  /** The chapter the audio engine is playing in the open book (null when none).
   *  The list marks it distinctly and treats it as selected, so it reflects what
   *  the read-along reader shows even when `currentPath` has drifted off it. */
  playingPath?: string | null;
  /** "book" mode (book.toml-driven) renders a clean titled spine — no file
   *  icons, root folder already dropped upstream. "docs" mode renders the raw
   *  filesystem tree with folder/file icons. */
  bookMode?: boolean;
  langs?: LangInfo[];
  currentLang?: string;
  onSwitchLang?: (lang: string) => void;
  onSelect: (path: string) => void;
  onBackToLanding: () => void;
  /** Deploy-time stamps (unix ms) of the open book; 0/undefined ⇒ hidden. */
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
}

// The Sidebar is the nav body inside NavShell, which owns the surrounding frame
// (panel width / drawer / collapse) and the top bar (title, settings, launcher,
// the collapse toggle). So this renders only the in-nav controls — back to the
// bookshelf, expand/collapse-all, reveal current — plus the language switcher
// and the tree, filling whatever container NavShell gives it.
/** Format a unix-ms deploy stamp as a locale date, or null when unset (0). */
function fmtDate(ms: number | undefined, lang: string): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function Sidebar({
  tree,
  currentPath,
  playingPath = null,
  bookMode = false,
  langs = [],
  currentLang,
  onSwitchLang,
  onSelect,
  onBackToLanding,
  createdAt,
  updatedAt,
}: SidebarProps): React.JSX.Element {
  const { t, lang } = useI18n();
  const allDirPaths = useMemo(() => collectAllDirPaths(tree), [tree]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    new Set()
  );
  const listContainerRef = useRef<HTMLDivElement>(null);
  const prevCurrentPathRef = useRef<string | null>(null);
  // What the list highlights + reveals: the playing chapter when audio is going
  // (the reader is a window onto the engine), else the viewed chapter.
  const focusPath = playingPath ?? currentPath;

  // Auto-expand parent directories only when the focused chapter changes
  useEffect(() => {
    if (
      focusPath && focusPath !== prevCurrentPathRef.current &&
      tree.length > 0
    ) {
      const parentPaths = findParentPaths(tree, focusPath);
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
    prevCurrentPathRef.current = focusPath;
  }, [focusPath, tree]);

  const isAllExpanded = allDirPaths.length > 0 &&
    allDirPaths.every((p) => expandedPaths.has(p));

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
    if (!focusPath || !listContainerRef.current) return;

    // Expand parent directories
    const parentPaths = findParentPaths(tree, focusPath);
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
      const element = listContainerRef.current?.querySelector(
        `[data-path="${CSS.escape(focusPath)}"]`,
      );
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
  }, [focusPath, tree]);

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
          <IconButton onClick={onBackToLanding}>
            <BackIcon />
          </IconButton>
        </Tooltip>
        <Box sx={{ display: "flex", flexShrink: 0 }}>
          <Tooltip
            title={t(
              isAllExpanded ? "sidebar.collapseAll" : "sidebar.expandAll",
            )}
          >
            <IconButton onClick={handleToggleAll}>
              {isAllExpanded ? <CollapseAllIcon /> : <ExpandAllIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title={t("sidebar.reveal")}>
            <span>
              <IconButton
                onClick={handleRevealCurrentFile}
                disabled={!focusPath}
              >
                <LocateIcon />
              </IconButton>
            </span>
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
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flexShrink: 0 }}
          >
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
              <ToggleButton
                key={l.lang}
                value={l.lang}
                sx={{ px: 1, py: 0.25, textTransform: "none" }}
              >
                {l.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      )}

      <Box
        ref={listContainerRef}
        sx={{
          flex: 1,
          overflow: "auto",
          // iOS rubber-band + async momentum. This inner list is the REAL
          // scroller (in the mobile DetentSheet the sheet body fits the Sidebar
          // exactly, so its own bounce never fires — the overscroll has to live
          // here). It's nested under the sheet root's transform, which would
          // demote it off the compositor; give it its own layer + touch momentum,
          // mirroring the sheet body's treatment. No-op on desktop/non-touch.
          WebkitOverflowScrolling: "touch",
          transform: "translateZ(0)",
        }}
      >
        <List dense disablePadding>
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              level={0}
              bookMode={bookMode}
              currentPath={currentPath}
              playingPath={playingPath}
              currentLang={currentLang}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={handleToggle}
            />
          ))}
        </List>
      </Box>

      {
        /* Book deploy-times footer — created on first appearance, updated on the
          last sync that changed the book. Hidden when unstamped. */
      }
      {(() => {
        const created = fmtDate(createdAt, lang);
        const updated = updatedAt !== createdAt
          ? fmtDate(updatedAt, lang)
          : null;
        const stamps = [
          created && t("landing.added", { date: created }),
          updated && t("landing.updated", { date: updated }),
        ].filter((s): s is string => Boolean(s));
        return stamps.length > 0
          ? (
            <Box
              sx={{
                flexShrink: 0,
                px: 1.25,
                py: 0.75,
                borderTop: 1,
                borderColor: "divider",
              }}
            >
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{ display: "block", lineHeight: 1.5 }}
              >
                {stamps.join(" · ")}
              </Typography>
            </Box>
          )
          : null;
      })()}
    </Box>
  );
}
