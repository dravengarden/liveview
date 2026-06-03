-- liveview content store — postgres schema.
--
-- Applied idempotently by `store::migrate` at sync/startup. Holds everything
-- the deployed (filesystem-free) server reads plus the Merkle deploy state the
-- incremental `liveview sync` reconciles against. All statements are
-- CREATE … IF NOT EXISTS so re-running is a no-op.
--
-- Content model mirrors config.rs: a book has renditions (text/audio), each
-- rendition has editions (one per language), and a chapter is the leaf,
-- identified by (book, rendition, lang, rel_path). The wire path the client
-- sends to /api/file is `<slug>/<rel_path>` + ?rendition=&lang=.

-- ── Structure ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books (
    slug              TEXT PRIMARY KEY,
    label             TEXT NOT NULL,
    description       TEXT,
    -- content_hash of the cover blob in `assets`, or NULL (gradient fallback).
    cover_hash        TEXT,
    default_rendition TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS renditions (
    book_slug    TEXT    NOT NULL REFERENCES books(slug) ON DELETE CASCADE,
    kind         TEXT    NOT NULL,   -- 'text' | 'audio'
    label        TEXT    NOT NULL,
    default_lang TEXT    NOT NULL,
    voice        TEXT,               -- audio only
    manifest     BOOLEAN NOT NULL,   -- true ⇒ book.toml-driven (titled spine)
    ord          INTEGER NOT NULL,   -- display order (text before audio)
    PRIMARY KEY (book_slug, kind)
);

CREATE TABLE IF NOT EXISTS editions (
    book_slug TEXT    NOT NULL,
    rendition TEXT    NOT NULL,
    lang      TEXT    NOT NULL,
    label     TEXT    NOT NULL,
    ord       INTEGER NOT NULL,      -- language-switcher order (default first)
    PRIMARY KEY (book_slug, rendition, lang),
    FOREIGN KEY (book_slug, rendition)
        REFERENCES renditions(book_slug, kind) ON DELETE CASCADE
);

-- ── Content leaves ───────────────────────────────────────────────────────────

-- One row per logical file in an edition. Text-ish files carry pre-rendered
-- `html` (+ raw `markdown` so a renderer bump can re-render); binary files
-- carry `asset_hash` pointing at `assets` (the bytes live in rustfs).
CREATE TABLE IF NOT EXISTS chapters (
    book_slug      TEXT    NOT NULL,
    rendition      TEXT    NOT NULL,
    lang           TEXT    NOT NULL,
    rel_path       TEXT    NOT NULL,   -- path under the edition source
    file_type      TEXT    NOT NULL,   -- 'markdown'|'image'|'pdf'|'html'|'data'|…
    html           TEXT,               -- rendered (text-ish only)
    markdown       TEXT,               -- raw source (text-ish only)
    asset_hash     TEXT,               -- → assets.content_hash (binary only)
    -- audio rendition (.spoken.md chapters): edge-tts output, pre-generated at
    -- sync time and stored as content-addressed assets in rustfs.
    audio_hash     TEXT,               -- → assets.content_hash (mp3)
    marks_hash     TEXT,               -- → assets.content_hash (sentence marks json)
    content_hash   TEXT    NOT NULL,   -- blake3 of source bytes (Merkle leaf)
    render_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (book_slug, rendition, lang, rel_path)
);

-- Content-addressed binary blobs stored in the private rustfs bucket. Shared
-- across editions/books by hash (a Merkle-DAG leaf with multiple parents).
CREATE TABLE IF NOT EXISTS assets (
    content_hash TEXT   PRIMARY KEY,   -- blake3, also the rustfs object key
    mime         TEXT   NOT NULL,
    size         BIGINT NOT NULL
);

-- ── Merkle deploy state ──────────────────────────────────────────────────────

-- The content-addressed Merkle DAG of the last successful sync. Leaves key off
-- content_hash; tree nodes hash their sorted children. `liveview sync` compares
-- the freshly-built root against `deploy_root` and only descends into changed
-- subtrees. payload is the node body (leaf descriptor or child list).
CREATE TABLE IF NOT EXISTS merkle_nodes (
    node_hash TEXT PRIMARY KEY,
    kind      TEXT NOT NULL,           -- 'leaf' | 'tree'
    payload   TEXT NOT NULL            -- serialized node body (JSON string)
);

CREATE TABLE IF NOT EXISTS deploy_root (
    id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    root_hash  TEXT,
    updated_at BIGINT NOT NULL DEFAULT 0
);

-- Pre-built sidebar forest per rendition (`text` / `audio`), as the JSON the
-- server returns verbatim from /api/tree. `liveview sync` computes it once (it
-- has the filesystem context + H1 titles + layout ordering); the thin server
-- never re-derives a spine.
CREATE TABLE IF NOT EXISTS site_tree (
    rendition TEXT PRIMARY KEY,         -- 'text' | 'audio'
    json      TEXT NOT NULL
);

-- ── Reader state (ported from the old SQLite store) ──────────────────────────

-- Scroll position per virtual doc path (`<slug>/<chapter>`); `scroll` is a
-- 0..1 ratio so it survives reflow. Single-user, global (syncs across devices).
CREATE TABLE IF NOT EXISTS progress (
    path       TEXT PRIMARY KEY,
    scroll     DOUBLE PRECISION NOT NULL,
    updated_at BIGINT NOT NULL
);

-- Player settings (rate, sleep-timer, …) as string key/value; client parses.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);
