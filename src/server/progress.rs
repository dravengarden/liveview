//! Reading-progress store — a tiny SQLite table that remembers how far down
//! each document the reader scrolled. Single-user, no auth: progress is global
//! so it syncs across the reader's devices (read on the laptop, resume on the
//! desktop). The state lives outside the (read-only) docs tree, under the
//! service's state dir (`$STATE_DIRECTORY` / `--state-dir`).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

/// One document's saved scroll position. `path` is the virtual doc path
/// (`<slug>/<chapter>`); `scroll` is a 0..1 ratio of the scrollable height,
/// chosen over a pixel offset so it survives reflow and font/width changes.
#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ProgressEntry {
    pub path: String,
    pub scroll: f64,
    /// Unix epoch milliseconds of the last update — lets the client pick the
    /// most-recently-read chapter when resuming a book.
    pub updated_at: i64,
}

#[derive(Clone)]
pub struct ProgressStore {
    pool: SqlitePool,
}

impl ProgressStore {
    /// Open (creating if absent) the SQLite db at `db_path` and ensure the
    /// schema. The parent directory must already exist.
    pub async fn open(db_path: &Path) -> Result<Self, sqlx::Error> {
        let opts = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS progress (
                 path       TEXT    PRIMARY KEY,
                 scroll     REAL    NOT NULL,
                 updated_at INTEGER NOT NULL
             )",
        )
        .execute(&pool)
        .await?;
        Ok(Self { pool })
    }

    /// Progress rows for one book (`<slug>` itself or any `<slug>/…` descendant),
    /// newest first so the client can resume the last-read chapter.
    pub async fn for_book(&self, slug: &str) -> Result<Vec<ProgressEntry>, sqlx::Error> {
        sqlx::query_as::<_, ProgressEntry>(
            "SELECT path, scroll, updated_at FROM progress
             WHERE path = ?1 OR path LIKE ?2
             ORDER BY updated_at DESC",
        )
        .bind(slug)
        .bind(format!("{slug}/%"))
        .fetch_all(&self.pool)
        .await
    }

    /// Insert or update one document's scroll ratio, stamping the current time.
    pub async fn upsert(&self, path: &str, scroll: f64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO progress (path, scroll, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET
                 scroll = excluded.scroll, updated_at = excluded.updated_at",
        )
        .bind(path)
        .bind(scroll.clamp(0.0, 1.0))
        .bind(now_millis())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
