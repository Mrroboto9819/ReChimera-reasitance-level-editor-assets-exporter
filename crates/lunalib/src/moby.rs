//! Moby (animated/dynamic prop) mesh decoder.
//!
//! Ported from the new-engine path of [LibLunacy/Moby.cs](../../../../LibLunacy/Moby.cs).
//! Each moby is its own IGHW chunk inside `mobys.dat`, sliced via the
//! `assetlookup.dat` moby pointer table.
//!
//! Layout (new engine):
//! - section `0xD100` — single `NewMoby` header (0x100 bytes)
//!   - `0x00` Vec3 bounding-sphere position
//!   - `0x0C` f32 bounding-sphere radius
//!   - `0x18` u16 bangleCount1
//!   - `0x24` u32 pointer (file-relative) to a packed `Bangle[]`
//!   - `0x70` f32 scale (multiplier applied to packed i16 vertex coords)
//!   - `0xB0` u64 tuid
//! - section `0xD200` — moby name (NUL-terminated string at section.offset)
//! - section `0xE100` — index buffer (raw u16 array)
//! - section `0xE200` — vertex buffer (raw bytes; stride 0x14 or 0x1C)
//!
//! `Bangle` (8 bytes): pointer-to-MobyMesh array + u32 count.
//! `MobyMesh` (0x40 bytes): vertex/index offsets + counts + shader index +
//! vertex stride flag at `0x0D` (`vertex_type == 1` ⇒ stride 0x1C, else 0x14).

use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use crate::assetlookup::{AssetKind, AssetLookup};
use crate::error::{Error, Result};
use crate::igfile::IgFile;

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
    /// Per-asset shader TUID table (section `0x5600`). `mesh.shader_index`
    /// indexes into this; resolve through the global shader map to get
    /// texture references.
    pub shader_tuids: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct MobyBangle {
    pub meshes: Vec<MobyMesh>,
}

/// One drawable submesh. Positions/UVs are already decoded to f32 in
/// moby-local space (multiplied by the moby's `scale`). Indices are a
/// triangle list (see `triangle_count = indices.len() / 3`).
#[derive(Debug, Clone)]
pub struct MobyMesh {
    pub shader_index: u16,
    pub vertex_count: u16,
    pub index_count: u16,
    pub vertex_stride: u8,
    /// Packed `[x0, y0, z0, x1, y1, z1, ...]` — vertex_count * 3.
    pub positions: Vec<f32>,
    /// Packed `[u0, v0, u1, v1, ...]` — vertex_count * 2.
    pub uvs: Vec<f32>,
    /// Triangle-list indices.
    pub indices: Vec<u32>,
}

/// Read moby assets for the given level. If `tuids` is `Some`, only those
/// asset TUIDs are decoded; if `None`, every moby in `assetlookup.dat` is
/// decoded.
pub fn read_moby_assets(level_folder: &Path, tuids: Option<&[u64]>) -> Result<Vec<MobyAsset>> {
    let assetlookup_path = level_folder.join("assetlookup.dat");
    let mut lookup = AssetLookup::open(BufReader::new(File::open(&assetlookup_path)?))?;
    let ptrs = lookup.pointers(AssetKind::Moby)?;
    if ptrs.is_empty() {
        return Ok(Vec::new());
    }

    let mobys_dat_path = level_folder.join("mobys.dat");
    let mut mobys_file = File::open(&mobys_dat_path)?;

    let mut out = Vec::new();
    for ptr in ptrs {
        if let Some(allowed) = tuids {
            if !allowed.contains(&ptr.tuid) {
                continue;
            }
        }
        mobys_file.seek(SeekFrom::Start(u64::from(ptr.offset)))?;
        let mut buf = vec![0u8; ptr.length as usize];
        mobys_file.read_exact(&mut buf)?;
        let mut moby_ig = IgFile::open(Cursor::new(buf))?;
        out.push(parse_moby(&mut moby_ig, ptr.tuid)?);
    }
    Ok(out)
}

fn parse_moby<R: Read + Seek>(ig: &mut IgFile<R>, tuid_hint: u64) -> Result<MobyAsset> {
    let header_section = ig.require_section(SECT_MOBY_HEADER)?;
    let header_off = u64::from(header_section.offset);

    // NewMoby header is 0x100; single record per moby file.
    ig.stream.seek_to(header_off + 0x00)?;
    let bsphere_position = ig.stream.read_vec3()?;
    let bsphere_radius = ig.stream.read_f32()?;

    ig.stream.seek_to(header_off + 0x18)?;
    let bangle_count = ig.stream.read_u16()?;
    let _bangle_count_2 = ig.stream.read_u16()?;

    ig.stream.seek_to(header_off + 0x24)?;
    let bangles_ptr = u64::from(ig.stream.read_u32()?);

    ig.stream.seek_to(header_off + 0x70)?;
    let scale = ig.stream.read_f32()?;

    ig.stream.seek_to(header_off + 0xB0)?;
    let header_tuid = ig.stream.read_u64()?;
    let tuid = if header_tuid != 0 {
        header_tuid
    } else {
        tuid_hint
    };

    // Moby name lives at section 0xD200 as a single NUL-terminated string.
    let name = match ig.section(SECT_MOBY_NAME) {
        Some(s) => ig.stream.read_cstring_at(u64::from(s.offset))?,
        None => format!("moby_{:016X}", tuid),
    };

    // Slurp the index + vertex data buffers (we need to seek inside them
    // separately for each MobyMesh).
    let isect = ig.require_section(SECT_MOBY_INDICES)?;
    ig.stream.seek_to(u64::from(isect.offset))?;
    let index_buf = ig.stream.read_bytes(isect.length as usize)?;

    let vsect = ig.require_section(SECT_MOBY_VERTICES)?;
    ig.stream.seek_to(u64::from(vsect.offset))?;
    let vertex_buf = ig.stream.read_bytes(vsect.length as usize)?;

    // Per-asset shader table — u64 array, indexed by MobyMesh.shader_index.
    let shader_tuids = read_shader_table(ig, SECT_MOBY_SHADER_TABLE)?;

    // Read bangles (pointer-array of MobyMesh sub-arrays).
    let mut bangles = Vec::with_capacity(bangle_count as usize);
    for b in 0..bangle_count {
        let bangle_base = bangles_ptr + (b as u64) * BANGLE_SIZE;
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

            ig.stream.seek_to(mesh_base + 0x0D)?;
            let vertex_type = ig.stream.read_u8()?;

            ig.stream.seek_to(mesh_base + 0x12)?;
            let index_count = ig.stream.read_u16()?;

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
            )?;
            meshes.push(mesh);
        }
        bangles.push(MobyBangle { meshes });
    }

    Ok(MobyAsset {
        tuid,
        name,
        bangles,
        bsphere_position,
        bsphere_radius,
        shader_tuids,
    })
}

/// Read a u64 shader-TUID table from the given section. Returns an empty
/// vector if the section is missing.
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
fn decode_moby_mesh(
    index_buf: &[u8],
    vertex_buf: &[u8],
    index_index: u32,
    index_count: u16,
    vertex_offset: u32,
    vertex_count: u16,
    stride: u32,
    shader_index: u16,
    scale: f32,
) -> Result<MobyMesh> {
    // Indices: u16 BE at byte offset `index_index * 2`.
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

    // Vertices: stride bytes per vertex, big-endian.
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
    }

    Ok(MobyMesh {
        shader_index,
        vertex_count,
        index_count,
        vertex_stride: stride as u8,
        positions,
        uvs,
        indices,
    })
}

/// IEEE-754 binary16 → f32 (no FMA). Subnormals & specials handled.
pub fn half_to_f32(half: u16) -> f32 {
    let sign = ((half >> 15) & 0x1) as u32;
    let exp = ((half >> 10) & 0x1F) as i32;
    let mantissa = (half & 0x3FF) as u32;

    let bits = if exp == 0 {
        if mantissa == 0 {
            sign << 31
        } else {
            // Subnormal: normalize.
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
        // Inf / NaN.
        (sign << 31) | (0xFFu32 << 23) | (mantissa << 13)
    } else {
        (sign << 31) | (((exp - 15 + 127) as u32) << 23) | (mantissa << 13)
    };
    f32::from_bits(bits)
}
