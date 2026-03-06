# lv - LiveView

A fast, live-reloading file previewer for your terminal. Watch Markdown, images, PDFs, and more with instant browser updates.

## Features

- **Live Reload** - Automatically refreshes when files change
- **File Browser** - Sidebar navigation for directories
- **Markdown** - Full GFM support with syntax highlighting, KaTeX math, and Mermaid diagrams
- **Multi-format** - Preview images, PDFs, HTML, CSV, JSON, Excalidraw, LaTeX, Typst

## Installation

### From Source

Requires [Rust](https://rustup.rs) and [Bun](https://bun.sh).

```bash
git clone https://github.com/user/markdown-live-renderer
cd markdown-live-renderer
make install
```

### Uninstall

```bash
make uninstall
```

## Usage

```bash
# Preview current directory
lv

# Preview a specific file
lv README.md

# Preview a directory
lv ./docs

# Open browser automatically
lv -o

# Custom port
lv -p 8080

# Include only specific patterns
lv -I "*.md" -I "*.txt"

# Exclude patterns
lv -E "**/drafts/**"
```

## Options

| Option | Description |
|--------|-------------|
| `path` | File or directory to watch (default: `.`) |
| `-p, --port <PORT>` | Port to serve on (default: auto from 4159) |
| `--host <HOST>` | Host address (default: `127.0.0.1`) |
| `-I, --include <PATTERN>` | File patterns to include (glob syntax) |
| `-E, --exclude <PATTERN>` | Patterns to exclude (added to defaults) |
| `-o, --open` | Open browser automatically |
| `--debounce-ms <MS>` | Debounce interval (default: 200) |
| `-v, --verbose` | Enable verbose logging |

## Supported Formats

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
# Start dev servers (frontend + backend)
make dev

# Frontend: http://localhost:5173
# Backend: http://localhost:4159

# Format code
make fmt

# Run checks
make check
```

## License

MIT
