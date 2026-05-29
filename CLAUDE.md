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
