import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/ — locked port matches tauri.conf.json's devUrl.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    // This repo still has legacy compiled .js siblings next to the TS/TSX
    // sources. Prefer the real sources so edits in .ts/.tsx are what the app
    // runs, and so stale .js files cannot shadow newer viewport code.
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
