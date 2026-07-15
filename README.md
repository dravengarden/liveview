<p align="center">
  <img src="docs/assets/liveview-hero.png" alt="LiveView — a self-hosted reader for Markdown books and technical documents" width="100%">
</p>

<h1 align="center">LiveView</h1>

<p align="center">
  A self-hosted reader for Markdown books, multilingual editions, rich technical content, and audiobooks.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/backend-Rust-dea584.svg" alt="Rust backend">
  <img src="https://img.shields.io/badge/frontend-React%20%2B%20TypeScript-61dafb.svg" alt="React and TypeScript frontend">
  <img src="https://img.shields.io/badge/platform-Web%20%2B%20Tauri-24c8db.svg" alt="Web and Tauri">
</p>

LiveView turns a directory of authored content into a polished reading experience. It supports local preview with no external services, and scales to a persistent deployment backed by PostgreSQL and S3-compatible object storage.

> [!NOTE]
> LiveView is currently pre-1.0. The content format is usable today, but command-line and protocol details may still evolve.

LiveView's non-negotiable product invariants—including interaction performance,
offline verification, and native lifecycle behavior—are defined in
[the core requirements](docs/core-requirements.md).

## Why LiveView?

Most Markdown tools stop at rendering a single document. LiveView treats a collection as a real publication:

- **Books and libraries** — curated covers, chapter spines, collections, reading progress, and “continue reading.”
- **Multilingual editions** — switch languages without losing your place; missing overlay pages can fall back to the default edition.
- **Read or listen** — text read-aloud and dedicated audiobook renditions with sentence-level timing.
- **Technical content** — Markdown, Mermaid, math, SVG, Typst, Excalidraw, JSON, CSV, HTML, images, and PDFs.
- **Offline-first clients** — a PWA for the web and an optional Tauri shell with a content-addressed native cache.
- **Incremental publishing** — a Merkle DAG detects changed content so syncs only reconcile what changed.
- **Renderer-aware validation** — check content with the same parsing rules used by the reader, then enforce a baseline-aware publication gate.
- **Self-hosted by design** — own the source, database, objects, and delivery path.

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

Local preview follows the short path: source files → renderer → browser. A persistent deployment adds validation, incremental sync, durable storage, and offline-capable clients.

## Quick start

### Prerequisites

- x86_64 Linux with [Nix](https://nixos.org/) and flakes enabled
- Git

Clone the repository and build the embedded reader:

```bash
git clone https://github.com/dravengarden/liveview.git
cd liveview
nix develop
make build
```

Preview the repository itself:

```bash
./target/release/liveview preview --open
```

Or preview any directory without PostgreSQL or object storage:

```bash
cd /path/to/your/library
/path/to/liveview/target/release/liveview preview --open
```

LiveView discovers `liveview.toml`, `liveview.yaml`, or `liveview.json` in the current directory. Without a config file, preview mode exposes the current directory as a single library.

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

## Validate content

LiveView validates content using renderer-compatible parsers. This catches failures before readers do.

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

The checker covers Markdown references and assets, KaTeX math, Mermaid syntax, inline SVG, Typst, JSON, Excalidraw, and read-aloud resource coverage.

## Persistent deployment

Use persistent mode when the library should be served independently from its source checkout.

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
| `LIVEVIEW_TTS_VOICE` | Default `edge-tts` voice for generated audio |

> [!IMPORTANT]
> LiveView does not currently provide multi-user authentication. For an internet-facing deployment, place it behind a trusted reverse proxy or identity-aware access layer, terminate TLS there, and restrict access to the storage services.

## CLI overview

| Command | Purpose |
|---|---|
| `liveview preview` | Serve a local library directly from the filesystem |
| `liveview check` | Validate renderability and content structure |
| `liveview gate` | Enforce a baseline-aware publication policy |
| `liveview sync` | Incrementally reconcile source content into persistent storage |
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

## Development

Enter the pinned development environment before running project commands:

```bash
nix develop
```

Common commands:

```bash
make dev          # Start the frontend and backend development servers
make build        # Build the embedded release binary
make check        # Formatting, Clippy, and TypeScript checks
make test         # Rust test suites
make verify       # Full local verification gate
```

The main components are:

```text
src/                 Rust CLI, server, renderer, checker, and sync pipeline
web/                 React and TypeScript reader
lv-sync/             Platform-neutral offline synchronization core
plugins/lvsync/      Tauri plugin for native storage and transport
app/                 Tauri application shell
tools/               Deterministic content tooling
```

## Contributing

Issues, focused pull requests, documentation improvements, and reproducible bug reports are welcome.

Before submitting a change:

```bash
nix develop -c make verify
```

For a substantial feature or protocol change, open an issue first so the design and compatibility impact can be discussed before implementation.

## License

LiveView is available under the [MIT License](LICENSE).
