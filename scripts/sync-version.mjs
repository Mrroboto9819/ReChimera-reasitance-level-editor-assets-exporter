#!/usr/bin/env node
/*
 * Single-source-of-truth version sync.
 *
 * `Cargo.toml` (workspace `version` field) is canonical. This script
 * reads it and propagates the same version into:
 *   - apps/desktop/package.json
 *   - apps/desktop/src-tauri/tauri.conf.json
 *
 * Why this exists: each ecosystem hard-codes its own version field
 * name in its own file (Cargo expects `version` in Cargo.toml, npm
 * expects it in package.json, Tauri expects it in tauri.conf.json),
 * and there's no native way to point all three at one source. Without
 * a sync script you end up bumping two of three by hand and forgetting
 * the third — exactly the CI failure this script prevents.
 *
 * Usage:
 *   node scripts/sync-version.mjs        # sync from Cargo.toml
 *   node scripts/sync-version.mjs --check  # dry-run; exits non-zero
 *                                          # if anything would change
 *
 * The `--check` mode is what CI uses: run sync without writing, fail
 * if the working tree wouldn't be clean afterwards. That makes
 * "forgot to run sync" a build-time error, not a release-time one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const checkOnly = process.argv.includes("--check");

// --- 1. Read canonical version from workspace Cargo.toml ---
const cargoPath = resolve(repoRoot, "Cargo.toml");
const cargoText = readFileSync(cargoPath, "utf-8");

// `[workspace.package]` block has `version = "X.Y.Z"`. We don't pull
// in a TOML parser for one field — a regex is fine here and keeps the
// script dependency-free.
const match = cargoText.match(
  /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/m,
);
if (!match) {
  console.error(
    `[sync-version] could not find workspace.package.version in ${cargoPath}`,
  );
  process.exit(1);
}
const canonicalVersion = match[1];
console.log(`[sync-version] canonical version (Cargo.toml): ${canonicalVersion}`);

// --- 2. Sync apps/desktop/package.json ---
const pkgPath = resolve(repoRoot, "apps/desktop/package.json");
const pkgText = readFileSync(pkgPath, "utf-8");
const pkg = JSON.parse(pkgText);
let pkgChanged = false;
if (pkg.version !== canonicalVersion) {
  console.log(
    `[sync-version] package.json: ${pkg.version} → ${canonicalVersion}`,
  );
  pkg.version = canonicalVersion;
  pkgChanged = true;
} else {
  console.log("[sync-version] package.json: in sync");
}

// --- 3. Sync apps/desktop/src-tauri/tauri.conf.json ---
const tauriPath = resolve(
  repoRoot,
  "apps/desktop/src-tauri/tauri.conf.json",
);
const tauriText = readFileSync(tauriPath, "utf-8");
const tauri = JSON.parse(tauriText);
let tauriChanged = false;
if (tauri.version !== canonicalVersion) {
  console.log(
    `[sync-version] tauri.conf.json: ${tauri.version} → ${canonicalVersion}`,
  );
  tauri.version = canonicalVersion;
  tauriChanged = true;
} else {
  console.log("[sync-version] tauri.conf.json: in sync");
}

// --- 4. Apply (or dry-run) ---
if (checkOnly) {
  if (pkgChanged || tauriChanged) {
    console.error(
      `\n[sync-version] FAIL — versions are out of sync. Run \`node scripts/sync-version.mjs\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log("\n[sync-version] OK — all sources match Cargo.toml");
  process.exit(0);
}

// Preserve trailing newline so editors / formatters don't fight us
// each time the file is rewritten.
if (pkgChanged) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
if (tauriChanged) {
  writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + "\n");
}

console.log("\n[sync-version] done.");
