use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use byteorder::{BigEndian, ReadBytesExt};
use flate2::read::ZlibDecoder;
use md5::{Digest, Md5};

use crate::error::{Error, Result};

const MAGIC: [u8; 4] = *b"PSAR";
/// DSAR is a meta-wrapper around a compressed PSARC. Only seen in late PS4 /
/// PS5 titles; we recognize it so we can emit a helpful error.
const MAGIC_DSAR: [u8; 4] = *b"DSAR";
const HEADER_BYTES: u32 = 32;
/// Default entry size for PSARC v1.2 / 1.3 / 1.4. The header carries its own
/// `toc_entry_size`; we fall back to this when the header value looks wrong.
const ENTRY_BYTES: u32 = 30;

const FLAG_IGNORE_CASE: u32 = 0x01;
const FLAG_ABSOLUTE: u32 = 0x02;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
    Zlib,
    Lzma,
    Oodle,
}

impl Compression {
    fn from_fourcc(b: [u8; 4]) -> Result<Self> {
        match &b {
            b"zlib" => Ok(Compression::Zlib),
            b"lzma" => Ok(Compression::Lzma),
            b"oodl" => Ok(Compression::Oodle),
            _ => Err(Error::UnsupportedCompression(b)),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Header {
    pub major: u16,
    pub minor: u16,
    pub compression: Compression,
    pub toc_size: u32,
    pub toc_entry_size: u32,
    pub toc_entries: u32,
    pub block_size: u32,
    pub flags: u32,
}

impl Header {
    pub fn ignore_case(&self) -> bool {
        self.flags & FLAG_IGNORE_CASE != 0
    }
    pub fn absolute(&self) -> bool {
        self.flags & FLAG_ABSOLUTE != 0
    }
}

/// One file entry inside the archive (after the manifest).
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub uncompressed_size: u64,
    pub file_offset: u64,
    /// Index into the `block_sizes` table for the first block of this file.
    pub block_offset: u32,
}

pub struct Archive<R: Read + Seek> {
    pub header: Header,
    pub entries: Vec<Entry>,
    /// Per-block compressed sizes. Indexed by `Entry::block_offset + i`.
    /// A value of `0` means "this block is uncompressed and full-sized
    /// (`header.block_size` bytes)".
    block_sizes: Vec<u16>,
    inner: R,
}

impl Archive<BufReader<File>> {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)?;
        Self::from_reader(BufReader::new(file))
    }
}

impl<R: Read + Seek> Archive<R> {
    pub fn from_reader(mut r: R) -> Result<Self> {
        r.seek(SeekFrom::Start(0))?;
        let header = read_header(&mut r)?;
        if header.compression != Compression::Zlib {
            return Err(Error::UnsupportedCompression(match header.compression {
                Compression::Lzma => *b"lzma",
                Compression::Oodle => *b"oodl",
                _ => *b"????",
            }));
        }

        // TOC entries (raw — 16-byte hash + offsets).
        let mut raw_entries: Vec<RawEntry> = Vec::with_capacity(header.toc_entries as usize);
        for _ in 0..header.toc_entries {
            raw_entries.push(read_raw_entry(&mut r)?);
        }

        // Block-sizes table: u16 BE, fills the remainder of the TOC.
        // Use the header's reported entry size (matches UnPSARC's behavior) —
        // this lets us read v1.2 archives even though we always parse 30-byte
        // entries on disk. If the header's value is bogus (zero), fall back
        // to our known constant so the math doesn't go sideways.
        let entry_size = if header.toc_entry_size == 0 {
            ENTRY_BYTES
        } else {
            header.toc_entry_size
        };
        // All three operands are attacker-controlled (from the PSARC header on
        // disk). Without `checked_*` a crafted file with `toc_entries =
        // 0xFFFF_FFFF` wraps the subtraction and yields a multi-GiB
        // `Vec::with_capacity`, OOM'ing the process before any data is even
        // read.
        let entries_bytes = entry_size
            .checked_mul(header.toc_entries)
            .ok_or(Error::MalformedHeader("entry_size * toc_entries overflows u32"))?;
        let block_sizes_bytes = header
            .toc_size
            .checked_sub(HEADER_BYTES)
            .and_then(|x| x.checked_sub(entries_bytes))
            .ok_or(Error::MalformedHeader("toc_size smaller than header + entries"))?;
        let block_sizes_count = (block_sizes_bytes / 2) as usize;
        let mut block_sizes = Vec::with_capacity(block_sizes_count);
        for _ in 0..block_sizes_count {
            block_sizes.push(r.read_u16::<BigEndian>()?);
        }

        // The first entry is the manifest (a list of filenames). We need the
        // block table BEFORE we can decode it, hence the order above.
        let mut tmp = Archive {
            header,
            entries: Vec::new(),
            block_sizes,
            inner: r,
        };

        // Decode entry 0 -> filenames.
        let manifest_raw = &raw_entries[0];
        let manifest_bytes = tmp.read_blocks(
            manifest_raw.uncompressed_size,
            manifest_raw.block_offset,
            manifest_raw.file_offset,
        )?;
        let manifest = parse_manifest(&manifest_bytes);

        // Build hash → name map. Hash the filename in three case variants
        // (original / upper / lower) — UnPSARC does this defensively because
        // some PS3 archives (especially v1.2 era) hash filenames in the
        // "wrong" case from what the manifest stores. Without this, ~10% of
        // entries on some R:FoM PSARCs end up unnamed.
        let mut name_for_hash: HashMap<[u8; 16], String> = HashMap::with_capacity(manifest.len() * 3);
        for raw_name in &manifest {
            let value = if header.absolute() && raw_name.starts_with('/') {
                raw_name[1..].to_string()
            } else {
                raw_name.clone()
            };
            // Insert under the canonical key the header tells us to use.
            let canonical = if header.ignore_case() {
                raw_name.to_uppercase()
            } else {
                raw_name.clone()
            };
            name_for_hash.entry(md5_of(&canonical)).or_insert(value.clone());
            // ...plus upper / lower variants as fallbacks. `entry().or_insert`
            // means the canonical hash wins if there's any collision.
            name_for_hash
                .entry(md5_of(&raw_name.to_uppercase()))
                .or_insert(value.clone());
            name_for_hash
                .entry(md5_of(&raw_name.to_lowercase()))
                .or_insert(value);
        }

        // Resolve every non-manifest entry to its filename.
        let mut entries = Vec::with_capacity(raw_entries.len().saturating_sub(1));
        for raw in raw_entries.iter().skip(1) {
            let name = match name_for_hash.get(&raw.hash) {
                Some(n) => n.clone(),
                None => continue, // missing name — skip silently
            };
            entries.push(Entry {
                name,
                uncompressed_size: raw.uncompressed_size,
                file_offset: raw.file_offset,
                block_offset: raw.block_offset,
            });
        }

        tmp.entries = entries;
        Ok(tmp)
    }

    /// Decompress one entry into a `Vec<u8>`.
    pub fn read_entry(&mut self, entry: &Entry) -> Result<Vec<u8>> {
        self.read_blocks(entry.uncompressed_size, entry.block_offset, entry.file_offset)
    }

    /// Block-wise decompression — see PsarcArchive.read in the Java source.
    /// `index` is the block_sizes index of the first block; `start_offset`
    /// is the byte offset in the file where compressed data begins.
    fn read_blocks(
        &mut self,
        uncompressed_size: u64,
        mut index: u32,
        start_offset: u64,
    ) -> Result<Vec<u8>> {
        let mut output = Vec::with_capacity(uncompressed_size as usize);
        self.inner.seek(SeekFrom::Start(start_offset))?;

        let block_size = self.header.block_size as usize;
        let mut buffer = vec![0u8; block_size];

        while output.len() < uncompressed_size as usize {
            let remaining = uncompressed_size as usize - output.len();
            let size = *self
                .block_sizes
                .get(index as usize)
                .ok_or_else(|| Error::Decompress(format!("block_offset {index} out of range")))?
                as usize;
            index += 1;

            if size == 0 {
                // Uncompressed full block.
                let take = block_size.min(remaining);
                buffer.resize(take, 0);
                self.inner.read_exact(&mut buffer[..take])?;
                output.extend_from_slice(&buffer[..take]);
            } else if size as u64 == uncompressed_size || size == remaining {
                // Uncompressed final partial block.
                buffer.resize(size, 0);
                self.inner.read_exact(&mut buffer[..size])?;
                output.extend_from_slice(&buffer[..size]);
            } else {
                // Compressed block — `size` bytes on disk, `min(block_size, remaining)` out.
                let want = block_size.min(remaining);
                buffer.resize(size, 0);
                self.inner.read_exact(&mut buffer[..size])?;
                let mut decoded = vec![0u8; want];
                let mut decoder = ZlibDecoder::new(&buffer[..size]);
                decoder
                    .read_exact(&mut decoded)
                    .map_err(|e| Error::Decompress(e.to_string()))?;
                output.extend_from_slice(&decoded);
            }
        }
        Ok(output)
    }
}

struct RawEntry {
    hash: [u8; 16],
    block_offset: u32,
    uncompressed_size: u64,
    file_offset: u64,
}

fn read_header<R: Read>(r: &mut R) -> Result<Header> {
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)?;
    if magic == MAGIC_DSAR {
        return Err(Error::Decompress(
            "DSAR-wrapped archive (PS4/PS5+) — not supported. Extract the inner PSARC first.".into(),
        ));
    }
    if magic != MAGIC {
        return Err(Error::BadMagic(magic));
    }
    let major = r.read_u16::<BigEndian>()?;
    let minor = r.read_u16::<BigEndian>()?;
    // Permissive: accept any v1.x. PS3 titles ship a mix of 1.2 / 1.3 / 1.4
    // and the layout is identical across them. Anything else, bail.
    if major != 1 {
        return Err(Error::UnsupportedVersion { major, minor });
    }
    let mut comp = [0u8; 4];
    r.read_exact(&mut comp)?;
    let compression = Compression::from_fourcc(comp)?;
    let toc_size = r.read_u32::<BigEndian>()?;
    let toc_entry_size = r.read_u32::<BigEndian>()?;
    let toc_entries = r.read_u32::<BigEndian>()?;
    let block_size = r.read_u32::<BigEndian>()?;
    let flags = r.read_u32::<BigEndian>()?;
    Ok(Header {
        major,
        minor,
        compression,
        toc_size,
        toc_entry_size,
        toc_entries,
        block_size,
        flags,
    })
}

fn read_raw_entry<R: Read>(r: &mut R) -> Result<RawEntry> {
    let mut hash = [0u8; 16];
    r.read_exact(&mut hash)?;
    let block_offset = r.read_u32::<BigEndian>()?;
    // 40-bit big-endian = high 32 bits + low 8 bits.
    let uncompressed_high = r.read_u32::<BigEndian>()? as u64;
    let uncompressed_low = r.read_u8()? as u64;
    let uncompressed_size = (uncompressed_high << 8) | uncompressed_low;
    let file_high = r.read_u32::<BigEndian>()? as u64;
    let file_low = r.read_u8()? as u64;
    let file_offset = (file_high << 8) | file_low;
    Ok(RawEntry {
        hash,
        block_offset,
        uncompressed_size,
        file_offset,
    })
}

fn parse_manifest(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split(|c: char| c == '\n' || c == '\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn md5_of(s: &str) -> [u8; 16] {
    let mut hasher = Md5::new();
    hasher.update(s.as_bytes());
    let out = hasher.finalize();
    let mut arr = [0u8; 16];
    arr.copy_from_slice(&out);
    arr
}
