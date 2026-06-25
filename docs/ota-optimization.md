# Web OTA optimization — design spec

Status: **design / not yet implemented**. The current web OTA (full-bundle download
on version change) works and is deployed; this spec evolves it into a
content-addressed, incremental, version-retained model that mirrors the corpus
content layer.

## Background: the two roots

liveview has **two independent content roots**, and they should share the same
content-addressed model:

| Root | Covers | Cheap probe | Manifest | Store | Status |
|---|---|---|---|---|---|
| **Content root** | books / docs / audio / images | `/api/root` (merkle root) | `/api/dag` | lvsync SqliteBlobStore (blake3) | ✅ done — content-addressed, incremental, retained |
| **App root** | the SPA web bundle (JS/CSS/html) | _(this spec)_ | `/app-dist/manifest.json` | `web-ota/` files (path-keyed) | ⚠️ full-download, single version — optimize here |

This spec is **only** the App root. The Content root already does all of this.

## Key realization

Vite already content-hashes every asset filename (`index-BHd-QzaZ.js`,
`chunk-XXXX.js`) — so the web bundle's assets are **already content-addressed**. The
only mutable file is `index.html` (it references the hashed assets). That means:

- **Incremental download is nearly free**: a chunk unchanged across builds keeps the
  same filename → already on disk → skip. Only changed chunks (new hash) download.
- A typical update downloads `index.html` + a few changed chunks (~tens of KB) instead
  of the whole bundle (~500 KB+) every time.

## Current (to replace)

- Server: `/app-dist/manifest.json` = `{version = entry-bundle filename, files: [...]}`,
  `/app-dist/<path>` serves each file.
- Plugin `web_ota_update()` (background, on launch): if `version != applied`, download
  **all** non-font files into `web-ota.staged`, atomically promote, apply-on-next-launch
  (`LvState::new` swaps `web-ota.staged → web-ota`).
- Single version on disk; no ETag probe (downloads the full manifest each check); no
  content-addressed sharing/retention.

## Target design

### 1. Root manifest (content-addressed, versioned)
Server emits `app-root.json`:
```json
{
  "version": "<hash of this manifest>",
  "files": { "index.html": "<sha>", "assets/index-X.js": "<sha>", ... }
}
```
- `version` = content hash of the manifest (the user's "root carries its own hash as
  the version"). Asset shas are the Vite filename hashes; `index.html` gets an explicit
  sha.

### 2. Cheap update check via HTTP conditional GET
- Server serves `app-root.json` with `ETag: <version>`.
- Client (timer, e.g. every few min, + on launch): `GET app-root.json`
  `If-None-Match: <current version>`.
  - `304 Not Modified` → no update (a few bytes).
  - `200` + new root → update available (carries the new version) — exactly the user's
    "client sends current version/hash, server says updated? if so new version".

### 3. Incremental download
- Parse the new root. For each `(path, sha)`, download `/app-dist/<path>` **only if the
  sha is not already in the asset store**. Content-addressed → unchanged chunks skipped.
- Skip fonts as today only if they're not in the root's diff (they usually are unchanged
  → skipped naturally; the explicit font-skip can be dropped once dedup is sha-based).

### 4. Asset store + version retention (reuse the lvsync blob store)
- Store web assets **by content hash** in the existing `SqliteBlobStore` (the same store
  the content layer uses) — assets shared across versions are stored once.
- Keep a small table of the **last 3 app roots** + which is `current`.
- GC: an asset is retained iff **any** of the 3 kept roots references it; otherwise evict.
  Gives rollback to any of 3 versions + bounded storage.
- Serving `/app/<path>`: look up `path` in the **current** root → sha → blob → bytes
  (replaces today's `web-ota/<path>` file read). `index.html` no-store; assets immutable.

### 5. Download-complete → banner → apply
- After **all** assets for the new root are present (version fully materialized), signal
  the web layer; it shows a "更新将在 3s 后生效" banner, then applies.
- Apply = set `current` root to the new one + `location.reload()` (the webview re-fetches
  `/app/index.html` → the plugin serves the new current root). Native AVPlayer playback
  survives the reload; the SPA restores session/scroll from its persisted stores.
- (Alternative kept for safety: apply-on-next-launch as today. The banner+reload is the
  requested in-session path.)

## Components to build

- **Server** (`src/main.rs`): emit `app-root.json` (manifest hash + per-file shas);
  `ETag`/`If-None-Match` 304 handling; keep `/app-dist/<path>` serving.
- **Plugin** (`plugins/lvsync`): app-root table (last 3 + current) in SQLite; conditional
  fetch (send current version, handle 304/200); incremental download into the blob store
  by sha; retention GC; `/app/<path>` resolves via current root → sha → blob; a periodic
  check timer; a signal to the web when an update is staged.
- **Web**: an "update ready" banner (3s countdown → reload); subscribe to the plugin's
  staged-update signal.

## Why this is safe to adopt
- It's the exact model the content root already runs in production (content-addressed +
  root + incremental + retention).
- Vite's content-hashed filenames make the incremental/dedup correct by construction.
- The embedded bundle stays the offline/first-launch fallback (unchanged).
- Retention (3 versions) enables rollback if a pushed bundle is bad.

## Migration note
The current `web_ota_update()` (full download to `web-ota/`) + `/app-dist/manifest.json`
({version, files[]}) can be evolved in place: add the sha map + ETag to the manifest,
switch the plugin to sha-keyed blob storage + incremental, then the retention + banner.
The `/app/` serving handler changes from a file read to a root→sha→blob lookup.
