import assert from "node:assert/strict";
import { test } from "node:test";
import { otaReloadUrl } from "./otaReloadUrl.ts";

test("OTA reload URL cache-busts the WebView while preserving reader state", () => {
  assert.equal(
    otaReloadUrl(
      "lvsync://localhost/app/?theme=dark#sui/chapter-2",
      "assets/index-new.js",
    ),
    "lvsync://localhost/app/?theme=dark&lv-ota=assets%2Findex-new.js#sui/chapter-2",
  );
});
