# GitHub Flavored Markdown Features

Testing comrak's GFM extensions.

## Task Lists

- [x] Project scaffolding
- [x] CLI argument parsing
- [x] File system watcher
- [x] Markdown rendering (comrak)
- [x] Web server (Dioxus + Axum)
- [x] WebSocket live updates
- [ ] Theme switching (dark/light)
- [ ] Search within files
- [ ] PDF export

## Tables

### Simple Table

| Command | Description |
|---------|-------------|
| `lv` | Watch current directory |
| `lv ./docs` | Watch specific directory |
| `lv -p 8080` | Custom port |
| `lv --open` | Auto-open browser |

### Alignment

| Left | Center | Right |
|:-----|:------:|------:|
| L1   | C1     |    R1 |
| L2   | C2     |    R2 |
| L3   | C3     |    R3 |

### Wide Table

| Feature | Status | Engine | Notes |
|---------|--------|--------|-------|
| GFM Tables | ✅ Supported | comrak | Full alignment support |
| Task Lists | ✅ Supported | comrak | Checkbox rendering |
| Strikethrough | ✅ Supported | comrak | ~~like this~~ |
| Autolinks | ✅ Supported | comrak | https://example.com |
| Footnotes | ✅ Supported | comrak | Extended GFM[^1] |
| Syntax Highlighting | ✅ Supported | highlight.js | 190+ languages |
| Mermaid Diagrams | ✅ Supported | mermaid.js | 10+ diagram types |
| Math (KaTeX) | ❌ Not yet | — | Future feature |

[^1]: Footnotes are a comrak extension beyond standard GFM.

## Strikethrough

This is ~~deleted text~~ and this is normal text.

You can combine: **~~bold strikethrough~~** and *~~italic strikethrough~~*.

## Autolinks

Plain URLs are auto-linked: https://github.com/anthropics

Email autolinks: user@example.com

Standard links: [Click here](https://example.com "Hover title")

## Footnotes

Here's a statement that needs a citation[^note1], and another one[^note2].

[^note1]: This is the first footnote with a longer explanation that spans
    multiple lines with proper indentation.

[^note2]: Second footnote.

## Headings with IDs

Each heading gets an auto-generated `id` attribute for deep linking.

### This Is A Test Heading {#custom-id}

Link to it: [jump to heading](#this-is-a-test-heading)

## Horizontal Rules

Three styles:

---

***

___

## HTML Entities & Escaping

- Em dash: —
- En dash: –
- Ellipsis: …
- Copyright: ©
- Arrows: ← → ↑ ↓
- Escaped: \*not italic\*, \`not code\`, \[not a link\]

## Description Lists

(comrak extension)

Term 1
: Definition for term 1

Term 2
: Definition A for term 2
: Definition B for term 2

## Multiline Blockquotes

> This is a blockquote that spans
> multiple lines. It can contain
> **formatted text** and even:
>
> ```
> code blocks
> ```
>
> And nested quotes:
> > Like this one.

## Images

![Rust Logo](https://www.rust-lang.org/logos/rust-logo-blk.svg)

## Line Breaks

First line with two trailing spaces
Second line (hard break).

First line
Second line (soft break, same paragraph).

## Emoji (Unicode)

🦀 Rust | 📝 Markdown | 🔄 Live Reload | 🌐 Web | 📂 Files
