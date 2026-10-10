#!/usr/bin/env bun
// mermaid-lint — validate every ```mermaid block by running the REAL mermaid
// parser, at the EXACT version the reader bundles. This is the only way to be
// 100% faithful ("checker == renderer"): a Rust/heuristic check can only guess at
// the grammar, so it passes diagrams the renderer then rejects with "Syntax error
// in text" (mermaid 11.12.3). mermaid.parse() validates syntax without rendering,
// and runs headlessly under jsdom.
//
// Version sync: tools/package.json pins the npm release, and this tool refuses
// to run unless that release equals the one read FROM the vendored
// web/public/mermaid.min.js (`version:"X"`) — upgrading the reader's bundle
// without the checker fails loudly, so they can never silently diverge.
//
// Usage:
//   bun tools/mermaid-lint.ts <file-or-dir> [...]        # recursive human report
//   bun tools/mermaid-lint.ts --json <file-or-dir> [...] # machine report for chart-review
//   bun tools/mermaid-lint.ts --json < stdin             # batch [{id,text}] → failures
//
// Output (human): one line per bad block: "<file>:<line>: <message>"; silent + exit 0 when all clean.

import { existsSync, readFileSync, type Stats } from "node:fs";
import { readdir, readFile, stat as statPath } from "node:fs/promises";

// ── Dependencies ────────────────────────────────────────────────────────────
// tools/package.json + tools/bun.lock pin jsdom and mermaid. Install them on
// first use so the tool stays a single command; stdout stays clean for --json.
// The resolver has already recorded the missing directory for this process,
// so the freshly installed tree is used by running the tool again.
const toolsDir = import.meta.dir;
const mermaidManifest = `${toolsDir}/node_modules/mermaid/package.json`;
if (!existsSync(mermaidManifest)) {
  const install = Bun.spawnSync({
    cmd: [process.execPath, "install", "--frozen-lockfile"],
    cwd: toolsDir,
    stdout: "ignore",
    stderr: "inherit",
  });
  if (!install.success) process.exit(2);
  const rerun = Bun.spawnSync({
    cmd: [process.execPath, ...process.argv.slice(1)],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(rerun.exitCode ?? 2);
}
const { JSDOM } = await import("jsdom");

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
      const head = readFileSync(p, "utf8");
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
const pinned = (JSON.parse(readFileSync(mermaidManifest, "utf8")) as {
  version: string;
}).version;
if (pinned !== ver) {
  console.error(
    `mermaid-lint: tools/package.json installs mermaid ${pinned} but the reader bundles ${ver}; pin ${ver} in tools/package.json and refresh tools/bun.lock`,
  );
  process.exit(2);
}
// mermaid loads its diagram grammars lazily via dynamic import.
const mermaid = (await import("mermaid")).default;
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
const args = process.argv.slice(2);
const json = args.includes("--json");
const targets = args.filter((arg) => !arg.startsWith("--"));
if (json && targets.length === 0) {
  const input = JSON.parse(
    await Bun.stdin.text(),
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
  process.exit(0);
}

// ── Path mode: recursively lint Markdown files ───────────────────────────────
if (targets.length === 0) {
  console.error("usage: mermaid-lint [--json] <file-or-dir> [...]");
  process.exit(2);
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
    md = await readFile(file, "utf8");
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
process.exit(failures.length > 0 ? 1 : 0);

async function markdownFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    let stat: Stats;
    try {
      stat = await statPath(input);
    } catch {
      continue;
    }
    if (stat.isFile() && /\.(md|markdown)$/i.test(input)) {
      files.push(input);
    } else if (stat.isDirectory()) {
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
    const output = Bun.spawnSync({
      cmd: [
        "git",
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
      stdout: "pipe",
      stderr: "ignore",
    });
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
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      ["node_modules", "target"].includes(entry.name)
    ) {
      continue;
    }
    const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
    if (entry.isDirectory()) await walkMarkdown(path, files);
    else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      files.push(path);
    }
  }
}
