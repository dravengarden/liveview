const root = new URL("../website/", import.meta.url);
const repositoryRoot = new URL("../", import.meta.url);
const page = await Deno.readTextFile(new URL("index.html", root));

function fail(message: string): never {
  console.error(`website check failed: ${message}`);
  Deno.exit(1);
}

for (
  const required of [
    '<meta name="description"',
    '<meta property="og:title"',
    '<meta name="twitter:card"',
    '<main id="main-content">',
    'class="skip-link"',
  ]
) {
  if (!page.includes(required)) fail(`missing ${required}`);
}

const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length > 0) {
  fail(`duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`);
}

for (const match of page.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const reference = match[1];
  if (/^(?:https?:|#|mailto:)/.test(reference)) continue;
  const [path] = reference.split("#", 1);
  try {
    const info = await Deno.stat(new URL(path, root));
    if (!info.isFile) fail(`${reference} is not a file`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      fail(`missing local asset ${reference}`);
    }
    throw error;
  }
}

for (const match of page.matchAll(/href="#([^"]+)"/g)) {
  if (!ids.includes(match[1])) fail(`missing anchor target #${match[1]}`);
}

for (
  const [siteAsset, canonicalAsset] of [
    ["assets/brand-mark.svg", "web/public/brand-mark.svg"],
    ["assets/apple-touch-icon.png", "web/public/apple-touch-icon.png"],
    [
      "assets/desktop-library.webp",
      "docs/assets/screenshots/desktop-library.webp",
    ],
    [
      "assets/iphone-library.webp",
      "docs/assets/screenshots/iphone-library.webp",
    ],
    [
      "assets/iphone-interactive.webp",
      "docs/assets/screenshots/iphone-interactive.webp",
    ],
    ["assets/iphone-audio.webp", "docs/assets/screenshots/iphone-audio.webp"],
    ["assets/liveview-hero.png", "docs/assets/liveview-hero.png"],
  ]
) {
  const websiteBytes = await Deno.readFile(new URL(siteAsset, root));
  const canonicalBytes = await Deno.readFile(
    new URL(canonicalAsset, repositoryRoot),
  );
  if (
    websiteBytes.length !== canonicalBytes.length ||
    websiteBytes.some((byte, index) => byte !== canonicalBytes[index])
  ) {
    fail(`${siteAsset} has drifted from ${canonicalAsset}`);
  }
}

for (const discoveryFile of ["robots.txt"]) {
  const text = await Deno.readTextFile(new URL(discoveryFile, root));
  if (text.trim().length === 0) fail(`${discoveryFile} is empty`);
}

console.log(`website check passed (${ids.length} IDs)`);
