# LiveView website

The standalone product website is a dependency-free static site. It keeps the
marketing surface separate from the reader application while reusing LiveView's
canonical brand and current product screenshots.

Production URL: https://dravengarden.github.io/liveview/

Preview it from the repository root:

```bash
nix shell nixpkgs#python3 -c python -m http.server 4321 -d website
```

Then open `http://localhost:4321`. Run `just website-check` after changing local
links, assets, headings, or metadata.
