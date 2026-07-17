//! Audio retention + download-order policy (heuristic, pure logic).
//!
//! Text-class resources are ALWAYS kept (small) — out of scope here. AUDIO is the
//! 11 GB problem, so it's budget-bounded with the BOOK as the atomic unit:
//!   - WHICH books to keep: a `frecency` score (recency + frequency, decayed) per
//!     book; over budget, evict the lowest-score book's audio whole.
//!   - DOWNLOAD ORDER: within the current book, spread OUT from the chapter you're
//!     on (forward-biased) so the next thing you'll play lands first; then other
//!     books by frecency. The same ordered list is the IDLE-fill worklist — when
//!     the current book is complete the app keeps pulling down the list (next
//!     books by frecency) until the budget is full.
//!
//! This module computes the plan; the native shell executes it (fetch + evict).

use std::collections::{HashMap, HashSet};

use crate::{Manifest, Resource};

/// Update a book's frecency on use at `now`: decay the old score by elapsed time,
/// then add 1. Recent + frequent → high. `halflife` and `now`/`last_used` share
/// one time unit (e.g. days, or ms — be consistent).
pub fn bump_frecency(score: f64, last_used: f64, now: f64, halflife: f64) -> f64 {
    let dt = (now - last_used).max(0.0);
    let decay = if halflife > 0.0 {
        0.5f64.powf(dt / halflife)
    } else {
        1.0
    };
    score * decay + 1.0
}

/// Inputs to the audio plan.
pub struct PlanInput<'a> {
    pub manifest: &'a Manifest,
    /// The book currently open — always kept, downloaded first.
    pub current_slug: &'a str,
    /// Index of the open chapter within the current book's audio chapters
    /// (0-based, in chapter order). The download spreads out from here.
    pub current_chapter: usize,
    /// Audio cache budget in bytes.
    pub budget_bytes: u64,
    /// Per-book frecency (slug → score); a book absent here scores 0.
    pub scores: &'a HashMap<String, f64>,
    /// Hashes already in the store (so we don't re-fetch + can compute evictions).
    pub cached: &'a HashSet<String>,
}

/// The plan: what to download (priority order) and what to drop.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// Audio resources to fetch, HIGHEST priority first (current book proximity
    /// order, then other books by frecency) — also the idle-fill worklist.
    pub fetch: Vec<Resource>,
    /// Hashes to evict (audio of the lowest-frecency books that don't fit budget).
    pub evict: Vec<String>,
}

/// Forward-biased proximity key from the current chapter: 0 for the current
/// chapter, then next chapters before previous ones (you usually go forward).
fn proximity_key(i: usize, current: usize) -> f64 {
    if i >= current {
        (i - current) as f64
    } else {
        (current - i) as f64 * 1.5
    }
}

/// Compute the audio download + eviction plan (see module docs).
pub fn plan_audio(input: &PlanInput) -> Plan {
    // Group audio resources by book slug, in chapter (path) order.
    let mut by_book: HashMap<String, Vec<Resource>> = HashMap::new();
    let mut hash_book: HashMap<String, String> = HashMap::new();
    for r in &input.manifest.resources {
        if r.kind != "audio" {
            continue;
        }
        let slug = book_of(&r.path);
        hash_book.insert(r.hash.clone(), slug.clone());
        by_book.entry(slug).or_default().push(r.clone());
    }
    for v in by_book.values_mut() {
        v.sort_by(|a, b| a.path.cmp(&b.path));
    }

    // Book priority: current first, then by frecency desc (ties: slug for
    // determinism).
    let mut books: Vec<String> = by_book.keys().cloned().collect();
    books.sort_by(|a, b| {
        if a == input.current_slug {
            return std::cmp::Ordering::Less;
        }
        if b == input.current_slug {
            return std::cmp::Ordering::Greater;
        }
        let sa = input.scores.get(a).copied().unwrap_or(0.0);
        let sb = input.scores.get(b).copied().unwrap_or(0.0);
        sb.partial_cmp(&sa)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });

    // Greedily KEEP books in priority order until the budget is full. The current
    // book is always kept (even if it alone exceeds budget — others get evicted).
    let mut kept: HashSet<String> = HashSet::new();
    let mut used: u64 = 0;
    for slug in &books {
        let book_bytes: u64 = by_book[slug].iter().map(|r| r.bytes).sum();
        let is_current = slug == input.current_slug;
        if is_current || used.saturating_add(book_bytes) <= input.budget_bytes {
            kept.insert(slug.clone());
            used = used.saturating_add(book_bytes);
        }
    }

    // FETCH: uncached audio of kept books, in priority order. The current book's
    // chapters are proximity-ordered from `current_chapter`; others stay in
    // chapter order.
    let mut fetch = Vec::new();
    for slug in &books {
        if !kept.contains(slug) {
            continue;
        }
        // Pair each chapter with its CHAPTER-ORDER index (by_book is path-sorted),
        // then for the current book reorder by proximity to the open chapter.
        let mut chapters: Vec<(usize, Resource)> =
            by_book[slug].iter().cloned().enumerate().collect();
        if slug == input.current_slug {
            chapters.sort_by(|(ia, _), (ib, _)| {
                let ka = proximity_key(*ia, input.current_chapter);
                let kb = proximity_key(*ib, input.current_chapter);
                ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        for (_, r) in chapters {
            if !input.cached.contains(&r.hash) {
                fetch.push(r);
            }
        }
    }

    // EVICT: cached audio whose book isn't kept.
    let mut evict = Vec::new();
    for hash in input.cached {
        if let Some(slug) = hash_book.get(hash)
            && !kept.contains(slug)
        {
            evict.push(hash.clone());
        }
    }
    evict.sort();

    Plan { fetch, evict }
}

/// The book slug from a resource path `slug/rendition/lang/rel#kind`.
fn book_of(path: &str) -> String {
    path.split('/').next().unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio(slug: &str, ch: u32, bytes: u64) -> Resource {
        Resource {
            path: format!("{slug}/audio/zh/{ch:02}.md#audio"),
            hash: format!("{slug}-{ch}"),
            kind: "audio".into(),
            bytes,
            url: format!("/api/blob/{slug}-{ch}"),
        }
    }

    #[test]
    fn frecency_recent_and_frequent_wins() {
        // Frequent-recent beats once-long-ago.
        let a = bump_frecency(bump_frecency(0.0, 0.0, 0.0, 14.0), 0.0, 1.0, 14.0); // 2 uses, recent
        let b = bump_frecency(0.0, 0.0, 100.0, 14.0); // 1 use, long ago (but just bumped)
        assert!(a > b);
        // Decay: an old score shrinks.
        let old = bump_frecency(10.0, 0.0, 28.0, 14.0); // 2 halflives → ~10*0.25+1
        assert!(old < 4.0 && old > 3.0);
    }

    #[test]
    fn current_book_first_proximity_spread() {
        let m = Manifest {
            root: "r".into(),
            resources: vec![
                audio("b", 0, 10),
                audio("b", 1, 10),
                audio("b", 2, 10),
                audio("b", 3, 10),
                audio("b", 4, 10),
            ],
            ..Manifest::default()
        };
        let plan = plan_audio(&PlanInput {
            manifest: &m,
            current_slug: "b",
            current_chapter: 2,
            budget_bytes: 1_000,
            scores: &HashMap::new(),
            cached: &HashSet::new(),
        });
        // From chapter 2, forward-biased: 2, 3, 1, 4, 0.
        let order: Vec<u32> = plan
            .fetch
            .iter()
            .map(|r| r.path.split('/').next_back().unwrap()[..2].parse().unwrap())
            .collect();
        assert_eq!(order, vec![2, 3, 1, 4, 0]);
    }

    #[test]
    fn budget_keeps_current_plus_top_frecency_evicts_rest() {
        let m = Manifest {
            root: "r".into(),
            resources: vec![
                audio("cur", 0, 100),
                audio("hot", 0, 100),
                audio("cold", 0, 100),
            ],
            ..Manifest::default()
        };
        let mut scores = HashMap::new();
        scores.insert("hot".to_string(), 5.0);
        scores.insert("cold".to_string(), 0.1);
        // Budget fits 2 books (200). Current + hot kept; cold evicted (it was cached).
        let mut cached = HashSet::new();
        cached.insert("cold-0".to_string()); // cold's audio is in the store
        let plan = plan_audio(&PlanInput {
            manifest: &m,
            current_slug: "cur",
            current_chapter: 0,
            budget_bytes: 200,
            scores: &scores,
            cached: &cached,
        });
        // Fetch: cur then hot (cold doesn't fit).
        let slugs: Vec<String> = plan.fetch.iter().map(|r| super::book_of(&r.path)).collect();
        assert_eq!(slugs, vec!["cur", "hot"]);
        // Evict the over-budget cold's cached audio.
        assert_eq!(plan.evict, vec!["cold-0"]);
    }

    #[test]
    fn current_book_kept_even_over_budget() {
        let m = Manifest {
            root: "r".into(),
            resources: vec![audio("big", 0, 999), audio("other", 0, 10)],
            ..Manifest::default()
        };
        let mut scores = HashMap::new();
        scores.insert("other".to_string(), 9.0);
        let mut cached = HashSet::new();
        cached.insert("other-0".to_string());
        let plan = plan_audio(&PlanInput {
            manifest: &m,
            current_slug: "big",
            current_chapter: 0,
            budget_bytes: 100, // big (999) alone exceeds budget
            scores: &scores,
            cached: &cached,
        });
        // Current "big" is kept despite exceeding budget; "other" evicted.
        assert_eq!(
            plan.fetch
                .iter()
                .map(|r| super::book_of(&r.path))
                .collect::<Vec<_>>(),
            vec!["big"]
        );
        assert_eq!(plan.evict, vec!["other-0"]);
    }
}
