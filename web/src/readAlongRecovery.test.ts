import assert from "node:assert/strict";
import { test } from "node:test";
import { domGeneration, locatedMapStale, readAlongKey, resourceFor } from "./hooks/readAlongCache.ts";

const np = { chapterPath: "book/01.md", lang: "en", voice: "v1", marksHash: "m1" };

test("read-along resources are bound to the playing chapter rendition", () => {
  const key = readAlongKey(np, true);
  assert.equal(readAlongKey(np, false), "");
  assert.equal(readAlongKey(null, true), "");
  assert.notEqual(readAlongKey({ ...np, voice: "v2" }, true), key);
  assert.notEqual(readAlongKey({ ...np, marksHash: "m2" }, true), key);
  const fetched = { key, value: ["units of 01"] };
  assert.deepEqual(resourceFor(fetched, key, []), ["units of 01"]);
  // The engine moved to the next chapter before its resources arrived.
  assert.deepEqual(resourceFor(fetched, readAlongKey({ ...np, chapterPath: "book/02.md" }, true), []), []);
});

test("the located map is rebuilt for new units, detached nodes, and a new DOM generation", () => {
  const units = ["u"];
  const a = {}, b = {}, c = {};
  const body = { firstChild: a, lastChild: b };
  const built = domGeneration(body);
  assert.equal(locatedMapStale(units, units, false, built, body), false);
  assert.equal(locatedMapStale(null, units, false, built, body), true);
  assert.equal(locatedMapStale(["other"], units, false, built, body), true);
  assert.equal(locatedMapStale(units, units, true, built, body), true);
  assert.equal(locatedMapStale(units, units, false, null, body), true);
  // The chapter HTML committed after its units: same body, new children.
  body.lastChild = c;
  assert.equal(locatedMapStale(units, units, false, built, body), true);
  assert.equal(locatedMapStale(units, units, false, built, { firstChild: a, lastChild: b }), true);
});
