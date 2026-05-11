# 08 — GLB writer (`gltf_export.rs`)

Source: `crates/lunalib/src/gltf_export.rs`, plus `math.rs` for the
col-major decompose used to emit bone nodes.

IT references — every section below mirrors the same logic in IT:
- `extract/extract_gltf.cpp` — `MobyToGltf`, `GenerateSkeleton`, the per-segment glTF Mesh emission.
- `common/src/gltf_shared.cpp` — `LoadAnimations`, `Instantiate`, the per-bone TRS write-back.

The user-facing options layer (`export_moby_glb_with_options`, the
multi-step modal, texture quality presets) lives on the **app** side
and is documented at [`../app/02-cache.md`](../app/02-cache.md) +
[`../app/03-frontend.md`](../app/03-frontend.md).

The writer is **engine-agnostic**. It takes a `MobyAsset`,
`DecodedClip`s, shaders, and textures — all of which are produced in
the same shape by the V2 / RFOM / TOD parser families. There is no
V2/RFOM/TOD branch inside this file. Per-engine differences are
absorbed upstream in the parser modules; by the time bytes reach
`write_moby_glb_full`, the only knob that varies is whether `clips`
is non-empty (V2 always, RFOM usually, TOD currently never).

## Two entry points

```rust
pub fn write_moby_geometry_glb(asset: &MobyAsset) -> Result<Vec<u8>>
pub fn write_moby_glb_full(
    asset: &MobyAsset,
    clips: &[DecodedClip],
    shaders: &HashMap<u64, ShaderInfo>,
    textures: &HashMap<u32, Vec<u8>>,
) -> Result<Vec<u8>>
```

`write_moby_geometry_glb` is `write_moby_glb_full(asset, &[], &empty, &empty)`.
The cache pipeline always calls the full one with the moby's primary
animset clips and the union of textures referenced by its primitives.

Tie assets go through the same writer via `cache::tie_as_moby` —
single-bangle, no-skeleton.

## Scene structure we emit

```
glTF Root
├── scenes[0]
│   └── nodes: [ asset_root ]
└── nodes
    ├── [0] asset_root          (no mesh, no skin — just a container)
    ├── [1..1+B] bone_0 .. bone_(B-1)   (each TRS-decomposed Node, parented per skeleton)
    └── [1+B..]   Mesh_0 .. Mesh_(N-1)   (one node per non-empty bangle)
        each: { mesh: Index(...), skin: Some(0), parent: asset_root }
```

This matches IT's `MobyToGltf` (`extract_gltf.cpp:222-333`) where each
`MobySegment` becomes one `glNode` + one `glMesh`. The previous version
of our writer flattened every primitive into a single Mesh, producing a
single monolithic Blender Object — fixed.

## Bone nodes (TRS, not matrix)

For each bone `i`:

```rust
let local = clean_rigid(skel.bind_local[i]);
let (translation, scale, quat) = decompose_col_major(&local);
nodes.push(Node {
    matrix: None,
    translation: Some(translation),
    rotation:    Some(UnitQuaternion(quat)),
    scale:       Some(scale),
    name: Some(format!("bone_{i}")),
    ...
});
```

Why TRS and not `matrix`:
- glTF spec: `Node` cannot have both `matrix` AND `translation/rotation/scale`.
- Animation channels can only target T/R/S, not `matrix`.
- Even just `matrix` alone fails validation if it isn't a clean rigid
  transform (PS3 FP noise → `NODE_MATRIX_NON_TRS`).

IT does the same in `GenerateSkeleton` (`extract_gltf.cpp:21-32`):

```cpp
tm.r4() *= YARD_TO_M;
tm.r1().w = 0;
tm.r2().w = 0;
tm.r3().w = 0;
tm.r4().w = 1;
Vector4A16 rotation, translation, scale;
tm.Decompose(translation, rotation, scale);
memcpy(glNode.rotation.data(),    &rotation,    16);
memcpy(glNode.translation.data(), &translation, 12);
memcpy(glNode.scale.data(),       &scale,       12);
```

(We do not currently apply the `YARD_TO_M` factor — see [Coordinates](#coordinates) below.)

## IBM cleanup (`pack_ibms`)

The `inverseBindMatrices` accessor is built from `skel.bind_world_inverse`
(= `tms1` cleaned). We additionally clamp the bottom row to `(0,0,0,1)`
and replace any non-finite value with `0.0`:

```rust
ibm[3] = 0.0; ibm[7] = 0.0; ibm[11] = 0.0; ibm[15] = 1.0;
for v in ibm {
    let cleaned = if v.is_finite() { v } else { 0.0 };
    ...
}
```

IT does the same `r4() *= YARD_TO_M; r1.w = 0; …; r4.w = 1` (`extract_gltf.cpp:148-153`).

## Materials & textures (`build_material`)

For each primitive in each bangle:

```rust
let material_idx = build_material(
    bin, views, images, gltf_textures, materials,
    image_idx_by_tex_id,
    asset.shader_tuids, shaders, texture_pngs,
    mesh.shader_index,
);
primitives.push(push_submesh(..., material_idx));
```

`build_material`:
1. Resolves the shader to its `albedo_tex_id` via `resolve_shader_textures`.
2. If the corresponding PNG is in `texture_pngs`, embeds it as a glTF
   `Image` (via a `BufferView` so Blender doesn't need to fetch
   externally).
3. Caches `albedo_id → image_idx` in `image_idx_by_tex_id` so reused
   textures don't get embedded twice.
4. Pushes one `Texture` per `Image` (1:1), then one `Material`
   referencing that texture as `pbrMetallicRoughness.baseColorTexture`.

Bug history: previously `texture_idx` was computed as
`gltf_textures.len() - 1`, which on the second call for the same albedo
(cache hit, no new texture pushed) returned the *most recently pushed*
texture — which belonged to a different material. Result: textures
swapped between body parts that shared albedos. Fix:
`texture_idx = image_idx` since images and textures are emitted 1:1.

## Animations (`emit_animations`)

```rust
fn emit_animations(
    bin, accessors, views, animations,
    clips: &[DecodedClip],
    bone_node_base: u32,
    bone_count: usize,
)
```

For each clip:
1. Build a single time accessor (`[0, 1/fps, 2/fps, ...]`) plus one for
   static (`[0]`).
2. For each bone, for each of `rotations` / `translations` / `scales`
   that's non-empty, push one Sampler + one Channel. Static (one-frame)
   tracks reuse the `[0]` time accessor.
3. Push the Animation with `name = clip.name` so Blender shows it as a
   separate Action in the NLA editor.

This mirrors IT's `LoadAnimations` (`gltf_shared.cpp:585-622`).

## Multi-mesh, single-skin

All bangle nodes share `skin: Some(0)`. The single Skin references every
bone Node as a joint. Blender imports this as **multiple Mesh Objects
parented to a single Armature** — the standard skinned-character layout.

The same multi-submesh pattern is used by **foliage** assets, except
unskinned: each `Foliage` descriptor emits two submeshes inside a single
`TieAsset` — the branch geometry (decoded `BranchVertex` triangles) and
the sprite quads (flat XY-plane quads at sprite centres). Both share the
same material slot since they reference the same `Foliage.textureIndex`.
The viewport / GLB writer treats them as two primitives on one mesh and
neither needs a skin reference.

## Static level-scope writer (`level_glb.rs`)

`gltf_export.rs` covers **per-asset** GLB writes (one moby or tie at a
time, skinned + animated). For the toolbar's *Export Level GLB* button
we use a separate writer, `level_glb::write_static_level_glb`, that
packs the entire scene into a single static GLB:

- Each unique `(asset_tuid, kind)` becomes one `LevelGlbAsset` with
  its submeshes' positions / UVs / indices flattened into one binary
  blob.
- Each placement becomes a `LevelGlbInstance` referencing the asset
  index plus its world transform (translation + rotation quaternion +
  scale).
- Textures land as PNG-embedded glTF images shared across instances.

There is **no skeleton, no skinning, no animation** in the level-scope
writer — it's pure static geometry suitable for drag-into-Godot /
Blender level dressings. Skinned characters belong in their own
per-moby GLB (the per-asset writer above) and are loaded separately by
the consumer game engine.

For full call flow + the list of asset kinds the level writer accepts,
see [`app/05-export-pipeline.md`](../app/05-export-pipeline.md#full-map-glb-export-export_level_glb).

## Coordinates

- We emit raw yards (`int16 * meshScale`). IT additionally multiplies
  by `YARD_TO_M = 0.9144` so the output is in metres. Net effect on a
  Blender import: a ReChimera-exported character is `~9.4%` larger than
  an IT-exported one, but proportions and skinning are identical.
- We do not transpose any matrices. PS3 stores col-major col-vector
  matrices, glTF expects col-major col-vector matrices, Three.js
  expects col-major col-vector matrices — bytes pass through unchanged
  except for the rigid-bottom-row cleanup. IT does likewise.

## Validator status after the fixes

What used to be 18,000+ glTF-validator warnings on the Hybrid asset is
now zero. Specifically:

| Was | Why | Fixed by |
|---|---|---|
| 46× `NODE_MATRIX_NON_TRS` | Bone matrices weren't decomposable | TRS decomposition + bottom-row clamp |
| 165× `ANIMATION_CHANNEL_TARGET_NODE_MATRIX` | Channels targeted a node with matrix | Removed `matrix`, set T/R/S |
| 108× `ACCESSOR_INVALID_IBM` | IBM W components had FP noise | `pack_ibms` clamps + finite-check |
| 18,180× `ACCESSOR_JOINTS_USED_ZERO_WEIGHT` | Joint != 0 with weight = 0 | Force `joint = 0` when `weight = 0` (in `decode_moby_mesh`) |
| 30× `ACCESSOR_INVALID_FLOAT` | NaN in animation tracks | `2^scale_shift` → `1/(0x8000>>shift)` |
