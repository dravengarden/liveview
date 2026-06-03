# liveview

A book reader for the [columbus](https://github.com/dravengarden) monorepo's
bookshelf — Markdown books with multi-language editions and audiobook tracks,
served by an axum daemon with an embedded React/MUI SPA.

Content is **not** read from the filesystem at request time. A git-driven
incremental deploy (`liveview sync`) reconciles the book corpus into a
**postgres + rustfs** content store; the server is a thin reader over those.

## Architecture

```
  git (projects/books/*)         liveview sync            content store          liveview serve
  ──────────────────────         ─────────────            ─────────────          ──────────────
  book.toml + <lang>/*.md   ─▶   Merkle DAG diff    ─▶    postgres  (structure,  ─▶  /api/books
  audio/<lang>/*.spoken.md       render md → HTML         rendered HTML,            /api/tree
  cover.*, images, PDFs          edge-tts → mp3+marks     progress, deploy state)   /api/file (HTML)
                                 content-addressed   ─▶    rustfs  (images, PDFs,  ─▶  /api/raw|cover
                                 blobs → rustfs            covers, audio blobs)      /api/audio|marks
```

- **Incremental** — `sync` builds a Merkle DAG of the corpus and only re-applies
  subtrees whose content hash changed; an unchanged run is a near-instant no-op.
  Audiobook MP3 + sentence marks are pre-generated (edge-tts) and stored once.
- **Thin reader** — the server resolves a request against an in-memory catalog
  (loaded from postgres) and returns pre-rendered HTML from pg / streams binary
  blobs from rustfs. Overlay → base language fallback is preserved.
- **Live-ish reload** — after a `sync`, a postgres `NOTIFY` makes the server
  reload its catalog and push a sidebar refresh over the existing websocket.

## Commands

```bash
# Reconcile the book corpus into pg + rustfs (the deploy step).
liveview sync --config <config.toml>

# Serve (reads pg + rustfs; connection params from the env below).
liveview --config <config.toml> --host 0.0.0.0 --port 4160
```

The server and `sync` read their store connection from the environment (the
deployed systemd unit sets these):

| Env | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://liveview@host:5433/liveview` (required) |
| `LIVEVIEW_S3_ENDPOINT` | rustfs S3 endpoint (default `http://127.0.0.1:9001`) |
| `LIVEVIEW_S3_BUCKET` | blob bucket (default `liveview`) |
| `LIVEVIEW_S3_ACCESS_KEY[_FILE]` / `LIVEVIEW_S3_SECRET_KEY[_FILE]` | S3 credentials (direct, or a file path — the file wins) |
| `LIVEVIEW_TTS_VOICE` | default edge-tts voice for `sync` audio generation |

## Book corpus layout

A book is a directory with a `book.toml` manifest discovered under a `[[shelf]]`
root (see the config docstring in `src/config.rs`):

```
<book>/
  book.toml            # slug, title, langs, renditions (text/audio)
  cover.{jpg,png,webp} # optional shelf cover
  <lang>/*.md          # text-rendition chapters (default lang = base, others overlay)
  audio/<lang>/*.spoken.md   # audiobook scripts → edge-tts mp3 + marks at sync
  <lang>/assets/…      # images / PDFs referenced by chapters
```

## Supported chapter formats

| Format | Extensions |
|--------|------------|
| Markdown | `.md`, `.markdown` |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.avif`, `.bmp`, `.ico`, `.tiff` |
| PDF | `.pdf` |
| HTML | `.html`, `.htm` |
| Data | `.csv`, `.tsv`, `.json`, `.jsonc`, `.json5` |
| Drawings | `.excalidraw` |
| Typesetting | `.tex`, `.latex`, `.typ`, `.typst` |

## Development

```bash
make build-web    # build the SPA (deno + vite)
make build        # release binary with the embedded SPA
make check        # fmt-check + clippy + typecheck
```

Running the backend locally needs a reachable postgres + rustfs and the env
above; `liveview sync` then `liveview` against the same config. On hawk it runs
as the `liveview` + `liveview-sync` systemd units with service-private
`postgres-liveview` (:5433) and `rustfs-liveview` (:9001) instances.

## License

MIT
