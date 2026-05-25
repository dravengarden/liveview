use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use globset::GlobSet;

use crate::config::{BookState, Layout};
use crate::shared::TreeNode;

/// Build the full sidebar forest across every book. Each book becomes a
/// top-level `is_dir` node whose `name` is the book label and `path` is the
/// book slug; descendants carry slug-prefixed paths
/// (`<slug>/<rel-under-source>`).
///
/// The tree is built from each book's *default* edition. Editions mirror the
/// same logical structure, so the tree is language-independent — switching
/// language only changes which edition's content is fetched.
pub fn build_virtual_tree(books: &[BookState]) -> Vec<TreeNode> {
    books
        .iter()
        .map(|b| {
            let children = if b.manifest {
                // book.toml book: a flat spine of section titles — no dirs/files.
                build_spine(b)
            } else {
                let ed = b.default_edition();
                let mut children = Vec::new();
                scan_dir(
                    &ed.source,
                    &ed.source,
                    &ed.include_set,
                    &ed.exclude_set,
                    &mut children,
                );
                prefix_all(&mut children, &b.slug);
                order_children(&mut children, b.layout.as_ref());
                children
            };
            TreeNode {
                name: b.label.clone(),
                path: b.slug.clone(),
                is_dir: true,
                children,
            }
        })
        .collect()
}

/// Sidebar for a `book.toml` book: a flat, ordered list of the base edition's
/// top-level markdown chapters, each labelled by its H1 (the chapter title).
/// Non-markdown (e.g. `assets/`) is hidden — readers see titles, not files.
fn build_spine(book: &BookState) -> Vec<TreeNode> {
    let ed = book.default_edition();
    let Ok(entries) = std::fs::read_dir(&ed.source) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && matches!(
                    p.extension().and_then(|x| x.to_str()),
                    Some("md" | "markdown")
                )
        })
        .collect();
    files.sort();

    files
        .iter()
        .map(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            let title = read_h1(p).unwrap_or_else(|| name.to_string());
            TreeNode {
                name: title,
                path: format!("{}/{}", book.slug, name),
                is_dir: false,
                children: Vec::new(),
            }
        })
        .collect()
}

/// First Markdown H1 (`# Title`) in a file, used as the section's sidebar
/// title. `None` when the file is unreadable or has no H1.
fn read_h1(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix("# ")
            .map(|rest| rest.trim().to_string())
    })
}

fn scan_dir(
    dir: &Path,
    root: &Path,
    include_set: &GlobSet,
    exclude_set: &GlobSet,
    nodes: &mut Vec<TreeNode>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let rel_path = path.strip_prefix(root).unwrap_or(&path);

        if exclude_set.is_match(rel_path) {
            continue;
        }

        if path.is_dir() {
            let mut children = Vec::new();
            scan_dir(&path, root, include_set, exclude_set, &mut children);
            if !children.is_empty() {
                nodes.push(TreeNode {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: rel_path.to_string_lossy().to_string(),
                    is_dir: true,
                    children,
                });
            }
        } else if include_set.is_match(rel_path) {
            nodes.push(TreeNode {
                name: entry.file_name().to_string_lossy().to_string(),
                path: rel_path.to_string_lossy().to_string(),
                is_dir: false,
                children: vec![],
            });
        }
    }
}

/// Rewrite every node's `path` in-place from `<rel>` to `<prefix>/<rel>`.
fn prefix_all(nodes: &mut [TreeNode], prefix: &str) {
    for node in nodes {
        node.path = if node.path.is_empty() {
            prefix.to_string()
        } else {
            format!("{prefix}/{}", node.path)
        };
        if node.is_dir {
            prefix_all(&mut node.children, prefix);
        }
    }
}

/// Sort siblings using `layout.order` when present (dir-then-alpha
/// otherwise), then recurse into each directory using `layout.subtree[name]`
/// — so curation can reach arbitrary depth.
fn order_children(nodes: &mut [TreeNode], layout: Option<&Layout>) {
    match layout {
        Some(l) if !l.order.is_empty() => apply_layout_order(nodes, l),
        _ => sort_siblings_default(nodes),
    }
    for node in nodes.iter_mut() {
        if node.is_dir {
            let sub = layout.and_then(|l| l.subtree.get(&node.name));
            order_children(&mut node.children, sub);
        }
    }
}

fn sort_siblings_default(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| default_cmp(a.is_dir, b.is_dir, &a.name, &b.name));
}

fn apply_layout_order(nodes: &mut [TreeNode], layout: &Layout) {
    nodes.sort_by(|a, b| {
        let ai = layout
            .order
            .iter()
            .position(|p| matches_layout(p, &a.name, a.is_dir));
        let bi = layout
            .order
            .iter()
            .position(|p| matches_layout(p, &b.name, b.is_dir));
        match (ai, bi) {
            (Some(ax), Some(bx)) => ax.cmp(&bx),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => default_cmp(a.is_dir, b.is_dir, &a.name, &b.name),
        }
    });
}

fn default_cmp(a_is_dir: bool, b_is_dir: bool, a_name: &str, b_name: &str) -> Ordering {
    b_is_dir
        .cmp(&a_is_dir)
        .then_with(|| a_name.to_lowercase().cmp(&b_name.to_lowercase()))
}

fn matches_layout(pattern: &str, name: &str, is_dir: bool) -> bool {
    if let Some(p) = pattern.strip_suffix('/') {
        is_dir && name == p
    } else {
        !is_dir && name == pattern
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{build_globset, BookState, EditionState, Layout};
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(prefix: &str) -> Self {
            let mut p = std::env::temp_dir();
            let suffix = format!(
                "{prefix}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            p.push(suffix);
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn touch(&self, rel: &str) {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, b"").unwrap();
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mk_mount(label: &str, slug: &str, source: &Path, layout: Option<Layout>) -> BookState {
        BookState {
            label: label.to_string(),
            slug: slug.to_string(),
            description: None,
            default_lang: "default".to_string(),
            layout,
            manifest: false,
            editions: vec![EditionState {
                lang: "default".to_string(),
                label: "default".to_string(),
                source: source.to_path_buf(),
                include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
                exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
            }],
        }
    }

    #[test]
    fn manifest_book_renders_flat_h1_spine() {
        let tmp = TempDir::new("lv-spine");
        tmp.touch("00-intro.md");
        fs::write(tmp.path().join("00-intro.md"), b"# Introduction\n\nbody").unwrap();
        fs::write(
            tmp.path().join("01-basics.md"),
            b"---\nkey: val\n---\n# The Basics\n",
        )
        .unwrap();
        // A non-markdown sibling dir must NOT surface in the sidebar.
        fs::create_dir_all(tmp.path().join("assets")).unwrap();
        fs::write(tmp.path().join("assets/fig.png"), b"").unwrap();

        let mut book = mk_mount("My Book", "mybook", tmp.path(), None);
        book.manifest = true;
        let tree = build_virtual_tree(&[book]);

        let top = &tree[0];
        assert_eq!(top.name, "My Book");
        assert!(top.is_dir);
        let kids: Vec<(&str, &str, bool)> = top
            .children
            .iter()
            .map(|n| (n.name.as_str(), n.path.as_str(), n.is_dir))
            .collect();
        assert_eq!(
            kids,
            vec![
                ("Introduction", "mybook/00-intro.md", false),
                ("The Basics", "mybook/01-basics.md", false),
            ]
        );
    }

    #[test]
    fn virtual_tree_prefixes_paths_with_slug() {
        let tmp = TempDir::new("lv-tree");
        tmp.touch("README.md");
        tmp.touch("sub/INDEX.md");

        let mount = mk_mount("Docs", "docs", tmp.path(), None);
        let tree = build_virtual_tree(&[mount]);

        assert_eq!(tree.len(), 1);
        let top = &tree[0];
        assert_eq!(top.name, "Docs");
        assert_eq!(top.path, "docs");
        assert!(top.is_dir);

        let paths: Vec<_> = top.children.iter().map(|n| n.path.as_str()).collect();
        assert!(paths.contains(&"docs/README.md"), "got: {:?}", paths);
        let sub = top.children.iter().find(|n| n.name == "sub").unwrap();
        assert_eq!(sub.path, "docs/sub");
        let index = sub.children.first().unwrap();
        assert_eq!(index.path, "docs/sub/INDEX.md");
    }

    #[test]
    fn layout_order_promotes_named_entries() {
        let tmp = TempDir::new("lv-layout");
        tmp.touch("INDEX.md");
        tmp.touch("a.md");
        tmp.touch("z.md");
        tmp.touch("api/spec.md");

        let layout = Layout {
            order: vec!["INDEX.md".to_string(), "api/".to_string()],
            ..Default::default()
        };
        let mount = mk_mount("Docs", "docs", tmp.path(), Some(layout));
        let tree = build_virtual_tree(&[mount]);
        let top_children: Vec<_> = tree[0].children.iter().map(|n| n.name.as_str()).collect();

        // First two by layout, remainder in default (dir-then-alpha) order.
        assert_eq!(top_children, vec!["INDEX.md", "api", "a.md", "z.md"]);
    }

    #[test]
    fn nested_layout_orders_subtree() {
        let tmp = TempDir::new("lv-nested");
        tmp.touch("INDEX.md");
        tmp.touch("projects/zed.md");
        tmp.touch("projects/alpha.md");
        tmp.touch("projects/middle.md");
        tmp.touch("projects/group/sub.md");

        // Top level: INDEX.md, then projects/. Within projects/:
        // group/, then middle.md, alpha.md (alpha by default after named).
        let mut subtree = std::collections::HashMap::new();
        subtree.insert(
            "projects".to_string(),
            Layout {
                order: vec!["group/".to_string(), "middle.md".to_string()],
                ..Default::default()
            },
        );
        let layout = Layout {
            order: vec!["INDEX.md".to_string(), "projects/".to_string()],
            subtree,
        };
        let mount = mk_mount("Docs", "docs", tmp.path(), Some(layout));
        let tree = build_virtual_tree(&[mount]);

        let top: Vec<_> = tree[0].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(top, vec!["INDEX.md", "projects"]);

        let projects = tree[0]
            .children
            .iter()
            .find(|n| n.name == "projects")
            .unwrap();
        let inside: Vec<_> = projects.children.iter().map(|n| n.name.as_str()).collect();
        // group/ first (named), then middle.md (named), then alpha.md, zed.md (alpha)
        assert_eq!(inside, vec!["group", "middle.md", "alpha.md", "zed.md"]);
    }

    #[test]
    fn multiple_mounts_distinct_slugs() {
        let tmp_docs = TempDir::new("lv-docs");
        tmp_docs.touch("hello.md");
        let tmp_tasks = TempDir::new("lv-tasks");
        tmp_tasks.touch("work.md");

        let docs = mk_mount("Docs", "docs", tmp_docs.path(), None);
        let tasks = mk_mount("Tasks", "tasks", tmp_tasks.path(), None);
        let tree = build_virtual_tree(&[docs, tasks]);

        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].path, "docs");
        assert_eq!(tree[1].path, "tasks");
        assert_eq!(tree[0].children[0].path, "docs/hello.md");
        assert_eq!(tree[1].children[0].path, "tasks/work.md");
    }

    #[test]
    fn matches_layout_kinds() {
        assert!(matches_layout("README.md", "README.md", false));
        assert!(!matches_layout("README.md", "README.md", true)); // file pattern, dir name
        assert!(matches_layout("api/", "api", true));
        assert!(!matches_layout("api/", "api", false)); // dir pattern, file name
    }
}
