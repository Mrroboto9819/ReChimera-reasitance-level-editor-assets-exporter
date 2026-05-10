

use std::env;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::process::ExitCode;
use std::collections::HashSet;

use lunalib::moby::{read_moby_assets_streaming, MobyAsset};
use lunalib::{AssetKind, AssetLookup};

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let mut level: Option<String> = None;
    let mut first: Option<usize> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--first" => match args.next() {
                Some(v) => match v.parse::<usize>() {
                    Ok(n) => first = Some(n),
                    Err(_) => {
                        eprintln!("--first: not a number: {v}");
                        return ExitCode::from(2);
                    }
                },
                None => {
                    eprintln!("--first: missing value");
                    return ExitCode::from(2);
                }
            },
            "-h" | "--help" => {
                println!(
                    "usage: dump_moby_skin <level-folder> [--first N]\n\
                     Walks the moby table and prints skeleton + skin-weight\n\
                     stats for the first N mobys (or all when --first is\n\
                     omitted). Use this to validate parser output."
                );
                return ExitCode::SUCCESS;
            }
            other => {
                if level.is_some() {
                    eprintln!("unexpected positional arg: {other}");
                    return ExitCode::from(2);
                }
                level = Some(other.to_string());
            }
        }
    }

    let Some(level) = level else {
        eprintln!("usage: dump_moby_skin <level-folder> [--first N]");
        return ExitCode::from(2);
    };
    let level_path = Path::new(&level);
    if !level_path.is_dir() {
        eprintln!("not a directory: {level}");
        return ExitCode::from(1);
    }

    println!("Scanning mobys in {}", level_path.display());
    println!("{}", "─".repeat(80));

    let animset_tuids: HashSet<u64> = match File::open(level_path.join("assetlookup.dat")) {
        Ok(f) => match AssetLookup::open(BufReader::new(f)) {
            Ok(mut l) => l
                .pointers(AssetKind::Animset)
                .unwrap_or_default()
                .iter()
                .map(|p| p.tuid)
                .collect(),
            Err(_) => HashSet::new(),
        },
        Err(_) => HashSet::new(),
    };
    println!("Animset table: {} entries", animset_tuids.len());

    let mut printed = 0usize;
    let mut totals = SummaryStats::default();
    let res = read_moby_assets_streaming(level_path, None, |asset| {
        totals.add(&asset, &animset_tuids);
        if first.map_or(true, |n| printed < n) {
            print_moby(&asset, &animset_tuids);
            printed += 1;
        }
    });

    if let Err(e) = res {
        eprintln!("error: {e}");
        return ExitCode::from(1);
    }

    println!();
    println!("{}", "─".repeat(80));
    println!("Summary across {} mobys:", totals.count);
    println!("  with skeleton            : {}", totals.with_skeleton);
    println!("  with non-empty bone_map  : {}", totals.with_bone_map);
    println!("  with skinned vertices    : {}", totals.with_skin);
    println!(
        "  total vertices (skinned) : {} (sum of weights ≠ 255 on {} of them)",
        totals.skinned_vertex_total, totals.weight_sum_off
    );
    println!(
        "  bone-index out-of-range  : {} vertices",
        totals.oob_bone_index_vertices
    );
    println!("  with animset_hash        : {}", totals.with_animset_hash);
    println!("  animset_hash MATCHES table : {}", totals.animset_hash_matches);
    println!("  animset_hash MISSES table  : {}", totals.animset_hash_misses);

    ExitCode::SUCCESS
}

#[derive(Default)]
struct SummaryStats {
    count: usize,
    with_skeleton: usize,
    with_bone_map: usize,
    with_skin: usize,
    skinned_vertex_total: usize,
    weight_sum_off: usize,
    oob_bone_index_vertices: usize,
    with_animset_hash: usize,
    animset_hash_matches: usize,
    animset_hash_misses: usize,
}

impl SummaryStats {
    fn add(&mut self, asset: &MobyAsset, animset_tuids: &HashSet<u64>) {
        self.count += 1;
        if let Some(h) = asset.animset_hash {
            self.with_animset_hash += 1;
            if animset_tuids.contains(&h) {
                self.animset_hash_matches += 1;
            } else {
                self.animset_hash_misses += 1;
            }
        }
        if asset.skeleton.is_some() {
            self.with_skeleton += 1;
        }
        let bone_count = asset
            .skeleton
            .as_ref()
            .map(|s| s.bones.len())
            .unwrap_or(0);

        let mut any_bone_map = false;
        let mut any_skin = false;
        for b in &asset.bangles {
            for m in &b.meshes {
                if !m.bone_indices.is_empty() {
                    any_skin = true;
                    any_bone_map = true;
                    self.skinned_vertex_total += m.vertex_count as usize;

                    for k in 0..(m.vertex_count as usize) {
                        let wsum: u32 = (0..4).map(|i| m.bone_weights[k * 4 + i] as u32).sum();
                        if wsum < 240 || wsum > 270 {

                            self.weight_sum_off += 1;
                        }
                        if bone_count > 0 {
                            for i in 0..4 {
                                let idx = m.bone_indices[k * 4 + i] as usize;
                                let w = m.bone_weights[k * 4 + i];
                                if w > 0 && idx >= bone_count {
                                    self.oob_bone_index_vertices += 1;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        if any_bone_map {
            self.with_bone_map += 1;
        }
        if any_skin {
            self.with_skin += 1;
        }
    }
}

fn print_moby(asset: &MobyAsset, animset_tuids: &HashSet<u64>) {
    let bone_count = asset
        .skeleton
        .as_ref()
        .map(|s| s.bones.len())
        .unwrap_or(0);

    let total_verts: usize = asset
        .bangles
        .iter()
        .flat_map(|b| b.meshes.iter())
        .map(|m| m.vertex_count as usize)
        .sum();
    let skinned_verts: usize = asset
        .bangles
        .iter()
        .flat_map(|b| b.meshes.iter())
        .filter(|m| !m.bone_indices.is_empty())
        .map(|m| m.vertex_count as usize)
        .sum();

    let animset_str = match asset.animset_hash {
        None => "—".to_string(),
        Some(h) => {
            if animset_tuids.contains(&h) {
                format!("0x{:016X} ✓", h)
            } else {
                format!("0x{:016X} (not in table)", h)
            }
        }
    };

    println!(
        "0x{:016X}  {:<28}  bones={:>3}  verts={:>5}  skinned={:>5}  animset={}",
        asset.tuid,
        truncate(&asset.name, 28),
        bone_count,
        total_verts,
        skinned_verts,
        animset_str,
    );

    for b in &asset.bangles {
        for m in &b.meshes {
            if m.bone_indices.is_empty() {
                continue;
            }
            let preview = (m.vertex_count as usize).min(3);
            for k in 0..preview {
                let i = [
                    m.bone_indices[k * 4],
                    m.bone_indices[k * 4 + 1],
                    m.bone_indices[k * 4 + 2],
                    m.bone_indices[k * 4 + 3],
                ];
                let w = [
                    m.bone_weights[k * 4],
                    m.bone_weights[k * 4 + 1],
                    m.bone_weights[k * 4 + 2],
                    m.bone_weights[k * 4 + 3],
                ];
                let wsum: u32 = w.iter().map(|&x| x as u32).sum();
                println!(
                    "    v{:<4} bones=[{:>3},{:>3},{:>3},{:>3}] weights=[{:>3},{:>3},{:>3},{:>3}] (Σ={})",
                    k, i[0], i[1], i[2], i[3], w[0], w[1], w[2], w[3], wsum,
                );
            }
            return;
        }
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}
