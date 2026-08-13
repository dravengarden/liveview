import { localeDescriptor, resolveLocale } from "./registry.ts";

declare const Deno: {
  test(name: string, body: () => void): void;
};

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("locale registry resolves exact and regional language tags", () => {
  assertEquals(resolveLocale("en-US"), "en");
  assertEquals(resolveLocale("ZH-Hans"), "zh");
  assertEquals(resolveLocale("fr"), undefined);
  assertEquals(resolveLocale(null), undefined);
  assertEquals(localeDescriptor("zh").htmlLang, "zh-CN");
});
