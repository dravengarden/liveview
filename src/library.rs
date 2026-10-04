//! User-owned library organization, independent of deployed content metadata.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Library {
    pub revision: u64,
    pub directories: Vec<Directory>,
    pub placements: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Directory {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Change {
    pub revision: u64,
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub undo_revision: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Operation {
    Create {
        id: String,
        name: String,
        parent: Option<String>,
    },
    Rename {
        id: String,
        name: String,
    },
    MoveDirectory {
        id: String,
        parent: Option<String>,
    },
    Place {
        slug: String,
        directory: Option<String>,
    },
    Delete {
        id: String,
    },
}
impl Library {
    pub fn apply(&self, change: &Change, books: &HashSet<String>) -> Result<Self, String> {
        if change.revision != self.revision {
            return Err("Revision conflict: refresh before retrying".into());
        }
        if change.operations.is_empty() || change.operations.len() > 1000 {
            return Err("Expected 1–1000 operations".into());
        }
        let mut next = self.clone();
        for op in &change.operations {
            match op {
                Operation::Create { id, name, parent } => {
                    if id.is_empty()
                        || id.len() > 128
                        || next.directories.iter().any(|d| d.id == *id)
                    {
                        return Err("Invalid or duplicate directory ID".into());
                    }
                    next.directories.push(Directory {
                        id: id.clone(),
                        name: name.trim().into(),
                        parent: parent.clone(),
                    });
                }
                Operation::Rename { id, name } => {
                    next.directories
                        .iter_mut()
                        .find(|d| d.id == *id)
                        .ok_or("Directory not found")?
                        .name = name.trim().into()
                }
                Operation::MoveDirectory { id, parent } => {
                    next.directories
                        .iter_mut()
                        .find(|d| d.id == *id)
                        .ok_or("Directory not found")?
                        .parent = parent.clone()
                }
                Operation::Place { slug, directory } => {
                    if !books.contains(slug) {
                        return Err(format!("Unknown content: {slug}"));
                    }
                    if let Some(id) = directory {
                        next.placements.insert(slug.clone(), id.clone());
                    } else {
                        next.placements.remove(slug);
                    }
                }
                Operation::Delete { id } => {
                    let parent = next
                        .directories
                        .iter()
                        .find(|d| d.id == *id)
                        .ok_or("Directory not found")?
                        .parent
                        .clone();
                    next.directories.retain(|d| d.id != *id);
                    for d in &mut next.directories {
                        if d.parent.as_ref() == Some(id) {
                            d.parent.clone_from(&parent);
                        }
                    }
                    next.placements.retain(|_, v| v != id);
                }
            }
        }
        next.validate()?;
        next.revision += 1;
        Ok(next)
    }
    fn validate(&self) -> Result<(), String> {
        if self.directories.len() > 10000 {
            return Err("Too many directories".into());
        }
        for dir in &self.directories {
            if dir.name.is_empty() || dir.name.len() > 256 || dir.name.chars().any(char::is_control)
            {
                return Err(
                    "Directory names must be nonempty and contain no control characters".into(),
                );
            }
            if self
                .directories
                .iter()
                .any(|d| d.id != dir.id && d.parent == dir.parent && d.name == dir.name)
            {
                return Err("A sibling directory already has this name".into());
            }
            let mut seen = HashSet::from([dir.id.as_str()]);
            let mut parent = dir.parent.as_deref();
            while let Some(id) = parent {
                if !seen.insert(id) {
                    return Err("Directory cycle".into());
                }
                parent = self
                    .directories
                    .iter()
                    .find(|d| d.id == id)
                    .ok_or("Parent directory not found")?
                    .parent
                    .as_deref();
            }
        }
        if self
            .placements
            .values()
            .any(|id| !self.directories.iter().any(|d| d.id == *id))
        {
            return Err("Placement directory not found".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn change(revision: u64, operations: Vec<Operation>) -> Change {
        Change {
            revision,
            operations,
            dry_run: false,
            undo_revision: None,
        }
    }
    #[test]
    fn nested_move_rejects_cycles_and_stale_plans_atomically() {
        let books = HashSet::from(["book".into()]);
        let tree = Library::default()
            .apply(
                &change(
                    0,
                    vec![
                        Operation::Create {
                            id: "a".into(),
                            name: "A".into(),
                            parent: None,
                        },
                        Operation::Create {
                            id: "b".into(),
                            name: "B".into(),
                            parent: Some("a".into()),
                        },
                    ],
                ),
                &books,
            )
            .unwrap();
        assert!(
            tree.apply(
                &change(
                    1,
                    vec![Operation::MoveDirectory {
                        id: "a".into(),
                        parent: Some("b".into())
                    }]
                ),
                &books
            )
            .is_err()
        );
        assert!(
            tree.apply(
                &change(0, vec![Operation::Delete { id: "a".into() }]),
                &books
            )
            .is_err()
        );
        assert_eq!(tree.directories.len(), 2);
    }
    #[test]
    fn deleting_directory_preserves_child_directories_and_content() {
        let books = HashSet::from(["book".into()]);
        let tree = Library::default()
            .apply(
                &change(
                    0,
                    vec![
                        Operation::Create {
                            id: "a".into(),
                            name: "A".into(),
                            parent: None,
                        },
                        Operation::Create {
                            id: "b".into(),
                            name: "B".into(),
                            parent: Some("a".into()),
                        },
                        Operation::Place {
                            slug: "book".into(),
                            directory: Some("a".into()),
                        },
                    ],
                ),
                &books,
            )
            .unwrap();
        let next = tree
            .apply(
                &change(1, vec![Operation::Delete { id: "a".into() }]),
                &books,
            )
            .unwrap();
        assert_eq!(next.directories[0].parent, None);
        assert!(next.placements.is_empty());
        assert!(books.contains("book"));
    }
}
