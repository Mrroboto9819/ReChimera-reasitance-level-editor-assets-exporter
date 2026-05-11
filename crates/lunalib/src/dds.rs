use crate::error::{Error, Result};

const DDS_MAGIC: &[u8; 4] = b"DDS ";
const DDSD_CAPS: u32 = 0x1;
const DDSD_HEIGHT: u32 = 0x2;
const DDSD_WIDTH: u32 = 0x4;
const DDSD_PIXELFORMAT: u32 = 0x1000;
const DDSD_PITCH: u32 = 0x8;
const DDPF_ALPHAPIXELS: u32 = 0x1;
const DDPF_RGB: u32 = 0x40;
const DDSCAPS_TEXTURE: u32 = 0x1000;

pub fn png_to_uncompressed_dds(png_bytes: &[u8]) -> Result<Vec<u8>> {
    let img = image::load_from_memory_with_format(png_bytes, image::ImageFormat::Png)
        .map_err(|e| Error::GltfWrite(format!("decode png: {e}")))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(write_a8r8g8b8_dds(&rgba, width, height))
}

pub fn write_a8r8g8b8_dds(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let pitch = width * 4;
    let mut out = Vec::with_capacity(128 + (rgba.len()));
    out.extend_from_slice(DDS_MAGIC);
    let header_size: u32 = 124;
    let flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_PITCH;
    out.extend_from_slice(&header_size.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&pitch.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 44]);

    let pf_size: u32 = 32;
    let pf_flags = DDPF_RGB | DDPF_ALPHAPIXELS;
    out.extend_from_slice(&pf_size.to_le_bytes());
    out.extend_from_slice(&pf_flags.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&32u32.to_le_bytes());
    out.extend_from_slice(&0x00FF_0000u32.to_le_bytes());
    out.extend_from_slice(&0x0000_FF00u32.to_le_bytes());
    out.extend_from_slice(&0x0000_00FFu32.to_le_bytes());
    out.extend_from_slice(&0xFF00_0000u32.to_le_bytes());

    out.extend_from_slice(&DDSCAPS_TEXTURE.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    out.reserve(rgba.len());
    for chunk in rgba.chunks_exact(4) {
        out.push(chunk[2]);
        out.push(chunk[1]);
        out.push(chunk[0]);
        out.push(chunk[3]);
    }
    out
}
