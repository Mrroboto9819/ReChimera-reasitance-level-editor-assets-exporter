# 10 — Vegetation & sky (RFOM)

Three small but visible RFOM-specific systems that ship as separate
parser modules.

## Modules

| What | Source | IT reference | Section IDs |
|---|---|---|---|
| Shrubs (mesh vegetation) | `shrub_rfom.rs` | `levelmain/extract.cpp::ShrubsToGltf` (line 1145) + `classes/shrub.hpp::Shrub` / `Shrubs` / `ShrubCluster` / `ShrubInstance` | `0xC700` mesh, `0xC650` container |
| Foliage (sprite vegetation) | `foliage_rfom.rs` | `levelmain/extract.cpp::FoliageToGltf` (line 929) + `classes/foliage.hpp::Foliage` / `FoliageInstance` | `0xC200` descriptor, `0x9700` placement |
| Skybox dome | `skybox_rfom.rs` | (no IT reference — reverse-engineered) | `0x9150` verts, `0xDA00` descriptor |

All three use the shared level vertex/index buffers (`ps3levelverts.dat`
sections `0x9000` / `0x9100`) and the same `YARD_TO_M` (0.9144) scaling
as detail clusters.

## Vertex format gotcha

Both `ShrubVertex` (16 B) and `BranchVertex` (20 B) declare position as
`int16[4]` in `vertex.hpp`, but the runtime attribute descriptors in
`ShrubsToGltf` / `FoliageToGltf` use `R16G16B16A16 FLOAT` — i.e. the
positions are **half-precision floats**, not signed integers. Reading as
i16 produces a single ~30 km mesh covering the whole map because raw
values like 32000 multiplied by `YARD_TO_M` land in the kilometre range.

This is documented inline in both modules with a `CRITICAL` note next to
the vertex decode loop.

## Shrubs (`shrub_rfom.rs`)

`Shrub` (`0xC700`, 48 B) holds per-mesh metadata: vertex/index buffer
offsets, the wind-sway params (currently unused), and a material index.
The level had **one** Shrub on the test map; bigger levels can have many.

`Shrubs` (`0xC650`, single record, 9472 B in the test level) is the
instance container. It owns:
- A `ShrubCluster[]` array (80 B per record). Each cluster references
  up to 16 shrub-mesh indices via a `shrubsMask` u16 (bit `i` set ⇒
  the cluster uses shrub index `15 - i`) and walks `localRanges[4]` —
  pairs of `{count, offset}` u8 fields — to figure out how many
  `Vis[]` records each referenced shrub claims.
- A `ShrubInstance[]` array ("Vis()" in IT terminology, 64 B per record)
  holding per-instance world-space position, scale, and r1/r2 basis
  rows. r3 (basis Z) is reconstructed as `r1 × r2` cross product.

The cluster's own `tm` matrix is **ignored** for placement (IT does the
same) — each `ShrubInstance.position` is already in world-yards.

## Foliage (`foliage_rfom.rs`)

`Foliage` (`0xC200`, 288 B) is the **mesh + sprite descriptor**. It
holds:

- A texture index + branch vertex offset for the mesh path
- `branchLods[4]` (8 B each) — index ranges for 4 LOD levels of the
  branch geometry
- A sprite vertex offset + `spriteLodRanges[6]` + `spriteRanges[8]`
  (8 B each) for the sprite-quad path
- A `spritePositions` pointer to a packed `Vector4[]` array of sprite
  centres

`FoliageInstance` (`0x9700`, 224 B) is the placement record:
`es::Matrix44 tm` at +0x00, then 132 bytes of unknown data, then a
`PointerX86<Foliage>` at +0xC4 that matches one of the Foliage
descriptors.

### Sprite emit

IT's `FoliageToGltf` punts on billboard rotation — it emits sprites as
flat XY-plane quads at `centers[i] + (size.x, size.y, 0)`. We mirror
that: cheap, no shader work, and the visual loss vs proper
camera-facing billboards is minor for static screenshots / Blender
imports. If a sprite shader is needed in the viewport later, the data
is all there.

### Mislabel history

Section IDs `0xC200` and `0x9700` were originally routed through
`lighting_rfom.rs` and `envsampler_rfom.rs` respectively, producing
bogus light/env-probe instances at world origin. The mislabel was caught
when an IT lookup found the actual struct definitions in
`foliage.hpp:42-72`. Both legacy readers still exist but are no longer
called from `level_layout` — they're kept around so the manifest schema
doesn't break for older caches.

## Skybox (`skybox_rfom.rs`)

No IT reference exists for the skybox path. We reverse-engineered:

- `0x9150` — array of dome vertices, 16 B each (3 × f32 BE + ignored W)
- `0xDA00` — single 336-byte sky descriptor. Most of the layout is
  unknown; we only pull the suspected texture-offset field at `+0x74`
  (an `u32` that *looks* like a file offset but hasn't been
  cross-verified against the actual texture table).

The dome is triangulated heuristically: for each vertex, find the 6
nearest neighbours, and emit a triangle when 3 vertices are mutually
adjacent. Winding is chosen by comparing the face normal with the
centroid-to-face vector. This produces a watertight-ish dome for ~800
vertices but may miss triangles near the rim — IT's original engine
probably streams indices from elsewhere.

The exported GLB places the dome at its raw position (not centred on
origin), so Blender / Godot importers might place it at a confusing
offset. For a runtime skybox in the viewport this doesn't matter — the
dome should follow the camera regardless.

## Where the data lands

All three feed `tie_assets_for_glb` so the cache writer, manifest, and
full-map exporter handle them identically to ties / details. Manifest
kinds:
- `kind: "shrub"` — files at `_rechimera_cache/shrubs/0x{tuid}.json`
- `kind: "foliage"` — `_rechimera_cache/foliage/0x{tuid}.json`
- `kind: "sky"` — `_rechimera_cache/skybox/sky.{glb,obj,ply,json}`

UI surfaces are wired in `Hierarchy.tsx` (KIND_LABELS / KIND_GLYPHS),
`Viewport.tsx` (`AssetGroup` + `ProxyPlacementGroup` rendering, toolbar
toggles), and `SettingsModal.tsx` (color picker rows).
