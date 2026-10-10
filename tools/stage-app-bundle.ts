#!/usr/bin/env bun

// Stage the native OTA bundle under web/dist/app-bundle without duplicating
// bytes already present in the PWA build. The server falls back to the root
// dist path for omitted identical files; manifest-files.json preserves the
// complete native file list for OTA clients.

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const root = new URL("../web/", import.meta.url).pathname;
const pwa = join(root, "dist");
const app = join(root, "dist-app");
const out = join(pwa, "app-bundle");

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(relative(dir, path));
    }
  }
  await walk(dir);
  return found.sort();
}

async function identical(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      readFile(left),
      readFile(right),
    ]);
    if (a.length !== b.length) return false;
    return a.every((byte, index) => byte === b[index]);
  } catch {
    return false;
  }
}

await rm(out, { recursive: true, force: true });
const appFiles = await files(app);
// KaTeX's stable public files ship in every native IPA and remain available
// through the embedded fallback when an OTA overlay does not contain them.
// Excluding that one immutable directory keeps the OTA transport flat so
// pre-0.1.21 hosts (which persisted URL-encoded slashes literally) can receive
// the bootstrap bundle. Any other nested output is a compatibility regression.
const manifest = appFiles.filter((rel) => !rel.startsWith("katex/"));
const nested = manifest.filter((rel) => rel.includes("/"));
if (nested.length > 0) {
  throw new Error(
    "stage-app-bundle: native OTA paths must stay flat for legacy host compatibility:\n" +
      nested.map((rel) => `  ${rel}`).join("\n"),
  );
}
// OTA hosts treat an existing overlay file as complete and never re-download
// it, so a script or stylesheet under a stable name would stay stale on every
// device after its first OTA. Code must ship content-hashed (`name-XXXXXXXX.js`;
// vendored public scripts are renamed by vite.config.ts hashedPublicScripts).
const contentHashed = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
const stableCode = manifest.filter((rel) =>
  /\.(?:js|mjs|css)$/.test(rel) && !contentHashed.test(rel)
);
if (stableCode.length > 0) {
  throw new Error(
    "stage-app-bundle: native OTA code must be content-hashed:\n" +
      stableCode.map((rel) => `  ${rel}`).join("\n"),
  );
}
let copied = 0;
let shared = 0;
for (const rel of manifest) {
  const source = join(app, rel);
  const sharedPath = join(pwa, rel);
  if (rel !== "index.html" && await identical(source, sharedPath)) {
    shared++;
    continue;
  }
  const destination = join(out, rel);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  copied++;
}

await writeFile(
  join(out, "manifest-files.json"),
  JSON.stringify(manifest),
);
console.log(`stage-app-bundle: ${copied} copied, ${shared} shared with PWA`);
