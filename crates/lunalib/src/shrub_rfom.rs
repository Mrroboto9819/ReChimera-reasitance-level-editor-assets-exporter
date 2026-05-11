//! RFOM shrub (foliage) reader. Ports IT's `ShrubsToGltf` at
//! `levelmain/extract.cpp:1145-1279`.
//!
//! Two sections involved (both in `ps3levelmain.dat`):
//! - **`0xC700` Shrub** (48 bytes each) — mesh metadata: vertex/index buffer
//!   offsets + material index + wind-sway params (unk1\[4\] not yet decoded).
//! - **`0xC650` Shrubs** (single record) — instance container: holds
//!   `numInstances` × `ShrubCluster` (80B) + `unk0` × `ShrubInstance` (64B).
//!
//! Each `ShrubCluster` references up to 16 shrubs via `shrubsMask` and walks
//! `localRanges[4]` to determine how many `ShrubInstance` slots each
//! referenced shrub claims out of `Vis()`. The cluster's `tm` field is
//! ignored here (IT also ignores it for glTF emit — instances are placed
//! directly in world space via `vis.position`).
//!
//! Vertex format: `ShrubVertex` (16 bytes per IT's `vertex.hpp:56-60`):
//! `int16 position[4]` + `UCVector4 color` + `float16 uv[2]`. Position is
//! multiplied by `YARD_TO_M` like detail clusters.

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
        main_ig.stream.seek_to(rec_off + 0x00)?;
        let vertex_buf_off = main_ig.stream.read_u32()? as u64;
        let index_off_u16 = main_ig.stream.read_u32()?;
        let num_indices = main_ig.stream.read_u32()? as u64;
        let _unk0 = main_ig.stream.read_u32()?;
        for _ in 0..4 {
            let _ = main_ig.stream.read_f32()?;
        }
        let material_index = main_ig.stream.read_u16()?;

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
            // IT declares ShrubVertex.position as int16[4] in vertex.hpp but
            // the attribute descriptor in ShrubsToGltf uses
            // `R16G16B16A16 FLOAT` — i.e. four half-precision floats. So
            // decode as half2f, NOT as i16. Reading as i16 produced a single
            // ~30 km mesh covering the entire map because raw i16 values like
            // 32000 multiplied by YARD_TO_M land in the kilometres.
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
            // bytes +0x08..0x0C = UCVector4 vertex color (not used yet)
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
        main_ig.stream.seek_to(cluster_off + 0x40)?;
        let mut local_ranges = [(0u8, 0u8); 4];
        for r in 0..4 {
            let cnt = main_ig.stream.read_u8()?;
            let off = main_ig.stream.read_u8()?;
            local_ranges[r] = (cnt, off);
        }
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
