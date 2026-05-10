use std::io::{Read, Seek};

use crate::error::{Error, Result};
use crate::stream::{Endian, StreamHelper};

const MAGIC_BIG: u32 = 0x4947_4857;

const MAGIC_LITTLE: u32 = 0x5748_4749;

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

    fn synthetic_v1_1() -> Vec<u8> {
        let mut buf = Vec::new();

        buf.extend_from_slice(&0x4947_4857u32.to_be_bytes());

        buf.extend_from_slice(&1u16.to_be_bytes());
        buf.extend_from_slice(&1u16.to_be_bytes());

        buf.extend_from_slice(&1u32.to_be_bytes());

        buf.extend_from_slice(&0x20u32.to_be_bytes());
        buf.extend_from_slice(&0x40u32.to_be_bytes());
        buf.extend_from_slice(&0u32.to_be_bytes());

        buf.extend_from_slice(&[0u8; 8]);

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
