//! Merkle reconcile planner — pure.
//!
//! Given a freshly-built corpus DAG (`new`) and the last-deployed DAG
//! (`stored`, reconstructed from the `merkle_nodes` table), walk both by child
//! name in lockstep and emit the minimal `Plan`:
//!
//!   * a child whose hash equals the stored child's hash → identical subtree,
//!     pruned (the whole point — unchanged books cost nothing);
//!   * a new/changed leaf → `put`;
//!   * a child present in `stored` but absent in `new` → its leaves are
//!     `delete`d.
//!
//! No IO: the actual bytes/HTML for a `put` leaf are fetched by the sync layer
//! afterwards, only for the leaves named here.

use std::collections::HashMap;

use super::merkle::{Dag, Leaf, Node};

/// The minimal set of leaf operations to make `stored` match `new`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Leaves to (re)apply — fetch content, upsert pg / put rustfs.
    pub put: Vec<Leaf>,
    /// Leaves to remove — delete pg rows / orphaned rustfs objects.
    pub delete: Vec<Leaf>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.put.is_empty() && self.delete.is_empty()
    }
}

/// Compute the reconcile plan. `stored` may be empty (first sync) → every leaf
/// in `new` is a `put`.
pub fn plan(new: &Dag, stored: &Dag) -> Plan {
    let mut p = Plan::default();
    if new.is_empty() && stored.is_empty() {
        return p;
    }
    let new_root = if new.is_empty() { None } else { Some(new.root.as_str()) };
    let stored_root = if stored.is_empty() {
        None
    } else {
        Some(stored.root.as_str())
    };
    diff_node(new_root, stored_root, new, stored, &mut p);
    p
}

fn diff_node(
    new_hash: Option<&str>,
    stored_hash: Option<&str>,
    new: &Dag,
    stored: &Dag,
    plan: &mut Plan,
) {
    match (new_hash, stored_hash) {
        // Identical hashes → identical subtree, prune.
        (Some(n), Some(s)) if n == s => {}
        // Gone from `new` → delete every leaf the stored subtree held.
        (None, Some(s)) => {
            for l in stored.leaves_under(s) {
                plan.delete.push(l.clone());
            }
        }
        // Brand-new in `new` → put every leaf in the subtree.
        (Some(n), None) => {
            for l in new.leaves_under(n) {
                plan.put.push(l.clone());
            }
        }
        // Both present but different → descend.
        (Some(n), Some(s)) => match new.nodes.get(n) {
            Some(Node::Leaf(l)) => plan.put.push(l.clone()),
            Some(Node::Tree(new_children)) => {
                let stored_children: HashMap<&str, &str> = match stored.nodes.get(s) {
                    Some(Node::Tree(c)) => c.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect(),
                    // Stored side was a leaf (kind/shape changed): treat its
                    // leaves as deletions, then add the new subtree.
                    Some(Node::Leaf(l)) => {
                        plan.delete.push(l.clone());
                        HashMap::new()
                    }
                    None => HashMap::new(),
                };
                let new_names: HashMap<&str, &str> =
                    new_children.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

                for (name, child) in new_children {
                    diff_node(
                        Some(child),
                        stored_children.get(name.as_str()).copied(),
                        new,
                        stored,
                        plan,
                    );
                }
                for (name, child) in &stored_children {
                    if !new_names.contains_key(name) {
                        diff_node(None, Some(child), new, stored, plan);
                    }
                }
            }
            None => {}
        },
        (None, None) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::merkle::{Build, Dag};
    use super::*;

    fn leaf(path: &str, content: &str) -> Build {
        Build::Leaf {
            path: path.into(),
            kind: "chapter".into(),
            content_hash: content.into(),
        }
    }

    fn corpus(books: &[(&str, &[(&str, &str)])]) -> Dag {
        // root → book → chapter(rel_path)
        Dag::build(Build::Tree(
            books
                .iter()
                .map(|(book, chapters)| {
                    (
                        (*book).to_string(),
                        Build::Tree(
                            chapters
                                .iter()
                                .map(|(rel, content)| {
                                    ((*rel).to_string(), leaf(&format!("{book}/{rel}"), content))
                                })
                                .collect(),
                        ),
                    )
                })
                .collect(),
        ))
    }

    #[test]
    fn identical_trees_empty_plan() {
        let a = corpus(&[("b1", &[("00", "h0"), ("01", "h1")])]);
        let b = corpus(&[("b1", &[("00", "h0"), ("01", "h1")])]);
        assert!(plan(&a, &b).is_empty(), "no changes → empty plan");
    }

    #[test]
    fn first_sync_puts_everything() {
        let new = corpus(&[("b1", &[("00", "h0"), ("01", "h1")])]);
        let p = plan(&new, &Dag::default());
        assert_eq!(p.put.len(), 2);
        assert!(p.delete.is_empty());
    }

    #[test]
    fn one_changed_leaf_only_touches_that_leaf() {
        let stored = corpus(&[
            ("b1", &[("00", "h0"), ("01", "h1")]),
            ("b2", &[("00", "g0")]),
        ]);
        let new = corpus(&[
            ("b1", &[("00", "h0"), ("01", "CHANGED")]),
            ("b2", &[("00", "g0")]),
        ]);
        let p = plan(&new, &stored);
        assert_eq!(p.put.len(), 1, "only the changed leaf");
        assert_eq!(p.put[0].path, "b1/01");
        assert!(p.delete.is_empty(), "b2 pruned, b1/00 pruned");
    }

    #[test]
    fn deleted_leaf_is_deleted() {
        let stored = corpus(&[("b1", &[("00", "h0"), ("01", "h1")])]);
        let new = corpus(&[("b1", &[("00", "h0")])]);
        let p = plan(&new, &stored);
        assert!(p.put.is_empty());
        assert_eq!(p.delete.len(), 1);
        assert_eq!(p.delete[0].path, "b1/01");
    }

    #[test]
    fn removed_book_deletes_all_its_leaves() {
        let stored = corpus(&[("b1", &[("00", "h0")]), ("b2", &[("00", "g0"), ("01", "g1")])]);
        let new = corpus(&[("b1", &[("00", "h0")])]);
        let p = plan(&new, &stored);
        assert!(p.put.is_empty());
        let mut deleted: Vec<_> = p.delete.iter().map(|l| l.path.clone()).collect();
        deleted.sort();
        assert_eq!(deleted, vec!["b2/00", "b2/01"]);
    }
}
