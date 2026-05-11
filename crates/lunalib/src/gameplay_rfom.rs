//! RFOM gameplay placements — moby instances scattered through the level.
//!
//! Ported from IT's `levelmain/extract.cpp::EmbedMobys` (line 1281)
//! plus `common/include/insomnia/classes/gameplay.hpp`. The data
//! lives in `ps3gameplay.dat` (IGHW v0.2 with buffer-mode TOC entries
//! — `id == 0xFFFFFFFF` markers raw byte regions; the only class
//! entry is `0x25000 Gameplay`).
//!
//! ## Pointer chain
//! ```text
//!   0x25000 Gameplay (48 bytes)
//!     +0x20 PointerX86<GameplayInstances> instances
//!         GameplayInstances (192 bytes)
//!           +0x00 char name[64]
//!           +0x40 GameplayInstancesGroup<GameplayInstanceMoby> mobys
//!             +0x00 PointerX86<GameplayInstanceMoby> items
//!             +0x04 u32 numItems
//!             +0x08 u32 null[2]
//!               GameplayInstanceMoby[] (64 bytes each, Vector=12)
//! ```
//!
//! ## GameplayInstanceMoby layout (64 bytes)
//! - `+0x00` `PointerX86<IGHWHeader> embeded`
//! - `+0x04` `u32 unk0`
//! - `+0x08` `float unk1[2]`
//! - `+0x10..+0x1C` `Vector position` (3 floats, yard units → multiply by YARD_TO_M)
//! - `+0x1C..+0x28` `Vector rotation` (3 floats Euler radians, ZYX)
//! - `+0x28` `u32 null1`
//! - `+0x2C` `i32 unk2`
//! - `+0x30` `u32 null2`
//! - `+0x34` `u32 embedSize`
//! - `+0x38` `f32 unk3`
//! - `+0x3C` `u16 mobyClassIndex` — matches `MobyV1.mobyId` (we set as MobyAsset.tuid)
//! - `+0x3E` `u16 null3`
//!
//! Stride confirmed empirically: 211008 / 64 = 3297 ÷ — clean.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::{Error, Result};
use crate::gameplay::{GameplayLayout, MobyInstance, Region};
use crate::igfile::IgFile;

const SECT_GAMEPLAY: u32 = 0x25000;
const GAMEPLAY_INSTANCE_MOBY_SIZE: u64 = 0x40;

const YARD_TO_M: f32 = 0.9144;

pub fn read_gameplay_rfom(level_folder: &Path) -> Result<GameplayLayout> {
    let path = level_folder.join("ps3gameplay.dat");
    let mut ig = IgFile::open(BufReader::new(File::open(&path).map_err(|e| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("ps3gameplay.dat is required for RFOM moby placements: {e}"),
        ))
    })?))?;

    let gp_section = match ig.section(SECT_GAMEPLAY) {
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

    // Gameplay struct at gp_section.offset.
    // +0x20 = instances PointerX86<GameplayInstances>.
    let gameplay_off = u64::from(gp_section.offset);
    ig.stream.seek_to(gameplay_off + 0x20)?;
    let instances_ptr = u64::from(ig.stream.read_u32()?);
    if instances_ptr == 0 {
        return Ok(GameplayLayout {
            regions: vec![Region {
                name: "art".to_string(),
                moby_instances: Vec::new(),
            }],
        });
    }

    // GameplayInstances at instances_ptr.
    // +0x40 = mobys group: items ptr + numItems.
    let mobys_group_off = instances_ptr + 0x40;
    ig.stream.seek_to(mobys_group_off + 0x00)?;
    let items_ptr = u64::from(ig.stream.read_u32()?);
    let num_items = ig.stream.read_u32()?;

    if std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
        eprintln!(
            "[rfom-gp] Gameplay@0x{gameplay_off:X} instances@0x{instances_ptr:X} items@0x{items_ptr:X} numItems={num_items}"
        );
    }

    if items_ptr == 0 || num_items == 0 {
        return Ok(GameplayLayout {
            regions: vec![Region {
                name: "art".to_string(),
                moby_instances: Vec::new(),
            }],
        });
    }

    let mut moby_instances: Vec<MobyInstance> = Vec::with_capacity(num_items as usize);
    let mut sample_logged = 0usize;
    for i in 0..num_items {
        let base = items_ptr + (i as u64) * GAMEPLAY_INSTANCE_MOBY_SIZE;

        ig.stream.seek_to(base + 0x10)?;
        let pos = ig.stream.read_vec3()?;

        ig.stream.seek_to(base + 0x1C)?;
        let rot = ig.stream.read_vec3()?;

        ig.stream.seek_to(base + 0x3C)?;
        let moby_class_index = ig.stream.read_u16()?;

        let position_m = [pos[0] * YARD_TO_M, pos[1] * YARD_TO_M, pos[2] * YARD_TO_M];

        if sample_logged < 3 && std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
            eprintln!(
                "[rfom-gp-moby] [{i}] class=0x{moby_class_index:04X} raw_yards=({:.2}, {:.2}, {:.2}) → m=({:.2}, {:.2}, {:.2})",
                pos[0], pos[1], pos[2],
                position_m[0], position_m[1], position_m[2]
            );
            sample_logged += 1;
        }

        moby_instances.push(MobyInstance {
            moby_tuid: u64::from(moby_class_index),
            instance_tuid: i as u64,
            name: format!("Moby_{moby_class_index:04X}_Instance_{i:04X}"),
            position: position_m,
            rotation: rot,
            scale: 1.0,
            group: 0,
        });
    }
    if std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
        eprintln!("[rfom-gp-moby] {} moby placements scaled to meters", moby_instances.len());
    }

    Ok(GameplayLayout {
        regions: vec![Region {
            name: "art".to_string(),
            moby_instances,
        }],
    })
}
