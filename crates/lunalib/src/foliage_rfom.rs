//! RFOM foliage (sprite + branch vegetation) reader. Ports IT's
//! `FoliageToGltf` at `levelmain/extract.cpp:929` for the branch-mesh
//! path. Sprite rendering is omitted for now — that's a billboarded
//! quad system that needs special handling in the viewport.
//!
//! Two sections:
//! - **`0xC200` Foliage** (288 bytes each) — mesh + sprite descriptors. Holds
//!   indexOffset, branchVertexOffset, branchLods[4], spriteVertexOffset,
//!   spriteLodRanges[6], spritePositions ptr, spriteRanges[8].
//! - **`0x9700` FoliageInstance** (224 bytes each) — placement: Matrix44 +
//!   pointer to a Foliage. Translation row × YARD_TO_M is world position.
//!
//! Vertex format: `BranchVertex` (20 bytes — per `vertex.hpp:43-48`):
//! - float16 position[4]  (8 bytes, *YARD_TO_M per IT)
//! - float16 uv[2]        (4 bytes)
//! - uint8   tangent[4]   (4 bytes)
//! - uint8   normal[3]    (3 bytes)
//! - 1 byte align to even → 20 bytes
//!
//! Old `lighting_rfom.rs` (also 0xC200) and `envsampler_rfom.rs` (0x9700)
//! were misidentified — they should now no longer be called.

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

        main_ig.stream.seek_to(rec_off + 0x08)?;
        let texture_index = main_ig.stream.read_u32()? as u16;
        let _unk5 = main_ig.stream.read_u32()?;
        let index_off_u16 = main_ig.stream.read_u32()?;
        let _null0 = main_ig.stream.read_u32()?;
        let branch_vertex_off = main_ig.stream.read_u32()? as u64;
        let _unk1 = main_ig.stream.read_u32()?;

        // branchLods[4] starts at +0x20
        let mut branch_lods: [(u32, u16); 4] = [(0, 0); 4];
        for slot in branch_lods.iter_mut() {
            let idx_off = main_ig.stream.read_u32()?;
            let num_indices = main_ig.stream.read_u16()?;
            let _unk = main_ig.stream.read_u16()?;
            *slot = (idx_off, num_indices);
        }

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
            let rx = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 0], vertex_block[base + 1],
            ]));
            let ry = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 2], vertex_block[base + 3],
            ]));
            let rz = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 4], vertex_block[base + 5],
            ]));
            // skip position[3] (half at +6..+8)
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
        }

        let asset_tuid = rec_off;
        foliage_ptr_to_asset.insert(rec_off, tie_assets.len());
        tie_assets.push(TieAsset {
            tuid: asset_tuid,
            scale: [1.0, 1.0, 1.0],
            meshes: vec![TieMeshGeom {
                shader_index: texture_index,
                vertex_count: num_verts as u16,
                index_count: lod0_num_indices,
                positions,
                uvs,
                indices,
            }],
            shader_tuids: identity_shader_tuids.clone(),
        });
    }

    let mut instances: Vec<TieInstance> = Vec::new();
    let inst_off = u64::from(inst_section.offset);
    let inst_count = inst_section.count as usize;
    let mut sample_logged = 0usize;
    for i in 0..inst_count {
        let rec = inst_off + (i as u64) * FOLIAGE_INSTANCE_SIZE;
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

        // FoliageInstance.foliage ptr is at +0xC4 (after Matrix44=0x40 +
        // float[33]=0x84 → +0xC4)
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
