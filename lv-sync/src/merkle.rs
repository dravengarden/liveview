//! Content-addressed Merkle DAG over the book corpus — the SHARED implementation.
//!
//! Pure: it hashes structure, never touches IO. blake3 compiles to WASM, so this
//! one module is the single source of truth for the Merkle hashing used by the
//! server (build + diff the corpus) AND the client (verify / diff the manifest).
//! (Extracted verbatim from the server's `src/sync/merkle.rs`; the server will
//! depend on this crate by path so the two never drift.)

use std::collections::HashMap;

/// A content leaf — identity plus the blake3 (hex) of its deployed form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Leaf {
    /// Unique logical id within the corpus (e.g. `book/text/zh/00.md`).
    pub path: String,
    /// Opaque tag the sync layer uses to decide how to apply. Part of the leaf
    /// hash so a kind change re-applies.
    pub kind: String,
    /// blake3 of the leaf's deployed content, computed by the caller.
    pub content_hash: String,
}

/// A built node: a content leaf, or an interior node over sorted children.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Node {
    Leaf(Leaf),
    /// Sorted `(child_name, child_hash)` — sorted so the hash is order-stable.
    Tree(Vec<(String, String)>),
}

/// A built DAG: the root hash plus every node keyed by its hash.
#[derive(Clone, Debug, Default)]
pub struct Dag {
    pub root: String,
    pub nodes: HashMap<String, Node>,
}

/// Recursive builder input — the corpus tree before hashing.
pub enum Build {
    Leaf {
        path: String,
        kind: String,
        content_hash: String,
    },
    /// `(child_name, subtree)` pairs; the builder sorts by name.
    Tree(Vec<(String, Build)>),
}

/// The node hash of a leaf — its content-addressed identity.
pub fn leaf_hash(l: &Leaf) -> String {
    hash_leaf(l)
}

fn hash_leaf(l: &Leaf) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"leaf\0");
    h.update(l.path.as_bytes());
    h.update(b"\0");
    h.update(l.kind.as_bytes());
    h.update(b"\0");
    h.update(l.content_hash.as_bytes());
    h.finalize().to_hex().to_string()
}

fn hash_tree(entries: &[(String, String)]) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"tree\0"); // domain separation from leaves
    for (name, child) in entries {
        h.update(name.as_bytes());
        h.update(b"\0");
        h.update(child.as_bytes());
        h.update(b"\0");
    }
    h.finalize().to_hex().to_string()
}

impl Dag {
    /// Build the DAG from a corpus tree, computing every node hash bottom-up.
    pub fn build(root: Build) -> Self {
        let mut nodes = HashMap::new();
        let root = insert(&mut nodes, root);
        Self { root, nodes }
    }

    /// Whether the DAG is empty (no root yet).
    pub fn is_empty(&self) -> bool {
        self.root.is_empty()
    }

    /// Every content leaf reachable from `hash`, in deterministic order.
    pub fn leaves_under(&self, hash: &str) -> Vec<&Leaf> {
        let mut out = Vec::new();
        self.collect(hash, &mut out);
        out
    }

    fn collect<'a>(&'a self, hash: &str, out: &mut Vec<&'a Leaf>) {
        match self.nodes.get(hash) {
            Some(Node::Leaf(l)) => out.push(l),
            Some(Node::Tree(children)) => {
                for (_, child) in children {
                    self.collect(child, out);
                }
            }
            None => {}
        }
    }
}

fn insert(nodes: &mut HashMap<String, Node>, build: Build) -> String {
    match build {
        Build::Leaf {
            path,
            kind,
            content_hash,
        } => {
            let leaf = Leaf {
                path,
                kind,
                content_hash,
            };
            let hash = hash_leaf(&leaf);
            nodes.insert(hash.clone(), Node::Leaf(leaf));
            hash
        }
        Build::Tree(children) => {
            let mut entries: Vec<(String, String)> = children
                .into_iter()
                .map(|(name, sub)| (name, insert(nodes, sub)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let hash = hash_tree(&entries);
            nodes.insert(hash.clone(), Node::Tree(entries));
            hash
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(path: &str, content: &str) -> Build {
        Build::Leaf {
            path: path.into(),
            kind: "chapter".into(),
            content_hash: content.into(),
        }
    }

    #[test]
    fn root_is_order_independent() {
        let a = Dag::build(Build::Tree(vec![
            ("a".into(), leaf("x/a", "h1")),
            ("b".into(), leaf("x/b", "h2")),
        ]));
        let b = Dag::build(Build::Tree(vec![
            ("b".into(), leaf("x/b", "h2")),
            ("a".into(), leaf("x/a", "h1")),
        ]));
        assert_eq!(a.root, b.root);
    }

    #[test]
    fn content_change_changes_root() {
        let a = Dag::build(Build::Tree(vec![("a".into(), leaf("x/a", "h1"))]));
        let b = Dag::build(Build::Tree(vec![("a".into(), leaf("x/a", "h2"))]));
        assert_ne!(a.root, b.root);
    }

    #[test]
    fn identical_subtrees_dedup_to_one_node() {
        let dag = Dag::build(Build::Tree(vec![
            ("b1".into(), Build::Tree(vec![("a".into(), leaf("a", "h"))])),
            ("b2".into(), Build::Tree(vec![("a".into(), leaf("a", "h"))])),
        ]));
        assert_eq!(dag.nodes.len(), 3);
    }
}
