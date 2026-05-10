use std::path::Path;

use crate::error::{Error, Result};

/// On-disk layout of a level folder.
///
/// Insomniac shipped levels in **three** engine eras with different
/// folder shapes. All three must remain supported simultaneously —
/// never replace one with the others.
///
/// - `V2` — used by Resistance 2 / R3 / Ratchet & Clank: Full Frontal
///   Assault. The folder contains `assetlookup.dat` plus per-kind
///   sibling files (`mobys.dat`, `ties.dat`, `shaders.dat`,
///   `highmips.dat`, `animsets.dat`, `zones.dat`, …). The asset table
///   in `assetlookup.dat` indexes those siblings by tuid.
///
/// - `Tod` — used by R&C Future: Tools of Destruction (and likely
///   related TOD-era titles). The folder contains `main.dat` (no
///   `assetlookup.dat`); asset tables for mobys / ties / shaders /
///   textures / zones live **embedded inside `main.dat`** keyed by
///   IGHW class ID. Vertex data lives in a sibling `vertices.dat`,
///   pixel data in `textures.dat` (+ optional `texstream.dat` for
///   higher mips).
///
/// - `Rfom` — used by Resistance: Fall of Man. The folder contains
///   `ps3levelmain.dat` as its single entry point — IT's
///   `levelmain/extract.cpp` is the canonical reference. IGHW
///   container version is `(0, 2)` rather than `(1, 1)`. Currently
///   detected and acknowledged but extraction is **not yet wired**;
///   the run_extract pipeline only probes section IDs and logs them
///   so we can plan the IT port off real bytes.
///
/// Discriminator order: TOD before V2 (since `main.dat` is the most
/// specific marker), RFOM last (its filename is unique enough not to
/// collide with the others). The first match wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LevelLayout {
    /// V2 / R3 / FFA — `assetlookup.dat` plus per-kind sibling `.dat` files.
    V2,
    /// TOD — `main.dat` embeds asset tables; `vertices.dat` + `textures.dat` are sidecars.
    Tod,
    /// RFOM — single bundled `ps3levelmain.dat`. Detection only; extraction TODO.
    Rfom,
}

/// Inspect `folder` and return which on-disk layout it uses.
///
/// Returns `Error::SectionNotFound(0)` if neither `main.dat` nor
/// `assetlookup.dat` is present (we re-use the section-not-found
/// variant rather than introduce a new error type for this one case;
/// the caller surfaces a friendlier message).
pub fn detect_layout(folder: &Path) -> Result<LevelLayout> {
    if folder.join("main.dat").is_file() {
        return Ok(LevelLayout::Tod);
    }
    if folder.join("assetlookup.dat").is_file() {
        return Ok(LevelLayout::V2);
    }
    if folder.join("ps3levelmain.dat").is_file() {
        return Ok(LevelLayout::Rfom);
    }
    Err(Error::SectionNotFound(0))
}

impl LevelLayout {
    /// A short tag suitable for surfacing to the user / logging.
    pub fn tag(self) -> &'static str {
        match self {
            LevelLayout::V2 => "v2",
            LevelLayout::Tod => "tod",
            LevelLayout::Rfom => "rfom",
        }
    }

    /// Human-friendly name.
    pub fn label(self) -> &'static str {
        match self {
            LevelLayout::V2 => "V2 (assetlookup.dat)",
            LevelLayout::Tod => "TOD (main.dat)",
            LevelLayout::Rfom => "RFOM (ps3levelmain.dat)",
        }
    }
}
