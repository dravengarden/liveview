<p align="center">
  <img src="web/public/brand-mark.svg" alt="LiveView Living Book mark" width="104">
</p>

<p align="center">
  <img src="docs/assets/liveview-hero.png" alt="LiveView — a self-hosted reader for Markdown books and technical documents" width="100%">
</p>

<h1 align="center">LiveView</h1>

<p align="center">
  <strong>Publish technical books that are as good to listen to and use offline as they are to read.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Rust-1.95-dea584.svg" alt="Rust 1.95">
  <img src="https://img.shields.io/badge/Deno-2.x-70ffaf.svg" alt="Deno 2.x">
  <img src="https://img.shields.io/badge/Web%20%2B%20Tauri-24c8db.svg" alt="Web and Tauri">
</p>

<p align="center">
  <a href="https://dravengarden.github.io/liveview/">Official website</a> ·
  <a href="#product-tour">Screenshots</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#create-a-library">Authoring</a> ·
  <a href="docs/INDEX.md">Documentation</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

LiveView turns a directory of Markdown, technical assets, translations, and
audio into a polished self-hosted library. The same rendering contract powers
local preview, publication checks, the responsive web reader, and the native
offline client.

Its Living Book identity pairs two open pages with a single spark: one durable
publication, ready to be read, heard, and explored in more than one form.

Explore the reading, listening, technical-format, and offline experience on the
[official LiveView website](https://dravengarden.github.io/liveview/).

Start locally with no database or object store. Add PostgreSQL, S3-compatible
storage, incremental Merkle synchronization, and the Tauri shell only when the
library needs durable publishing, verified offline access, and native background
audio.

## Product tour

### Desktop library

<p align="center">
  <img src="docs/assets/screenshots/desktop-library.webp" alt="LiveView desktop library showing searchable collections, multilingual editions, and reading and listening progress" width="100%">
</p>

<p align="center"><sub>A dense, searchable bookshelf with collections, language editions, artwork, and independent reading and listening progress.</sub></p>

### Mobile, without simplifying the content

<table>
  <tr>
    <td width="33.33%" align="center">
      <img src="docs/assets/screenshots/iphone-library.webp" alt="LiveView mobile bookshelf with book artwork, collections, languages, and progress" width="100%"><br>
      <strong>Library</strong><br>
      <sub>Touch-first discovery, filters, editions, and progress.</sub>
    </td>
    <td width="33.33%" align="center">
      <img src="docs/assets/screenshots/iphone-interactive.webp" alt="LiveView mobile reader rendering interactive controls, metrics, and a responsive technical chart" width="100%"><br>
      <strong>Interactive technical content</strong><br>
      <sub>Signals, controls, computed metrics, and responsive charts.</sub>
    </td>
    <td width="33.33%" align="center">
      <img src="docs/assets/screenshots/iphone-audio.webp" alt="LiveView mobile reader playing an audiobook with sentence-level highlighting and playback controls" width="100%"><br>
      <strong>Synchronized audio</strong><br>
      <sub>Native playback, sentence highlighting, seeking, speed, and chapter controls.</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Captured from the current light-theme desktop build and native iPhone Simulator app.</sub></p>

> [!NOTE]
> LiveView is pre-1.0 and developed from the default branch. The content model
> is usable today, while CLI and protocol details may still evolve. Security
> fixes target the latest revision rather than multiple maintained release
> lines.

## Why LiveView

Most Markdown tools stop at rendering a document. LiveView treats the whole
library as a publication:

- **One content contract** — preview, checking, publication, and reading use the
  same parsing rules.
- **Books, not file listings** — covers, chapter spines, collections, reading
  progress, and continue-reading state are first-class.
- **Multilingual by construction** — editions share identity and position while
  allowing deliberate fallback to a default language.
- **Reading and listening are peers** — text, audiobook renditions, sentence
  timing, and narration for non-prose resources live in one content model.
- **Technical formats remain native** — Mermaid, math, SVG, Typst, Excalidraw,
  JSON, CSV, HTML, images, PDFs, and interactive views keep their semantics.
- **Offline data is verifiable** — covers, backdrops, text, documents, and audio
  are content-addressed Merkle DAG resources rather than a URL-keyed side cache.
- **Publishing is incremental** — synchronization reconciles changed content
  instead of rebuilding the entire corpus.
- **Infrastructure stays yours** — source, database, object storage, and
  delivery remain self-hosted.

The non-negotiable interaction, offline, lifecycle, and portability guarantees
are documented in [the core requirements](docs/core-requirements.md).

## Start here

| Goal | Start with | Infrastructure |
|---|---|---|
| Preview a folder locally | [`liveview preview`](#quick-start) | None |
| Author a book or bookshelf | [Create a library](#create-a-library) | Files and `book.toml` |
| Catch publication failures | [Validate content](#validate-content) | None |
| Host a durable reader | [Persistent deployment](#persistent-deployment) | PostgreSQL and S3-compatible storage |
| Contribute to LiveView | [Development](#development) | Nix, Git, and the pinned toolchain |

## Quick start

### Prerequisites

- x86_64 Linux with [Nix](https://nixos.org/) and flakes enabled
- Git

Clone the repository and build the reproducible package:

```bash
git clone https://github.com/dravengarden/liveview.git
cd liveview
nix build
```

Preview the repository itself:

```bash
./result/bin/liveview preview --open
```

Or preview any directory without PostgreSQL or object storage:

```bash
cd /path/to/your/library
/path/to/liveview/result/bin/liveview preview --open
```

LiveView prints the selected local URL and opens it when `--open` is present.
It discovers `liveview.toml`, `liveview.yaml`, or `liveview.json` in the current
directory. Without a config file, preview mode exposes that directory as one
library.

For an editable development build, use the pinned shell:

```bash
nix develop -c just build
./target/release/liveview preview --open
```

## Create a library

For a small documentation set, an explicit book entry is enough:

```toml
# liveview.toml
[server]
host = "127.0.0.1"
port = 4160

[[book]]
label = "Project Handbook"
description = "Guides, decisions, and operating notes."
source = "docs"

[book.layout]
order = ["README.md", "getting-started/", "reference/"]
```

For a bookshelf, point LiveView at a directory whose immediate children contain `book.toml` manifests:

```toml
# liveview.toml
[[shelf]]
path = "library"
```

```text
library/
├── distributed-systems/
│   ├── book.toml
│   ├── cover.webp
│   ├── backdrop.webp
│   ├── en/
│   │   ├── 01-introduction.md
│   │   └── 02-replication.md
│   ├── zh/
│   │   ├── 01-introduction.md
│   │   └── 02-replication.md
│   └── audio/
│       └── en/
│           ├── 01-introduction.spoken.md
│           └── 02-replication.spoken.md
└── practical-rust/
    ├── book.toml
    └── en/
        └── 01-getting-started.md
```

An example multilingual manifest:

```toml
# library/distributed-systems/book.toml
slug = "distributed-systems"
title = "Distributed Systems"
default_lang = "en"
default_rendition = "text"
cover = "cover.webp"
backdrop = "backdrop.webp"
tags = ["subject.distributed-systems", "format.guide", "replication"]

[langs.en]
label = "English"

[langs.zh]
label = "简体中文"

[renditions.text]
label = "Read"
langs = ["en", "zh"]

[renditions.audio]
label = "Listen"
langs = ["en"]
voice = "en-US-AriaNeural"
```

Tags are optional, author-owned search keywords. LiveView derives filters from
the current catalog instead of shipping a subject taxonomy: `facet.value`
creates a named facet (for example, `format.guide`), while an unnamespaced value
such as `replication` appears under the generic Tags facet. Collections group
books independently and never imply tags or priority.

## Validate content

LiveView validates content using renderer-compatible parsers. This catches
failures before readers do.

```bash
# Check one book or a whole library.
liveview check ./library

# Treat warnings as failures.
liveview check ./library --deny-warnings

# Create a baseline for existing warnings.
liveview gate ./library --write-baseline

# Reject renderer errors and warning regressions.
liveview gate ./library
```

The checker covers Markdown references and assets, KaTeX math, Mermaid syntax,
inline SVG, Typst, JSON, Excalidraw, and read-aloud resource coverage.

## Persistent deployment

Use persistent mode when the library should be served independently from its
source checkout.

```mermaid
sequenceDiagram
    participant Author as Author
    participant CLI as LiveView CLI
    participant DB as PostgreSQL
    participant S3 as S3-compatible storage
    participant Server as LiveView server
    participant Reader as Reader client

    Author->>CLI: Edit books and assets
    CLI->>CLI: Check, render, and diff the Merkle DAG
    CLI->>DB: Reconcile catalog and rendered content
    CLI->>S3: Upload changed binary assets and audio
    CLI-->>Server: Notify catalog reload
    Reader->>Server: Request shelf, chapter, or media
    Server->>DB: Read metadata and rendered content
    Server->>S3: Stream binary objects
    Server-->>Reader: Serve the web, PWA, or native client
```

Set the storage connection details, sync the library, then start the server:

```bash
export DATABASE_URL='postgres://liveview:password@127.0.0.1:5432/liveview'
export LIVEVIEW_S3_ENDPOINT='http://127.0.0.1:9000'
export LIVEVIEW_S3_BUCKET='liveview'
export LIVEVIEW_S3_ACCESS_KEY='...'
export LIVEVIEW_S3_SECRET_KEY='...'

liveview sync --config liveview.toml
liveview --config liveview.toml --host 0.0.0.0 --port 4160
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL |
| `LIVEVIEW_S3_ENDPOINT` | S3-compatible API endpoint |
| `LIVEVIEW_S3_BUCKET` | Object bucket name; defaults to `liveview` |
| `LIVEVIEW_S3_ACCESS_KEY[_FILE]` | Access key or path to a file containing it |
| `LIVEVIEW_S3_SECRET_KEY[_FILE]` | Secret key or path to a file containing it |
| `LIVEVIEW_EDGE_TTS_CMD` | Optional Edge TTS adapter command; unset disables network speech synthesis |
| `LIVEVIEW_TTS_VOICE` | Optional fallback voice when a book rendition does not declare one |
| `LIVEVIEW_BOOK_END_PHRASES` | Optional JSON map of language tags to spoken end cues, for example `{"en":"The end."}` |
| `LIVEVIEW_APM_VL_URL` | Optional VictoriaLogs-compatible APM ingest URL |
| `LIVEVIEW_APM_TOKEN[_FILE]` | Bearer token or token file for the optional APM sink |
| `LIVEVIEW_APM_ALLOW_UNAUTHENTICATED` | Explicitly permit a configured APM sink without a token; defaults to false |
| `LIVEVIEW_ALLOWED_ORIGINS` | Extra comma-separated exact CORS origins. `lvsync://localhost` and `tauri://localhost` are always allowed so the native WKWebView can `fetch` `/api`. Wildcard `*` is rejected |
| `LIVEVIEW_ACCESS_TOKEN[_FILE]` | Optional bearer token expected on every API and WebSocket request |

The default Nix package has no speech provider. `.#liveview-with-edge-tts`
adds the reference adapter; synthesis still remains disabled until
`LIVEVIEW_EDGE_TTS_CMD=edge-tts` is set. Browser APM collection is separately
opted in at build time with `VITE_APM_ENABLED=true`.

Native release prompts are deployment-owned. Set both
`VITE_NATIVE_RELEASE_APP_ID` and `VITE_NATIVE_RELEASE_MANIFEST_URL` while
building the web application to enable one; otherwise no release channel or
endpoint appears in the reader.

> [!IMPORTANT]
> LiveView does not provide user accounts or multi-user authorization. For an
> internet-facing deployment, place it behind a trusted reverse proxy or
> identity-aware access layer, terminate TLS there, and restrict access to the
> storage services. As defense in depth, the proxy can inject
> `Authorization: Bearer …` upstream while LiveView verifies the matching
> `LIVEVIEW_ACCESS_TOKEN`. This proxy-injected mode also covers media and
> WebSocket requests that browser APIs cannot decorate directly.

The native WKWebView origin (`lvsync://localhost`, plus `tauri://localhost` for
older shells) is always on the CORS allow-list. A separately hosted reader
must still enumerate each extra exact origin in `LIVEVIEW_ALLOWED_ORIGINS`;
wildcard CORS is deliberately rejected. For example:

```bash
export LIVEVIEW_ALLOWED_ORIGINS='https://reader.example.org'
```

## Architecture

```mermaid
flowchart LR
    subgraph Source[Authored library]
        M[Markdown chapters]
        A[Images, PDFs, and data]
        T[Translations and audio scripts]
        B[book.toml manifests]
    end

    subgraph Tooling[LiveView CLI]
        P[preview]
        C[check and gate]
        S[sync and Merkle diff]
    end

    subgraph Storage[Persistent deployment]
        PG[(PostgreSQL<br/>catalog, rendered content, progress)]
        OBJ[(S3-compatible storage<br/>assets and audio)]
    end

    subgraph Delivery[Reader]
        API[Axum server]
        WEB[Web and PWA]
        NATIVE[Tauri native shell]
    end

    M --> P
    A --> P
    T --> P
    B --> P
    P --> C
    C --> S
    S --> PG
    S --> OBJ
    PG --> API
    OBJ --> API
    API --> WEB
    API --> NATIVE
```

Local preview follows the short path: source files → renderer → browser. A
persistent deployment adds validation, incremental sync, durable storage, and
offline-capable clients.

| Mode | Content source | Reader | External services |
|---|---|---|---|
| Local preview | Filesystem | Web | None |
| Persistent server | PostgreSQL and object storage | Web/PWA | PostgreSQL and S3-compatible storage |
| Native shell | Persistent server plus verified local cache | Tauri/WKWebView | Persistent server; Xcode for native builds |

## CLI overview

| Command | Purpose |
|---|---|
| `liveview preview` | Serve a local library directly from the filesystem |
| `liveview check` | Validate renderability and content structure |
| `liveview gate` | Enforce a baseline-aware publication policy |
| `liveview sync` | Incrementally reconcile source content into persistent storage |
| `liveview audio-optimize` | Promote legacy MP3 chapter audio to canonical content-addressed audio |
| `liveview targets` | List Mermaid and SVG render targets for visual review |
| `liveview tasks` | Inspect or retry asynchronous audio-generation work |
| `liveview narrate-audit` | Audit how prose and non-prose resources will be spoken |
| `liveview narrate-plan` | Emit missing narration work as structured JSON |

Run `liveview <command> --help` for the complete option reference.

## Supported formats

| Content | Extensions and syntax |
|---|---|
| Markdown | `.md`, `.markdown`, GitHub-flavored Markdown, footnotes |
| Images | PNG, JPEG, GIF, SVG, WebP, AVIF, BMP, ICO, TIFF |
| Documents | PDF, HTML |
| Data | CSV, TSV, JSON, JSONC, JSON5 |
| Diagrams | Mermaid, inline SVG, Excalidraw |
| Math and typesetting | KaTeX-compatible math, LaTeX, Typst |
| Interactive views | `*.interactive-view.json` |
| Audio | Spoken Markdown scripts, generated audio, sentence timing marks |

## Documentation

The [documentation index](docs/INDEX.md) is the canonical map for stable
contracts, design documents, and historical plans. Recommended entry points:

- [Core requirements](docs/core-requirements.md) — product invariants and
  performance acceptance gates.
- [Design system](docs/design-system.md) — brand, responsive layout, materials,
  motion, and accessibility rules.
- [Incremental offline pipeline](docs/design/incremental-offline-pipeline.md) —
  content identity, synchronization, retention, and recovery.
- [Interactive view authoring](docs/design/interactive-view-authoring.md) —
  schema and authoring guidance for executable technical content.
- [Read-aloud narration](docs/design/read-aloud-narration.md) — narration
  identity and handling of diagrams, tables, formulas, and code.

## Development

Use the repository's pinned development environment; host tool versions are not
part of the supported build:

```bash
nix develop -c just verify
```

For faster iteration:

```bash
just dev          # Start the frontend and backend development servers
just build        # Build the embedded release binary
just check        # Formatting, Clippy, and TypeScript checks
just test         # Rust and web test suites
just dependencies # Vulnerability, license, and dependency hygiene checks
just verify       # Full local verification gate
```

Run these commands inside `nix develop` (or prefix a one-shot invocation with
`nix develop -c`). Native simulator and device validation additionally require
Xcode on macOS.

The main components are:

```text
src/                 Rust CLI, server, renderer, checker, and sync pipeline
web/                 React and TypeScript reader (IDB replica)
app/                 Tauri application shell (thin lvsync:// host)
tools/               Deterministic content tooling
```

## Contributing

Issues, focused pull requests, documentation improvements, and reproducible bug
reports are welcome. A useful bug report includes `liveview --version`, the
platform, a minimal content/configuration example, expected and actual behavior,
and relevant logs with credentials removed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review contract.
For a substantial feature or protocol change, [open an issue](https://github.com/dravengarden/liveview/issues/new)
first so ownership and compatibility can be discussed before implementation.
Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), never in a public issue.

Before submitting a change:

```bash
nix develop -c just verify
```

## License

LiveView is available under the [MIT License](LICENSE).
