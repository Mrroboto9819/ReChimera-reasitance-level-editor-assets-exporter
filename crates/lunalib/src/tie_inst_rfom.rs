//! RFOM tie placements (`0x9300 TieInstanceV1`).
//!
//! Ported from IT's struct definition in
//! `common/include/insomnia/classes/tie.hpp:146`. The 0x9300 section
//! lives in `ps3levelmain.dat` (v1.1 IGHW) so no v0.2 buffer-mode
//! gymnastics needed.
//!
//! ## TieInstanceV1 layout (`0xC0` = 192 bytes)
//! - `+0x00..+0x40` `Matrix44 tm`  (16 floats, row-major per V2 convention)
//! - `+0x40..+0x80` `OOBB bounds` (Spike: 64 bytes — origin Vector4A16 + 3×Vector4A16 extents)
//! - `+0x80` `u16 lightMapIndex`
//! - `+0x82` `u16 unk0`
//! - `+0x84` `u32 offset0`
//! - `+0x88` `u32 offset1`
//! - `+0x8C` `PointerX86<TieV1> tie` — file offset of the TieV1 entry in 0x3400
//! - `+0x90..+0xC0` `u32 unk[12]`

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;
use crate::math::decompose_row_major;
use crate::zone::TieInstance;

const SECT_TIE_INSTANCE: u32 = 0x9300;
const TIE_INSTANCE_SIZE: u64 = 0xC0;

/// Per IT `levelmain/extract.cpp` (lines 767, 847, 1021), RFOM tie
/// instance transforms have their translation column scaled by
/// `YARD_TO_M` to convert from raw yards to meters — matching the
/// moby placement convention used elsewhere on this game.
const YARD_TO_M: f32 = 0.9144;

pub fn read_tie_instances_rfom(level_folder: &Path) -> Result<Vec<TieInstance>> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut main_ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let section = match main_ig.section(SECT_TIE_INSTANCE) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    if section.length != TIE_INSTANCE_SIZE as u32 {
        eprintln!(
            "warn: 0x9300 TieInstanceV1 length is {} (expected {}) — skipping",
            section.length, TIE_INSTANCE_SIZE
        );
        return Ok(Vec::new());
    }

    let count = section.count as usize;
    let mut out: Vec<TieInstance> = Vec::with_capacity(count);
    let mut sample_logged = 0usize;
    let log_probes = std::env::var("RECHIMERA_LOG_PROBES").is_ok();
    for i in 0..count {
        let base = u64::from(section.offset) + (i as u64) * TIE_INSTANCE_SIZE;

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

        if sample_logged < 3 && log_probes {
            eprintln!(
                "[rfom-tie-inst] [{i}] raw_pos=({:.2}, {:.2}, {:.2}) → meters=({:.2}, {:.2}, {:.2}) scale=({:.3}, {:.3}, {:.3})",
                position_raw[0], position_raw[1], position_raw[2],
                position[0], position[1], position[2],
                scale[0], scale[1], scale[2]
            );
            sample_logged += 1;
        }

        main_ig.stream.seek_to(base + 0x8C)?;
        let tie_ptr = u64::from(main_ig.stream.read_u32()?);

        out.push(TieInstance {
            tie_tuid: tie_ptr,
            instance_tuid: i as u64,
            name: format!("TieInstance_{i:04X}"),
            position,
            quaternion,
            scale,
            bounding_radius: 0.0,
        });
    }
    if log_probes {
        eprintln!("[rfom-tie-inst] {} tie placements scaled to meters", out.len());
    }
    Ok(out)
}
