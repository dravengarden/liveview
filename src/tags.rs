use std::collections::BTreeSet;

/// Validate and order author-provided search tags. Tags are an open vocabulary
/// owned by each manifest. Sorting makes catalog identity
/// independent of manifest ordering and keeps API output deterministic.
///
/// A tag is a lowercase keyword; `facet.value` opts into a derived facet. The
/// web reader (`web/src/libraryDiscovery.ts`) splits on the first `.` and
/// labels each value by its `.`/`_`/`-`-separated words, so every dot segment
/// must be non-empty and contain a letter or digit — otherwise the tag would
/// lose its facet or render with an empty label. Uppercase is rejected so one
/// keyword can't split into case-variant facets and chips.
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
        if tag
            .chars()
            .any(|c| !c.to_lowercase().eq(std::iter::once(c)))
        {
            return Err(format!("tag {tag:?} must be lowercase"));
        }
        if tag
            .split('.')
            .any(|segment| !segment.chars().any(char::is_alphanumeric))
        {
            return Err(format!(
                "tag {tag:?} must not have an empty or punctuation-only `.` segment"
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

    /// Shared with `web/src/libraryDiscovery.test.ts` — keep both lists aligned.
    #[test]
    fn tag_fixtures_match_web_facet_derivation() {
        let accepted = [
            "beginner",
            "subject.history",
            "format.field-guide",
            "主题.生态学",
            "a.b.c",
            "x_y",
            "2024",
        ];
        for tag in accepted {
            assert!(normalize_tags(vec![tag.into()]).is_ok(), "{tag:?}");
        }
        let rejected = [
            "",
            ".",
            "-",
            "a.",
            ".a",
            "a..b",
            "a.-",
            "Subject.history",
            "École",
        ];
        for tag in rejected {
            assert!(normalize_tags(vec![tag.into()]).is_err(), "{tag:?}");
        }
    }
}
