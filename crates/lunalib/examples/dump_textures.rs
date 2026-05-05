//! Decode every texture in a level, print format/size summary, and write
//! up to N PNGs to a chosen folder for visual inspection.
//!
//!   cargo run -p lunalib --example dump_textures -- <level_folder> [output_dir] [max_pngs]
//!
//! `output_dir` defaults to `./tmp_textures`; `max_pngs` defaults to 16.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lunalib::{encode_png, read_textures};

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let Some(folder) = args.next() else {
        eprintln!("usage: dump_textures <level_folder> [output_dir] [max_pngs]");
        return ExitCode::from(2);
    };
    let out_dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("./tmp_textures"));
    let max_pngs: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(16);
    let folder = Path::new(&folder);

    let textures = match read_textures(folder) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("read_textures({}): {e}", folder.display());
            return ExitCode::from(1);
        }
    };

    let mut by_format: BTreeMap<&str, usize> = BTreeMap::new();
    let mut decoded = 0usize;
    let mut total_pixels = 0u64;
    for t in &textures {
        *by_format.entry(t.format.name()).or_insert(0) += 1;
        if t.is_decoded() {
            decoded += 1;
            total_pixels += u64::from(t.width) * u64::from(t.height);
        }
    }

    println!(
        "Loaded {} textures ({} decoded successfully, {} total decoded pixels).",
        textures.len(),
        decoded,
        total_pixels,
    );
    for (name, count) in &by_format {
        println!("  {:<10} : {}", name, count);
    }

    if max_pngs == 0 {
        return ExitCode::SUCCESS;
    }

    if let Err(e) = fs::create_dir_all(&out_dir) {
        eprintln!("mkdir {}: {e}", out_dir.display());
        return ExitCode::from(1);
    }

    let mut written = 0usize;
    for t in &textures {
        if written >= max_pngs {
            break;
        }
        if !t.is_decoded() {
            continue;
        }
        let png = encode_png(&t.rgba, t.width, t.height);
        if png.is_empty() {
            continue;
        }
        let path = out_dir.join(format!(
            "{:08X}_{}_{}x{}.png",
            t.id,
            t.format.name(),
            t.width,
            t.height,
        ));
        if let Err(e) = fs::write(&path, &png) {
            eprintln!("write {}: {e}", path.display());
            continue;
        }
        written += 1;
    }
    println!();
    println!("Wrote {} PNGs to {}", written, out_dir.display());

    ExitCode::SUCCESS
}
