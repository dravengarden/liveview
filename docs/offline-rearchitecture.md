# Offline re-architecture: iOS-native (no Service Worker) + SQLite-backed store

Status: **design / research** (no implementation yet). Tracked by tasks A1–A4
(build split) and B1–B5 (SQLite + indexes), plus D0 (this doc).

## 1. Why

Two problems drove this:

1. **Offline is fragile and the mechanism is doubled.** The iOS shell loads the
   *remote* SPA in a WKWebView and relies on a **service worker** to serve the
   app shell offline — *and* a parallel **native bridge** (lvSync + AVPlayer) to
   serve content/audio offline. The two systems overlap, disagree, and each has
   broken offline in a different way (SW unregistered → can't even launch
   offline; raw-`fetch` spine → card won't open; URL-vs-hash key mismatch → no
   offline playback). One device, two offline stacks, neither fully owning it.

2. **The Downloads panel is slow to open, every time.** It recomputes
   everything from scratch on each open (and every 2 s poll): the web fetches
   the full **~4 MB `/api/dag`** and parses ~15 k resources; `LvSyncController.
   stats` re-parses the dag and **stats ~11 k text files**; `audioStats` **stats
   ~3388 audio files** and marshals a 3388-element `cached[]` array across the
   bridge. There is no persistent index.

The decision: **stop fighting the service worker on iOS.** Make iOS a
first-class native app (bundled SPA, native data layer, SQLite), keep the SW for
the PWA only, and replace the scan-everything stats with a maintained index.

## 2. Current architecture (as researched)

- **One build** (`web/`, Vite) → `dist/`, embedded in the liveview server and
  served at the remote origin `https://liveview.hawk.thundersparrow.top`.
- **PWA / browser**: loads the remote origin; `public/sw.js` is the offline
  layer (cache-first navigate shell, SWR assets, cache-first `/api` content,
  Range-from-cache audio, VERSION-stamped by the `lv-stamp-sw` Vite plugin).
- **iOS shell** (Tauri/WKWebView): `tauri.conf.json` `frontendDist = ../loader`.
  A bundled `loader/index.html` probes the remote, survives the iOS Local-Network
  prompt, then `location.replace(REMOTE)` — so the running webview is the
  **remote origin**. `main.tsx` then *unregistered* the SW on the shell ("always
  fresh"), which is exactly what broke cold offline launch.
- **Native bridges** (because a remote origin can only call native *plugins*, see
  memory `tauri-remote-ipc-needs-plugin`):
  - `LvSyncController.swift` — text/units/marks/spine content, dir
    `Application Support/lvcontent/`, file-per-URL-digest. `contentFetch`
    (`native-sync.ts`) routes here.
  - `NativeAudioController.swift` — audio via a real **AVPlayer** (lock-screen /
    background), dir `Application Support/lv-audio/`, file-per-content-hash, with
    an adaptive download scheduler.
- **`apiBase.ts` already has a `BUNDLED` mode** (Tauri shell + *not* the remote
  origin): load the SPA from a **local origin**, rewrite relative `/api` → remote
  for things that must hit the server, content via the native plugin. **This mode
  exists but is unused** — it is the seam this whole plan builds on.
- **Stats slow-path**: `OfflineSection` fetches `/api/dag` fresh + parses it;
  `nativeCacheStats`→`LvSyncController.stats` parses the dag + stats every file
  (`storeDirty` defeats its Merkle short-circuit during an active download);
  `nativeAudioStats` scans the audio dir + returns the full key list.

## 3. Target architecture

### 3.1 Two build targets, one shared core

The split is **app vs pwa**, NOT ios vs pwa — the **macOS** desktop shell belongs
with iOS in the native "app" target (same bundled SPA + native data layer + no
SW), not with the browser PWA.

```
web/src/                     shared SPA core (reader, audio UI, components, hooks)
  platform/
    index.ts                 re-exports the adapter chosen by __TARGET__
    app.ts                   native adapter (Tauri plugin + native audio) — iOS + macOS
    pwa.ts                   web adapter (fetch + service worker)
```

- `vite build --mode pwa` → `dist-pwa/`: **service worker kept**, remote origin,
  served by the server. Unchanged behaviour for browsers/PWA.
- `vite build --mode app` → `dist-app/`: **no service worker** (drop the
  registration *and* the `stampServiceWorker` plugin), native adapter only.
  Bundled into the Tauri app (iOS **and** macOS).
- A build-time `__TARGET__` define + the `platform/` indirection let Rollup
  tree-shake the unused stack out of each bundle (no SW code in the app build; no
  native bridge in the PWA build).

### 3.1a Native data layer: cross-platform Rust Tauri plugin (iOS + macOS)

The current iOS data layer is **Swift** (`LvSyncController`/`NativeAudioController`
as WKScriptMessageHandlers), reachable because the shell loads the remote origin.
That code is **iOS-only** — the macOS desktop shell (`cargo tauri build`, wry
WebView) does not compile `gen/apple/Sources`, so it cannot reuse it. To serve
BOTH Apple platforms from one native layer with no SW, the **content/Merkle/SQLite
store becomes a Rust Tauri plugin** (`plugin:lvsync|*`), shared by iOS + macOS —
which is exactly what memories `tauri-remote-ipc-needs-plugin` and
`lvsync-rust-offline-core` already pointed to (a Rust Merkle+resolve+retention
core exists in `src/sync`). The plugin is reachable only from a **local (bundled)
origin** — another reason the app target must be bundled (§3.2).

- **Data** (content resolve, Merkle DAG, SQLite index, retention/eviction,
  download scheduling): **Rust plugin** + `rusqlite`. Native, no SW, shared.
- **Audio playback** (lock-screen / background) stays **native Swift AVPlayer**
  on iOS (a thin per-platform piece); macOS can use AVFoundation or, lower
  priority, the web `<audio>` element. "Prefer Swift where it's Apple-specific"
  → audio; "prefer one shared native core" → the data/store layer in Rust.
- Migration: the iOS Swift `LvSyncController` content path is retired once the app
  loads bundled (plugin reachable); `NativeAudioController` (AVPlayer) is kept and
  its store is backed by the same SQLite index via the plugin.
- **macOS is not yet in the Tauri Apple project** (gen/apple is iOS-only; macOS is
  a separate desktop `cargo tauri build`). Adding the macOS app target + wiring
  the shared Rust plugin is its own task (A5).

### 3.2 iOS: bundled SPA + native, **no service worker**

- `frontendDist = dist-ios` (the built SPA), so the shell loads from a **local
  origin**. The app shell is therefore *always* available offline — **no SW
  needed**, and no remote-probe loader (a local origin has no Local-Network
  prompt). The `loader/` page and its favicon-probe handoff go away on iOS.
- Every `/api` read goes through the **native adapter** → SQLite/native store
  (offline-first), never a bare network fetch. Absolute-remote is used only for
  the things that genuinely must hit the live server *when online* (and they
  degrade gracefully offline).
- **SPA update story** (tradeoff to confirm): the bundled SPA updates with the
  app build (`lvbuild.sh`/App-Store), not a server deploy. Phase-2 option: a
  native OTA bundle-swap (download the new `dist-ios` over the air, atomic swap)
  to keep instant updates without the App Store. Recommend shipping bundled
  first, OTA later.

### 3.3 Client SQLite store (iOS native)

Replace file-per-blob + directory scans with **one SQLite DB** as the offline
source of truth.

```sql
-- one row per offline resource (text + audio), content-addressed
resource(
  hash TEXT PRIMARY KEY, kind TEXT, slug TEXT, lang TEXT, rel_path TEXT,
  bytes INTEGER, cached INTEGER, pinned INTEGER, mtime INTEGER
);
CREATE INDEX resource_kind  ON resource(kind);
CREATE INDEX resource_slug  ON resource(slug);
CREATE INDEX resource_cached ON resource(cached);
CREATE INDEX resource_lru   ON resource(pinned, mtime);   -- eviction

merkle_node(hash TEXT PRIMARY KEY, kind TEXT, payload TEXT);  -- the DAG
kv(k TEXT PRIMARY KEY, v BLOB);            -- progress / settings / prefs / root
agg(kind TEXT PRIMARY KEY, cached_bytes INTEGER, cached_count INTEGER,
    total_bytes INTEGER, total_count INTEGER);  -- O(1) Downloads stats
```

- **Blob bytes**: keep large audio/text as files keyed by `hash` (avoid DB
  bloat); the row carries `bytes`+location. Small JSON (marks/units) may live
  inline. (Confirm in B2.)
- **WAL** mode; all writes update `agg` in the same transaction → **O(1) size**.
- Swift via system `libsqlite3` (thin wrapper, no heavy dependency).

### 3.4 Merkle DAG on SQLite

Port the offline replica's Merkle reconcile (mirror of server `src/sync`) to run
against SQLite: nodes in `merkle_node`, **diff server root vs local root with
indexed queries** (not a dir walk), enqueue only changed leaves, prune dropped
ones, advance the local root last. Resumable + incremental; an unchanged deploy
is an indexed no-op. One queue drives both the text and audio fills.

### 3.5 Size/progress index — server + client

- **Server (B1)**: a cheap endpoint returning **precomputed** per-book + global
  `{text_bytes, audio_bytes, text_count, audio_count}`, keyed by the deploy
  root, from a maintained pg summary (or indexed SUM). The client gets totals in
  one tiny response instead of downloading + parsing the 4 MB dag.
- **Client (B4)**: Downloads stats come from the `agg` table (maintained on every
  download/evict) → the panel opens **instantly**; the bridge returns small
  numbers + a cheap per-book breakdown, never the 3388-element key list, and
  nothing scans the filesystem.

## 4. Plan / sequencing

| Phase | Tasks | Notes |
|---|---|---|
| Quick win | **B1** | Server size index — cuts the 4 MB dag fetch now; independent of the rest. |
| Seam | **A1** | Platform data-layer interface + two adapters. Unblocks the split. |
| Split | **A2** → **A3**, **A4** | Two build targets; iOS bundled + no SW; native adapter covers all reads. |
| SQLite | **B2** → **B3**, **B4** → **B5** | Schema → Merkle-on-SQLite + O(1) stats → migrate stores. |

B1 can land immediately (biggest UX win for the slow panel, low risk). The
SQLite work (B2–B5) lands behind the iOS-native direction (A) since SQLite lives
in the native layer. PWA keeps the SW throughout.

## 5. Risks / decisions to confirm

- **SPA freshness on iOS** loses instant server-deploy updates (bundled). Accept
  app-rebuild updates first; add native OTA bundle-swap later if needed.
- **Two stacks during migration**: keep the SW + native both working until the
  iOS target is proven, then remove the SW from the iOS bundle only.
- **SQLite blob policy** (files-by-hash vs inline) — default files-by-hash for
  audio; confirm for text/marks in B2.
- **Local-origin gotchas** (CSP, `withGlobalTauri`, plugin ACLs for a local vs
  remote origin) — the `BUNDLED` path was built for exactly this; re-verify the
  capability files (`capabilities/`).
