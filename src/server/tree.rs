use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use globset::GlobSet;

use crate::config::{BookState, Layout, RenditionKind, RenditionState};
use crate::shared::TreeNode;

/// Build the sidebar forest for the given `rendition` across every book. Each
/// book that offers that rendition becomes a top-level `is_dir` node whose
/// `name` is the book label and `path` is the book slug; descendants carry
/// slug-prefixed paths (`<slug>/<rel-under-source>`). Books lacking the
/// rendition are omitted.
///
/// The tree is built from the rendition's *default* edition. Editions mirror
/// the same logical structure, so the tree is language-independent — switching
/// language only changes which edition's content is fetched. A text rendition's
/// spine is its filesystem tree (or, for a `book.toml` book, an H1-titled
/// chapter spine); an audio rendition's spine is its top-level `*.spoken.md`
/// chapters.
pub fn build_virtual_tree(books: &[BookState], rendition: RenditionKind) -> Vec<TreeNode> {
    books
        .iter()
        .filter_map(|b| {
            let r = b.rendition(rendition)?;
            let children = if r.kind == RenditionKind::Audio {
                build_audio_spine(b, r)
            } else if r.manifest {
                // book.toml book: a flat spine of section titles — no dirs/files.
                build_spine(b, r)
            } else {
                let ed = r.default_edition();
                let mut children = Vec::new();
                scan_dir(
                    &ed.source,
                    &ed.source,
                    &ed.include_set,
                    &ed.exclude_set,
                    &mut children,
                );
                prefix_all(&mut children, &b.slug);
                order_children(&mut children, r.layout.as_ref());
                children
            };
            Some(TreeNode {
                name: b.label.clone(),
                path: b.slug.clone(),
                is_dir: true,
                children,
                titles: None,
            })
        })
        .collect()
}

/// Audiobook spine: the rendition's default-edition top-level `*.spoken.md`
/// files (these ARE the audiobook chapters), titled by each file's H1, in
/// filename order. Per-language titles are collected across the rendition's
/// editions so the sidebar can swap titles with the language.
fn build_audio_spine(book: &BookState, rendition: &RenditionState) -> Vec<TreeNode> {
    let ed = rendition.default_edition();
    let Ok(entries) = std::fs::read_dir(&ed.source) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
    paths.sort();

    let mut nodes = Vec::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // Audio chapters are the `<aid>.spoken.md` scripts at the top level.
        if !name.ends_with(".spoken.md") {
            continue;
        }
        let title = read_h1(&path).unwrap_or_else(|| name.to_string());
        // Each edition holds the same chapter at the same filename; its H1 is
        // that edition's title.
        let titles: std::collections::HashMap<String, String> = rendition
            .editions
            .iter()
            .filter_map(|e| read_h1(&e.source.join(name)).map(|h1| (e.lang.clone(), h1)))
            .collect();
        nodes.push(TreeNode {
            name: title,
            path: format!("{}/{}", book.slug, name),
            is_dir: false,
            children: Vec::new(),
            titles: (!titles.is_empty()).then_some(titles),
        });
    }
    nodes
}

/// Sidebar for a `book.toml` book: an ordered spine of the base edition's
/// markdown chapters, each labelled by its H1 (the chapter title). Chapters
/// may be grouped in subdirectories — those become collapsible group nodes
/// (labelled by the directory name) so a book can have a nested structure.
/// Non-markdown files and markdown-free dirs (e.g. `assets/`, `audio/`) are
/// hidden — readers see titled sections, not files.
fn build_spine(book: &BookState, rendition: &RenditionState) -> Vec<TreeNode> {
    let ed = rendition.default_edition();
    build_spine_dir(book, rendition, &ed.source, &ed.source)
}

/// Recursively build a book's spine rooted at `dir` (relative to the edition
/// `root`). Markdown files become H1-titled, language-aware chapter nodes;
/// subdirectories that contain at least one markdown chapter (at any depth)
/// become group nodes. A dir with no markdown under it is dropped, so asset
/// directories never surface. Siblings are sorted by filename — the book
/// convention for chapter ordering (numeric `NN-` prefixes sort naturally).
fn build_spine_dir(
    book: &BookState,
    rendition: &RenditionState,
    root: &Path,
    dir: &Path,
) -> Vec<TreeNode> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
    paths.sort();

    let mut nodes = Vec::new();
    for path in paths {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        // `*.spoken.md` are the audiobook scripts (the `audio` rendition's
        // spine), never text chapters — keep them out of the text spine.
        if path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|n| n.ends_with(".spoken.md"))
        {
            continue;
        }
        if path.is_dir() {
            let children = build_spine_dir(book, rendition, root, &path);
            if children.is_empty() {
                continue;
            }
            // Group nodes are language-independent (editions share the dir
            // layout), so they carry the raw dir name and no per-language title.
            nodes.push(TreeNode {
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: format!("{}/{}", book.slug, rel.to_string_lossy()),
                is_dir: true,
                children,
                titles: None,
            });
        } else if matches!(
            path.extension().and_then(|x| x.to_str()),
            Some("md" | "markdown")
        ) {
            let title = read_h1(&path).unwrap_or_else(|| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });
            // Each edition holds the same chapter at the same relative path; its
            // H1 is that edition's title. Collect them so the sidebar can switch
            // titles with the language. Editions missing the page are simply
            // absent (the sidebar falls back to `name`, like the content fallback).
            let titles: std::collections::HashMap<String, String> = rendition
                .editions
                .iter()
                .filter_map(|e| read_h1(&e.source.join(rel)).map(|h1| (e.lang.clone(), h1)))
                .collect();
            nodes.push(TreeNode {
                name: title,
                path: format!("{}/{}", book.slug, rel.to_string_lossy()),
                is_dir: false,
                children: Vec::new(),
                titles: (!titles.is_empty()).then_some(titles),
            });
        }
    }
    nodes
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
                    titles: None,
                });
            }
        } else if include_set.is_match(rel_path) {
            nodes.push(TreeNode {
                name: entry.file_name().to_string_lossy().to_string(),
                path: rel_path.to_string_lossy().to_string(),
                is_dir: false,
                children: vec![],
                titles: None,
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
    use crate::config::{
        build_globset, BookState, EditionState, Layout, RenditionKind, RenditionState,
    };
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

    /// A single-`text`-rendition book over `source` (the `[[mount]]` shape).
    fn mk_mount(label: &str, slug: &str, source: &Path, layout: Option<Layout>) -> BookState {
        BookState {
            label: label.to_string(),
            slug: slug.to_string(),
            description: None,
            tags: vec![],
            collection: None,
            author: None,
            cover: None,
            backdrop: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![RenditionState {
                kind: RenditionKind::Text,
                label: "text".to_string(),
                default_lang: "default".to_string(),
                voice: None,
                layout,
                manifest: false,
                editions: vec![EditionState {
                    lang: "default".to_string(),
                    label: "default".to_string(),
                    source: source.to_path_buf(),
                    include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
                    exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
                }],
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
        book.renditions[0].manifest = true;
        let tree = build_virtual_tree(&[book], RenditionKind::Text);

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
    fn manifest_book_supports_nested_chapter_dirs() {
        let tmp = TempDir::new("lv-spine-nested");
        // A top-level chapter, plus a grouped part with its own chapters.
        fs::write(tmp.path().join("00-intro.md"), b"# Introduction\n").unwrap();
        fs::create_dir_all(tmp.path().join("01-part-one")).unwrap();
        fs::write(
            tmp.path().join("01-part-one/01-accounts.md"),
            b"# Accounts\n",
        )
        .unwrap();
        fs::write(tmp.path().join("01-part-one/02-state.md"), b"# State\n").unwrap();
        // A markdown-free dir must NOT surface as a group.
        fs::create_dir_all(tmp.path().join("assets")).unwrap();
        fs::write(tmp.path().join("assets/fig.png"), b"").unwrap();

        let mut book = mk_mount("My Book", "mybook", tmp.path(), None);
        book.renditions[0].manifest = true;
        let tree = build_virtual_tree(&[book], RenditionKind::Text);

        let kids = &tree[0].children;
        // Filename order: 00-intro.md, then the 01-part-one group; assets dropped.
        assert_eq!(kids.len(), 2);
        assert_eq!(
            (kids[0].name.as_str(), kids[0].is_dir),
            ("Introduction", false)
        );
        assert_eq!(
            (kids[1].name.as_str(), kids[1].is_dir),
            ("01-part-one", true)
        );
        assert_eq!(kids[1].path, "mybook/01-part-one");

        let inner: Vec<(&str, &str)> = kids[1]
            .children
            .iter()
            .map(|n| (n.name.as_str(), n.path.as_str()))
            .collect();
        assert_eq!(
            inner,
            vec![
                ("Accounts", "mybook/01-part-one/01-accounts.md"),
                ("State", "mybook/01-part-one/02-state.md"),
            ]
        );
    }

    #[test]
    fn manifest_spine_carries_per_language_titles() {
        // zh is the default edition; en is an overlay missing one chapter.
        let zh = TempDir::new("lv-spine-zh");
        fs::write(zh.path().join("01-intro.md"), "# 介绍\n").unwrap();
        fs::write(zh.path().join("02-types.md"), "# 类型\n").unwrap();
        let en = TempDir::new("lv-spine-en");
        fs::write(en.path().join("01-intro.md"), "# Introduction\n").unwrap();
        // 02-types.md intentionally absent in `en` (untranslated chapter).

        let book = BookState {
            label: "Book".to_string(),
            slug: "book".to_string(),
            description: None,
            tags: vec![],
            collection: None,
            author: None,
            cover: None,
            backdrop: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![RenditionState {
                kind: RenditionKind::Text,
                label: "text".to_string(),
                default_lang: "zh".to_string(),
                voice: None,
                layout: None,
                manifest: true,
                editions: vec![
                    EditionState {
                        lang: "zh".to_string(),
                        label: "中文".to_string(),
                        source: zh.path().to_path_buf(),
                        include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
                        exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
                    },
                    EditionState {
                        lang: "en".to_string(),
                        label: "English".to_string(),
                        source: en.path().to_path_buf(),
                        include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
                        exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
                    },
                ],
            }],
        };

        let tree = build_virtual_tree(&[book], RenditionKind::Text);
        let kids = &tree[0].children;

        // Default `name` is the zh (default edition) title.
        assert_eq!(kids[0].name, "介绍");
        let t0 = kids[0].titles.as_ref().unwrap();
        assert_eq!(t0.get("zh").map(String::as_str), Some("介绍"));
        assert_eq!(t0.get("en").map(String::as_str), Some("Introduction"));

        // Chapter missing in `en`: only zh title present, sidebar falls back to `name`.
        assert_eq!(kids[1].name, "类型");
        let t1 = kids[1].titles.as_ref().unwrap();
        assert_eq!(t1.get("zh").map(String::as_str), Some("类型"));
        assert_eq!(t1.get("en"), None);
    }

    #[test]
    fn virtual_tree_prefixes_paths_with_slug() {
        let tmp = TempDir::new("lv-tree");
        tmp.touch("README.md");
        tmp.touch("sub/INDEX.md");

        let mount = mk_mount("Docs", "docs", tmp.path(), None);
        let tree = build_virtual_tree(&[mount], RenditionKind::Text);

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
        let tree = build_virtual_tree(&[mount], RenditionKind::Text);
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
        let tree = build_virtual_tree(&[mount], RenditionKind::Text);

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
        let tree = build_virtual_tree(&[docs, tasks], RenditionKind::Text);

        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].path, "docs");
        assert_eq!(tree[1].path, "tasks");
        assert_eq!(tree[0].children[0].path, "docs/hello.md");
        assert_eq!(tree[1].children[0].path, "tasks/work.md");
    }

    #[test]
    fn audio_rendition_spine_lists_spoken_chapters() {
        // A book with both renditions: text reads `*.md`, audio reads the
        // sibling `*.spoken.md` scripts. The text spine must hide `.spoken.md`;
        // the audio spine must list exactly them, H1-titled.
        let text_dir = TempDir::new("lv-rt-text");
        fs::write(text_dir.path().join("01-intro.md"), b"# Intro\n").unwrap();
        // A stray `.spoken.md` in the text dir must NOT appear in the text spine.
        fs::write(
            text_dir.path().join("01-intro.spoken.md"),
            b"# Intro spoken\n",
        )
        .unwrap();
        let audio_dir = TempDir::new("lv-rt-audio");
        fs::write(audio_dir.path().join("01-intro.spoken.md"), "# 介绍\n").unwrap();
        fs::write(audio_dir.path().join("02-types.spoken.md"), "# 类型\n").unwrap();
        // A non-spoken file in the audio dir must NOT surface.
        fs::write(audio_dir.path().join("notes.md"), b"# notes\n").unwrap();

        let mk_ed = |lang: &str, src: &Path| EditionState {
            lang: lang.to_string(),
            label: lang.to_string(),
            source: src.to_path_buf(),
            include_set: build_globset(&["**/*.md".to_string()]).unwrap(),
            exclude_set: build_globset(&["**/.git/**".to_string()]).unwrap(),
        };
        let book = BookState {
            label: "Eth".to_string(),
            slug: "eth".to_string(),
            description: None,
            tags: vec![],
            collection: None,
            author: None,
            cover: None,
            backdrop: None,
            default_rendition: RenditionKind::Text,
            renditions: vec![
                RenditionState {
                    kind: RenditionKind::Text,
                    label: "阅读".to_string(),
                    default_lang: "zh".to_string(),
                    voice: None,
                    layout: None,
                    manifest: true,
                    editions: vec![mk_ed("zh", text_dir.path())],
                },
                RenditionState {
                    kind: RenditionKind::Audio,
                    label: "听书".to_string(),
                    default_lang: "zh".to_string(),
                    voice: None,
                    layout: None,
                    manifest: true,
                    editions: vec![mk_ed("zh", audio_dir.path())],
                },
            ],
        };

        let books = [book];
        // Text spine: just the `.md` chapter, `.spoken.md` hidden.
        let text = build_virtual_tree(&books, RenditionKind::Text);
        let text_kids: Vec<&str> = text[0].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(text_kids, vec!["Intro"]);

        // Audio spine: the two `.spoken.md` scripts, H1-titled, filename order.
        let audio = build_virtual_tree(&books, RenditionKind::Audio);
        let audio_kids: Vec<(&str, &str)> = audio[0]
            .children
            .iter()
            .map(|n| (n.name.as_str(), n.path.as_str()))
            .collect();
        assert_eq!(
            audio_kids,
            vec![
                ("介绍", "eth/01-intro.spoken.md"),
                ("类型", "eth/02-types.spoken.md"),
            ]
        );
    }

    #[test]
    fn book_without_rendition_is_omitted_from_that_tree() {
        let text_dir = TempDir::new("lv-noaud");
        text_dir.touch("a.md");
        // Text-only book (the `[[mount]]` shape).
        let book = mk_mount("Docs", "docs", text_dir.path(), None);
        // Asking for the audio tree yields no node for a text-only book.
        let audio = build_virtual_tree(&[book], RenditionKind::Audio);
        assert!(audio.is_empty());
    }

    #[test]
    fn matches_layout_kinds() {
        assert!(matches_layout("README.md", "README.md", false));
        assert!(!matches_layout("README.md", "README.md", true)); // file pattern, dir name
        assert!(matches_layout("api/", "api", true));
        assert!(!matches_layout("api/", "api", false)); // dir pattern, file name
    }
}
