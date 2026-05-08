# 01 — Map Extraction & Cache-First Render Flow

This document describes the canonical pipeline ReChimera uses to open a level, extract its raw `.dat` payloads into a structured on-disk cache, and render the result in the viewport.

The architecture is **cache-first**: a single Rust extraction pipeline writes `_rechimera_cache/` once, and every consumer (viewport renderer, exports, hierarchy library, asset preview modal) reads from that cache. There is no runtime streaming pipeline anymore.

---

## Top-level pipeline

```
.dat files          extract_level_to_cache (Rust)         _rechimera_cache/                FE consumers
─────────────       ──────────────────────────            ───────────────────             ──────────────
assetlookup.dat ──┐                                       manifest.json                   loadFromCache  → viewport
mobys.dat         │  read_moby_assets_with_total          mobys/<tuid>.json
ties.dat          │  read_tie_assets_with_total           mobys/<tuid>.glb     ← G1-G4    exportCachedMobyGlb → user .glb
zones.dat         ├─ read_zones                           ties/<tuid>.json
shaders.dat       │  read_shaders                         ufrags/<tuid>.json
textures.dat      │  bulk_extract_pngs                    textures/<id>.png    ← PBR maps
highmips.dat      │  write_moby_glb_full (G1-G4)
animsets.dat      ┘  decode_animation
```

The same files that drive the viewport are the files exported to disk when the user hits **Export .glb** — guaranteeing geometric / skeletal consistency between preview and export.

---

## Step-by-step

### 1. User picks a level folder

Entry point: `OpenLevelModal` → `handleOpen(folder)` in `apps/desktop/src/App.tsx`.

The handler:
- Clears stale state (`setMeshes(null)`, `setSummary(null)`, etc.)
- Calls `openLevel(folder)` (Tauri command in `apps/desktop/src-tauri/src/main.rs`) which only reads the IGHW header from `assetlookup.dat` — cheap, ~50ms.
- Calls `levelLayout(folder)` to get instance positions + UFrag bounds (no mesh decode).

### 2. Cache check — does `_rechimera_cache/` exist and is it complete?

`loadFullMeshes(sum, cacheMode)` in `App.tsx`:

```ts
const status = await cacheStatus(sum.folder);
const needExtract =
  cacheMode === "force-reextract"  ||
  !status.exists                   ||
  status.incomplete;
```

`cache_status` (Rust, `apps/desktop/src-tauri/src/cache.rs`) returns:
- `exists: bool` — manifest exists OR cache directory has files (recovery from missing manifest)
- `stale: bool` — source `.dat` mtimes newer than the manifest's snapshot
- `incomplete: bool` — manifest has `complete: false` (extraction was interrupted)

If a fresh complete cache exists, **skip directly to step 4**.

### 3. Extract (only if needed) — `runCacheExtract(folder, force)`

A wrapper around the Tauri command `extract_level_to_cache` (or `reextract_level_cache` when `force === true`). Returns a `Promise<void>` that resolves on the `done` event.

While running, `<CacheModal>` displays phase pills (Mobys / Ties / Terrain / Textures) with live counts. The Rust side (`run_extract` in `cache.rs`) executes phases in order:

| Phase    | Rust call                                     | Output                                         |
|----------|-----------------------------------------------|------------------------------------------------|
| Mobys    | `read_moby_assets_with_total`                 | `mobys/<tuid>.json`                            |
| Ties     | `read_tie_assets_with_total`                  | `ties/<tuid>.json`                             |
| Terrain  | `read_zones` then per-`UFrag`                 | `ufrags/<tuid>.json`                           |
| Textures | `bulk_extract_pngs` (rayon parallel)          | `textures/<id>.png`                            |
| GLBs     | `write_moby_glb_full` (G1-G4 phases combined) | `mobys/<tuid>.glb` (geometry+skin+anim+matl)   |

The manifest is written **twice**:
- At extraction start with `complete: false` → guards against interrupted runs (next `cache_status` call flags it as incomplete and the user gets a re-extract prompt).
- At extraction end with `complete: true` plus full entries[] + source_mtimes snapshot.

### 4. Read the manifest

```ts
const manifest = await readCachedManifest(sum.folder);
setCacheManifest(manifest);
```

Drives the Hierarchy's "Cache" sub-tab and the Cache library modal.

### 5. Build `LevelMeshes` from the cache — `loadFromCache(folder, onProgress)`

Defined in `apps/desktop/src/api.ts`. Walks the manifest entries grouped by kind:

```ts
const moby_assets = await Promise.all(mobyEntries.map(e => readCachedAsset(folder, e.file)));
const tie_assets  = await Promise.all(tieEntries .map(e => readCachedAsset(folder, e.file)));
const ufrag_meshes = await Promise.all(ufragEntries.map(e => readCachedAsset(folder, e.file)));
const textures = textureEntries.map(e => ({ id: parseInt(e.tuid, 10), width: 0, height: 0 }));
return { moby_assets, tie_assets, ufrag_meshes, textures };
```

Returns the same `LevelMeshes` shape the streaming pipeline used to emit, so the Viewport, Hierarchy, Inspector, and CacheLibraryModal consume it without any further changes.

`onProgress` callback drives the unified loading modal (phase + current/total).

### 6. Set FE state → viewport renders

```ts
setMeshes(meshes);  // → Viewport reads from this
loadCachedTextures(folder, textureIds).then(setTextureBlobs);  // → materials
```

The Viewport's `<InstancedAssetSubmesh>` builds Three.js `BufferGeometry` from `submeshes[*].positions_b64 / uvs_b64 / indices_b64` — exactly the same code path as before, just sourced from cache JSONs instead of from streaming events.

---

## Methods called and where they live

| Layer       | Symbol                          | File                                             |
|-------------|---------------------------------|--------------------------------------------------|
| FE entry    | `handleOpen(rawFolder)`         | `apps/desktop/src/App.tsx`                       |
| FE orchest. | `loadFullMeshes(sum, mode)`     | `apps/desktop/src/App.tsx`                       |
| FE extract  | `runCacheExtract(folder, force)`| `apps/desktop/src/App.tsx`                       |
| FE reader   | `loadFromCache(folder, onProg)` | `apps/desktop/src/api.ts`                        |
| FE reader   | `loadCachedTextures(folder, ids)`| `apps/desktop/src/api.ts`                       |
| FE reader   | `readCachedManifest(folder)`    | `apps/desktop/src/api.ts`                        |
| FE reader   | `readCachedAsset(folder, file)` | `apps/desktop/src/api.ts`                        |
| FE reader   | `cacheStatus(folder)`           | `apps/desktop/src/api.ts`                        |
| Tauri cmd   | `open_level`                    | `apps/desktop/src-tauri/src/main.rs`             |
| Tauri cmd   | `level_layout`                  | `apps/desktop/src-tauri/src/main.rs`             |
| Tauri cmd   | `cache_status`                  | `apps/desktop/src-tauri/src/cache.rs`            |
| Tauri cmd   | `extract_level_to_cache`        | `apps/desktop/src-tauri/src/cache.rs`            |
| Tauri cmd   | `reextract_level_cache`         | `apps/desktop/src-tauri/src/cache.rs`            |
| Tauri cmd   | `read_cached_manifest`          | `apps/desktop/src-tauri/src/cache.rs`            |
| Tauri cmd   | `read_cached_asset`             | `apps/desktop/src-tauri/src/cache.rs`            |
| Tauri cmd   | `read_cached_bytes`             | `apps/desktop/src-tauri/src/cache.rs`            |
| Tauri cmd   | `export_cached_moby_glb`        | `apps/desktop/src-tauri/src/cache.rs`            |
| Rust extract| `run_extract(folder, on_event)` | `apps/desktop/src-tauri/src/cache.rs`            |
| Rust GLB    | `write_moby_glb_full`           | `crates/lunalib/src/gltf_export.rs`              |
| Rust IGHW   | `read_moby_assets_with_total`   | `crates/lunalib/src/moby.rs`                     |
| Rust IGHW   | `read_tie_assets_with_total`    | `crates/lunalib/src/tie.rs`                      |
| Rust IGHW   | `read_zones`                    | `crates/lunalib/src/zone.rs`                     |
| Rust IGHW   | `read_shaders`                  | `crates/lunalib/src/shader.rs`                   |
| Rust IGHW   | `bulk_extract_pngs`             | `crates/lunalib/src/texture.rs`                  |
| Rust IGHW   | `decode_animation`              | `crates/lunalib/src/animation.rs`                |

---

## File shapes inside `_rechimera_cache/`

```
_rechimera_cache/
├── manifest.json                  // CacheManifest { version, folder, entries[], source_mtimes, complete }
├── mobys/
│   ├── 0xABCDEF.json              // AssetMeshes (positions_b64, uvs_b64, indices_b64, skeleton, animset_hash, ...)
│   └── 0xABCDEF.glb               // pre-baked GLB with G1-G4 layers (geom + skin + anim + materials)
├── ties/
│   └── 0x123456.json              // AssetMeshes (no skeleton)
├── ufrags/
│   └── 0x789ABC.json              // UFragMeshDto { tuid, zone_tuid, position, mesh }
└── textures/
    └── 12345.png                  // decoded + downsampled (≤512px) PNG
```

The JSONs use the same `AssetMeshes` and `UFragMeshDto` types the FE knows. The GLBs match the Khronos binary glTF 2.0 spec; opening one in Blender/Three.js yields a correctly-skinned, animated, textured asset.

---

## What happened to the old streaming pipeline?

`streamLevelMeshes` (Tauri command `level_meshes_stream`) and the related FE wiring were removed. They duplicated work — both decoded the same `.dat` files into different in-memory shapes, then the cache extractor decoded them a *third* time to disk. Now there is one decode (Rust → cache), and every consumer reads the cache.

Side benefit: the recurring `[TAURI] Couldn't find callback id …` log floods that happened when the user navigated away mid-stream are gone — no long-lived Channel<LevelEvent> exists anymore.

---

## Edge cases handled

- **Cache directory exists but `manifest.json` missing**: `cache_status` falls back to a directory scan and returns `exists: true, incomplete: true` so the user gets the prompt.
- **Manifest has `complete: false`**: same — flagged as incomplete (the extractor writes this placeholder at start and only flips it to `true` on success).
- **Source `.dat` files modified after extraction**: `cache_status` compares current mtimes against the snapshot in the manifest; staleness flag drives the re-extract prompt.
- **User cancels mid-extract**: leaves a `complete: false` manifest behind; next open prompts to re-extract.

---

## When to update this doc

- New phases added to `run_extract` (e.g. cinematics, lighting probes)
- New Tauri commands that produce cache files
- Changes to `CacheManifest` schema (bump `MANIFEST_VERSION` constant + document old → new migration)
- Changes to `AssetMeshes` or `UFragMeshDto` wire shape (FE will fail to deserialize older caches)
