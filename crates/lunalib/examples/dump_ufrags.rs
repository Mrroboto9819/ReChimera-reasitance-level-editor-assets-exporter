

use std::env;
use std::path::Path;
use std::process::ExitCode;

use lunalib::read_zones;

fn main() -> ExitCode {
    let Some(folder) = env::args().nth(1) else {
        eprintln!("usage: dump_ufrags <path/to/level/folder>");
        return ExitCode::from(2);
    };
    let folder = Path::new(&folder);

    let zones = match read_zones(folder) {
        Ok(z) => z,
        Err(e) => {
            eprintln!("read_zones({}): {e}", folder.display());
            return ExitCode::from(1);
        }
    };

    let total: usize = zones.iter().map(|z| z.ufrags.len()).sum();
    let total_verts: u64 = zones
        .iter()
        .flat_map(|z| z.ufrags.iter())
        .map(|u| u64::from(u.vertex_count))
        .sum();
    let total_idx: u64 = zones
        .iter()
        .flat_map(|z| z.ufrags.iter())
        .map(|u| u64::from(u.index_count))
        .sum();

    println!(
        "Found {} zones, {} UFrag chunks ({} verts / {} indices total).",
        zones.len(),
        total,
        total_verts,
        total_idx,
    );

    for (i, zone) in zones.iter().enumerate() {
        println!();
        println!(
            "Zone {} (tuid 0x{:016X}) — {} UFrags",
            i,
            zone.tuid,
            zone.ufrags.len(),
        );
        if zone.ufrags.is_empty() {
            continue;
        }

        for u in zone.ufrags.iter().take(3) {
            println!(
                "  ufrag 0x{:016X}  pos [{:>8.2} {:>8.2} {:>8.2}]  r={:>6.2}  verts={:>5}  tris={:>5}",
                u.tuid,
                u.position[0],
                u.position[1],
                u.position[2],
                u.radius,
                u.vertex_count,
                u.index_count / 3,
            );
        }
        if zone.ufrags.len() > 3 {
            println!("  ... and {} more", zone.ufrags.len() - 3);
        }

        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for u in &zone.ufrags {
            for axis in 0..3 {
                if u.position[axis] - u.radius < min[axis] {
                    min[axis] = u.position[axis] - u.radius;
                }
                if u.position[axis] + u.radius > max[axis] {
                    max[axis] = u.position[axis] + u.radius;
                }
            }
        }
        println!(
            "  envelope: min [{:>8.2} {:>8.2} {:>8.2}]  max [{:>8.2} {:>8.2} {:>8.2}]",
            min[0], min[1], min[2], max[0], max[1], max[2],
        );
    }

    ExitCode::SUCCESS
}
