use globset::GlobSet;
use std::path::Path;

use crate::shared::TreeNode;

/// Scan the root directory and build a tree of matching files.
pub fn build_file_tree(root: &Path, include_set: &GlobSet, exclude_set: &GlobSet) -> Vec<TreeNode> {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut tree = Vec::new();
    scan_dir(
        &canonical_root,
        &canonical_root,
        include_set,
        exclude_set,
        &mut tree,
    );
    sort_tree(&mut tree);
    tree
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

fn sort_tree(nodes: &mut Vec<TreeNode>) {
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    for node in nodes {
        if node.is_dir {
            sort_tree(&mut node.children);
        }
    }
}
