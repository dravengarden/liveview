# LiveView website

The standalone product website is a dependency-free static site, deployed as-is
to GitHub Pages. It keeps the marketing surface separate from the reader
application while reusing LiveView's canonical Living Book brand.

Production URL: https://dravengarden.github.io/liveview/

## Artwork

The website and both READMEs use abstract, privacy-safe artwork rather than
screenshots of a real library. `tools/website-art.ts` renders every scene (hero,
mobile, publication pipeline) in light and dark from the Living Book palette in
`docs/design-system.md` into `website/assets/art/`:

```bash
nix develop -c bun tools/website-art.ts          # regenerate
nix develop -c bun tools/website-art.ts --check  # fail on drift
```

Edit the generator, never the SVG output. `just website-check` rejects drift,
raster product images, and README editions that lose the shared artwork.

## Behavior

- System, light, and dark themes, plus English and Chinese copy, are chosen in
  the header preferences and remembered in `localStorage`. Chinese strings live
  in `app.js`; every translatable node carries a `data-i18n` key.
- Theme artwork switches through `<picture>` sources that follow the chosen
  theme, not only the operating system.
- The quick-start Copy button copies runnable commands only; prompts, comments,
  and sample output are marked `data-copy-exclude`.

## Preview

```bash
nix shell nixpkgs#python3 -c python -m http.server 4321 -d website
```

Then open `http://localhost:4321`. Run `just website-check` after changing local
links, assets, headings, metadata, or artwork.
