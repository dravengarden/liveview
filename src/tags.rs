use std::collections::BTreeSet;

/// Validate and order author-provided search tags. Tags are an open vocabulary
/// owned by each manifest. Sorting makes catalog identity
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
        if tag.chars().count() > MAX_TAG_LENGTH {
            return Err(format!(
                "tag {tag:?} exceeds the {MAX_TAG_LENGTH}-character limit"
            ));
        }
        if !tag
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | '.'))
        {
            return Err(format!(
                "tag {tag:?} must use letters, digits, dots, underscores, or hyphens"
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

    #[test]
    fn normalize_tags_sorts_deduplicates_and_accepts_precise_keywords() {
        assert_eq!(
            normalize_tags(vec![
                "subject.history".into(),
                "format.reference".into(),
                "subject.history".into(),
            ])
            .unwrap(),
            vec!["format.reference", "subject.history"]
        );
        assert_eq!(
            normalize_tags(vec!["field-observations".into(), "主题.生态学".into()]).unwrap(),
            vec!["field-observations", "主题.生态学"]
        );
        assert!(normalize_tags(vec!["not a tag".into()]).is_err());
    }
}
