# liveview Examples

This directory contains example markdown files for testing **liveview**.

## Quick Start

```bash
liveview ./examples --open
```

## Files

| File | Tests |
|------|-------|
| [README.md](README.md) | Basic formatting, tables, links |
| [code-and-syntax.md](code-and-syntax.md) | Syntax highlighting across languages |
| [mermaid-diagrams.md](mermaid-diagrams.md) | Mermaid diagram types |
| [gfm-features.md](gfm-features.md) | GitHub Flavored Markdown extensions |
| [subdir/nested.md](subdir/nested.md) | File tree nesting verification |

---

## Inline Formatting

Regular text with **bold**, *italic*, ~~strikethrough~~, `inline code`, and ***bold italic***.

Here's a [link](https://github.com), an ![Rust logo](https://www.rust-lang.org/logos/rust-logo-32x32.png), and a footnote[^1].

[^1]: This is a footnote rendered by comrak's GFM support.

> Blockquote with **formatted** text inside.
>
> > Nested blockquote.

---

*Generated for testing liveview — Markdown Live Renderer.*
