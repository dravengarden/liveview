#!/usr/bin/env -S deno run -A

import { extname, join } from "node:path";

const web = new URL("../web/", import.meta.url).pathname;
const mib = 1024 * 1024;

type Totals = { total: number; javascript: number; fonts: number };

async function measure(dir: string, skip?: string): Promise<Totals> {
  const totals: Totals = { total: 0, javascript: 0, fonts: 0 };
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      if (entry.isDirectory && entry.name === skip) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      const bytes = (await Deno.stat(path)).size;
      totals.total += bytes;
      const extension = extname(entry.name);
      if (extension === ".js") totals.javascript += bytes;
      if ([".woff", ".woff2", ".ttf", ".otf"].includes(extension)) {
        totals.fonts += bytes;
      }
    }
  }
  await walk(dir);
  return totals;
}

const budgets: Totals = {
  total: 14 * mib,
  javascript: 6 * mib,
  fonts: 7 * mib,
};
const targets = [
  ["pwa", await measure(join(web, "dist"), "app-bundle")],
  ["native", await measure(join(web, "dist-app"))],
] as const;

let failed = false;
for (const [name, totals] of targets) {
  console.log(
    `${name}: total=${(totals.total / mib).toFixed(2)} MiB ` +
      `js=${(totals.javascript / mib).toFixed(2)} MiB ` +
      `fonts=${(totals.fonts / mib).toFixed(2)} MiB`,
  );
  for (const key of Object.keys(budgets) as (keyof Totals)[]) {
    if (totals[key] > budgets[key]) {
      console.error(
        `${name} ${key} exceeds budget: ` +
          `${(totals[key] / mib).toFixed(2)} MiB > ` +
          `${(budgets[key] / mib).toFixed(2)} MiB`,
      );
      failed = true;
    }
  }
}

if (failed) Deno.exit(1);
