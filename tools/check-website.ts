import { readFile, stat } from "node:fs/promises";
import { renderAll } from "./website-art.ts";

const root = new URL("../website/", import.meta.url);
const repositoryRoot = new URL("../", import.meta.url);
const page = await readFile(new URL("index.html", root), "utf8");

function fail(message: string): never {
  console.error(`website check failed: ${message}`);
  process.exit(1);
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
    const info = await stat(new URL(path, root));
    if (!info.isFile()) fail(`${reference} is not a file`);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
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
  ]
) {
  const websiteBytes = await readFile(new URL(siteAsset, root));
  const canonicalBytes = await readFile(
    new URL(canonicalAsset, repositoryRoot),
  );
  if (
    websiteBytes.length !== canonicalBytes.length ||
    websiteBytes.some((byte, index) => byte !== canonicalBytes[index])
  ) {
    fail(`${siteAsset} has drifted from ${canonicalAsset}`);
  }
}

// The website and README use privacy-safe generated artwork, never product
// screenshots of a real library.
for (const match of page.matchAll(/(?:src|srcset)="([^"]+\.(?:png|jpe?g|webp|avif))"/g)) {
  if (match[1] !== "assets/apple-touch-icon.png") {
    fail(`raster image ${match[1]}: use generated artwork from tools/website-art.ts`);
  }
}
const art = renderAll();
for (const [name, content] of art) {
  const committed = await readFile(new URL(`assets/art/${name}`, root), "utf8").catch(() => "");
  if (committed !== content) fail(`assets/art/${name} drifted; run bun tools/website-art.ts`);
}
for (const theme of ["light", "dark"]) {
  for (const scene of ["hero", "mobile", "pipeline"]) {
    const name = `liveview-${scene}-${theme}.svg`;
    if (!page.includes(`assets/art/${name}`)) fail(`website does not show ${name}`);
  }
}
const readme = await readFile(new URL("README.md", repositoryRoot), "utf8");
const readmeZh = await readFile(new URL("README.zh-CN.md", repositoryRoot), "utf8");
for (const [label, text] of [["README.md", readme], ["README.zh-CN.md", readmeZh]] as const) {
  if (/docs\/assets\/screenshots\/|liveview-hero\.png/.test(text)) {
    fail(`${label} must use generated artwork instead of screenshots`);
  }
  for (const name of art.keys()) {
    if (!text.includes(`website/assets/art/${name}`)) fail(`${label} is missing ${name}`);
  }
}
if (!readme.includes('href="README.zh-CN.md"') || !readmeZh.includes('href="README.md"')) {
  fail("README language switch must link both editions");
}

for (const discoveryFile of ["robots.txt"]) {
  const text = await readFile(new URL(discoveryFile, root), "utf8");
  if (text.trim().length === 0) fail(`${discoveryFile} is empty`);
}

console.log(`website check passed (${ids.length} IDs)`);
