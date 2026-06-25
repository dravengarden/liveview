#!/usr/bin/env -S deno run -A
// mermaid-lint — validate every ```mermaid block by running the REAL mermaid
// parser, at the EXACT version the reader bundles. This is the only way to be
// 100% faithful ("checker == renderer"): a Rust/heuristic check can only guess at
// the grammar, so it passes diagrams the renderer then rejects with "Syntax error
// in text" (mermaid 11.12.3). mermaid.parse() validates syntax without rendering,
// and runs headlessly under jsdom.
//
// Version sync: the npm version is read FROM the vendored web/public/mermaid.min.js
// (`version:"X"`), so upgrading the reader's bundle automatically moves the
// checker too — they can never silently diverge.
//
// Usage:
//   deno run -A tools/mermaid-lint.ts <file.md> [more.md ...]   # human report, exit 1 on any error
//   deno run -A tools/mermaid-lint.ts --json  < stdin            # batch: stdin JSON [{id,text}] → [{id,error,line}]
//
// Output (human): one line per bad block: "<file>:<line>: <message>"; silent + exit 0 when all clean.

import { JSDOM } from "npm:jsdom@24";

// ── Resolve the reader's mermaid version from the vendored bundle ────────────
function vendoredVersion(): string {
  const here = new URL(".", import.meta.url).pathname;
  for (
    const p of [
      `${here}../web/public/mermaid.min.js`,
      `${here}../web/dist/mermaid.min.js`,
    ]
  ) {
    try {
      const head = Deno.readTextFileSync(p);
      const m = head.match(/version:"(\d+\.\d+\.\d+)"/);
      if (m) return m[1];
    } catch { /* try next */ }
  }
  return "11.12.3"; // fallback; keep in step with web/public/mermaid.min.js
}

// ── Boot a headless DOM + the real mermaid parser ───────────────────────────
const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
const ver = vendoredVersion();
// deno caches the npm graph after the first run; mermaid loads its diagram
// grammars lazily via dynamic import (works under deno).
const mermaid = (await import(`npm:mermaid@${ver}`)).default;
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

/** Validate one diagram. Returns null when valid, else the first error line. */
async function parseOne(text: string): Promise<string | null> {
  try {
    await mermaid.parse(text, { suppressErrors: false });
    return null;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    return msg.trim();
  }
}

/** Extract ```mermaid fenced blocks from markdown with their 1-based start line. */
function mermaidBlocks(md: string): { text: string; line: number }[] {
  const lines = md.split("\n");
  const out: { text: string; line: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*mermaid\b/);
    if (m) {
      const fence = m[2][0];
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      out.push({ text: body.join("\n"), line: start + 2 }); // +2: 1-based, first body line
    }
    i++;
  }
  return out;
}

// ── JSON batch mode (for the Rust checker to shell out to) ───────────────────
if (Deno.args.includes("--json")) {
  const input = JSON.parse(new TextDecoder().decode(await readAll(Deno.stdin))) as {
    id: string;
    text: string;
  }[];
  const results: { id: string; error: string }[] = [];
  for (const { id, text } of input) {
    const err = await parseOne(text);
    if (err) results.push({ id, error: err });
  }
  console.log(JSON.stringify({ version: ver, results }));
  Deno.exit(0);
}

// ── Human mode: lint the given markdown files ────────────────────────────────
let bad = 0;
for (const file of Deno.args.filter((a) => !a.startsWith("--"))) {
  let md: string;
  try {
    md = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  for (const blk of mermaidBlocks(md)) {
    const err = await parseOne(blk.text);
    if (err) {
      bad++;
      console.log(`${file}:${blk.line}: ${err}`);
    }
  }
}
if (bad === 0) console.error(`mermaid-lint: all clean (mermaid ${ver})`);
Deno.exit(bad > 0 ? 1 : 0);

async function readAll(r: Deno.Reader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  while (true) {
    const n = await r.read(buf);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
