use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;

const PROBE_BYTES: usize = 384;

const SKYBOX_CANDIDATES: &[(u32, &str)] = &[
    (0x9950, "LevelHeader"),
    (0xC700, "EnvDescriptor?"),
    (0xC650, "CuboidVolume?"),
    (0x8800, "TexturePalette0?"),
    (0x8A00, "TexturePalette1?"),
    (0x9150, "Sky/CamMeta12k?"),
    (0xDA00, "Cinematic336?"),
    (0x10500, "EnvSamplerExtra?"),
];

const COLLISION_CANDIDATES: &[(u32, &str)] = &[
    (0xD600, "Collision32K?"),
    (0xD900, "Collision80K?"),
    (0x10200, "CollisionBuffer157K?"),
    (0x10400, "CollisionIndex2.8K?"),
    (0x10500, "CollisionAux2K?"),
    (0x10600, "CollisionAux3.5K?"),
    (0x10700, "CollisionAux2.5K?"),
    (0x10900, "CollisionAux5K?"),
];

pub fn probe_rfom_unknowns(level_folder: &Path) -> Result<()> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    eprintln!("[rfom-probe] === SKYBOX candidates ===");
    for (id, label) in SKYBOX_CANDIDATES {
        dump_section(&mut ig, *id, label);
    }

    eprintln!("[rfom-probe] === COLLISION candidates ===");
    for (id, label) in COLLISION_CANDIDATES {
        dump_section(&mut ig, *id, label);
    }

    Ok(())
}

fn dump_section<R: std::io::Read + std::io::Seek>(
    ig: &mut IgFile<R>,
    id: u32,
    label: &str,
) {
    let section = match ig.section(id) {
        Some(s) => s,
        None => {
            eprintln!("[rfom-probe] 0x{:04X} ({}) — absent", id, label);
            return;
        }
    };
    let take = (section.length as usize)
        .min(PROBE_BYTES)
        .min(((section.length as u64) * (section.count as u64)) as usize);
    eprintln!(
        "[rfom-probe] 0x{:04X} ({}) count={} length={} — first {} bytes:",
        id, label, section.count, section.length, take
    );
    if ig.stream.seek_to(u64::from(section.offset)).is_err() {
        eprintln!("[rfom-probe]   <seek failed>");
        return;
    }
    let mut bytes = vec![0u8; take];
    for b in bytes.iter_mut() {
        *b = ig.stream.read_u8().unwrap_or(0);
    }
    for row in 0..((take + 15) / 16) {
        let mut hex = String::new();
        let mut ascii = String::new();
        let row_count = (take - row * 16).min(16);
        for col in 0..row_count {
            let b = bytes[row * 16 + col];
            hex.push_str(&format!("{:02X} ", b));
            ascii.push(if (0x20..0x7F).contains(&b) {
                b as char
            } else {
                '.'
            });
        }
        eprintln!(
            "[rfom-probe]   +0x{:03X}: {:<48}  {}",
            row * 16,
            hex.trim_end(),
            ascii
        );
    }
    // BE f32 interpretation of first 32 quads — easier to spot positions/colors
    let nf = (bytes.len() / 4).min(32);
    let mut floats = String::new();
    for i in 0..nf {
        let off = i * 4;
        let b = u32::from_be_bytes([
            bytes[off],
            bytes[off + 1],
            bytes[off + 2],
            bytes[off + 3],
        ]);
        let f = f32::from_bits(b);
        let label = if f.is_finite() && f.abs() > 0.0 && f.abs() < 1.0e9 {
            format!("{:.3}", f)
        } else {
            "·".into()
        };
        if i % 4 == 0 {
            floats.push_str(&format!("\n[rfom-probe]    f32 +0x{:03X}: ", i * 4));
        }
        floats.push_str(&format!("{:>10}  ", label));
    }
    eprintln!("{}", floats.trim_start());
}
