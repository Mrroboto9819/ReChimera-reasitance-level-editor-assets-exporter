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
/// Mirrors the full `ResourceLookup<>` registry in InsomniaToolset
/// (`common/include/insomnia/classes/resource.hpp`). Sections that have no
/// decoder yet are still enumerated here so manifests / hierarchies can
/// surface them (the FE will show a count and "decoder not yet
/// implemented" tag for those).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetKind {
    Shader,
    Texture,
    HighMip,
    Cubemap,
    Tie,
    Foliage,
    Shrub,
    Moby,
    Animset,
    Cinematic,
    Zone,
    Lighting,
}

impl AssetKind {
    pub const fn section_id(self) -> u32 {
        match self {
            AssetKind::Shader => 0x1D100,
            AssetKind::Texture => 0x1D180,
            AssetKind::HighMip => 0x1D1C0,
            AssetKind::Cubemap => 0x1D200,
            AssetKind::Tie => 0x1D300,
            AssetKind::Foliage => 0x1D400,
            AssetKind::Shrub => 0x1D500,
            AssetKind::Moby => 0x1D600,
            AssetKind::Animset => 0x1D700,
            AssetKind::Cinematic => 0x1D800,
            AssetKind::Zone => 0x1DA00,
            AssetKind::Lighting => 0x1DB00,
        }
    }

    pub const fn all() -> &'static [AssetKind] {
        &[
            AssetKind::Shader,
            AssetKind::Texture,
            AssetKind::HighMip,
            AssetKind::Cubemap,
            AssetKind::Tie,
            AssetKind::Foliage,
            AssetKind::Shrub,
            AssetKind::Moby,
            AssetKind::Animset,
            AssetKind::Cinematic,
            AssetKind::Zone,
            AssetKind::Lighting,
        ]
    }

    pub const fn name(self) -> &'static str {
        match self {
            AssetKind::Shader => "shader",
            AssetKind::Texture => "texture",
            AssetKind::HighMip => "highmip",
            AssetKind::Cubemap => "cubemap",
            AssetKind::Tie => "tie",
            AssetKind::Foliage => "foliage",
            AssetKind::Shrub => "shrub",
            AssetKind::Moby => "moby",
            AssetKind::Animset => "animset",
            AssetKind::Cinematic => "cinematic",
            AssetKind::Zone => "zone",
            AssetKind::Lighting => "lighting",
        }
    }

    /// Whether lunalib currently has a decoder for this kind. The
    /// manifest still lists undecoded kinds so the user can see they
    /// exist — the viewport / asset pipeline just can't render them yet.
    pub const fn has_decoder(self) -> bool {
        matches!(
            self,
            AssetKind::Shader
                | AssetKind::HighMip
                | AssetKind::Tie
                | AssetKind::Moby
                | AssetKind::Animset
                | AssetKind::Zone
        )
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
        if count > crate::MAX_SECTION_ENTRIES {
            return Err(Error::AllocLimitExceeded {
                size: count as u64,
                limit: crate::MAX_SECTION_ENTRIES as u64,
            });
        }
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
