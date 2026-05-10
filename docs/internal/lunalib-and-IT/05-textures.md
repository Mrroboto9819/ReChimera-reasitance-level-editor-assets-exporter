# 05 — Textures & materials

Per-engine sources:

| Layout | Texture decoder | Shader / material reader |
|---|---|---|
| V2 (R2 / R3 / RCFFA / RCA4O) | `crates/lunalib/src/texture.rs` | `crates/lunalib/src/shader.rs` |
| RFOM | `crates/lunalib/src/texture_rfom.rs` | `crates/lunalib/src/shader_rfom.rs` |
| TOD | `crates/lunalib/src/texture_old.rs` | `crates/lunalib/src/shader_old.rs` |

Each pair exposes `read_textures_*` and `read_shaders_*` returning the
same `Vec<(u32, png_bytes)>` and `HashMap<u64, ShaderInfo>` shapes, so
the cache pipeline can dispatch on `LevelLayout` once and feed every
downstream consumer engine-agnostic data.

Most of this chapter walks through the V2 path. RFOM and TOD reuse
the same `TexFormat::from_byte` decoder (it covers both R2's
`0x03..0x0A` and FFA's `0x81..0x8B`/`0xA6` ranges — see
`project_texture_format_dual_range` in memory) but with per-engine
metadata layouts and per-engine tile schemes (linear vs Morton).

**IT references**:
- Format enum + per-format byte counts: `classes/shader.hpp::TextureFormat`
  (`R8=0x81, RGB5A1, RGBA4, R5G6B5, RGBA8, BC1, BC2, BC3, RG8=0x8B, BC1_LN=0xA6`).
- The "two-file scheme" (`assetlookup.dat` metadata + `highmips.dat` /
  `textures.dat` payload) is documented in
  `extract/extract_v2.cpp::ExtractTextures` (V2 path) and
  `texture/extract_textures.cpp` (RFOM path).
- Shader → texture id resolution mirrors IT's `MaterialResourceNameLookup`
  (`0x5d00`) walk in `extract/extract_v2.cpp::ExtractShaders`.

## The two-file scheme

Textures live in **two files**:
- `assetlookup.dat` carries the per-texture metadata table (format, mip
  count, dimensions, pointer into `highmips.dat`).
- `highmips.dat` carries the raw mip pyramids, concatenated.

For a clean PNG, we read both, decode, and emit.

## Texture metadata (`assetlookup.dat`, `0x5A00`)

Each entry is 4 bytes:

```
+0x00 u8 format    (TexFormat::from_byte: BC1, BC3, R5G6B5, A8R8G8B8, …)
+0x01 u8 mipCount
+0x02 u8 widthPow  (width  = 1 << widthPow)
+0x03 u8 heightPow (height = 1 << heightPow)
```

There's a parallel pointer table (`0x9800`) with `(tuid, offset, length)`
into `highmips.dat`.

## Decode pipeline

`bulk_extract_pngs(level_folder, wanted_ids, max_dim) -> Vec<(u32, Vec<u8>)>`:

1. Walks the metadata table once.
2. For each requested texture id:
   - Seek into `highmips.dat` at the listed `(offset, length)`.
   - Decode raw bytes → RGBA8.
     - **DXT1 / DXT3 / DXT5** → `texpresso` block decode.
     - **R5G6B5 / A8R8G8B8** → custom decoder + Morton-swizzle inverse.
     - **R8 / RG8 / RGB5A1 / RGBA4** → custom Morton-aware decoders.
     - **BC1_LN** → DXT1 decode without Morton inverse (RFOM linear-tiled).
   - If the result exceeds `max_dim`, downsample with bilinear filter
     (`image::imageops::resize`).
   - Encode to PNG.
3. Returns `Vec<(id, png_bytes)>`.

The whole loop is parallelised with `rayon::par_iter` — texture decode
is embarrassingly parallel and PS3 levels can have 1000+ textures.

## Format byte: two coexisting ranges (R2 + FFA)

`TexFormat::from_byte` accepts **two non-overlapping byte ranges** at
the same time, because Insomniac uses different format-byte spaces in
different games and we have to keep both working:

| Byte range | Source | Games (verified / suspected) |
|---|---|---|
| `0x03..0x0A` | `assetlookup.dat`'s short per-texture metadata enum | **Resistance 2** ✓, likely R3 / R&C ToD |
| `0x81..0x8B` + `0xA6` | PS3 NV4097 hardware byte from the full `Texture` (`0x5200`) struct in `textures.dat`, mirrored from IT's `classes/shader.hpp::TextureFormat` | **R&C: Full Frontal Assault** ✓, likely other later RCF-engine titles |

Mapping example — both `0x05` and `0x85` resolve to `A8R8G8B8`; both
`0x06` and `0x86` resolve to `Dxt1`; etc.

**Do not collapse these into a single mapping.** The two ranges don't
overlap (low ≤ `0x0A`, high ≥ `0x81`), so they live in the same
`match` arm and both games stay functional without any runtime
"which game is this?" branch. Replacing the low range with the high
range would break R2; replacing the high range with the low range
would break FFA. Future game additions should append to whichever
range matches what their on-disk byte uses.

Unknown bytes log a `warn:` line with the byte value so the next
unknown variant is one paste-the-log away from being mapped.

This pattern — **two coexisting non-overlapping mappings, one per
game family, in the same match** — is the recommended shape for any
other lunalib parser when game-version differences appear, *as long
as the on-disk bytes themselves disambiguate*. Prefer this over a
runtime game-detection branch.

## The Morton inversion

PS3 stores R5G6B5 / A8R8G8B8 textures **swizzled** into a Morton order
(Z-order curve). We invert:

```rust
fn unswizzle_morton(x: u32, y: u32) -> usize { /* ... */ }
```

Run that for every output pixel coordinate, sample the source byte at
the swizzled index, write to output. After this the texture is in raster
order and can be PNG-encoded.

## Shader → texture id resolution

A shader (section `0x5600`) maps a moby's `shader_index` to up to three
texture ids:

```rust
pub struct ShaderInfo {
    pub albedo_tex_id: Option<u32>,
    pub normal_tex_id: Option<u32>,
    pub emissive_tex_id: Option<u32>,
}
```

`resolve_shader_textures(shaders, shader_tuids, shader_index)` returns
`(albedo, normal, emissive)`. The cache pipeline calls this to figure out
which textures it actually needs to bake.

## Cache layout

When `extract_level_to_cache` runs, it computes the union of every
texture id any moby/tie references and calls `bulk_extract_pngs` with
that subset and `max_dim = 512` (`TEXTURE_MAX_DIM`). The PNGs land in
`_rechimera_cache/textures/{id}.png`.

512 is a balance — most R2 textures are 256×256 to 1024×1024; 512 keeps
file sizes reasonable while preserving most detail. The export pipeline
can exceed this when the user picks "High" or "Original" quality (see
[`08-gltf-export.md`](08-gltf-export.md)).

## Downsample helper

`downsample_png_to(png_bytes, max_dim) -> Option<Vec<u8>>` is the
public knob:

- Returns `None` if the PNG is already small enough.
- Otherwise decodes → resize (Triangle filter) → re-encodes.
- Handles `max_dim == u32::MAX` ("original, don't downsample") as a
  no-op (returns `None`).

Both the cache step and the export step go through this same helper, so
the resize behaviour is identical regardless of which entry point.
