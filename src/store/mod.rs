//! Postgres content store for the deployed (filesystem-free) server and the
//! incremental `liveview sync`. Runtime-checked sqlx queries only — the Nix
//! build never needs a live `DATABASE_URL`.

pub mod blobs;
pub mod content;
pub mod fs;
pub mod model;
pub mod objstore;
pub mod pg;
pub mod preparation;
pub mod range;
pub mod speech;

/// The PostgreSQL URL for database-backed tests. Without `DATABASE_URL` the
/// tests skip (so `cargo test` stays hermetic) and say so; under
/// `LIVEVIEW_REQUIRE_DB=1` (`just test-db`) a missing URL fails instead of
/// passing silently.
#[cfg(test)]
pub fn test_database_url(test: &str) -> Option<String> {
    match std::env::var("DATABASE_URL") {
        Ok(url) => Some(url),
        Err(_) if std::env::var("LIVEVIEW_REQUIRE_DB").as_deref() == Ok("1") => {
            panic!("{test}: DATABASE_URL is required under LIVEVIEW_REQUIRE_DB=1")
        }
        Err(_) => {
            eprintln!("skipped {test}: DATABASE_URL is unset");
            None
        }
    }
}
