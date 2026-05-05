//! Smoke-test CLI: walk a level's gameplay.dat and print region + moby
//! instance summaries.
//!
//!   cargo run -p lunalib --example dump_gameplay -- <path/to/level/folder>

use std::env;
use std::path::Path;
use std::process::ExitCode;

use lunalib::read_gameplay;

fn main() -> ExitCode {
    let Some(folder) = env::args().nth(1) else {
        eprintln!("usage: dump_gameplay <path/to/level/folder>");
        return ExitCode::from(2);
    };
    let folder = Path::new(&folder);

    let layout = match read_gameplay(folder) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("read_gameplay({}): {e}", folder.display());
            return ExitCode::from(1);
        }
    };

    println!("Found {} region(s).", layout.regions.len());
    for r in &layout.regions {
        println!();
        println!(
            "Region: {} ({} moby instances)",
            r.name,
            r.moby_instances.len(),
        );
        if r.moby_instances.is_empty() {
            continue;
        }

        // Show first 5 instances + a coarse bounding box.
        for inst in r.moby_instances.iter().take(5) {
            println!(
                "  inst 0x{:016X}  moby 0x{:016X}  pos [{:>8.2} {:>8.2} {:>8.2}]  scale {:.3}  '{}'",
                inst.instance_tuid,
                inst.moby_tuid,
                inst.position[0],
                inst.position[1],
                inst.position[2],
                inst.scale,
                inst.name,
            );
        }
        if r.moby_instances.len() > 5 {
            println!("  ... and {} more", r.moby_instances.len() - 5);
        }

        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for inst in &r.moby_instances {
            for axis in 0..3 {
                if inst.position[axis] < min[axis] {
                    min[axis] = inst.position[axis];
                }
                if inst.position[axis] > max[axis] {
                    max[axis] = inst.position[axis];
                }
            }
        }
        println!(
            "  bounds: min [{:>8.2} {:>8.2} {:>8.2}]  max [{:>8.2} {:>8.2} {:>8.2}]",
            min[0], min[1], min[2], max[0], max[1], max[2],
        );

        // Count distinct moby assets used in this region.
        let mut tuids: Vec<u64> = r.moby_instances.iter().map(|i| i.moby_tuid).collect();
        tuids.sort_unstable();
        tuids.dedup();
        println!("  distinct moby assets referenced: {}", tuids.len());
    }

    ExitCode::SUCCESS
}
