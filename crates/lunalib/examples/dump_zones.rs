//! Smoke-test CLI: walk a level's zones.dat and print tie-instance summaries.
//!
//!   cargo run -p lunalib --example dump_zones -- <path/to/level/folder>

use std::env;
use std::path::Path;
use std::process::ExitCode;

use lunalib::read_zones;

fn main() -> ExitCode {
    let Some(folder) = env::args().nth(1) else {
        eprintln!("usage: dump_zones <path/to/level/folder>");
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

    let total_ties: usize = zones.iter().map(|z| z.tie_instances.len()).sum();
    println!(
        "Found {} zones, {} tie instances total.",
        zones.len(),
        total_ties,
    );

    for (i, zone) in zones.iter().enumerate() {
        println!();
        println!(
            "Zone {} (tuid 0x{:016X}) — {} tie instances",
            i,
            zone.tuid,
            zone.tie_instances.len(),
        );
        if zone.tie_instances.is_empty() {
            continue;
        }

        for inst in zone.tie_instances.iter().take(3) {
            println!(
                "  inst 0x{:016X}  tie 0x{:016X}  pos [{:>7.2} {:>7.2} {:>7.2}]  scale [{:.2} {:.2} {:.2}]  quat [{:.3} {:.3} {:.3} {:.3}]  '{}'",
                inst.instance_tuid,
                inst.tie_tuid,
                inst.position[0], inst.position[1], inst.position[2],
                inst.scale[0], inst.scale[1], inst.scale[2],
                inst.quaternion[0], inst.quaternion[1], inst.quaternion[2], inst.quaternion[3],
                inst.name,
            );
        }
        if zone.tie_instances.len() > 3 {
            println!("  ... and {} more", zone.tie_instances.len() - 3);
        }

        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for inst in &zone.tie_instances {
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

        let mut tuids: Vec<u64> = zone.tie_instances.iter().map(|t| t.tie_tuid).collect();
        tuids.sort_unstable();
        tuids.dedup();
        println!("  distinct tie assets: {}", tuids.len());
    }

    ExitCode::SUCCESS
}
