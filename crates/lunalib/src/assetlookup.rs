use std::io::{Read, Seek};

use crate::error::{Error, Result};
use crate::igfile::IgFile;

/// 0x10-byte entry in an `assetlookup.dat` section: a TUID-keyed pointer into
/// the matching `<kind>.dat` blob file (e.g. `mobys.dat`, `ties.dat`).
#[derive(Debug, Clone, Copy)]
pub struct AssetPointer {
    pub tuid: u64,
    pub offset: u32,
    pub length: u32,
}

const ASSET_POINTER_SIZE: u32 = 0x10;

/// Section IDs used by the new (Future / Resistance 2+) engine generation.
///
/// Confirmed against R&C Future via LibLunacy + cross-checked against
/// InsomniaToolset's [resource.hpp](../../../../InsomniaToolset/common/include/insomnia/classes/resource.hpp)
/// `ResourceLookup<>` aliases for the IDs we hadn't yet mapped (Animset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Shader,
    HighMip,
    Tie,
    Moby,
    Zone,
    /// Animation sets — pointers into `animsets.dat`. One animset typically
    /// corresponds to one character/weapon's full clip library (idle, walk,
    /// run, fire, …). Section ID confirmed against IT's
    /// `ResourceAnimsets = ResourceLookup<0x1d700>`.
    Animset,
}

impl AssetKind {
    pub const fn section_id(self) -> u32 {
        match self {
            AssetKind::Shader => 0x1D100,
            AssetKind::HighMip => 0x1D1C0,
            AssetKind::Tie => 0x1D300,
            AssetKind::Moby => 0x1D600,
            AssetKind::Animset => 0x1D700,
            AssetKind::Zone => 0x1DA00,
        }
    }

    pub const fn all() -> &'static [AssetKind] {
        &[
            AssetKind::Shader,
            AssetKind::HighMip,
            AssetKind::Tie,
            AssetKind::Moby,
            AssetKind::Animset,
            AssetKind::Zone,
        ]
    }

    pub const fn name(self) -> &'static str {
        match self {
            AssetKind::Shader => "shader",
            AssetKind::HighMip => "highmip",
            AssetKind::Tie => "tie",
            AssetKind::Moby => "moby",
            AssetKind::Animset => "animset",
            AssetKind::Zone => "zone",
        }
    }
}

pub struct AssetLookup<R: Read + Seek> {
    pub file: IgFile<R>,
}

impl<R: Read + Seek> AssetLookup<R> {
    pub fn open(reader: R) -> Result<Self> {
        Ok(Self { file: IgFile::open(reader)? })
    }

    /// Return the asset pointer table for the given asset kind, or an empty
    /// vector if the section is absent in this file.
    pub fn pointers(&mut self, kind: AssetKind) -> Result<Vec<AssetPointer>> {
        let Some(section) = self.file.section(kind.section_id()) else {
            return Ok(Vec::new());
        };

        if section.length % ASSET_POINTER_SIZE != 0 {
            return Err(Error::SectionLengthMismatch {
                id: section.id,
                length: section.length,
                entry: ASSET_POINTER_SIZE,
            });
        }

        let count = (section.length / ASSET_POINTER_SIZE) as usize;
        self.file.stream.seek_to(u64::from(section.offset))?;

        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let tuid = self.file.stream.read_u64()?;
            let offset = self.file.stream.read_u32()?;
            let length = self.file.stream.read_u32()?;
            out.push(AssetPointer { tuid, offset, length });
        }
        Ok(out)
    }
}
