#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use std::collections::{HashMap, HashSet};

use lunalib::math::zyx_euler_to_quat;
use lunalib::{
    decode_animation, downsample_rgba, encode_png, read_animation_control, read_animation_header,
    read_gameplay, read_moby_assets_with_total, read_shaders, read_textures_with_total,
    read_tie_assets_with_total, read_zones, read_zones_streaming, AssetKind, AssetLookup, IgFile,
    ShaderInfo,
};
use serde::Serialize;
use tauri::ipc::Channel;

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
///
/// Each `*_id` is the lower 32 bits of a highmip TUID; the frontend looks
/// it up in the same texture cache (filled by `LevelEvent::Texture`) for
/// all three slots. `None` means the shader/asset doesn't reference one.
#[derive(Serialize)]
struct MeshDto {
    positions: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
    /// Albedo / base color map.
    albedo_id: Option<u32>,
    /// Tangent-space normal map.
    normal_id: Option<u32>,
    /// Insomniac calls this "expensive" — usually a packed map (specular /
    /// emission / detail). We attach it as `emissiveMap` since glow / paint
    /// markings are the most user-visible interpretation.
    emissive_id: Option<u32>,
    /// Per-vertex global bone indices `[i0,i1,i2,i3]` — `vertex_count * 4`
    /// entries. Empty when the submesh isn't skinned (rigless props). The
    /// frontend wires these into `THREE.SkinnedMesh.skinIndex` when
    /// non-empty.
    bone_indices: Vec<u16>,
    /// Per-vertex weights as u8 (0..255). Same length as `bone_indices`.
    /// Frontend normalizes to 0..1 for `THREE.SkinnedMesh.skinWeight`.
    bone_weights: Vec<u8>,
}

#[derive(Serialize)]
struct TextureDto {
    id: u32,
    width: u32,
    height: u32,
    /// PNG-encoded RGBA8 — three.js loads via `URL.createObjectURL`.
    png: Vec<u8>,
}

/// Compact skeleton hierarchy + bind pose, sent per-asset alongside the
/// submeshes. Frontend uses this to (eventually) build `THREE.Skeleton` +
/// `THREE.SkinnedMesh`. Phase 1 only surfaces the bone count so the
/// Inspector can show "Skeleton: N bones"; skin weights + animation come
/// in later phases.
#[derive(Serialize)]
struct SkeletonDto {
    /// Number of bones — convenience so the UI doesn't have to count.
    bone_count: usize,
    /// Index of the root bone in `parents` / `bind_local`.
    root_bone: u16,
    /// Per-bone parent index. -1 = root. Indexing the rest matches `bones`
    /// in the underlying `Skeleton` struct.
    parents: Vec<i16>,
    /// Per-bone local bind-pose (column-major 4x4). Length == `bone_count`
    /// when present, empty when the moby's tms0 pointer was null.
    bind_local: Vec<[f32; 16]>,
    /// World-space inverse bind-pose. Length == `bone_count` when present.
    /// Required by `THREE.Skeleton`'s `boneInverses` array.
    bind_world_inverse: Vec<[f32; 16]>,
    /// Power-of-2 exponent for animation scale values. Frontend computes
    /// `scale_scale = 2 ^ scale_shift` when calling `fetch_animset_clip`.
    scale_shift: u16,
    /// Same role for translations. Currently informational — the
    /// per-moby `bind_pose_inverse_offset` is the canonical source for
    /// position scaling.
    translation_shift: u16,
}

/// Per-asset geometry: an asset is one moby/tie kind, made of N submeshes.
/// The instance system reuses these via `InstancedMesh` in the frontend.
#[derive(Serialize)]
struct AssetMeshesDto {
    asset_tuid: String,
    submeshes: Vec<MeshDto>,
    /// Optional rig — present for animated mobys (characters, weapons,
    /// enemies), `None` for static props.
    skeleton: Option<SkeletonDto>,
    /// `MobyV2.animsetHash` — points into `animsets.dat`. Frontend uses
    /// this with `fetch_animset_clip` to load the character's animation.
    /// `None` for ties / rigless mobys.
    animset_hash: Option<String>,
    /// Power-of-2 exponent for animation translation values. Backend
    /// converts to a float when calling `decode_animation`. Mostly an
    /// FYI for the frontend.
    bind_pose_inverse_offset: i16,
}

#[derive(Serialize)]
struct UFragMeshDto {
    tuid: String,
    zone_tuid: String,
    /// World-space position offset (apply to vertices when rendering).
    position: [f32; 3],
    mesh: MeshDto,
}

/// Build a SkeletonDto from the lib's Skeleton, or None for rigless mobys.
/// Ties don't have skeletons — they're static — so this only gets called
/// from the moby decode paths.
fn build_skeleton_dto(skel: &Option<lunalib::Skeleton>) -> Option<SkeletonDto> {
    let s = skel.as_ref()?;
    Some(SkeletonDto {
        bone_count: s.bones.len(),
        root_bone: s.root_bone,
        parents: s.bones.iter().map(|b| b.parent_index).collect(),
        bind_local: s.bind_local.clone(),
        bind_world_inverse: s.bind_world_inverse.clone(),
        scale_shift: s.scale_shift,
        translation_shift: s.translation_shift,
    })
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

/// Items per chunk. We yield a longer pause between chunks so the JS
/// thread has time to parse + render what it already has before we drown
/// it in the next batch. Diagnostic showed JS chokes on bursts of large
/// mesh JSON, so chunks are kept small + pauses long enough for the
/// frontend's BUILD_BATCH=2 to drain a few mobys per chunk.
const CHUNK_SIZE: usize = 4;
/// Sleep between chunks. Picked to match ~6 frames at 60Hz so the
/// frontend can build BUILD_BATCH=2 mobys × 3 renders per chunk window.
const CHUNK_PAUSE_MS: u64 = 100;

/// Helper called by every per-item streaming loop. After every CHUNK_SIZE
/// items it pauses for CHUNK_PAUSE_MS — that's the actual freeze fix.
/// Inline so the closure overhead is zero.
#[inline(always)]
fn chunk_yield(counter: usize) {
    if counter > 0 && counter % CHUNK_SIZE == 0 {
        std::thread::sleep(std::time::Duration::from_millis(CHUNK_PAUSE_MS));
    }
}

/// Streaming events emitted by `level_meshes_stream`. The frontend listens on
/// a `Channel<LevelEvent>` and updates UI / appends meshes incrementally.
///
/// Phase boundaries: layout → shaders → mobys → ties → ufrags → textures →
/// done. Each phase emits exactly one `Phase` event up front (with the total
/// item count for that phase + the chunk size so the UI can show "Chunk
/// X/Y"), then 0..N item events, then optionally a final `Progress` to
/// mark completion.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LevelEvent {
    /// Start of a new phase. `total` is the item count for this phase
    /// (callers should reset their per-phase progress to 0). `chunk_size`
    /// is constant across phases — the frontend uses it to compute the
    /// current chunk index from `current` (e.g. `ceil(current / chunk_size)`).
    Phase {
        phase: &'static str,
        label: &'static str,
        total: usize,
        chunk_size: usize,
    },
    /// Item count completed within the current phase.
    Progress { current: usize },
    /// One decoded moby asset (geometry + albedo refs).
    MobyAsset { asset: AssetMeshesDto },
    /// One decoded tie asset.
    TieAsset { asset: AssetMeshesDto },
    /// One decoded UFrag terrain chunk.
    UfragMesh { mesh: UFragMeshDto },
    /// One decoded + PNG-encoded texture referenced by a visible mesh.
    Texture { texture: TextureDto },
    /// All phases finished successfully.
    Done,
    /// Fatal error mid-stream — frontend should stop showing progress.
    Error { message: String },
}

/// Streaming counterpart to the old `level_meshes`. Same outputs, but pushed
/// over a `Channel` per item rather than buffered into one giant response.
///
/// Why streaming:
/// - Frontend can render mobys before ties finish, ties before terrain, etc.
/// - Progress UI has phase labels + within-phase counts.
/// - JS gets to yield to the event loop between chunks instead of choking
///   on one ~10s blocking call.
#[tauri::command]
fn level_meshes_stream(folder: String, on_event: Channel<LevelEvent>) -> Result<(), String> {
    if let Err(message) = run_level_stream(&folder, &on_event) {
        let _ = on_event.send(LevelEvent::Error { message: message.clone() });
        return Err(message);
    }
    let _ = on_event.send(LevelEvent::Done);
    Ok(())
}

fn run_level_stream(folder: &str, on_event: &Channel<LevelEvent>) -> Result<(), String> {
    let path = Path::new(folder);

    // ── Phase 1: layout — figure out which asset TUIDs are actually placed
    // in this level. Cheap (sub-second on real data). HashSet keeps dedup
    // O(1) per insert; the old Vec::contains was O(n²).
    let _ = on_event.send(LevelEvent::Phase {
        phase: "layout",
        label: "Reading placements",
        total: 1,
        chunk_size: CHUNK_SIZE,
    });

    let mut moby_tuids: HashSet<u64> = HashSet::new();
    let mut tie_tuids: HashSet<u64> = HashSet::new();

    if let Ok(layout) = read_gameplay(path) {
        for region in layout.regions {
            for inst in region.moby_instances {
                moby_tuids.insert(inst.moby_tuid);
            }
        }
    }

    // We need each Zone twice — once now to enumerate placed tie TUIDs +
    // collect ufrag work, and again later to emit ufrag meshes. Do both in
    // one pass: cache zones in memory (they're already small enough — only
    // their tie_instances/ufrag headers, no decoded geometry).
    let mut zones: Vec<lunalib::Zone> = Vec::new();
    read_zones_streaming(path, |z| {
        for inst in &z.tie_instances {
            tie_tuids.insert(inst.tie_tuid);
        }
        zones.push(z);
    })
    .map_err(|e| e.to_string())?;

    let moby_tuids: Vec<u64> = moby_tuids.into_iter().collect();
    let tie_tuids: Vec<u64> = tie_tuids.into_iter().collect();
    let _ = on_event.send(LevelEvent::Progress { current: 1 });

    // ── Phase 2: shader resolver. Single read of shaders.dat → HashMap.
    let _ = on_event.send(LevelEvent::Phase {
        phase: "shaders",
        label: "Reading shaders",
        total: 1,
        chunk_size: CHUNK_SIZE,
    });
    let shaders: HashMap<u64, ShaderInfo> = read_shaders(path).map_err(|e| e.to_string())?;
    // (albedo, normal, emissive) ids for the given shader_index. Centralizes
    // the lookup so we don't repeat the option chain at each call site.
    let resolve_textures = |shader_tuids: &[u64], shader_index: usize|
        -> (Option<u32>, Option<u32>, Option<u32>)
    {
        let Some(&st) = shader_tuids.get(shader_index) else {
            return (None, None, None);
        };
        let Some(s) = shaders.get(&st) else {
            return (None, None, None);
        };
        (s.albedo_tex_id, s.normal_tex_id, s.expensive_tex_id)
    };
    let _ = on_event.send(LevelEvent::Progress { current: 1 });

    // Track which textures any visible mesh actually references — used as a
    // filter in the textures phase so we don't decode every highmip in the
    // level (most aren't visible from the placed mobys/ties/ufrags).
    let mut needed_albedo: HashSet<u32> = HashSet::new();

    // ── Phase 3: mobys. Streamed per-asset.
    {
        let mut moby_done = 0usize;
        read_moby_assets_with_total(
            path,
            Some(&moby_tuids),
            |total| {
                let _ = on_event.send(LevelEvent::Phase {
                    phase: "mobys",
                    label: "Decoding mobys",
                    total,
                    chunk_size: CHUNK_SIZE,
                });
            },
            |asset| {
                let mut submeshes = Vec::new();
                for bangle in asset.bangles {
                    for m in bangle.meshes {
                        let (albedo, normal, emissive) =
                            resolve_textures(&asset.shader_tuids, m.shader_index as usize);
                        for id in [albedo, normal, emissive].into_iter().flatten() {
                            needed_albedo.insert(id);
                        }
                        submeshes.push(MeshDto {
                            positions: m.positions,
                            uvs: m.uvs,
                            indices: m.indices,
                            albedo_id: albedo,
                            normal_id: normal,
                            emissive_id: emissive,
                            bone_indices: m.bone_indices,
                            bone_weights: m.bone_weights,
                        });
                    }
                }
                let skeleton = build_skeleton_dto(&asset.skeleton);
                let dto = AssetMeshesDto {
                    asset_tuid: format!("0x{:016X}", asset.tuid),
                    submeshes,
                    skeleton,
                    animset_hash: asset.animset_hash.map(|h| format!("0x{:016X}", h)),
                    bind_pose_inverse_offset: asset.bind_pose_inverse_offset,
                };
                let _ = on_event.send(LevelEvent::MobyAsset { asset: dto });
                moby_done += 1;
                let _ = on_event.send(LevelEvent::Progress { current: moby_done });
                chunk_yield(moby_done);
            },
        )
        .map_err(|e| e.to_string())?;
    }

    // ── Phase 4: ties. Streamed per-asset.
    {
        let mut tie_done = 0usize;
        read_tie_assets_with_total(
            path,
            Some(&tie_tuids),
            |total| {
                let _ = on_event.send(LevelEvent::Phase {
                    phase: "ties",
                    label: "Decoding ties",
                    total,
                    chunk_size: CHUNK_SIZE,
                });
            },
            |asset| {
                let submeshes: Vec<MeshDto> = asset
                    .meshes
                    .into_iter()
                    .map(|m| {
                        let (albedo, normal, emissive) =
                            resolve_textures(&asset.shader_tuids, m.shader_index as usize);
                        for id in [albedo, normal, emissive].into_iter().flatten() {
                            needed_albedo.insert(id);
                        }
                        MeshDto {
                            positions: m.positions,
                            uvs: m.uvs,
                            indices: m.indices,
                            albedo_id: albedo,
                            normal_id: normal,
                            emissive_id: emissive,
                            // Ties are static — no per-vertex skinning.
                            bone_indices: Vec::new(),
                            bone_weights: Vec::new(),
                        }
                    })
                    .collect();
                // Ties are static — no skeleton, no animset.
                let dto = AssetMeshesDto {
                    asset_tuid: format!("0x{:016X}", asset.tuid),
                    submeshes,
                    skeleton: None,
                    animset_hash: None,
                    bind_pose_inverse_offset: 0,
                };
                let _ = on_event.send(LevelEvent::TieAsset { asset: dto });
                tie_done += 1;
                let _ = on_event.send(LevelEvent::Progress { current: tie_done });
                chunk_yield(tie_done);
            },
        )
        .map_err(|e| e.to_string())?;
    }

    // ── Phase 5: UFrag terrain — emit one mesh per non-empty ufrag.
    let total_ufrags: usize = zones
        .iter()
        .map(|z| {
            z.ufrags
                .iter()
                .filter(|u| !u.positions.is_empty() && !u.indices.is_empty())
                .count()
        })
        .sum();
    let _ = on_event.send(LevelEvent::Phase {
        phase: "ufrags",
        label: "Decoding terrain",
        total: total_ufrags,
        chunk_size: CHUNK_SIZE,
    });
    let mut ufrag_done = 0usize;
    for zone in zones {
        let zone_tuid_hex = format!("0x{:016X}", zone.tuid);
        for u in zone.ufrags {
            if u.positions.is_empty() || u.indices.is_empty() {
                continue;
            }
            let shader_info = zone
                .ufrag_shader_tuids
                .get(u.shader_index as usize)
                .and_then(|st| shaders.get(st));
            let albedo = shader_info.and_then(|s| s.albedo_tex_id);
            let normal = shader_info.and_then(|s| s.normal_tex_id);
            let emissive = shader_info.and_then(|s| s.expensive_tex_id);
            for id in [albedo, normal, emissive].into_iter().flatten() {
                needed_albedo.insert(id);
            }
            let dto = UFragMeshDto {
                tuid: format!("0x{:016X}", u.tuid),
                zone_tuid: zone_tuid_hex.clone(),
                position: u.position,
                mesh: MeshDto {
                    positions: u.positions,
                    uvs: u.uvs,
                    indices: u.indices,
                    albedo_id: albedo,
                    normal_id: normal,
                    emissive_id: emissive,
                    // Terrain ufrags aren't skinned.
                    bone_indices: Vec::new(),
                    bone_weights: Vec::new(),
                },
            };
            let _ = on_event.send(LevelEvent::UfragMesh { mesh: dto });
            ufrag_done += 1;
            let _ = on_event.send(LevelEvent::Progress { current: ufrag_done });
            chunk_yield(ufrag_done);
        }
    }

    // ── Phase 6: textures — only the ones referenced by visible meshes.
    if needed_albedo.is_empty() {
        let _ = on_event.send(LevelEvent::Phase {
            phase: "textures",
            label: "Decoding textures",
            total: 0,
            chunk_size: CHUNK_SIZE,
        });
    } else {
        let mut tex_done = 0usize;
        let needed = needed_albedo.clone();
        read_textures_with_total(
            path,
            move |id| needed.contains(&id),
            |total| {
                let _ = on_event.send(LevelEvent::Phase {
                    phase: "textures",
                    label: "Decoding textures",
                    total,
                    chunk_size: CHUNK_SIZE,
                });
            },
            |t| {
                if !t.is_decoded() {
                    return;
                }
                // Downsample to 512px max — full-res PS3 textures balloon the
                // JSON payload over the IPC channel and freeze the JS thread
                // while parsing. 512² is plenty for an editor preview.
                let (rgba, w, h) = downsample_rgba(t.rgba, t.width, t.height, 512);
                if rgba.is_empty() {
                    return;
                }
                let png = encode_png(&rgba, w, h);
                if png.is_empty() {
                    return;
                }
                let _ = on_event.send(LevelEvent::Texture {
                    texture: TextureDto {
                        id: t.id,
                        width: w,
                        height: h,
                        png,
                    },
                });
                tex_done += 1;
                let _ = on_event.send(LevelEvent::Progress { current: tex_done });
                chunk_yield(tex_done);
            },
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/* ────────────────────────────────────────────────────────────────────────
 * Character / asset library — loads all mobys from a `character/` subfolder
 * if it exists. Shared with the level-meshes streaming code.
 *
 * Different from `level_meshes_stream` in that it doesn't filter by placed
 * instances — characters / weapons / enemies aren't placed in the main
 * level via gameplay.dat, they're standalone assets the engine spawns at
 * runtime. We surface them in the Hierarchy as a "Library" section.
 * ──────────────────────────────────────────────────────────────────────── */

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LibraryEvent {
    /// Folder isn't present — caller should treat as no library.
    Missing,
    /// Found the library at this path — surfaced for the user's Console.
    Located { path: String },
    /// Total moby count for this library — emitted once at the start.
    Total { total: usize },
    /// One decoded asset.
    Asset { asset: AssetMeshesDto },
    /// One PNG-encoded texture used by some asset in the library.
    Texture { texture: TextureDto },
    Done,
    Error { message: String },
}

/// Build the candidate list of character-library locations relative to a
/// level folder. PSARC extraction layouts in the wild:
///   - `<level>/entities/character/`      — most common, entities under level
///   - `<level>/character/`               — characters bundled in the level
///   - `<root>/entities/character/`       — entities is a sibling of the level
///                                          (R2/R3 PS3_GAME/USRDIR/packed/...)
///   - `<root>/../entities/character/`    — deeply-nested extracts (some users
///                                          have 13+ folders to the level)
///
/// Walks up to 15 ancestors so very-deep PS3 disc dumps work without manual
/// intervention. Each candidate is logged for debugging.
fn character_library_candidates(level_path: &Path) -> Vec<std::path::PathBuf> {
    let mut candidates = vec![
        level_path.join("entities").join("character"),
        level_path.join("character"),
    ];
    let mut cur = level_path.parent().map(|p| p.to_path_buf());
    for _ in 0..15 {
        let Some(p) = cur.clone() else { break };
        candidates.push(p.join("entities").join("character"));
        candidates.push(p.join("character"));
        cur = p.parent().map(|x| x.to_path_buf());
    }
    candidates
}

/// Locate the character library for the **IGHW (.dat) loader**. Requires
/// an `assetlookup.dat` — that's the marker file the IGHW parser reads
/// to enumerate mobys. Returns the first candidate that has one.
fn find_character_library(level_path: &Path) -> Option<std::path::PathBuf> {
    character_library_candidates(level_path)
        .into_iter()
        .find(|c| c.is_dir() && c.join("assetlookup.dat").exists())
}

/// Locate the character library for the **GLTF loader**. Just checks if
/// the directory exists — doesn't require any specific marker file,
/// because folders produced by InsomniaToolset's `extract_assets` contain
/// .gltf/.glb files but no assetlookup.dat.
///
/// Logs every candidate considered so the dev terminal makes it obvious
/// which paths we tried and which one (if any) matched.
fn find_gltf_library_dir(level_path: &Path) -> Option<std::path::PathBuf> {
    let candidates = character_library_candidates(level_path);
    eprintln!(
        "find_gltf_library_dir: trying {} candidates from level={}",
        candidates.len(),
        level_path.display()
    );
    for (i, c) in candidates.iter().enumerate() {
        let exists = c.is_dir();
        eprintln!(
            "  [{}] {} — {}",
            i,
            c.display(),
            if exists { "MATCH" } else { "miss" }
        );
        if exists {
            return Some(c.clone());
        }
    }
    None
}

#[tauri::command]
fn level_character_library_stream(
    folder: String,
    on_event: Channel<LibraryEvent>,
) -> Result<(), String> {
    let level_path = Path::new(&folder);
    let Some(char_path) = find_character_library(level_path) else {
        let _ = on_event.send(LibraryEvent::Missing);
        let _ = on_event.send(LibraryEvent::Done);
        return Ok(());
    };
    let _ = on_event.send(LibraryEvent::Located {
        path: char_path.display().to_string(),
    });
    if let Err(message) = run_library_stream(&char_path, &on_event) {
        let _ = on_event.send(LibraryEvent::Error { message: message.clone() });
        return Err(message);
    }
    let _ = on_event.send(LibraryEvent::Done);
    Ok(())
}

fn run_library_stream(
    folder: &Path,
    on_event: &Channel<LibraryEvent>,
) -> Result<(), String> {
    // Resolve shaders so material → albedo / normal / emissive lookups
    // work for the library.
    let shaders: HashMap<u64, ShaderInfo> =
        read_shaders(folder).map_err(|e| e.to_string())?;
    let resolve_textures = |shader_tuids: &[u64], shader_index: usize|
        -> (Option<u32>, Option<u32>, Option<u32>)
    {
        let Some(&st) = shader_tuids.get(shader_index) else {
            return (None, None, None);
        };
        let Some(s) = shaders.get(&st) else {
            return (None, None, None);
        };
        (s.albedo_tex_id, s.normal_tex_id, s.expensive_tex_id)
    };

    let mut needed_albedo: HashSet<u32> = HashSet::new();

    // Decode every moby in the library (no placement filter, hence `None`).
    let mut done = 0usize;
    read_moby_assets_with_total(
        folder,
        None,
        |total| {
            let _ = on_event.send(LibraryEvent::Total { total });
        },
        |asset| {
            let mut submeshes = Vec::new();
            for bangle in asset.bangles {
                for m in bangle.meshes {
                    let (albedo, normal, emissive) =
                        resolve_textures(&asset.shader_tuids, m.shader_index as usize);
                    for id in [albedo, normal, emissive].into_iter().flatten() {
                        needed_albedo.insert(id);
                    }
                    submeshes.push(MeshDto {
                        positions: m.positions,
                        uvs: m.uvs,
                        indices: m.indices,
                        albedo_id: albedo,
                        normal_id: normal,
                        emissive_id: emissive,
                        bone_indices: m.bone_indices,
                        bone_weights: m.bone_weights,
                    });
                }
            }
            // Library mobys (characters / weapons / enemies) are exactly
            // the ones we expect to have skeletons, so emit theirs.
            let skeleton = build_skeleton_dto(&asset.skeleton);
            let dto = AssetMeshesDto {
                asset_tuid: format!("0x{:016X}", asset.tuid),
                submeshes,
                skeleton,
                animset_hash: asset.animset_hash.map(|h| format!("0x{:016X}", h)),
                bind_pose_inverse_offset: asset.bind_pose_inverse_offset,
            };
            let _ = on_event.send(LibraryEvent::Asset { asset: dto });
            done += 1;
            chunk_yield(done);
        },
    )
    .map_err(|e| e.to_string())?;

    // Decode + PNG-encode only the textures the library's mobys actually use.
    if needed_albedo.is_empty() {
        return Ok(());
    }
    let needed = needed_albedo.clone();
    let mut tex_done = 0usize;
    read_textures_with_total(
        folder,
        move |id| needed.contains(&id),
        |_total| {},
        |t| {
            if !t.is_decoded() {
                return;
            }
            let (rgba, w, h) = downsample_rgba(t.rgba, t.width, t.height, 512);
            if rgba.is_empty() {
                return;
            }
            let png = encode_png(&rgba, w, h);
            if png.is_empty() {
                return;
            }
            let _ = on_event.send(LibraryEvent::Texture {
                texture: TextureDto {
                    id: t.id,
                    width: w,
                    height: h,
                    png,
                },
            });
            tex_done += 1;
            chunk_yield(tex_done);
        },
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/* ────────────────────────────────────────────────────────────────────────
 * PSARC tools — list / extract a PlayStation Archive (PS3 .psarc files).
 * Backed by the new `psarc` crate. ZLIB only for now.
 * ──────────────────────────────────────────────────────────────────────── */

#[derive(Serialize)]
struct PsarcEntryDto {
    name: String,
    uncompressed_size: u64,
    file_offset: u64,
}

#[derive(Serialize)]
struct PsarcListDto {
    major: u16,
    minor: u16,
    compression: &'static str,
    block_size: u32,
    entry_count: usize,
    entries: Vec<PsarcEntryDto>,
}

#[tauri::command]
fn psarc_list(path: String) -> Result<PsarcListDto, String> {
    let archive = psarc::Archive::open(Path::new(&path)).map_err(|e| e.to_string())?;
    let compression = match archive.header.compression {
        psarc::Compression::Zlib => "zlib",
        psarc::Compression::Lzma => "lzma",
        psarc::Compression::Oodle => "oodle",
    };
    let entries = archive
        .entries
        .iter()
        .map(|e| PsarcEntryDto {
            name: e.name.clone(),
            uncompressed_size: e.uncompressed_size,
            file_offset: e.file_offset,
        })
        .collect();
    Ok(PsarcListDto {
        major: archive.header.major,
        minor: archive.header.minor,
        compression,
        block_size: archive.header.block_size,
        entry_count: archive.entries.len(),
        entries,
    })
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PsarcEvent {
    /// Total file count for the extract — emitted once at the start.
    Total { total: usize },
    /// One file extracted to disk.
    File {
        index: usize,
        name: String,
        bytes: u64,
    },
    Done,
    Error { message: String },
}

#[tauri::command]
fn psarc_extract_stream(
    input: String,
    output: String,
    on_event: Channel<PsarcEvent>,
) -> Result<(), String> {
    if let Err(message) = run_psarc_extract(&input, &output, &on_event) {
        let _ = on_event.send(PsarcEvent::Error { message: message.clone() });
        return Err(message);
    }
    let _ = on_event.send(PsarcEvent::Done);
    Ok(())
}

fn run_psarc_extract(
    input: &str,
    output: &str,
    on_event: &Channel<PsarcEvent>,
) -> Result<(), String> {
    let mut archive = psarc::Archive::open(Path::new(input)).map_err(|e| e.to_string())?;
    let out_root = Path::new(output);
    std::fs::create_dir_all(out_root).map_err(|e| format!("create out dir: {e}"))?;

    let total = archive.entries.len();
    let _ = on_event.send(PsarcEvent::Total { total });

    // Clone entry list so we can iterate while mutably borrowing archive.
    let entries: Vec<_> = archive.entries.clone();

    for (i, entry) in entries.iter().enumerate() {
        let bytes = archive.read_entry(entry).map_err(|e| e.to_string())?;

        // Sanitize: normalize separators, strip leading slashes, reject any
        // `..` segments. Together these prevent the archive from writing
        // outside of `out_root` via crafted entry names — important since
        // `entry.name` comes from arbitrary user-supplied PSARCs.
        let mut rel = entry.name.replace('\\', "/");
        while rel.starts_with('/') {
            rel.remove(0);
        }
        if rel.split('/').any(|seg| seg == "..") {
            return Err(format!(
                "path traversal attempt blocked for entry: {}",
                entry.name
            ));
        }

        // Build dest with Path::join — handles `/` correctly on all OSes.
        let dest = out_root.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }

        // On Windows, long PSARC trees (>260 chars total) need the `\\?\`
        // prefix to bypass MAX_PATH. The std `fs::write` won't add this for
        // us, so we apply it on Windows only.
        write_bytes_to_path(&dest, &bytes)
            .map_err(|e| format!("write {dest:?}: {e}"))?;

        let _ = on_event.send(PsarcEvent::File {
            index: i + 1,
            name: entry.name.clone(),
            bytes: bytes.len() as u64,
        });
        // Yield so the JS event loop processes the event before the next file.
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    Ok(())
}

/// Write bytes to a path, adding the Windows long-path prefix `\\?\` when
/// needed (over ~250 chars or when nested deep inside a long output dir).
/// On non-Windows platforms this is just `std::fs::write`.
fn write_bytes_to_path(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        // Heuristic: prefix all writes with `\\?\` so we don't have to
        // think about the 260-char threshold per file. Path::canonicalize
        // would be more correct but it's slower and requires the path to
        // exist; we want the prefix BEFORE creating the file.
        if !s.starts_with(r"\\?\") && !s.starts_with(r"\\.\") {
            // Ensure absolute — `\\?\` only works on absolute paths.
            let abs: std::path::PathBuf = if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()?.join(path)
            };
            let prefixed = format!(r"\\?\{}", abs.display());
            return std::fs::write(prefixed, bytes);
        }
    }
    std::fs::write(path, bytes)
}

/// Write arbitrary bytes to a path the user has chosen via the OS save
/// dialog. Used by the GLB exporter — we hand the file picker bytes from
/// the JS-side three.js GLTFExporter, then this command commits them to
/// disk. Tighter scope than enabling tauri-plugin-fs's full write surface.
#[tauri::command]
fn write_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"))
}

/// One file inside a GLTF character library folder.
#[derive(Serialize)]
struct GltfFileDto {
    /// Just the file name (e.g. `chimera_grunt.glb`).
    name: String,
    /// Absolute path on disk — caller passes back to `read_file_bytes`
    /// to actually load the model.
    path: String,
    /// `gltf` or `glb` (lowercase, no dot).
    extension: String,
    size_bytes: u64,
    /// Top-level subfolder under `entities/` (e.g. `character`, `object`,
    /// `unique`). Used by the Hierarchy to group files into sections, the
    /// same way mobys/ties are grouped. Empty string when the file lives
    /// directly under the scan root.
    category: String,
}

#[derive(Serialize)]
struct GltfLibraryDto {
    /// Where we found it. Empty when no library was located.
    folder: String,
    files: Vec<GltfFileDto>,
}

/// List all .gltf/.glb files in `<level>/../entities/character/` (or other
/// candidate locations). Used by the new GLTF character browser — these
/// files are produced by InsomniaToolset's `extract_assets` command and
/// already contain skeleton + animations baked in, so we don't need to
/// implement any of that ourselves.
#[tauri::command]
fn list_character_gltfs(folder: String) -> Result<GltfLibraryDto, String> {
    let level_path = Path::new(&folder);
    // Use the GLTF-specific finder — does NOT require assetlookup.dat.
    // InsomniaToolset's extract_assets output is a typed-folder layout
    // (entities/, shaders/, textures/, ...) with no asset-lookup marker.
    let Some(char_path) = find_gltf_library_dir(level_path) else {
        eprintln!(
            "list_character_gltfs: no character/ directory found near {}",
            level_path.display()
        );
        return Ok(GltfLibraryDto {
            folder: String::new(),
            files: Vec::new(),
        });
    };

    eprintln!(
        "list_character_gltfs: scanning {}",
        char_path.display()
    );
    let mut files: Vec<GltfFileDto> = Vec::new();
    walk_gltf(&char_path, "character", &mut files).map_err(|e| e.to_string())?;
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    eprintln!(
        "list_character_gltfs: found {} files at {}",
        files.len(),
        char_path.display()
    );

    Ok(GltfLibraryDto {
        folder: char_path.display().to_string(),
        files,
    })
}

fn walk_gltf(dir: &Path, category: &str, out: &mut Vec<GltfFileDto>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ftype = entry.file_type()?;
        if ftype.is_dir() {
            walk_gltf(&path, category, out)?;
        } else if ftype.is_file() {
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            if matches!(ext.as_deref(), Some("gltf") | Some("glb")) {
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(GltfFileDto {
                    name,
                    path: path.display().to_string(),
                    extension: ext.unwrap_or_default(),
                    size_bytes: size,
                    category: category.to_string(),
                });
            }
        }
    }
    Ok(())
}

/// Locate an `entities/` directory near the level. Same walk-up strategy
/// as `character_library_candidates`, but stops one level earlier so we
/// can scan ALL of entities/* (character, object, unique, …) at once
/// instead of just `entities/character/`.
fn find_entities_dir(level_path: &Path) -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = vec![level_path.join("entities")];
    let mut cur = level_path.parent().map(|p| p.to_path_buf());
    for _ in 0..15 {
        let Some(p) = cur.clone() else { break };
        candidates.push(p.join("entities"));
        cur = p.parent().map(|x| x.to_path_buf());
    }
    eprintln!(
        "find_entities_dir: trying {} candidates from level={}",
        candidates.len(),
        level_path.display()
    );
    for (i, c) in candidates.iter().enumerate() {
        let exists = c.is_dir();
        eprintln!(
            "  [{}] {} — {}",
            i,
            c.display(),
            if exists { "MATCH" } else { "miss" }
        );
        if exists {
            return Some(c.clone());
        }
    }
    None
}

/// Scan ALL of `<level>/.../entities/*` for .gltf/.glb files, tagging each
/// with the first-level subfolder name (`character`, `object`, `unique`,
/// …). The Hierarchy uses `category` to render one collapsible section
/// per subfolder — same affordance as Mobys/Ties for placed instances.
#[tauri::command]
fn list_entities_gltfs(folder: String) -> Result<GltfLibraryDto, String> {
    let level_path = Path::new(&folder);
    let Some(entities_root) = find_entities_dir(level_path) else {
        eprintln!(
            "list_entities_gltfs: no entities/ directory found near {}",
            level_path.display()
        );
        return Ok(GltfLibraryDto {
            folder: String::new(),
            files: Vec::new(),
        });
    };

    eprintln!(
        "list_entities_gltfs: scanning {}",
        entities_root.display()
    );

    let mut files: Vec<GltfFileDto> = Vec::new();
    let entries = std::fs::read_dir(&entities_root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ftype = entry.file_type().map_err(|e| e.to_string())?;
        if ftype.is_dir() {
            let category = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("other")
                .to_string();
            walk_gltf(&path, &category, &mut files).map_err(|e| e.to_string())?;
        } else if ftype.is_file() {
            // Stray .gltf/.glb directly in entities/ — bucket as "other".
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            if matches!(ext.as_deref(), Some("gltf") | Some("glb")) {
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                files.push(GltfFileDto {
                    name,
                    path: path.display().to_string(),
                    extension: ext.unwrap_or_default(),
                    size_bytes: size,
                    category: "other".to_string(),
                });
            }
        }
    }

    files.sort_by(|a, b| {
        a.category
            .to_lowercase()
            .cmp(&b.category.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    eprintln!(
        "list_entities_gltfs: found {} files at {}",
        files.len(),
        entities_root.display()
    );

    Ok(GltfLibraryDto {
        folder: entities_root.display().to_string(),
        files,
    })
}

/// Read raw bytes from a path. The frontend uses this to fetch GLTF/GLB
/// contents into memory and feed them to three.js's GLTFLoader.parse().
/// Scope: any file the user can access — paired with the explicit picker
/// flow so the user has agency over what gets read.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))
}

/// One bone's animated TRS keyframes. Matches `lunalib::DecodedBone`
/// but with a JSON-friendly Vec layout the frontend can flatten into
/// `THREE.QuaternionKeyframeTrack` / `VectorKeyframeTrack` directly.
#[derive(Serialize)]
struct DecodedBoneDto {
    /// Quaternion keyframes — flat `[x,y,z,w, x,y,z,w, …]`. Length is
    /// `num_frames * 4` for animated bones, exactly `4` for static.
    rotations: Vec<f32>,
    /// Translation keyframes — flat `[x,y,z, …]`. Empty when this bone
    /// has no position track (consumer falls back to bind-pose).
    translations: Vec<f32>,
    scales: Vec<f32>,
    rotation_animated: bool,
    translation_animated: bool,
    scale_animated: bool,
}

/// One decoded animation clip. Returned by `fetch_animset_clip`.
#[derive(Serialize)]
struct DecodedClipDto {
    name: String,
    num_frames: u16,
    frame_rate: f32,
    looping: bool,
    /// One entry per bone in the *animation's* `numBones`. The frontend
    /// must align this against the moby's skeleton bone-count — usually
    /// they match, but face-only viseme clips can drive bones beyond
    /// the head sub-skeleton.
    bones: Vec<DecodedBoneDto>,
}

/// Fetch + fully decode the animation clip referenced by a moby's
/// `animset_hash`. Used by the frontend animation browser + the export
/// path. Scoped to one clip per call because most animsets in
/// Resistance 2 hold a single named clip (idle/walk/run are stored as
/// SEPARATE animset entries, each with its own hash).
///
/// Inputs:
/// - `level_folder` — same level path used for `open_level`
/// - `animset_hash_hex` — `"0x"`-prefixed 16-hex u64 from `AssetMeshesDto.animset_hash`
/// - `position_scale` — typically `2 ^ MobyAsset.bind_pose_inverse_offset`,
///   or `1.0` if you want raw quantized units (the frontend can apply a
///   per-instance scale separately)
/// - `scale_scale` — typically `2 ^ skeleton.scale_shift`
#[tauri::command]
fn fetch_animset_clip(
    level_folder: String,
    animset_hash_hex: String,
    position_scale: f32,
    scale_scale: f32,
) -> Result<DecodedClipDto, String> {
    let target = parse_hex_u64(&animset_hash_hex)?;

    // 1. Look up the animset in assetlookup.dat's 0x1D700 table.
    let mut lookup = open_lookup(&level_folder)?;
    let ptrs = lookup
        .pointers(AssetKind::Animset)
        .map_err(|e| format!("read animset table: {e}"))?;
    let ptr = ptrs
        .iter()
        .find(|p| p.tuid == target)
        .ok_or_else(|| format!("animset 0x{:016X} not in 0x1D700 table", target))?;

    // 2. Slice the IGHW chunk out of animsets.dat.
    let path = Path::new(&level_folder).join("animsets.dat");
    let mut file =
        File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(u64::from(ptr.offset)))
        .map_err(|e| format!("seek animsets.dat: {e}"))?;
    let mut buf = vec![0u8; ptr.length as usize];
    file.read_exact(&mut buf)
        .map_err(|e| format!("read animsets.dat: {e}"))?;

    // 3. Parse + decode.
    let mut ig = IgFile::open(std::io::Cursor::new(buf))
        .map_err(|e| format!("animset IGHW: {e}"))?;
    let header = read_animation_header(&mut ig)
        .map_err(|e| format!("animation header: {e}"))?
        .ok_or_else(|| {
            "animset chunk has no 0xF000 Animation section".to_string()
        })?;
    let ctrl = read_animation_control(&mut ig, &header)
        .map_err(|e| format!("animation control: {e}"))?;
    let clip = decode_animation(&mut ig, &header, &ctrl, position_scale, scale_scale)
        .map_err(|e| format!("animation decode: {e}"))?;

    // 4. Convert to JSON-friendly DTO.
    Ok(DecodedClipDto {
        name: clip.name,
        num_frames: clip.num_frames,
        frame_rate: clip.frame_rate,
        looping: clip.looping,
        bones: clip
            .bones
            .into_iter()
            .map(|b| DecodedBoneDto {
                rotations: b.rotations,
                translations: b.translations,
                scales: b.scales,
                rotation_animated: b.rotation_animated,
                translation_animated: b.translation_animated,
                scale_animated: b.scale_animated,
            })
            .collect(),
    })
}

/// Parse a `"0x..."` or bare hex u64 string. Helper for Tauri commands
/// that take TUIDs / hashes from the frontend (which serializes them
/// as hex strings to avoid JS Number precision loss above 2^53).
fn parse_hex_u64(s: &str) -> Result<u64, String> {
    let trimmed = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    u64::from_str_radix(trimmed, 16).map_err(|e| format!("invalid hex u64 {s:?}: {e}"))
}

/// Scan an arbitrary folder (recursively) for .gltf/.glb files. Used by
/// the manual "Browse GLTF folder…" Tools menu entry — lets the user
/// point at any path produced by InsomniaToolset's `extract_assets`
/// regardless of the surrounding folder layout. Different from
/// `list_character_gltfs` which auto-searches near the level folder.
#[tauri::command]
fn list_gltfs_in_folder(path: String) -> Result<GltfLibraryDto, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    // Manual browse: tag every file with the immediate parent folder name
    // so the Hierarchy still groups things meaningfully (e.g. picking the
    // user's `entities/` directly produces character/object/unique groups).
    let mut files: Vec<GltfFileDto> = Vec::new();
    let entries = std::fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let ftype = entry.file_type().map_err(|e| e.to_string())?;
        if ftype.is_dir() {
            let category = entry_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("other")
                .to_string();
            walk_gltf(&entry_path, &category, &mut files).map_err(|e| e.to_string())?;
        } else if ftype.is_file() {
            let ext = entry_path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            if matches!(ext.as_deref(), Some("gltf") | Some("glb")) {
                let name = entry_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                files.push(GltfFileDto {
                    name,
                    path: entry_path.display().to_string(),
                    extension: ext.unwrap_or_default(),
                    size_bytes: size,
                    category: "other".to_string(),
                });
            }
        }
    }
    files.sort_by(|a, b| {
        a.category
            .to_lowercase()
            .cmp(&b.category.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    eprintln!(
        "list_gltfs_in_folder: found {} files at {}",
        files.len(),
        path
    );
    Ok(GltfLibraryDto {
        folder: path,
        files,
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_level,
            list_assets,
            level_layout,
            level_meshes_stream,
            level_character_library_stream,
            list_character_gltfs,
            list_entities_gltfs,
            list_gltfs_in_folder,
            read_file_bytes,
            fetch_animset_clip,
            psarc_list,
            psarc_extract_stream,
            write_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
