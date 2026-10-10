import { test } from "bun:test";
import { localeDescriptor, resolveLocale } from "./registry.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

test("locale registry resolves exact and regional language tags", () => {
  assertEquals(resolveLocale("en-US"), "en");
  assertEquals(resolveLocale("ZH-Hans"), "zh");
  assertEquals(resolveLocale("fr"), undefined);
  assertEquals(resolveLocale(null), undefined);
  assertEquals(localeDescriptor("zh").htmlLang, "zh-CN");
});
