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
- **`liveview check`** = 8 content validators (markdown/math/mermaid/svg/typst/
  json/excalidraw) on the **checker == renderer** principle — "clean" means
  "renders". It's the engine behind the warn-only sync gate + `/fix-book`.
  (memory: liveview-content-checker)
- **Diagram theming**: mermaid renders natively per light/dark mode (re-render,
  not invert); book SVGs use an invert-filter; the lightbox must **NOT** invert
  theme-native mermaid. (memory: liveview-diagram-rendering)
- **Multi-client**: single-active-player handoff (stable device id + per-tab
  instance id + WS setting broadcast). `crypto.randomUUID` needs a secure
  context; `persisted()` doesn't write its initial value until the first `.set()`.
  (memory: liveview-multi-client)
- **PWA / native**: hard iOS limits (lock-screen/background audio needs the Tauri
  shell, not the PWA). The Tauri macOS build must pin `time = 0.3.47` (0.3.48
  trips an E0119 in tauri-utils); `src-tauri/Cargo.lock` is untracked, so the pin
  isn't durable — re-check it. (memories: liveview-pwa-apis, liveview-tauri-shell,
  liveview-tauri-macos-build)

Authoring books that this reader serves: see the **books** project's AGENTS.md
(the check + fix + chart-review delivery gate).
