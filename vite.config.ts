import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

function manualChunks(id: string) {
  if (!id.includes("node_modules")) return undefined;

  if (id.includes("react-dom") || id.includes("/react/")) {
    return "react";
  }

  if (id.includes("react-router-dom")) {
    return "router";
  }

  if (
    id.includes("react-markdown")
    || id.includes("remark-gfm")
    || id.includes("/remark-")
    || id.includes("/rehype-")
    || id.includes("/micromark")
    || id.includes("/mdast")
    || id.includes("/hast")
    || id.includes("/unist")
    || id.includes("/vfile")
  ) {
    return "markdown";
  }

  if (id.includes("lucide-react")) {
    return "icons";
  }

  if (id.includes("/gifuct-js/")) {
    return "pixi-gif";
  }

  if (id.includes("/earcut/")) {
    return "pixi-geom";
  }

  if (id.includes("/@xmldom/") || id.includes("/parse-svg-path/")) {
    return "pixi-svg";
  }

  if (id.includes("/eventemitter3/") || id.includes("/ismobilejs/") || id.includes("/tiny-lru/")) {
    return "pixi-utils";
  }

  if (id.includes("/pixi.js/") || id.includes("/@pixi/")) {
    return "pixi";
  }

  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8791",
      "/ws": { target: "ws://127.0.0.1:8791", ws: true },
      "/sprites": "http://127.0.0.1:8791",
    },
  },
  build: {
    outDir: "dist",
    // The Office view lazy-loads Pixi as a dedicated renderer vendor chunk.
    // After splitting non-office views out of the entry bundle, a slightly
    // higher warning threshold avoids noisy false positives for that one chunk.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
