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
    /// Per-asset shader TUID table (section `0x5600`). `mesh.shader_index`
    /// indexes into this; resolve through the global shader map to get
    /// texture references.
    pub shader_tuids: Vec<u64>,
    /// Skeleton from section `0xD300`. `None` for rigless props (crates,
    /// debris, etc.). Skin weights + animation playback build on this.
    pub skeleton: Option<Skeleton>,
    /// `MobyV2.animsetHash` — points into `assetlookup.dat`'s `0x1D700`
    /// (Animset) table. `None` for mobys without an animset (most static
    /// props). Used by the animation phase to fetch this character's
    /// clips. Read from header offset `0x50` per IT moby.hpp.
    pub animset_hash: Option<u64>,
    /// Power-of-2 factor for skinned-animation translation values:
    /// `position_scale = 2 ^ bindPoseInverseOffset`. Stored at moby
    /// header offset `0x10` (i16). Pass to [`crate::decode_animation`].
    pub bind_pose_inverse_offset: i16,
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
    /// Per-vertex global bone indices `[i0,i1,i2,i3]` (mapped through this
    /// mesh's `bone_map`). Empty when this submesh isn't skinned (stride
    /// 0x14 *and* the parent moby has no skeleton). Length, when present,
    /// is `vertex_count * 4`.
    pub bone_indices: Vec<u16>,
    /// Per-vertex weights `[w0,w1,w2,w3]` as u8 (UNORM, divide by 255 for
    /// 0..1). Length matches `bone_indices`. For the single-bone Vertex0
    /// case, the first slot holds 255 and the rest are 0.
    pub bone_weights: Vec<u8>,
}

/// Read moby assets for the given level. If `tuids` is `Some`, only those
/// asset TUIDs are decoded; if `None`, every moby in `assetlookup.dat` is
/// decoded.
pub fn read_moby_assets(level_folder: &Path, tuids: Option<&[u64]>) -> Result<Vec<MobyAsset>> {
    let mut out = Vec::new();
    read_moby_assets_streaming(level_folder, tuids, |asset| out.push(asset))?;
    Ok(out)
}

/// Streaming variant — invokes `on_each` once per parsed moby instead of
/// collecting into a Vec. Reports the total asset count up front via
/// `on_total` so callers (e.g. progress UIs) know the denominator before any
/// item arrives. Lets callers pipe progress events without buffering the
/// whole level in RAM.
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

/// Same as `read_moby_assets_streaming` plus an `on_total` callback fired
/// exactly once after pointer enumeration.
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

    // Two-stage pipeline for max throughput on multi-core machines:
    //   stage 1 (this thread, sequential): seek + read each moby's bytes
    //                                      from disk into an owned buffer
    //   stage 2 (rayon thread pool):      parse the bytes into a MobyAsset
    //                                      in parallel across cores
    //
    // We do BUFFER_AHEAD asset's worth of buffers at a time, then parse
    // them in parallel, then emit `on_each` in the original order. Limiting
    // the buffer-ahead window keeps memory bounded — important for huge
    // mobys.
    const BUFFER_AHEAD: usize = 16;

    let total = filtered.len();
    let mut next_index = 0usize;
    while next_index < total {
        let end = (next_index + BUFFER_AHEAD).min(total);
        let slice = &filtered[next_index..end];

        // Stage 1: read all the buffers for this batch sequentially.
        // (Disk I/O doesn't parallelize well with one shared file handle.)
        let mut bufs: Vec<(usize, Vec<u8>, u64)> = Vec::with_capacity(slice.len());
        for (i, ptr) in slice.iter().enumerate() {
            mobys_file.seek(SeekFrom::Start(u64::from(ptr.offset)))?;
            let mut buf = vec![0u8; ptr.length as usize];
            mobys_file.read_exact(&mut buf)?;
            bufs.push((next_index + i, buf, ptr.tuid));
        }

        // Stage 2: parse in parallel. Each worker gets its own Cursor +
        // IgFile, so there's no shared mutable state. Errors short-circuit.
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

        // Restore original order so the streaming consumer sees mobys in
        // the same sequence as the assetlookup table.
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

    // NewMoby header is 0x100; single record per moby file.
    ig.stream.seek_to(header_off + 0x00)?;
    let bsphere_position = ig.stream.read_vec3()?;
    let bsphere_radius = ig.stream.read_f32()?;

    // bindPoseInverseOffset (i16, exponent for position_scale during
    // animation decode). Per IT moby.hpp at 0x10. Some R2 mobys store
    // 0 here, in which case position_scale is 2^0 = 1.0.
    ig.stream.seek_to(header_off + 0x10)?;
    let bind_pose_inverse_offset = ig.stream.read_i16()?;

    ig.stream.seek_to(header_off + 0x18)?;
    let bangle_count = ig.stream.read_u16()?;
    let _bangle_count_2 = ig.stream.read_u16()?;

    ig.stream.seek_to(header_off + 0x24)?;
    let bangles_ptr = u64::from(ig.stream.read_u32()?);

    // animsetHash — IT struct says it's at 0x50. We treat 0 as "no
    // animset" (matches the convention for other null pointers in this
    // header). The frontend cross-checks against the assetlookup
    // 0x1D700 table to verify the link.
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

            ig.stream.seek_to(mesh_base + 0x0C)?;
            let bone_map_count = ig.stream.read_u8()?;
            let vertex_type = ig.stream.read_u8()?;

            ig.stream.seek_to(mesh_base + 0x12)?;
            let index_count = ig.stream.read_u16()?;

            // Per-mesh bone map at offset 0x20 — pointer to a u16 array of
            // length `bone_map_count`, mapping per-vertex local bone indices
            // (stored in the vertex stream) to global skeleton bone indices.
            // Per LibLunacy's MobyMesh struct + IT's PrimitiveV2.joints.
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

    // Skeleton is optional — rigless props (crates etc.) skip section 0xD300.
    // Failing to parse a skeleton on a moby that's expected to have one
    // would silently break skinned rendering later, so log instead of
    // burying the error.
    //
    // Kill-switch: setting `RECHIMERA_SKIP_SKELETON=1` skips skeleton parse
    // entirely — useful if you suspect skeleton parse is causing freezes
    // and want to confirm by bypassing it.
    let skeleton = if std::env::var("RECHIMERA_SKIP_SKELETON").is_ok() {
        None
    } else {
        match read_skeleton(ig) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("warn: moby 0x{:016X} skeleton skipped: {e}", tuid);
                None
            }
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
    bone_map: &[u16],
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

    // Per-vertex layouts from
    // [InsomniaToolset/vertex.hpp](../../../../InsomniaToolset/common/include/insomnia/internal/vertex.hpp):
    //
    //   Vertex0 (stride 0x14, single-bone or rigless):
    //     0x00 i16[3] position
    //     0x06 i16    purpose       — encodes single bone idx as `abs((p+1)/3)`
    //     0x08 f16[2] uv0
    //     0x0C u32    normal (R11G11B10)
    //     0x10 u32    tangent
    //
    //   Vertex1 (stride 0x1C, 4-bone skinned):
    //     0x00 i16[3] position
    //     0x06 i16    unk
    //     0x08 u8[4]  bones        — local indices into bone_map
    //     0x0C u8[4]  weights      — UNORM (divide by 255)
    //     0x10 f16[2] uv0
    //     0x14 u32    normal (R11G11B10)
    //     0x18 u32    tangent
    let uv_off = if stride == 0x1C { 0x10 } else { 0x08 };
    let mut positions = Vec::with_capacity((vertex_count as usize) * 3);
    let mut uvs = Vec::with_capacity((vertex_count as usize) * 2);
    let mut bone_indices = Vec::with_capacity((vertex_count as usize) * 4);
    let mut bone_weights = Vec::with_capacity((vertex_count as usize) * 4);

    let map_local = |local: usize| -> u16 {
        // Out-of-range local indices fall back to bone 0 — better than
        // panicking on a single corrupted vertex. Common cause: bone_map
        // was empty (mesh marked rigged but moby has no skeleton attached).
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
            // Vertex1: 4×u8 local bone indices at +0x08, 4×u8 weights at +0x0C.
            for i in 0..4 {
                let local = vertex_buf[base + 0x08 + i] as usize;
                bone_indices.push(map_local(local));
            }
            for i in 0..4 {
                bone_weights.push(vertex_buf[base + 0x0C + i]);
            }
        } else if !bone_map.is_empty() {
            // Vertex0: single bone in `purpose` field at +0x06. Formula
            // from IT's AttributeBoneIndex: `idx = abs((purpose + 1) / 3)`.
            let purpose = i16::from_be_bytes([vertex_buf[base + 6], vertex_buf[base + 7]]);
            let local = ((purpose + 1) / 3).unsigned_abs() as usize;
            bone_indices.push(map_local(local));
            bone_indices.push(0);
            bone_indices.push(0);
            bone_indices.push(0);
            // Single bone gets full weight; weights[0] = 255 = 1.0 UNORM.
            bone_weights.push(255);
            bone_weights.push(0);
            bone_weights.push(0);
            bone_weights.push(0);
        }
        // If stride == 0x14 AND bone_map is empty, this is a truly rigless
        // mesh (a static prop) — leave bone_indices/weights empty so the
        // frontend renders it as a regular Mesh, not a SkinnedMesh.
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

/// Read `count` u16 entries from `ptr` — the per-mesh bone-map (local
/// vertex bone idx → global skeleton bone idx). Returns Ok(empty) for
/// null pointer / zero count.
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
