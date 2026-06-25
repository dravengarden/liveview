import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { splashHtml } from "./src/_shell/splash";

const ReactCompilerConfig = {
  target: "19",
};

// ── Single-instance enforcement for React-context-bearing packages ──────────
//
// THE BUG CLASS this prevents (it has bitten the bundled app twice): the shared
// _shell SDK is a DIRECTORY SYMLINK to ../../../shared-utils/packages/ui, and
// shared-utils carries its OWN node_modules copies of React/MUI/emotion. Vite
// resolves a symlinked source file's bare imports from the file's REAL location
// (shared-utils), so NavShell / SettingsSheet / DetentSheet etc. bind to a SECOND
// copy of these packages. React Context is keyed by MODULE IDENTITY, so the app's
// <ThemeProvider> populates copy-A's context while the SDK reads copy-B's EMPTY
// context → MUI silently falls back to its DEFAULT (light) theme for every SDK
// subtree. Symptom: in dark mode the bottom nav bar AND the Settings sheet render
// white-on-near-white. App-instantiated MUI (MuiPaper) stays correct, which makes
// it look like "only some things" are broken.
//
// THE FIX: force the context-bearing packages to ONE physical copy (the app's) via
// alias. Note we do NOT need to dedupe @mui/material itself — the ThemeContext
// lives in these lower-level packages, so two @mui/material copies both read the
// shared context once these are singletons. (resolve.dedupe of @mui/* is NOT usable
// here: under deno's nested node_modules/.deno layout it breaks @mui/material's
// internal sibling imports and fails the build — see the git history.)
//
// THE POKA-YOKE: assertSingletons() (below) FAILS THE BUILD if any of these ends
// up bundled from >1 location, so a future re-introduced duplicate can never ship
// a silently light-themed SDK again — it dies loudly at build time instead.
// All @mui/* and @emotion/* (+ react) must be single copies: not only the explicit
// context-holders, but @mui/material itself — otherwise shared-utils's @mui/material
// copy gets bundled and drags IN its OWN transitive @mui/private-theming /
// @emotion/cache (resolved internally within shared-utils's .deno tree, bypassing a
// bare-specifier interceptor). forceSingletons() resolves each via `this.resolve`
// from the app root, which honours package.json `exports`, so deep subpaths
// (@mui/system/createBreakpoints, @mui/utils/composeClasses) resolve correctly —
// the reason a plain dedupe/alias could not cover @mui/*.
const SINGLETONS = [
  "react",
  "react-dom",
  "@emotion/react",
  "@emotion/styled",
  "@emotion/cache",
  "@mui/material",
  "@mui/icons-material",
  "@mui/system",
  "@mui/private-theming",
  "@mui/styled-engine",
  "@mui/utils",
  "@mui/base",
];

// Force every import of a SINGLETON package (bare OR deep subpath) to resolve as if
// imported from the APP root, so it lands on the app's single copy — including from
// the symlinked _shell SDK, whose source otherwise resolves these from
// shared-utils/node_modules. We re-run resolution via `this.resolve` (vite's own
// resolver) rather than a path alias on purpose: these packages use package.json
// `exports` for deep subpaths (e.g. @mui/system/createBreakpoints,
// @mui/utils/composeClasses), so a raw directory alias — and resolve.dedupe — both
// FAIL to resolve those subpaths under deno's nested node_modules layout. Resolving
// from a fixed app-root importer keeps exports semantics AND pins the copy.
const APP_ROOT = resolve(import.meta.dirname, "src/main.tsx");
const isSingleton = (id: string): boolean =>
  SINGLETONS.some((p) => id === p || id.startsWith(`${p}/`));
function forceSingletons(): Plugin {
  return {
    name: "lv-force-singletons",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !isSingleton(source)) return null;
      // skipSelf so this doesn't re-enter; importer=APP_ROOT pins the app's copy.
      const r = await this.resolve(source, APP_ROOT, { ...options, skipSelf: true });
      return r ?? null;
    },
  };
}

// Build-time guard: collect the physical package root of every bundled module that
// belongs to a SINGLETON package; if any package resolved to more than one root,
// throw. This is the tripwire for the dual-context bug — keep it; do not weaken it
// to a warning. If it fires, a new duplicate copy slipped in (usually a shared SDK
// dep not in SINGLETONS, or the alias above stopped matching) — add it / fix it.
function assertSingletons(): Plugin {
  const seen: Record<string, Set<string>> = {};
  return {
    name: "lv-assert-singletons",
    apply: "build",
    moduleParsed(info) {
      // Normalize: drop rollup virtual prefix (\0) and any ?query (e.g. ?v=) so the
      // same physical file isn't counted as two roots.
      const id = (info.id.replace(/^\0/, "").split("?")[0]) ?? "";
      for (const p of SINGLETONS) {
        const marker = `/node_modules/${p}/`;
        const i = id.indexOf(marker);
        if (i !== -1) (seen[p] ??= new Set()).add(id.slice(0, i + marker.length));
      }
    },
    buildEnd() {
      const dupes = Object.entries(seen).filter(([, s]) => s.size > 1);
      if (dupes.length) {
        throw new Error(
          "lv-assert-singletons: a React-context-bearing package was bundled from " +
            "MORE THAN ONE copy — this reintroduces the dual-MUI-theme-context bug " +
            "(washed-out SDK components in dark mode). Force them to one copy in " +
            "vite.config resolve.alias.\n" +
            dupes
              .map(([p, s]) => `  ${p}:\n` + [...s].map((x) => `    ${x}`).join("\n"))
              .join("\n"),
        );
      }
    },
  };
}

// Inject the shared pre-mount app-shell splash (from @shared-utils/ui, staged
// into _shell) into index.html at build time: the <style> before </head> and
// the spinner markup inside #root. One source across all atlantis apps; React's
// createRoot replaces it on mount.
function splashInjector(): Plugin {
  const { head, body } = splashHtml({ title: "LiveView" });
  return {
    name: "lv-splash-injector",
    transformIndexHtml(html: string): string {
      return html
        .replace("</head>", `${head}\n  </head>`)
        .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
    },
  };
}

// Stamp the hand-rolled service worker at build time so its cache version and
// precached app shell track the actual build — no hand-bumped VERSION to forget,
// and the offline shell is precached atomically with the exact hashed chunks
// index.html boots from. Reads the emitted dist/index.html, rewrites the two
// build placeholders in dist/sw.js. Fails the build loudly if either placeholder
// is missing, so a future SW refactor that renames them can't silently ship an
// unstamped (manual-VERSION, incomplete-shell) worker. See web/public/sw.js.
function stampServiceWorker(): Plugin {
  return {
    name: "lv-stamp-sw",
    apply: "build",
    closeBundle() {
      const dist = resolve(import.meta.dirname, "dist");
      const html = readFileSync(resolve(dist, "index.html"), "utf8");
      const assets = [
        ...new Set(
          [...html.matchAll(/\/assets\/[^"']+\.(?:js|css)/g)].map((m) => m[0]),
        ),
      ].sort();
      if (assets.length === 0) {
        throw new Error("lv-stamp-sw: no /assets/* references found in dist/index.html");
      }
      // VERSION = content hash of the shell asset set → changes iff the shell
      // changes (each filename already embeds Vite's per-file content hash).
      const version =
        "lv-" + createHash("sha256").update(assets.join(",")).digest("hex").slice(0, 12);
      const swPath = resolve(dist, "sw.js");
      const out = readFileSync(swPath, "utf8")
        .replace('const VERSION = "lv-dev";', `const VERSION = ${JSON.stringify(version)};`)
        .replace("const SHELL_ASSETS = [];", `const SHELL_ASSETS = ${JSON.stringify(assets)};`);
      if (!out.includes(version) || !out.includes(JSON.stringify(assets))) {
        throw new Error(
          "lv-stamp-sw: VERSION / SHELL_ASSETS placeholders not found in dist/sw.js — did the SW source change?",
        );
      }
      writeFileSync(swPath, out);
      console.log(
        `lv-stamp-sw: ${version} · precaching ${assets.length} shell assets`,
      );
    },
  };
}

// App build only: the native (iOS/macOS) bundle has NO service worker — the
// shell serves its own offline layer. Drop the precached sw.js from dist-app.
function stripServiceWorker(): Plugin {
  return {
    name: "lv-strip-sw",
    apply: "build",
    closeBundle() {
      try {
        rmSync(resolve(import.meta.dirname, "dist-app", "sw.js"));
      } catch {
        // not emitted — fine.
      }
    },
  };
}

// Two build targets share ONE src core (see src/platform):
//   • `vite build`            → dist/      — PWA + service worker, served by the server.
//   • `vite build --mode app` → dist-app/  — native iOS/macOS bundle, NO service worker.
// The app build bakes `__TARGET__="app"` so IS_APP is a build-time constant and
// the SW / pwa code tree-shakes out. The pwa build leaves `__TARGET__` undefined
// → src/platform/target.ts uses a runtime fallback, so the server-served build
// still behaves correctly in a browser (pwa) AND in the old remote-loading shell
// (app), until A3 switches the shell to dist-app.
export default defineConfig(({ mode }) => {
  const isApp = mode === "app";
  return {
  // App build uses RELATIVE asset URLs so the same bundle works whether it's
  // served from the embedded origin (tauri://localhost/) OR the OTA origin
  // (lvsync://localhost/app/) — relative `./assets/…` resolve against the
  // document/module URL in both. The PWA stays absolute (/) for its SW scope.
  base: isApp ? "./" : "/",
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
    forceSingletons(),
    splashInjector(),
    assertSingletons(),
    ...(isApp ? [stripServiceWorker()] : [stampServiceWorker()]),
  ],
  define: isApp ? { __TARGET__: JSON.stringify("app") } : {},
  resolve: {
    // forceSingletons() (a resolveId plugin, above) pins the React-context-bearing
    // packages to the app's single copy so the symlinked _shell SDK shares the app's
    // React/MUI/emotion context (the dual-context bug that washed out the nav bar +
    // Settings sheet in dark mode); assertSingletons() guards against regressions.
    dedupe: ["react", "react-dom"],
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: isApp ? "dist-app" : "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: "esbuild",
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          mui: ["@mui/material", "@mui/icons-material"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4159",
      "/ws": {
        target: "ws://127.0.0.1:4159",
        ws: true,
      },
    },
  },
  };
});
