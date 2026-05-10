# 02 — Cache pipeline

Source: `apps/desktop/src-tauri/src/cache.rs`.

The cache is the seam between Rust (parser-heavy) and the frontend
(viewer/exporter). One pass over the level produces every artifact the
UI needs.

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

| Command | Purpose |
|---|---|
| `extract_level_to_cache(folder, on_event)` | Build the cache from scratch. Streams `Phase` + `Item` + `Progress` events for the UI progress bar. |
| `reextract_level_cache(folder, on_event)` | Wipe `_rechimera_cache/` and call extract. |
| `cache_status(folder)` | Lightweight: returns counts + staleness without parsing anything. |
| `read_cached_manifest(folder)` | Read `manifest.json`. |
| `read_cached_asset(folder, file)` | Read a JSON DTO file. |
| `read_cached_bytes(folder, file)` | Return raw bytes (for `.glb` and `.png`) via binary IPC. |
| `export_cached_moby_glb(folder, tuid, out_path)` | Fast path: copy the cached `.glb` to `out_path`. |
| `export_moby_glb_with_options(folder, tuid, out_path, options)` | Slower path: re-extracts the moby and re-bakes a GLB with custom scope, texture quality, and animation picks. |
| `list_animsets(folder)` | Enumerate every animset in `assetlookup.dat` with clip metadata (lightweight, headers only). |
| `decode_animset_clip(folder, asset_tuid, animset_hash, clip_index)` | Decode one specific clip and return its full track data, retargetable to any skeleton. |

## Extraction flow (`run_extract`)

```
Phase: shaders   → read_shaders → HashMap<u64, ShaderInfo>
Phase: animsets  → AnimsetIndex::build (just builds the lookup map)
Phase: mobys     → read_moby_assets_with_total
                    for each MobyAsset:
                      collect needed texture ids (via shader resolve)
                      write mobys/0x{tuid}.json
                      remember the asset for the GLB step
Phase: ties      → read_tie_assets_with_total   (same shape)
Phase: ufrags    → read_zones (for terrain UFrag positions)
Phase: textures  → bulk_extract_pngs(level, &needed_ids, 512)
                    write textures/{id}.png × N
Phase: mobys (G1-G4) → for each moby:
                       decode_clips_for_moby(animset)
                       write_moby_glb_full(asset, &clips, &shaders, &texture_pngs)
                       write mobys/0x{tuid}.glb
Phase: ties (G1-G4)  → tie_as_moby + write_moby_glb_full → ties/0x{tuid}.glb
Final: write manifest.json with `complete: true`
```

The `tie_as_moby` adapter wraps a `TieAsset` in a single-bangle
`MobyAsset` shape so the GLB writer doesn't need a separate code path.

## Cache invalidation

`cache_status` returns:
- `exists` — does `manifest.json` exist (or any sub-folder content if
  manifest is missing)?
- `stale` — does any of the recorded `source_mtimes` no longer match
  current disk mtimes?
- `complete` — was the manifest written with the `complete: true` flag?

The frontend uses these to decide whether to prompt the user to
re-extract before opening a level.
