import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Read package.json with plain readFileSync rather than an `import ...
// with { type: "json" }` attribute — the latter needs a very recent
// Node/Bun and was failing silently in dev (Vite's `define`
// substitution then never ran, and `__APP_VERSION__` showed up as an
// undefined ReferenceError at runtime).
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, "package.json"), "utf-8"),
) as { version: string };

// https://vite.dev/config/ — locked port matches tauri.conf.json's devUrl.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Inject the package.json version as a global at build time so the
  // UI can show "ReChimera v0.1.1" without needing to import the JSON
  // file from src/ (which is outside the tsconfig include path).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
