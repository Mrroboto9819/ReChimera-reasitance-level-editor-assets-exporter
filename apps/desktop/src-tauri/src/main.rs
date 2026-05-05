#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use std::collections::{HashMap, HashSet};

use lunalib::math::zyx_euler_to_quat;
use lunalib::{
    encode_png, read_gameplay, read_moby_assets, read_shaders, read_textures, read_tie_assets,
    read_zones, AssetKind, AssetLookup, ShaderInfo, Texture,
};
use serde::Serialize;

#[derive(Serialize)]
struct SectionDto {
    id: u32,
    offset: u32,
    count: u32,
    length: u32,
}

#[derive(Serialize)]
struct AssetCount {
    kind: &'static str,
    section_id: u32,
    count: usize,
    present: bool,
}

#[derive(Serialize)]
struct LevelSummary {
    folder: String,
    version_major: u16,
    version_minor: u16,
    sections: Vec<SectionDto>,
    asset_counts: Vec<AssetCount>,
}

#[derive(Serialize)]
struct AssetPointerDto {
    /// Hex string — JS `number` cannot represent a full u64 without precision loss.
    tuid: String,
    offset: u32,
    length: u32,
}

#[derive(Serialize)]
struct InstanceDto {
    /// Unique placement key (instance_tuid for real mobys, synthetic for debug
    /// fallbacks).
    tuid: String,
    /// TUID of the underlying asset this is an instance of.
    asset_tuid: String,
    kind: &'static str,
    name: String,
    position: [f32; 3],
    /// Unit quaternion `[x, y, z, w]` (column-vector / three.js convention).
    quaternion: [f32; 4],
    /// Per-axis scale.
    scale: [f32; 3],
    /// True when sourced from real gameplay/zone data, false for debug spiral.
    real: bool,
}

#[derive(Serialize)]
struct UFragDto {
    tuid: String,
    zone_tuid: String,
    position: [f32; 3],
    radius: f32,
    vertex_count: u16,
    triangle_count: u16,
}

#[derive(Serialize)]
struct LevelLayoutDto {
    instances: Vec<InstanceDto>,
    ufrags: Vec<UFragDto>,
}

/// Self-contained mesh: positions + uvs + triangle indices. Sent as plain
/// number arrays — TypeScript builds a `BufferGeometry` directly.
#[derive(Serialize)]
struct MeshDto {
    positions: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
    /// Lower 32 bits of the albedo texture TUID this mesh wants, or `None`
    /// when the resolver can't find a shader/albedo (frontend falls back to
    /// flat color).
    albedo_id: Option<u32>,
}

#[derive(Serialize)]
struct TextureDto {
    id: u32,
    width: u32,
    height: u32,
    /// PNG-encoded RGBA8 — three.js loads via `URL.createObjectURL`.
    png: Vec<u8>,
}

/// Per-asset geometry: an asset is one moby/tie kind, made of N submeshes.
/// The instance system reuses these via `InstancedMesh` in the frontend.
#[derive(Serialize)]
struct AssetMeshesDto {
    asset_tuid: String,
    submeshes: Vec<MeshDto>,
}

/// Output of `level_meshes` — covers everything the Viewport needs to draw
/// real geometry instead of cube placeholders.
#[derive(Serialize)]
struct LevelMeshesDto {
    moby_assets: Vec<AssetMeshesDto>,
    tie_assets: Vec<AssetMeshesDto>,
    /// One mesh per UFrag in the level. UFrag positions are zone-local; the
    /// frontend renders them at the UFrag's bounding-sphere centre.
    ufrag_meshes: Vec<UFragMeshDto>,
    /// PNG-encoded textures referenced by visible meshes' `albedo_id`.
    textures: Vec<TextureDto>,
}

#[derive(Serialize)]
struct UFragMeshDto {
    tuid: String,
    zone_tuid: String,
    /// World-space position offset (apply to vertices when rendering).
    position: [f32; 3],
    mesh: MeshDto,
}

fn parse_kind(name: &str) -> Option<AssetKind> {
    match name {
        "shader" => Some(AssetKind::Shader),
        "highmip" => Some(AssetKind::HighMip),
        "tie" => Some(AssetKind::Tie),
        "moby" => Some(AssetKind::Moby),
        "zone" => Some(AssetKind::Zone),
        _ => None,
    }
}

fn assetlookup_path(folder: &str) -> PathBuf {
    Path::new(folder).join("assetlookup.dat")
}

fn open_lookup(folder: &str) -> Result<AssetLookup<BufReader<File>>, String> {
    let path = assetlookup_path(folder);
    let file = File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    AssetLookup::open(BufReader::new(file)).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_level(folder: String) -> Result<LevelSummary, String> {
    let mut lookup = open_lookup(&folder)?;

    let sections = lookup
        .file
        .sections
        .iter()
        .map(|s| SectionDto {
            id: s.id,
            offset: s.offset,
            count: s.count,
            length: s.length,
        })
        .collect();

    let mut asset_counts = Vec::new();
    for kind in AssetKind::all() {
        let ptrs = lookup.pointers(*kind).map_err(|e| e.to_string())?;
        asset_counts.push(AssetCount {
            kind: kind.name(),
            section_id: kind.section_id(),
            count: ptrs.len(),
            present: !ptrs.is_empty(),
        });
    }

    Ok(LevelSummary {
        folder,
        version_major: lookup.file.version.major,
        version_minor: lookup.file.version.minor,
        sections,
        asset_counts,
    })
}

#[tauri::command]
fn list_assets(folder: String, kind: String) -> Result<Vec<AssetPointerDto>, String> {
    let kind = parse_kind(&kind).ok_or_else(|| format!("unknown asset kind: {kind}"))?;
    let mut lookup = open_lookup(&folder)?;
    let ptrs = lookup.pointers(kind).map_err(|e| e.to_string())?;
    Ok(ptrs
        .iter()
        .map(|p| AssetPointerDto {
            tuid: format!("0x{:016X}", p.tuid),
            offset: p.offset,
            length: p.length,
        })
        .collect())
}

/// Phase 3b: real placements parsed from gameplay.dat (mobys) and zones.dat
/// (ties + UFrag terrain bounds). Falls back to a debug Fibonacci-spiral if
/// neither parser produces output, so the viewport always has something.
#[tauri::command]
fn level_layout(folder: String) -> Result<LevelLayoutDto, String> {
    let mut instances = Vec::new();
    instances.extend(real_moby_layout(&folder).unwrap_or_default());
    instances.extend(real_tie_layout(&folder).unwrap_or_default());

    let ufrags = real_ufrag_bounds(&folder).unwrap_or_default();

    if !instances.is_empty() || !ufrags.is_empty() {
        return Ok(LevelLayoutDto { instances, ufrags });
    }

    Ok(LevelLayoutDto {
        instances: debug_spiral_layout(&folder)?,
        ufrags: Vec::new(),
    })
}

fn real_moby_layout(folder: &str) -> Option<Vec<InstanceDto>> {
    let layout = read_gameplay(Path::new(folder)).ok()?;
    let mut out = Vec::new();
    for region in layout.regions {
        for inst in region.moby_instances {
            out.push(InstanceDto {
                tuid: format!("0x{:016X}", inst.instance_tuid),
                asset_tuid: format!("0x{:016X}", inst.moby_tuid),
                kind: AssetKind::Moby.name(),
                name: inst.name,
                position: inst.position,
                quaternion: zyx_euler_to_quat(inst.rotation),
                scale: [inst.scale, inst.scale, inst.scale],
                real: true,
            });
        }
    }
    (!out.is_empty()).then_some(out)
}

fn real_tie_layout(folder: &str) -> Option<Vec<InstanceDto>> {
    let zones = read_zones(Path::new(folder)).ok()?;
    let mut out = Vec::new();
    for zone in zones {
        for inst in zone.tie_instances {
            out.push(InstanceDto {
                tuid: format!("0x{:016X}", inst.instance_tuid),
                asset_tuid: format!("0x{:016X}", inst.tie_tuid),
                kind: AssetKind::Tie.name(),
                name: inst.name,
                position: inst.position,
                quaternion: inst.quaternion,
                scale: inst.scale,
                real: true,
            });
        }
    }
    (!out.is_empty()).then_some(out)
}

fn real_ufrag_bounds(folder: &str) -> Option<Vec<UFragDto>> {
    let zones = read_zones(Path::new(folder)).ok()?;
    let mut out = Vec::new();
    for zone in zones {
        let zone_tuid_hex = format!("0x{:016X}", zone.tuid);
        for u in zone.ufrags {
            out.push(UFragDto {
                tuid: format!("0x{:016X}", u.tuid),
                zone_tuid: zone_tuid_hex.clone(),
                position: u.position,
                radius: u.radius,
                vertex_count: u.vertex_count,
                triangle_count: u.index_count / 3,
            });
        }
    }
    (!out.is_empty()).then_some(out)
}

fn debug_spiral_layout(folder: &str) -> Result<Vec<InstanceDto>, String> {
    let mut lookup = open_lookup(folder)?;

    let kinds = [
        (AssetKind::Tie, -25.0_f32, 0.0_f32),
        (AssetKind::Moby, 25.0_f32, 1.5_f32),
    ];

    let golden_angle = std::f32::consts::PI * (3.0 - 5.0_f32.sqrt());
    let mut out = Vec::new();

    for (kind, x_anchor, y) in kinds {
        let ptrs = lookup.pointers(kind).map_err(|e| e.to_string())?;
        for (i, p) in ptrs.iter().enumerate() {
            let theta = (i as f32) * golden_angle;
            let r = (i as f32).sqrt() * 1.3;
            let tuid_hex = format!("0x{:016X}", p.tuid);
            out.push(InstanceDto {
                tuid: format!("{tuid_hex}#{i}"),
                asset_tuid: tuid_hex,
                kind: kind.name(),
                name: format!("{}_{i}", kind.name()),
                position: [x_anchor + r * theta.cos(), y, r * theta.sin()],
                quaternion: [0.0, 0.0, 0.0, 1.0],
                scale: [1.0, 1.0, 1.0],
                real: false,
            });
        }
    }
    Ok(out)
}

/// Phase 3c+3d: decode every placed moby/tie asset's geometry, every UFrag
/// terrain chunk, every shader→albedo mapping, and the actual texture pixels
/// that visible meshes reference.
///
/// Heavy command (~10s on a full level). Designed to run once per level open.
#[tauri::command]
fn level_meshes(folder: String) -> Result<LevelMeshesDto, String> {
    let path = Path::new(&folder);

    // Step 1: which asset TUIDs are actually placed in this level?
    let mut moby_tuids: Vec<u64> = Vec::new();
    let mut tie_tuids: Vec<u64> = Vec::new();

    if let Ok(layout) = read_gameplay(path) {
        for region in layout.regions {
            for inst in region.moby_instances {
                if !moby_tuids.contains(&inst.moby_tuid) {
                    moby_tuids.push(inst.moby_tuid);
                }
            }
        }
    }
    let zones = read_zones(path).map_err(|e| e.to_string())?;
    for zone in &zones {
        for inst in &zone.tie_instances {
            if !tie_tuids.contains(&inst.tie_tuid) {
                tie_tuids.push(inst.tie_tuid);
            }
        }
    }

    // Step 2: shader resolver.
    let shaders: HashMap<u64, ShaderInfo> = read_shaders(path).map_err(|e| e.to_string())?;
    let resolve_albedo = |shader_tuids: &[u64], shader_index: usize| -> Option<u32> {
        let st = *shader_tuids.get(shader_index)?;
        shaders.get(&st)?.albedo_tex_id
    };

    // Step 3: decode mobys + collect their albedo IDs.
    let mut needed_albedo: HashSet<u32> = HashSet::new();

    let moby_assets: Vec<AssetMeshesDto> = read_moby_assets(path, Some(&moby_tuids))
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|asset| {
            let mut submeshes = Vec::new();
            for bangle in asset.bangles {
                for m in bangle.meshes {
                    let albedo = resolve_albedo(&asset.shader_tuids, m.shader_index as usize);
                    if let Some(id) = albedo {
                        needed_albedo.insert(id);
                    }
                    submeshes.push(MeshDto {
                        positions: m.positions,
                        uvs: m.uvs,
                        indices: m.indices,
                        albedo_id: albedo,
                    });
                }
            }
            AssetMeshesDto {
                asset_tuid: format!("0x{:016X}", asset.tuid),
                submeshes,
            }
        })
        .collect();

    // Step 4: decode ties + collect albedo IDs.
    let tie_assets: Vec<AssetMeshesDto> = read_tie_assets(path, Some(&tie_tuids))
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|asset| AssetMeshesDto {
            asset_tuid: format!("0x{:016X}", asset.tuid),
            submeshes: asset
                .meshes
                .into_iter()
                .map(|m| {
                    let albedo = resolve_albedo(&asset.shader_tuids, m.shader_index as usize);
                    if let Some(id) = albedo {
                        needed_albedo.insert(id);
                    }
                    MeshDto {
                        positions: m.positions,
                        uvs: m.uvs,
                        indices: m.indices,
                        albedo_id: albedo,
                    }
                })
                .collect(),
        })
        .collect();

    // Step 5: UFrag meshes + albedo IDs (each zone has its own shader table).
    let mut ufrag_meshes: Vec<UFragMeshDto> = Vec::new();
    for zone in zones {
        let zone_tuid_hex = format!("0x{:016X}", zone.tuid);
        for u in zone.ufrags {
            if u.positions.is_empty() || u.indices.is_empty() {
                continue;
            }
            let albedo = zone
                .ufrag_shader_tuids
                .get(u.shader_index as usize)
                .and_then(|st| shaders.get(st))
                .and_then(|s| s.albedo_tex_id);
            if let Some(id) = albedo {
                needed_albedo.insert(id);
            }
            ufrag_meshes.push(UFragMeshDto {
                tuid: format!("0x{:016X}", u.tuid),
                zone_tuid: zone_tuid_hex.clone(),
                position: u.position,
                mesh: MeshDto {
                    positions: u.positions,
                    uvs: u.uvs,
                    indices: u.indices,
                    albedo_id: albedo,
                },
            });
        }
    }

    // Step 6: decode and PNG-encode only the textures we'll actually use.
    let textures: Vec<TextureDto> = if needed_albedo.is_empty() {
        Vec::new()
    } else {
        read_textures(path)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|t: &Texture| t.is_decoded() && needed_albedo.contains(&t.id))
            .filter_map(|t| {
                let png = encode_png(&t.rgba, t.width, t.height);
                if png.is_empty() {
                    return None;
                }
                Some(TextureDto {
                    id: t.id,
                    width: t.width,
                    height: t.height,
                    png,
                })
            })
            .collect()
    };

    Ok(LevelMeshesDto {
        moby_assets,
        tie_assets,
        ufrag_meshes,
        textures,
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_level,
            list_assets,
            level_layout,
            level_meshes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
