

use std::env;
use std::path::Path;
use std::process::ExitCode;

use lunalib::{read_moby_assets, read_shaders, read_tie_assets, read_zones};

fn main() -> ExitCode {
    let Some(folder) = env::args().nth(1) else {
        eprintln!("usage: dump_shaders <path/to/level/folder>");
        return ExitCode::from(2);
    };
    let folder = Path::new(&folder);

    let shaders = match read_shaders(folder) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("read_shaders({}): {e}", folder.display());
            return ExitCode::from(1);
        }
    };
    let with_albedo = shaders.values().filter(|s| s.albedo_tex_id.is_some()).count();
    println!(
        "Loaded {} shaders ({} reference an albedo texture).",
        shaders.len(),
        with_albedo,
    );

    println!();
    println!("== sample moby shader resolutions ==");
    if let Ok(mobys) = read_moby_assets(folder, None) {
        for asset in mobys.iter().take(5) {
            println!(
                "  moby 0x{:016X}  {} submeshes  shader_tuids={}",
                asset.tuid,
                asset.bangles.iter().map(|b| b.meshes.len()).sum::<usize>(),
                asset.shader_tuids.len(),
            );
            for (b_idx, bangle) in asset.bangles.iter().enumerate() {
                for (m_idx, mesh) in bangle.meshes.iter().enumerate() {
                    let shader_tuid = asset
                        .shader_tuids
                        .get(mesh.shader_index as usize)
                        .copied()
                        .unwrap_or(0);
                    let albedo = shaders
                        .get(&shader_tuid)
                        .and_then(|s| s.albedo_tex_id)
                        .map(|a| format!("0x{a:08X}"))
                        .unwrap_or_else(|| "none".to_string());
                    println!(
                        "    bangle{b_idx} mesh{m_idx}: shader_index={:>3}  shader_tuid=0x{shader_tuid:016X}  albedo={albedo}",
                        mesh.shader_index,
                    );
                    if b_idx == 0 && m_idx >= 2 {
                        break;
                    }
                }
            }
        }
    }

    println!();
    println!("== sample tie shader resolutions ==");
    if let Ok(ties) = read_tie_assets(folder, None) {
        for asset in ties.iter().take(5) {
            println!(
                "  tie 0x{:016X}  {} meshes  shader_tuids={}",
                asset.tuid,
                asset.meshes.len(),
                asset.shader_tuids.len(),
            );
            for (m_idx, mesh) in asset.meshes.iter().enumerate().take(3) {
                let shader_tuid = asset
                    .shader_tuids
                    .get(mesh.shader_index as usize)
                    .copied()
                    .unwrap_or(0);
                let albedo = shaders
                    .get(&shader_tuid)
                    .and_then(|s| s.albedo_tex_id)
                    .map(|a| format!("0x{a:08X}"))
                    .unwrap_or_else(|| "none".to_string());
                println!(
                    "    mesh{m_idx}: shader_index={:>3}  shader_tuid=0x{shader_tuid:016X}  albedo={albedo}",
                    mesh.shader_index,
                );
            }
        }
    }

    println!();
    println!("== sample zone UFrag shader resolutions ==");
    if let Ok(zones) = read_zones(folder) {
        for zone in zones.iter().take(2) {
            println!(
                "  zone 0x{:016X}  {} ufrags  shader_tuids={}",
                zone.tuid,
                zone.ufrags.len(),
                zone.ufrag_shader_tuids.len(),
            );
            for u in zone.ufrags.iter().take(3) {
                let shader_tuid = zone
                    .ufrag_shader_tuids
                    .get(u.shader_index as usize)
                    .copied()
                    .unwrap_or(0);
                let albedo = shaders
                    .get(&shader_tuid)
                    .and_then(|s| s.albedo_tex_id)
                    .map(|a| format!("0x{a:08X}"))
                    .unwrap_or_else(|| "none".to_string());
                println!(
                    "    ufrag 0x{:016X}: shader_index={:>3}  shader_tuid=0x{shader_tuid:016X}  albedo={albedo}",
                    u.tuid, u.shader_index,
                );
            }
        }
    }

    ExitCode::SUCCESS
}
