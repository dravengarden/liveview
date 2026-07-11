#!/usr/bin/env -S deno run -A

// Stage the native OTA bundle under web/dist/app-bundle without duplicating
// bytes already present in the PWA build. The server falls back to the root
// dist path for omitted identical files; manifest-files.json preserves the
// complete native file list for OTA clients.

import { dirname, join, relative } from "node:path";

const root = new URL("../web/", import.meta.url).pathname;
const pwa = join(root, "dist");
const app = join(root, "dist-app");
const out = join(pwa, "app-bundle");

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile) found.push(relative(dir, path));
    }
  }
  await walk(dir);
  return found.sort();
}

async function identical(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      Deno.readFile(left),
      Deno.readFile(right),
    ]);
    if (a.length !== b.length) return false;
    return a.every((byte, index) => byte === b[index]);
  } catch {
    return false;
  }
}

await Deno.remove(out, { recursive: true }).catch(() => undefined);
const manifest = await files(app);
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
  await Deno.mkdir(dirname(destination), { recursive: true });
  await Deno.copyFile(source, destination);
  copied++;
}

await Deno.writeTextFile(
  join(out, "manifest-files.json"),
  JSON.stringify(manifest),
);
console.log(`stage-app-bundle: ${copied} copied, ${shared} shared with PWA`);
