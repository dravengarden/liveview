# Web OTA optimization — design spec

Status: **design**. OTA *policy* is TypeScript (`web/src/otaUpdater.ts`); overlay
*bytes* are native-fetched path-only from baked origins (`putFromUrl`, no `u=`).
The retired `plugins/lvsync` SqliteBlobStore is not the implementer. See
[design/thin-native-idb-replica.md](design/thin-native-idb-replica.md).
Document origin stays `lvsync://localhost`.

## Background: the two roots

liveview has **two independent content roots**, and they should share the same
content-addressed model:

| Root | Covers | Cheap probe | Manifest | Store | Status |
|---|---|---|---|---|---|
| **Content root** | books / docs / audio / images | `/api/root` (merkle root) | `/api/dag` | TypeScript IDB replica (`web/src/replica/`) | ✅ done — content-addressed, incremental, retained |
| **App root** | the SPA web bundle (JS/CSS/html) | ETag on `/app-dist/manifest.json` | `/app-dist/manifest.json` | native overlay (`putFromUrl` / `activate`, last 3) | ✅ TS policy + native allowlisted fetch |

This spec is **only** the App root. The Content root already does all of this.

## Key realization

Vite already content-hashes every asset filename (`index-BHd-QzaZ.js`,
`chunk-XXXX.js`) — so the web bundle's assets are **already content-addressed**. The
only mutable file is `index.html` (it references the hashed assets). That means:

- **Incremental download is nearly free**: a chunk unchanged across builds keeps the
  same filename → already on disk → skip. Only changed chunks (new hash) download.
- A typical update downloads `index.html` + a few changed chunks (~tens of KB) instead
  of the whole bundle (~500 KB+) every time.

## Current implementer (TS policy + native allowlisted fetch)

- Server: `/app-dist/manifest.json` = `{version = entry-bundle filename, files: [...]}`,
  `/app-dist/<path>` serves each file.
- TypeScript (`otaUpdater.ts`) ETags the manifest (`If-None-Match` = current overlay
  version), diffs the file list, and decides skip vs fetch. Native `putFromUrl?p=`
  fetches `/app-dist/<path>` against baked `LIVEVIEW_REMOTE_ORIGINS` (path-only; no
  `u=`; JS never supplies overlay bytes). Hashed files go to `web/files/`
  skip-if-exists; `index.html&v=` always writes `roots/<ver>/index.html`.
- `activate` refuses incomplete sets, writes the per-version manifest, flips
  `current` last, GCs last 3, then TS `location.replace`s a versioned
  `lvsync://localhost/app/...` URL (`otaReloadUrl`). Debug shells skip apply
  (`web_get` → None).
- Remaining target below (`app-root.json` with explicit shas) is a further
  evolution of the same split — not a return to plugin-owned storage.

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

### 4. Asset store + version retention (native overlay; TS policy)
- TypeScript owns update detection, the skip list, activate, and reload.
  Native fetches allowlisted `/app-dist/<path>` into a dumb file overlay — not
  a Merkle/SQLite content store, and not JS-supplied bytes.
- Vite's content-hashed filenames already make unchanged chunks skippable
  (`appshellHas` / skip-if-exists). Explicit sha maps (`app-root.json`) remain
  a target evolution; they do not move storage ownership back to native.
- Keep the **last 3 app roots** + which is `current`. `activate` refuses
  incomplete sets, flips `current` last, then GCs.
- Serving `/app/<path>`: current overlay, then embedded `frontendDist`.
  `index.html` no-store; hashed assets immutable. Document origin stays
  `lvsync://localhost`.

### 5. Download-complete → banner → apply
- After **all** assets for the new root are present (version fully materialized), signal
  the web layer; it shows a "更新将在 3s 后生效" banner, then applies.
- Apply = set `current` root to the new one + versioned navigation (the webview
  re-fetches `/app/index.html` → the thin `lvsync://localhost` host serves the
  new current overlay). Native AVPlayer playback survives the reload; the SPA
  restores session/scroll from its persisted stores.
- (Alternative kept for safety: apply-on-next-launch as today. The banner+reload is the
  requested in-session path.)

## Components to build

- **Server** (`src/main.rs`): emit `app-root.json` (manifest hash + per-file shas);
  `ETag`/`If-None-Match` 304 handling; keep `/app-dist/<path>` serving.
- **Native host** (`app/src-tauri/src/host.rs`): path-only `putFromUrl` against
  baked `LIVEVIEW_REMOTE_ORIGINS`; last-3 retention; `/app/<path>` overlay;
  debug `web_get` → None. Not `plugins/lvsync`, not SqliteBlobStore.
- **Web** (`web/src/otaUpdater.ts`): ETag / If-None-Match, decide which files
  to fetch, `activate`, versioned `location.replace`. An "update ready" banner
  (3s countdown) remains a UX follow-up; apply is already reload-into-overlay.

## Why this is safe to adopt
- It's the exact model the content root already runs in production (content-addressed +
  root + incremental + retention).
- Vite's content-hashed filenames make the incremental/dedup correct by construction.
- The embedded bundle stays the offline/first-launch fallback (unchanged).
- Retention (3 versions) enables rollback if a pushed bundle is bad.

## Migration note
Policy already lives in TypeScript and overlay fetch already lives in the thin
native host. Further evolution (explicit sha map on the manifest, a 3s banner)
stays in that split: do not move OTA storage ownership back to a plugin or
SQLite blob store. `/app/` continues to serve the current overlay from
`lvsync://localhost`.
