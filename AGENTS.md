# Contributor Guide

## Toolchain

- Use Deno 2.x for JavaScript and TypeScript work.
- Use the pinned Nix development shell when available: `nix develop`.
- Keep Rust, Deno, and native dependency lockfiles checked in.
- Write code, comments, documentation, and commit messages in English.

## Common commands

```bash
make dev              # start the web and server development processes
make build            # build the embedded release binary
make check            # formatting, linting, and type checks
make test             # Rust, plugin, and web tests
make verify           # the complete local quality gate
nix build             # reproducible package build
```

The native dependency graph can be checked without an Apple toolchain with
`make native-metadata`. Simulator and device validation still require Xcode.

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

- Run `make verify` before committing.
- Preserve unrelated working-tree changes.
- Add tests for protocol, parser, cache, and synchronization behavior changes.
- Keep protocol additions backward compatible and bump the protocol version
  before making an incompatible change.
- Never commit credentials, deployment hostnames, private addresses, or
  environment-specific operational instructions.
- Keep generated build output out of Git.

## Content and UI behavior

- The checker and renderer should accept the same content formats.
- Mermaid diagrams are rendered for the active light or dark theme; do not
  apply image inversion to theme-native diagrams.
- Each device owns its playback state. Cross-device progress is a resume hint,
  not a live mutual-exclusion mechanism.
- Background audio and lock-screen controls are native-shell capabilities; do
  not assume a browser PWA can provide the same lifecycle guarantees on iOS.
- Keep remote-origin selection aligned between `web/src/apiBase.ts` and
  `plugins/lvsync`.

## Native shell

The Tauri app has a separate, tracked Cargo lockfile. `time` is pinned for
compatibility with the current Tauri dependency graph. The Mac/iOS Simulator is
the authoritative native UI and background-audio validation target.

Use the repo-local `ios-sim-dev` skill for simulator builds, WKWebView
inspection, selector-driven interaction, screenshots, and light/dark visual
verification. Physical-device provisioning is a host operation owned by the
machine-level `ios-resign` skill.
