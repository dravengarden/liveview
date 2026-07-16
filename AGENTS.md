# Contributor Guide

## Toolchain

- Use Deno 2.x for JavaScript and TypeScript work.
- The pinned Nix development shell owns Rust, Deno, and native build tools.
  Run project commands from the repository root through it, for example
  `nix develop -c just verify`; do not probe host tools first.
- Keep Rust, Deno, and native dependency lockfiles checked in.
- Write code, comments, documentation, and commit messages in English.

## Common commands

```bash
just dev              # start the web and server development processes
just build            # build the embedded release binary
just check            # formatting, linting, and type checks
just test             # Rust, plugin, and web tests
just verify           # the complete local quality gate
nix build             # reproducible package build
```

The native dependency graph can be checked without an Apple toolchain with
`just native-metadata`. Simulator and device validation still require Xcode.

## Project boundaries

- `src/` owns the server, CLI, content checking, and embedded reader delivery.
- `web/` owns the React reader and PWA.
- `lv-sync/` owns the platform-independent offline synchronization core.
- `plugins/lvsync/` exposes offline synchronization to Tauri.
- `app/` owns the native shell and platform integration.
- `tools/` contains deterministic repository utilities.

The server reads deployed content from PostgreSQL and an S3-compatible object
store. A native client resolves cached content through the `lvsync://` custom
scheme and refreshes it from a configured LiveView server.

## Development rules

- Run `just verify` before committing.
- Preserve unrelated working-tree changes.
- Add tests for protocol, parser, cache, and synchronization behavior changes.
- Keep protocol additions backward compatible and bump the protocol version
  before making an incompatible change.
- Never commit credentials, deployment hostnames, private addresses, or
  environment-specific operational instructions.
- Keep generated build output out of Git.

## Content and UI behavior

- Treat [docs/core-requirements.md](docs/core-requirements.md) as a product gate.
  A functionally correct feature is incomplete if it regresses scrolling,
  transitions, sheets, or playback responsiveness under background work.
- Follow `docs/design-system.md` for brand, material, responsive, and motion
  decisions. Keep identity tokens in `web/src/brand.ts`; do not fork logo geometry
  or palette values inside components.
- Never add `backdrop-filter`, CSS `filter`, or blend modes to scrolling shelf
  content or fixed chrome that overlaps it. Preserve the scroll-material test.
- The checker and renderer should accept the same content formats.
- Mermaid diagrams are rendered for the active light or dark theme; do not
  apply image inversion to theme-native diagrams.
- Each device owns its playback state. Cross-device progress is a resume hint,
  not a live mutual-exclusion mechanism.
- Covers and backdrops are first-class content-addressed Merkle DAG resources.
  Keep their blob hashes in the deploy root and enumerate both in `/api/dag` so
  native clients can verify, sync, retain, garbage-collect, and serve them offline.
  Do not regress artwork to a URL-keyed side cache.
- Background audio and lock-screen controls are native-shell capabilities; do
  not assume a browser PWA can provide the same lifecycle guarantees on iOS.
- Keep remote-origin selection aligned between `web/src/apiBase.ts` and
  `plugins/lvsync`.
- Treat manifest `tags` as author-owned, lowercase search keywords. Keep them
  precise and portable; `taxonomy.json` maps selected aliases onto the stable
  Topic, Technology, and Level discovery facets. Taxonomy aliases, labels, and
  IDs are product schema: update Rust and web consistency tests together, and
  keep taxonomy plus book tags in the catalog Merkle identity.

## Native shell

The Tauri app has a separate, tracked Cargo lockfile. `time` is pinned for
compatibility with the current Tauri dependency graph. The Mac/iOS Simulator is
the authoritative native UI and background-audio validation target.

Use the repo-local `ios-sim-dev` skill for simulator builds, WKWebView
inspection, selector-driven interaction, screenshots, and light/dark visual
verification. Physical-device provisioning is a host operation owned by the
machine-level `ios-resign` skill.
