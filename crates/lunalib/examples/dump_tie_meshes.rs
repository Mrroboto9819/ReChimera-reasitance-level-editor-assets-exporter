

use std::env;
use std::path::Path;
use std::process::ExitCode;

use lunalib::read_tie_assets;

fn main() -> ExitCode {
    let Some(folder) = env::args().nth(1) else {
        eprintln!("usage: dump_tie_meshes <path/to/level/folder>");
        return ExitCode::from(2);
    };
    let folder = Path::new(&folder);

    let assets = match read_tie_assets(folder, None) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("read_tie_assets({}): {e}", folder.display());
            return ExitCode::from(1);
        }
    };

    let total_meshes: usize = assets.iter().map(|a| a.meshes.len()).sum();
    let total_verts: usize = assets
        .iter()
        .flat_map(|a| a.meshes.iter())
        .map(|m| m.vertex_count as usize)
        .sum();
    let total_tris: usize = assets
        .iter()
        .flat_map(|a| a.meshes.iter())
        .map(|m| (m.index_count / 3) as usize)
        .sum();

    println!(
        "Decoded {} tie assets — {} submeshes / {} verts / {} tris.",
        assets.len(),
        total_meshes,
        total_verts,
        total_tris,
    );
    println!();

    for a in assets.iter().take(8) {
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        let mut verts = 0usize;
        let mut tris = 0usize;
        for m in &a.meshes {
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
        let size = if verts == 0 {
            [0.0_f32; 3]
        } else {
            [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
        };
        println!(
            "  0x{:016X}  meshes={} verts={} tris={}  scale=[{:.3} {:.3} {:.3}]  size={:.2}×{:.2}×{:.2}",
            a.tuid,
            a.meshes.len(),
            verts,
            tris,
            a.scale[0],
            a.scale[1],
            a.scale[2],
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
