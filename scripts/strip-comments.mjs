#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import stripComments from "strip-comments";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

const ROOTS = [
  "apps/desktop/src",
  "apps/desktop/src-tauri/src",
  "crates",
];

const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  ".git",
  ".claude",
  "_rechimera_cache",
  "locales",
]);

const SKIP_FILES = new Set([
  "vite-env.d.ts",
]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile()) {
      if (SKIP_FILES.has(name)) continue;
      out.push(full);
    }
  }
}

function stripTsLike(src) {
  return stripComments(src, { language: "javascript", preserveNewlines: true });
}

function stripCss(src) {
  return stripComments(src, { language: "css", preserveNewlines: true });
}

function stripRust(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let pendingLineHasContent = false;
  let pendingLineStart = 0;

  const isLineStart = () => {
    let j = out.length - 1;
    while (j >= 0 && (out[j] === " " || out[j] === "\t")) j--;
    return j < 0 || out[j] === "\n";
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "/" && c2 === "/") {
      const wholeLine = isLineStart();
      while (i < n && src[i] !== "\n") i++;
      if (wholeLine) {
        let k = out.length - 1;
        while (k >= 0 && (out[k] === " " || out[k] === "\t")) k--;
        out = out.slice(0, k + 1);
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const ch = src[i];
        out += ch;
        i++;
        if (ch === "\\") {
          if (i < n) {
            out += src[i];
            i++;
          }
        } else if (ch === '"') {
          break;
        }
      }
      continue;
    }
    if (c === "r" && (c2 === '"' || c2 === "#")) {
      let j = i + 1;
      let hashes = 0;
      while (j < n && src[j] === "#") {
        hashes++;
        j++;
      }
      if (j < n && src[j] === '"') {
        out += src.slice(i, j + 1);
        i = j + 1;
        while (i < n) {
          if (src[i] === '"') {
            let k = i + 1;
            let h = 0;
            while (h < hashes && k < n && src[k] === "#") {
              h++;
              k++;
            }
            if (h === hashes) {
              out += src.slice(i, k);
              i = k;
              break;
            }
          }
          out += src[i];
          i++;
        }
        continue;
      }
    }
    if (c === "b" && c2 === '"') {
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      out += c;
      i++;
      const start = i;
      let escaped = false;
      let saw = 0;
      let closed = false;
      while (i < n && saw < 5) {
        const ch = src[i];
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "'") {
          closed = true;
          break;
        } else if (ch === "\n") {
          break;
        }
        i++;
        saw++;
      }
      if (closed) {
        out += src.slice(start, i + 1);
        i++;
      } else {
        out += src.slice(start, i);
      }
      continue;
    }

    out += c;
    i++;
  }

  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out;
}

const collected = [];
for (const root of ROOTS) {
  walk(join(repoRoot, root), collected);
}

let modified = 0;
let bytesBefore = 0;
let bytesAfter = 0;

for (const path of collected) {
  const ext = extname(path);
  if (![".ts", ".tsx", ".js", ".jsx", ".rs", ".css"].includes(ext)) continue;

  const original = readFileSync(path, "utf8");
  bytesBefore += original.length;

  let next;
  try {
    if (ext === ".css") next = stripCss(original);
    else if (ext === ".rs") next = stripRust(original);
    else next = stripTsLike(original);
  } catch (e) {
    console.error(`SKIP (parse failed): ${relative(repoRoot, path)} — ${e.message}`);
    bytesAfter += original.length;
    continue;
  }

  bytesAfter += next.length;
  if (next !== original) {
    writeFileSync(path, next);
    modified++;
  }
}

console.log(`Stripped comments from ${modified} / ${collected.length} files`);
console.log(`Total size: ${bytesBefore} → ${bytesAfter} (${(bytesBefore - bytesAfter).toLocaleString()} bytes removed)`);
