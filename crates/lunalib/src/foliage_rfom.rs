//! RFOM foliage reader. Ports IT's `FoliageToGltf` (extract.cpp:929-1126).
//! Emits both branch meshes and sprite quads.
//!
//! ## Sections used (all in `ps3levelmain.dat`)
//!
//! ### `0xC200` Foliage — 288 bytes per record, **mesh + sprite descriptor**
//! ```text
//! +0x00..+0x04  u32  unk0
//! +0x04..+0x06  u16  foliageId
//! +0x06..+0x08  u16  unk6
//! +0x08..+0x0C  u32  textureIndex          — material slot
//! +0x0C..+0x10  u32  unk5
//! +0x10..+0x14  u32  indexOffset           — u16-units into shared index buffer (0x9100 in ps3levelverts.dat)
//! +0x14..+0x18  u32  null0
//! +0x18..+0x1C  u32  branchVertexOffset    — byte offset into shared vertex buffer (0x9000)
//! +0x1C..+0x20  u32  unk1
//! +0x20..+0x40  FoliageBranchLod[4]        — 8 bytes each: { u32 indexOffset; u16 numIndices; u16 unk }
//! +0x40..+0x44  u32  spriteVertexOffset    — byte offset into shared vertex buffer (sprite vertex section)
//! +0x44..+0x48  u32  usedSpriteLods        — count, 0..6
//! +0x48..+0xA8  SpriteLodRange[6]          — 16 bytes each: { u32 indexBegin; u32 indexEnd; u32 unk0; f32 unk1 }
//! +0xA8..+0xB8  float unk2[4]              — wind/sway params? unverified
//! +0xB8..+0xBC  PointerX86 spritePositions — file offset to Vector4 array of sprite centers
//! +0xBC..+0xC0  u32  usedSpriteRanges      — count, 0..8
//! +0xC0..+0x100 SpriteRange[8]             — 8 bytes each: { u16 indexBegin; u16 indexEnd; u16 positionsOffset; u16 numSprites }
//! +0x100..+0x120 float unk3[8]             — shader params, not decoded
//! ```
//!
//! ### `0x9700` FoliageInstance — 224 bytes per record, **placement**
//! ```text
//! +0x00..+0x40  es::Matrix44 tm            — world transform (row-major)
//! +0x40..+0xC4  float unk0[33]             — 132 bytes, undecoded
//! +0xC4..+0xC8  PointerX86<Foliage>        — points back at the Foliage descriptor
//! +0xC8..+0xD0  u32 unk1[2]
//! +0xD0..+0xE0  u32 unk[4]
//! ```
//!
//! ## Vertex formats (in `ps3levelverts.dat` shared buffer 0x9000)
//!
//! ### `BranchVertex` — 20 bytes, per IT `vertex.hpp:43-48`
//! ```text
//! +0x00..+0x08  float16 position[4]   — half2-encoded XYZ + ignored W (multiply XYZ by YARD_TO_M)
//! +0x08..+0x0C  float16 uv[2]
//! +0x0C..+0x10  uint8   tangent[4]    — packed octahedral?
//! +0x10..+0x13  uint8   normal[3]
//! +0x13..+0x14  pad to 2-byte align
//! ```
//!
//! ### `SpriteVertex` — 12 bytes, per IT `vertex.hpp:50-54`
//! ```text
//! +0x00..+0x04  float16 spriteSize[2] — corner offset from sprite center (yards)
//! +0x04..+0x08  USVector2 uv          — two u16, normalised 0..65535
//! +0x08..+0x0C  uint32 unk            — IT speculates "prolly normal"
//! ```
//!
//! ## Sprite centers (read via `spritePositions` ptr above)
//!
//! ### `Vector4` — 16 bytes per record, BE f32 (x, y, z, w). W is unused.
//!
//! ## Mislabel history (do not delete)
//!
//! Sections `0xC200` and `0x9700` were previously routed through
//! `lighting_rfom.rs` and `envsampler_rfom.rs` respectively. Those readers
//! were producing bogus light/env-probe instances at world origin because
//! the data layouts don't match those types. Both readers still exist but
//! are no longer called from `level_layout` (see main.rs).

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;
use crate::math::decompose_row_major;
use crate::moby::half_to_f32;
use crate::tie::{TieAsset, TieMeshGeom};
use crate::zone::TieInstance;

const SECT_FOLIAGE: u32 = 0xC200;
const SECT_FOLIAGE_INSTANCE: u32 = 0x9700;
const SECT_LEVEL_VERTEX_BUFFER: u32 = 0x9000;
const SECT_LEVEL_INDEX_BUFFER: u32 = 0x9100;
const SECT_MATERIAL_V1: u32 = 0x5001;

const FOLIAGE_SIZE: u64 = 288;
const FOLIAGE_INSTANCE_SIZE: u64 = 224;
const BRANCH_VERTEX_STRIDE: usize = 20;

const YARD_TO_M: f32 = 0.9144;

pub fn read_foliage_rfom(
    level_folder: &Path,
) -> Result<(Vec<TieAsset>, Vec<TieInstance>)> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut main_ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let foliage_section = match main_ig.section(SECT_FOLIAGE) {
        Some(s) => s,
        None => return Ok((Vec::new(), Vec::new())),
    };
    let inst_section = match main_ig.section(SECT_FOLIAGE_INSTANCE) {
        Some(s) => s,
        None => return Ok((Vec::new(), Vec::new())),
    };
    if foliage_section.length != FOLIAGE_SIZE as u32 {
        eprintln!(
            "warn: RFOM foliage section length is {} (expected {}) — skipping",
            foliage_section.length, FOLIAGE_SIZE
        );
        return Ok((Vec::new(), Vec::new()));
    }
    if inst_section.length != FOLIAGE_INSTANCE_SIZE as u32 {
        eprintln!(
            "warn: RFOM foliage-instance section length is {} (expected {}) — skipping",
            inst_section.length, FOLIAGE_INSTANCE_SIZE
        );
        return Ok((Vec::new(), Vec::new()));
    }

    let global_material_count = main_ig
        .section(SECT_MATERIAL_V1)
        .map(|s| s.count)
        .unwrap_or(0) as usize;
    let identity_shader_tuids: Vec<u64> =
        (0..global_material_count as u64).collect();

    let verts_path = level_folder.join("ps3levelverts.dat");
    let mut verts_ig = IgFile::open(BufReader::new(File::open(&verts_path)?))?;
    let vertex_section = verts_ig
        .section(SECT_LEVEL_VERTEX_BUFFER)
        .ok_or(crate::error::Error::SectionNotFound(SECT_LEVEL_VERTEX_BUFFER))?;
    let index_section = verts_ig
        .section(SECT_LEVEL_INDEX_BUFFER)
        .ok_or(crate::error::Error::SectionNotFound(SECT_LEVEL_INDEX_BUFFER))?;
    let vbuf_off = u64::from(vertex_section.offset);
    let ibuf_off = u64::from(index_section.offset);
    let vbuf_len = u64::from(vertex_section.length);
    let ibuf_len = u64::from(index_section.length);

    let foliage_section_off = u64::from(foliage_section.offset);
    let foliage_count = foliage_section.count as usize;
    let log_probes = std::env::var("RECHIMERA_LOG_PROBES").is_ok();
    if log_probes {
        eprintln!(
            "[rfom-foliage] {} Foliage descriptors @ 0xC200, {} FoliageInstance @ 0x9700",
            foliage_count, inst_section.count
        );
    }

    let mut tie_assets: Vec<TieAsset> = Vec::with_capacity(foliage_count);
    let mut foliage_ptr_to_asset: HashMap<u64, usize> = HashMap::new();
    let mut skipped = 0usize;

    for f in 0..foliage_count {
        let rec_off = foliage_section_off + (f as u64) * FOLIAGE_SIZE;

        // ---- Foliage header read, skipping +0x00..+0x08 (unk0 + ids) ----
        main_ig.stream.seek_to(rec_off + 0x08)?;
        let texture_index = main_ig.stream.read_u32()? as u16; // +0x08 textureIndex
        let _unk5 = main_ig.stream.read_u32()?;                // +0x0C
        let index_off_u16 = main_ig.stream.read_u32()?;        // +0x10 indexOffset (u16-units)
        let _null0 = main_ig.stream.read_u32()?;               // +0x14
        let branch_vertex_off = main_ig.stream.read_u32()? as u64; // +0x18 branchVertexOffset (bytes)
        let _unk1 = main_ig.stream.read_u32()?;                // +0x1C

        // ---- branchLods[4] @ +0x20 (4 × 8B = 32B) ----
        // Each entry: { u32 indexOffset; u16 numIndices; u16 unk }
        let mut branch_lods: [(u32, u16); 4] = [(0, 0); 4];
        for slot in branch_lods.iter_mut() {
            let idx_off = main_ig.stream.read_u32()?;     // +0x00 (within entry)
            let num_indices = main_ig.stream.read_u16()?; // +0x04
            let _unk = main_ig.stream.read_u16()?;        // +0x06
            *slot = (idx_off, num_indices);
        }

        // ---- spriteVertexOffset @ +0x40 ----
        // Bytes offset into ps3levelverts.dat 0x9000 vertex buffer.
        // The branch vertex count is derived from the byte gap between
        // branchVertexOffset and spriteVertexOffset (see below).
        main_ig.stream.seek_to(rec_off + 0x40)?;
        let sprite_vertex_off = main_ig.stream.read_u32()? as u64;

        // IT only emits LOD 0 (the comment says "only 1 lod"). Mirror that.
        let (lod0_idx_off, lod0_num_indices) = branch_lods[0];
        if lod0_num_indices == 0 || branch_vertex_off >= sprite_vertex_off {
            skipped += 1;
            continue;
        }

        // numVertices comes from the byte gap between branch and sprite verts.
        let num_verts = ((sprite_vertex_off - branch_vertex_off) / BRANCH_VERTEX_STRIDE as u64) as usize;
        if num_verts == 0 || num_verts > 0x10000 {
            skipped += 1;
            continue;
        }

        // Compute absolute byte offset for indices: indexOffset is in u16 units,
        // and each branch LOD's indexOffset is relative to the foliage's main indexOffset.
        let i_start_units = u64::from(index_off_u16) + u64::from(lod0_idx_off);
        let i_byte_off = i_start_units * 2;
        let i_byte_len = u64::from(lod0_num_indices) * 2;
        let v_byte_len = (num_verts * BRANCH_VERTEX_STRIDE) as u64;
        if i_byte_off + i_byte_len > ibuf_len
            || branch_vertex_off + v_byte_len > vbuf_len
        {
            eprintln!(
                "warn: RFOM foliage[{f}] geometry out of range (i={:#X}+{}, v={:#X}+{}) — skipping",
                i_byte_off, i_byte_len, branch_vertex_off, v_byte_len
            );
            skipped += 1;
            continue;
        }

        verts_ig.stream.seek_to(ibuf_off + i_byte_off)?;
        let mut indices: Vec<u32> = Vec::with_capacity(lod0_num_indices as usize);
        for _ in 0..lod0_num_indices {
            indices.push(u32::from(verts_ig.stream.read_u16()?));
        }

        verts_ig.stream.seek_to(vbuf_off + branch_vertex_off)?;
        let vertex_block = verts_ig.stream.read_bytes(v_byte_len as usize)?;

        let mut positions: Vec<f32> = Vec::with_capacity(num_verts * 3);
        let mut uvs: Vec<f32> = Vec::with_capacity(num_verts * 2);
        for k in 0..num_verts {
            let base = k * BRANCH_VERTEX_STRIDE;
            // BranchVertex byte layout (20 B total — see file header doc):
            //   +0x00..+0x02  half  position.x
            //   +0x02..+0x04  half  position.y
            //   +0x04..+0x06  half  position.z
            //   +0x06..+0x08  half  position.w  (ignored)
            //   +0x08..+0x0A  half  uv.u
            //   +0x0A..+0x0C  half  uv.v
            //   +0x0C..+0x10  u8[4] tangent       (octahedral?)
            //   +0x10..+0x13  u8[3] normal
            //   +0x13..+0x14  pad
            let rx = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 0], vertex_block[base + 1],
            ]));
            let ry = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 2], vertex_block[base + 3],
            ]));
            let rz = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 4], vertex_block[base + 5],
            ]));
            // position[3] (w) skipped — unused.
            positions.push(rx * YARD_TO_M);
            positions.push(ry * YARD_TO_M);
            positions.push(rz * YARD_TO_M);
            let u = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 8], vertex_block[base + 9],
            ]));
            let v = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 10], vertex_block[base + 11],
            ]));
            uvs.push(u);
            uvs.push(v);
            // tangent (+0x0C..+0x10) and normal (+0x10..+0x13) currently
            // discarded. If lighting on foliage looks wrong, decode here.
        }

        // Sprite quads. Per IT's FoliageToGltf (extract.cpp:1032-1126), only
        // LOD 0 is emitted. Each sprite is 6 vertices (two triangles forming a
        // flat XY-plane quad) positioned at `centers[i]` with corner offsets
        // from SpriteVertex.spriteSize. IT punts on billboard rotation — emits
        // static geometry. We do the same: cheap, no shader work, looks OK.
        let mut sprite_mesh = read_foliage_sprites(
            &mut main_ig, &mut verts_ig,
            rec_off, sprite_vertex_off,
            ibuf_off, ibuf_len, vbuf_off, vbuf_len,
            u64::from(index_off_u16),
            texture_index,
        ).unwrap_or(None);

        let mut meshes = vec![TieMeshGeom {
            shader_index: texture_index,
            vertex_count: num_verts as u16,
            index_count: lod0_num_indices,
            positions,
            uvs,
            indices,
        }];
        if let Some(sp) = sprite_mesh.take() {
            if log_probes {
                eprintln!(
                    "[rfom-foliage] foliage[{f}] sprite quads: {} verts, {} indices",
                    sp.vertex_count, sp.index_count
                );
            }
            meshes.push(sp);
        }

        let asset_tuid = rec_off;
        foliage_ptr_to_asset.insert(rec_off, tie_assets.len());
        tie_assets.push(TieAsset {
            tuid: asset_tuid,
            scale: [1.0, 1.0, 1.0],
            meshes,
            shader_tuids: identity_shader_tuids.clone(),
        });
    }

    let mut instances: Vec<TieInstance> = Vec::new();
    let inst_off = u64::from(inst_section.offset);
    let inst_count = inst_section.count as usize;
    let mut sample_logged = 0usize;
    for i in 0..inst_count {
        let rec = inst_off + (i as u64) * FOLIAGE_INSTANCE_SIZE;

        // ---- FoliageInstance.tm @ +0x00 (Matrix44 row-major, 64 B) ----
        // Row 0 = X basis (xyz + w padding)
        // Row 1 = Y basis
        // Row 2 = Z basis
        // Row 3 = translation (xyz, w=1)
        main_ig.stream.seek_to(rec + 0x00)?;
        let mut matrix = [0f32; 16];
        for slot in matrix.iter_mut() {
            *slot = main_ig.stream.read_f32()?;
        }
        let (position_raw, scale, quaternion) = decompose_row_major(&matrix);
        let position = [
            position_raw[0] * YARD_TO_M,
            position_raw[1] * YARD_TO_M,
            position_raw[2] * YARD_TO_M,
        ];

        // ---- foliage ptr @ +0xC4 ----
        // The struct layout is: Matrix44 tm (64B = 0x40) + float unk0[33] (132B = 0x84),
        // so the foliage pointer lands at 0x40 + 0x84 = 0xC4.
        // It's a file offset into ps3levelmain.dat that should match one of
        // our Foliage descriptor rec_off values.
        main_ig.stream.seek_to(rec + 0xC4)?;
        let foliage_ptr = main_ig.stream.read_u32()? as u64;
        let Some(&asset_idx) = foliage_ptr_to_asset.get(&foliage_ptr) else {
            // Pointer doesn't match — try first foliage as a fallback (often
            // works for single-foliage levels) so instances still surface.
            if tie_assets.is_empty() {
                continue;
            }
            let asset_tuid = tie_assets[0].tuid;
            instances.push(TieInstance {
                instance_tuid: rec,
                tie_tuid: asset_tuid,
                name: format!("Foliage_{:04X}_fallback", i),
                position,
                quaternion,
                scale,
                bounding_radius: 0.0,
            });
            continue;
        };
        let asset_tuid = tie_assets[asset_idx].tuid;

        if sample_logged < 3 && log_probes {
            eprintln!(
                "[rfom-foliage-inst] [{i}] foliage_ptr=0x{foliage_ptr:X} m=({:.2}, {:.2}, {:.2}) scale=({:.3}, {:.3}, {:.3})",
                position[0], position[1], position[2], scale[0], scale[1], scale[2],
            );
            sample_logged += 1;
        }

        instances.push(TieInstance {
            instance_tuid: rec,
            tie_tuid: asset_tuid,
            name: format!("Foliage_{:04X}_{i:04X}", asset_idx),
            position,
            quaternion,
            scale,
            bounding_radius: 0.0,
        });
    }

    if log_probes {
        eprintln!(
            "[rfom-foliage] surfaced {} foliage meshes + {} placements ({} meshes skipped)",
            tie_assets.len(), instances.len(), skipped
        );
    }

    Ok((tie_assets, instances))
}

/// Read the sprite-quad geometry for one Foliage descriptor. Returns None if
/// the foliage has no sprite data (usedSpriteLods == 0 or pointer invalid).
///
/// Layout of fields used inside the Foliage record:
///   +0x40  u32 spriteVertexOffset   (already known by caller via `sprite_vertex_off`)
///   +0x44  u32 usedSpriteLods
///   +0x48..+0xA8  SpriteLodRange[6]  (16 bytes each: u32 idxBegin, u32 idxEnd, u32 unk0, f32 unk1)
///   +0xB8  PointerX86 spritePositions  (file offset to Vector4 array)
///   +0xBC  u32 usedSpriteRanges
///   +0xC0..+0x100  SpriteRange[8]  (8 bytes each: u16 idxBegin, u16 idxEnd, u16 positionsOffset, u16 numSprites)
///
/// SpriteVertex (12 bytes): float16 spriteSize[2] + USVector2 uv + u32 unk
fn read_foliage_sprites<R: std::io::Read + std::io::Seek>(
    main_ig: &mut IgFile<R>,
    verts_ig: &mut IgFile<R>,
    rec_off: u64,
    sprite_vertex_off: u64,
    ibuf_off: u64,
    ibuf_len: u64,
    vbuf_off: u64,
    vbuf_len: u64,
    foliage_index_off_u16: u64,
    shader_index: u16,
) -> Result<Option<TieMeshGeom>> {
    const SPRITE_VERTEX_STRIDE: usize = 12;

    // usedSpriteLods at +0x44
    // ---- usedSpriteLods @ +0x44 ----
    main_ig.stream.seek_to(rec_off + 0x44)?;
    let used_sprite_lods = main_ig.stream.read_u32()? as usize;
    if used_sprite_lods == 0 {
        return Ok(None);
    }

    // ---- SpriteLodRange[0] @ +0x48 (16 B) ----
    // IT only emits LOD 0 (it does `break;` after the first iteration in
    // FoliageToGltf line ~1125). We mirror that for simplicity.
    //   +0x00..+0x04  u32 indexBegin  — sprite-index window for this LOD
    //   +0x04..+0x08  u32 indexEnd
    //   +0x08..+0x0C  u32 unk0
    //   +0x0C..+0x10  f32 unk1        — likely LOD distance threshold
    main_ig.stream.seek_to(rec_off + 0x48)?;
    let lod_idx_begin = main_ig.stream.read_u32()? as u64;
    let lod_idx_end = main_ig.stream.read_u32()? as u64;
    let _lod_unk0 = main_ig.stream.read_u32()?;
    let _lod_unk1 = main_ig.stream.read_f32()?;

    // ---- spritePositions ptr @ +0xB8 / usedSpriteRanges @ +0xBC ----
    // spritePositions: u32 file offset into ps3levelmain.dat pointing at a
    // packed Vector4 array. Per-range subsets are taken via positionsOffset
    // (byte offset within this packed array).
    main_ig.stream.seek_to(rec_off + 0xB8)?;
    let sprite_positions_off = main_ig.stream.read_u32()? as u64;
    let used_sprite_ranges = main_ig.stream.read_u32()? as usize;
    if sprite_positions_off == 0 || used_sprite_ranges == 0 {
        return Ok(None);
    }

    // ---- SpriteRange[8] @ +0xC0 (8 × 8B = 64 B) ----
    //   +0x00..+0x02  u16 indexBegin       — first index in sprite-range's index window
    //   +0x02..+0x04  u16 indexEnd
    //   +0x04..+0x06  u16 positionsOffset  — byte offset within spritePositions array
    //   +0x06..+0x08  u16 numSprites       — how many centers live in this range
    let mut sprite_ranges: Vec<(u16, u16, u16, u16)> = Vec::with_capacity(used_sprite_ranges.min(8));
    main_ig.stream.seek_to(rec_off + 0xC0)?;
    for _ in 0..used_sprite_ranges.min(8) {
        let idx_begin = main_ig.stream.read_u16()?;
        let idx_end = main_ig.stream.read_u16()?;
        let positions_offset = main_ig.stream.read_u16()?;
        let num_sprites = main_ig.stream.read_u16()?;
        sprite_ranges.push((idx_begin, idx_end, positions_offset, num_sprites));
    }

    let mut out_positions: Vec<f32> = Vec::new();
    let mut out_uvs: Vec<f32> = Vec::new();
    let mut out_indices: Vec<u32> = Vec::new();

    for (idx_begin, idx_end, positions_offset, num_sprites) in sprite_ranges {
        if num_sprites == 0 || idx_end <= idx_begin {
            continue;
        }

        // Indices for this sprite range live in the shared index buffer at
        // foliage.indexOffset (in u16 units) + r.indexBegin..r.indexEnd
        let i_start = foliage_index_off_u16 + u64::from(idx_begin);
        let i_count = u64::from(idx_end - idx_begin);
        let i_byte_off = i_start * 2;
        let i_byte_len = i_count * 2;
        if i_byte_off + i_byte_len > ibuf_len {
            eprintln!(
                "warn: RFOM foliage sprite range index out of range ({:#X}+{} > {})",
                i_byte_off, i_byte_len, ibuf_len
            );
            continue;
        }

        verts_ig.stream.seek_to(ibuf_off + i_byte_off)?;
        let mut raw_indices: Vec<u16> = Vec::with_capacity(i_count as usize);
        let mut max_index: u16 = 0;
        for _ in 0..i_count {
            let v = verts_ig.stream.read_u16()?;
            if v > max_index { max_index = v; }
            raw_indices.push(v);
        }
        let num_sprite_verts = max_index as usize + 1;

        // Sprite vertices start at foliage.spriteVertexOffset (byte offset in
        // shared vertex buffer).
        let v_byte_len = (num_sprite_verts * SPRITE_VERTEX_STRIDE) as u64;
        if sprite_vertex_off + v_byte_len > vbuf_len {
            eprintln!(
                "warn: RFOM foliage sprite range vertex out of range ({:#X}+{} > {})",
                sprite_vertex_off, v_byte_len, vbuf_len
            );
            continue;
        }
        verts_ig.stream.seek_to(vbuf_off + sprite_vertex_off)?;
        let sprite_vblock = verts_ig.stream.read_bytes(v_byte_len as usize)?;

        // ---- Decode SpriteVertex array (12 B per record) ----
        //   +0x00..+0x02  half  spriteSize.x   (corner offset from center, yards)
        //   +0x02..+0x04  half  spriteSize.y
        //   +0x04..+0x06  u16   uv.u           (normalised 0..65535)
        //   +0x06..+0x08  u16   uv.v
        //   +0x08..+0x0C  u32   unk            (IT speculates: normal?)
        let mut sprite_size: Vec<(f32, f32)> = Vec::with_capacity(num_sprite_verts);
        let mut sprite_uv: Vec<(f32, f32)> = Vec::with_capacity(num_sprite_verts);
        for k in 0..num_sprite_verts {
            let base = k * SPRITE_VERTEX_STRIDE;
            let sx = half_to_f32(u16::from_be_bytes([sprite_vblock[base + 0], sprite_vblock[base + 1]]));
            let sy = half_to_f32(u16::from_be_bytes([sprite_vblock[base + 2], sprite_vblock[base + 3]]));
            // USVector2 uv at +0x04 (two u16 normalized? store as-is for now)
            let u = (u16::from_be_bytes([sprite_vblock[base + 4], sprite_vblock[base + 5]]) as f32) / 65535.0;
            let v = (u16::from_be_bytes([sprite_vblock[base + 6], sprite_vblock[base + 7]]) as f32) / 65535.0;
            sprite_size.push((sx, sy));
            sprite_uv.push((u, v));
        }

        // ---- Centers array (Vector4 records, 16 B per sprite) ----
        // File offset = spritePositions ptr (Foliage +0xB8) + this range's
        // positionsOffset. Each Vector4 is 4 × BE f32:
        //   +0x00..+0x04  cx   (world-space sprite center, yards)
        //   +0x04..+0x08  cy
        //   +0x08..+0x0C  cz
        //   +0x0C..+0x10  cw   (ignored)
        let centers_byte_off = sprite_positions_off + u64::from(positions_offset);
        main_ig.stream.seek_to(centers_byte_off)?;
        let mut centers: Vec<[f32; 3]> = Vec::with_capacity(num_sprites as usize);
        for _ in 0..num_sprites {
            let cx = main_ig.stream.read_f32()?;
            let cy = main_ig.stream.read_f32()?;
            let cz = main_ig.stream.read_f32()?;
            let _cw = main_ig.stream.read_f32()?;
            centers.push([cx, cy, cz]);
        }

        // For each sprite i in this range, IT emits 6 vertices using idx[i*6+d]
        // unless the sprite is outside the current LOD's index window.
        // Each emitted vertex's position = centers[i] + (size.x, size.y, 0) yards.
        for sprite_i in 0..(num_sprites as usize) {
            let sprite_index = sprite_i * 6 + idx_begin as usize;
            // LOD-window check (IT punts to LOD 0; we mirror)
            if (sprite_index as u64) < lod_idx_begin
                || (sprite_index as u64) >= lod_idx_end
            {
                continue;
            }
            for d in 0..6 {
                let local = sprite_i * 6 + d;
                if local >= raw_indices.len() {
                    break;
                }
                let v_idx = raw_indices[local] as usize;
                if v_idx >= num_sprite_verts {
                    continue;
                }
                let (sx, sy) = sprite_size[v_idx];
                let (u, v) = sprite_uv[v_idx];
                let c = centers[sprite_i];
                let next_index = out_positions.len() / 3;
                out_positions.push((c[0] + sx) * YARD_TO_M);
                out_positions.push((c[1] + sy) * YARD_TO_M);
                out_positions.push(c[2] * YARD_TO_M);
                out_uvs.push(u);
                out_uvs.push(v);
                out_indices.push(next_index as u32);
            }
        }
    }

    if out_positions.is_empty() {
        return Ok(None);
    }
    let vertex_count = (out_positions.len() / 3) as u16;
    let index_count = out_indices.len() as u16;
    Ok(Some(TieMeshGeom {
        shader_index,
        vertex_count,
        index_count,
        positions: out_positions,
        uvs: out_uvs,
        indices: out_indices,
    }))
}
