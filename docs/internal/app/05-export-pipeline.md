# 05 — Export pipeline

Source: `apps/desktop/src-tauri/src/cache.rs::export_moby_glb_with_options`,
`apps/desktop/src/components/ExportOptionsModal.tsx`,
`apps/desktop/src/views/GlbPreview.tsx`.

This is the user-facing export flow. The actual GLB-byte writer it sits
on top of is documented at
[`../lunalib-and-IT/08-gltf-export.md`](../lunalib-and-IT/08-gltf-export.md).

## Two export paths

| Path | Tauri command | Behaviour |
|---|---|---|
| Quick copy | `export_cached_moby_glb(folder, asset_tuid, out_path)` | Copies `_rechimera_cache/mobys/0x{tuid}.glb` (or `ties/`) byte-for-byte to `out_path`. Used when the user just wants whatever the cache already has. |
| Custom rebuild | `export_moby_glb_with_options(folder, asset_tuid, out_path, options)` | Re-loads the moby from `mobys.dat`, decodes its primary animset + any user-picked extras, optionally re-extracts textures at higher resolution, then re-bakes a fresh GLB through `lunalib::write_moby_glb_full`. |

The custom rebuild is what the multi-step Export modal invokes. The
quick copy is wired but not currently surfaced (the modal always uses
the rebuild because users may have changed scope / picked extras).

## `GlbExportOptions`

```rust
pub struct GlbExportOptions {
    pub include_mesh: bool,            // off → error (would produce empty GLB)
    pub include_materials: bool,       // off → empty texture_pngs + empty shaders
    pub include_armature: bool,        // off → asset.skeleton = None, no clips
    pub extra_clips: Vec<ClipPick>,    // additional animset clips to merge
    pub texture_max_dim: Option<u32>,  // None or u32::MAX → original res
}

pub struct ClipPick {
    pub animset_hash: String,          // hex like "0xD6013737654DEE32"
    pub clip_indices: Vec<u32>,        // empty = "all clips in this animset"
}
```

The Rust handler:
1. Detects `LevelLayout` from the marker file in the folder, then
   re-loads the moby through the matching parser:
   - V2: `lunalib::read_moby_assets_with_total(level, Some(&[tuid]), ...)`
   - RFOM: `lunalib::read_mobys_rfom(...)` against `ps3levelmain.dat`
   - TOD: `lunalib::read_mobys_old(...)` against `main.dat`
   - Falls back to the matching tie reader if not found in the moby pool.
2. Strips `asset.skeleton` if `!include_armature`.
3. Picks shaders + textures based on `include_materials` and `texture_max_dim`.
   Shader/texture readers are also layout-dispatched
   (`read_shaders` vs `read_shaders_rfom` vs `read_shaders_old`,
   `bulk_extract_pngs` vs `read_textures_rfom` vs `read_textures_old`).
4. Decodes animation clips:
   - V2: from the moby's primary animset.
   - RFOM: from inline anim offsets via `decode_clips_for_moby_inline("ps3levelmain.dat")`.
   - TOD: skipped (T-pose only — frame format unsolved).
5. Walks `extra_clips`; for each pick, decodes the requested clips from
   the chosen animset using **this skeleton's** quantization shifts (since
   the bones we're targeting are this skeleton's bones). On RFOM/TOD
   `extra_clips` is effectively empty because there are no animsets to
   pick from.
6. Calls `lunalib::write_moby_glb_full(asset, &all_clips, &shaders, &texture_pngs)`.
7. Writes the result to `out_path`.

## Texture quality presets

| Preset | `texture_max_dim` | Source |
|---|---|---|
| Low | `256` | Cached `_rechimera_cache/textures/{id}.png`, then `lunalib::downsample_png_to(bytes, 256)` |
| Medium | `512` | Cached PNGs (already at the cache cap), no resize needed |
| High | `1024` | Re-extracted via `lunalib::bulk_extract_pngs(level, &needed_ids, 1024)` |
| Original | `u32::MAX` | Re-extracted at full source res, no cap |

The split at 512 is intentional: anything at or below the cache cap can
read the cached PNGs (instant). Anything above has to bypass the cache
and re-decode the source `textures.dat` block at the requested
resolution. Slower (~seconds per export) but unlocks the full PS3
fidelity for high-quality exports.

## Multi-step Export modal

`ExportOptionsModal.tsx` — opened by the Cache Library's **Export**
button. Two visible steps + a saving step:

### Step 1 — Scope

Three checkboxes:
- ☑ **Mesh** — vertex / index buffers
- ☑ **Materials & textures** — when on, reveals the **Texture quality**
  picker (Low / Medium / High / Original)
- ☑ **Armature** — bones + IBMs. Disabled if the asset has no skeleton.
  Off implies "no animations" (the second-step UI greys out animations
  when armature is off).

### Step 2 — Animations

Lists every animset in the level via `listAnimsets(folder)`:

- The moby's **primary animset** (matched by `animset_hash`) appears
  first, highlighted, expanded by default, all clips pre-checked.
- Other animsets are collapsed by default; expanding shows clip names
  with `(num_frames f @ frame_rate fps · loop?)` metadata.
- Per-animset tri-state checkbox toggles all clips in that animset.
- "All / None" button per animset for explicit batch toggle.
- The footer button shows the live total clip count: **Export (N clips)**.

### Step 3 — Saving

After clicking Export:
1. Native save dialog (`@tauri-apps/plugin-dialog::save`).
2. Builds the `GlbExportOptions` payload from the form state.
3. Invokes `exportMobyGlbWithOptions(folder, tuid, path, options)`.
4. Shows the byte count / final path or an error message.

## Integration with the GLB preview burger menu

The burger menu in `views/GlbPreview.tsx` (described in
[`03-frontend.md`](03-frontend.md)) writes its checkbox selections into
a `previewPicks` state object held by `CacheLibraryModal`. When the
user clicks Export, that state is passed to `ExportOptionsModal` as
`initialExtraPicks`, so the modal opens with whatever the user already
ticked in the burger menu pre-checked. The modal is the source of
truth for the final payload — the user can still add/remove from the
modal's UI before confirming.

## Why bypass the cache for High/Original

The cache stores PNGs at `TEXTURE_MAX_DIM = 512` to keep `_rechimera_cache/`
manageable on disk (a level can have 1000+ textures). Loading a 512px
PNG and "scaling up" can't recover detail that was thrown away during
the cache build, so for High (1024) and Original we re-decode the
source `textures.dat` block. The trade-off is: cache stays small,
exports take a few extra seconds but get full quality.

This is the same `lunalib::bulk_extract_pngs` function the cache itself
calls (V2 layout) — just with a larger `max_dim` argument. The single
function serves both call sites identically. RFOM and TOD use their
own layout-specific texture readers (`read_textures_rfom`,
`read_textures_old`) which take the same `max_dim` parameter and
behave identically from the export modal's perspective.

## Full-map GLB export (`export_level_glb`)

The toolbar's "Export Level GLB" button bakes the entire scene into a
single static GLB. Implementation: `cache.rs::run_export_level_glb`.
It does **not** re-parse `.dat` files — it reads back the JSON DTOs
written to `_rechimera_cache/` by the cache pipeline, decodes the
base64 vertex/UV/index buffers, and stitches them into one big
`level_glb::write_static_level_glb` payload.

Streams `LevelGlbExportEvent`:

```rust
enum LevelGlbExportEvent {
    Phase { label: &'static str, total: usize },
    Progress { current: usize },
    Done { bytes_written: usize, instance_count: usize, asset_count: usize },
    Error { message: String },
}
```

### What gets baked

| Kind | Source folder | Notes |
|---|---|---|
| Mobys | `mobys/*.json` | Geometry only (no skinning) — full-map GLB is static |
| Ties | `ties/*.json` | All world-placed static props |
| Details | `details/*.json` | RFOM debris clusters, routed through `kind: "detail"` |
| Shrubs | `shrubs/*.json` | RFOM mesh vegetation, `kind: "shrub"` |
| Foliage | `foliage/*.json` | RFOM branch meshes + sprite quads, `kind: "foliage"` |
| UFrags (terrain) | `ufrags/*.json` | Each becomes its own asset+instance at its world position |
| Skybox dome | (re-runs `read_skybox_rfom`) | Dome geometry with spherical UVs added in-place |
| Textures | `textures/*.png` | Only those referenced by the baked submeshes |

Foliage descriptors with TWO submeshes (branch + sprite) carry both
through to the final GLB as separate primitives sharing one material.

### Diagnostic line

After the placement loop, the exporter logs:
```
[level-glb] placements baked: N mobys, N ties, N details, N shrubs, N foliage
```
Useful when a level looks "missing" something — confirms whether the
issue is at extraction time (missing JSONs in cache) or export time
(missing routing for a kind).
