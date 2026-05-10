# 04 — Moby & tie geometry

Sources by engine era:

| Engine | Moby parser | Tie parser | Asset entry |
|---|---|---|---|
| **V2** (R2 / R3 / R&C: FFA / R&C: A4O) | `crates/lunalib/src/moby.rs` | `crates/lunalib/src/tie.rs` | `assetlookup.dat` + per-kind sibling `.dat` files |
| **RFOM** (Resistance: Fall of Man) | `crates/lunalib/src/moby_rfom.rs` | `crates/lunalib/src/tie_rfom.rs` | `ps3levelmain.dat` (single bundled IGHW) |
| **TOD** (R&C: Tools of Destruction) | `crates/lunalib/src/moby_old.rs` | `crates/lunalib/src/tie_old.rs` | `main.dat` (embeds asset tables) |

All three produce the **same `MobyAsset` struct** (defined in `moby.rs`) so the cache pipeline, GLB writer, and modal preview don't have to branch by engine. Layout dispatch happens at `read_moby_assets_*` entry points based on `LevelLayout` (see `level_layout.rs`).

A **moby** is an animated asset (characters, weapons, props that move).
A **tie** is a static prop (placed instances, no skeleton).

## Moby asset shape

```rust
pub struct MobyAsset {
    pub tuid: u64,                       // 64-bit asset hash
    pub name: String,                    // path-style, e.g. "entities/character/enemy/adv_hybrid/..."
    pub bangles: Vec<MobyBangle>,        // a.k.a. "segments" in IT
    pub bsphere_position: [f32; 3],
    pub bsphere_radius: f32,
    pub shader_tuids: Vec<u64>,          // global shader id table
    pub skeleton: Option<Skeleton>,      // optional — prop mobys may have no skeleton
    pub animset_hash: Option<u64>,
    pub bind_pose_inverse_offset: i16,
}

pub struct MobyBangle {
    pub meshes: Vec<MobyMesh>,           // a.k.a. "primitives" in IT
}

pub struct MobyMesh {
    pub shader_index: u16,               // index into shader_tuids
    pub vertex_count: u16,
    pub index_count: u16,
    pub vertex_stride: u8,               // 0x14 (static) or 0x1C (skinned)
    pub positions: Vec<f32>,             // x,y,z * vertex_count
    pub uvs: Vec<f32>,                   // u,v * vertex_count
    pub indices: Vec<u32>,
    pub bone_indices: Vec<u16>,          // 4 per vertex (slot 0..3)
    pub bone_weights: Vec<u8>,           // 4 per vertex, sum ≈ 255
}
```

Most of this maps 1:1 to IT's `MobyV2 → MobySegment → PrimitiveV2` — we
just renamed segment → bangle and primitive → mesh because the existing
codebase uses those names.

## Header layout (MobyV2 header @ section `0xD100`)

| Offset | Type | Meaning |
|---|---|---|
| `+0x00` | `Vector4` | Bounding sphere (x, y, z, radius) |
| `+0x10` | `int16` | `bindPoseInverseOffset` (animation pos-scale exponent) |
| `+0x18` | `uint16` | `numSegments` (= our `bangle_count`) |
| `+0x24` | `PtrX86<MobySegment>` | Pointer to bangle array |
| `+0x50` | `Hash` | `animsetHash` |
| `+0x70` | `float32` | `meshScale` (multiplier for quantized vertex positions) |
| `+0xB0` | `uint64` | TUID (asset hash) |

## Bangle struct (`MobySegment`, 8 bytes)

```
+0x00  ptr to PrimitiveV2[]
+0x04  u32 numPrimitives
```

## Primitive struct (`PrimitiveV2`, 64 bytes)

| Offset | Type | Meaning |
|---|---|---|
| `+0x00` | `u32` | `indexOffset` (in u16-element units) |
| `+0x04` | `u32` | `vertexOffset` (in bytes) |
| `+0x08` | `u16` | `materialIndex` (== our `shader_index`) |
| `+0x0A` | `u16` | `numVertices` |
| `+0x0C` | `u8` | `numJoints` (per-primitive bone palette length) |
| `+0x0D` | `u8` | `vertexFormat` (0 = static Vertex0, 1 = skinned Vertex1) |
| `+0x10` | `u32` | `numIndices` |
| `+0x20` | `PtrX86<u16>` | bone palette (per-primitive) |

Two earlier-version bugs worth knowing about:
- We previously read `numIndices` as `u16` at `+0x12`, picking up only the
  low 16 bits of the actual `u32` field. Worked for small primitives,
  silently truncated for primitives with more than 65,535 indices.
- The `numJoints` byte and `vertexFormat` byte were correctly placed.

## Vertex layouts

Two formats, selected by `vertexFormat`:

### Vertex0 (static, stride `0x14`)

```
+0x00  i16[3] position
+0x06  i16   purpose          ← encodes the local-palette bone index
+0x08  f16[2] uv0
+0x0C  u32   normal (R11G11B10 NORM)
+0x10  u32   tangent (unused by us)
```

A Vertex0 is bound to **one** bone (the whole primitive shares it). The
`purpose` field is `(int16)(palette_index * 3 - 1)` — we recover via
`abs((purpose + 1) / 3)`. This is IT's exact formula
(`extract_gltf.cpp:167`).

### Vertex1 (skinned, stride `0x1C`)

```
+0x00  i16[3] position
+0x06  i16    unk
+0x08  u8[4]  bone palette indices (slot 0..3)
+0x0C  u8[4]  weights (sum ≈ 255)
+0x10  f16[2] uv0
+0x14  u32    normal
+0x18  u32    tangent
```

The four `u8` indices are local to the primitive's bone palette. They get
remapped to the global skeleton via `bone_map[local]` during decode.

## Bone-palette indirection

Each `PrimitiveV2` has its own bone palette (a `Vec<u16>` of global
skeleton bone indices). A vertex says "I'm bound to slot 2", and slot 2 is
looked up in the palette to get the actual skeleton bone, e.g. bone 46.

This means **the same primitive ID can be bound to different bones in
different primitives** — the renderer must respect the palette per
primitive.

## Joint=0 when weight=0

The glTF spec requires that any vertex slot with `weight = 0` also have
`joint = 0`. PS3 sometimes stores garbage in unused slots. After loading,
we zero them out:

```rust
for i in 0..4 {
    if slot_weights[i] == 0 {
        slot_bones[i] = 0;
    }
}
```

This is what eliminated 18,000 `ACCESSOR_JOINTS_USED_ZERO_WEIGHT` validator
warnings.

## Position scale

Stored positions are `int16 * meshScale`. We multiply at decode time so
downstream code sees plain f32 metres-ish (yards strictly, since IT's
`YARD_TO_M = 0.9144` factor isn't applied — see [`08-gltf-export.md`](08-gltf-export.md)).

## Tie

Ties are a strict subset:
- No skeleton. No animset. No bone palette.
- One global vertex stride (no Vertex1).
- Multiple bangles still possible but typically one per asset.

The cache and GLB pipeline treats ties as "single-bangle, no-skeleton
mobys" via `tie_as_moby` (in `cache.rs`) so the rest of the pipeline
doesn't have to branch.
