import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const ReactCompilerConfig = {
  target: "19",
};

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
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
