use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("not an IGHW file (got magic 0x{0:08X})")]
    BadMagic(u32),

    #[error("unsupported IGHW version {major}.{minor}")]
    UnsupportedVersion { major: u16, minor: u16 },

    #[error("section 0x{0:X} not found")]
    SectionNotFound(u32),

    #[error("section 0x{id:X} length {length} is not a multiple of entry size {entry}")]
    SectionLengthMismatch { id: u32, length: u32, entry: u32 },

    #[error("section 0x{id:X}: index {index} out of bounds (max {max})")]
    IndexOutOfBounds { id: u32, index: u64, max: u64 },

    #[error("integer overflow computing offset in section 0x{id:X}")]
    OffsetOverflow { id: u32 },

    #[error("asset payload size {size} exceeds limit {limit}")]
    AllocLimitExceeded { size: u64, limit: u64 },

    #[error("glTF serialization failed: {0}")]
    GltfWrite(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
