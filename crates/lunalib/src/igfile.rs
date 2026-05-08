use std::io::{Read, Seek};

use crate::error::{Error, Result};
use crate::stream::{Endian, StreamHelper};

/// 'IHGW' read big-endian — the on-disk magic for big-endian PS3 files.
const MAGIC_BIG: u32 = 0x4947_4857;
/// 'IGHW' read big-endian — same four bytes seen on a little-endian file.
const MAGIC_LITTLE: u32 = 0x5748_4749;

/// One entry in the section table at the start of every IGHW file.
#[derive(Debug, Clone, Copy)]
pub struct SectionHeader {
    pub id: u32,
    pub offset: u32,
    pub count: u32,
    pub length: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u16,
    pub minor: u16,
}

/// Parsed IGHW header. The underlying stream is retained so callers can read
/// section bodies on demand without reopening the file.
pub struct IgFile<R: Read + Seek> {
    pub stream: StreamHelper<R>,
    pub version: Version,
    pub sections: Vec<SectionHeader>,
}

impl<R: Read + Seek> IgFile<R> {
    pub fn open(inner: R) -> Result<Self> {
        let mut sh = StreamHelper::new(inner, Endian::Big);
        sh.seek_to(0)?;

        let magic = sh.read_u32()?;
        match magic {
            MAGIC_BIG => {}
            MAGIC_LITTLE => sh.endian = Endian::Little,
            other => return Err(Error::BadMagic(other)),
        }

        let major = sh.read_u16()?;
        let minor = sh.read_u16()?;
        let version = Version { major, minor };

        let (section_count, sections_offset) = match (major, minor) {
            (1, 1) => {
                let section_count = sh.read_u32()?;
                let _header_length = sh.read_u32()?;
                let _file_length = sh.read_u32()?;
                let _unknown = sh.read_u32()?;
                (section_count, 0x20u64)
            }
            (0, 2) => {
                let section_count = sh.read_u32()?;
                (section_count, 0x10u64)
            }
            _ => return Err(Error::UnsupportedVersion { major, minor }),
        };

        sh.seek_to(sections_offset)?;
        if (section_count as usize) > crate::MAX_SECTION_ENTRIES {
            return Err(Error::AllocLimitExceeded {
                size: u64::from(section_count),
                limit: crate::MAX_SECTION_ENTRIES as u64,
            });
        }
        let mut sections = Vec::with_capacity(section_count as usize);
        for _ in 0..section_count {
            let id = sh.read_u32()?;
            let offset = sh.read_u32()?;
            // High bit of `count` is a flag in some sections (matches LibLunacy's mask).
            let count = sh.read_u32()? & !0x1000_0000;
            let length = sh.read_u32()?;
            sections.push(SectionHeader { id, offset, count, length });
        }

        Ok(Self { stream: sh, version, sections })
    }

    pub fn section(&self, id: u32) -> Option<SectionHeader> {
        self.sections.iter().copied().find(|s| s.id == id)
    }

    pub fn require_section(&self, id: u32) -> Result<SectionHeader> {
        self.section(id).ok_or(Error::SectionNotFound(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Build a minimal IGHW v1.1 big-endian header with one synthetic section.
    /// The v1.1 header is 0x20 bytes; section table starts at 0x20.
    fn synthetic_v1_1() -> Vec<u8> {
        let mut buf = Vec::new();
        // 0x00 magic ('IHGW' big-endian)
        buf.extend_from_slice(&0x4947_4857u32.to_be_bytes());
        // 0x04 version 1.1
        buf.extend_from_slice(&1u16.to_be_bytes());
        buf.extend_from_slice(&1u16.to_be_bytes());
        // 0x08 section count
        buf.extend_from_slice(&1u32.to_be_bytes());
        // 0x0C header length, 0x10 file length, 0x14 unknown
        buf.extend_from_slice(&0x20u32.to_be_bytes());
        buf.extend_from_slice(&0x40u32.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes());
        // 0x18..0x20 padding before section table
        buf.extend_from_slice(&[0u8; 8]);
        // 0x20 first section: id 0xD100, offset 0x30, count 7, length 0x10
        buf.extend_from_slice(&0xD100u32.to_be_bytes());
        buf.extend_from_slice(&0x30u32.to_be_bytes());
        buf.extend_from_slice(&7u32.to_be_bytes());
        buf.extend_from_slice(&0x10u32.to_be_bytes());
        buf
    }

    #[test]
    fn parses_v1_1_header() {
        let bytes = synthetic_v1_1();
        let f = IgFile::open(Cursor::new(bytes)).unwrap();
        assert_eq!(f.version, Version { major: 1, minor: 1 });
        assert_eq!(f.sections.len(), 1);
        assert_eq!(f.sections[0].id, 0xD100);
        assert_eq!(f.sections[0].offset, 0x30);
        assert_eq!(f.sections[0].count, 7);
        assert_eq!(f.sections[0].length, 0x10);
    }

    #[test]
    fn rejects_bad_magic() {
        let bytes = vec![0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 0];
        let result = IgFile::open(Cursor::new(bytes));
        assert!(matches!(result, Err(Error::BadMagic(_))));
    }

    #[test]
    fn require_section_errors_when_missing() {
        let f = IgFile::open(Cursor::new(synthetic_v1_1())).unwrap();
        assert!(f.section(0xFFFF).is_none());
        assert!(f.require_section(0xFFFF).is_err());
    }
}
