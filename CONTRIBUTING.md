# Contributing to LiveView

Thank you for helping improve LiveView. Focused fixes, tests, documentation,
content-format improvements, and accessible reader refinements are welcome.

## Development setup

LiveView uses a pinned Nix development environment. From the repository root:

```bash
nix develop
just verify
```

The full gate formats and lints every Rust workspace, type-checks and tests the
web reader, audits dependencies, builds the embedded application, and checks
native dependency metadata. Use the narrower `just check`, `just test`, or
`just build` commands while iterating.

## Change guidelines

- Keep the reader and content model independent of any particular subject,
  organization, deployment, speech provider, or release channel.
- Put backend-neutral records and traits under `src/store/model.rs` and
  `src/store/content.rs`; concrete database details remain in their adapters.
- Register UI locales in `web/src/locales/registry.ts` rather than branching on
  language IDs throughout components.
- Add regression coverage for protocol, parser, cache, synchronization, and
  content-identity changes.
- Keep protocol additions backward compatible. Discuss incompatible changes
  before implementation and bump the protocol version deliberately.
- Preserve scrolling, transition, sheet, and playback responsiveness. The
  invariants in `docs/core-requirements.md` are part of the product contract.
- Do not commit credentials, private endpoints, generated output, or local
  operating instructions.
- Write source, comments, documentation, identifiers, and commit messages in
  English.

## Pull requests

Explain the user-visible outcome, important design decisions, and validation
performed. Keep unrelated changes out of the pull request. For a substantial
feature or protocol change, open an issue first so maintainers and contributors
can agree on ownership and compatibility boundaries.
