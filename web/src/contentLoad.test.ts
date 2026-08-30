import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ChapterFetchOptions,
  fetchChapterResponse,
} from "./contentLoad.ts";

const noDelay = async (): Promise<void> => undefined;

test("chapter fetch retries one transient replica miss from cache", async () => {
  const calls: Array<ChapterFetchOptions | undefined> = [];
  const response = await fetchChapterResponse(
    "/api/file?path=book%2F02.md&lang=zh&rendition=text",
    (_url, opts) => {
      calls.push(opts);
      return Promise.resolve(
        calls.length === 1
          ? new Response(null, { status: 504 })
          : new Response("chapter", { status: 200 }),
      );
    },
    () => false,
    noDelay,
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "chapter");
  assert.deepEqual(calls, [undefined, { cacheFirst: true, connectMs: 5_000 }]);
});

test("chapter fetch does not retry a real missing page or known offline miss", async () => {
  for (const [status, offline] of [[404, false], [504, true]] as const) {
    let calls = 0;
    const response = await fetchChapterResponse(
      "/api/file?path=book%2Fmissing.md&lang=zh&rendition=text",
      () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status }));
      },
      () => offline,
      noDelay,
    );
    assert.equal(response.status, status);
    assert.equal(calls, 1);
  }
});

test("chapter fetch retries one online transport exception", async () => {
  let calls = 0;
  const response = await fetchChapterResponse(
    "/api/file?path=book%2F02.md&lang=zh&rendition=text",
    () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve(new Response("chapter", { status: 200 }));
    },
    () => false,
    noDelay,
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});
