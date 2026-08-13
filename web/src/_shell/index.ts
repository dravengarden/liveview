// Directory-import barrel: lets a consumer `import { … } from "./_shell"` (a
// directory) resolve here. Deno/JSR use `mod.ts` (see deno.json `exports`); this
// re-export keeps both entry styles working — Vite/Node resolve `index.ts` when
// the staged `web/src/_shell/` is imported as a directory.
export * from "./mod.ts";
