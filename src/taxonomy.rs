use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LocalizedLabels {
    pub en: String,
    pub zh: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FacetDefinition {
    pub id: String,
    pub labels: LocalizedLabels,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TagDefinition {
    pub id: String,
    pub facet: String,
    pub labels: LocalizedLabels,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Taxonomy {
    pub facets: Vec<FacetDefinition>,
    pub tags: Vec<TagDefinition>,
}

pub fn taxonomy() -> &'static Taxonomy {
    static TAXONOMY: OnceLock<Taxonomy> = OnceLock::new();
    TAXONOMY.get_or_init(|| {
        serde_json::from_str(include_str!("../taxonomy.json"))
            .expect("the built-in taxonomy must be valid JSON")
    })
}

/// Validate and canonicalize author-provided search tags. Book manifests keep
/// their precise, open-vocabulary keywords; `taxonomy.json` maps a curated
/// subset onto stable discovery facets. Sorting makes catalog identity
/// independent of manifest ordering and keeps API output deterministic.
pub fn normalize_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    const MAX_TAGS: usize = 128;
    const MAX_TAG_LENGTH: usize = 64;
    let mut normalized = BTreeSet::new();
    for raw in tags {
        let tag = raw.trim();
        if tag.is_empty() {
            return Err("tag IDs must not be empty".to_string());
        }
        if tag.len() > MAX_TAG_LENGTH {
            return Err(format!(
                "tag {tag:?} exceeds the {MAX_TAG_LENGTH}-byte limit"
            ));
        }
        if !tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(format!(
                "tag {tag:?} must use ASCII letters, digits, dots, underscores, or hyphens"
            ));
        }
        normalized.insert(tag.to_string());
    }
    if normalized.len() > MAX_TAGS {
        return Err(format!(
            "a book may declare at most {MAX_TAGS} tags (found {})",
            normalized.len()
        ));
    }
    Ok(normalized.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn taxonomy_is_internally_consistent() {
        let taxonomy = taxonomy();
        let facets: HashSet<_> = taxonomy.facets.iter().map(|f| f.id.as_str()).collect();
        let mut ids = HashSet::new();
        for tag in &taxonomy.tags {
            assert!(ids.insert(&tag.id), "duplicate tag {}", tag.id);
            assert!(
                facets.contains(tag.facet.as_str()),
                "unknown facet on {}",
                tag.id
            );
        }
    }

    #[test]
    fn normalize_tags_sorts_deduplicates_and_accepts_precise_keywords() {
        assert_eq!(
            normalize_tags(vec![
                "technology.rust".into(),
                "topic.agents".into(),
                "technology.rust".into(),
            ])
            .unwrap(),
            vec!["technology.rust", "topic.agents"]
        );
        assert_eq!(
            normalize_tags(vec!["market-microstructure".into()]).unwrap(),
            vec!["market-microstructure"]
        );
        assert!(normalize_tags(vec!["not a tag".into()]).is_err());
    }
}
