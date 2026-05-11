use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;

const SECT_ENVSAMPLER: u32 = 0x9700;
const ENVSAMPLER_SIZE: u64 = 224;
const YARD_TO_M: f32 = 0.9144;

#[derive(Debug, Clone)]
pub struct EnvSampler {
    pub tuid: u64,
    pub position: [f32; 3],
    pub half_extents: [f32; 3],
    pub cubemap_tuid: u64,
}

pub fn read_envsamplers_rfom(level_folder: &Path) -> Result<Vec<EnvSampler>> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let section = match ig.section(SECT_ENVSAMPLER) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    if section.length != ENVSAMPLER_SIZE as u32 {
        eprintln!(
            "warn: RFOM envsampler section size mismatch ({} != {}) — skipping",
            section.length, ENVSAMPLER_SIZE
        );
        return Ok(Vec::new());
    }

    let count = section.count as usize;
    let base = u64::from(section.offset);
    let log_probes = std::env::var("RECHIMERA_LOG_PROBES").is_ok();
    if log_probes {
        eprintln!(
            "[rfom-envs] {} env-samplers @ section 0x9700 (record={} bytes)",
            count, ENVSAMPLER_SIZE
        );
    }

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let rec = base + (i as u64) * ENVSAMPLER_SIZE;

        if i == 0 && log_probes {
            ig.stream.seek_to(rec)?;
            let mut hex = String::new();
            for row in 0..(ENVSAMPLER_SIZE as usize / 16) {
                let mut line = String::new();
                for _ in 0..16 {
                    let b = ig.stream.read_u8().unwrap_or(0);
                    line.push_str(&format!("{:02X} ", b));
                }
                hex.push_str(&format!("[rfom-envs]   +0x{:02X}: {}\n", row * 16, line));
            }
            eprintln!("[rfom-envs] record[0] dump:\n{}", hex.trim_end());
        }

        ig.stream.seek_to(rec)?;
        let m00 = ig.stream.read_f32()?;
        let _m01 = ig.stream.read_f32()?;
        let m02 = ig.stream.read_f32()?;
        let _w0 = ig.stream.read_f32()?;
        let _m10 = ig.stream.read_f32()?;
        let m11 = ig.stream.read_f32()?;
        let _m12 = ig.stream.read_f32()?;
        let _w1 = ig.stream.read_f32()?;
        let m20 = ig.stream.read_f32()?;
        let _m21 = ig.stream.read_f32()?;
        let m22 = ig.stream.read_f32()?;
        let _w2 = ig.stream.read_f32()?;

        let px = ig.stream.read_f32()?;
        let py = ig.stream.read_f32()?;
        let pz = ig.stream.read_f32()?;
        let _pw = ig.stream.read_f32()?;

        let col_x_len = (m00 * m00 + m02 * m02).sqrt();
        let col_y_len = m11.abs();
        let col_z_len = (m20 * m20 + m22 * m22).sqrt();

        ig.stream.seek_to(rec + 0xC4)?;
        let cube_off = ig.stream.read_u32()?;
        let cubemap_tuid = u64::from(cube_off);

        let position = [px * YARD_TO_M, py * YARD_TO_M, pz * YARD_TO_M];
        let half_extents = [
            col_x_len * YARD_TO_M,
            col_y_len * YARD_TO_M,
            col_z_len * YARD_TO_M,
        ];

        if log_probes {
            eprintln!(
                "[rfom-envs] [{}] m=({:.2}, {:.2}, {:.2}) half=({:.2}, {:.2}, {:.2}) cube_off=0x{:08X}",
                i, position[0], position[1], position[2],
                half_extents[0], half_extents[1], half_extents[2],
                cubemap_tuid
            );
        }

        out.push(EnvSampler {
            tuid: rec,
            position,
            half_extents,
            cubemap_tuid,
        });
    }

    Ok(out)
}
