import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const hookUrl = new URL("./hooks/useInPlaceHighlight.ts", import.meta.url);

test("read-along cache is bound to both chapter resources and DOM generation", async () => {
  const source = await readFile(hookUrl, "utf8");

  assert.match(source, /resources\.key === readAlongKey/);
  assert.match(source, /dom\.first !== body\.firstChild/);
  assert.match(source, /dom\.last !== body\.lastChild/);
  assert.match(source, /locatedForRef\.current = null/);
});
