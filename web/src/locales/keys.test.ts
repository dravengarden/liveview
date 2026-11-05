import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { en } from "./en.ts";
import { zh } from "./zh.ts";

// web/src, the tree whose `t("…")` calls these tables serve.
const SRC = new URL("../", import.meta.url);

/** Every production source file under web/src except the locale tables. */
async function sources(): Promise<string> {
  const out: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(
        entry.isDirectory() ? `${entry.name}/` : entry.name,
        dir,
      );
      if (entry.isDirectory()) {
        if (entry.name !== "locales") await walk(child);
      } else if (
        /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ) {
        out.push(await readFile(child, "utf8"));
      }
    }
  };
  await walk(SRC);
  return out.join("\n");
}

test("both locales define exactly the same keys", () => {
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  assert.deepEqual(
    enKeys.filter((k) => !(k in zh)),
    [],
    "keys missing from zh",
  );
  assert.deepEqual(
    zhKeys.filter((k) => !(k in en)),
    [],
    "keys missing from en",
  );
});

test("every literal t() key exists and every key has a caller", async () => {
  const code = await sources();
  const missing: string[] = [];
  for (const m of code.matchAll(/\bt\(\s*(["'])([a-zA-Z0-9_.]+)\1/g)) {
    const key = m[2] ?? "";
    if (!(key in en)) missing.push(key);
  }
  assert.deepEqual([...new Set(missing)], [], "t() keys with no translation");

  // A key is used when its literal appears anywhere (a direct `t("key")`, or
  // a lookup table of keys such as FILTER_KIND_LABEL), or when some prefix of
  // it is completed dynamically (`t(\`reading.${value}\`)`).
  const dynamicPrefixes = new Set(
    [...code.matchAll(/`([a-zA-Z0-9_.]+)\.\$\{/g)].map((m) => m[1] ?? ""),
  );
  const unused = Object.keys(en).filter((key) => {
    if (code.includes(`"${key}"`) || code.includes(`'${key}'`)) return false;
    const parts = key.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      if (dynamicPrefixes.has(parts.slice(0, i).join("."))) return false;
    }
    return true;
  });
  assert.deepEqual(unused, [], "locale keys nothing calls");
});
