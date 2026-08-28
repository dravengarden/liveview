# LiveView website

The standalone product website is a dependency-free static site. It keeps the
marketing surface separate from the reader application while reusing LiveView's
canonical Living Book brand and current product screenshots. Its visual system
uses warm paper, navy and plum page fields, and an amber live-state spark.

Production URL: https://dravengarden.github.io/liveview/

Preview it from the repository root:

```bash
nix shell nixpkgs#python3 -c python -m http.server 4321 -d website
```

Then open `http://localhost:4321`. Run `just website-check` after changing local
links, assets, headings, or metadata.
