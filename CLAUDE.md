# Project Guidelines

## Package Manager

Use **bun** for all JavaScript/TypeScript operations:

```bash
# Install dependencies
bun install

# Run scripts
bun run dev
bun run build
bun run typecheck

# Run TypeScript files directly
bun run script.ts

# Run tests with Playwright
bun run playwright test
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
