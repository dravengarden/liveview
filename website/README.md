# LiveView website

The standalone product website is a dependency-free static site. It keeps the
marketing surface separate from the reader application while reusing LiveView's
canonical Living Book brand and current product screenshots. Its visual system
uses midnight indigo, layered ivory and lavender pages, and a gold-led trio of
live-state glints.

Production URL: https://dravengarden.github.io/liveview/

Preview it from the repository root:

```bash
nix shell nixpkgs#python3 -c python -m http.server 4321 -d website
```

Then open `http://localhost:4321`. Run `just website-check` after changing local
links, assets, headings, or metadata.
