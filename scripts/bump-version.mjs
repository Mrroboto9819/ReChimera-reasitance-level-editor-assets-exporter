#!/usr/bin/env node
/*
 * One-command version bump.
 *
 * Writes the new version into the workspace Cargo.toml (the canonical
 * source) and then defers to sync-version.mjs to propagate it to
 * apps/desktop/package.json + apps/desktop/src-tauri/tauri.conf.json.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.1.2
 *
 * After this script runs, three files in the working tree will have
 * the new version. Commit them together as part of the release PR.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const newVersion = process.argv[2];
if (!newVersion) {
  console.error("Usage: node scripts/bump-version.mjs <version>");
  console.error("Example: node scripts/bump-version.mjs 0.1.2");
  process.exit(1);
}

// Sanity-check the format. Tauri / Cargo / npm all expect a SemVer
// triple (optionally with a pre-release suffix). Catching this here
// is friendlier than failing in three different parsers later.
if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(newVersion)) {
  console.error(
    `[bump-version] "${newVersion}" doesn't look like a valid SemVer string`,
  );
  console.error("Expected: MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease");
  process.exit(1);
}

// --- Update Cargo.toml workspace.package.version in place ---
const cargoPath = resolve(repoRoot, "Cargo.toml");
const cargoText = readFileSync(cargoPath, "utf-8");
const updated = cargoText.replace(
  /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/m,
  `$1${newVersion}$2`,
);
if (updated === cargoText) {
  console.error(
    `[bump-version] failed to locate workspace.package.version in ${cargoPath}`,
  );
  process.exit(1);
}
writeFileSync(cargoPath, updated);
console.log(`[bump-version] Cargo.toml → ${newVersion}`);

// --- Defer to the sync script for the other two files ---
const result = spawnSync(
  process.execPath,
  [resolve(here, "sync-version.mjs")],
  { stdio: "inherit" },
);
process.exit(result.status ?? 0);
