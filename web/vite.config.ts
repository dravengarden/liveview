import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
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

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
    splashInjector(),
  ],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
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
});
