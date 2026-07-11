# Liveview system audit — 2026-07-11

## Decision

Liveview does not need a rewrite, and the books repository does not need a
deeper directory hierarchy. The durable direction is to make ownership and
delivery gates explicit:

| Owner | Owns | Must not own |
|---|---|---|
| `liveview` | Book format contract, parser, renderer, checker, sync protocol, server, web reader, native shell, deterministic book tooling | Book source content or host-specific orchestration |
| `books` | `book.toml`, authored Markdown, assets, narration overlays, audiobook scripts | Generated audio, caches, databases, compiler/checker implementations |
| Columbus skills | Agent workflow and editorial judgment around extract, translate, fix, narrate, and visual review | A second parser, renderer, Mermaid validator, or hidden runtime environment |

The current books shape (`<slug>/book.toml`, language directories, assets,
optional `audio/` and `.narration/`) already matches this boundary. Adding
category folders, per-book repositories, or a second manifest index would make
discovery and tooling more complex without solving a current failure mode.

## Evidence baseline

This audit covered the server, web/PWA, Tauri app, offline sync core, deployed
service, books corpus, and the six book-generation/review skills.

- Server Rust suite: 169 passed, 3 ignored.
- Offline sync core: 20 passed, 1 native end-to-end test ignored on Linux.
- Web and app bundles build successfully.
- The real iOS Simulator app loaded the shelf and a Markdown chapter in both
  light and dark appearance through `lvsync://localhost`.
- The deployed shelf contains 142 items from 137 book manifests.
- Corpus check found 486 warnings: 381 stray-emphasis, 93 missing assets,
  7 broken references, and 5 math parse warnings.
- Narration audit found 21,216 non-prose resources and 14,882 without authored
  narration, led by code (5,093), diagrams (4,735), tables (2,845), and math
  (1,592).
- All 5,468 Mermaid blocks in served books parse with the reader's Mermaid
  11.12.3 bundle. A separate ignored extraction artifact contains one failure.
- `/api/books` is about 80 KiB for the current shelf. `/api/sizes` is the slowest
  sampled metadata endpoint at about 220 ms; the others are sub-millisecond.
- The frontend emits three roughly 390–460 KiB JavaScript chunks before gzip,
  plus multi-megabyte CJK font files. `InteractiveViewViewer` is both statically
  and dynamically imported, preventing the intended split.

## P0 — correctness and reproducibility

### Native source must be self-contained

`plugins/lvsync` referenced `../../lv-sync`, but that crate lived in a separate
local repository with no remote. A clean checkout therefore could not resolve
the native dependency graph. The crate is now part of this repository, the app
lockfile is tracked, and CI validates `cargo metadata --locked` in addition to
testing the core crate. The Mac Simulator remains the authoritative native
compile/install/launch gate.

### Store failures must fail closed

The manifest, root, DAG, sizes, and per-book manifest handlers turned postgres
errors into empty successful responses with `unwrap_or_default`-style fallbacks.
Empty state is valid protocol data, so a database outage could look like a
successful empty deployment to native clients. These handlers now use a shared
API error that logs the operation and returns 503. Add store-failure integration
tests before changing client retry behavior.

Sync also used to discard the result of the postgres reload notification. It
now reports that content committed but notification failed instead of claiming
clean success. A later improvement can retry the idempotent notification
without rerunning content ingestion.

### Content quality is a delivery gate, not a skill convention

The deployed corpus has no fatal checker errors, but hundreds of warnings and a
large narration backlog have accumulated because quality is advisory. Add a
machine-readable policy command owned by liveview, for example:

```text
liveview book gate <book-or-shelf> --profile production
```

The profile should define allowed warning budgets and required narration by
resource type. Run it in the books repository CI and before `liveview sync`.
Skills may repair failures, but they must not be the only enforcement point.
Start with a checked-in baseline so legacy debt does not block every change;
reject only new regressions, then ratchet the baseline down.

### Published Git must match deployed source

The audited liveview checkout is 31 commits ahead of `origin/main`, and the Nix
flake pins that local head. Deployment is reproducible on this host but not
recoverable from GitHub. Push only after reviewing the commit series and the
current audit changes; future deployments should require a remotely reachable
commit.

The release workflow now builds the generated web bundle once and packages the
actual `liveview` binary. The old crates.io job was removed: an embedded reader
archive is about 32 MiB compressed because of its fonts, so a source crate is
the wrong distribution channel. GitHub binaries remain the canonical CLI
artifact; npm/Python packages may wrap those binaries rather than compiling an
incomplete non-embedded server.

## P1 — one toolchain, observable operations

### Consolidate deterministic book tooling

There are two Mermaid validators with different runtimes and traversal rules:
the liveview Deno tool and the chart-review Chromium helper. Keep one canonical
validator in liveview, with both file and JSON-stream inputs; make chart-review
call it inside the real-reader loop.

The Python helpers behind extract/narrate/translate currently have no tests.
Move deterministic format operations toward the liveview CLI and add fixtures
for manifest discovery, chapter mapping, asset rebasing, narration-plan hashes,
and overlay fallback. Keep model calls and editorial decisions in skills. Remove
the mechanical narration commands whose surface contradicts the spoken-track
workflow.

MinerU must have an explicit tool-owned environment. The extraction workflow
must not depend on `projects/julia-land/.venv-extract`; pin the extractor in
`agent_tools` or invoke a documented external service through one adapter.

### Make the corpus incremental

The shelf gate, narration plan, and sync should all accept the same content
fingerprint. Cache results by book revision and resource hash so an unchanged
137-book corpus is not rescanned or re-narrated. The books repository remains a
plain source repository; derived indexes belong in CI artifacts or the runtime
store, not in Git.

### Split by responsibility, not line count

Large files are a symptom, not the target. Split `src/main.rs` first around API
route groups, response/error policy, and startup wiring. Split `App.tsx` around
shelf, reader, sync, appearance, and audio controllers. Keep state ownership at
feature boundaries and avoid a generic utilities layer. `check/interactive_view`
should separate syntax parsing, semantic validation, and diagnostics only when
tests can freeze their behavior.

### Operational observability

- Export liveview request, sync, audio-task, and store-error metrics to the
  existing VictoriaMetrics instance. The service currently has logs but no
  application scrape target.
- Filter the expected hidden-document View Transition cancellation from APM;
  all sampled recent error events were this benign browser condition.
- Bound `/api/ingest` request bytes and event count. Treat its client token as
  abuse resistance, not a secret, because it is embedded in the app.
- Stop postgres from probing an inaccessible `~/.pgpass` under `ProtectHome` by
  setting the intended password-file behavior explicitly.
- Version the manifest/root protocol and report client/server compatibility in
  diagnostics before evolving either side.

## P2 — reader performance and polish

- Fix the static/dynamic `InteractiveViewViewer` import conflict, then measure
  route-level lazy loading before introducing more chunks.
- Subset or defer CJK fonts and record a bundle budget in CI. Do not optimize
  only the compressed JavaScript number while font transfer dominates.
- Paginate or incrementally hydrate the shelf before the 80 KiB metadata
  response grows materially.
- Reposition the floating audio control so it cannot overlap shelf card actions
  or reader controls; account for safe-area insets and the bottom navigation.
- Add frontend tests for navigation, offline resolution, theme transitions,
  audio state, and error recovery. Use Simulator validation for native UI and
  reserve Chrome-based review for rendered book charts.

## Sequencing

1. Land self-contained native dependencies, lockfile, CI, and corrected docs.
2. Add typed 503 store errors and reliable reload notification with tests.
3. Introduce a baseline-aware production book gate and run it before sync.
4. Unify Mermaid validation and add deterministic book-tool fixtures.
5. Address narration debt incrementally by resource hash.
6. Split server/web responsibilities, then enforce bundle and runtime budgets.

This order protects data correctness and recoverability before doing structural
or visual refactors. Each step is independently releasable and keeps the
existing book format stable.
