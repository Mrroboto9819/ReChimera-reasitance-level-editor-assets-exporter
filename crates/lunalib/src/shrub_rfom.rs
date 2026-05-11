//! RFOM shrub reader. Ports IT's `ShrubsToGltf` (extract.cpp:1145-1279).
//!
//! ## Sections used (all in `ps3levelmain.dat`)
//!
//! ### `0xC700` Shrub — 48 bytes per record, **mesh metadata**
//! ```text
//! +0x00..+0x04  u32   vertexBufferOffset  — byte offset into ps3levelverts.dat 0x9000
//! +0x04..+0x08  u32   indexOffset         — u16-units into ps3levelverts.dat 0x9100
//! +0x08..+0x0C  u32   numIndices
//! +0x0C..+0x10  u32   unk0
//! +0x10..+0x20  float unk1[4]             — wind-sway params (not decoded)
//! +0x20..+0x22  u16   materialIndex
//! +0x22..+0x2E  u32   unk2[3]
//! ```
//!
//! ### `0xC650` Shrubs — single record, **instance container**
//! ```text
//! +0x00..+0x04  u32   unk0                — Vis() array length
//! +0x04..+0x08  u32   unkOffset           — byte offset to ShrubInstance array (Vis)
//! +0x08..+0x0C  u32   numInstances        — number of ShrubClusters
//! +0x0C..+0x10  u32   instancesOffset     — byte offset to ShrubCluster array
//! +0x10..+0x60  u32   unk[20]             — flags/sentinels (not decoded)
//! ```
//!
//! ### `ShrubCluster` — 80 bytes per record (inside the Shrubs container)
//! ```text
//! +0x00..+0x40  es::Matrix44 tm           — cluster transform (IGNORED — see note below)
//! +0x40..+0x48  LocalRange[4]             — 4 × { u8 count; u8 offset } pairs
//! +0x48..+0x4C  u32   visOffset           — base index into the Vis array for this cluster
//! +0x4C..+0x4E  u16   shrubsMask          — bitmask: bit i set ⇒ this cluster uses shrub index (15-i)
//! +0x4E..+0x50  u16   unk1
//! ```
//!
//! ### `ShrubInstance` (Vis array entry) — 64 bytes per record
//! ```text
//! +0x00..+0x0C  float position[3]         — world-space (yards) center of one shrub
//! +0x0C..+0x10  float scale
//! +0x10..+0x1C  float r1[3]               — rotation matrix row 1 (basis X)
//! +0x1C..+0x20  float unk0
//! +0x20..+0x2C  float r2[3]               — rotation matrix row 2 (basis Y)
//! +0x2C..+0x40  float unk1[5]             — 20 bytes undecoded
//! ```
//! Note: row 3 (basis Z) is reconstructed as r1 × r2 cross product.
//!
//! ### `ShrubVertex` — 16 bytes (in shared vertex buffer 0x9000)
//! ```text
//! +0x00..+0x08  int16  position[4]        — XYZ + ignored W (multiply XYZ by YARD_TO_M)
//! +0x08..+0x0C  uint8  color[4]           — vertex color (UCVector4, unused for now)
//! +0x0C..+0x10  float16 uv[2]
//! ```
//!
//! ## Cluster→instance walking algorithm
//!
//! Each `ShrubCluster` references up to 16 unique shrub-mesh indices via
//! `shrubsMask`. For every set bit i, the cluster claims a contiguous slice
//! of `Vis()` defined by `localRanges[localId]`:
//!   - `localId` starts at 0 and increments each time we find a set bit.
//!   - The slice is `Vis[visOffset + offset .. visOffset + offset + count]`.
//!   - The shrub-mesh index used by that slice is `15 - i` (per IT).
//!
//! The cluster's own `tm` matrix is ignored — each `ShrubInstance.position`
//! is already in world space, so we use it directly. IT does the same.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;
use crate::moby::half_to_f32;
use crate::tie::{TieAsset, TieMeshGeom};
use crate::zone::TieInstance;

const SECT_SHRUB: u32 = 0xC700;
const SECT_SHRUBS: u32 = 0xC650;
const SECT_LEVEL_VERTEX_BUFFER: u32 = 0x9000;
const SECT_LEVEL_INDEX_BUFFER: u32 = 0x9100;
const SECT_MATERIAL_V1: u32 = 0x5001;

const SHRUB_SIZE: u64 = 48;
const SHRUB_CLUSTER_SIZE: u64 = 80;
const SHRUB_INSTANCE_SIZE: u64 = 64;
const SHRUB_VERTEX_STRIDE: usize = 16;

const YARD_TO_M: f32 = 0.9144;

pub fn read_shrubs_rfom(
    level_folder: &Path,
) -> Result<(Vec<TieAsset>, Vec<TieInstance>)> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut main_ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let shrub_section = match main_ig.section(SECT_SHRUB) {
        Some(s) => s,
        None => return Ok((Vec::new(), Vec::new())),
    };
    let shrubs_section = match main_ig.section(SECT_SHRUBS) {
        Some(s) => s,
        None => return Ok((Vec::new(), Vec::new())),
    };

    if shrub_section.length != SHRUB_SIZE as u32 {
        eprintln!(
            "warn: RFOM shrub section length is {} (expected {}) — skipping",
            shrub_section.length, SHRUB_SIZE
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

    let shrub_section_off = u64::from(shrub_section.offset);
    let shrub_count = shrub_section.count as usize;
    let log_probes = std::env::var("RECHIMERA_LOG_PROBES").is_ok();
    if log_probes {
        eprintln!(
            "[rfom-shrub] {} Shrubs (per-mesh) @ 0x{:X}, container 0xC650 @ 0x{:X} ({}B)",
            shrub_count, shrub_section_off, shrubs_section.offset, shrubs_section.length
        );
    }

    let mut tie_assets: Vec<TieAsset> = Vec::with_capacity(shrub_count);
    let mut shrub_idx_to_asset: HashMap<usize, usize> = HashMap::new();
    let mut skipped = 0usize;

    for s in 0..shrub_count {
        let rec_off = shrub_section_off + (s as u64) * SHRUB_SIZE;

        // ---- Shrub record (48 B) — see file-header doc for full layout ----
        main_ig.stream.seek_to(rec_off + 0x00)?;
        let vertex_buf_off = main_ig.stream.read_u32()? as u64;  // +0x00 vertexBufferOffset (bytes)
        let index_off_u16 = main_ig.stream.read_u32()?;          // +0x04 indexOffset (u16 units)
        let num_indices = main_ig.stream.read_u32()? as u64;     // +0x08 numIndices
        let _unk0 = main_ig.stream.read_u32()?;                  // +0x0C unk0
        // +0x10..+0x20  float unk1[4]  — wind sway parameters (read+discard)
        for _ in 0..4 {
            let _ = main_ig.stream.read_f32()?;
        }
        let material_index = main_ig.stream.read_u16()?;         // +0x20 materialIndex
        // +0x22..+0x2E  u32 unk2[3]  — not read (we already have all we need)

        if num_indices == 0 || num_indices > 0x100000 {
            skipped += 1;
            continue;
        }

        let i_byte_off = u64::from(index_off_u16) * 2;
        let i_byte_len = num_indices * 2;
        if i_byte_off + i_byte_len > ibuf_len {
            eprintln!(
                "warn: RFOM shrub[{s}] index range {:#X}+{} > buffer {} — skipping",
                i_byte_off, i_byte_len, ibuf_len
            );
            skipped += 1;
            continue;
        }

        verts_ig.stream.seek_to(ibuf_off + i_byte_off)?;
        let mut indices: Vec<u32> = Vec::with_capacity(num_indices as usize);
        let mut max_index = 0u32;
        for _ in 0..num_indices {
            let v = u32::from(verts_ig.stream.read_u16()?);
            if v > max_index {
                max_index = v;
            }
            indices.push(v);
        }

        let num_verts = (max_index + 1) as usize;
        let v_byte_len = (num_verts * SHRUB_VERTEX_STRIDE) as u64;
        if vertex_buf_off + v_byte_len > vbuf_len {
            eprintln!(
                "warn: RFOM shrub[{s}] vertex range {:#X}+{} > buffer {} — skipping",
                vertex_buf_off, v_byte_len, vbuf_len
            );
            skipped += 1;
            continue;
        }

        verts_ig.stream.seek_to(vbuf_off + vertex_buf_off)?;
        let vertex_block = verts_ig.stream.read_bytes(v_byte_len as usize)?;

        let mut positions: Vec<f32> = Vec::with_capacity(num_verts * 3);
        let mut uvs: Vec<f32> = Vec::with_capacity(num_verts * 2);
        for k in 0..num_verts {
            let base = k * SHRUB_VERTEX_STRIDE;
            // ShrubVertex byte layout (16 B per vertex):
            //   +0x00..+0x02  half  position.x
            //   +0x02..+0x04  half  position.y
            //   +0x04..+0x06  half  position.z
            //   +0x06..+0x08  half  position.w  (ignored)
            //   +0x08..+0x0C  u8[4] vertex color (UCVector4, currently unused)
            //   +0x0C..+0x0E  half  uv.u
            //   +0x0E..+0x10  half  uv.v
            //
            // CRITICAL: IT declares position as int16[4] in vertex.hpp:56-60
            // but the attribute descriptor used in ShrubsToGltf says
            // `R16G16B16A16 FLOAT`. The runtime treats these as halfs.
            // Reading as i16 produced a single ~30 km mesh blob covering the
            // whole map (raw i16 like 32000 × YARD_TO_M = ~29 km). Decode as
            // half-float to get sensible meter-scale geometry.
            let rx = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 0], vertex_block[base + 1],
            ]));
            let ry = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 2], vertex_block[base + 3],
            ]));
            let rz = half_to_f32(u16::from_be_bytes([
                vertex_block[base + 4], vertex_block[base + 5],
            ]));
            positions.push(rx * YARD_TO_M);
            positions.push(ry * YARD_TO_M);
            positions.push(rz * YARD_TO_M);
            let uv_base = base + 0x0C;
            let u = half_to_f32(u16::from_be_bytes([
                vertex_block[uv_base],
                vertex_block[uv_base + 1],
            ]));
            let v = half_to_f32(u16::from_be_bytes([
                vertex_block[uv_base + 2],
                vertex_block[uv_base + 3],
            ]));
            uvs.push(u);
            uvs.push(v);
        }

        let asset_tuid = rec_off;
        shrub_idx_to_asset.insert(s, tie_assets.len());
        tie_assets.push(TieAsset {
            tuid: asset_tuid,
            scale: [1.0, 1.0, 1.0],
            meshes: vec![TieMeshGeom {
                shader_index: material_index,
                vertex_count: num_verts as u16,
                index_count: num_indices as u16,
                positions,
                uvs,
                indices,
            }],
            shader_tuids: identity_shader_tuids.clone(),
        });
    }

    let mut instances: Vec<TieInstance> = Vec::new();
    let shrubs_off = u64::from(shrubs_section.offset);

    // ---- Shrubs container header (first 16 B of section 0xC650) ----
    //   +0x00..+0x04  u32 unk0            (Vis array length)
    //   +0x04..+0x08  u32 unkOffset       (byte offset to Vis array, relative to shrubs_off)
    //   +0x08..+0x0C  u32 numInstances    (number of ShrubClusters)
    //   +0x0C..+0x10  u32 instancesOffset (byte offset to ShrubCluster array, relative to shrubs_off)
    main_ig.stream.seek_to(shrubs_off + 0x00)?;
    let vis_count = main_ig.stream.read_u32()? as usize;
    let vis_off_rel = main_ig.stream.read_u32()? as u64;
    let cluster_count = main_ig.stream.read_u32()? as usize;
    let cluster_off_rel = main_ig.stream.read_u32()? as u64;

    let cluster_base = shrubs_off + cluster_off_rel;
    let vis_base = shrubs_off + vis_off_rel;

    if log_probes {
        eprintln!(
            "[rfom-shrub] container: {} clusters @ +0x{:X}, {} vis records @ +0x{:X}",
            cluster_count, cluster_off_rel, vis_count, vis_off_rel
        );
    }

    let mut placed = 0usize;
    let mut sample_logged = 0usize;
    for c in 0..cluster_count {
        let cluster_off = cluster_base + (c as u64) * SHRUB_CLUSTER_SIZE;

        // Skip cluster.tm (Matrix44 @ +0x00..+0x40) — IT ignores it for glTF
        // emit; each ShrubInstance.position is already world-space yards.
        // Read the post-matrix metadata:
        main_ig.stream.seek_to(cluster_off + 0x40)?;

        // ---- LocalRange[4] @ +0x40..+0x48 (4 × 2B = 8B) ----
        // Each entry: { u8 count, u8 offset }
        //   count  = how many Vis records this slot claims
        //   offset = where in the cluster's Vis window the slot starts
        let mut local_ranges = [(0u8, 0u8); 4];
        for r in 0..4 {
            let cnt = main_ig.stream.read_u8()?;
            let off = main_ig.stream.read_u8()?;
            local_ranges[r] = (cnt, off);
        }
        // +0x48..+0x4C  u32 visOffset   (base into the global Vis array)
        let vis_offset = main_ig.stream.read_u32()? as u64;
        let shrubs_mask = main_ig.stream.read_u16()?;

        let mut local_id = 0usize;
        for i in 0..16u8 {
            if (shrubs_mask & (0x8000u16 >> i)) == 0 {
                continue;
            }
            if local_id >= 4 {
                break;
            }
            let (count, offset) = local_ranges[local_id];
            local_id += 1;

            let shrub_idx = (15 - i) as usize;
            let Some(&asset_idx) = shrub_idx_to_asset.get(&shrub_idx) else {
                continue;
            };
            let asset_tuid = tie_assets[asset_idx].tuid;

            for l in 0..count as u64 {
                let vis_slot = vis_offset + u64::from(offset) + l;
                if vis_slot >= vis_count as u64 {
                    continue;
                }
                let vis_rec = vis_base + vis_slot * SHRUB_INSTANCE_SIZE;

                // ---- ShrubInstance record (64 B) ----
                //   +0x00..+0x0C  float position[3]  — world XYZ (yards)
                //   +0x0C..+0x10  float scale
                //   +0x10..+0x1C  float r1[3]        — basis X
                //   +0x1C..+0x20  float unk0
                //   +0x20..+0x2C  float r2[3]        — basis Y
                //   +0x2C..+0x40  float unk1[5]      — 20 B undecoded
                main_ig.stream.seek_to(vis_rec + 0x00)?;
                let px = main_ig.stream.read_f32()?;
                let py = main_ig.stream.read_f32()?;
                let pz = main_ig.stream.read_f32()?;
                let scale = main_ig.stream.read_f32()?;
                let r1 = [
                    main_ig.stream.read_f32()?,
                    main_ig.stream.read_f32()?,
                    main_ig.stream.read_f32()?,
                ];
                let _unk0 = main_ig.stream.read_f32()?;
                let r2 = [
                    main_ig.stream.read_f32()?,
                    main_ig.stream.read_f32()?,
                    main_ig.stream.read_f32()?,
                ];
                // r3 (basis Z) reconstructed below via r1 × r2 cross product.
                let r3 = [
                    r1[1] * r2[2] - r1[2] * r2[1],
                    r1[2] * r2[0] - r1[0] * r2[2],
                    r1[0] * r2[1] - r1[1] * r2[0],
                ];
                let quat = rot_basis_to_quat(r1, r2, r3);

                if sample_logged < 3 && log_probes {
                    eprintln!(
                        "[rfom-shrub-inst] cluster[{c}] shrub_idx={shrub_idx} vis[{vis_slot}] m=({:.2}, {:.2}, {:.2}) scale={:.3}",
                        px * YARD_TO_M, py * YARD_TO_M, pz * YARD_TO_M, scale,
                    );
                    sample_logged += 1;
                }

                instances.push(TieInstance {
                    instance_tuid: vis_rec,
                    tie_tuid: asset_tuid,
                    name: format!("Shrub_{shrub_idx:02X}_{c:04X}_{l:02X}"),
                    position: [px * YARD_TO_M, py * YARD_TO_M, pz * YARD_TO_M],
                    quaternion: quat,
                    scale: [scale, scale, scale],
                    bounding_radius: 0.0,
                });
                placed += 1;
            }
        }
    }

    if log_probes {
        eprintln!(
            "[rfom-shrub] surfaced {} shrub meshes + {} placements ({} meshes skipped)",
            tie_assets.len(), placed, skipped
        );
    }

    Ok((tie_assets, instances))
}

fn rot_basis_to_quat(r1: [f32; 3], r2: [f32; 3], r3: [f32; 3]) -> [f32; 4] {
    let m00 = r1[0]; let m01 = r1[1]; let m02 = r1[2];
    let m10 = r2[0]; let m11 = r2[1]; let m12 = r2[2];
    let m20 = r3[0]; let m21 = r3[1]; let m22 = r3[2];
    let trace = m00 + m11 + m22;
    if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        [
            (m21 - m12) / s,
            (m02 - m20) / s,
            (m10 - m01) / s,
            0.25 * s,
        ]
    } else if m00 > m11 && m00 > m22 {
        let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0;
        [
            0.25 * s,
            (m01 + m10) / s,
            (m02 + m20) / s,
            (m21 - m12) / s,
        ]
    } else if m11 > m22 {
        let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0;
        [
            (m01 + m10) / s,
            0.25 * s,
            (m12 + m21) / s,
            (m02 - m20) / s,
        ]
    } else {
        let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0;
        [
            (m02 + m20) / s,
            (m12 + m21) / s,
            0.25 * s,
            (m10 - m01) / s,
        ]
    }
}
