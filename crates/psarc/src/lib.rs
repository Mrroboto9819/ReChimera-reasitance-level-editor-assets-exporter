//! PlayStation Archive (PSARC) reader.
//!
//! Rust port of the Java reference at
//! `psarc/app/src/main/java/sh/adelessfox/psarc/archive/psarc/`.
//! Format: PSAR magic, big-endian, v1.3 / v1.4. The TOC describes one entry
//! per file; the first entry is the manifest (a `\n` / `\0`-separated list
//! of file paths). Subsequent entries are matched to manifest paths by MD5
//! hash of the path string. File data is split into fixed-size blocks; per-
//! block compressed sizes live in a `u16[]` array right after the TOC.
//!
//! Supported compression: **ZLIB** (most PS3-era archives). LZMA and OODLE
//! are recognized but not yet decoded — they return
//! `Error::UnsupportedCompression` from `Archive::open`.

pub mod error;
pub mod reader;

pub use error::{Error, Result};
pub use reader::{Archive, Compression, Entry, Header};
