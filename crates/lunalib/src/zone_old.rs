//! TOD-era zone reader (R&C: Tools of Destruction).
//!
//! Ported from ReLunacy `LibLunacy/Zone.cs::CZone` `isOld` branch +
//! `LibLunacy/AssetLoader.cs::LoadZonesOld`.
//!
//! ## Layout — TOD has **one zone per level**
//! Per ReLunacy's `LoadZonesOld`, TOD effectively has a single zone
//! ("art") loaded from `main.dat`. We mirror that: one [`Zone`]
//! returned, holding all tie instances (and eventually UFrags +
//! ufrag-shader links — those land in stages B.2 / B.3).
//!
//! ## Tie instances — section `0x9240` in `main.dat`
//! Array of `count` × `0x80`-byte records.
//!
//! ### `OldTieInstance` (0x80 bytes)
//! - `+0x00..0x40` `Matrix4x4` transformation (row-major per ReLunacy's
//!   `System.Numerics.Matrix4x4.Decompose` — translation lives at
//!   flat indices [12..14])
//! - `+0x40..0x4C` `Vector3` boundingPosition
//! - `+0x4C..0x50` `float` boundingRadius
//! - `+0x50` `u32` tie reference — **byte offset in `main.dat` of the
//!   matching `OldTie` header**, which is exactly the value
//!   [`crate::tie_old::TieAsset::tuid`] carries. So linking
//!   instance → prototype is a hash-map lookup by `tie_tuid`.
//!
//! ## What's NOT yet ported (planned)
//! - UFrag terrain (`0x6200`) — stage B.2.
//! - Zone shader table (`0x71A0`) → ufrag/material linking — stage B.3.
//! - The full tie / shader debug-name decoration ReLunacy does.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;
use crate::math::decompose_row_major;
use crate::zone::{TieInstance, Zone};

const SECT_OLD_TIE_INSTANCE: u32 = 0x9240;
const OLD_TIE_INSTANCE_SIZE: u64 = 0x80;

/// Read TOD-era zone(s) from `main.dat`.
///
/// Returns a single-element `Vec<Zone>` matching ReLunacy's
/// "one art zone" convention. The zone's `tie_instances` are
/// populated from `main.dat:0x9240`. UFrags + ufrag_shader_tuids are
/// empty for now (stages B.2 / B.3).
pub fn read_zones_old(level_folder: &Path) -> Result<Vec<Zone>> {
    let main_path = level_folder.join("main.dat");
    let mut main_ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let mut tie_instances: Vec<TieInstance> = Vec::new();
    if let Some(section) = main_ig.section(SECT_OLD_TIE_INSTANCE) {
        let count = section.count as usize;
        tie_instances.reserve(count);
        for i in 0..count {
            let base = u64::from(section.offset) + (i as u64) * OLD_TIE_INSTANCE_SIZE;
            match parse_one_tie_instance(&mut main_ig, base, i) {
                Ok(inst) => tie_instances.push(inst),
                Err(e) => {
                    eprintln!("warn: TOD tie-instance[{i}] skipped: {e}");
                }
            }
        }
    }

    Ok(vec![Zone {
        tuid: 0,
        tie_instances,
        ufrags: Vec::new(),
        ufrag_shader_tuids: Vec::new(),
    }])
}

fn parse_one_tie_instance<R: std::io::Read + std::io::Seek>(
    ig: &mut IgFile<R>,
    base: u64,
    index: usize,
) -> Result<TieInstance> {
    // Read the 4x4 transform — 16 floats. Row-major per ReLunacy.
    ig.stream.seek_to(base + 0x00)?;
    let mut m = [0f32; 16];
    for slot in m.iter_mut() {
        *slot = ig.stream.read_f32()?;
    }
    let (translation, scale, quat) = decompose_row_major(&m);

    ig.stream.seek_to(base + 0x4C)?;
    let bounding_radius = ig.stream.read_f32()?;

    ig.stream.seek_to(base + 0x50)?;
    let tie_ref = ig.stream.read_u32()?;

    Ok(TieInstance {
        // Tie reference is the byte offset of the OldTie header in
        // main.dat — matches `tie_old::TieAsset::tuid` so downstream
        // lookups work without translation.
        tie_tuid: u64::from(tie_ref),
        instance_tuid: index as u64,
        name: format!("TieInstance_{index:04X}"),
        position: translation,
        quaternion: quat,
        scale,
        bounding_radius,
    })
}
