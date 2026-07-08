# Project Guidelines

## Package Manager

Use **deno** (2.x) for all JavaScript/TypeScript operations. The `web/`
SPA keeps a `package.json` (npm deps + scripts); deno reads both and
materializes a `node_modules/` for Vite.

```bash
# Install dependencies (--allow-scripts lets esbuild's lifecycle script
# link its native binary; deno blocks npm lifecycle scripts by default)
deno install --allow-scripts

# Run package.json scripts via deno task
deno task dev
deno task build
deno task typecheck

# Run a TypeScript file directly
deno run -A script.ts

# Run tests with Playwright
deno run -A npm:playwright test
```

## Development

```bash
# Start dev servers (frontend + backend)
make dev

# Frontend only
make dev-web

# Backend only
make dev-server
```

## Build

```bash
# Build frontend
make build-web

# Build release binary
make build

# Install globally
make install
```

## Code Style

- Use TypeScript strict mode
- Run `make check` before committing
- Run `make fmt` to format code

## Portal UI (when hosted by atlantis)

liveview is hosted by the **atlantis** portal in a keep-alive iframe (it also
runs standalone). The shared cross-app UI primitives — launcher placement,
theme, selected states, mobile, cross-origin gotchas — are a **living guide** in
the columbus monorepo at `conventions/ui.md` (SDK mechanics:
`interface/app-shell/`). Read it before changing liveview's chrome/launcher, and
when you discover a better pattern or a sharp edge, update that guide (it's
shared across all the portal apps, not just liveview).

## Serving & deploy (distilled from the project memory tier)

- The binary is **`liveview`** (renamed from `lv`). It serves from a **pg +
  rustfs** store fed by **`liveview sync`** — a git-driven, Merkle-incremental
  deploy that reads the **working tree** (not a git rev). Don't fire `sync`
  mid-write (partial book); poll the pg goal state / `deploy_root`, not the
  service's `is-active` (the oneshot returns before content is ready).
  (memory: liveview-pg-rustfs-store)
- **Code deploy is separate from content sync**. Frontend/server changes are
  embedded in the `liveview` binary consumed by `/etc/nixos` as a `git+file`
  flake input, so uncommitted source edits do not reach the running service.
  For a hawk deploy: commit the focused liveview change, update the `liveview`
  input in `/etc/nixos/flake.lock`, run `sudo nixos-rebuild build`, then
  `sudo nixos-rebuild switch` for service-code-only changes. Verify
  `liveview.service`, `/api/version`, and the served JS bundle.
- **`liveview check`** = 8 content validators (markdown/math/mermaid/svg/typst/
  json/excalidraw) on the **checker == renderer** principle — "clean" means
  "renders". It's the engine behind the warn-only sync gate + `/fix-book`.
  (memory: liveview-content-checker)
- **Diagram theming**: mermaid renders natively per light/dark mode (re-render,
  not invert); book SVGs use an invert-filter; the lightbox must **NOT** invert
  theme-native mermaid. (memory: liveview-diagram-rendering)
- **Multi-device**: each device plays INDEPENDENTLY — the old single-active-player
  mutual exclusion (claim/heartbeat/"playing elsewhere") was removed (lv-v172).
  The cross-device RESUME pointer (sessionStore/posStore) + rate/sleep prefs are
  kept but only reconcile at STARTUP, never mid-playback. (`persisted()` still
  doesn't write its initial value until the first `.set()`.)
- **PWA / native**: hard iOS limits (lock-screen/background audio needs the Tauri
  shell, not the PWA). The Tauri macOS build must pin `time = 0.3.47` (0.3.48
  trips an E0119 in tauri-utils); `src-tauri/Cargo.lock` is untracked, so the pin
  isn't durable — re-check it. (memories: liveview-pwa-apis, liveview-tauri-shell,
  liveview-tauri-macos-build)

Authoring books that this reader serves: see the **books** project's AGENTS.md
(the check + fix + chart-review delivery gate).

## APM / Observability (client operation + perf telemetry)

The **native shell** captures client operation / perf / error events, buffers them
in an offline-durable SQLite outbox, and batch-flushes them to the server when the
network is good; the server forwards each to the host **VictoriaLogs**, where you
debug "what happened / how it performed" with LogsQL. **Native-only** — off the
shell (PWA / browser) every hook is a no-op (that surface is effectively always
online; a lost analytics event isn't worth a buffer).

**Data flow** (capture → buffer → flush → store → debug):

```
web/src/apm.ts logEvent()          plugins/lvsync /apm/*         src/main.rs
  player.tsx / App.tsx / errors  →  SqliteBlobStore.apm_*    →   POST /api/ingest  →  VictoriaLogs
  (native SQLite outbox: lvsync.sqlite `apm_events`)             (bearer auth,          :6302 /insert/jsonline
   flush gate = online + NWPathMonitor, at-least-once)           forwards NDJSON)       → vmui / LogsQL
```

- **Capture** — `logEvent(type, fields)` in `web/src/apm.ts`; wired at the choke
  points: `audio/player.tsx` (`audio_open` / `audio_play` / `audio_pause` /
  `audio_ended`), `App.tsx` `openFile` (`open_chapter`), and app-wide uncaught
  `error` / `unhandledrejection`. Add new call sites here; keep perf numbers scalar
  (e.g. `dur_ms`) so they stay queryable, not buried in a nested object.
- **Buffer** — the Rust `SqliteBlobStore` (`lv-sync/src/sqlite.rs`) gains an
  `apm_events(event_id PK, ts, body)` table + `apm_log/apm_drain/apm_ack/apm_prune`.
  Schema-DUMB: the web owns the event JSON; the store only lifts `event_id` (dedup)
  + `client_ts` (prune order). Reached from `plugins/lvsync/src/lib.rs`
  `scheme_dispatch` via `/apm/log`, `/apm/drain`, `/apm/ack` (a row is deleted only
  on server ack; a 5000-row cap is the offline-forever safety valve).
- **Flush** — `flushApm()` drains in batches and POSTs to `/api/ingest`, acking only
  on a 200 (**at-least-once**; `event_id` dedups a re-send). Gated on connectivity,
  reusing the audio layer's `NWPathMonitor` signal; triggers mirror `syncQueue`
  (online / visibility / 30 s interval).
- **Server → VL** — `api_ingest` (`src/main.rs`) stamps `received_at` + `_msg` and
  forwards the batch as jsonline to VL. Returns 200 only when VL accepts (a VL
  hiccup → 502 → the client keeps the events). `event_type` + `device_id` are the VL
  **stream** fields; `client_ts` is the log **time** (so an offline-buffered event
  lands at when it HAPPENED). No pg table — VL is the store, its 14-day retention IS
  the cleanup (no cron).
- **Auth** — bearer token: server reads `LIVEVIEW_APM_TOKEN[_FILE]`
  (`/etc/liveview/secrets/apm-token`, NixOS unit); client bakes the same value in via
  Vite `VITE_APM_TOKEN`. **Both absent ⇒ open** (dev/LAN): the server logs a warning
  and accepts unauthenticated, so nothing breaks until you provision both.

**Debug in vmui** (`http://192.168.0.96:6302/select/vmui/`, LogsQL):

```logsql
# All client events from the liveview APM stream, newest first
event_type:* | sort by (_time desc) | limit 200

# One reading session's timeline (grab session_id from any row)
session_id:"<id>" | sort by (client_ts)

# Per-device error rate over the last day
event_type:error | stats by (device_id) count()

# Audio open→first-play latency p95 (once you log a dur_ms on the event)
event_type:audio_play | stats quantile(0.95, dur_ms) p95, count() n
```

Since VL already carries `liveview.service`'s own journald (`_SYSTEMD_UNIT`),
client APM events and server logs are queryable **side by side** in one place.
Enabling numeric MetricsQL dashboards (VictoriaMetrics) is a future add — LogsQL
`stats quantile(...)` covers perf today.
