# Offline-first reader architecture (design)

Status: design (task #1). The **#1 hard requirement**: after going offline the app
behaves *almost identically to online* — entering a page, play, pause, seek,
navigate, resume all work with **zero network**. Network is for *acquiring new
content*, never for *using already-acquired content*.

This document is the blueprint for the refactor; the phased plan lives in
[offline-first-plan.md](offline-first-plan.md).

---

## 1. The core idea

The server already has a content-addressed **Merkle DAG** of the corpus
(`src/sync/merkle.rs`, persisted in pg `merkle_nodes` + `deploy_root`). Today the
*browser* doesn't use it — it fetches per-path, network-first. The refactor makes
the client read from a **local content-addressed replica** of that DAG, so every
read is local-first.

Two addressing primitives, shared by both modes:

- **DAG / manifest**: `path → {hash, kind, bytes, status}` for every leaf, plus
  the root. This is the *map*.
- **Blob**: `hash → bytes`, immutable (content-addressed, survives deploys). This
  is the *content*.

Everything the reader needs (rendered text/html, units, spoken, marks, audio,
assets, covers) is a blob addressed by a hash the manifest hands out. "Open a
page" = resolve path→hash via the local manifest, read the blob from the local
store. No hash missing locally ⇒ no network needed.

---

## 2. Two modes: `lazy` (web/PWA) and `eager` (native app)

Detected once at startup: native shell present ⇒ `eager`, else `lazy`. A single
`dataMode` flag drives behaviour; **the UI is one set of loading-aware components**
— the mode only changes how often `loading` is ever true.

### lazy — web / PWA
- On-demand, like a normal web page. Resolve path→hash; if the blob is cached
  serve it instantly, else fetch it (`loading=true`) and cache it.
- **Loading is first-class** and must be polished on every path (skeletons /
  placeholders). Offline ⇒ whatever you've already opened + the active book's
  prefetch is available; the rest shows a graceful "not downloaded" state.
- Storage = the Service Worker Cache API (already in `web/public/sw.js`), made
  fully cache-first-by-hash on a persistent (non-version-wiped) cache.
- Audio is budget-bound (quota + iOS eviction): current book + listened + LRU.

### eager — native (iOS + Mac, Tauri)
- Pre-loads the **whole corpus** by mirroring the DAG (see §4). Reads are
  local/instant ⇒ **`loading` is almost never shown**. The few genuine cases:
  1. first **cold sync** after install (one-time corpus download w/ progress),
  2. a leaf newer than the local replica (just deployed, not yet pulled — brief),
  3. audio still **generating server-side** (queued/running — the existing badge,
     a server wait, not a network load).
- Storage = a **native content-addressed store** (not the SW), see §5.
- "Almost no loading" — but where genuinely unavoidable (the three cases) we
  still render a loading state.

### The unified read path (one code, two behaviours)
```
useResource(pathOrHash) -> { data, loading, missing }
   resolver:
     lazy:  cache.match(hash) ?? fetch(blob)         // loading until fetch
     eager: nativeStore.get(hash)                     // sync hit; loading only on miss
```
Components bind to `{ loading, missing }` and never branch on the mode. The
resolver and the mode decide how often each is true.

---

## 3. API redesign (collapse to DAG + blob + push)

The reader's data API collapses to three faces; both modes share the **blob**
substrate. Legacy path endpoints stay during migration, then retire.

| Face | Endpoint | Returns |
|---|---|---|
| Map | `GET /api/dag` | `{ root, leaves: [{ path, kind, hash, bytes, audioStatus }] }` — the whole manifest in one shot (flat leaf list is enough for a replica; the tree is a diff optimization) |
| Content | `GET /api/blob/{hash}` | bytes, `Cache-Control: immutable`. **Extended** from audio/asset-only to cover text/html, units, spoken, marks too |
| Push | `WS RootChanged { root }` | fires on any DAG change (deploy AND audio completion); the existing `chapter-ready` becomes a special case |

Derivation: `/api/file`, `/api/units`, `/api/spoken`, `/api/marks`, `/api/audio`
all become "resolve path→hash in the local DAG, GET `/api/blob/{hash}`". The
path endpoints are kept as thin shims until the client fully moves to blobs.

Current gaps this closes (server side, `src/main.rs`, `src/store/`):
- Text/html/units/spoken are pg-stored and **not** content-addressed in
  responses → give them stable hashes and serve them as blobs (store by hash in
  rustfs alongside audio/marks, or a pg hash→bytes table).
- `/api/blob/{hash}` only resolves rustfs blobs today → extend to all leaf types.
- No `RootChanged` WS message → add it (the reload NOTIFY already exists).

---

## 4. "Two DAG states" → unify into one **live root**

Today there are effectively two states:
1. **Content / deploy DAG** — source-based blake3, root fixed at `liveview sync`
   (`deploy_root`). Says *what content exists*.
2. **Audio-generation state** — `audio_hash`/`marks_hash` filled asynchronously by
   the worker, tracked via `/api/tasks` + `chapter-ready` WS, **not in the root**.
   Says *what is playable*.

**Decision: unify into one live root.** Fold the generated-artifact hashes
(audio/marks) into the corresponding chapter leaf's identity; when the worker
finishes a chapter it updates that leaf → bubbles to the root → `RootChanged`
fires. The eager client then follows **exactly one signal** (the root) for both
content updates and audio backfill; `chapter-ready` becomes a special case of
`RootChanged`.

- Trade-off: the root churns during TTS generation (one bump per chapter). That
  is *desired* — it is precisely "audio backfilled, client pulls it". Diffs are
  cheap (one changed leaf). The worker becomes a bounded DAG writer (re-hash one
  leaf + path-to-root, one pg txn).
- `deploy_root` may stay as the "content deployed" marker; clients see the live
  root only.
- Fallback (if we want the worker to never touch the DAG): keep two — content
  root + a separate audio-readiness channel. Rejected as the default: it makes
  the eager client follow two signals for no real gain.

---

## 5. Native eager storage (not the Service Worker)

A native content-addressed blob store in the Tauri Rust side, replacing the SW
for the native app:

- `blob(hash) -> bytes`, `has(hash) -> bool`, content-addressed on disk.
- **Compression**: zstd (libzstd ships SIMD; the `zstd` crate links it).
  - text-class (md/html/json/marks/units/spoken) → compress (typically 3–5×).
  - **mp3 → store raw** (already compressed; zstd ≈ 1×). So compression helps
    text a lot, audio not at all — and audio dominates the on-disk size. That is
    fine: native disk is large; the win of compression is text density + fewer
    bytes to sync, not shrinking audio.
- The web layer talks to it via a bridge (`getBlob`/`hasBlob`); **audio streams
  straight into the native AVPlayer by hash** (the gated native engine,
  `native-audio.ts`, already does load-by-hash). SW stays only for web/PWA.

---

## 6. Unified status component (one ambient strip)

Reconnect/offline + update + sync-generation all become states of the **existing
`SyncIndicator`** (one flat-chrome strip + one DetentSheet), switched by a state
machine on the highest-priority active state:

| Prio | State | Colour | Label / action |
|---|---|---|---|
| 1 | update available / hard error | error→**red**; update→**blue** | "new version, tap to reload" (blue) / error detail (red) |
| 2 | offline · reconnecting | **yellow (warning)** | "offline, reconnecting…" |
| 3 | generating this book's audio | neutral (primary filament) | existing scoped "x/y" |
| — | offline prefetch | silent | no strip |

- **Update = blue**, offline/reconnect = yellow, error = red.
- Reconnect hooks the existing `connectionStore` (already exp-backoff) + the
  `online`/`offline` events + WS close. **Conservative**: show the warning only
  after ~4 failed reconnects; **exponential backoff capped at 60s**, retries
  **unbounded** (so offline only ever needs a warning, never red).
- Reuses the strip's rem sizing, top/bottom placement, `--lv-syncbar-h`, and the
  scoped-to-current-book logic already in place.

---

## 7. What "offline ≈ online" guarantees (the hard requirement)

| Operation | lazy (web/PWA) | eager (native) |
|---|---|---|
| Enter a page (text/units/spoken/marks) | ✅ if visited/prefetched | ✅ always (full replica) |
| Play audio | ✅ if listened/within budget | ✅ always (full replica) |
| Pause / seek / scrub | ✅ always (local) | ✅ always |
| Navigate chapters / shelf | ✅ for cached content | ✅ always |
| Progress / resume / settings | ✅ local IDB mirror (already) | ✅ |
| Acquire *new/never-touched* content | needs network | needs network (cold sync) |

Honest limit: on a web PWA, audio for never-opened books is quota-bound — full
offline audio is guaranteed only on native (or within the LRU budget). Everything
*already acquired* is 100% offline in both modes. Pause/seek/navigation within
acquired content is always network-free.

---

## 8. Risks

- **Storage quota / iOS eviction (web)** → `StorageManager.persist()`, audio LRU
  budget, text-class is small enough to keep fully. `lv-blobs` already survives
  deploys.
- **Live-root churn during TTS** → accepted; diffs are O(1) leaf.
- **Worker as DAG writer** → bounded (one leaf + path-to-root per completion).
- **Native store correctness** → content-addressed = self-verifying (hash is the
  key); GC orphans on render_version bump.
- **Migration risk** → keep legacy path endpoints as shims; ship phase-by-phase
  (see the plan), each independently deployable, offline-first delivered first.
