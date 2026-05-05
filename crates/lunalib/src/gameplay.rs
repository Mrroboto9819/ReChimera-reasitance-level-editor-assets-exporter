//! Parser for `gameplay.dat` and per-region `gp_prius.dat` / `region.dat`.
//!
//! Ported from [LibLunacy/Gameplay.cs](../../../../LibLunacy/Gameplay.cs).
//! New-engine path only (Resistance 2/3, R&C Future). The "old" engine path
//! used by Resistance: Fall of Man is not implemented yet.
//!
//! Layout (new engine):
//!
//! - `gameplay.dat`
//!   - section `0x25000` — region string table. Last 16 bytes contain
//!     `(region_count: u32, region_table_offset: u32)`. Each region table
//!     entry is a `u32` offset to a NUL-terminated region name.
//!
//! - `<region>/gp_prius.dat`
//!   - section `0x25048` — packed `NewMobyInstance` (0x50 each)
//!   - section `0x2504C` — parallel `NewVolumeInstanceMetadata` (0x10 each)
//!     with TUID + name pointer + group
//!
//! - `<region>/region.dat`
//!   - section `0x1C600` — `u64` table of moby asset TUIDs, indexed by
//!     `NewMobyInstance.moby_index`.

use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

use crate::error::{Error, Result};
use crate::igfile::IgFile;

const SECT_GAMEPLAY_STRINGS: u32 = 0x25000;
const SECT_PRIUS_MOBY_INSTANCES: u32 = 0x25048;
const SECT_PRIUS_MOBY_METADATA: u32 = 0x2504C;
const SECT_REGION_MOBY_TUIDS: u32 = 0x1C600;

const MOBY_INSTANCE_SIZE: u64 = 0x50;
const MOBY_METADATA_SIZE: u64 = 0x10;

#[derive(Debug, Clone)]
pub struct GameplayLayout {
    pub regions: Vec<Region>,
}

#[derive(Debug, Clone)]
pub struct Region {
    pub name: String,
    pub moby_instances: Vec<MobyInstance>,
}

#[derive(Debug, Clone)]
pub struct MobyInstance {
    /// TUID of the moby *asset* this is an instance of.
    pub moby_tuid: u64,
    /// TUID of *this specific placement* — unique within the level.
    pub instance_tuid: u64,
    pub name: String,
    pub position: [f32; 3],
    /// ZYX Euler angles in radians.
    pub rotation: [f32; 3],
    pub scale: f32,
    pub group: u16,
}

/// Open `<level_folder>/gameplay.dat`, walk its region table, and parse every
/// per-region `gp_prius.dat` / `region.dat` pair found alongside it.
pub fn read_gameplay(level_folder: &Path) -> Result<GameplayLayout> {
    let gameplay_path = level_folder.join("gameplay.dat");
    let gp_file = File::open(&gameplay_path)?;
    let mut gameplay = IgFile::open(BufReader::new(gp_file))?;

    let region_names = read_region_names(&mut gameplay)?;

    let mut regions = Vec::with_capacity(region_names.len());
    for name in region_names {
        let region = read_region(level_folder, &name)?;
        regions.push(region);
    }
    Ok(GameplayLayout { regions })
}

/// `gameplay.dat` is unusual: in section `0x25000`, `count` holds the section's
/// byte length and `length` is zero. The region table descriptor lives in the
/// last 16 bytes of that section.
fn read_region_names<R: Read + Seek>(gameplay: &mut IgFile<R>) -> Result<Vec<String>> {
    let str_section = gameplay.require_section(SECT_GAMEPLAY_STRINGS)?;
    let bytes = u64::from(str_section.count);
    if bytes < 0x10 {
        return Err(Error::SectionLengthMismatch {
            id: SECT_GAMEPLAY_STRINGS,
            length: str_section.count,
            entry: 0x10,
        });
    }
    let descriptor_offset = u64::from(str_section.offset) + bytes - 0x10;

    gameplay.stream.seek_to(descriptor_offset)?;
    let region_count = gameplay.stream.read_u32()?;
    let region_table_offset = u64::from(gameplay.stream.read_u32()?);

    let mut names = Vec::with_capacity(region_count as usize);
    for i in 0..region_count {
        gameplay
            .stream
            .seek_to(region_table_offset + 4 * u64::from(i))?;
        let name_offset = u64::from(gameplay.stream.read_u32()?);
        let name = gameplay.stream.read_cstring_at(name_offset)?;
        names.push(name);
    }
    Ok(names)
}

fn read_region(level_folder: &Path, name: &str) -> Result<Region> {
    let region_dir = level_folder.join(name);

    let prius_path = region_dir.join("gp_prius.dat");
    let region_path = region_dir.join("region.dat");

    let mut prius = IgFile::open(BufReader::new(File::open(&prius_path)?))?;
    let mut region = IgFile::open(BufReader::new(File::open(&region_path)?))?;

    let inst_section = prius.require_section(SECT_PRIUS_MOBY_INSTANCES)?;
    let meta_section = prius.require_section(SECT_PRIUS_MOBY_METADATA)?;
    let tuid_section = region.require_section(SECT_REGION_MOBY_TUIDS)?;

    let count = inst_section.count as usize;

    // First pass: read NewMobyInstance entries (positions/rotations/scales).
    let mut raw_instances: Vec<RawMobyInstance> = Vec::with_capacity(count);
    for i in 0..count {
        let base = u64::from(inst_section.offset) + (i as u64) * MOBY_INSTANCE_SIZE;
        prius.stream.seek_to(base + 0x00)?;
        let moby_index = prius.stream.read_u16()?;
        let _group_index = prius.stream.read_u16()?;
        prius.stream.seek_to(base + 0x14)?;
        let position = prius.stream.read_vec3()?;
        prius.stream.seek_to(base + 0x20)?;
        let rotation = prius.stream.read_vec3()?;
        prius.stream.seek_to(base + 0x2C)?;
        let scale = prius.stream.read_f32()?;
        raw_instances.push(RawMobyInstance {
            moby_index,
            position,
            rotation,
            scale,
        });
    }

    // Second pass: read per-instance metadata (TUID, name pointer, group).
    let mut raw_metadata: Vec<RawMobyMetadata> = Vec::with_capacity(count);
    for i in 0..count {
        let base = u64::from(meta_section.offset) + (i as u64) * MOBY_METADATA_SIZE;
        prius.stream.seek_to(base + 0x00)?;
        let instance_tuid = prius.stream.read_u64()?;
        let name_ptr = u64::from(prius.stream.read_u32()?);
        let group = prius.stream.read_u16()?;
        raw_metadata.push(RawMobyMetadata {
            instance_tuid,
            name_ptr,
            group,
        });
    }

    // Resolve names (separate loop to avoid alternating seeks).
    let names: Vec<String> = raw_metadata
        .iter()
        .map(|m| prius.stream.read_cstring_at(m.name_ptr))
        .collect::<Result<_>>()?;

    // Third pass: resolve moby asset TUIDs from region.dat's index → tuid table.
    let mut moby_instances = Vec::with_capacity(count);
    for ((raw, meta), name) in raw_instances
        .iter()
        .zip(raw_metadata.iter())
        .zip(names.into_iter())
    {
        region
            .stream
            .seek_to(u64::from(tuid_section.offset) + 8 * u64::from(raw.moby_index))?;
        let moby_tuid = region.stream.read_u64()?;
        moby_instances.push(MobyInstance {
            moby_tuid,
            instance_tuid: meta.instance_tuid,
            name,
            position: raw.position,
            rotation: raw.rotation,
            scale: raw.scale,
            group: meta.group,
        });
    }

    Ok(Region {
        name: name.to_string(),
        moby_instances,
    })
}

struct RawMobyInstance {
    moby_index: u16,
    position: [f32; 3],
    rotation: [f32; 3],
    scale: f32,
}

struct RawMobyMetadata {
    instance_tuid: u64,
    name_ptr: u64,
    group: u16,
}
