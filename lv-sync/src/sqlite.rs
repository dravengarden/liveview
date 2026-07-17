//! SQLite-backed [`BlobStore`](crate::BlobStore) — the cross-platform (iOS · macOS
//! · future Android) replacement for the per-file [`FsBlobStore`](crate::native).
//!
//! WHY SQLite, not a file-per-hash dir: the offline panel needs O(1) totals
//! (cached count + bytes) and LRU eviction over a budget — a `SELECT count(*),
//! sum(bytes)` and an `ORDER BY mtime LIMIT` instead of a full `readdir` + per-
//! file `stat` of ~12k blobs (the Swift LvStore added exactly this index on top of
//! the file store; here the index AND the bytes live in one table, one source of
//! truth). It's also one portable C library (bundled, compiled per target) so the
//! same Rust runs on every native platform — no Swift `libsqlite3` shim.
//!
//! The table is the content-addressed store itself: `hash` (the manifest key, may
//! carry a `:units`/`:spoken` suffix) is the PRIMARY KEY, `data` the bytes. Extra
//! columns (`bytes`, `pinned`, `mtime`) drive stats + retention; they are NOT part
//! of the [`BlobStore`] trait (content addressing only needs get/put/has/keys/
//! remove) — the plugin reaches them via the inherent methods below.
//!
//! Concurrency: rusqlite's `Connection` is `Send` but `!Sync`, so it lives behind
//! a `Mutex`. SQLite calls are fast and synchronous; the async trait methods take
//! the lock, run the statement, and drop the guard WITHOUT awaiting — so the boxed
//! futures stay `Send`. WAL mode lets reads not block the single writer.

use std::path::Path;
use std::sync::Mutex;

use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension};

use crate::BlobStore;

/// Wall-clock seconds, monotonic enough for LRU ordering. The platform passes
/// `now` into `touch`/`put` where it matters; this is the default stamp.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Aggregate store stats — O(1) via a single indexed query (no per-blob stat).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StoreStats {
    pub count: i64,
    pub bytes: i64,
}

/// A content-addressed blob store in one SQLite table.
pub struct SqliteBlobStore {
    conn: Mutex<Connection>,
}

impl SqliteBlobStore {
    /// Open (creating + migrating) the database at `path`. WAL for concurrent
    /// reads; the schema is created once and is forward-only.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// In-memory store (tests).
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn init(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS blobs (
               hash   TEXT PRIMARY KEY,
               data   BLOB NOT NULL,
               bytes  INTEGER NOT NULL,
               pinned INTEGER NOT NULL DEFAULT 0,
               mtime  INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS blobs_lru ON blobs(pinned, mtime);
             -- APM outbox: append-only client operation/perf events, buffered here
             -- while offline and batch-flushed to the server when the network is
             -- good (see plugins/lvsync /apm routes + web/src/apm.ts). This store is
             -- schema-DUMB: `body` is the whole event JSON authored by the web; only
             -- `event_id` (dedup/ack key) and `ts` (client epoch-ms, for prune order)
             -- are lifted out. Rows are deleted on the server's ack, so this table is
             -- normally near-empty; the row cap is a safety valve for a device that
             -- stays offline forever.
             -- Ordering + FIFO drain are by the implicit `rowid` (insertion order),
             -- which is already SQLite's clustered key — no extra index needed.
             CREATE TABLE IF NOT EXISTS apm_events (
               event_id TEXT PRIMARY KEY,
               ts       INTEGER NOT NULL,
               body     TEXT NOT NULL
             );",
        )
        .map_err(|e| e.to_string())
    }

    // ── APM outbox (append-only client events; flushed + pruned by the plugin) ──

    /// Buffer one client event. `INSERT OR IGNORE` on the `event_id` PK makes this
    /// idempotent — a web-side retry (or a double `logEvent`) never duplicates a row.
    pub fn apm_log(&self, event_id: &str, ts: i64, body: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "INSERT OR IGNORE INTO apm_events(event_id, ts, body) VALUES(?1, ?2, ?3)",
            rusqlite::params![event_id, ts, body],
        );
    }

    /// Oldest-first batch of pending event bodies (raw JSON strings), up to `limit`.
    /// FIFO by insertion (`rowid`) so the server sees events in the order they
    /// happened; the caller POSTs them, then `apm_ack`s the same ids on success.
    pub fn apm_drain(&self, limit: i64) -> Vec<String> {
        let c = self.conn.lock().unwrap();
        let Ok(mut stmt) = c.prepare("SELECT body FROM apm_events ORDER BY rowid ASC LIMIT ?1")
        else {
            return Vec::new();
        };
        stmt.query_map([limit], |r| r.get::<_, String>(0))
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Delete the acked events by id (the server confirmed receipt). Chunked IN-list
    /// to stay under SQLite's bound-parameter limit for a large flush.
    pub fn apm_ack(&self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        let c = self.conn.lock().unwrap();
        for chunk in ids.chunks(400) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("DELETE FROM apm_events WHERE event_id IN ({placeholders})");
            let params = rusqlite::params_from_iter(chunk.iter());
            let _ = c.execute(&sql, params);
        }
    }

    /// Safety valve: cap the buffer at `max_rows`, dropping the OLDEST rows first.
    /// Only bites when a device never gets a good-enough network to flush — normal
    /// operation keeps the table near-empty via `apm_ack`.
    pub fn apm_prune(&self, max_rows: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "DELETE FROM apm_events WHERE rowid IN (
               SELECT rowid FROM apm_events ORDER BY rowid DESC LIMIT -1 OFFSET ?1
             )",
            [max_rows],
        );
    }

    // ── Inherent methods (beyond BlobStore) for stats + retention ──────────────

    /// O(1) totals over the whole store.
    pub fn stats(&self) -> StoreStats {
        let c = self.conn.lock().unwrap();
        c.query_row(
            "SELECT count(*), coalesce(sum(bytes),0) FROM blobs",
            [],
            |r| {
                Ok(StoreStats {
                    count: r.get(0)?,
                    bytes: r.get(1)?,
                })
            },
        )
        .unwrap_or_default()
    }

    /// Mark/unmark a blob as pinned (eviction-exempt — a per-book download).
    pub fn set_pinned(&self, hash: &str, pinned: bool) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "UPDATE blobs SET pinned=?2 WHERE hash=?1",
            rusqlite::params![hash, pinned as i64],
        );
    }

    /// Touch a blob's LRU stamp (called on a cache-hit read).
    pub fn touch(&self, hash: &str, now: i64) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "UPDATE blobs SET mtime=?2 WHERE hash=?1",
            rusqlite::params![hash, now],
        );
    }

    /// Evict least-recently-used UNPINNED blobs until total bytes ≤ `cap`. Returns
    /// the bytes freed. One indexed pass — `ORDER BY mtime` over the LRU index.
    pub fn evict_to_cap(&self, cap: i64) -> i64 {
        let c = self.conn.lock().unwrap();
        let total: i64 = c
            .query_row("SELECT coalesce(sum(bytes),0) FROM blobs", [], |r| r.get(0))
            .unwrap_or(0);
        if total <= cap {
            return 0;
        }
        let mut over = total - cap;
        let mut freed = 0i64;
        // Oldest unpinned first. Collect victims, then delete (can't delete while
        // the statement borrows the connection).
        let victims: Vec<(String, i64)> = {
            let mut stmt = match c
                .prepare("SELECT hash, bytes FROM blobs WHERE pinned=0 ORDER BY mtime ASC")
            {
                Ok(s) => s,
                Err(_) => return 0,
            };
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map(|it| it.filter_map(Result::ok).collect::<Vec<_>>())
                .unwrap_or_default();
            let mut take = Vec::new();
            for (h, b) in rows {
                if over <= 0 {
                    break;
                }
                over -= b;
                freed += b;
                take.push((h, b));
            }
            take
        };
        for (h, _) in &victims {
            let _ = c.execute("DELETE FROM blobs WHERE hash=?1", [h]);
        }
        freed
    }
}

#[async_trait]
impl BlobStore for SqliteBlobStore {
    async fn get(&self, hash: &str) -> Option<Vec<u8>> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT data FROM blobs WHERE hash=?1", [hash], |r| {
            r.get::<_, Vec<u8>>(0)
        })
        .optional()
        .ok()
        .flatten()
    }

    async fn put(&self, hash: &str, data: &[u8]) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "INSERT INTO blobs(hash, data, bytes, mtime) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(hash) DO UPDATE SET data=?2, bytes=?3, mtime=?4",
            rusqlite::params![hash, data, data.len() as i64, now_secs()],
        );
    }

    async fn has(&self, hash: &str) -> bool {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT 1 FROM blobs WHERE hash=?1", [hash], |_| Ok(()))
            .optional()
            .map(|o| o.is_some())
            .unwrap_or(false)
    }

    async fn keys(&self) -> Vec<String> {
        let c = self.conn.lock().unwrap();
        let Ok(mut stmt) = c.prepare("SELECT hash FROM blobs") else {
            return Vec::new();
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|it| it.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    async fn remove(&self, hash: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute("DELETE FROM blobs WHERE hash=?1", [hash]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pollster::block_on;

    #[test]
    fn roundtrip_keys_stats() {
        let s = SqliteBlobStore::open_in_memory().unwrap();
        block_on(async {
            assert!(!s.has("abc").await);
            assert_eq!(s.get("abc").await, None);
            s.put("abc", b"hello").await;
            assert!(s.has("abc").await);
            assert_eq!(s.get("abc").await.unwrap(), b"hello");
            // colon-suffixed key (units/spoken) is just a string PK here.
            s.put("deadbeef:units", b"{}").await;
            let mut keys = s.keys().await;
            keys.sort();
            assert_eq!(keys, vec!["abc".to_string(), "deadbeef:units".to_string()]);
            let st = s.stats();
            assert_eq!(st.count, 2);
            assert_eq!(st.bytes, 7); // 5 + 2
            s.remove("abc").await;
            assert!(!s.has("abc").await);
            assert_eq!(s.stats().count, 1);
        });
    }

    #[test]
    fn lru_eviction_respects_pin() {
        let s = SqliteBlobStore::open_in_memory().unwrap();
        block_on(async {
            s.put("old", &[0u8; 100]).await;
            s.touch("old", 1);
            s.put("mid", &[0u8; 100]).await;
            s.touch("mid", 2);
            s.put("pinnedbig", &[0u8; 100]).await;
            s.touch("pinnedbig", 0); // oldest, but pinned → never evicted
            s.set_pinned("pinnedbig", true);
            // cap 50, total 300 → must shed ≥250; only 200 is UNPINNED (old+mid),
            // so both go (oldest-first) and the store stays ABOVE cap because the
            // 100-byte pinned blob is exempt — pinned wins even when it's the oldest.
            let freed = s.evict_to_cap(50);
            assert_eq!(freed, 200);
            assert!(!s.has("old").await);
            assert!(!s.has("mid").await);
            assert!(s.has("pinnedbig").await); // pinned survives even though oldest + over cap
        });
    }

    #[test]
    fn apm_log_drain_ack_is_fifo_and_idempotent() {
        let s = SqliteBlobStore::open_in_memory().unwrap();
        s.apm_log("e1", 100, "{\"event_id\":\"e1\"}");
        s.apm_log("e2", 200, "{\"event_id\":\"e2\"}");
        // Duplicate id (a web retry) must NOT create a second row.
        s.apm_log("e1", 999, "{\"event_id\":\"e1\",\"dup\":true}");
        let batch = s.apm_drain(10);
        assert_eq!(
            batch,
            vec!["{\"event_id\":\"e1\"}", "{\"event_id\":\"e2\"}"]
        ); // FIFO, deduped
        // Limit is honored (oldest first).
        assert_eq!(s.apm_drain(1), vec!["{\"event_id\":\"e1\"}"]);
        // Ack drops only the acked ids; the rest stay for the next flush.
        s.apm_ack(&["e1".to_string()]);
        assert_eq!(s.apm_drain(10), vec!["{\"event_id\":\"e2\"}"]);
    }

    #[test]
    fn apm_prune_caps_oldest_first() {
        let s = SqliteBlobStore::open_in_memory().unwrap();
        for i in 0..10 {
            s.apm_log(&format!("e{i}"), i, &format!("{{\"n\":{i}}}"));
        }
        s.apm_prune(3); // keep the 3 NEWEST
        let kept = s.apm_drain(100);
        assert_eq!(kept, vec!["{\"n\":7}", "{\"n\":8}", "{\"n\":9}"]);
    }
}
