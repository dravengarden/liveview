# Offline-first refactor — phased plan

Companion to [offline-first.md](offline-first.md) (the design). Sequenced so the
**#1 requirement (offline ≈ online) lands earliest**, each phase independently
deployable, legacy path endpoints kept as shims until the end. Verify gate every
phase: `deno task typecheck` (web) + `cargo build` (server) + `nixos-rebuild
build` + manual offline smoke-test, then deploy.

Task IDs reference the session task list.

---

## P1 — Content-address everything + local-first reads  (tasks #3, #4)

**Goal:** the existing web app becomes offline-robust and deploy-stable for all
*acquired* content. Highest-value, lowest-risk; the substrate for everything else.

### P1a — server (task #3)  `src/`
1. Give text/html, units, spoken, marks **stable content hashes** (the text Merkle
   leaf already hashes source; we need hashes of the *served* artifacts). Store
   them content-addressed (rustfs by hash like audio/marks, or a pg `blobs(hash)`
   table). `src/store/`, `src/sync/run.rs`.
2. Extend `GET /api/blob/{hash}` to resolve **all** leaf types, not just
   rustfs audio/asset. `src/main.rs`.
3. Extend the manifest to a `GET /api/dag` returning `{ root, leaves:[{path, kind,
   hash, bytes, audioStatus}] }` covering every leaf incl. text-class. Keep
   `/api/manifest` as-is meanwhile.
4. Immutable cache headers on all blobs. Keep `/api/file|units|spoken|marks` as
   thin path→blob shims.

### P1b — client (task #4)  `web/src/`
1. **Resource resolver**: `resolveHash(path) -> hash` from a locally cached DAG;
   `getBlob(hash)`; `useResource(pathOrHash) -> {data, loading, missing}`.
2. **SW rewrite** (`web/public/sw.js`): content endpoints + blobs served
   **cache-first by hash** from a **persistent** cache (not the version-prefixed
   `API_CACHE` that a deploy wipes). Network only on miss. Today `/api/file` is
   network-first in `API_CACHE` → after a deploy, offline text breaks; this fixes
   it.
3. Route reader reads through the resolver (text/units/spoken/marks). Audio already
   cache-warms; align it to hash-keys.
4. Loading-aware: skeletons where `loading`, "not downloaded" placeholder where
   `missing` (lazy) — never a hard error offline.

**Exit:** open a book online, go offline (airplane mode), re-open visited
chapters + play listened audio + pause/seek/navigate — all work; survives a
redeploy.

---

## P2 — Client DAG replica + reconcile; drop pull-to-refresh  (task #5)

1. Client tracks the root; on `RootChanged` (WS) / fallback poll, **diff** vs
   locally-known hashes, **pull only changed leaves** into the cache, **GC**
   orphans (old render_version). `web/src/` new `dagReplica` store.
2. Add `WS RootChanged{root}` server-side (`src/server/ws.rs`, `src/shared.rs`);
   fire on sync + (after P3 unify) audio completion.
3. **Remove pull-to-refresh** (`Landing.tsx`) — content is reconciled live; the
   shelf updates on root change. No manual refresh affordance.

**Exit:** deploy new content while the app is open → it appears without a manual
refresh; no pull-to-refresh remains.

---

## P3 — Eager native mode + one live root  (task #6)

1. **DAG unify** (design §4): worker folds audio/marks hashes into the leaf →
   live root; `RootChanged` covers audio backfill. `src/server/audio.rs`,
   `src/sync/`.
2. **Native content-addressed store** (Tauri Rust): zstd (SIMD) for text-class,
   raw mp3; `getBlob`/`hasBlob` bridge; audio→native AVPlayer by hash. Replaces
   the SW for native.
3. **Eager sync**: on launch + `RootChanged`, mirror the whole DAG into the native
   store (cold-sync progress UI). `dataMode='eager'` ⇒ resolver hits the native
   store; `loading` only on the three genuine cases.

**Exit:** native app, airplane mode from cold-synced state → every book/chapter
opens + plays with no network, no loading.

---

## P4 — Unified status component + offline UX audit  (task #7)

1. Fold reconnect/offline + update into `SyncIndicator` as a **state machine**
   (design §6): update=**blue**, offline/reconnect=**yellow**, generating=neutral,
   error=**red**. Reconnect via `connectionStore` (exp backoff cap 60s, show after
   ~4 retries, unbounded). One strip, one sheet.
2. **Offline UX audit**: sweep every reader/shelf path for loading-aware + "not
   downloaded" states; no hard error offline.
3. `StorageManager.persist()` (web) + audio LRU budget; verify eviction behaviour.

**Exit:** pull network mid-session → a calm yellow "reconnecting" strip (after the
backoff threshold), app stays fully usable; reconnect clears it; a deploy shows a
blue "reload" strip.

---

## Sequencing & risk

- **Do P1 first** — it alone delivers "offline ≈ online" for acquired content on
  the web app, and is the substrate for P2–P4. Lowest risk (additive; legacy
  endpoints stay).
- P3's DAG-unify is the one server-coupling decision; isolated to P3.
- Each phase ships behind the keep-legacy-shims rule, so a half-done refactor
  never breaks the live app.
- The two-mode split means web (lazy) keeps working throughout; native (eager) is
  additive on top of the shared blob substrate.
