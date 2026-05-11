

use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use rayon::prelude::*;

use crate::assetlookup::{AssetKind, AssetLookup};
use crate::error::{Error, Result};
use crate::igfile::IgFile;
use crate::skeleton::{read_skeleton, Skeleton};

const SECT_MOBY_HEADER: u32 = 0xD100;
const SECT_MOBY_NAME: u32 = 0xD200;
const SECT_MOBY_SHADER_TABLE: u32 = 0x5600;
const SECT_MOBY_INDICES: u32 = 0xE100;
const SECT_MOBY_VERTICES: u32 = 0xE200;

const BANGLE_SIZE: u64 = 0x08;
const MOBY_MESH_SIZE: u64 = 0x40;

#[derive(Debug, Clone)]
pub struct MobyAsset {
    pub tuid: u64,
    pub name: String,
    pub bangles: Vec<MobyBangle>,
    pub bsphere_position: [f32; 3],
    pub bsphere_radius: f32,

    pub shader_tuids: Vec<u64>,

    pub skeleton: Option<Skeleton>,

    pub animset_hash: Option<u64>,

    pub bind_pose_inverse_offset: i16,

    /// RFOM-only: per-moby list of file offsets into the global 0xF000 anim
    /// header array. Populated by `moby_rfom.rs`; empty for V2 / TOD assets.
    pub rfom_anim_offsets: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct MobyBangle {
    pub meshes: Vec<MobyMesh>,
}

#[derive(Debug, Clone)]
pub struct MobyMesh {
    pub shader_index: u16,
    pub vertex_count: u16,
    pub index_count: u16,
    pub vertex_stride: u8,

    pub positions: Vec<f32>,

    pub uvs: Vec<f32>,

    pub indices: Vec<u32>,

    pub bone_indices: Vec<u16>,

    pub bone_weights: Vec<u8>,
}

pub fn read_moby_assets(level_folder: &Path, tuids: Option<&[u64]>) -> Result<Vec<MobyAsset>> {
    let mut out = Vec::new();
    read_moby_assets_streaming(level_folder, tuids, |asset| out.push(asset))?;
    Ok(out)
}

pub fn read_moby_assets_streaming<F>(
    level_folder: &Path,
    tuids: Option<&[u64]>,
    mut on_each: F,
) -> Result<()>
where
    F: FnMut(MobyAsset),
{
    read_moby_assets_with_total(level_folder, tuids, |_| {}, |a| on_each(a))
}

pub fn read_moby_assets_with_total<T, F>(
    level_folder: &Path,
    tuids: Option<&[u64]>,
    mut on_total: T,
    mut on_each: F,
) -> Result<()>
where
    T: FnMut(usize),
    F: FnMut(MobyAsset),
{
    let assetlookup_path = level_folder.join("assetlookup.dat");
    let mut lookup = AssetLookup::open(BufReader::new(File::open(&assetlookup_path)?))?;
    let ptrs = lookup.pointers(AssetKind::Moby)?;

    let filtered: Vec<_> = ptrs
        .into_iter()
        .filter(|p| tuids.map_or(true, |allowed| allowed.contains(&p.tuid)))
        .collect();
    on_total(filtered.len());
    if filtered.is_empty() {
        return Ok(());
    }

    let mobys_dat_path = level_folder.join("mobys.dat");
    let mut mobys_file = File::open(&mobys_dat_path)?;

    const BUFFER_AHEAD: usize = 16;

    let total = filtered.len();
    let mut next_index = 0usize;
    while next_index < total {
        let end = (next_index + BUFFER_AHEAD).min(total);
        let slice = &filtered[next_index..end];

        let mut bufs: Vec<(usize, Vec<u8>, u64)> = Vec::with_capacity(slice.len());
        for (i, ptr) in slice.iter().enumerate() {
            if ptr.length > crate::MAX_ASSET_SIZE {
                return Err(Error::AllocLimitExceeded {
                    size: u64::from(ptr.length),
                    limit: u64::from(crate::MAX_ASSET_SIZE),
                });
            }
            mobys_file.seek(SeekFrom::Start(u64::from(ptr.offset)))?;
            let mut buf = vec![0u8; ptr.length as usize];
            mobys_file.read_exact(&mut buf)?;
            bufs.push((next_index + i, buf, ptr.tuid));
        }

        let mut parsed: Vec<(usize, Result<MobyAsset>)> = bufs
            .into_par_iter()
            .map(|(idx, buf, tuid)| {
                let parsed_or_err = (|| {
                    let mut moby_ig = IgFile::open(Cursor::new(buf))?;
                    parse_moby(&mut moby_ig, tuid)
                })();
                (idx, parsed_or_err)
            })
            .collect();

        parsed.sort_by_key(|(i, _)| *i);

        for (_i, result) in parsed {
            let asset = result?;
            on_each(asset);
        }

        next_index = end;
    }
    Ok(())
}

fn parse_moby<R: Read + Seek>(ig: &mut IgFile<R>, tuid_hint: u64) -> Result<MobyAsset> {
    let header_section = ig.require_section(SECT_MOBY_HEADER)?;
    let header_off = u64::from(header_section.offset);

    ig.stream.seek_to(header_off + 0x00)?;
    let bsphere_position = ig.stream.read_vec3()?;
    let bsphere_radius = ig.stream.read_f32()?;

    ig.stream.seek_to(header_off + 0x10)?;
    let bind_pose_inverse_offset = ig.stream.read_i16()?;

    ig.stream.seek_to(header_off + 0x18)?;
    let bangle_count = ig.stream.read_u16()?;
    let _bangle_count_2 = ig.stream.read_u16()?;

    ig.stream.seek_to(header_off + 0x24)?;
    let bangles_ptr = u64::from(ig.stream.read_u32()?);

    ig.stream.seek_to(header_off + 0x50)?;
    let animset_hash_raw = ig.stream.read_u64()?;
    let animset_hash = if animset_hash_raw != 0 {
        Some(animset_hash_raw)
    } else {
        None
    };

    ig.stream.seek_to(header_off + 0x70)?;
    let scale = ig.stream.read_f32()?;

    ig.stream.seek_to(header_off + 0xB0)?;
    let header_tuid = ig.stream.read_u64()?;
    let tuid = if header_tuid != 0 {
        header_tuid
    } else {
        tuid_hint
    };

    let name = match ig.section(SECT_MOBY_NAME) {
        Some(s) => ig.stream.read_cstring_at(u64::from(s.offset))?,
        None => format!("moby_{:016X}", tuid),
    };

    let isect = ig.require_section(SECT_MOBY_INDICES)?;
    ig.stream.seek_to(u64::from(isect.offset))?;
    let index_buf = ig.stream.read_bytes(isect.length as usize)?;

    let vsect = ig.require_section(SECT_MOBY_VERTICES)?;
    ig.stream.seek_to(u64::from(vsect.offset))?;
    let vertex_buf = ig.stream.read_bytes(vsect.length as usize)?;

    let shader_tuids = read_shader_table(ig, SECT_MOBY_SHADER_TABLE)?;

    let mut bangles = Vec::with_capacity(bangle_count as usize);
    for _b in 0..bangle_count {
        let bangle_base = bangles_ptr + (_b as u64) * BANGLE_SIZE;
        ig.stream.seek_to(bangle_base + 0x00)?;
        let meshes_ptr = u64::from(ig.stream.read_u32()?);
        let mesh_count = ig.stream.read_u32()?;

        let mut meshes = Vec::with_capacity(mesh_count as usize);
        for m in 0..mesh_count {
            let mesh_base = meshes_ptr + (m as u64) * MOBY_MESH_SIZE;
            ig.stream.seek_to(mesh_base + 0x00)?;
            let index_index = ig.stream.read_u32()?;
            let vertex_offset = ig.stream.read_u32()?;
            let shader_index = ig.stream.read_u16()?;
            let vertex_count = ig.stream.read_u16()?;

            ig.stream.seek_to(mesh_base + 0x0C)?;
            let bone_map_count = ig.stream.read_u8()?;
            let vertex_type = ig.stream.read_u8()?;

            ig.stream.seek_to(mesh_base + 0x10)?;
            let index_count_u32 = ig.stream.read_u32()?;
            let index_count = index_count_u32 as u16;

            ig.stream.seek_to(mesh_base + 0x20)?;
            let bone_map_ptr = u64::from(ig.stream.read_u32()?);
            let bone_map = read_bone_map(ig, bone_map_ptr, bone_map_count as usize)
                .unwrap_or_default();

            let stride = if vertex_type == 1 { 0x1C } else { 0x14 };

            let mesh = decode_moby_mesh(
                &index_buf,
                &vertex_buf,
                index_index,
                index_count,
                vertex_offset,
                vertex_count,
                stride,
                shader_index,
                scale,
                &bone_map,
            )?;
            meshes.push(mesh);
        }
        bangles.push(MobyBangle { meshes });
    }

    let skeleton = match read_skeleton(ig) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("warn: moby 0x{:016X} skeleton skipped: {e}", tuid);
            None
        }
    };

    Ok(MobyAsset {
        tuid,
        name,
        bangles,
        bsphere_position,
        bsphere_radius,
        shader_tuids,
        skeleton,
        animset_hash,
        bind_pose_inverse_offset,
        rfom_anim_offsets: Vec::new(),
    })
}

pub(crate) fn read_shader_table<R: Read + Seek>(
    ig: &mut IgFile<R>,
    section_id: u32,
) -> Result<Vec<u64>> {
    let Some(s) = ig.section(section_id) else {
        return Ok(Vec::new());
    };
    let count = s.count as usize;
    ig.stream.seek_to(u64::from(s.offset))?;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(ig.stream.read_u64()?);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn decode_moby_mesh(
    index_buf: &[u8],
    vertex_buf: &[u8],
    index_index: u32,
    index_count: u16,
    vertex_offset: u32,
    vertex_count: u16,
    stride: u32,
    shader_index: u16,
    scale: f32,
    bone_map: &[u16],
) -> Result<MobyMesh> {

    let i_byte_off = (index_index as usize) * 2;
    let i_byte_end = i_byte_off + (index_count as usize) * 2;
    if i_byte_end > index_buf.len() {
        return Err(Error::SectionLengthMismatch {
            id: SECT_MOBY_INDICES,
            length: index_buf.len() as u32,
            entry: 2,
        });
    }
    let mut indices = Vec::with_capacity(index_count as usize);
    for k in 0..(index_count as usize) {
        let off = i_byte_off + k * 2;
        let v = u16::from_be_bytes([index_buf[off], index_buf[off + 1]]);
        indices.push(u32::from(v));
    }

    let v_byte_off = vertex_offset as usize;
    let v_total = (vertex_count as usize) * (stride as usize);
    if v_byte_off + v_total > vertex_buf.len() {
        return Err(Error::SectionLengthMismatch {
            id: SECT_MOBY_VERTICES,
            length: vertex_buf.len() as u32,
            entry: stride,
        });
    }

    let uv_off = if stride == 0x1C { 0x10 } else { 0x08 };
    let mut positions = Vec::with_capacity((vertex_count as usize) * 3);
    let mut uvs = Vec::with_capacity((vertex_count as usize) * 2);
    let mut bone_indices = Vec::with_capacity((vertex_count as usize) * 4);
    let mut bone_weights = Vec::with_capacity((vertex_count as usize) * 4);

    let map_local = |local: usize| -> u16 {

        bone_map.get(local).copied().unwrap_or(0)
    };

    for k in 0..(vertex_count as usize) {
        let base = v_byte_off + k * (stride as usize);

        let x = i16::from_be_bytes([vertex_buf[base + 0], vertex_buf[base + 1]]) as f32;
        let y = i16::from_be_bytes([vertex_buf[base + 2], vertex_buf[base + 3]]) as f32;
        let z = i16::from_be_bytes([vertex_buf[base + 4], vertex_buf[base + 5]]) as f32;
        positions.push(x * scale);
        positions.push(y * scale);
        positions.push(z * scale);

        let uv_base = base + uv_off;
        let u = half_to_f32(u16::from_be_bytes([
            vertex_buf[uv_base],
            vertex_buf[uv_base + 1],
        ]));
        let v = half_to_f32(u16::from_be_bytes([
            vertex_buf[uv_base + 2],
            vertex_buf[uv_base + 3],
        ]));
        uvs.push(u);
        uvs.push(v);

        if stride == 0x1C {

            let mut slot_bones = [0u16; 4];
            let mut slot_weights = [0u8; 4];
            for i in 0..4 {
                let local = vertex_buf[base + 0x08 + i] as usize;
                slot_bones[i] = map_local(local);
                slot_weights[i] = vertex_buf[base + 0x0C + i];
            }
            for i in 0..4 {
                if slot_weights[i] == 0 {
                    slot_bones[i] = 0;
                }
            }
            for i in 0..4 {
                bone_indices.push(slot_bones[i]);
            }
            for i in 0..4 {
                bone_weights.push(slot_weights[i]);
            }
        } else if !bone_map.is_empty() {

            let purpose = i16::from_be_bytes([vertex_buf[base + 6], vertex_buf[base + 7]]);
            let local = ((purpose + 1) / 3).unsigned_abs() as usize;
            bone_indices.push(map_local(local));
            bone_indices.push(0);
            bone_indices.push(0);
            bone_indices.push(0);

            bone_weights.push(255);
            bone_weights.push(0);
            bone_weights.push(0);
            bone_weights.push(0);
        }

    }

    if !bone_indices.is_empty() && std::env::var("RECHIMERA_LOG_WEIGHTS").is_ok() {
        let verts = vertex_count as usize;
        let max_bone = bone_indices.iter().copied().max().unwrap_or(0);
        let oversize = bone_indices.iter().filter(|&&v| v > 255).count();
        let zero_weight_first_slot = bone_weights.iter().step_by(4).filter(|&&w| w == 0).count();
        let unnormalized = (0..verts).filter(|&v| {
            let s: u32 = (0..4).map(|i| bone_weights[v * 4 + i] as u32).sum();
            s == 0 || (s as i32 - 255).abs() > 4
        }).count();
        eprintln!(
            "[mesh-weights] stride=0x{:02X} verts={} max_bone_idx={} oversize_u8={} zero_first_slot={} unnormalized={} bone_map_len={}",
            stride, verts, max_bone, oversize, zero_weight_first_slot, unnormalized, bone_map.len(),
        );
    }

    Ok(MobyMesh {
        shader_index,
        vertex_count,
        index_count,
        vertex_stride: stride as u8,
        positions,
        uvs,
        indices,
        bone_indices,
        bone_weights,
    })
}

fn read_bone_map<R: Read + Seek>(
    ig: &mut IgFile<R>,
    ptr: u64,
    count: usize,
) -> Result<Vec<u16>> {
    if ptr == 0 || count == 0 {
        return Ok(Vec::new());
    }
    ig.stream.seek_to(ptr)?;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(ig.stream.read_u16()?);
    }
    Ok(out)
}

pub fn half_to_f32(half: u16) -> f32 {
    let sign = ((half >> 15) & 0x1) as u32;
    let exp = ((half >> 10) & 0x1F) as i32;
    let mantissa = (half & 0x3FF) as u32;

    let bits = if exp == 0 {
        if mantissa == 0 {
            sign << 31
        } else {

            let mut m = mantissa;
            let mut e = -14_i32;
            while m & 0x400 == 0 {
                m <<= 1;
                e -= 1;
            }
            m &= 0x3FF;
            (sign << 31) | (((e + 127) as u32) << 23) | (m << 13)
        }
    } else if exp == 31 {

        (sign << 31) | (0xFFu32 << 23) | (mantissa << 13)
    } else {
        (sign << 31) | (((exp - 15 + 127) as u32) << 23) | (mantissa << 13)
    };
    f32::from_bits(bits)
}
