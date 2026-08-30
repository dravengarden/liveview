import { readableMermaidLabelColor } from "./mermaid-contrast.ts";

declare const Deno: {
  test(name: string, body: () => void): void;
};

function assertEquals<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("Mermaid labels repair light-on-light semantic nodes", () => {
  for (
    const background of [
      "rgb(253, 230, 138)",
      "rgb(220, 252, 231)",
      "rgb(254, 202, 202)",
    ]
  ) {
    assertEquals(
      readableMermaidLabelColor(background, "rgb(204, 204, 204)"),
      "#111827",
    );
  }
});

Deno.test("Mermaid labels preserve colours that already have enough contrast", () => {
  assertEquals(
    readableMermaidLabelColor("rgb(31, 32, 32)", "rgb(204, 204, 204)"),
    null,
  );
  assertEquals(
    readableMermaidLabelColor("rgb(220, 252, 231)", "rgb(17, 24, 39)"),
    null,
  );
});

Deno.test("Mermaid labels do not guess across gradients or translucent fills", () => {
  assertEquals(
    readableMermaidLabelColor(
      'url("#semantic-gradient")',
      "rgb(204, 204, 204)",
    ),
    null,
  );
  assertEquals(
    readableMermaidLabelColor("rgba(255, 255, 255, 0.5)", "rgb(204, 204, 204)"),
    null,
  );
});
