use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;

const SECT_LIGHT: u32 = 0xC200;
const LIGHT_SIZE: u64 = 288;
const YARD_TO_M: f32 = 0.9144;

#[derive(Debug, Clone)]
pub struct LightInstance {
    pub tuid: u64,
    pub position: [f32; 3],
    pub color: [f32; 3],
    pub range: f32,
    pub intensity: f32,
}

pub fn read_lights_rfom(level_folder: &Path) -> Result<Vec<LightInstance>> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    let section = match ig.section(SECT_LIGHT) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    if section.length != LIGHT_SIZE as u32 {
        eprintln!(
            "warn: RFOM light section size mismatch ({} != {}) — skipping",
            section.length, LIGHT_SIZE
        );
        return Ok(Vec::new());
    }

    let count = section.count as usize;
    let base = u64::from(section.offset);
    eprintln!(
        "[rfom-light] {} lights @ section 0xC200 (record={} bytes)",
        count, LIGHT_SIZE
    );

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let rec = base + (i as u64) * LIGHT_SIZE;

        if i == 0 {
            ig.stream.seek_to(rec)?;
            let mut hex = String::new();
            for row in 0..(LIGHT_SIZE as usize / 16) {
                let mut line = String::new();
                for _ in 0..16 {
                    let b = ig.stream.read_u8().unwrap_or(0);
                    line.push_str(&format!("{:02X} ", b));
                }
                hex.push_str(&format!("[rfom-light]   +0x{:02X}: {}\n", row * 16, line));
            }
            eprintln!("[rfom-light] record[0] dump:\n{}", hex.trim_end());
        }

        ig.stream.seek_to(rec)?;
        let px = ig.stream.read_f32()?;
        let py = ig.stream.read_f32()?;
        let pz = ig.stream.read_f32()?;
        let _pw = ig.stream.read_f32()?;

        let cr = ig.stream.read_f32()?;
        let cg = ig.stream.read_f32()?;
        let cb = ig.stream.read_f32()?;
        let intensity = ig.stream.read_f32()?;

        ig.stream.seek_to(rec + 0x30)?;
        let range = ig.stream.read_f32()?.max(0.0);

        let position = [px * YARD_TO_M, py * YARD_TO_M, pz * YARD_TO_M];
        let color = [cr.max(0.0), cg.max(0.0), cb.max(0.0)];

        eprintln!(
            "[rfom-light] [{}] m=({:.2}, {:.2}, {:.2}) rgb=({:.2}, {:.2}, {:.2}) range={:.2} intensity={:.2}",
            i, position[0], position[1], position[2], color[0], color[1], color[2], range, intensity
        );

        out.push(LightInstance {
            tuid: rec,
            position,
            color,
            range: range * YARD_TO_M,
            intensity,
        });
    }

    Ok(out)
}
