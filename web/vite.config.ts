import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { splashHtml } from "./src/_shell/splash";

const ReactCompilerConfig = {
  target: "19",
};

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
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
    splashInjector(),
    ...(isApp ? [stripServiceWorker()] : [stampServiceWorker()]),
  ],
  define: isApp ? { __TARGET__: JSON.stringify("app") } : {},
  resolve: {
    // Force a SINGLE React/React-DOM copy. Without this a duplicated React (a
    // transitively-bundled second copy, e.g. via the _shell SDK) leaves the hooks
    // dispatcher null → `$.H.useSyncExternalStore`/`dispatcher.useContext` is null
    // → white screen. Harmless when there's already one copy.
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
