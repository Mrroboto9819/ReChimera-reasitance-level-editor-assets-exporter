//! TOD-era gameplay reader — placed moby instances.
//!
//! Ported from ReLunacy `LibLunacy/Gameplay.cs` `isOld` branch
//! (`Region(IGFile, AssetLoader)` constructor at line 127).
//!
//! ## Layout
//! `gameplay.dat` is one IGHW. Section `0x7340` holds an array of
//! `OldMobyInstance` records (0x48 bytes each). One single region
//! ("art") contains every instance — no per-region split like V2.
//!
//! ## OldMobyInstance struct (0x48 bytes)
//! - `+0x18` `Vector3` position
//! - `+0x24` `Vector3` rotation (ZYX Euler radians)
//! - `+0x30` `f32`     scale (single uniform scalar)
//! - `+0x3C` `u16`     mobyIndex — direct index into the moby DB read
//!   from `main.dat:0xD100`

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::gameplay::{GameplayLayout, MobyInstance, Region};
use crate::igfile::IgFile;

const SECT_OLD_MOBY_INSTANCES: u32 = 0x7340;
const OLD_MOBY_INSTANCE_SIZE: u64 = 0x48;

/// Read placed moby instances from a TOD-era `gameplay.dat`.
pub fn read_gameplay_old(level_folder: &Path) -> Result<GameplayLayout> {
    let gameplay_path = level_folder.join("gameplay.dat");
    let mut gameplay = IgFile::open(BufReader::new(File::open(&gameplay_path)?))?;

    let section = match gameplay.section(SECT_OLD_MOBY_INSTANCES) {
        Some(s) => s,
        None => {
            return Ok(GameplayLayout {
                regions: vec![Region {
                    name: "art".to_string(),
                    moby_instances: Vec::new(),
                }],
            });
        }
    };

    let count = section.count as usize;
    let mut moby_instances: Vec<MobyInstance> = Vec::with_capacity(count);
    for i in 0..count {
        let base = u64::from(section.offset) + (i as u64) * OLD_MOBY_INSTANCE_SIZE;

        gameplay.stream.seek_to(base + 0x18)?;
        let pos = gameplay.stream.read_vec3()?;
        gameplay.stream.seek_to(base + 0x24)?;
        let rot = gameplay.stream.read_vec3()?;
        gameplay.stream.seek_to(base + 0x30)?;
        let scale = gameplay.stream.read_f32()?;
        gameplay.stream.seek_to(base + 0x3C)?;
        let moby_index = gameplay.stream.read_u16()?;

        moby_instances.push(MobyInstance {
            moby_tuid: u64::from(moby_index),
            instance_tuid: i as u64,
            name: format!("Moby_{moby_index:04X}_Instance_{i:04X}"),
            position: pos,
            rotation: rot,
            scale,
            group: 0,
        });
    }

    Ok(GameplayLayout {
        regions: vec![Region {
            name: "art".to_string(),
            moby_instances,
        }],
    })
}
