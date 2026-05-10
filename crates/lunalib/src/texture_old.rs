//! TOD-era texture reader (R&C: Tools of Destruction).
//!
//! Ported from ReLunacy `LibLunacy/Texture.cs::CTexture` `isOld` branch +
//! `LibLunacy/AssetLoader.cs::LoadTexturesOld`.
//!
//! ## Layout
//! - `main.dat` section `0x5200` — array of `count` × `0x20`-byte
//!   `OldTextureReference` headers. Each header points (via byte
//!   offset) into `textures.dat` for raw pixel data.
//! - `main.dat` section `0x9800` (optional) — array of
//!   `OldTexstreamReference` (`0x10` bytes each). When present, the
//!   matching texture's pixel data lives in `texstream.dat` at a
//!   higher resolution (width/height ×2, +1 mip).
//! - The texture's "id" (used by shaders) is its **byte offset in
//!   `main.dat`** = `section.offset + index * 0x20`. Shader records
//!   refer to textures via these offsets, not via tuids.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;
use crate::texture::{decode_format, encode_png, TexFormat, Texture};

const SECT_OLD_TEXTURE_REFS: u32 = 0x5200;
const SECT_OLD_TEXSTREAM_REFS: u32 = 0x9800;
const OLD_TEXTURE_REF_SIZE: u64 = 0x20;
const OLD_TEXSTREAM_REF_SIZE: u64 = 0x10;

#[derive(Debug, Clone, Copy)]
struct OldTexRef {
    main_offset: u32,        // offset within main.dat — used as texture ID
    pixel_offset: u32,       // offset within textures.dat OR texstream.dat
    format: TexFormat,
    width: u32,
    height: u32,
    mipmap_count: u8,
}

#[derive(Debug, Clone, Copy)]
struct OldTexstreamRef {
    pixel_offset: u32,
    index: u16,
}

/// Read every TOD texture and decode its base mip into RGBA.
///
/// Returns one `Texture` per `OldTextureReference` in `main.dat`. The
/// `id` field on each texture is the **byte offset of the reference
/// inside main.dat** (which is what TOD shaders use to link to
/// textures — see `shader_old.rs`).
pub fn read_textures_old(level_folder: &Path) -> Result<Vec<Texture>> {
    let main_path = level_folder.join("main.dat");
    let mut main_ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let texrefs = match main_ig.section(SECT_OLD_TEXTURE_REFS) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let count = texrefs.count as u64;
    let mut headers: Vec<OldTexRef> = Vec::with_capacity(count as usize);
    for i in 0..count {
        let base = u64::from(texrefs.offset) + i * OLD_TEXTURE_REF_SIZE;
        main_ig.stream.seek_to(base + 0x00)?;
        let pixel_offset = main_ig.stream.read_u32()?;
        let _mipmap_count = main_ig.stream.read_u16()?;
        let format_field = main_ig.stream.read_u16()?;
        // ReLunacy: format = (formatBitField >> 8) & 0xF — the byte
        // landing here is in our low-range space (0x03..0x08).
        let format_byte = ((format_field >> 8) & 0xF) as u8;
        main_ig.stream.seek_to(base + 0x18)?;
        let width = main_ig.stream.read_u16()? as u32;
        let height = main_ig.stream.read_u16()? as u32;
        headers.push(OldTexRef {
            main_offset: base as u32,
            pixel_offset,
            format: TexFormat::from_format_byte(format_byte),
            width,
            height,
            mipmap_count: 0,
        });
    }

    // Optional texstream references — they upgrade the matching
    // texture by a factor of 2 in each dimension.
    let texstream_refs: Vec<OldTexstreamRef> = match main_ig.section(SECT_OLD_TEXSTREAM_REFS) {
        Some(s) => {
            let mut out = Vec::with_capacity(s.count as usize);
            for i in 0..(s.count as u64) {
                let base = u64::from(s.offset) + i * OLD_TEXSTREAM_REF_SIZE;
                main_ig.stream.seek_to(base + 0x00)?;
                let pixel_offset = main_ig.stream.read_u32()?;
                main_ig.stream.seek_to(base + 0x06)?;
                let index = main_ig.stream.read_u16()?;
                out.push(OldTexstreamRef {
                    pixel_offset,
                    index,
                });
            }
            out
        }
        None => Vec::new(),
    };

    // Open the raw pixel-data files. textures.dat is required;
    // texstream.dat is optional (presence = high-mips available).
    let textures_dat = level_folder.join("textures.dat");
    let mut textures_file = File::open(&textures_dat)?;
    let texstream_dat = level_folder.join("texstream.dat");
    let mut texstream_file = File::open(&texstream_dat).ok();

    let mut out: Vec<Texture> = Vec::with_capacity(headers.len());
    for (i, mut h) in headers.into_iter().enumerate() {
        let texstream = texstream_refs.iter().find(|r| r.index as usize == i);
        let (rgba, w, h_size) = if let (Some(tsr), Some(tsf)) =
            (texstream, texstream_file.as_mut())
        {
            // Higher-resolution mip in texstream.dat.
            h.width *= 2;
            h.height *= 2;
            h.mipmap_count += 1;
            decode_one(tsf, tsr.pixel_offset, h.width, h.height, h.format)?
        } else {
            decode_one(&mut textures_file, h.pixel_offset, h.width, h.height, h.format)?
        };
        out.push(Texture {
            id: h.main_offset,
            tuid: u64::from(h.main_offset),
            width: w,
            height: h_size,
            format: h.format,
            mipmap_count: h.mipmap_count,
            rgba,
        });
    }
    Ok(out)
}

fn decode_one<R: Read + Seek>(
    file: &mut R,
    pixel_offset: u32,
    width: u32,
    height: u32,
    format: TexFormat,
) -> Result<(Vec<u8>, u32, u32)> {
    let payload_size = highmip_size(width, height, format);
    if payload_size == 0 {
        return Ok((Vec::new(), 0, 0));
    }
    file.seek(SeekFrom::Start(u64::from(pixel_offset)))?;
    let mut raw = vec![0u8; payload_size as usize];
    file.read_exact(&mut raw)?;
    let rgba = decode_format(&raw, width, height, format);
    if rgba.is_empty() {
        Ok((Vec::new(), 0, 0))
    } else {
        Ok((rgba, width, height))
    }
}

fn highmip_size(width: u32, height: u32, format: TexFormat) -> u64 {
    use TexFormat::*;
    let pixels = (width as u64) * (height as u64);
    match format {
        Dxt1 | Bc1Linear => {
            let bw = (width as u64 + 3) / 4;
            let bh = (height as u64 + 3) / 4;
            bw.max(1) * bh.max(1) * 8
        }
        Dxt3 | Dxt5 => {
            let bw = (width as u64 + 3) / 4;
            let bh = (height as u64 + 3) / 4;
            bw.max(1) * bh.max(1) * 16
        }
        A8R8G8B8 => pixels * 4,
        R5G6B5 | Rg8 | Rgb5A1 | Rgba4 => pixels * 2,
        R8 => pixels,
        Unknown(_) => 0,
    }
}

/// Encode a TOD-decoded `Texture` into PNG bytes for the cache.
pub fn texture_to_png(t: &Texture) -> Option<Vec<u8>> {
    if t.rgba.is_empty() {
        return None;
    }
    let png = encode_png(&t.rgba, t.width, t.height);
    if png.is_empty() {
        None
    } else {
        Some(png)
    }
}
