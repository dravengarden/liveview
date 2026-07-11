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
//   deno run -A tools/mermaid-lint.ts <file-or-dir> [...]        # recursive human report
//   deno run -A tools/mermaid-lint.ts --json <file-or-dir> [...] # machine report for chart-review
//   deno run -A tools/mermaid-lint.ts --json < stdin             # batch [{id,text}] → failures
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
const dom = new JSDOM("<!DOCTYPE html><body></body>", {
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
});
const ver = vendoredVersion();
// deno caches the npm graph after the first run; mermaid loads its diagram
// grammars lazily via dynamic import (works under deno).
const mermaid = (await import(`npm:mermaid@${ver}`)).default;
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

/** Validate one diagram. Returns null when valid, else the first error line. */
async function parseOne(
  text: string,
): Promise<{ error: string | null; type: string | null }> {
  try {
    const parsed = await mermaid.parse(text, { suppressErrors: false });
    return { error: null, type: parsed?.diagramType ?? null };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    return { error: msg.trim(), type: null };
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
      while (
        i < lines.length && !new RegExp(`^\\s*${fence}{3,}\\s*$`).test(lines[i])
      ) {
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
const json = Deno.args.includes("--json");
const targets = Deno.args.filter((arg) => !arg.startsWith("--"));
if (json && targets.length === 0) {
  const input = JSON.parse(
    await new Response(Deno.stdin.readable).text(),
  ) as {
    id: string;
    text: string;
  }[];
  const results: { id: string; error: string }[] = [];
  for (const { id, text } of input) {
    const parsed = await parseOne(text);
    if (parsed.error) results.push({ id, error: parsed.error });
  }
  console.log(JSON.stringify({ version: ver, results }));
  Deno.exit(0);
}

// ── Path mode: recursively lint Markdown files ───────────────────────────────
if (targets.length === 0) {
  console.error("usage: mermaid-lint [--json] <file-or-dir> [...]");
  Deno.exit(2);
}

type PathResult = {
  file: string;
  startLine: number;
  type: string | null;
  ok: boolean;
  error?: string;
  blockLine?: number;
  snippet?: string;
};

const results: PathResult[] = [];
for (const file of await markdownFiles(targets)) {
  let md: string;
  try {
    md = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  for (const blk of mermaidBlocks(md)) {
    const parsed = await parseOne(blk.text);
    const lineMatch = parsed.error?.match(/line (\d+)/i);
    const blockLine = lineMatch ? Number(lineMatch[1]) : undefined;
    results.push({
      file,
      startLine: blk.line,
      type: parsed.type,
      ok: parsed.error === null,
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(blockLine
        ? {
          blockLine,
          snippet: blk.text.split("\n")[blockLine - 1]?.trim(),
        }
        : {}),
    });
  }
}
const failures = results.filter((result) => !result.ok);
if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const failure of failures) {
    console.log(`${failure.file}:${failure.startLine}: ${failure.error}`);
  }
  console.error(
    `mermaid-lint: ${
      results.length - failures.length
    }/${results.length} block(s) clean (mermaid ${ver})`,
  );
}
Deno.exit(failures.length > 0 ? 1 : 0);

async function markdownFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(input);
    } catch {
      continue;
    }
    if (stat.isFile && /\.(md|markdown)$/i.test(input)) {
      files.push(input);
    } else if (stat.isDirectory) {
      const tracked = await gitMarkdownFiles(input);
      if (tracked === null) await walkMarkdown(input, files);
      else files.push(...tracked);
    }
  }
  return files.sort();
}

/** Respect the repository's ignore contract when linting a worktree. This keeps
 *  regeneratable MinerU output, build trees, and other ignored corpora out of the
 *  same command CI runs, while still including both tracked files and untracked
 *  authoring work that is not ignored. Non-git directories fall back to walking. */
async function gitMarkdownFiles(dir: string): Promise<string[] | null> {
  try {
    const output = await new Deno.Command("git", {
      args: [
        "-C",
        dir,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "*.md",
        "*.markdown",
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return null;
    const base = dir.replace(/\/$/, "");
    return new TextDecoder().decode(output.stdout).split("\0")
      .filter(Boolean)
      .map((path) => `${base}/${path}`);
  } catch {
    return null;
  }
}

async function walkMarkdown(dir: string, files: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (
      entry.name.startsWith(".") ||
      ["node_modules", "target"].includes(entry.name)
    ) {
      continue;
    }
    const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
    if (entry.isDirectory) await walkMarkdown(path, files);
    else if (entry.isFile && /\.(md|markdown)$/i.test(entry.name)) {
      files.push(path);
    }
  }
}
