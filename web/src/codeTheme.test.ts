import { ok, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

test("code text and syntax tokens meet 4.5:1 contrast in every reader theme", async () => {
  const css = await readFile(
    new URL("./styles/code-theme.css", import.meta.url),
    "utf8",
  );
  const palettes = [
    ...css.matchAll(/:root(?:\[data-theme="([^"]+)"\])?\s*\{([^}]+)\}/g),
  ]
    .map((match) => ({
      theme: match[1] ?? "light",
      colors: Object.fromEntries(
        [...match[2]!.matchAll(/--lv-code-([\w-]+):\s*(#[\da-f]{6});/g)]
          .map((color) => [color[1]!, color[2]!]),
      ),
    }));
  strictEqual(palettes.length, 6);
  for (const { theme, colors } of palettes) {
    strictEqual(
      Object.keys(colors).length,
      8,
      `${theme} has a complete palette`,
    );
    const background = luminance(colors["bg"]!);
    for (const [token, color] of Object.entries(colors)) {
      if (token === "bg") continue;
      const foreground = luminance(color);
      const contrast = (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05);
      ok(contrast >= 4.5, `${theme} ${token}: ${contrast.toFixed(2)}:1`);
    }
  }
});
