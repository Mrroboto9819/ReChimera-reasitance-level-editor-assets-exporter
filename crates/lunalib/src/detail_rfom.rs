//! RFOM `DetailCluster` (small static prop) reader.
//!
//! Ported from IT's `levelmain/extract.cpp::DetailToGltf` (line 779)
//! plus the struct layouts in
//! `common/include/insomnia/classes/detail.hpp`. Detail clusters are
//! the small static decorations sprinkled around RFOM levels — sign
//! posts, debris, signs, etc. They share the V1 `Vertex0` (20-byte)
//! stride with ties and use the same `meshScale * raw_i16` formula
//! per primitive plus an instance matrix scaled by `YARD_TO_M`.
//!
//! ## Detail (`0xB200`, 32 bytes — `detail.hpp:22`)
//! - `+0x00 u16 materialIndex`
//! - `+0x02 u16 unk1`
//! - `+0x04 u16 numVertices`
//! - `+0x06 u16 numIndices`
//! - `+0x08 u32 vertexBufferOffset` — bytes into `ps3levelverts.dat 0x9000`
//! - `+0x0C u32 indexOffset` — u16-units into `ps3levelverts.dat 0x9100`
//! - `+0x10 Vector meshScale` (3 floats)
//! - `+0x1C float null0`
//!
//! ## DetailCluster (`0xB300`, 128 bytes — `detail.hpp:34`)
//! - `+0x00..+0x40 OOBB bounds`
//! - `+0x40..+0x50 BoundSphere boundSphere` (Vector + float = 16)
//! - `+0x50 PointerX86<Detail> primitives` — file offset to first primitive
//! - `+0x54 u32 numPrimitives`
//! - `+0x58 u32 null00[2]`
//! - `+0x60 u16 detailId`
//! - `+0x62 u16 unk1`
//! - `+0x64 float unk2[7]`
//!
//! ## DetailInstance (`0x9500`, 128 bytes — `detail.hpp:46`)
//! - `+0x00..+0x40 Matrix44 tm` (16 floats, row-major)
//! - `+0x40..+0x4C Vector unk0`
//! - `+0x4C float unk2`
//! - `+0x50 PointerX86<DetailCluster> cluster` — file offset of the cluster
//! - `+0x54..+0x80 int32 unk1[11]`
//!
//! Translation column of `tm` is in raw yards on disk; we apply
//! `* YARD_TO_M` to match the meter-scale moby/tie conventions so
//! everything sits in the same coordinate space.

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

const SECT_DETAIL: u32 = 0xB200;
const SECT_DETAIL_CLUSTER: u32 = 0xB300;
const SECT_DETAIL_INSTANCE: u32 = 0x9500;
const SECT_LEVEL_VERTEX_BUFFER: u32 = 0x9000;
const SECT_LEVEL_INDEX_BUFFER: u32 = 0x9100;
const SECT_MATERIAL_V1: u32 = 0x5001;

const DETAIL_SIZE: u64 = 32;
const DETAIL_CLUSTER_SIZE: u64 = 128;
const DETAIL_INSTANCE_SIZE: u64 = 128;
const VERTEX0_STRIDE: usize = 0x14;

const YARD_TO_M: f32 = 0.9144;

/// Returns `(detail_clusters_as_ties, detail_instances_as_tie_instances)`
/// so the caller can append them to its existing tie pools and the
/// rest of the pipeline (cache writer, GLB exporter, MAP renderer)
/// works unchanged.
pub fn read_detail_clusters_rfom(
    level_folder: &Path,
) -> Result<(Vec<TieAsset>, Vec<TieInstance>)> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut main_ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let cluster_section = match main_ig.section(SECT_DETAIL_CLUSTER) {
        Some(s) => s,
        None => return Ok((Vec::new(), Vec::new())),
    };
    let detail_section = match main_ig.section(SECT_DETAIL) {
        Some(s) => s,
        None => return Ok((Vec::new(), Vec::new())),
    };
    let inst_section = match main_ig.section(SECT_DETAIL_INSTANCE) {
        Some(s) => s,
        None => return Ok((Vec::new(), Vec::new())),
    };

    if cluster_section.length != DETAIL_CLUSTER_SIZE as u32
        || detail_section.length != DETAIL_SIZE as u32
        || inst_section.length != DETAIL_INSTANCE_SIZE as u32
    {
        eprintln!(
            "warn: RFOM detail section size mismatch (cluster={} detail={} inst={}) — skipping",
            cluster_section.length, detail_section.length, inst_section.length
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
    let vertex_section_offset = u64::from(vertex_section.offset);
    let index_section_offset = u64::from(index_section.offset);
    let vertex_section_length = u64::from(vertex_section.length);
    let index_section_length = u64::from(index_section.length);

    let cluster_section_offset = u64::from(cluster_section.offset);
    let cluster_count = cluster_section.count as usize;
    if std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
        eprintln!(
            "[rfom-detail] {} DetailClusters / {} Details / {} DetailInstances",
            cluster_count, detail_section.count, inst_section.count
        );
    }

    let mut tie_assets: Vec<TieAsset> = Vec::with_capacity(cluster_count);
    let mut cluster_ptr_to_idx: HashMap<u64, usize> = HashMap::new();

    for c in 0..cluster_count {
        let cluster_off = cluster_section_offset + (c as u64) * DETAIL_CLUSTER_SIZE;

        main_ig.stream.seek_to(cluster_off + 0x50)?;
        let primitives_ptr = u64::from(main_ig.stream.read_u32()?);
        let num_primitives = main_ig.stream.read_u32()? as usize;

        if num_primitives == 0 || primitives_ptr == 0 {
            continue;
        }

        let mut meshes: Vec<TieMeshGeom> = Vec::with_capacity(num_primitives);
        for p in 0..num_primitives {
            let prim_off = primitives_ptr + (p as u64) * DETAIL_SIZE;

            main_ig.stream.seek_to(prim_off + 0x00)?;
            let material_index = main_ig.stream.read_u16()?;
            let _unk1 = main_ig.stream.read_u16()?;
            let num_verts = main_ig.stream.read_u16()?;
            let num_indices = main_ig.stream.read_u16()?;
            let vertex_offset = main_ig.stream.read_u32()?;
            let index_offset = main_ig.stream.read_u32()?;
            let scale_x = main_ig.stream.read_f32()?;
            let scale_y = main_ig.stream.read_f32()?;
            let scale_z = main_ig.stream.read_f32()?;

            if num_verts == 0 || num_indices == 0 {
                continue;
            }

            let v_byte_off = u64::from(vertex_offset);
            let v_byte_len = u64::from(num_verts) * VERTEX0_STRIDE as u64;
            let i_byte_off = u64::from(index_offset) * 2;
            let i_byte_len = u64::from(num_indices) * 2;
            if v_byte_off + v_byte_len > vertex_section_length
                || i_byte_off + i_byte_len > index_section_length
            {
                eprintln!(
                    "warn: RFOM detail cluster[{c}] prim[{p}] geometry out of range; skipping"
                );
                continue;
            }

            verts_ig
                .stream
                .seek_to(vertex_section_offset + v_byte_off)?;
            let vertex_block = verts_ig.stream.read_bytes(v_byte_len as usize)?;

            verts_ig
                .stream
                .seek_to(index_section_offset + i_byte_off)?;
            let mut indices: Vec<u32> = Vec::with_capacity(num_indices as usize);
            for _ in 0..num_indices {
                indices.push(u32::from(verts_ig.stream.read_u16()?));
            }

            let mut positions = Vec::with_capacity(num_verts as usize * 3);
            let mut uvs = Vec::with_capacity(num_verts as usize * 2);
            for k in 0..(num_verts as usize) {
                let v_off = k * VERTEX0_STRIDE;
                let raw_x = i16::from_be_bytes([
                    vertex_block[v_off],
                    vertex_block[v_off + 1],
                ]) as f32;
                let raw_y = i16::from_be_bytes([
                    vertex_block[v_off + 2],
                    vertex_block[v_off + 3],
                ]) as f32;
                let raw_z = i16::from_be_bytes([
                    vertex_block[v_off + 4],
                    vertex_block[v_off + 5],
                ]) as f32;
                positions.push(raw_x * scale_x);
                positions.push(raw_y * scale_y);
                positions.push(raw_z * scale_z);

                let uv_base = v_off + 0x08;
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

            meshes.push(TieMeshGeom {
                shader_index: material_index,
                vertex_count: num_verts,
                index_count: num_indices,
                positions,
                uvs,
                indices,
            });
        }

        if meshes.is_empty() {
            continue;
        }

        // Use the cluster file offset as the asset tuid so instances
        // can resolve via the cluster pointer field they store.
        let asset_tuid = cluster_off;
        cluster_ptr_to_idx.insert(cluster_off, tie_assets.len());
        tie_assets.push(TieAsset {
            tuid: asset_tuid,
            scale: [1.0, 1.0, 1.0],
            meshes,
            shader_tuids: identity_shader_tuids.clone(),
        });
    }

    let inst_section_offset = u64::from(inst_section.offset);
    let inst_count = inst_section.count as usize;
    let mut instances: Vec<TieInstance> = Vec::with_capacity(inst_count);
    let mut sample_logged = 0usize;
    for i in 0..inst_count {
        let base = inst_section_offset + (i as u64) * DETAIL_INSTANCE_SIZE;

        main_ig.stream.seek_to(base + 0x00)?;
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

        main_ig.stream.seek_to(base + 0x50)?;
        let cluster_ptr = u64::from(main_ig.stream.read_u32()?);

        // Match by file offset — DetailCluster section lives at
        // contiguous `cluster_section_offset + idx * 128` slots, so
        // the pointer should match exactly.
        let asset_tuid = if cluster_ptr_to_idx.contains_key(&cluster_ptr) {
            cluster_ptr
        } else {
            // Fallback: bind to first cluster if pointer doesn't
            // resolve cleanly (single-cluster levels usually do this
            // anyway because there's only one target).
            tie_assets.first().map(|t| t.tuid).unwrap_or(0)
        };

        if sample_logged < 3 && std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
            eprintln!(
                "[rfom-detail-inst] [{i}] cluster_ptr=0x{cluster_ptr:X} → asset=0x{asset_tuid:X} m=({:.2}, {:.2}, {:.2})",
                position[0], position[1], position[2]
            );
            sample_logged += 1;
        }

        instances.push(TieInstance {
            tie_tuid: asset_tuid,
            instance_tuid: i as u64 | 0xDE7A1_0000_0000,
            name: format!("Detail_{i:04X}"),
            position,
            quaternion,
            scale,
            bounding_radius: 0.0,
        });
    }
    if std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
        eprintln!(
            "[rfom-detail] surfaced {} detail-cluster ties + {} instances",
            tie_assets.len(),
            instances.len()
        );
    }

    Ok((tie_assets, instances))
}
