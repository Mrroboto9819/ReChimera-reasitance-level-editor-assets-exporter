//! RFOM-era texture reader.
//!
//! Ported from InsomniaToolset's `levelmain/extract.cpp::ExtractTexture`
//! (line 119) plus the `TextureV1` / `Texture` struct definition in
//! `common/include/insomnia/classes/shader.hpp:126`. Each 0x5300 entry
//! is **32 bytes** (matches the RFOM probe).
//!
//! ## TextureV1 layout (`0x20` bytes)
//! - `+0x00` `uint32 offset`        — byte offset into `ps3leveltexs.dat`
//!   where the pixel payload lives
//! - `+0x04` `uint16 numMips`
//! - `+0x06` `TextureFormat format` (1 byte) — NV4097 high range
//!   (0x81..0x8B + 0xA6); see `TexFormat::from_byte`
//! - `+0x07` `TextureFlags`         — 1 byte (cubemap/dimension/border)
//! - `+0x08` `uint32 address`       — wrap modes
//! - `+0x0C` `uint32 control0`      — minLod/maxLod/anisotropy/enable
//! - `+0x10` `uint32 control3`      — pitch/depth
//! - `+0x14` `uint32 filter`
//! - `+0x18` `uint16 width`
//! - `+0x1A` `uint16 height`
//! - `+0x1C` `uint32 borderColor`
//!
//! ## ID convention
//! Each emitted [`Texture`]'s `id` is the byte offset of its 0x5300
//! entry inside `ps3levelmain.dat`. That same offset is what
//! `shader_rfom.rs::read_shaders_rfom` stores as the texture
//! reference, so the V2/TOD pipeline lookup pattern works unchanged.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;
use crate::texture::{decode_format, encode_png, TexFormat, Texture};

const SECT_TEXTURE_V1: u32 = 0x5300;
const TEXTURE_V1_SIZE: u64 = 0x20;

#[derive(Debug, Clone, Copy)]
struct RfomTexHeader {
    main_offset: u32,
    pixel_offset: u32,
    format: TexFormat,
    width: u32,
    height: u32,
    mip_count: u8,
}

pub fn read_textures_rfom(level_folder: &Path) -> Result<Vec<Texture>> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut main_ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let section = match main_ig.section(SECT_TEXTURE_V1) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    if section.length != TEXTURE_V1_SIZE as u32 {
        eprintln!(
            "warn: 0x5300 section length is {} (expected {} for TextureV1) — skipping",
            section.length, TEXTURE_V1_SIZE
        );
        return Ok(Vec::new());
    }

    let count = section.count as u64;
    let mut headers: Vec<RfomTexHeader> = Vec::with_capacity(count as usize);
    for i in 0..count {
        let base = u64::from(section.offset) + i * TEXTURE_V1_SIZE;
        main_ig.stream.seek_to(base + 0x00)?;
        let pixel_offset = main_ig.stream.read_u32()?;
        let mip_count = main_ig.stream.read_u16()? as u8;
        let format_byte = main_ig.stream.read_u8()?;
        let _flags = main_ig.stream.read_u8()?;
        main_ig.stream.seek_to(base + 0x18)?;
        let width = main_ig.stream.read_u16()? as u32;
        let height = main_ig.stream.read_u16()? as u32;
        headers.push(RfomTexHeader {
            main_offset: base as u32,
            pixel_offset,
            format: TexFormat::from_format_byte(format_byte),
            width,
            height,
            mip_count,
        });
    }

    let texs_path = level_folder.join("ps3leveltexs.dat");
    if !texs_path.exists() {
        eprintln!(
            "warn: {} missing — RFOM texture pixel data lives in ps3leveltexs.dat",
            texs_path.display()
        );
        return Ok(Vec::new());
    }
    let mut texs_file = File::open(&texs_path)?;
    let texs_size = std::fs::metadata(&texs_path).map(|m| m.len()).unwrap_or(0);

    let mut out: Vec<Texture> = Vec::with_capacity(headers.len());
    for h in headers {
        let payload = base_mip_size(h.width, h.height, h.format);
        if payload == 0 {
            continue;
        }
        let end = u64::from(h.pixel_offset) + payload;
        if end > texs_size {
            eprintln!(
                "[rfom-tex] header @0x{:X} skipped — pixel range [0x{:X}..0x{:X}] past EOF (size 0x{:X})",
                h.main_offset, h.pixel_offset, end, texs_size
            );
            continue;
        }
        texs_file.seek(SeekFrom::Start(u64::from(h.pixel_offset)))?;
        let mut raw = vec![0u8; payload as usize];
        texs_file.read_exact(&mut raw)?;
        let rgba = decode_format(&raw, h.width, h.height, h.format);
        if rgba.is_empty() {
            continue;
        }
        out.push(Texture {
            id: h.main_offset,
            tuid: u64::from(h.main_offset),
            width: h.width,
            height: h.height,
            format: h.format,
            mipmap_count: h.mip_count,
            rgba,
        });
    }
    Ok(out)
}

pub fn texture_rfom_to_png(t: &Texture) -> Option<Vec<u8>> {
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

fn base_mip_size(width: u32, height: u32, format: TexFormat) -> u64 {
    use TexFormat::*;
    let pixels = u64::from(width) * u64::from(height);
    match format {
        Dxt1 | Bc1Linear => {
            let bw = (u64::from(width) + 3) / 4;
            let bh = (u64::from(height) + 3) / 4;
            bw.max(1) * bh.max(1) * 8
        }
        Dxt3 | Dxt5 => {
            let bw = (u64::from(width) + 3) / 4;
            let bh = (u64::from(height) + 3) / 4;
            bw.max(1) * bh.max(1) * 16
        }
        A8R8G8B8 => pixels * 4,
        R5G6B5 | Rg8 | Rgb5A1 | Rgba4 => pixels * 2,
        R8 => pixels,
        Unknown(_) => 0,
    }
}
