# 02 — Cache pipeline

Source: `apps/desktop/src-tauri/src/cache.rs`.

The cache is the seam between Rust (parser-heavy) and the frontend
(viewer/exporter). One pass over the level produces every artifact the
UI needs — and every consumer (viewport, modal preview, export) reads
the same bytes back out, so there's no preview/export divergence.

## On-disk layout

```
<level_folder>/_rechimera_cache/
├── manifest.json           # entry index, source mtimes, version
├── mobys/
│   ├── 0x{tuid}.json       # AssetMeshesDto: meshes, skeleton, shader ids
│   └── 0x{tuid}.glb        # baked glTF for the modal preview + export
├── ties/
│   ├── 0x{tuid}.json
│   └── 0x{tuid}.glb
├── ufrags/
│   └── 0x{tuid}.json
└── textures/
    └── {id}.png            # 512px max, one per used texture id
```

`manifest.json`:

```json
{
  "version": 2,
  "folder": "<level_folder>",
  "entries": [
    { "kind": "moby",     "tuid": "0x...", "name": "...", "file": "mobys/0x....json", "size_bytes": ... },
    { "kind": "moby_glb", "tuid": "0x...", "name": "...", "file": "mobys/0x....glb",  "size_bytes": ... },
    { "kind": "tie",      ... },
    { "kind": "tie_glb",  ... },
    { "kind": "ufrag",    ... },
    { "kind": "texture",  ... }
  ],
  "source_mtimes": { "mobys.dat": 1715212345, ... },
  "complete": true
}
```

`source_mtimes` lets `cache_status` decide whether the cache is stale
(any source `.dat` newer than its recorded mtime → user sees "rebuild
cache" prompt).

## The Tauri commands

The cache module exports the following commands (registered in
`main.rs::invoke_handler`):

| Command | Purpose |
|---|---|
| `extract_level_to_cache(folder, on_event)` | Build the cache from scratch. Streams `Phase` + `Item` + `Progress` events for the UI progress bar. Layout-dispatches internally. |
| `reextract_level_cache(folder, on_event)` | Wipe `_rechimera_cache/` and call extract. |
| `cache_status(folder)` | Lightweight: returns counts + staleness without parsing anything. |
| `read_cached_manifest(folder)` | Read `manifest.json`. |
| `read_cached_asset(folder, file)` | Read a JSON DTO file. |
| `read_cached_bytes(folder, file)` | Return raw bytes (for `.glb` and `.png`) via binary IPC. |
| `export_cached_moby_glb(folder, tuid, out_path)` | Fast path: copy the cached `.glb` to `out_path`. |
| `export_moby_glb_with_options(folder, tuid, out_path, options)` | Slower path: re-extracts the moby and re-bakes a GLB with custom scope, texture quality, and animation picks. Layout-aware (works on every supported game). |
| `list_animsets(folder)` | Enumerate every animset in `assetlookup.dat` with clip metadata (V2 only — returns empty `Vec` for RFOM and TOD because their anims live inline in `ps3levelmain.dat` / `main.dat`, not in standalone animsets). |
| `decode_animset_clip(folder, asset_tuid, animset_hash, clip_index)` | V2 path: decode one specific clip and return its full track data, retargetable to any skeleton. |

## Per-engine dispatch

Every phase below detects `LevelLayout` once and branches into the
matching parser family. The three layouts are:

| Layout | Marker file | Shaders | Mobys | Textures | Anims |
|---|---|---|---|---|---|
| `V2` | `assetlookup.dat` | `read_shaders` | `read_moby_assets_with_total` | `bulk_extract_pngs` | animset-based (`decode_clips_for_moby`) |
| `Rfom` | `ps3levelmain.dat` | `read_shaders_rfom` | `read_mobys_rfom` (inside `ps3levelmain.dat`) | `read_textures_rfom` | inline offsets (`decode_clips_for_moby_inline`) |
| `Tod` | `main.dat` | `read_shaders_old` | `read_mobys_old` (inside `main.dat`) | `read_textures_old` | currently disabled — `decode_clips_for_moby_inline` early-returns for TOD because the per-frame format is unsolved (T-pose only) |

The DTOs are unified: V2 / RFOM / TOD all surface a `MobyAsset` with
the same `meshes`, `skeleton`, and `shader_ids` shape, so once the
asset is in memory the GLB writer and the frontend don't care which
parser produced it.

## Extraction flow (`run_extract`)

```
detect layout from marker file (level_layout.rs)

Phase: shaders   → V2:    read_shaders
                   Rfom:  read_shaders_rfom
                   Tod:   read_shaders_old
Phase: animsets  → V2 only: AnimsetIndex::build (lookup map for clips)
                   RFOM/TOD skip — no standalone animsets
Phase: mobys     → V2/Rfom/Tod: layout-specific reader
                    for each MobyAsset:
                      collect needed texture ids (via shader resolve)
                      write mobys/0x{tuid}.json
                      remember the asset for the GLB step
Phase: ties      → V2/Rfom: layout-specific tie reader
                   Tod: skipped (no tie support yet)
Phase: ufrags    → V2: read_zones
                   Rfom: read_regions_rfom
                   Tod: read_zones_old
Phase: textures  → V2:    bulk_extract_pngs
                   Rfom:  read_textures_rfom + PNG encode
                   Tod:   read_textures_old + PNG encode
Phase: mobys (G1-G4) → for each moby:
                       V2:    decode_clips_for_moby(animset)
                       Rfom:  decode_clips_for_moby_inline("ps3levelmain.dat")
                       Tod:   decode_clips_for_moby_inline("main.dat")  → early returns []
                       write_moby_glb_full(asset, &clips, &shaders, &texture_pngs)
                       write mobys/0x{tuid}.glb
Phase: ties (G1-G4)  → tie_as_moby + write_moby_glb_full → ties/0x{tuid}.glb
Final: write manifest.json with `complete: true`
```

The `tie_as_moby` adapter wraps a `TieAsset` in a single-bangle
`MobyAsset` shape so the GLB writer doesn't need a separate code path.

## Inline animation decoder

`decode_clips_for_moby_inline(level_folder, main_dat_filename, ...)`
opens the per-engine `.dat` (either `ps3levelmain.dat` for RFOM or
`main.dat` for TOD), seeks to the moby's `rfom_anim_offsets` list, and
runs the IT-style decoder against each offset.

For TOD, the function returns an empty `Vec` immediately — the
per-frame format isn't documented in IT (no TOD support there) or
ReLunacy (TOD anims unimplemented). Mobys still get their skeleton,
mesh, textures and a default T-pose; only the animation tracks are
empty. See `project_tod_anim_format` in memory for the four
hypotheses being investigated.

## Cache invalidation

`cache_status` returns:
- `exists` — does `manifest.json` exist (or any sub-folder content if
  manifest is missing)?
- `stale` — does any of the recorded `source_mtimes` no longer match
  current disk mtimes?
- `complete` — was the manifest written with the `complete: true` flag?

The frontend uses these to decide whether to prompt the user to
re-extract before opening a level.
