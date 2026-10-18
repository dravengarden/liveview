import { test } from "bun:test";
import { deepStrictEqual } from "node:assert";
import { configuredRemotes } from "./apiBase";

test("native deployments exclude an OTA bundle's unrelated fallback server", () => {
  deepStrictEqual(configuredRemotes(
    ["https://reader.example", "https://reader-backup.example"],
    ["http://127.0.0.1:4160"],
    "https://retired.example",
  ), ["https://reader.example", "https://reader-backup.example"]);
});

test("older installed shells preserve their working endpoint across OTA updates", () => {
  deepStrictEqual(configuredRemotes([], ["http://127.0.0.1:4160"], "https://reader.example"),
    ["http://127.0.0.1:4160", "https://reader.example"]);
});

test("older shells without the origins bridge retain configured fallbacks", () => {
  deepStrictEqual(configuredRemotes([], ["https://reader.example", "https://reader.example"]),
    ["https://reader.example"]);
});
