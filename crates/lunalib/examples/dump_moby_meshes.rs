//! Smoke-test CLI: decode every moby asset's geometry from `mobys.dat` and
//! print vertex/triangle counts + a coarse local AABB per asset.
//!
//!   cargo run -p lunalib --example dump_moby_meshes -- <path/to/level>

use std::env;
use std::path::Path;
use std::process::ExitCode;

use lunalib::read_moby_assets;

fn main() -> ExitCode {
    let Some(folder) = env::args().nth(1) else {
        eprintln!("usage: dump_moby_meshes <path/to/level/folder>");
        return ExitCode::from(2);
    };
    let folder = Path::new(&folder);

    let assets = match read_moby_assets(folder, None) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("read_moby_assets({}): {e}", folder.display());
            return ExitCode::from(1);
        }
    };

    let mut total_meshes = 0usize;
    let mut total_verts = 0usize;
    let mut total_tris = 0usize;
    for a in &assets {
        for b in &a.bangles {
            for m in &b.meshes {
                total_meshes += 1;
                total_verts += m.vertex_count as usize;
                total_tris += (m.index_count / 3) as usize;
            }
        }
    }

    println!(
        "Decoded {} moby assets — {} submeshes / {} verts / {} tris total.",
        assets.len(),
        total_meshes,
        total_verts,
        total_tris,
    );

    println!();
    for a in assets.iter().take(8) {
        let mut verts = 0usize;
        let mut tris = 0usize;
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for b in &a.bangles {
            for m in &b.meshes {
                verts += m.vertex_count as usize;
                tris += (m.index_count / 3) as usize;
                for k in 0..(m.vertex_count as usize) {
                    let p = [
                        m.positions[k * 3],
                        m.positions[k * 3 + 1],
                        m.positions[k * 3 + 2],
                    ];
                    for axis in 0..3 {
                        if p[axis] < min[axis] {
                            min[axis] = p[axis];
                        }
                        if p[axis] > max[axis] {
                            max[axis] = p[axis];
                        }
                    }
                }
            }
        }
        let size = if verts == 0 {
            [0.0_f32; 3]
        } else {
            [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
        };
        println!(
            "  0x{:016X}  {:<32}  bangles={} verts={} tris={}  size={:.2}×{:.2}×{:.2}",
            a.tuid,
            shorten(&a.name),
            a.bangles.len(),
            verts,
            tris,
            size[0],
            size[1],
            size[2],
        );
    }
    if assets.len() > 8 {
        println!("  ... and {} more", assets.len() - 8);
    }

    ExitCode::SUCCESS
}

fn shorten(s: &str) -> String {
    if s.len() > 32 {
        format!("{}…", &s[..31])
    } else {
        s.to_string()
    }
}
