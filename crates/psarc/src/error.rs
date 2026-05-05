use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("not a PSARC file (magic was {0:?})")]
    BadMagic([u8; 4]),

    #[error("unsupported PSARC version {major}.{minor} (only 1.3 / 1.4 are supported)")]
    UnsupportedVersion { major: u16, minor: u16 },

    #[error("unsupported compression {0:?} (only ZLIB is implemented; LZMA / OODLE require additional crates)")]
    UnsupportedCompression([u8; 4]),

    #[error("TOC entry size {0} does not match expected 30 bytes")]
    BadEntrySize(u32),

    #[error("decompression failed: {0}")]
    Decompress(String),

    #[error("file not found in archive: {0}")]
    NotFound(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
