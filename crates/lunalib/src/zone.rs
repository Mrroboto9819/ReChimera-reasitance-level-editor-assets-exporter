//! Parser for `zones.dat` — reads tie instances out of every zone chunk.
//!
//! Ported from [LibLunacy/Zone.cs](../../../../LibLunacy/Zone.cs). UFrag (terrain)
//! parsing is intentionally deferred — phase 3b.2 only extracts tie placements
//! so the viewport can render their world-space positions.
//!
//! Layout (new engine):
//!
//! - `assetlookup.dat` section `0x1DA00` — `AssetPointer` table giving each
//!   zone's slice within `zones.dat`.
//! - Each zone slice is itself an IGHW container with:
//!   - `0x7240` — array of `TieInstance` (0x80 each). Bytes 0x00..0x40 hold a
//!     row-major 4×4 transform; the translation lives at 0x30..0x3C (M41–M43).
//!     `0x40..0x4C` is the bounding-sphere centre, `0x4C` the radius, and
//!     `0x50` is a `u32` index into the per-zone tie-TUID table.
//!   - `0x72C0` — parallel `AssetPointer` array: the `tuid` field is the
//!     instance's own TUID and `offset` is a string pointer for the name.
//!   - `0x7200` — `u64` table of tie *asset* TUIDs, indexed by the field at
//!     `0x50` of each instance.

use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use crate::assetlookup::{AssetKind, AssetLookup};
use crate::error::{Error, Result};
use crate::igfile::IgFile;
use crate::math::decompose_row_major;
use crate::moby::{half_to_f32, read_shader_table};

const SECT_UFRAG_VERTICES: u32 = 0x6000;
const SECT_UFRAG_INDICES: u32 = 0x6100;
const SECT_UFRAGS: u32 = 0x6200;
const SECT_UFRAG_SHADER_TABLE: u32 = 0x71A0;
const SECT_TIE_TUID_TABLE: u32 = 0x7200;
const SECT_TIE_INSTANCES: u32 = 0x7240;
const SECT_TIE_NAME_POINTERS: u32 = 0x72C0;

const TIE_INSTANCE_SIZE: u64 = 0x80;
const NAME_POINTER_SIZE: u64 = 0x10;
const UFRAG_SIZE: u64 = 0x80;
const UFRAG_VERTEX_STRIDE: usize = 0x18;

#[derive(Debug, Clone)]
pub struct Zone {
    /// TUID of the zone itself (taken from `assetlookup.dat`).
    pub tuid: u64,
    pub tie_instances: Vec<TieInstance>,
    pub ufrags: Vec<UFrag>,
    /// Per-zone UFrag shader TUID table (section `0x71A0`), indexed by
    /// `UFrag.shader_index`.
    pub ufrag_shader_tuids: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct TieInstance {
    /// TUID of the tie *asset* this is an instance of.
    pub tie_tuid: u64,
    /// TUID of *this specific placement*.
    pub instance_tuid: u64,
    pub name: String,
    pub position: [f32; 3],
    /// Orientation as a unit quaternion `[x, y, z, w]` in column-vector
    /// (three.js / glTF) convention.
    pub quaternion: [f32; 4],
    /// Per-axis scale extracted from the source 4×4.
    pub scale: [f32; 3],
    pub bounding_radius: f32,
}

/// "UFrag" = Universe Fragment, a chunk of zone terrain mesh.
#[derive(Debug, Clone)]
pub struct UFrag {
    pub tuid: u64,
    /// Bounding-sphere centre.
    pub position: [f32; 3],
    pub radius: f32,
    pub vertex_count: u16,
    pub index_count: u16,
    pub shader_index: u16,
    /// Decoded vertex positions: i16 → f32, no scale. Unit is presumably
    /// world-meter relative to zone origin (matches what the C# renderer
    /// uses).
    pub positions: Vec<f32>,
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
}

/// Read every zone from `<level_folder>/zones.dat`, returning their tie
/// instances. Zones referenced by `assetlookup.dat`'s zone section.
pub fn read_zones(level_folder: &Path) -> Result<Vec<Zone>> {
    let mut out = Vec::new();
    read_zones_streaming(level_folder, |z| out.push(z))?;
    Ok(out)
}

/// Streaming variant — invokes `on_each` once per parsed zone.
pub fn read_zones_streaming<F>(level_folder: &Path, mut on_each: F) -> Result<()>
where
    F: FnMut(Zone),
{
    read_zones_with_total(level_folder, |_| {}, |z| on_each(z))
}

pub fn read_zones_with_total<T, F>(
    level_folder: &Path,
    mut on_total: T,
    mut on_each: F,
) -> Result<()>
where
    T: FnMut(usize),
    F: FnMut(Zone),
{
    let assetlookup_path = level_folder.join("assetlookup.dat");
    let mut lookup = AssetLookup::open(BufReader::new(File::open(&assetlookup_path)?))?;
    let zone_ptrs = lookup.pointers(AssetKind::Zone)?;

    on_total(zone_ptrs.len());
    if zone_ptrs.is_empty() {
        return Ok(());
    }

    let zones_dat_path = level_folder.join("zones.dat");
    let mut zones_file = File::open(&zones_dat_path)?;

    for ptr in zone_ptrs {
        if ptr.length > crate::MAX_ASSET_SIZE {
            return Err(Error::AllocLimitExceeded {
                size: u64::from(ptr.length),
                limit: u64::from(crate::MAX_ASSET_SIZE),
            });
        }
        zones_file.seek(SeekFrom::Start(u64::from(ptr.offset)))?;
        let mut buf = vec![0u8; ptr.length as usize];
        zones_file.read_exact(&mut buf)?;
        let mut zone_ig = IgFile::open(Cursor::new(buf))?;
        on_each(parse_zone(&mut zone_ig, ptr.tuid)?);
    }
    Ok(())
}

fn parse_zone<R: Read + Seek>(zone: &mut IgFile<R>, zone_tuid: u64) -> Result<Zone> {
    let ufrags = parse_ufrags(zone)?;
    let ufrag_shader_tuids = read_shader_table(zone, SECT_UFRAG_SHADER_TABLE)?;

    let inst_section = match zone.section(SECT_TIE_INSTANCES) {
        Some(s) => s,
        None => {
            // Zone has no ties — that's valid (e.g. cubemap-only zones).
            return Ok(Zone {
                tuid: zone_tuid,
                tie_instances: Vec::new(),
                ufrags,
                ufrag_shader_tuids,
            });
        }
    };
    let name_section = zone.require_section(SECT_TIE_NAME_POINTERS)?;
    let tuid_section = zone.require_section(SECT_TIE_TUID_TABLE)?;

    let count = inst_section.count as usize;
    if count == 0 {
        return Ok(Zone {
            tuid: zone_tuid,
            tie_instances: Vec::new(),
            ufrags,
            ufrag_shader_tuids,
        });
    }

    // First pass: read each TieInstance's full 4×4 transform + tie index + bounds.
    let mut raws: Vec<RawTie> = Vec::with_capacity(count);
    for i in 0..count {
        let base = u64::from(inst_section.offset) + (i as u64) * TIE_INSTANCE_SIZE;
        zone.stream.seek_to(base)?;
        let mut matrix = [0f32; 16];
        for slot in matrix.iter_mut() {
            *slot = zone.stream.read_f32()?;
        }
        let (position, scale, quaternion) = decompose_row_major(&matrix);

        zone.stream.seek_to(base + 0x4C)?;
        let bounding_radius = zone.stream.read_f32()?;
        zone.stream.seek_to(base + 0x50)?;
        let tie_index = zone.stream.read_u32()?;
        raws.push(RawTie {
            tie_index,
            position,
            quaternion,
            scale,
            bounding_radius,
        });
    }

    // Second pass: read parallel name-pointer entries (AssetPointer-shaped).
    let mut metas: Vec<RawTieMeta> = Vec::with_capacity(count);
    for i in 0..count {
        let base = u64::from(name_section.offset) + (i as u64) * NAME_POINTER_SIZE;
        zone.stream.seek_to(base)?;
        let instance_tuid = zone.stream.read_u64()?;
        let name_ptr = u64::from(zone.stream.read_u32()?);
        let _length = zone.stream.read_u32()?;
        metas.push(RawTieMeta {
            instance_tuid,
            name_ptr,
        });
    }

    let names: Vec<String> = metas
        .iter()
        .map(|m| zone.stream.read_cstring_at(m.name_ptr))
        .collect::<Result<_>>()?;

    // Third pass: resolve tie asset TUIDs from the per-zone tuid table.
    //
    // Note on bounds: real R2 levels (e.g. `bay area`) have valid
    // `tie_index` values that read past the section's reported
    // `length` field — the IGHW format apparently has slack here and
    // the original parsers never checked. We keep `checked_mul` /
    // `checked_add` to prevent u64 overflow (which would wrap to a
    // bogus seek), but skip the strict `index < length/8` test —
    // `read_u64` returns a clean I/O error if the seek truly lands
    // past the embedded buffer.
    let mut tie_instances = Vec::with_capacity(count);
    for ((r, m), name) in raws.iter().zip(metas.iter()).zip(names.into_iter()) {
        let tie_index = u64::from(r.tie_index);
        let byte_offset = tie_index
            .checked_mul(8)
            .and_then(|x| x.checked_add(u64::from(tuid_section.offset)))
            .ok_or(Error::OffsetOverflow { id: SECT_TIE_TUID_TABLE })?;
        zone.stream.seek_to(byte_offset)?;
        let tie_tuid = zone.stream.read_u64()?;
        tie_instances.push(TieInstance {
            tie_tuid,
            instance_tuid: m.instance_tuid,
            name,
            position: r.position,
            quaternion: r.quaternion,
            scale: r.scale,
            bounding_radius: r.bounding_radius,
        });
    }

    Ok(Zone {
        tuid: zone_tuid,
        tie_instances,
        ufrags,
        ufrag_shader_tuids,
    })
}

/// Read the UFrag array (`0x6200`) plus their geometry from sections
/// `0x6000` (vertices, stride 0x18) and `0x6100` (u16 indices).
fn parse_ufrags<R: Read + Seek>(zone: &mut IgFile<R>) -> Result<Vec<UFrag>> {
    let Some(section) = zone.section(SECT_UFRAGS) else {
        return Ok(Vec::new());
    };

    // Slurp vertex/index buffers up front; cheaper than seeking per ufrag.
    let vertex_buf = if let Some(s) = zone.section(SECT_UFRAG_VERTICES) {
        zone.stream.seek_to(u64::from(s.offset))?;
        zone.stream.read_bytes(s.length as usize)?
    } else {
        Vec::new()
    };
    let index_buf = if let Some(s) = zone.section(SECT_UFRAG_INDICES) {
        zone.stream.seek_to(u64::from(s.offset))?;
        zone.stream.read_bytes(s.length as usize)?
    } else {
        Vec::new()
    };

    let count = section.count as usize;
    let mut ufrags = Vec::with_capacity(count);
    for i in 0..count {
        let base = u64::from(section.offset) + (i as u64) * UFRAG_SIZE;
        zone.stream.seek_to(base + 0x00)?;
        let tuid = zone.stream.read_u64()?;
        // 0x30..0x3C = bounding sphere centre, 0x3C..0x40 = radius.
        zone.stream.seek_to(base + 0x30)?;
        let position = zone.stream.read_vec3()?;
        let radius = zone.stream.read_f32()?;
        // 0x40 = u32 indexOffset, 0x44 = u32 vertexOffset.
        zone.stream.seek_to(base + 0x40)?;
        let index_offset = zone.stream.read_u32()?;
        let vertex_offset = zone.stream.read_u32()?;
        // 0x48 = u16 indexCount, 0x4A = u16 vertexCount.
        let index_count = zone.stream.read_u16()?;
        let vertex_count = zone.stream.read_u16()?;
        // 0x50 = u16 shaderIndex.
        zone.stream.seek_to(base + 0x50)?;
        let shader_index = zone.stream.read_u16()?;

        let (positions, uvs, indices) = decode_ufrag_mesh(
            &vertex_buf,
            &index_buf,
            vertex_offset,
            vertex_count,
            index_offset,
            index_count,
        );

        ufrags.push(UFrag {
            tuid,
            position,
            radius,
            vertex_count,
            index_count,
            shader_index,
            positions,
            uvs,
            indices,
        });
    }
    Ok(ufrags)
}

/// Decode one UFrag's geometry. Returns `(positions, uvs, indices)`. On
/// any out-of-bounds read it returns empty vectors instead of erroring —
/// individual zone meshes failing shouldn't block the rest of the level.
fn decode_ufrag_mesh(
    vertex_buf: &[u8],
    index_buf: &[u8],
    vertex_offset: u32,
    vertex_count: u16,
    index_offset: u32,
    index_count: u16,
) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    let v_start = vertex_offset as usize;
    let v_total = (vertex_count as usize) * UFRAG_VERTEX_STRIDE;
    let positions_uvs = if v_start + v_total > vertex_buf.len() {
        None
    } else {
        let mut positions = Vec::with_capacity((vertex_count as usize) * 3);
        let mut uvs = Vec::with_capacity((vertex_count as usize) * 2);
        for k in 0..(vertex_count as usize) {
            let base = v_start + k * UFRAG_VERTEX_STRIDE;
            let x = i16::from_be_bytes([vertex_buf[base], vertex_buf[base + 1]]) as f32;
            let y = i16::from_be_bytes([vertex_buf[base + 2], vertex_buf[base + 3]]) as f32;
            let z = i16::from_be_bytes([vertex_buf[base + 4], vertex_buf[base + 5]]) as f32;
            positions.push(x);
            positions.push(y);
            positions.push(z);
            // UV1 at 0x08, UV2 at 0x0C — we only keep UV1 for now.
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
        Some((positions, uvs))
    };

    let i_start = index_offset as usize;
    let i_total = (index_count as usize) * 2;
    let indices = if i_start + i_total > index_buf.len() {
        Vec::new()
    } else {
        let mut indices = Vec::with_capacity(index_count as usize);
        for k in 0..(index_count as usize) {
            let off = i_start + k * 2;
            let v = u16::from_be_bytes([index_buf[off], index_buf[off + 1]]);
            indices.push(u32::from(v));
        }
        indices
    };

    let (positions, uvs) = positions_uvs.unwrap_or_else(|| (Vec::new(), Vec::new()));
    (positions, uvs, indices)
}

struct RawTie {
    tie_index: u32,
    position: [f32; 3],
    quaternion: [f32; 4],
    scale: [f32; 3],
    bounding_radius: f32,
}

struct RawTieMeta {
    instance_tuid: u64,
    name_ptr: u64,
}
