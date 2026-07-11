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
