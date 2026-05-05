//! Tie (static-prop) mesh decoder.
//!
//! Ported from the new-engine path of [LibLunacy/Tie.cs](../../../../LibLunacy/Tie.cs).
//! Each tie is its own IGHW chunk inside `ties.dat`, sliced via the
//! `assetlookup.dat` tie pointer table.
//!
//! Layout (new engine):
//! - section `0x3400` — single `Tie` header (0x80 bytes)
//!   - `0x00` u32 pointer to `TieMesh[]` (file-relative)
//!   - `0x0F` u8 metadataCount (mesh count)
//!   - `0x14` u32 vertexBufferStart (relative to section `0x3000`)
//!   - `0x18` u32 vertexBufferSize
//!   - `0x20` Vec3 scale (per-axis multiplier on packed i16 positions)
//!   - `0x68` u64 tuid
//! - section `0x3000` — raw vertex bytes (stride 0x14 always)
//! - section `0x3200` — raw u16 index buffer
//! - `TieMesh` (0x40): indexIndex (in u16 units), vertexIndex (in strides),
//!   vertexCount, indexCount, newShaderIndex, etc.

use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use crate::assetlookup::{AssetKind, AssetLookup};
use crate::error::{Error, Result};
use crate::igfile::IgFile;
use crate::moby::{half_to_f32, read_shader_table};

const SECT_TIE_VERTICES: u32 = 0x3000;
const SECT_TIE_INDICES: u32 = 0x3200;
const SECT_TIE_HEADER: u32 = 0x3400;
const SECT_TIE_SHADER_TABLE: u32 = 0x5600;

const TIE_MESH_SIZE: u64 = 0x40;
const TIE_VERTEX_STRIDE: usize = 0x14;

#[derive(Debug, Clone)]
pub struct TieAsset {
    pub tuid: u64,
    pub scale: [f32; 3],
    pub meshes: Vec<TieMeshGeom>,
    /// Per-asset shader TUID table (section `0x5600`), indexed by
    /// `TieMeshGeom.shader_index`.
    pub shader_tuids: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct TieMeshGeom {
    /// Index into `TieAsset.shader_tuids`. Sourced from `materialIndex`
    /// (u16 at offset 0x28) per InsomniaToolset's `TiePrimitiveV2`. The
    /// LibLunacy C# port mislabeled this as `oldShaderIndex` and read the
    /// wrong field at 0x2A (which was the source of the original
    /// `KeyNotFoundException` against R2 levels).
    pub shader_index: u16,
    pub vertex_count: u16,
    pub index_count: u16,
    pub positions: Vec<f32>,
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
}

pub fn read_tie_assets(level_folder: &Path, tuids: Option<&[u64]>) -> Result<Vec<TieAsset>> {
    let assetlookup_path = level_folder.join("assetlookup.dat");
    let mut lookup = AssetLookup::open(BufReader::new(File::open(&assetlookup_path)?))?;
    let ptrs = lookup.pointers(AssetKind::Tie)?;
    if ptrs.is_empty() {
        return Ok(Vec::new());
    }

    let ties_path = level_folder.join("ties.dat");
    let mut ties_file = File::open(&ties_path)?;

    let mut out = Vec::new();
    for ptr in ptrs {
        if let Some(allowed) = tuids {
            if !allowed.contains(&ptr.tuid) {
                continue;
            }
        }
        ties_file.seek(SeekFrom::Start(u64::from(ptr.offset)))?;
        let mut buf = vec![0u8; ptr.length as usize];
        ties_file.read_exact(&mut buf)?;
        let mut tie_ig = IgFile::open(Cursor::new(buf))?;
        match parse_tie(&mut tie_ig, ptr.tuid) {
            Ok(tie) => out.push(tie),
            Err(e) => {
                eprintln!("warn: tie 0x{:016X} skipped: {e}", ptr.tuid);
            }
        }
    }
    Ok(out)
}

fn parse_tie<R: Read + Seek>(ig: &mut IgFile<R>, tuid_hint: u64) -> Result<TieAsset> {
    let header_section = ig.require_section(SECT_TIE_HEADER)?;
    let header_off = u64::from(header_section.offset);

    ig.stream.seek_to(header_off + 0x00)?;
    let meshes_ptr = u64::from(ig.stream.read_u32()?);

    ig.stream.seek_to(header_off + 0x0F)?;
    let mesh_count = ig.stream.read_u8()? as usize;

    ig.stream.seek_to(header_off + 0x14)?;
    let vertex_buffer_start = ig.stream.read_u32()?;
    let vertex_buffer_size = ig.stream.read_u32()?;

    ig.stream.seek_to(header_off + 0x20)?;
    let scale = ig.stream.read_vec3()?;

    ig.stream.seek_to(header_off + 0x68)?;
    let header_tuid = ig.stream.read_u64()?;
    let tuid = if header_tuid != 0 {
        header_tuid
    } else {
        tuid_hint
    };

    // Slice vertex region [vertex_buffer_start, +vertex_buffer_size) inside
    // section 0x3000; read full index section (we'll seek inside it per-mesh).
    let vsect = ig.require_section(SECT_TIE_VERTICES)?;
    ig.stream
        .seek_to(u64::from(vsect.offset) + u64::from(vertex_buffer_start))?;
    let vertex_buf = ig.stream.read_bytes(vertex_buffer_size as usize)?;

    let isect = ig.require_section(SECT_TIE_INDICES)?;
    ig.stream.seek_to(u64::from(isect.offset))?;
    let index_buf = ig.stream.read_bytes(isect.length as usize)?;

    // Read TieMesh records.
    let mut meshes = Vec::with_capacity(mesh_count);
    for m in 0..mesh_count {
        let mesh_base = meshes_ptr + (m as u64) * TIE_MESH_SIZE;
        ig.stream.seek_to(mesh_base + 0x00)?;
        let index_index = ig.stream.read_u32()?;
        ig.stream.seek_to(mesh_base + 0x04)?;
        let vertex_index = ig.stream.read_u16()?;
        // C# struct has a 2-byte gap from 0x06..0x08 before vertexCount.
        ig.stream.seek_to(mesh_base + 0x08)?;
        let vertex_count = ig.stream.read_u16()?;
        ig.stream.seek_to(mesh_base + 0x12)?;
        let index_count = ig.stream.read_u16()?;
        // materialIndex per InsomniaToolset's TiePrimitiveV2 (u16 @ 0x28).
        ig.stream.seek_to(mesh_base + 0x28)?;
        let shader_index = ig.stream.read_u16()?;

        meshes.push(decode_tie_mesh(
            &index_buf,
            &vertex_buf,
            index_index,
            index_count,
            vertex_index,
            vertex_count,
            scale,
            shader_index,
        )?);
    }

    let shader_tuids = read_shader_table(ig, SECT_TIE_SHADER_TABLE)?;

    Ok(TieAsset {
        tuid,
        scale,
        meshes,
        shader_tuids,
    })
}

#[allow(clippy::too_many_arguments)]
fn decode_tie_mesh(
    index_buf: &[u8],
    vertex_buf: &[u8],
    index_index: u32,
    index_count: u16,
    vertex_index: u16,
    vertex_count: u16,
    scale: [f32; 3],
    shader_index: u16,
) -> Result<TieMeshGeom> {
    let i_byte_off = (index_index as usize) * 2;
    let i_byte_end = i_byte_off + (index_count as usize) * 2;
    if i_byte_end > index_buf.len() {
        return Err(Error::SectionLengthMismatch {
            id: SECT_TIE_INDICES,
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

    let v_byte_off = (vertex_index as usize) * TIE_VERTEX_STRIDE;
    let v_total = (vertex_count as usize) * TIE_VERTEX_STRIDE;
    if v_byte_off + v_total > vertex_buf.len() {
        return Err(Error::SectionLengthMismatch {
            id: SECT_TIE_VERTICES,
            length: vertex_buf.len() as u32,
            entry: TIE_VERTEX_STRIDE as u32,
        });
    }

    let mut positions = Vec::with_capacity((vertex_count as usize) * 3);
    let mut uvs = Vec::with_capacity((vertex_count as usize) * 2);
    for k in 0..(vertex_count as usize) {
        let base = v_byte_off + k * TIE_VERTEX_STRIDE;
        let x = i16::from_be_bytes([vertex_buf[base + 0], vertex_buf[base + 1]]) as f32;
        let y = i16::from_be_bytes([vertex_buf[base + 2], vertex_buf[base + 3]]) as f32;
        let z = i16::from_be_bytes([vertex_buf[base + 4], vertex_buf[base + 5]]) as f32;
        positions.push(x * scale[0]);
        positions.push(y * scale[1]);
        positions.push(z * scale[2]);

        let u = half_to_f32(u16::from_be_bytes([
            vertex_buf[base + 0x08],
            vertex_buf[base + 0x09],
        ]));
        let v = half_to_f32(u16::from_be_bytes([
            vertex_buf[base + 0x0A],
            vertex_buf[base + 0x0B],
        ]));
        uvs.push(u);
        uvs.push(v);
    }

    Ok(TieMeshGeom {
        shader_index,
        vertex_count,
        index_count,
        positions,
        uvs,
        indices,
    })
}
