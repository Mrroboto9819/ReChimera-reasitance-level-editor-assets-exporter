

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use lunalib::{
    animation_section_offsets, decode_animation, read_animation_control, read_animation_header_at,
    read_moby_assets_with_total, read_shaders, read_tie_assets_with_total,
    read_zones, AssetKind, AssetLookup, DecodedClip, IgFile, ShaderInfo, UFrag, Zone,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::{
    build_skeleton_dto, mesh_dto, resolve_shader_textures, AssetMeshesDto, UFragMeshDto,
};

const CACHE_DIR_NAME: &str = "_rechimera_cache";
const MANIFEST_NAME: &str = "manifest.json";

const MANIFEST_VERSION: u32 = 2;
const TEXTURE_MAX_DIM: u32 = 512;

const TARGET_LOG_HASH: u64 = 0x5ED3_7B1C_9C40_3839;

const SOURCE_FILES: &[&str] = &[
    "assetlookup.dat",
    "mobys.dat",
    "ties.dat",
    "shaders.dat",
    "textures.dat",
    "highmips.dat",
    "zones.dat",
    "animsets.dat",
];

#[derive(Serialize, Deserialize, Clone)]
pub struct CacheManifestEntry {

    pub kind: String,

    pub tuid: String,

    pub name: String,

    pub file: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Deserialize)]
pub struct CacheManifest {
    pub version: u32,
    pub folder: String,
    pub entries: Vec<CacheManifestEntry>,

    #[serde(default)]
    pub source_mtimes: HashMap<String, u64>,

    #[serde(default = "default_complete")]
    pub complete: bool,
}

fn default_complete() -> bool {
    true
}

#[derive(Serialize)]
pub struct CacheStatus {
    pub exists: bool,
    pub folder: String,

    pub cache_path: String,
    pub entry_count: usize,

    pub mobys: usize,
    pub ties: usize,
    pub textures: usize,

    pub stale: bool,

    pub incomplete: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CacheEvent {

    Phase {
        phase: &'static str,
        total: usize,
    },

    Item {
        kind: &'static str,
        name: String,
    },

    Progress {
        current: usize,
    },

    Done {
        entry_count: usize,
    },

    Error {
        message: String,
    },
}

fn cache_root(folder: &str) -> PathBuf {
    Path::new(folder).join(CACHE_DIR_NAME)
}

fn mtime_unix_secs(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_secs())
}

fn snapshot_source_mtimes(folder: &Path) -> HashMap<String, u64> {
    let mut out = HashMap::with_capacity(SOURCE_FILES.len());
    for name in SOURCE_FILES {
        if let Some(mt) = mtime_unix_secs(&folder.join(name)) {
            out.insert((*name).to_string(), mt);
        }
    }
    out
}

fn is_cache_stale(folder: &Path, snapshot: &HashMap<String, u64>) -> bool {
    if snapshot.is_empty() {
        return true;
    }
    for (name, &snap) in snapshot {
        let current = match mtime_unix_secs(&folder.join(name)) {
            Some(m) => m,
            None => continue,
        };
        if current > snap {
            return true;
        }
    }
    false
}

struct AnimsetIndex {
    by_hash: HashMap<u64, (u32, u32)>,
}

impl AnimsetIndex {
    fn build(level_folder: &Path) -> Result<Self, String> {
        let path = level_folder.join("assetlookup.dat");
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        let mut lookup = AssetLookup::open(std::io::BufReader::new(file))
            .map_err(|e| e.to_string())?;
        let ptrs = lookup
            .pointers(AssetKind::Animset)
            .map_err(|e| format!("read animset table: {e}"))?;
        let mut by_hash = HashMap::with_capacity(ptrs.len());
        for ptr in ptrs {
            by_hash.insert(ptr.tuid, (ptr.offset, ptr.length));
        }
        Ok(Self { by_hash })
    }
}

fn decode_clips_for_moby(
    level_folder: &Path,
    index: &AnimsetIndex,
    animsets_file: &mut std::fs::File,
    animset_hash: u64,
    position_scale: f32,
    scale_scale: f32,
) -> Vec<DecodedClip> {
    let Some(&(offset, length)) = index.by_hash.get(&animset_hash) else {
        return Vec::new();
    };
    use std::io::{Read, Seek, SeekFrom};
    if animsets_file
        .seek(SeekFrom::Start(u64::from(offset)))
        .is_err()
    {
        return Vec::new();
    }
    let mut buf = vec![0u8; length as usize];
    if animsets_file.read_exact(&mut buf).is_err() {
        return Vec::new();
    }
    let mut ig = match IgFile::open(std::io::Cursor::new(buf)) {
        Ok(ig) => ig,
        Err(_) => return Vec::new(),
    };
    let offsets = animation_section_offsets(&ig);
    let mut out = Vec::with_capacity(offsets.len());
    for (i, off) in offsets.into_iter().enumerate() {
        let header = match read_animation_header_at(&mut ig, off) {
            Ok(h) => h,
            Err(e) => {
                eprintln!(
                    "warn: animset 0x{animset_hash:016X} clip[{i}] header read failed: {e}"
                );
                continue;
            }
        };
        let ctrl = match read_animation_control(&mut ig, &header) {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "warn: animset 0x{animset_hash:016X} clip[{i}] '{}' control read failed: {e}",
                    header.name
                );
                continue;
            }
        };
        match decode_animation(&mut ig, &header, &ctrl, position_scale, scale_scale) {
            Ok(clip) => out.push(clip),
            Err(e) => {
                eprintln!(
                    "warn: animset 0x{animset_hash:016X} clip[{i}] '{}' decode failed (level {level_folder:?}): {e}",
                    header.name
                );
            }
        }
    }
    out
}

fn ensure_dirs(root: &Path) -> Result<(), String> {
    for sub in ["mobys", "ties", "textures"] {
        fs::create_dir_all(root.join(sub))
            .map_err(|e| format!("create {sub} dir: {e}"))?;
    }
    Ok(())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<u64, String> {
    let bytes =
        serde_json::to_vec(value).map_err(|e| format!("serialize {path:?}: {e}"))?;
    let len = bytes.len() as u64;
    fs::write(path, bytes).map_err(|e| format!("write {path:?}: {e}"))?;
    Ok(len)
}

#[tauri::command]
pub fn extract_level_to_cache(
    folder: String,
    on_event: Channel<CacheEvent>,
) -> Result<(), String> {
    match run_extract(&folder, &on_event) {
        Ok(entry_count) => {
            let _ = on_event.send(CacheEvent::Done { entry_count });
            Ok(())
        }
        Err(message) => {
            let _ = on_event.send(CacheEvent::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

fn run_extract(folder: &str, on_event: &Channel<CacheEvent>) -> Result<usize, String> {
    let level_path = Path::new(folder);
    let root = cache_root(folder);
    ensure_dirs(&root)?;

    let manifest_path = root.join(MANIFEST_NAME);
    let in_progress = CacheManifest {
        version: MANIFEST_VERSION,
        folder: folder.to_string(),
        entries: Vec::new(),
        source_mtimes: HashMap::new(),
        complete: false,
    };
    write_json(&manifest_path, &in_progress)?;

    let shaders: HashMap<u64, ShaderInfo> =
        read_shaders(level_path).map_err(|e| e.to_string())?;

    let animset_index = AnimsetIndex::build(level_path).ok();
    let animsets_path = level_path.join("animsets.dat");
    let mut animsets_file = std::fs::File::open(&animsets_path).ok();

    let mut entries: Vec<CacheManifestEntry> = Vec::new();
    let mut needed_textures: HashSet<u32> = HashSet::new();

    let mut moby_assets_for_glb: Vec<lunalib::MobyAsset> = Vec::new();
    let mut tie_assets_for_glb: Vec<lunalib::TieAsset> = Vec::new();

    let mut moby_done = 0usize;
    let phase_total_emit = |total: usize| {
        let _ = on_event.send(CacheEvent::Phase {
            phase: "mobys",
            total,
        });
    };
    {
        read_moby_assets_with_total(
            level_path,
            None,
            phase_total_emit,
            |asset| {

                if asset.tuid == TARGET_LOG_HASH {
                    eprintln!(
                        "[target 0x{:016X}] moby name={:?} animset={:?} bind_pose_inverse_offset={}",
                        asset.tuid,
                        asset.name,
                        asset.animset_hash.map(|h| format!("0x{:016X}", h)),
                        asset.bind_pose_inverse_offset,
                    );
                    eprintln!(
                        "[target 0x{:016X}] shader_tuids.len={} bangles.len={}",
                        asset.tuid,
                        asset.shader_tuids.len(),
                        asset.bangles.len(),
                    );
                    if let Some(skel) = asset.skeleton.as_ref() {
                        eprintln!(
                            "[target 0x{:016X}] skeleton bones={} root={} scale_shift={} translation_shift={}",
                            asset.tuid,
                            skel.bones.len(),
                            skel.root_bone,
                            skel.scale_shift,
                            skel.translation_shift,
                        );
                        if !skel.tms0_col.is_empty() {
                            eprintln!(
                                "[target 0x{:016X}] tms0_col[0] = {:?}",
                                asset.tuid, skel.tms0_col[0]
                            );
                            eprintln!(
                                "[target 0x{:016X}] tms0_col[0] T@[12,13,14] = ({}, {}, {})",
                                asset.tuid,
                                skel.tms0_col[0][12],
                                skel.tms0_col[0][13],
                                skel.tms0_col[0][14],
                            );
                        }
                        if !skel.tms1_col.is_empty() {
                            eprintln!(
                                "[target 0x{:016X}] tms1_col[0] = {:?}",
                                asset.tuid, skel.tms1_col[0]
                            );
                            eprintln!(
                                "[target 0x{:016X}] tms1_col[0] T@[12,13,14] = ({}, {}, {})",
                                asset.tuid,
                                skel.tms1_col[0][12],
                                skel.tms1_col[0][13],
                                skel.tms1_col[0][14],
                            );
                        }
                        if !skel.bind_local.is_empty() {
                            let last = skel.bind_local.len() - 1;
                            eprintln!(
                                "[target 0x{:016X}] bind_local[0] T@[12,13,14] = ({}, {}, {})",
                                asset.tuid,
                                skel.bind_local[0][12],
                                skel.bind_local[0][13],
                                skel.bind_local[0][14],
                            );
                            eprintln!(
                                "[target 0x{:016X}] bind_local[{}] T@[12,13,14] = ({}, {}, {})",
                                asset.tuid,
                                last,
                                skel.bind_local[last][12],
                                skel.bind_local[last][13],
                                skel.bind_local[last][14],
                            );
                        }
                        let parents: Vec<i16> =
                            skel.bones.iter().map(|b| b.parent_index).collect();
                        eprintln!(
                            "[target 0x{:016X}] parents (first 32) = {:?}",
                            asset.tuid,
                            &parents[..parents.len().min(32)]
                        );
                    } else {
                        eprintln!(
                            "[target 0x{:016X}] no skeleton parsed",
                            asset.tuid
                        );
                    }
                }

                moby_assets_for_glb.push(asset.clone());

                let mut submeshes = Vec::new();
                for bangle in asset.bangles {
                    for m in bangle.meshes {
                        let (albedo, normal, emissive) = resolve_shader_textures(
                            &shaders,
                            &asset.shader_tuids,
                            m.shader_index as usize,
                        );
                        for id in [albedo, normal, emissive].into_iter().flatten() {
                            needed_textures.insert(id);
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
                let dto = AssetMeshesDto {
                    asset_tuid: format!("0x{:016X}", asset.tuid),
                    name: asset.name.clone(),
                    submeshes,
                    skeleton: build_skeleton_dto(&asset.skeleton),
                    animset_hash: asset.animset_hash.map(|h| format!("0x{:016X}", h)),
                    bind_pose_inverse_offset: asset.bind_pose_inverse_offset,
                };
                let file_rel = format!("mobys/0x{:016X}.json", asset.tuid);
                let path = root.join(&file_rel);
                if let Ok(size_bytes) = write_json(&path, &dto) {
                    entries.push(CacheManifestEntry {
                        kind: "moby".into(),
                        tuid: dto.asset_tuid.clone(),
                        name: dto.name.clone(),
                        file: file_rel,
                        size_bytes,
                    });
                }
                moby_done += 1;
                let _ = on_event.send(CacheEvent::Item {
                    kind: "moby",
                    name: dto.name,
                });
                let _ = on_event.send(CacheEvent::Progress { current: moby_done });
            },
        )
        .map_err(|e| e.to_string())?;
    }

    let mut tie_done = 0usize;
    let tie_phase_emit = |total: usize| {
        let _ = on_event.send(CacheEvent::Phase {
            phase: "ties",
            total,
        });
    };
    read_tie_assets_with_total(
        level_path,
        None,
        tie_phase_emit,
        |asset| {

            tie_assets_for_glb.push(asset.clone());

            let submeshes: Vec<_> = asset
                .meshes
                .into_iter()
                .map(|m| {
                    let (albedo, normal, emissive) = resolve_shader_textures(
                        &shaders,
                        &asset.shader_tuids,
                        m.shader_index as usize,
                    );
                    for id in [albedo, normal, emissive].into_iter().flatten() {
                        needed_textures.insert(id);
                    }
                    mesh_dto(
                        m.positions,
                        m.uvs,
                        m.indices,
                        albedo,
                        normal,
                        emissive,
                        Vec::new(),
                        Vec::new(),
                    )
                })
                .collect();
            let dto = AssetMeshesDto {
                asset_tuid: format!("0x{:016X}", asset.tuid),
                name: String::new(),
                submeshes,
                skeleton: None,
                animset_hash: None,
                bind_pose_inverse_offset: 0,
            };
            let file_rel = format!("ties/0x{:016X}.json", asset.tuid);
            let path = root.join(&file_rel);
            if let Ok(size_bytes) = write_json(&path, &dto) {
                entries.push(CacheManifestEntry {
                    kind: "tie".into(),
                    tuid: dto.asset_tuid.clone(),
                    name: dto.name.clone(),
                    file: file_rel,
                    size_bytes,
                });
            }
            tie_done += 1;
            let _ = on_event.send(CacheEvent::Item {
                kind: "tie",
                name: dto.name,
            });
            let _ = on_event.send(CacheEvent::Progress { current: tie_done });
        },
    )
    .map_err(|e| e.to_string())?;

    let zones: Vec<Zone> = match read_zones(level_path) {
        Ok(z) => z,
        Err(e) => {
            eprintln!("warn: read_zones failed: {e}; skipping ufrag cache phase");
            Vec::new()
        }
    };
    let mut total_ufrags = 0usize;
    for z in &zones {
        for u in &z.ufrags {
            if u.positions.is_empty() || u.indices.is_empty() {
                continue;
            }
            total_ufrags += 1;
        }
    }
    let _ = on_event.send(CacheEvent::Phase {
        phase: "ufrags",
        total: total_ufrags,
    });
    fs::create_dir_all(root.join("ufrags")).map_err(|e| format!("create ufrags dir: {e}"))?;
    let mut ufrag_done = 0usize;
    for zone in zones {
        let zone_tuid_hex = format!("0x{:016X}", zone.tuid);
        let shader_tuids = zone.ufrag_shader_tuids.clone();
        for u in zone.ufrags {
            if u.positions.is_empty() || u.indices.is_empty() {
                continue;
            }
            let UFrag {
                tuid,
                shader_index,
                position,
                positions,
                uvs,
                indices,
                ..
            } = u;
            let shader_info = shader_tuids
                .get(shader_index as usize)
                .and_then(|st| shaders.get(st));
            let albedo = shader_info.and_then(|s| s.albedo_tex_id);
            let normal = shader_info.and_then(|s| s.normal_tex_id);
            let emissive = shader_info.and_then(|s| s.expensive_tex_id);
            for id in [albedo, normal, emissive].into_iter().flatten() {
                needed_textures.insert(id);
            }
            let dto = UFragMeshDto {
                tuid: format!("0x{:016X}", tuid),
                zone_tuid: zone_tuid_hex.clone(),
                position,
                mesh: mesh_dto(positions, uvs, indices, albedo, normal, emissive, Vec::new(), Vec::new()),
            };
            let file_rel = format!("ufrags/{}.json", dto.tuid);
            let path = root.join(&file_rel);
            let size_bytes = write_json(&path, &dto).unwrap_or(0);
            entries.push(CacheManifestEntry {
                kind: "ufrag".into(),
                tuid: dto.tuid,
                name: dto.zone_tuid,
                file: file_rel,
                size_bytes,
            });
            ufrag_done += 1;
            let _ = on_event.send(CacheEvent::Progress { current: ufrag_done });
        }
    }

    let needed_ids: Vec<u32> = needed_textures.iter().copied().collect();
    let _ = on_event.send(CacheEvent::Phase {
        phase: "textures",
        total: needed_ids.len(),
    });
    let pngs = lunalib::bulk_extract_pngs(level_path, Some(&needed_ids), TEXTURE_MAX_DIM)
        .map_err(|e| e.to_string())?;
    let mut texture_pngs: HashMap<u32, Vec<u8>> = HashMap::with_capacity(pngs.len());
    let mut tex_done = 0usize;
    let progress_every = (pngs.len() / 50).max(1);
    for (id, png) in pngs.into_iter() {
        let file_rel = format!("textures/{id}.png");
        let path = root.join(&file_rel);
        let size_bytes = png.len() as u64;
        if fs::write(&path, &png).is_ok() {
            entries.push(CacheManifestEntry {
                kind: "texture".into(),
                tuid: id.to_string(),
                name: String::new(),
                file: file_rel,
                size_bytes,
            });
        }
        texture_pngs.insert(id, png);
        tex_done += 1;
        if tex_done % progress_every == 0 {
            let _ = on_event.send(CacheEvent::Progress { current: tex_done });
        }
    }
    let _ = on_event.send(CacheEvent::Progress { current: tex_done });

    let _ = on_event.send(CacheEvent::Phase {
        phase: "mobys",
        total: moby_assets_for_glb.len() + tie_assets_for_glb.len(),
    });
    let mut glb_done = 0usize;
    for asset in moby_assets_for_glb.into_iter() {
        let clips: Vec<DecodedClip> = match (
            asset.animset_hash,
            animset_index.as_ref(),
            animsets_file.as_mut(),
        ) {
            (Some(hash), Some(idx), Some(file)) => {
                let trans_shift = asset
                    .skeleton
                    .as_ref()
                    .map(|s| s.translation_shift)
                    .unwrap_or(0);
                let scale_shift_v = asset
                    .skeleton
                    .as_ref()
                    .map(|s| s.scale_shift)
                    .unwrap_or(0);
                let pos_scale = if (trans_shift as u32) < 15 {
                    1.0 / (0x8000u32 >> trans_shift) as f32
                } else {
                    1.0 / 32768.0
                };
                let scale_scale = if (scale_shift_v as u32) < 15 {
                    1.0 / (0x8000u32 >> scale_shift_v) as f32
                } else {
                    1.0 / 32768.0
                };
                decode_clips_for_moby(level_path, idx, file, hash, pos_scale, scale_scale)
            }
            _ => Vec::new(),
        };
        if asset.tuid == TARGET_LOG_HASH {
            eprintln!(
                "[target 0x{:016X}] writing GLB: clips={} shaders.len={} texture_pngs.len={}",
                asset.tuid,
                clips.len(),
                shaders.len(),
                texture_pngs.len(),
            );
            for (i, clip) in clips.iter().enumerate() {
                eprintln!(
                    "[target 0x{:016X}] clip[{}] name={:?} frames={} fps={} bones={} looping={}",
                    asset.tuid,
                    i,
                    clip.name,
                    clip.num_frames,
                    clip.frame_rate,
                    clip.bones.len(),
                    clip.looping
                );
            }
        }
        match lunalib::write_moby_glb_full(&asset, &clips, &shaders, &texture_pngs) {
            Ok(glb_bytes) => {
                let glb_rel = format!("mobys/0x{:016X}.glb", asset.tuid);
                let glb_path = root.join(&glb_rel);
                if fs::write(&glb_path, &glb_bytes).is_ok() {
                    entries.push(CacheManifestEntry {
                        kind: "moby_glb".into(),
                        tuid: format!("0x{:016X}", asset.tuid),
                        name: asset.name.clone(),
                        file: glb_rel,
                        size_bytes: glb_bytes.len() as u64,
                    });
                }
            }
            Err(e) => {
                eprintln!(
                    "warn: GLB export failed for moby 0x{:016X}: {e}",
                    asset.tuid
                );
            }
        }
        glb_done += 1;
        let _ = on_event.send(CacheEvent::Progress { current: glb_done });
    }

    fs::create_dir_all(root.join("ties")).map_err(|e| format!("create ties dir: {e}"))?;
    for tie in tie_assets_for_glb.into_iter() {
        let synth = tie_as_moby(&tie);
        match lunalib::write_moby_glb_full(&synth, &[], &shaders, &texture_pngs) {
            Ok(glb_bytes) => {
                let glb_rel = format!("ties/0x{:016X}.glb", tie.tuid);
                let glb_path = root.join(&glb_rel);
                if fs::write(&glb_path, &glb_bytes).is_ok() {
                    entries.push(CacheManifestEntry {
                        kind: "tie_glb".into(),
                        tuid: format!("0x{:016X}", tie.tuid),
                        name: synth.name.clone(),
                        file: glb_rel,
                        size_bytes: glb_bytes.len() as u64,
                    });
                }
            }
            Err(e) => {
                eprintln!(
                    "warn: GLB export failed for tie 0x{:016X}: {e}",
                    tie.tuid
                );
            }
        }
        glb_done += 1;
        let _ = on_event.send(CacheEvent::Progress { current: glb_done });
    }

    let manifest = CacheManifest {
        version: MANIFEST_VERSION,
        folder: folder.to_string(),
        entries,
        source_mtimes: snapshot_source_mtimes(level_path),
        complete: true,
    };
    write_json(&manifest_path, &manifest)?;
    Ok(manifest.entries.len())
}

fn count_files_in(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .count()
}

#[tauri::command]
pub fn cache_status(folder: String) -> Result<CacheStatus, String> {
    let root = cache_root(&folder);
    let manifest_path = root.join(MANIFEST_NAME);

    if !manifest_path.is_file() {

        if root.is_dir() {
            let mobys = count_files_in(&root.join("mobys"));
            let ties = count_files_in(&root.join("ties"));
            let textures = count_files_in(&root.join("textures"));
            let total = mobys + ties + textures;
            if total > 0 {
                return Ok(CacheStatus {
                    exists: true,
                    folder,
                    cache_path: root.to_string_lossy().into_owned(),
                    entry_count: total,
                    mobys,
                    ties,
                    textures,
                    stale: true,
                    incomplete: true,
                });
            }
        }
        return Ok(CacheStatus {
            exists: false,
            folder,
            cache_path: root.to_string_lossy().into_owned(),
            entry_count: 0,
            mobys: 0,
            ties: 0,
            textures: 0,
            stale: false,
            incomplete: false,
        });
    }

    let bytes = match fs::read(&manifest_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cache_status: read manifest failed: {e}");
            return cache_status_from_dir(&folder, &root, true, true);
        }
    };
    let manifest: CacheManifest = match serde_json::from_slice(&bytes) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("cache_status: parse manifest failed: {e}");
            return cache_status_from_dir(&folder, &root, true, true);
        }
    };
    let mut mobys = 0usize;
    let mut ties = 0usize;
    let mut textures = 0usize;
    for entry in &manifest.entries {
        match entry.kind.as_str() {
            "moby" => mobys += 1,
            "tie" => ties += 1,
            "texture" => textures += 1,
            _ => {}
        }
    }
    let stale = is_cache_stale(Path::new(&folder), &manifest.source_mtimes);

    let incomplete = !manifest.complete;
    Ok(CacheStatus {
        exists: true,
        folder,
        cache_path: root.to_string_lossy().into_owned(),
        entry_count: manifest.entries.len(),
        mobys,
        ties,
        textures,
        stale: stale || incomplete,
        incomplete,
    })
}

fn cache_status_from_dir(
    folder: &str,
    root: &Path,
    stale: bool,
    incomplete: bool,
) -> Result<CacheStatus, String> {
    let mobys = count_files_in(&root.join("mobys"));
    let ties = count_files_in(&root.join("ties"));
    let textures = count_files_in(&root.join("textures"));
    let total = mobys + ties + textures;
    Ok(CacheStatus {
        exists: total > 0,
        folder: folder.to_owned(),
        cache_path: root.to_string_lossy().into_owned(),
        entry_count: total,
        mobys,
        ties,
        textures,
        stale,
        incomplete,
    })
}

#[tauri::command]
pub fn read_cached_manifest(folder: String) -> Result<CacheManifest, String> {
    let root = cache_root(&folder);
    let manifest_path = root.join(MANIFEST_NAME);
    let bytes = fs::read(&manifest_path)
        .map_err(|e| format!("read {manifest_path:?}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))
}

#[tauri::command]
pub fn export_cached_moby_glb(
    level_folder: String,
    asset_tuid_hex: String,
    out_path: String,
) -> Result<u64, String> {
    let root = cache_root(&level_folder);
    let moby_glb = root.join("mobys").join(format!("{asset_tuid_hex}.glb"));
    let tie_glb = root.join("ties").join(format!("{asset_tuid_hex}.glb"));
    let cache_glb = if moby_glb.is_file() {
        moby_glb
    } else if tie_glb.is_file() {
        tie_glb
    } else {
        return Err(format!(
            "Cached GLB not found in mobys/ or ties/ for {asset_tuid_hex} — re-extract the level cache first"
        ));
    };
    fs::copy(&cache_glb, &out_path).map_err(|e| {
        format!("copy {} → {}: {e}", cache_glb.display(), out_path)
    })
}

#[tauri::command]
pub fn read_cached_asset(folder: String, file: String) -> Result<serde_json::Value, String> {
    let path = sanitized_cache_path(&folder, &file)?;
    let bytes = fs::read(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {file}: {e}"))
}

#[tauri::command]
pub fn read_cached_bytes(
    folder: String,
    file: String,
) -> Result<tauri::ipc::Response, String> {
    let path = sanitized_cache_path(&folder, &file)?;
    let bytes = fs::read(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn reextract_level_cache(
    folder: String,
    on_event: Channel<CacheEvent>,
) -> Result<(), String> {
    let root = cache_root(&folder);
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|e| format!("remove cache dir: {e}"))?;
    }
    extract_level_to_cache(folder, on_event)
}

fn sanitized_cache_path(folder: &str, file: &str) -> Result<PathBuf, String> {
    if file.split(['/', '\\']).any(|seg| seg == ".." || seg.is_empty()) {
        return Err(format!("rejected path: {file}"));
    }
    if Path::new(file).is_absolute() {
        return Err(format!("rejected absolute path: {file}"));
    }
    Ok(cache_root(folder).join(file))
}

fn tie_as_moby(tie: &lunalib::TieAsset) -> lunalib::MobyAsset {
    let meshes: Vec<lunalib::MobyMesh> = tie
        .meshes
        .iter()
        .map(|m| lunalib::MobyMesh {
            shader_index: m.shader_index,
            vertex_count: m.vertex_count,
            index_count: m.index_count,
            vertex_stride: 0x14,
            positions: m.positions.clone(),
            uvs: m.uvs.clone(),
            indices: m.indices.clone(),
            bone_indices: Vec::new(),
            bone_weights: Vec::new(),
        })
        .collect();
    lunalib::MobyAsset {
        tuid: tie.tuid,
        name: format!("tie_{:016X}", tie.tuid),
        bangles: vec![lunalib::MobyBangle { meshes }],
        bsphere_position: [0.0, 0.0, 0.0],
        bsphere_radius: 0.0,
        shader_tuids: tie.shader_tuids.clone(),
        skeleton: None,
        animset_hash: None,
        bind_pose_inverse_offset: 0,
    }
}

