// LvStore — the client-side SQLite index for the offline stores.
//
// Why: the Downloads panel was slow because every open (+ every 2s poll)
// recomputed totals by scanning thousands of files (contentsOfDirectory + a
// per-file size stat) AND marshalling the full ~3388-element key list over the
// JS bridge. This keeps a maintained INDEX instead — one row per cached blob with
// its byte size — so stats are an O(1) indexed aggregate (SELECT count(*), sum)
// and the bridge returns small numbers, never the whole key list.
//
// Scope: this is the resource INDEX (metadata). Blob BYTES stay as files on disk
// keyed by content hash (large audio — DB-as-blob-store would bloat); the row
// carries the size + pinned flag + mtime, which is all the stats/LRU need. One DB
// per native store (audio = lv-index-audio.sqlite next to the lv-audio dir).
//
// Native Swift + system libsqlite3 (no third-party dep), per the "iOS native"
// direction. WAL mode so a write never blocks a concurrent read.

import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

final class LvStore {
  private var db: OpaquePointer?
  private let queue = DispatchQueue(label: "lvstore.sqlite") // serialize all access

  /// Open (or create) the index DB at `path`. Idempotent; safe to call once at init.
  init?(path: String) {
    if sqlite3_open(path, &db) != SQLITE_OK { return nil }
    exec("PRAGMA journal_mode=WAL;")
    exec("PRAGMA synchronous=NORMAL;")
    exec("""
      CREATE TABLE IF NOT EXISTS resource(
        key    TEXT PRIMARY KEY,
        kind   TEXT NOT NULL DEFAULT 'audio',
        bytes  INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        mtime  INTEGER NOT NULL DEFAULT 0
      );
    """)
    exec("CREATE INDEX IF NOT EXISTS resource_lru ON resource(pinned, mtime);")
  }

  deinit { if db != nil { sqlite3_close(db) } }

  private func exec(_ sql: String) {
    queue.sync { sqlite3_exec(db, sql, nil, nil, nil) }
  }

  /// Insert/replace a cached blob's row. Called on every successful download.
  func upsert(key: String, kind: String, bytes: Int64, pinned: Bool, mtime: Int64) {
    queue.sync {
      var st: OpaquePointer?
      let sql = "INSERT INTO resource(key,kind,bytes,pinned,mtime) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, bytes=excluded.bytes, " +
        "pinned=excluded.pinned, mtime=excluded.mtime;"
      guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return }
      defer { sqlite3_finalize(st) }
      sqlite3_bind_text(st, 1, key, -1, SQLITE_TRANSIENT)
      sqlite3_bind_text(st, 2, kind, -1, SQLITE_TRANSIENT)
      sqlite3_bind_int64(st, 3, bytes)
      sqlite3_bind_int(st, 4, pinned ? 1 : 0)
      sqlite3_bind_int64(st, 5, mtime)
      sqlite3_step(st)
    }
  }

  /// Remove a blob's row (on evict / unpin / purge).
  func remove(key: String) {
    queue.sync {
      var st: OpaquePointer?
      guard sqlite3_prepare_v2(db, "DELETE FROM resource WHERE key=?;", -1, &st, nil) == SQLITE_OK
      else { return }
      defer { sqlite3_finalize(st) }
      sqlite3_bind_text(st, 1, key, -1, SQLITE_TRANSIENT)
      sqlite3_step(st)
    }
  }

  /// Update the pinned flag (manual download toggle) without re-stating the file.
  func setPinned(key: String, pinned: Bool) {
    queue.sync {
      var st: OpaquePointer?
      guard sqlite3_prepare_v2(db, "UPDATE resource SET pinned=? WHERE key=?;", -1, &st, nil)
        == SQLITE_OK else { return }
      defer { sqlite3_finalize(st) }
      sqlite3_bind_int(st, 1, pinned ? 1 : 0)
      sqlite3_bind_text(st, 2, key, -1, SQLITE_TRANSIENT)
      sqlite3_step(st)
    }
  }

  /// Touch mtime (LRU recency) on play. Cheap single-row update.
  func touch(key: String, mtime: Int64) {
    queue.sync {
      var st: OpaquePointer?
      guard sqlite3_prepare_v2(db, "UPDATE resource SET mtime=? WHERE key=?;", -1, &st, nil)
        == SQLITE_OK else { return }
      defer { sqlite3_finalize(st) }
      sqlite3_bind_int64(st, 1, mtime)
      sqlite3_bind_text(st, 2, key, -1, SQLITE_TRANSIENT)
      sqlite3_step(st)
    }
  }

  func contains(key: String) -> Bool {
    queue.sync {
      var st: OpaquePointer?
      guard sqlite3_prepare_v2(db, "SELECT 1 FROM resource WHERE key=? LIMIT 1;", -1, &st, nil)
        == SQLITE_OK else { return false }
      defer { sqlite3_finalize(st) }
      sqlite3_bind_text(st, 1, key, -1, SQLITE_TRANSIENT)
      return sqlite3_step(st) == SQLITE_ROW
    }
  }

  /// O(1) aggregate: (count, totalBytes, pinnedBytes). The whole point — the
  /// Downloads panel reads this instead of scanning the directory.
  func stats() -> (count: Int, bytes: Int64, pinnedBytes: Int64) {
    queue.sync {
      var st: OpaquePointer?
      let sql = "SELECT count(*), coalesce(sum(bytes),0), " +
        "coalesce(sum(CASE WHEN pinned=1 THEN bytes ELSE 0 END),0) FROM resource;"
      guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return (0, 0, 0) }
      defer { sqlite3_finalize(st) }
      guard sqlite3_step(st) == SQLITE_ROW else { return (0, 0, 0) }
      return (Int(sqlite3_column_int64(st, 0)),
              sqlite3_column_int64(st, 1),
              sqlite3_column_int64(st, 2))
    }
  }

  /// All cached keys (indexed read — no directory scan + per-file stat).
  func allKeys() -> [String] {
    queue.sync {
      var st: OpaquePointer?
      guard sqlite3_prepare_v2(db, "SELECT key FROM resource;", -1, &st, nil) == SQLITE_OK
      else { return [] }
      defer { sqlite3_finalize(st) }
      var keys: [String] = []
      while sqlite3_step(st) == SQLITE_ROW {
        if let c = sqlite3_column_text(st, 0) { keys.append(String(cString: c)) }
      }
      return keys
    }
  }

  /// LRU candidates (evictable = not pinned), oldest first, until `needed` bytes
  /// are freed. Returns the keys to delete — the caller removes the files + rows.
  func lruEvictionCandidates(toFree needed: Int64) -> [String] {
    queue.sync {
      var st: OpaquePointer?
      guard sqlite3_prepare_v2(
        db, "SELECT key,bytes FROM resource WHERE pinned=0 ORDER BY mtime ASC;", -1, &st, nil
      ) == SQLITE_OK else { return [] }
      defer { sqlite3_finalize(st) }
      var keys: [String] = []
      var freed: Int64 = 0
      while freed < needed, sqlite3_step(st) == SQLITE_ROW {
        if let c = sqlite3_column_text(st, 0) { keys.append(String(cString: c)) }
        freed += sqlite3_column_int64(st, 1)
      }
      return keys
    }
  }

  /// True if the index has never been populated (fresh DB) — triggers a one-time
  /// import of any blobs already on disk so an upgrade doesn't re-download.
  func isEmpty() -> Bool { stats().count == 0 }
}
