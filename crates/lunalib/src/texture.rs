//! Texture decoder.
//!
//! Ported from new-engine path of [LibLunacy/Texture.cs](../../../../LibLunacy/Texture.cs).
//! Cross-checked against [InsomniaToolset/common/include/insomnia/classes/](../../../../InsomniaToolset/common/include/insomnia/classes/) for format codes.
//!
//! Layout (new engine):
//! - `assetlookup.dat` section `0x1D140` — 4-byte `NewTexMeta` per texture
//!   (format, mip count, log2(width), log2(height)).
//! - `assetlookup.dat` section `0x1D1C0` — 16-byte `AssetPointer` per highmip
//!   (`tuid`, `offset`, `length`) referencing `highmips.dat`.
//! - `highmips.dat` — raw blob storage.
//!
//! Format codes (`NewTexMeta.format`):
//! | code | meaning |
//! | --- | --- |
//! | 0x03 | R5G6B5 (Morton-swizzled 16bpp) |
//! | 0x05 | A8R8G8B8 (Morton-swizzled 32bpp) |
//! | 0x06 | DXT1 |
//! | 0x07 | DXT3 |
//! | 0x08 | DXT5 |

use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use crate::error::{Error, Result};
use crate::igfile::IgFile;

const SECT_TEX_META: u32 = 0x1D140;
const SECT_HIGHMIP_PTRS: u32 = 0x1D1C0;

const NEW_TEX_META_SIZE: u64 = 0x04;
const ASSET_POINTER_SIZE: u64 = 0x10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TexFormat {
    R5G6B5,
    A8R8G8B8,
    Dxt1,
    Dxt3,
    Dxt5,
    /// Format we recognize the byte for but haven't implemented yet.
    Unknown(u8),
}

impl TexFormat {
    fn from_byte(b: u8) -> Self {
        match b {
            0x03 => TexFormat::R5G6B5,
            0x05 => TexFormat::A8R8G8B8,
            0x06 => TexFormat::Dxt1,
            0x07 => TexFormat::Dxt3,
            0x08 => TexFormat::Dxt5,
            other => TexFormat::Unknown(other),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            TexFormat::R5G6B5 => "R5G6B5",
            TexFormat::A8R8G8B8 => "A8R8G8B8",
            TexFormat::Dxt1 => "DXT1",
            TexFormat::Dxt3 => "DXT3",
            TexFormat::Dxt5 => "DXT5",
            TexFormat::Unknown(_) => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Texture {
    /// Lower 32 bits of the highmip TUID — matches the keys used by the
    /// shader's `NewReferences.albedoTuid` field.
    pub id: u32,
    pub tuid: u64,
    pub width: u32,
    pub height: u32,
    pub format: TexFormat,
    pub mipmap_count: u8,
    /// Decoded RGBA8 (row-major, top-to-bottom). Empty if the format wasn't
    /// implemented or decoding failed (in which case `width=0, height=0`).
    pub rgba: Vec<u8>,
}

impl Texture {
    pub fn is_decoded(&self) -> bool {
        self.width > 0 && self.height > 0 && !self.rgba.is_empty()
    }
}

/// Decode every texture in the level. Heavy — call once per level open and
/// cache the result; PNG-encode in the caller if shipping over IPC.
pub fn read_textures(level_folder: &Path) -> Result<Vec<Texture>> {
    let assetlookup_path = level_folder.join("assetlookup.dat");
    let mut lookup = IgFile::open(BufReader::new(File::open(&assetlookup_path)?))?;

    let meta_section = lookup.require_section(SECT_TEX_META)?;
    let ptr_section = lookup.require_section(SECT_HIGHMIP_PTRS)?;

    let count = (ptr_section.length / ASSET_POINTER_SIZE as u32) as usize;
    if (meta_section.length / NEW_TEX_META_SIZE as u32) as usize != count {
        return Err(Error::SectionLengthMismatch {
            id: SECT_TEX_META,
            length: meta_section.length,
            entry: NEW_TEX_META_SIZE as u32,
        });
    }

    // Pull metadata + pointers in two passes (separate sections).
    let mut metas: Vec<(TexFormat, u8, u32, u32)> = Vec::with_capacity(count);
    for i in 0..count {
        lookup
            .stream
            .seek_to(u64::from(meta_section.offset) + (i as u64) * NEW_TEX_META_SIZE)?;
        let format_byte = lookup.stream.read_u8()?;
        let mip_count = lookup.stream.read_u8()?;
        let w_pow = lookup.stream.read_u8()?;
        let h_pow = lookup.stream.read_u8()?;
        let format = TexFormat::from_byte(format_byte);
        let width = 1u32 << w_pow;
        let height = 1u32 << h_pow;
        metas.push((format, mip_count, width, height));
    }

    let mut pointers: Vec<(u64, u32, u32)> = Vec::with_capacity(count);
    for i in 0..count {
        lookup
            .stream
            .seek_to(u64::from(ptr_section.offset) + (i as u64) * ASSET_POINTER_SIZE)?;
        let tuid = lookup.stream.read_u64()?;
        let offset = lookup.stream.read_u32()?;
        let length = lookup.stream.read_u32()?;
        pointers.push((tuid, offset, length));
    }

    // Stream textures from highmips.dat.
    let highmips_path = level_folder.join("highmips.dat");
    let mut highmips = File::open(&highmips_path)?;

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let (format, mip_count, width, height) = metas[i];
        let (tuid, offset, length) = pointers[i];
        let id = tuid as u32;

        if length == 0 {
            out.push(Texture {
                id,
                tuid,
                width: 0,
                height: 0,
                format,
                mipmap_count: mip_count,
                rgba: Vec::new(),
            });
            continue;
        }

        highmips.seek(SeekFrom::Start(u64::from(offset)))?;
        let mut raw = vec![0u8; length as usize];
        highmips.read_exact(&mut raw)?;

        let rgba = match format {
            TexFormat::Dxt1 => decode_dxt(&raw, width, height, texpresso::Format::Bc1),
            TexFormat::Dxt3 => decode_dxt(&raw, width, height, texpresso::Format::Bc2),
            TexFormat::Dxt5 => decode_dxt(&raw, width, height, texpresso::Format::Bc3),
            TexFormat::R5G6B5 => decode_r5g6b5_morton(&raw, width, height),
            TexFormat::A8R8G8B8 => decode_a8r8g8b8_morton(&raw, width, height),
            TexFormat::Unknown(_) => Vec::new(),
        };

        let (w, h) = if rgba.is_empty() { (0, 0) } else { (width, height) };

        out.push(Texture {
            id,
            tuid,
            width: w,
            height: h,
            format,
            mipmap_count: mip_count,
            rgba,
        });
    }

    Ok(out)
}

/// `texpresso::decompress_image` expects the on-disk DXT bytes — PS3 stores
/// these in standard format (NVIDIA RSX uses the same DXT layout as PC).
fn decode_dxt(raw: &[u8], width: u32, height: u32, format: texpresso::Format) -> Vec<u8> {
    let expected = format.compressed_size(width as usize, height as usize);
    if raw.len() < expected {
        return Vec::new();
    }
    let mut rgba = vec![0u8; (width as usize) * (height as usize) * 4];
    format.decompress(&raw[..expected], width as usize, height as usize, &mut rgba);
    rgba
}

/// Morton (Z-order) inverse used by the PS3 RSX for non-DXT textures.
/// Stolen — like the C# port — from RawTex.
fn morton_index(t: u32, x: u32, y: u32) -> u32 {
    let mut num = 1u32;
    let mut num2 = 1u32;
    let mut num3 = t;
    let mut num4 = x;
    let mut num5 = y;
    let mut num6 = 0u32;
    let mut num7 = 0u32;
    while num4 > 1 || num5 > 1 {
        if num4 > 1 {
            num6 += num2 * (num3 & 1);
            num3 >>= 1;
            num2 *= 2;
            num4 >>= 1;
        }
        if num5 > 1 {
            num7 += num * (num3 & 1);
            num3 >>= 1;
            num *= 2;
            num5 >>= 1;
        }
    }
    num7 * x + num6
}

fn decode_a8r8g8b8_morton(raw: &[u8], width: u32, height: u32) -> Vec<u8> {
    let pixels = (width as usize) * (height as usize);
    if raw.len() < pixels * 4 {
        return Vec::new();
    }
    let mut rgba = vec![0u8; pixels * 4];
    for t in 0..(pixels as u32) {
        let src = (t as usize) * 4;
        let dst = (morton_index(t, width, height) as usize) * 4;
        // Source: ABGR (PS3 big-endian read). Want RGBA.
        let a = raw[src + 0];
        let b = raw[src + 1];
        let g = raw[src + 2];
        let r = raw[src + 3];
        rgba[dst + 0] = r;
        rgba[dst + 1] = g;
        rgba[dst + 2] = b;
        rgba[dst + 3] = a;
    }
    rgba
}

fn decode_r5g6b5_morton(raw: &[u8], width: u32, height: u32) -> Vec<u8> {
    let pixels = (width as usize) * (height as usize);
    if raw.len() < pixels * 2 {
        return Vec::new();
    }
    let mut rgba = vec![0u8; pixels * 4];
    for t in 0..(pixels as u32) {
        let src = (t as usize) * 2;
        let dst = (morton_index(t, width, height) as usize) * 4;
        // PS3 big-endian u16: high byte first.
        let v = u16::from_be_bytes([raw[src], raw[src + 1]]);
        let r5 = ((v >> 11) & 0x1F) as u8;
        let g6 = ((v >> 5) & 0x3F) as u8;
        let b5 = (v & 0x1F) as u8;
        rgba[dst + 0] = (r5 << 3) | (r5 >> 2);
        rgba[dst + 1] = (g6 << 2) | (g6 >> 4);
        rgba[dst + 2] = (b5 << 3) | (b5 >> 2);
        rgba[dst + 3] = 0xFF;
    }
    rgba
}

/// Convenience: encode an RGBA buffer to PNG bytes. Returns empty on failure.
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    if rgba.is_empty() || width == 0 || height == 0 {
        return Vec::new();
    }
    let mut out = Cursor::new(Vec::new());
    let img = match image::RgbaImage::from_raw(width, height, rgba.to_vec()) {
        Some(i) => i,
        None => return Vec::new(),
    };
    if img
        .write_to(&mut out, image::ImageFormat::Png)
        .is_err()
    {
        return Vec::new();
    }
    out.into_inner()
}
