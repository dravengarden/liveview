//! Single byte-range requests over content-addressed blobs.
//!
//! The HTTP `Range` header is parsed before the blob's size is known so a
//! backend that supports native range reads (S3 `GetObject` with `Range`) can
//! fetch only the requested bytes instead of the whole object.

/// One `Range: bytes=…` request, independent of the object size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeSpec {
    /// `start-` or `start-end` (inclusive end, possibly past the object end).
    From { start: u64, end: Option<u64> },
    /// `-n`: the final `n` bytes.
    Suffix(u64),
}

impl RangeSpec {
    /// Parse a single-range `bytes=` header value. Multi-range, other units,
    /// and malformed values yield `None`, and the caller serves the full body.
    pub fn parse(value: &str) -> Option<Self> {
        let (start, end) = value.trim().strip_prefix("bytes=")?.split_once('-')?;
        let (start, end) = (start.trim(), end.trim());
        if start.is_empty() {
            return end.parse().ok().map(Self::Suffix);
        }
        let start = start.parse().ok()?;
        if end.is_empty() {
            return Some(Self::From { start, end: None });
        }
        let end = end.parse().ok()?;
        (start <= end).then_some(Self::From {
            start,
            end: Some(end),
        })
    }

    /// The inclusive `(start, end)` this range selects within `total` bytes,
    /// clamping an end past the object to its last byte (RFC 9110 §14.1.2).
    /// `None` when unsatisfiable.
    pub fn resolve(self, total: u64) -> Option<(u64, u64)> {
        let last = total.checked_sub(1)?;
        match self {
            Self::From { start, end } => {
                (start <= last).then(|| (start, end.map_or(last, |end| end.min(last))))
            }
            Self::Suffix(0) => None,
            Self::Suffix(n) => Some((total.saturating_sub(n), last)),
        }
    }

    /// The header value that requests this range from an upstream store.
    pub fn header_value(self) -> String {
        match self {
            Self::From { start, end: None } => format!("bytes={start}-"),
            Self::From {
                start,
                end: Some(end),
            } => format!("bytes={start}-{end}"),
            Self::Suffix(n) => format!("bytes=-{n}"),
        }
    }
}

/// The result of a ranged blob read.
#[derive(Debug, PartialEq, Eq)]
pub enum RangedBlob {
    /// Bytes `start..=end` of an object that is `total` bytes long.
    Partial {
        bytes: Vec<u8>,
        start: u64,
        end: u64,
        total: u64,
    },
    /// The range was unsatisfiable; the whole object is returned instead.
    Full(Vec<u8>),
}

impl RangedBlob {
    /// Slice an already-loaded object: the fallback for backends without
    /// native range reads.
    pub fn from_full(mut bytes: Vec<u8>, range: RangeSpec) -> Self {
        let total = bytes.len() as u64;
        match range.resolve(total) {
            Some((start, end)) => {
                bytes.truncate(end as usize + 1);
                bytes.drain(..start as usize);
                Self::Partial {
                    bytes,
                    start,
                    end,
                    total,
                }
            }
            None => Self::Full(bytes),
        }
    }
}

/// Parse an upstream `Content-Range: bytes start-end/total` value.
pub fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (span, total) = value.trim().strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(
            RangeSpec::parse("bytes=0-1"),
            Some(RangeSpec::From {
                start: 0,
                end: Some(1)
            })
        );
        assert_eq!(
            RangeSpec::parse("bytes=10-"),
            Some(RangeSpec::From {
                start: 10,
                end: None
            })
        );
        assert_eq!(RangeSpec::parse("bytes=-5"), Some(RangeSpec::Suffix(5)));
        for invalid in [
            "bytes=5-1",
            "bytes=0-1,4-5",
            "items=0-1",
            "bytes=a-b",
            "0-1",
        ] {
            assert_eq!(RangeSpec::parse(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn resolves_and_clamps_against_the_object_size() {
        let from = |start, end| RangeSpec::From { start, end };
        assert_eq!(from(10, Some(19)).resolve(100), Some((10, 19)));
        assert_eq!(from(90, Some(999)).resolve(100), Some((90, 99)));
        assert_eq!(from(0, None).resolve(100), Some((0, 99)));
        assert_eq!(from(100, None).resolve(100), None);
        assert_eq!(RangeSpec::Suffix(5).resolve(100), Some((95, 99)));
        assert_eq!(RangeSpec::Suffix(500).resolve(100), Some((0, 99)));
        assert_eq!(RangeSpec::Suffix(0).resolve(100), None);
        assert_eq!(from(0, Some(0)).resolve(0), None);
    }

    #[test]
    fn header_value_round_trips() {
        for value in ["bytes=0-1", "bytes=10-", "bytes=-5"] {
            assert_eq!(RangeSpec::parse(value).unwrap().header_value(), value);
        }
    }

    #[test]
    fn slices_a_loaded_object() {
        let bytes: Vec<u8> = (0..10).collect();
        assert_eq!(
            RangedBlob::from_full(bytes.clone(), RangeSpec::parse("bytes=2-4").unwrap()),
            RangedBlob::Partial {
                bytes: vec![2, 3, 4],
                start: 2,
                end: 4,
                total: 10
            }
        );
        assert_eq!(
            RangedBlob::from_full(bytes.clone(), RangeSpec::parse("bytes=20-").unwrap()),
            RangedBlob::Full(bytes)
        );
    }

    #[test]
    fn parses_upstream_content_range() {
        assert_eq!(
            parse_content_range("bytes 10-19/4096"),
            Some((10, 19, 4096))
        );
        assert_eq!(parse_content_range("bytes */4096"), None);
    }
}
