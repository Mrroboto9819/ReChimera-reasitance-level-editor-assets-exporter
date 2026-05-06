#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use std::collections::{HashMap, HashSet};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lunalib::math::zyx_euler_to_quat;
use lunalib::{
    bulk_extract_pngs, decode_animation, downsample_rgba, encode_png, extract_bank_sounds,
    list_sounds as list_sounds_in, read_animation_control, read_animation_header, read_gameplay,
    read_moby_assets_with_total, read_shaders, read_textures_with_total,
    read_tie_assets_with_total, read_zones, read_zones_streaming, AssetKind, AssetLookup, IgFile,
    ShaderInfo, SoundKind,
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

/// Self-contained mesh: positions + uvs + triangle indices. Large numeric
/// arrays are sent as base64-encoded little-endian binary buffers instead of
/// JSON number arrays. That keeps Tauri IPC parsing from freezing the WebView
/// before the loading progress can repaint.
///
/// Each `*_id` is the lower 32 bits of a highmip TUID; the frontend looks
/// it up in the same texture cache (filled by `LevelEvent::Texture`) for
/// all three slots. `None` means the shader/asset doesn't reference one.
#[derive(Serialize)]
struct MeshDto {
    positions_b64: String,
    uvs_b64: String,
    indices_b64: String,
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
    bone_indices_b64: String,
    /// Per-vertex weights as u8 (0..255). Same length as `bone_indices`.
    /// Frontend normalizes to 0..1 for `THREE.SkinnedMesh.skinWeight`.
    bone_weights_b64: String,
}

/// Texture metadata — id + dimensions only. PNG bytes are no longer
/// inlined here; the frontend fetches them via `get_level_textures_bulk`
/// (binary IPC) once the streaming `done` event fires. Keeping bytes
/// out of the streaming JSON cut the per-event JSON payload by ~33%
/// (base64 overhead) plus the JSON-parse cost of every PNG byte.
#[derive(Serialize)]
struct TextureDto {
    id: u32,
    width: u32,
    height: u32,
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
    /// Path-style name from section 0xD200 (e.g.
    /// `"entities/character/weapon/sawgun"`). Empty for mobys whose
    /// chunk has no name section. Drives the Hierarchy's path-grouped
    /// Asset Library tree.
    name: String,
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

fn encode_f32_buffer(values: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<f32>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    BASE64.encode(bytes)
}

fn encode_u32_buffer(values: &[u32]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<u32>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    BASE64.encode(bytes)
}

fn encode_u16_buffer(values: &[u16]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<u16>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    BASE64.encode(bytes)
}

fn encode_u8_buffer(values: &[u8]) -> String {
    BASE64.encode(values)
}

/// Mirror of `downsample_rgba`'s output dimensions, without doing the
/// resize itself. The streaming texture pipeline emits these dims in
/// the metadata event so the frontend knows the final aspect ratio
/// without waiting for the bytes; the actual resize + PNG encode runs
/// later in `get_level_textures_bulk`.
fn downsample_dims(width: u32, height: u32, max_dim: u32) -> (u32, u32) {
    if width <= max_dim && height <= max_dim {
        return (width, height);
    }
    let (new_w, new_h) = if width >= height {
        (max_dim, ((height as u64 * max_dim as u64) / width as u64) as u32)
    } else {
        (((width as u64 * max_dim as u64) / height as u64) as u32, max_dim)
    };
    (new_w.max(1), new_h.max(1))
}

fn mesh_dto(
    positions: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
    albedo_id: Option<u32>,
    normal_id: Option<u32>,
    emissive_id: Option<u32>,
    bone_indices: Vec<u16>,
    bone_weights: Vec<u8>,
) -> MeshDto {
    MeshDto {
        positions_b64: encode_f32_buffer(&positions),
        uvs_b64: encode_f32_buffer(&uvs),
        indices_b64: encode_u32_buffer(&indices),
        albedo_id,
        normal_id,
        emissive_id,
        bone_indices_b64: encode_u16_buffer(&bone_indices),
        bone_weights_b64: encode_u8_buffer(&bone_weights),
    }
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

/// Items per progress chunk. Mesh buffers are sent as compact base64 binary,
/// so we can hand manageable groups to the WebView and viewport.
const CHUNK_SIZE: usize = 4;
/// Yield roughly one frame between chunks so the WebView can decode the
/// queued messages, commit React state, and let the viewport build geometry.
const CHUNK_PAUSE_MS: u64 = 16;
/// frontend can build BUILD_BATCH=2 mobys × 3 renders per chunk window.
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
                        submeshes.push(mesh_dto(
                            m.positions,
                            m.uvs,
                            m.indices,
                            albedo,
                            normal,
                            emissive,
                            m.bone_indices,
                            m.bone_weights,
                        ));
                    }
                }
                let skeleton = build_skeleton_dto(&asset.skeleton);
                let dto = AssetMeshesDto {
                    asset_tuid: format!("0x{:016X}", asset.tuid),
                    name: asset.name.clone(),
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
                        mesh_dto(
                            m.positions,
                            m.uvs,
                            m.indices,
                            albedo,
                            normal,
                            emissive,
                            // Ties are static — no per-vertex skinning.
                            Vec::new(),
                            Vec::new(),
                        )
                    })
                    .collect();
                // Ties are static — no skeleton, no animset.
                // TieAsset doesn't currently have a name section parsed —
                // ties don't carry path-style names like mobys do, so we
                // ship empty here and the frontend falls back to a
                // truncated TUID for the Asset Library leaf label.
                let dto = AssetMeshesDto {
                    asset_tuid: format!("0x{:016X}", asset.tuid),
                    name: String::new(),
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
                mesh: mesh_dto(
                    u.positions,
                    u.uvs,
                    u.indices,
                    albedo,
                    normal,
                    emissive,
                    // Terrain ufrags aren't skinned.
                    Vec::new(),
                    Vec::new(),
                ),
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
                // Compute the dimensions we'll downsample to, but skip
                // the actual PNG encode here — that's the expensive
                // step (RGBA pack + deflate) and we no longer ship
                // bytes through the streaming channel. Frontend fetches
                // bytes via `get_level_textures_bulk` after `done`.
                let (w, h) = downsample_dims(t.width, t.height, 512);
                let _ = on_event.send(LevelEvent::Texture {
                    texture: TextureDto {
                        id: t.id,
                        width: w,
                        height: h,
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
                    submeshes.push(mesh_dto(
                        m.positions,
                        m.uvs,
                        m.indices,
                        albedo,
                        normal,
                        emissive,
                        m.bone_indices,
                        m.bone_weights,
                    ));
                }
            }
            // Library mobys (characters / weapons / enemies) are exactly
            // the ones we expect to have skeletons, so emit theirs.
            let skeleton = build_skeleton_dto(&asset.skeleton);
            let dto = AssetMeshesDto {
                asset_tuid: format!("0x{:016X}", asset.tuid),
                name: asset.name.clone(),
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
            // Same as the level path: skip the encode here, ship only
            // metadata. Frontend fetches bytes via the bulk binary IPC
            // command once it has the full id list.
            let (w, h) = downsample_dims(t.width, t.height, 512);
            let _ = on_event.send(LibraryEvent::Texture {
                texture: TextureDto {
                    id: t.id,
                    width: w,
                    height: h,
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
            // CRITICAL: paths under the `\\?\` prefix are LITERAL — Windows
            // skips normalization, so forward slashes are NOT auto-converted
            // to backslashes and the API returns ERROR_INVALID_NAME (123).
            // PSARC entry names are Unix-style ("levels/iceland_invasion/
            // level_cached.toc"), so a join with the user's Windows output
            // dir produces a mixed-slash path. Normalize everything to `\`
            // before applying the prefix.
            let normalized = abs.display().to_string().replace('/', "\\");
            let prefixed = format!(r"\\?\{}", normalized);
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

/// Per-material texture lookup result. The frontend passes a list of
/// material names (parsed from a GLB's `materials[*].name`) and gets
/// back the absolute paths of matching `_c.dds` / `_n.dds` / `_e.dds`
/// files in the level's `textures/` tree.
///
/// IT (InsomniaToolset's `extract_assets`) writes character textures as
/// external `.dds` files instead of embedding them in the `.glb`, so the
/// preview modal sees grey untextured meshes by default. This command
/// re-attaches them by name.
#[derive(Serialize)]
struct GlbMaterialTexturesDto {
    /// Same name the frontend sent in (e.g. `"coopmedicnew/coopmedicnew"`).
    material_name: String,
    /// Absolute path to the `_c.dds` (color/albedo) file, if present.
    albedo_path: Option<String>,
    /// Absolute path to the `_n.dds` (tangent-space normal map), if present.
    normal_path: Option<String>,
    /// Absolute path to the `_e.dds` (emissive / "expensive" pack), if
    /// present.
    emissive_path: Option<String>,
}

/// Search `<level>/textures/` recursively for DDS files matching each
/// requested material name. Material names are matched by their last
/// path segment (e.g. `coopmedicnew/coopmedicnew` → look for files
/// starting with `coopmedicnew_`).
///
/// Returns one entry per input name, with whichever channel files were
/// found set to their absolute paths. Channels not on disk stay `None`
/// — the frontend leaves those material slots null, so the mesh just
/// renders without that channel.
#[tauri::command]
fn find_glb_textures(
    level_folder: String,
    material_names: Vec<String>,
) -> Result<Vec<GlbMaterialTexturesDto>, String> {
    let textures_root = Path::new(&level_folder).join("textures");
    if !textures_root.is_dir() {
        // No `textures/` folder near this level — return empty entries
        // so the frontend can carry on rendering grey materials.
        eprintln!(
            "find_glb_textures: no textures/ at {}",
            textures_root.display()
        );
        return Ok(material_names
            .into_iter()
            .map(|n| GlbMaterialTexturesDto {
                material_name: n,
                albedo_path: None,
                normal_path: None,
                emissive_path: None,
            })
            .collect());
    }

    // Single full walk of `textures/` — much cheaper than per-name walks
    // when the user has many materials. Build a map keyed on the file
    // stem (e.g. `coopmedicnew_c` → full path).
    let mut by_stem: HashMap<String, std::path::PathBuf> = HashMap::new();
    walk_dds_files(&textures_root, &mut by_stem).map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(material_names.len());
    for name in material_names {
        // Material names look like `coopmedicnew/coopmedicnew`. Take the
        // basename (last segment after `/` or `\`).
        let base = name
            .rsplit(|c: char| c == '/' || c == '\\')
            .next()
            .unwrap_or(&name)
            .to_string();
        let albedo_path = by_stem
            .get(&format!("{}_c", base))
            .map(|p| p.display().to_string());
        let normal_path = by_stem
            .get(&format!("{}_n", base))
            .map(|p| p.display().to_string());
        let emissive_path = by_stem
            .get(&format!("{}_e", base))
            .map(|p| p.display().to_string());
        out.push(GlbMaterialTexturesDto {
            material_name: name,
            albedo_path,
            normal_path,
            emissive_path,
        });
    }

    Ok(out)
}

/// Walk a textures tree, indexing every `.dds` file by its file stem.
fn walk_dds_files(
    dir: &Path,
    out: &mut HashMap<String, std::path::PathBuf>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ftype = entry.file_type()?;
        if ftype.is_dir() {
            walk_dds_files(&path, out)?;
        } else if ftype.is_file() {
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            if matches!(ext.as_deref(), Some("dds")) {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    // Last write wins — there shouldn't be duplicates,
                    // but if there are this just keeps a deterministic
                    // ordering (whichever read_dir hits last).
                    out.insert(stem.to_string(), path.clone());
                }
            }
        }
    }
    Ok(())
}

/// One animset entry — header-only metadata. Returned by
/// `list_animset_clips` so the frontend can show a dropdown of available
/// clips without paying the full decode cost up front.
#[derive(Serialize)]
struct AnimsetSummaryDto {
    /// `"0x"`-prefixed 16-hex u64 — pass back to `fetch_animset_clip`.
    tuid_hex: String,
    /// Clip name from the Animation header (e.g. "titan_agg-idle"). Empty
    /// when the chunk has no `0xF000` Animation section.
    name: String,
    /// Sometimes 0 if the chunk is metadata-only.
    num_frames: u16,
    frame_rate: f32,
    /// Number of bones the clip drives (≤ moby's bone count usually).
    num_bones: u16,
    looping: bool,
}

/// List every animset in `<level>/animsets.dat` with its header metadata.
/// Drives the GLTF-preview modal's animation-source dropdown — Option B
/// (raw `.dat` instead of IT-bundled clips).
///
/// Skips chunks that fail IGHW open (returns `Err` for them in the log
/// but keeps walking) and chunks without a `0xF000` section (those are
/// metadata-only animsets).
#[tauri::command]
fn list_animset_clips(level_folder: String) -> Result<Vec<AnimsetSummaryDto>, String> {
    let mut lookup = open_lookup(&level_folder)?;
    let ptrs = lookup
        .pointers(AssetKind::Animset)
        .map_err(|e| format!("read animset table: {e}"))?;

    let path = Path::new(&level_folder).join("animsets.dat");
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            // No animsets.dat → empty list, not an error.
            eprintln!("list_animset_clips: no animsets.dat at {} ({e})", path.display());
            return Ok(Vec::new());
        }
    };

    let mut out: Vec<AnimsetSummaryDto> = Vec::new();
    use std::io::{Read, Seek, SeekFrom};
    for ptr in ptrs {
        if let Err(e) = file.seek(SeekFrom::Start(u64::from(ptr.offset))) {
            eprintln!("list_animset_clips: seek failed for 0x{:016X}: {e}", ptr.tuid);
            continue;
        }
        let mut buf = vec![0u8; ptr.length as usize];
        if let Err(e) = file.read_exact(&mut buf) {
            eprintln!("list_animset_clips: read failed for 0x{:016X}: {e}", ptr.tuid);
            continue;
        }
        let mut ig = match IgFile::open(std::io::Cursor::new(buf)) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let h = match read_animation_header(&mut ig) {
            Ok(Some(h)) => h,
            _ => continue, // chunk without an Animation section — skip
        };
        out.push(AnimsetSummaryDto {
            tuid_hex: format!("0x{:016X}", ptr.tuid),
            name: h.name.clone(),
            num_frames: h.num_frames,
            frame_rate: h.frame_rate,
            num_bones: h.num_bones,
            looping: h.is_looping(),
        });
    }
    // Sort by name so the UI shows a stable alphabetical list.
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
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

/// One sound entry — name + index + which file it lives in. Returned
/// by `list_sounds` for UI display.
#[derive(Serialize)]
struct SoundEntryDto {
    name: String,
    /// Sound table index (within the source `.dat`). Pass back to
    /// `extract_sound` to fetch its WAV.
    index: usize,
    /// "bank" = inline SCREAM bank (extractable now). "stream" =
    /// references a sibling streaming file (not yet supported).
    kind: &'static str,
    /// Source file relative to the level folder (e.g. "resident_sound.dat").
    source: String,
}

/// List every named sound across every recognised sound-bank file in
/// the level folder. Cheap — only reads IGHW headers (Sounds + names),
/// not the SCREAM data. Each entry carries its actual source filename
/// so playback / extraction can route to the right file.
///
/// Scanned patterns (per InsomniaToolset's `AppProcessFile`):
///   - `resident_sound.dat`      (V2 SFX bank — R2/R3/RCF main banks)
///   - `resident_dialogue*.dat`  (V2 dialogue banks, per-language variants)
///   - `ps3sound.dat`            (V1 SFX bank — RFOM, some R2 multiplayer)
///   - `ps3dialogue*.dat`        (V1 dialogue banks)
///
/// Per-file errors are logged to stderr (so they show up in the Tauri
/// dev console) but don't abort the scan — a missing or corrupt
/// dialogue bank shouldn't hide the SFX bank that lives next to it.
#[tauri::command]
fn list_level_sounds(level_folder: String) -> Result<Vec<SoundEntryDto>, String> {
    let folder = Path::new(&level_folder);
    let read_dir = match std::fs::read_dir(folder) {
        Ok(d) => d,
        Err(e) => return Err(format!("read_dir {}: {e}", folder.display())),
    };
    // Collect candidate bank filenames first (sorted for stable
    // ordering — the frontend Hierarchy renders entries in this
    // order, and reproducible output makes debugging easier).
    let mut candidates: Vec<String> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        let is_bank = lower == "resident_sound.dat"
            || lower == "ps3sound.dat"
            || lower.starts_with("resident_dialogue")
            || lower.starts_with("ps3dialogue");
        if is_bank && lower.ends_with(".dat") {
            candidates.push(name);
        }
    }
    candidates.sort();

    let mut out: Vec<SoundEntryDto> = Vec::new();
    for filename in &candidates {
        let path = folder.join(filename);
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[list_level_sounds] open {}: {e}", path.display());
                continue;
            }
        };
        let mut ig = match IgFile::open(BufReader::new(file)) {
            Ok(ig) => ig,
            Err(e) => {
                eprintln!("[list_level_sounds] IgFile {}: {e}", path.display());
                continue;
            }
        };
        let summaries = match list_sounds_in(&mut ig) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[list_level_sounds] list_sounds {}: {e}", path.display());
                continue;
            }
        };
        // Stream-kind entries reference a sibling streaming file
        // (e.g. `streaming_dialogue.us.dat` next to `resident_dialogue.us.dat`).
        // If the sibling isn't in this folder, the user clicking on
        // such an entry will hit `extract_level_stream_sounds` →
        // "missing stream sibling" error. Mark them as
        // `stream-missing` instead so the Hierarchy can render them
        // disabled with a clear badge — visibility without false
        // affordance.
        let sibling_exists = lunalib::streaming_sibling_for(filename)
            .map(|s| folder.join(s).is_file())
            .unwrap_or(false);
        for s in summaries {
            let kind = match s.kind {
                SoundKind::Bank => "bank",
                SoundKind::Stream => {
                    if sibling_exists { "stream" } else { "stream-missing" }
                }
            };
            out.push(SoundEntryDto {
                name: s.name,
                index: s.index,
                kind,
                source: filename.clone(),
            });
        }
    }

    // Phase 2 — orphan streaming files. Walk the folder again for
    // stream files (`streaming_sound.dat`, `streaming_dialogue*.dat`,
    // `ps3soundstream*.dat`, `ps3dialoguestream*.dat`) and check
    // whether their expected bank pair was found in Phase 1. If not,
    // the stream is "orphan" — its offset table is missing, so we
    // brute-force-scan it for VAGp/XVAG/VPK headers and surface each
    // hit as a synthetic SoundEntry with `kind = "raw"`.
    let bank_lookup: HashSet<String> =
        candidates.iter().map(|s| s.to_ascii_lowercase()).collect();
    let read_dir2 = std::fs::read_dir(folder)
        .map_err(|e| format!("read_dir {}: {e}", folder.display()))?;
    let mut stream_candidates: Vec<String> = Vec::new();
    for entry in read_dir2.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        let is_stream = lower.starts_with("streaming_sound")
            || lower.starts_with("streaming_dialogue")
            || lower.starts_with("ps3soundstream")
            || lower.starts_with("ps3dialoguestream");
        if is_stream && lower.ends_with(".dat") {
            stream_candidates.push(name);
        }
    }
    stream_candidates.sort();
    for stream_name in &stream_candidates {
        let expected_bank = lunalib::bank_pair_for(stream_name);
        if let Some(bank) = expected_bank {
            if bank_lookup.contains(&bank.to_ascii_lowercase()) {
                continue; // paired — Phase 1 already covered this stream
            }
        }
        let stream_path = folder.join(stream_name);
        let summaries = match lunalib::list_raw_streaming(&stream_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "[list_level_sounds] raw scan {}: {e}",
                    stream_path.display()
                );
                continue;
            }
        };
        for s in summaries {
            out.push(SoundEntryDto {
                name: s.name,
                index: s.index,
                kind: "raw",
                source: stream_name.clone(),
            });
        }
    }

    Ok(out)
}

/// One extracted WAV blob — base64 to keep the IPC layer happy. The
/// frontend decodes via `atob` + Blob → audio element.
#[derive(Serialize)]
struct ExtractedSoundDto {
    name: String,
    sample_rate: u32,
    /// Channel count baked into the WAV. 1 for SCREAM bank sounds and
    /// VAGp streams; can be 2+ for VPK or multi-channel XVAG streams.
    channels: u16,
    sample_count: u32,
    /// Base64-encoded RIFF/WAVE bytes.
    wav_b64: String,
}

/// Extract every SCREAM-bank sound from `resident_sound.dat` to WAV.
/// Returns the full list in one call — bayou's bank is small enough
/// (< 5 MB total post-decode) that this is fine. For larger banks we
/// can swap to per-name fetching, but the current API trades a one-
/// time extract cost for trivial frontend code.
#[tauri::command]
fn extract_level_sounds(level_folder: String) -> Result<Vec<ExtractedSoundDto>, String> {
    let path = Path::new(&level_folder).join("resident_sound.dat");
    if !path.is_file() {
        return Err(format!("missing {}", path.display()));
    }
    let file = File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut ig = IgFile::open(BufReader::new(file)).map_err(|e| e.to_string())?;
    let extracted = extract_bank_sounds(&mut ig).map_err(|e| {
        // Self-diagnose: when extract returns an error (typically
        // an EOF read-past-buffer on a misresolved pointer), dump
        // the bank's structure to stderr so the next debug round
        // doesn't need a manual hexdump.
        let dump = lunalib::dump_sound_bank_info(&mut ig)
            .unwrap_or_else(|de| format!("(dump itself failed: {de})"));
        eprintln!("[extract_level_sounds] {} failed: {e}\n{dump}", path.display());
        e.to_string()
    })?;
    if extracted.is_empty() {
        // Empty result on a >1MB bank is almost always a parser bug.
        // Surface the diagnostic dump so we can iterate from logs.
        let dump = lunalib::dump_sound_bank_info(&mut ig)
            .unwrap_or_else(|e| format!("(dump failed: {e})"));
        eprintln!(
            "[extract_level_sounds] {} returned 0 sounds — dumping structure:\n{dump}",
            path.display()
        );
    }
    Ok(extracted
        .into_iter()
        .map(|s| ExtractedSoundDto {
            name: s.name,
            sample_rate: s.sample_rate,
            channels: s.channels,
            sample_count: s.sample_count,
            wav_b64: BASE64.encode(&s.wav),
        })
        .collect())
}

/// Diagnostic dump for a SCREAM bank file. Walks the IGHW sections,
/// SCREAMBankHeader pointers, SCREAMBank fields, and the first few
/// Sounds/Names/Stream offsets — each printed with both the on-disk
/// u32 and the resolved file-absolute address. Use this whenever an
/// extract command returns "io: failed to fill whole buffer" or an
/// empty list: the dump shows exactly which pointer is bad without
/// any manual hexdumping.
///
/// Returns the dump as a UTF-8 string so the frontend can show it in
/// the bottom Console panel.
#[tauri::command]
fn dump_sound_bank(
    level_folder: String,
    bank_filename: String,
) -> Result<String, String> {
    let path = Path::new(&level_folder).join(&bank_filename);
    if !path.is_file() {
        return Err(format!("missing bank {}", path.display()));
    }
    let file = File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut ig = IgFile::open(BufReader::new(file)).map_err(|e| e.to_string())?;
    lunalib::dump_sound_bank_info(&mut ig).map_err(|e| e.to_string())
}

/// Extract every streaming sound for a given bank file. The bank
/// stores only an offset table; the audio bytes live in a sibling
/// streaming file (e.g. `streaming_sound.dat` next to
/// `resident_sound.dat`). Decode formats: VAGp (LE/BE), VPK,
/// XVAG (PS_ADPCM with interleave=1). MPEG-encoded XVAG entries
/// are skipped with the error captured per-name in `errors_out`.
///
/// `bank_filename` should be one of `resident_sound.dat`,
/// `resident_dialogue*.dat`, `ps3sound.dat`, or `ps3dialogue*.dat`.
/// We pair it with the matching streaming file via
/// `streaming_sibling_for`. Returns an error when the streaming file
/// is missing — the frontend should only show streaming entries when
/// the file exists, but this is a defense in depth.
#[tauri::command]
fn extract_level_stream_sounds(
    level_folder: String,
    bank_filename: String,
) -> Result<Vec<ExtractedSoundDto>, String> {
    let folder = Path::new(&level_folder);
    let bank_path = folder.join(&bank_filename);
    if !bank_path.is_file() {
        return Err(format!("missing bank {}", bank_path.display()));
    }
    let stream_filename = lunalib::streaming_sibling_for(&bank_filename)
        .ok_or_else(|| format!("unrecognized bank filename '{bank_filename}'"))?;
    let stream_path = folder.join(&stream_filename);
    if !stream_path.is_file() {
        return Err(format!("missing stream sibling {}", stream_path.display()));
    }
    let file =
        File::open(&bank_path).map_err(|e| format!("open {}: {e}", bank_path.display()))?;
    let mut ig = IgFile::open(BufReader::new(file)).map_err(|e| e.to_string())?;
    let mut errors: Vec<String> = Vec::new();
    let extracted = lunalib::extract_stream_sounds(&mut ig, &stream_path, &mut errors)
        .map_err(|e| e.to_string())?;
    if !errors.is_empty() {
        // Keep going — partial extracts are still useful — but log
        // the per-name failures to stderr so they show up in the
        // Tauri dev log. The frontend only sees the successful list.
        eprintln!(
            "[extract_level_stream_sounds] {} entries failed:",
            errors.len()
        );
        for e in &errors {
            eprintln!("  · {e}");
        }
    }
    Ok(extracted
        .into_iter()
        .map(|s| ExtractedSoundDto {
            name: s.name,
            sample_rate: s.sample_rate,
            channels: s.channels,
            sample_count: s.sample_count,
            wav_b64: BASE64.encode(&s.wav),
        })
        .collect())
}

/// Extract every raw-scanned audio container from an orphan
/// streaming file (no paired bank). Brute-force-scans for VAGp /
/// XVAG / VPK magic bytes and decodes each hit. Synthetic names of
/// the form `stream_NNNNN_0xOFFSET` so multiple hits at different
/// offsets stay distinguishable.
///
/// Use this when `list_level_sounds` reports entries with
/// `kind = "raw"` — the bank-paired `extract_level_stream_sounds`
/// path won't work for those because there's no offset table to
/// drive it.
#[tauri::command]
fn extract_raw_streaming_sounds(
    level_folder: String,
    stream_filename: String,
) -> Result<Vec<ExtractedSoundDto>, String> {
    let path = Path::new(&level_folder).join(&stream_filename);
    if !path.is_file() {
        return Err(format!("missing stream {}", path.display()));
    }
    let mut errors: Vec<String> = Vec::new();
    let extracted =
        lunalib::extract_raw_streaming(&path, &mut errors).map_err(|e| e.to_string())?;
    if !errors.is_empty() {
        eprintln!(
            "[extract_raw_streaming_sounds] {} entries failed (false-positive magics or unsupported formats):",
            errors.len()
        );
        for e in &errors {
            eprintln!("  · {e}");
        }
    }
    Ok(extracted
        .into_iter()
        .map(|s| ExtractedSoundDto {
            name: s.name,
            sample_rate: s.sample_rate,
            channels: s.channels,
            sample_count: s.sample_count,
            wav_b64: BASE64.encode(&s.wav),
        })
        .collect())
}

/// Lazy single-texture fetch using Tauri 2's binary IPC. Returns the
/// raw PNG bytes — no base64, no JSON serialization. The frontend
/// receives an `ArrayBuffer` directly and wraps it in a Blob URL.
///
/// Why this exists alongside the streaming texture pipeline: the
/// streaming flow eagerly decodes every texture in the level and ships
/// each as base64 inside a JSON event. That's right for the Viewport
/// (every texture is needed to render placed assets) but wasteful for
/// previews — clicking a single Hierarchy texture row to inspect it
/// shouldn't have required holding ~tens of MB of base64 strings in JS
/// memory just in case. This command re-reads + decodes the requested
/// texture on demand and ships only its PNG bytes, exercising the
/// binary IPC path that we'll roll out to other consumers (Viewport,
/// GLB export) once it's proven.
///
/// Cost: one re-open of `assetlookup.dat` + `highmips.dat` per call,
/// plus decode of the single texture. The `accept` filter on
/// `read_textures_with_total` skips decoding for every other texture,
/// so the per-call cost is genuinely O(1) in the texture count.
#[tauri::command]
fn get_level_texture_png(
    level_folder: String,
    texture_id: u32,
) -> Result<tauri::ipc::Response, String> {
    let path = Path::new(&level_folder);
    let mut found: Option<(Vec<u8>, u32, u32)> = None;
    read_textures_with_total(
        path,
        |id| id == texture_id,
        |_| {},
        |t| {
            if t.id == texture_id && t.is_decoded() {
                let (rgba, w, h) = downsample_rgba(t.rgba, t.width, t.height, 512);
                if !rgba.is_empty() {
                    let png = encode_png(&rgba, w, h);
                    if !png.is_empty() {
                        found = Some((png, w, h));
                    }
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;
    let (png, _w, _h) = found.ok_or_else(|| {
        format!(
            "texture id {texture_id:#010x} not found in {}",
            path.display()
        )
    })?;
    Ok(tauri::ipc::Response::new(png))
}

/// Bulk binary fetch — primary path for moving texture bytes to the
/// frontend. The streaming pipeline (`level_meshes_stream`) ships only
/// metadata events now; once the frontend has the full id list it
/// makes one call to this command to get every texture's PNG bytes in
/// a single Tauri 2 binary response, then parses the flat blob into a
/// `Map<id, Blob>` and feeds it to the Three.js texture cache.
///
/// Wire format (little-endian, no padding):
///   [u32 count]
///   for each texture:
///     [u32 id][u32 png_len][png_len bytes]
///
/// Why one call instead of N: each invoke round-trip pays a fixed
/// overhead (event loop hop, command dispatch, response packaging).
/// On a level with 200+ textures, batching cuts the overhead by ~200×
/// while keeping the bytes binary the entire way (no JSON, no base64).
///
/// Memory: we hold the entire response in RAM while building it. For
/// a 200-texture level at 512² each, post-PNG that's typically ~30 MB
/// — well within budget. If we ever ship 4K levels we should switch
/// to a streamed binary channel instead of one big response.
#[tauri::command]
fn get_level_textures_bulk(
    level_folder: String,
    texture_ids: Vec<u32>,
) -> Result<tauri::ipc::Response, String> {
    let path = Path::new(&level_folder);
    // Heavy lifting (per-texture decode + downsample + PNG encode) runs
    // in parallel via rayon inside `bulk_extract_pngs`. On a 200-texture
    // level this typically finishes in a fraction of the serial time
    // because PNG encode is CPU-bound and fully independent per texture.
    let collected =
        bulk_extract_pngs(path, Some(&texture_ids), 512).map_err(|e| e.to_string())?;

    // Pre-size the output buffer: 4 bytes header + per-entry 8 bytes
    // header + actual PNG bytes. Avoids reallocations on the hot path.
    let payload_bytes: usize = collected.iter().map(|(_, p)| p.len()).sum();
    let mut out = Vec::with_capacity(4 + collected.len() * 8 + payload_bytes);
    out.extend_from_slice(&(collected.len() as u32).to_le_bytes());
    for (id, png) in &collected {
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&(png.len() as u32).to_le_bytes());
        out.extend_from_slice(png);
    }
    Ok(tauri::ipc::Response::new(out))
}

/// One entry in the level's file inventory — drives the "Files" section
/// in the Hierarchy. Distinct from the Asset Library tree (which shows
/// assetlookup.dat-resolved geometry) — this is a survey of EVERY
/// file the level ships, classified by what we DO and DON'T parse yet.
#[derive(Serialize)]
struct LevelFileDto {
    /// File name relative to the level folder (e.g. "dialogue.us.pkg").
    name: String,
    /// Size in bytes — useful in the UI for "this is a big file" cues.
    size_bytes: u64,
    /// Category we recognize: "audio", "audio-stream", "localization",
    /// "lighting", "vfx", "cinematic", "lipsync", "core", "lookup",
    /// "other". Drives icon + grouping in the Hierarchy.
    category: &'static str,
    /// Whether ReChimera currently has a parser for this file. False
    /// means we surface its existence but the user can't extract or
    /// preview its contents yet — a roadmap signal more than anything.
    parsed: bool,
}

/// Enumerate notable files in the level folder. We classify by name
/// patterns rather than file content because most of these are
/// proprietary IGHW variants where mis-classification just means a
/// different icon — no risk.
#[tauri::command]
fn list_level_files(level_folder: String) -> Result<Vec<LevelFileDto>, String> {
    let dir = Path::new(&level_folder);
    if !dir.is_dir() {
        return Err(format!("not a directory: {level_folder}"));
    }
    let mut out: Vec<LevelFileDto> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);

        // Classification by name pattern. Order matters — more specific
        // names check first (resident_dialogue before dialogue, etc).
        let (category, parsed) = if lower == "assetlookup.dat" || lower == "assetstats.dat" {
            ("lookup", true)
        } else if lower == "mobys.dat"
            || lower == "ties.dat"
            || lower == "animsets.dat"
            || lower == "shaders.dat"
            || lower == "highmips.dat"
            || lower == "textures.dat"
            || lower == "zones.dat"
            || lower == "gameplay.dat"
        {
            ("core", true)
        } else if lower == "resident_sound.dat" || lower == "ps3sound.dat" {
            // V2 (R2/R3 SP, RCF) uses resident_sound.dat; V1 (RFOM, R2
            // multiplayer maps like chicago_coop) uses ps3sound.dat.
            // Both decode through the same SCREAM-bank path.
            ("audio", true)
        } else if lower.starts_with("streaming_sound")
            || lower.starts_with("ps3soundstream")
        {
            ("audio-stream", true)
        } else if lower.starts_with("resident_dialogue")
            || lower.starts_with("ps3dialogue")
        {
            // Dialogue banks — same SCREAM-bank format, different file
            // pairing (sibling streaming_dialogue / ps3dialoguestream
            // file holds the actual VAGp/XVAG bytes).
            ("audio", true)
        } else if lower.starts_with("streaming_dialogue")
            || lower.starts_with("ps3dialoguestream")
        {
            ("audio-stream", true)
        } else if lower.starts_with("dialogue.") && lower.ends_with(".pkg") {
            ("localization", false)
        } else if lower.starts_with("lipsync.") {
            ("lipsync", false)
        } else if lower == "lighting.dat" || lower == "cubemaps.dat" {
            ("lighting", false)
        } else if lower == "effect.dat" || lower.starts_with("vfx_system") || lower == "fxconduit_packed.dat" {
            ("vfx", false)
        } else if lower == "cinematics.dat" {
            ("cinematic", false)
        } else if lower == "shrubs.dat" || lower == "foliages.dat" {
            ("foliage", false)
        } else if lower.ends_with(".lc") {
            ("config", false)
        } else if lower.ends_with(".dat") || lower.ends_with(".pkg") {
            ("other", false)
        } else {
            continue; // skip unknown extensions
        };
        out.push(LevelFileDto {
            name,
            size_bytes,
            category,
            parsed,
        });
    }
    // Sort: parsed first (so the things we CAN do float to top), then
    // by category, then by name.
    out.sort_by(|a, b| {
        b.parsed
            .cmp(&a.parsed)
            .then(a.category.cmp(b.category))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
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
            list_animset_clips,
            find_glb_textures,
            list_level_sounds,
            dump_sound_bank,
            extract_level_sounds,
            extract_level_stream_sounds,
            extract_raw_streaming_sounds,
            get_level_texture_png,
            get_level_textures_bulk,
            list_level_files,
            psarc_list,
            psarc_extract_stream,
            write_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
