

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use lunalib::{
    animation_section_offsets, decode_animation, decode_animation_with_skeleton, detect_layout,
    read_animation_control, read_animation_header_at, read_moby_assets_old,
    read_moby_assets_with_total, read_shaders, read_tie_assets_with_total, read_zones, AssetKind,
    AssetLookup, DecodedClip, IgFile, LevelLayout, ShaderInfo, Skeleton, UFrag, Zone,
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

fn decode_clips_for_moby_inline(
    level_folder: &Path,
    main_dat_filename: &str,
    anim_offsets: &[u64],
    position_scale: f32,
    scale_scale: f32,
    skeleton: &Skeleton,
    layout: LevelLayout,
) -> Vec<DecodedClip> {
    if anim_offsets.is_empty() {
        return Vec::new();
    }
    if matches!(layout, LevelLayout::Tod) {
        eprintln!(
            "[cache] TOD inline anim decode skipped — frame format unsolved (see project_tod_anim_format.md)"
        );
        return Vec::new();
    }
    let main_path = level_folder.join(main_dat_filename);
    let file = match std::fs::File::open(&main_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("warn: inline anim decode — open {main_dat_filename}: {e}");
            return Vec::new();
        }
    };
    let mut ig = match IgFile::open(std::io::BufReader::new(file)) {
        Ok(ig) => ig,
        Err(e) => {
            eprintln!("warn: inline anim decode — IgFile::open {main_dat_filename}: {e}");
            return Vec::new();
        }
    };
    let skel_bones = skeleton.bones.len() as u16;
    let mut out = Vec::with_capacity(anim_offsets.len());
    for (i, off) in anim_offsets.iter().enumerate() {
        let mut header = match read_animation_header_at(&mut ig, *off) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("warn: inline anim[{i}] header read failed: {e}");
                continue;
            }
        };
        if skel_bones > 0 {
            header.num_bones = skel_bones;
        }
        let ctrl = match read_animation_control(&mut ig, &header) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("warn: inline anim[{i}] '{}' control read failed: {e}", header.name);
                continue;
            }
        };
        let result = decode_animation_with_skeleton(
            &mut ig,
            &header,
            &ctrl,
            position_scale,
            scale_scale,
            skeleton,
        );
        match result {
            Ok(clip) => out.push(clip),
            Err(e) => {
                eprintln!("warn: inline anim[{i}] '{}' decode failed: {e}", header.name);
            }
        }
    }
    out
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

    let layout = detect_layout(level_path)
        .map_err(|_| {
            "Folder has none of main.dat (TOD), assetlookup.dat (V2), or ps3levelmain.dat (RFOM)"
                .to_string()
        })?;
    eprintln!(
        "[cache] level layout detected: {} ({})",
        layout.tag(),
        layout.label()
    );

    // RFOM probe — log every IGHW section in ps3levelmain.dat so we
    // can keep porting structures off real bytes. Stage R.1 (mobys)
    // is wired below; later stages reuse the same probe.
    if matches!(layout, LevelLayout::Rfom) {
        let entry_path = level_path.join("ps3levelmain.dat");
        match std::fs::File::open(&entry_path) {
            Ok(file) => match IgFile::open(std::io::BufReader::new(file)) {
                Ok(ig) => {
                    eprintln!(
                        "[probe-rfom] ps3levelmain.dat IGHW v{}.{} — {} section(s):",
                        ig.version.major,
                        ig.version.minor,
                        ig.sections.len()
                    );
                    for s in &ig.sections {
                        eprintln!(
                            "[probe-rfom]   id=0x{:04X} offset=0x{:X} count={} length={}",
                            s.id, s.offset, s.count, s.length
                        );
                    }
                }
                Err(e) => eprintln!("[probe-rfom] failed to parse ps3levelmain.dat: {e}"),
            },
            Err(e) => eprintln!("[probe-rfom] failed to open ps3levelmain.dat: {e}"),
        }
        let gp_path = level_path.join("ps3gameplay.dat");
        if gp_path.exists() {
            match std::fs::File::open(&gp_path) {
                Ok(file) => match IgFile::open(std::io::BufReader::new(file)) {
                    Ok(ig) => {
                        eprintln!(
                            "[probe-rfom-gp] ps3gameplay.dat IGHW v{}.{} — {} section(s):",
                            ig.version.major,
                            ig.version.minor,
                            ig.sections.len()
                        );
                        for s in &ig.sections {
                            eprintln!(
                                "[probe-rfom-gp]   id=0x{:04X} offset=0x{:X} count={} length={}",
                                s.id, s.offset, s.count, s.length
                            );
                        }
                    }
                    Err(e) => eprintln!("[probe-rfom-gp] failed to parse ps3gameplay.dat: {e}"),
                },
                Err(e) => eprintln!("[probe-rfom-gp] failed to open ps3gameplay.dat: {e}"),
            }
        } else {
            eprintln!("[probe-rfom-gp] ps3gameplay.dat not present in level folder");
        }
    }

    // Stage A — TOD skeleton / animation probe. We log whatever
    // sections exist with class IDs 0xD300 (skeleton) and 0xF000
    // (animation) inside main.dat so we know whether the V2 layout
    // applies, the layout differs, or those sections don't exist at
    // all for TOD-era levels. Drives stage D (reverse engineering)
    // decisions.
    if matches!(layout, LevelLayout::Tod) {
        let main_path = level_path.join("main.dat");
        if let Ok(file) = std::fs::File::open(&main_path) {
            if let Ok(ig) = IgFile::open(std::io::BufReader::new(file)) {
                let mut skel_sections = 0usize;
                let mut anim_sections = 0usize;
                for s in &ig.sections {
                    match s.id {
                        0xD300 => {
                            eprintln!(
                                "[probe-tod-skeleton] section 0xD300 @ offset 0x{:X}, count={}, length={}",
                                s.offset, s.count, s.length
                            );
                            skel_sections += 1;
                        }
                        0xF000 => {
                            eprintln!(
                                "[probe-tod-animation] section 0xF000 @ offset 0x{:X}, count={}, length={}",
                                s.offset, s.count, s.length
                            );
                            anim_sections += 1;
                        }
                        _ => {}
                    }
                }
                if skel_sections == 0 {
                    eprintln!("[probe-tod-skeleton] no 0xD300 section in main.dat");
                }
                if anim_sections == 0 {
                    eprintln!("[probe-tod-animation] no 0xF000 section in main.dat");
                }
            }
        }
    }

    let manifest_path = root.join(MANIFEST_NAME);
    let in_progress = CacheManifest {
        version: MANIFEST_VERSION,
        folder: folder.to_string(),
        entries: Vec::new(),
        source_mtimes: HashMap::new(),
        complete: false,
    };
    write_json(&manifest_path, &in_progress)?;

    let shaders: HashMap<u64, ShaderInfo> = match layout {
        LevelLayout::V2 => read_shaders(level_path).map_err(|e| e.to_string())?,
        LevelLayout::Rfom => match lunalib::read_shaders_rfom(level_path) {
            Ok(map) => {
                eprintln!(
                    "[cache] RFOM layout: read {} materials from ps3levelmain.dat",
                    map.len()
                );
                let _ = lunalib::probe_rfom_unknowns(level_path);
                map
            }
            Err(e) => {
                eprintln!("warn: RFOM shader read failed ({e}) — using empty shader table");
                HashMap::new()
            }
        },
        LevelLayout::Tod => match lunalib::read_shaders_old(level_path) {
            Ok(map) => {
                eprintln!("[cache] TOD layout: read {} shaders from main.dat", map.len());
                map
            }
            Err(e) => {
                eprintln!("warn: TOD shader read failed ({e}) — using empty shader table");
                HashMap::new()
            }
        },
    };

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
    if matches!(layout, LevelLayout::Tod) {
        let mut tod_total_emitted = false;
        let mut tod_count = 0usize;
        if let Err(e) = read_moby_assets_old(level_path, |asset| {
            if !tod_total_emitted {
                let _ = on_event.send(CacheEvent::Phase {
                    phase: "mobys",
                    total: 1,
                });
                tod_total_emitted = true;
            }
            tod_count += 1;
            moby_assets_for_glb.push(asset.clone());

            let mut submeshes = Vec::new();
            for bangle in &asset.bangles {
                for m in &bangle.meshes {
                    let (albedo, normal, emissive) = resolve_shader_textures(
                        &shaders,
                        &asset.shader_tuids,
                        m.shader_index as usize,
                    );
                    for id in [albedo, normal, emissive].into_iter().flatten() {
                        needed_textures.insert(id);
                    }
                    submeshes.push(mesh_dto(
                        m.positions.clone(),
                        m.uvs.clone(),
                        m.indices.clone(),
                        albedo,
                        normal,
                        emissive,
                        m.bone_indices.clone(),
                        m.bone_weights.clone(),
                    ));
                }
            }
            let dto = AssetMeshesDto {
                asset_tuid: format!("0x{:016X}", asset.tuid),
                name: asset.name.clone(),
                submeshes,
                skeleton: build_skeleton_dto(&asset.skeleton),
                animset_hash: None,
                bind_pose_inverse_offset: asset.bind_pose_inverse_offset,
                embedded_animation_count: asset.rfom_anim_offsets.len() as u32,
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
            let _ = on_event.send(CacheEvent::Item {
                kind: "moby",
                name: dto.name,
            });
            let _ = on_event.send(CacheEvent::Progress { current: tod_count });
        }) {
            return Err(format!("TOD moby read failed: {e}"));
        }
        eprintln!("[cache] TOD layout: extracted {tod_count} mobys");
    } else if matches!(layout, LevelLayout::Rfom) {
        // RFOM path — Stage R.1. Reads MobyV1 (0xC0) + PrimitiveV1
        // (0x20) from ps3levelmain.dat with geometry sourced from
        // ps3levelverts.dat. Shaders/textures/skeleton are not ported
        // yet so submeshes carry None texture ids and the skeleton/
        // animset fields stay empty.
        let mut rfom_total_emitted = false;
        let mut rfom_count = 0usize;
        if let Err(e) = lunalib::read_moby_assets_rfom(level_path, |asset| {
            if !rfom_total_emitted {
                let _ = on_event.send(CacheEvent::Phase {
                    phase: "mobys",
                    total: 1,
                });
                rfom_total_emitted = true;
            }
            rfom_count += 1;
            moby_assets_for_glb.push(asset.clone());

            let mut submeshes = Vec::new();
            for bangle in &asset.bangles {
                for m in &bangle.meshes {
                    let (albedo, normal, emissive) = resolve_shader_textures(
                        &shaders,
                        &asset.shader_tuids,
                        m.shader_index as usize,
                    );
                    for id in [albedo, normal, emissive].into_iter().flatten() {
                        needed_textures.insert(id);
                    }
                    submeshes.push(mesh_dto(
                        m.positions.clone(),
                        m.uvs.clone(),
                        m.indices.clone(),
                        albedo,
                        normal,
                        emissive,
                        m.bone_indices.clone(),
                        m.bone_weights.clone(),
                    ));
                }
            }
            let dto = AssetMeshesDto {
                asset_tuid: format!("0x{:016X}", asset.tuid),
                name: asset.name.clone(),
                submeshes,
                skeleton: build_skeleton_dto(&asset.skeleton),
                animset_hash: None,
                bind_pose_inverse_offset: asset.bind_pose_inverse_offset,
                embedded_animation_count: asset.rfom_anim_offsets.len() as u32,
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
            let _ = on_event.send(CacheEvent::Item {
                kind: "moby",
                name: dto.name,
            });
            let _ = on_event.send(CacheEvent::Progress { current: rfom_count });
        }) {
            eprintln!("warn: RFOM moby read failed: {e}");
        }
        eprintln!("[cache] RFOM layout: extracted {rfom_count} mobys");
    } else {
        read_moby_assets_with_total(
            level_path,
            None,
            phase_total_emit,
            |asset| {
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
                    embedded_animation_count: 0,
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
    if matches!(layout, LevelLayout::Tod) {
        let mut tod_total_emitted = false;
        if let Err(e) = lunalib::read_tie_assets_old(level_path, |asset| {
            if !tod_total_emitted {
                let _ = on_event.send(CacheEvent::Phase {
                    phase: "ties",
                    total: 1,
                });
                tod_total_emitted = true;
            }
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
                name: format!("tie_{:016X}", asset.tuid),
                submeshes,
                skeleton: None,
                animset_hash: None,
                bind_pose_inverse_offset: 0,
                embedded_animation_count: 0,
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
        }) {
            eprintln!("warn: TOD tie read failed: {e}");
        }
        eprintln!("[cache] TOD layout: extracted {tie_done} ties");
    } else if matches!(layout, LevelLayout::Rfom) {
        let mut rfom_total_emitted = false;
        if let Err(e) = lunalib::read_tie_assets_rfom(level_path, |asset| {
            if !rfom_total_emitted {
                let _ = on_event.send(CacheEvent::Phase {
                    phase: "ties",
                    total: 1,
                });
                rfom_total_emitted = true;
            }
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
                name: format!("tie_{:016X}", asset.tuid),
                submeshes,
                skeleton: None,
                animset_hash: None,
                bind_pose_inverse_offset: 0,
                embedded_animation_count: 0,
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
        }) {
            eprintln!("warn: RFOM tie read failed: {e}");
        }
        eprintln!("[cache] RFOM layout: extracted {tie_done} ties");

        // RFOM also has DetailCluster (0xB300) — small static props
        // (debris, signs, etc.) that share the V1 Vertex0 stride and
        // meshScale convention with regular ties. Surface them under
        // their own `kind: "detail"` so the cache modal can filter
        // them into a dedicated tab and the viewport can color them
        // distinctly. Geometry pipeline is identical to ties — they
        // still feed `tie_assets_for_glb` so the per-asset GLB +
        // texture resolution work the same.
        let _ = lunalib::read_detail_clusters_rfom(level_path)
            .map(|(detail_assets, _)| {
                let _ = fs::create_dir_all(root.join("details"));
                let mut detail_done = 0usize;
                for asset in detail_assets {
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
                        name: format!("detail_{:016X}", asset.tuid),
                        submeshes,
                        skeleton: None,
                        animset_hash: None,
                        bind_pose_inverse_offset: 0,
                        embedded_animation_count: 0,
                    };
                    let file_rel = format!("details/0x{:016X}.json", asset.tuid);
                    let path = root.join(&file_rel);
                    if let Ok(size_bytes) = write_json(&path, &dto) {
                        entries.push(CacheManifestEntry {
                            kind: "detail".into(),
                            tuid: dto.asset_tuid.clone(),
                            name: dto.name.clone(),
                            file: file_rel,
                            size_bytes,
                        });
                    }
                    detail_done += 1;
                    let _ = on_event.send(CacheEvent::Item {
                        kind: "tie",
                        name: dto.name,
                    });
                }
                eprintln!("[cache] RFOM layout: extracted {detail_done} detail clusters");
            })
            .map_err(|e| eprintln!("warn: RFOM detail-cluster read failed: {e}"));

        match lunalib::read_skybox_rfom(level_path) {
            Ok(Some(sky)) => {
                let sky_dir = root.join("skybox");
                let _ = fs::create_dir_all(&sky_dir);
                let glb = lunalib::write_skybox_glb(&sky)
                    .unwrap_or_default();
                let obj = lunalib::write_skybox_obj(&sky);
                let ply = lunalib::write_skybox_ply(&sky);
                let json = serde_json::json!({
                    "vertex_count": sky.vertices.len(),
                    "triangle_count": sky.indices.len() / 3,
                    "aabb_min": sky.aabb_min,
                    "aabb_max": sky.aabb_max,
                    "texture_offset": sky.texture_offset,
                });

                let glb_path = sky_dir.join("sky.glb");
                let obj_path = sky_dir.join("sky.obj");
                let ply_path = sky_dir.join("sky.ply");
                let json_path = sky_dir.join("sky.json");
                let _ = fs::write(&glb_path, &glb);
                let _ = fs::write(&obj_path, obj.as_bytes());
                let _ = fs::write(&ply_path, ply.as_bytes());
                let _ = fs::write(
                    &json_path,
                    serde_json::to_vec_pretty(&json).unwrap_or_default(),
                );

                let glb_size = glb.len() as u64;
                entries.push(CacheManifestEntry {
                    kind: "sky".into(),
                    tuid: format!("0x{:08X}", sky.texture_offset.unwrap_or(0)),
                    name: "sky_dome".into(),
                    file: "skybox/sky.glb".into(),
                    size_bytes: glb_size,
                });
                eprintln!(
                    "[cache] RFOM layout: wrote skybox GLB ({} verts, {} tris, {} bytes)",
                    sky.vertices.len(),
                    sky.indices.len() / 3,
                    glb_size
                );
            }
            Ok(None) => eprintln!("[cache] RFOM layout: no skybox sections found"),
            Err(e) => eprintln!("warn: RFOM skybox read failed: {e}"),
        }
    } else {
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
                embedded_animation_count: 0,
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
    }

    let zones: Vec<Zone> = match layout {
        LevelLayout::V2 => match read_zones(level_path) {
            Ok(z) => z,
            Err(e) => {
                eprintln!("warn: read_zones failed: {e}; skipping ufrag cache phase");
                Vec::new()
            }
        },
        LevelLayout::Tod => {
            eprintln!("[cache] TOD layout: zone reader not yet ported");
            Vec::new()
        }
        LevelLayout::Rfom => {
            match lunalib::read_regions_rfom(level_path) {
                Ok(z) => {
                    eprintln!(
                        "[cache] RFOM layout: read {} synthetic zone(s) with {} ufrags",
                        z.len(),
                        z.iter().map(|x| x.ufrags.len()).sum::<usize>()
                    );
                    z
                }
                Err(e) => {
                    eprintln!("warn: RFOM region read failed ({e}); skipping ufrag phase");
                    Vec::new()
                }
            }
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
    let pngs = match layout {
        LevelLayout::V2 => lunalib::bulk_extract_pngs(level_path, Some(&needed_ids), TEXTURE_MAX_DIM)
            .map_err(|e| e.to_string())?,
        LevelLayout::Tod => match lunalib::read_textures_old(level_path) {
            Ok(textures) => {
                let needed: HashSet<u32> = needed_ids.iter().copied().collect();
                let mut out: Vec<(u32, Vec<u8>)> = Vec::new();
                for t in &textures {
                    if !needed.contains(&t.id) {
                        continue;
                    }
                    if let Some(png) = lunalib::texture_to_png(t) {
                        let resized =
                            lunalib::downsample_png_to(&png, TEXTURE_MAX_DIM).unwrap_or(png);
                        out.push((t.id, resized));
                    }
                }
                eprintln!(
                    "[cache] TOD layout: encoded {} / {} requested textures",
                    out.len(),
                    needed_ids.len()
                );
                out
            }
            Err(e) => {
                eprintln!("warn: TOD texture read failed ({e}) — emitting no textures");
                Vec::new()
            }
        },
        LevelLayout::Rfom => match lunalib::read_textures_rfom(level_path) {
            Ok(textures) => {
                let needed: HashSet<u32> = needed_ids.iter().copied().collect();
                let mut out: Vec<(u32, Vec<u8>)> = Vec::new();
                for t in &textures {
                    if !needed.contains(&t.id) {
                        continue;
                    }
                    if let Some(png) = lunalib::texture_rfom_to_png(t) {
                        let resized =
                            lunalib::downsample_png_to(&png, TEXTURE_MAX_DIM).unwrap_or(png);
                        out.push((t.id, resized));
                    }
                }
                eprintln!(
                    "[cache] RFOM layout: encoded {} / {} requested textures",
                    out.len(),
                    needed_ids.len()
                );
                out
            }
            Err(e) => {
                eprintln!("warn: RFOM texture read failed ({e}) — emitting no textures");
                Vec::new()
            }
        },
    };
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

        let clips: Vec<DecodedClip> = if !asset.rfom_anim_offsets.is_empty() {
            match asset.skeleton.as_ref() {
                Some(skel) => {
                    let main_dat = match layout {
                        LevelLayout::Tod => "main.dat",
                        _ => "ps3levelmain.dat",
                    };
                    decode_clips_for_moby_inline(
                        level_path,
                        main_dat,
                        &asset.rfom_anim_offsets,
                        pos_scale,
                        scale_scale,
                        skel,
                        layout,
                    )
                }
                None => Vec::new(),
            }
        } else {
            match (
                asset.animset_hash,
                animset_index.as_ref(),
                animsets_file.as_mut(),
            ) {
                (Some(hash), Some(idx), Some(file)) => {
                    decode_clips_for_moby(level_path, idx, file, hash, pos_scale, scale_scale)
                }
                _ => Vec::new(),
            }
        };
        const PROBE_TUID: u64 = 0x079D;
        let probe = asset.tuid == PROBE_TUID;
        if probe {
            eprintln!(
                "[probe-moby-{:04X}] (glb-stage) bangles={} primitives={} skeleton_bones={} clip_count={} anim_offsets={} pos_scale={pos_scale} scale_scale={scale_scale}",
                PROBE_TUID,
                asset.bangles.len(),
                asset.bangles.iter().map(|b| b.meshes.len()).sum::<usize>(),
                asset.skeleton.as_ref().map(|s| s.bones.len()).unwrap_or(0),
                clips.len(),
                asset.rfom_anim_offsets.len()
            );
            for (bi, bangle) in asset.bangles.iter().enumerate() {
                for (mi, m) in bangle.meshes.iter().enumerate() {
                    eprintln!(
                        "[probe-moby-{:04X}]   bangle[{bi}].mesh[{mi}] verts={} idx={} stride={} mat={} bone_idx_len={} bone_w_len={}",
                        PROBE_TUID,
                        m.vertex_count, m.index_count, m.vertex_stride, m.shader_index,
                        m.bone_indices.len(), m.bone_weights.len()
                    );
                }
            }
            for (ci, clip) in clips.iter().enumerate().take(3) {
                let mut animated_bones = 0usize;
                let mut total_rot = 0usize;
                let mut total_trans = 0usize;
                for b in &clip.bones {
                    if b.rotation_animated || b.translation_animated || b.scale_animated {
                        animated_bones += 1;
                    }
                    total_rot += b.rotations.len();
                    total_trans += b.translations.len();
                }
                eprintln!(
                    "[probe-moby-{:04X}]   clip[{ci}] name='{}' frames={} fps={} loop={} bones={} animated_bones={} total_rot_floats={} total_trans_floats={}",
                    PROBE_TUID,
                    clip.name, clip.num_frames, clip.frame_rate, clip.looping,
                    clip.bones.len(), animated_bones, total_rot, total_trans
                );
            }
        }
        match lunalib::write_moby_glb_full(&asset, &clips, &shaders, &texture_pngs) {
            Ok(glb_bytes) => {
                if probe {
                    eprintln!(
                        "[probe-moby-{:04X}] GLB write OK — {} bytes",
                        PROBE_TUID,
                        glb_bytes.len()
                    );
                }
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
                } else if probe {
                    eprintln!("[probe-moby-{:04X}] GLB fs::write FAILED", PROBE_TUID);
                }
            }
            Err(e) => {
                eprintln!(
                    "warn: GLB export failed for moby 0x{:016X}: {e}",
                    asset.tuid
                );
                if probe {
                    eprintln!("[probe-moby-{:04X}] GLB write FAILED: {e}", PROBE_TUID);
                }
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

#[derive(Deserialize)]
pub struct GlbExportOptions {
    pub include_mesh: bool,
    pub include_materials: bool,
    pub include_armature: bool,
    pub extra_clips: Vec<ClipPick>,
    #[serde(default)]
    pub texture_max_dim: Option<u32>,
}

#[derive(Deserialize)]
pub struct ClipPick {
    pub animset_hash: String,
    pub clip_indices: Vec<u32>,
}

#[tauri::command]
pub fn export_moby_glb_with_options(
    level_folder: String,
    asset_tuid_hex: String,
    out_path: String,
    options: GlbExportOptions,
) -> Result<u64, String> {
    use lunalib::{read_moby_assets_with_total, read_tie_assets_with_total};

    let level_path = std::path::Path::new(&level_folder);
    let target_tuid = u64::from_str_radix(
        asset_tuid_hex
            .trim_start_matches("0x")
            .trim_start_matches("0X"),
        16,
    )
    .map_err(|e| format!("parse asset tuid {asset_tuid_hex}: {e}"))?;

    let layout = lunalib::detect_layout(level_path).map_err(|e| e.to_string())?;

    let mut moby_asset: Option<lunalib::MobyAsset> = None;
    let mut tie_asset: Option<lunalib::TieAsset> = None;
    match layout {
        LevelLayout::V2 => {
            read_moby_assets_with_total(
                level_path,
                Some(&[target_tuid]),
                |_| {},
                |a| {
                    if a.tuid == target_tuid {
                        moby_asset = Some(a);
                    }
                },
            )
            .map_err(|e| e.to_string())?;
            if moby_asset.is_none() {
                read_tie_assets_with_total(
                    level_path,
                    Some(&[target_tuid]),
                    |_| {},
                    |a| {
                        if a.tuid == target_tuid {
                            tie_asset = Some(a);
                        }
                    },
                )
                .map_err(|e| e.to_string())?;
            }
        }
        LevelLayout::Tod => {
            lunalib::read_moby_assets_old(level_path, |a| {
                if a.tuid == target_tuid {
                    moby_asset = Some(a);
                }
            })
            .map_err(|e| e.to_string())?;
            if moby_asset.is_none() {
                lunalib::read_tie_assets_old(level_path, |a| {
                    if a.tuid == target_tuid {
                        tie_asset = Some(a);
                    }
                })
                .map_err(|e| e.to_string())?;
            }
        }
        LevelLayout::Rfom => {
            lunalib::read_moby_assets_rfom(level_path, |a| {
                if a.tuid == target_tuid {
                    moby_asset = Some(a);
                }
            })
            .map_err(|e| e.to_string())?;
            if moby_asset.is_none() {
                lunalib::read_tie_assets_rfom(level_path, |a| {
                    if a.tuid == target_tuid {
                        tie_asset = Some(a);
                    }
                })
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let mut synthetic_from_tie = false;
    let asset = match moby_asset {
        Some(a) => a,
        None => {
            let tie =
                tie_asset.ok_or_else(|| format!("asset {asset_tuid_hex} not found in level"))?;
            synthetic_from_tie = true;
            tie_as_moby(&tie)
        }
    };

    let asset = if options.include_armature {
        asset
    } else {
        let mut a = asset;
        a.skeleton = None;
        a
    };

    if !options.include_mesh {
        return Err("include_mesh=false is not yet supported (would produce empty GLB)".into());
    }

    let shaders = if options.include_materials {
        match layout {
            LevelLayout::V2 => read_shaders(level_path).map_err(|e| e.to_string())?,
            LevelLayout::Tod => lunalib::read_shaders_old(level_path).unwrap_or_default(),
            LevelLayout::Rfom => lunalib::read_shaders_rfom(level_path).unwrap_or_default(),
        }
    } else {
        HashMap::new()
    };

    let texture_pngs = if options.include_materials {
        let mut needed: HashSet<u32> = HashSet::new();
        for bangle in &asset.bangles {
            for m in &bangle.meshes {
                let (a, n, e) = resolve_shader_textures(
                    &shaders,
                    &asset.shader_tuids,
                    m.shader_index as usize,
                );
                for id in [a, n, e].into_iter().flatten() {
                    needed.insert(id);
                }
            }
        }

        let max_dim = options.texture_max_dim.unwrap_or(u32::MAX);
        let needed_ids: Vec<u32> = needed.iter().copied().collect();

        let cached_lookup = || -> HashMap<u32, Vec<u8>> {
            let cache_root = cache_root(&level_folder);
            let tex_dir = cache_root.join("textures");
            let mut out = HashMap::with_capacity(needed.len());
            for id in &needed_ids {
                let path = tex_dir.join(format!("{id}.png"));
                if let Ok(bytes) = fs::read(&path) {
                    let resized = if max_dim != 0 && max_dim < u32::MAX {
                        lunalib::downsample_png_to(&bytes, max_dim).unwrap_or(bytes)
                    } else {
                        bytes
                    };
                    out.insert(*id, resized);
                }
            }
            out
        };

        // For sub-512 quality presets, just resize cached PNGs (every layout writes them).
        if max_dim <= 512 && max_dim != 0 {
            cached_lookup()
        } else {
            match layout {
                LevelLayout::V2 => match lunalib::bulk_extract_pngs(level_path, Some(&needed_ids), max_dim) {
                    Ok(pngs) => pngs.into_iter().collect(),
                    Err(e) => {
                        eprintln!("warn: V2 bulk_extract_pngs failed: {e} — falling back to cache");
                        cached_lookup()
                    }
                },
                LevelLayout::Tod => match lunalib::read_textures_old(level_path) {
                    Ok(textures) => {
                        let want: HashSet<u32> = needed.iter().copied().collect();
                        let mut out: HashMap<u32, Vec<u8>> = HashMap::new();
                        for t in &textures {
                            if !want.contains(&t.id) {
                                continue;
                            }
                            if let Some(png) = lunalib::texture_to_png(t) {
                                let resized = if max_dim != 0 && max_dim < u32::MAX {
                                    lunalib::downsample_png_to(&png, max_dim).unwrap_or(png)
                                } else {
                                    png
                                };
                                out.insert(t.id, resized);
                            }
                        }
                        out
                    }
                    Err(e) => {
                        eprintln!("warn: TOD texture re-extract failed: {e} — falling back to cache");
                        cached_lookup()
                    }
                },
                LevelLayout::Rfom => match lunalib::read_textures_rfom(level_path) {
                    Ok(textures) => {
                        let want: HashSet<u32> = needed.iter().copied().collect();
                        let mut out: HashMap<u32, Vec<u8>> = HashMap::new();
                        for t in &textures {
                            if !want.contains(&t.id) {
                                continue;
                            }
                            if let Some(png) = lunalib::texture_rfom_to_png(t) {
                                let resized = if max_dim != 0 && max_dim < u32::MAX {
                                    lunalib::downsample_png_to(&png, max_dim).unwrap_or(png)
                                } else {
                                    png
                                };
                                out.insert(t.id, resized);
                            }
                        }
                        out
                    }
                    Err(e) => {
                        eprintln!("warn: RFOM texture re-extract failed: {e} — falling back to cache");
                        cached_lookup()
                    }
                },
            }
        }
    } else {
        HashMap::new()
    };

    let mut clips: Vec<DecodedClip> = Vec::new();
    let animset_index = if matches!(layout, LevelLayout::V2) {
        AnimsetIndex::build(level_path).ok()
    } else {
        None
    };
    let animsets_path = level_path.join("animsets.dat");
    let mut animsets_file = if matches!(layout, LevelLayout::V2) {
        std::fs::File::open(&animsets_path).ok()
    } else {
        None
    };

    if options.include_armature && !synthetic_from_tie {
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

        if matches!(layout, LevelLayout::Rfom | LevelLayout::Tod)
            && !asset.rfom_anim_offsets.is_empty()
        {
            if let Some(skel) = asset.skeleton.as_ref() {
                let main_dat = match layout {
                    LevelLayout::Tod => "main.dat",
                    _ => "ps3levelmain.dat",
                };
                clips.extend(decode_clips_for_moby_inline(
                    level_path,
                    main_dat,
                    &asset.rfom_anim_offsets,
                    pos_scale,
                    scale_scale,
                    skel,
                    layout,
                ));
            }
        }

        if let (Some(hash), Some(idx), Some(file)) = (
            asset.animset_hash,
            animset_index.as_ref(),
            animsets_file.as_mut(),
        ) {
            clips
                .extend(decode_clips_for_moby(level_path, idx, file, hash, pos_scale, scale_scale));
        }

        if !options.extra_clips.is_empty() && !matches!(layout, LevelLayout::V2) {
            eprintln!(
                "warn: extra_clips picker is V2-only; {} pick(s) ignored for {} layout",
                options.extra_clips.len(),
                layout.tag()
            );
        }

        if let (Some(idx), Some(file)) = (animset_index.as_ref(), animsets_file.as_mut()) {
            for pick in &options.extra_clips {
                let hex = pick.animset_hash.trim_start_matches("0x").trim_start_matches("0X");
                let Ok(hash) = u64::from_str_radix(hex, 16) else { continue };
                if Some(hash) == asset.animset_hash {
                    continue;
                }
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
                let extras =
                    decode_clips_for_moby(level_path, idx, file, hash, pos_scale, scale_scale);
                if pick.clip_indices.is_empty() {
                    clips.extend(extras);
                } else {
                    let want: HashSet<u32> = pick.clip_indices.iter().copied().collect();
                    for (i, clip) in extras.into_iter().enumerate() {
                        if want.contains(&(i as u32)) {
                            clips.push(clip);
                        }
                    }
                }
            }
        }
    }

    let glb_bytes = lunalib::write_moby_glb_full(&asset, &clips, &shaders, &texture_pngs)
        .map_err(|e| format!("GLB build failed: {e}"))?;

    fs::write(&out_path, &glb_bytes)
        .map_err(|e| format!("write {out_path}: {e}"))?;
    Ok(glb_bytes.len() as u64)
}

#[tauri::command]
pub fn export_skybox(
    level_folder: String,
    format: String,
    out_path: String,
) -> Result<u64, String> {
    let root = cache_root(&level_folder);
    let file = match format.as_str() {
        "glb" => "skybox/sky.glb",
        "obj" => "skybox/sky.obj",
        "ply" => "skybox/sky.ply",
        "json" => "skybox/sky.json",
        other => return Err(format!("Unsupported skybox format: {other}")),
    };
    let src = root.join(file);
    if !src.is_file() {
        return Err(format!(
            "Skybox not in cache yet ({}). Re-extract the level.",
            file
        ));
    }
    fs::copy(&src, &out_path)
        .map_err(|e| format!("copy {} → {}: {e}", src.display(), out_path))
}

#[tauri::command]
pub fn read_cached_skybox_meta(level_folder: String) -> Result<serde_json::Value, String> {
    let root = cache_root(&level_folder);
    let meta = root.join("skybox/sky.json");
    if !meta.is_file() {
        return Err("no skybox in cache".into());
    }
    let bytes = fs::read(&meta).map_err(|e| format!("read {}: {e}", meta.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse skybox meta: {e}"))
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

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LevelGlbExportEvent {
    Phase { label: &'static str, total: usize },
    Progress { current: usize },
    Done { bytes_written: usize, instance_count: usize, asset_count: usize },
    Error { message: String },
}

#[tauri::command]
pub fn export_level_glb(
    level_folder: String,
    out_path: String,
    on_event: Channel<LevelGlbExportEvent>,
) -> Result<(), String> {
    if let Err(message) = run_export_level_glb(&level_folder, &out_path, &on_event) {
        let _ = on_event.send(LevelGlbExportEvent::Error { message: message.clone() });
        return Err(message);
    }
    Ok(())
}

fn run_export_level_glb(
    level_folder: &str,
    out_path: &str,
    on_event: &Channel<LevelGlbExportEvent>,
) -> Result<(), String> {
    use base64::engine::general_purpose::STANDARD as BASE64;

    let _ = on_event.send(LevelGlbExportEvent::Phase {
        label: "Reading placements",
        total: 1,
    });

    let mobys = crate::real_moby_layout(level_folder).unwrap_or_default();
    let ties = crate::real_tie_layout(level_folder).unwrap_or_default();

    if mobys.is_empty() && ties.is_empty() {
        return Err("No placements found in this level. Open and extract the level cache first.".into());
    }

    let _ = on_event.send(LevelGlbExportEvent::Phase {
        label: "Loading assets",
        total: mobys.len() + ties.len(),
    });

    let cache_root = cache_root(level_folder);
    let mut asset_idx_by_tuid: HashMap<(String, &'static str), usize> = HashMap::new();
    let mut assets: Vec<lunalib::level_glb::LevelGlbAsset> = Vec::new();
    let mut needed_textures: HashSet<u32> = HashSet::new();

    let mut load_one = |kind_name: &'static str, asset_tuid: &str| -> Result<Option<usize>, String> {
        let key = (asset_tuid.to_string(), kind_name);
        if let Some(idx) = asset_idx_by_tuid.get(&key) {
            return Ok(Some(*idx));
        }
        let folder = match kind_name {
            "moby" => "mobys",
            "detail" => "details",
            _ => "ties",
        };
        let primary = cache_root.join(folder).join(format!("{}.json", asset_tuid));
        let bytes = match fs::read(&primary) {
            Ok(b) => b,
            Err(_) => {
                // Fallback: detail JSONs may have been routed to ties/ in older
                // caches, or vice versa.
                let alt = if folder == "details" {
                    cache_root.join("ties").join(format!("{}.json", asset_tuid))
                } else if folder == "ties" {
                    cache_root.join("details").join(format!("{}.json", asset_tuid))
                } else {
                    primary.clone()
                };
                match fs::read(&alt) {
                    Ok(b) => b,
                    Err(_) => return Ok(None),
                }
            }
        };
        let dto: AssetMeshesDto = serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse {}: {e}", primary.display()))?;
        let mut submeshes: Vec<lunalib::level_glb::LevelGlbSubmesh> =
            Vec::with_capacity(dto.submeshes.len());
        for m in &dto.submeshes {
            let positions = decode_f32_b64(&m.positions_b64, &BASE64)?;
            let uvs = decode_f32_b64(&m.uvs_b64, &BASE64)?;
            let indices = decode_u32_b64(&m.indices_b64, &BASE64)?;
            if let Some(id) = m.albedo_id {
                needed_textures.insert(id);
            }
            submeshes.push(lunalib::level_glb::LevelGlbSubmesh {
                positions,
                uvs,
                indices,
                albedo_id: m.albedo_id,
            });
        }
        let idx = assets.len();
        assets.push(lunalib::level_glb::LevelGlbAsset {
            name: if dto.name.is_empty() { asset_tuid.to_string() } else { dto.name.clone() },
            submeshes,
        });
        asset_idx_by_tuid.insert(key, idx);
        Ok(Some(idx))
    };

    let mut instances: Vec<lunalib::level_glb::LevelGlbInstance> = Vec::new();
    let mut progress: usize = 0;

    for inst in &mobys {
        progress += 1;
        if progress % 16 == 0 {
            let _ = on_event.send(LevelGlbExportEvent::Progress { current: progress });
        }
        if let Some(idx) = load_one("moby", &inst.asset_tuid)? {
            instances.push(lunalib::level_glb::LevelGlbInstance {
                asset_idx: idx,
                name: format!("moby:{}:{}", inst.name, inst.tuid),
                translation: inst.position,
                rotation: inst.quaternion,
                scale: inst.scale,
            });
        }
    }
    for inst in &ties {
        progress += 1;
        if progress % 16 == 0 {
            let _ = on_event.send(LevelGlbExportEvent::Progress { current: progress });
        }
        let kind_name: &'static str = if inst.kind == "detail" { "detail" } else { "tie" };
        if let Some(idx) = load_one(kind_name, &inst.asset_tuid)? {
            instances.push(lunalib::level_glb::LevelGlbInstance {
                asset_idx: idx,
                name: format!("{}:{}:{}", kind_name, inst.name, inst.tuid),
                translation: inst.position,
                rotation: inst.quaternion,
                scale: inst.scale,
            });
        }
    }

    let _ = on_event.send(LevelGlbExportEvent::Progress { current: progress });

    let _ = on_event.send(LevelGlbExportEvent::Phase {
        label: "Loading textures",
        total: needed_textures.len(),
    });

    let mut textures: HashMap<u32, Vec<u8>> = HashMap::new();
    let textures_dir = cache_root.join("textures");
    let mut tex_progress = 0usize;
    for tex_id in &needed_textures {
        tex_progress += 1;
        if tex_progress % 16 == 0 {
            let _ = on_event.send(LevelGlbExportEvent::Progress { current: tex_progress });
        }
        let path = textures_dir.join(format!("{}.png", tex_id));
        if let Ok(b) = fs::read(&path) {
            textures.insert(*tex_id, b);
        }
    }
    let _ = on_event.send(LevelGlbExportEvent::Progress { current: tex_progress });

    let _ = on_event.send(LevelGlbExportEvent::Phase {
        label: "Writing GLB",
        total: 1,
    });

    let glb_bytes = lunalib::level_glb::write_static_level_glb(&assets, &instances, &textures)
        .map_err(|e| format!("write_static_level_glb: {e}"))?;

    fs::write(out_path, &glb_bytes).map_err(|e| format!("write {out_path}: {e}"))?;

    let _ = on_event.send(LevelGlbExportEvent::Done {
        bytes_written: glb_bytes.len(),
        instance_count: instances.len(),
        asset_count: assets.len(),
    });

    Ok(())
}

fn decode_f32_b64(
    s: &str,
    engine: &base64::engine::general_purpose::GeneralPurpose,
) -> Result<Vec<f32>, String> {
    use base64::Engine as _;
    let bytes = engine.decode(s).map_err(|e| format!("base64: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(format!("f32 buffer length {} not /4", bytes.len()));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(out)
}

fn decode_u32_b64(
    s: &str,
    engine: &base64::engine::general_purpose::GeneralPurpose,
) -> Result<Vec<u32>, String> {
    use base64::Engine as _;
    let bytes = engine.decode(s).map_err(|e| format!("base64: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(format!("u32 buffer length {} not /4", bytes.len()));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(out)
}

#[tauri::command]
pub fn export_texture_png(
    level_folder: String,
    tex_id: u32,
    out_path: String,
) -> Result<u64, String> {
    let cache_root = cache_root(&level_folder);
    let src = cache_root.join("textures").join(format!("{}.png", tex_id));
    fs::copy(&src, &out_path)
        .map_err(|e| format!("copy {} → {}: {e}", src.display(), out_path))
}

#[tauri::command]
pub fn export_texture_dds(
    level_folder: String,
    tex_id: u32,
    out_path: String,
) -> Result<u64, String> {
    let cache_root = cache_root(&level_folder);
    let src = cache_root.join("textures").join(format!("{}.png", tex_id));
    let png_bytes =
        fs::read(&src).map_err(|e| format!("read {}: {e}", src.display()))?;
    let dds_bytes = lunalib::dds::png_to_uncompressed_dds(&png_bytes)
        .map_err(|e| format!("png→dds: {e}"))?;
    fs::write(&out_path, &dds_bytes)
        .map_err(|e| format!("write {}: {e}", out_path))?;
    Ok(dds_bytes.len() as u64)
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

#[derive(Serialize)]
pub struct AnimsetClipMeta {
    pub name: String,
    pub num_frames: u16,
    pub frame_rate: f32,
    pub looping: bool,
}

#[derive(Serialize)]
pub struct AnimsetSummary {
    pub hash: String,
    pub clips: Vec<AnimsetClipMeta>,
}

#[derive(Serialize)]
pub struct DecodedBoneDto {
    pub rotations: Vec<f32>,
    pub translations: Vec<f32>,
    pub scales: Vec<f32>,
    pub rotation_animated: bool,
    pub translation_animated: bool,
    pub scale_animated: bool,
}

#[derive(Serialize)]
pub struct DecodedClipDto {
    pub name: String,
    pub num_frames: u16,
    pub frame_rate: f32,
    pub looping: bool,
    pub bones: Vec<DecodedBoneDto>,
}

#[tauri::command]
pub fn decode_animset_clip(
    folder: String,
    asset_tuid_hex: String,
    animset_hash: String,
    clip_index: u32,
) -> Result<DecodedClipDto, String> {
    use lunalib::read_moby_assets_with_total;
    use std::io::{Read, Seek, SeekFrom};

    let level_path = std::path::Path::new(&folder);
    let target_tuid = u64::from_str_radix(
        asset_tuid_hex.trim_start_matches("0x").trim_start_matches("0X"),
        16,
    )
    .map_err(|e| format!("parse asset tuid: {e}"))?;
    let target_animset = u64::from_str_radix(
        animset_hash.trim_start_matches("0x").trim_start_matches("0X"),
        16,
    )
    .map_err(|e| format!("parse animset hash: {e}"))?;

    let mut moby_skeleton: Option<lunalib::Skeleton> = None;
    read_moby_assets_with_total(
        level_path,
        Some(&[target_tuid]),
        |_| {},
        |a| {
            if a.tuid == target_tuid {
                moby_skeleton = a.skeleton.clone();
            }
        },
    )
    .map_err(|e| e.to_string())?;
    let skeleton = moby_skeleton
        .ok_or_else(|| format!("asset {asset_tuid_hex} has no skeleton"))?;

    let trans_shift = skeleton.translation_shift;
    let scale_shift_v = skeleton.scale_shift;
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

    let lookup_path = level_path.join("assetlookup.dat");
    let lookup_file =
        std::fs::File::open(&lookup_path).map_err(|e| format!("open {lookup_path:?}: {e}"))?;
    let mut lookup =
        AssetLookup::open(std::io::BufReader::new(lookup_file)).map_err(|e| e.to_string())?;
    let ptrs = lookup
        .pointers(AssetKind::Animset)
        .map_err(|e| format!("read animset table: {e}"))?;
    let ptr = ptrs
        .iter()
        .find(|p| p.tuid == target_animset)
        .ok_or_else(|| format!("animset {animset_hash} not found in level"))?;

    let animsets_path = level_path.join("animsets.dat");
    let mut animsets_file =
        std::fs::File::open(&animsets_path).map_err(|e| format!("open {animsets_path:?}: {e}"))?;
    animsets_file
        .seek(SeekFrom::Start(u64::from(ptr.offset)))
        .map_err(|e| format!("seek animset: {e}"))?;
    let mut buf = vec![0u8; ptr.length as usize];
    animsets_file
        .read_exact(&mut buf)
        .map_err(|e| format!("read animset: {e}"))?;
    let mut ig =
        IgFile::open(std::io::Cursor::new(buf)).map_err(|e| format!("ighw open: {e}"))?;

    let offsets = animation_section_offsets(&ig);
    let off = offsets
        .get(clip_index as usize)
        .copied()
        .ok_or_else(|| format!("clip index {clip_index} out of range ({} clips)", offsets.len()))?;
    let header = read_animation_header_at(&mut ig, off).map_err(|e| format!("header: {e}"))?;
    let ctrl =
        read_animation_control(&mut ig, &header).map_err(|e| format!("control: {e}"))?;
    let clip = decode_animation(&mut ig, &header, &ctrl, pos_scale, scale_scale)
        .map_err(|e| format!("decode: {e}"))?;

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

#[tauri::command]
pub fn list_animsets(folder: String) -> Result<Vec<AnimsetSummary>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let level_path = std::path::Path::new(&folder);

    // TOD and RFOM layouts have no `assetlookup.dat` / `animsets.dat`
    // — animation data isn't yet ported for either layout. Surface an
    // empty list rather than a hard error so the UI doesn't show a
    // misleading "animset list failed" warning every time a non-V2
    // level loads.
    match detect_layout(level_path) {
        Ok(LevelLayout::Tod) | Ok(LevelLayout::Rfom) => return Ok(Vec::new()),
        _ => {}
    }

    let lookup_path = level_path.join("assetlookup.dat");
    let lookup_file =
        std::fs::File::open(&lookup_path).map_err(|e| format!("open {lookup_path:?}: {e}"))?;
    let mut lookup = AssetLookup::open(std::io::BufReader::new(lookup_file))
        .map_err(|e| e.to_string())?;
    let ptrs = lookup
        .pointers(AssetKind::Animset)
        .map_err(|e| format!("read animset table: {e}"))?;

    let animsets_path = level_path.join("animsets.dat");
    let mut animsets_file =
        std::fs::File::open(&animsets_path).map_err(|e| format!("open {animsets_path:?}: {e}"))?;

    let mut out = Vec::with_capacity(ptrs.len());
    for ptr in ptrs {
        if animsets_file
            .seek(SeekFrom::Start(u64::from(ptr.offset)))
            .is_err()
        {
            continue;
        }
        let mut buf = vec![0u8; ptr.length as usize];
        if animsets_file.read_exact(&mut buf).is_err() {
            continue;
        }
        let mut ig = match IgFile::open(std::io::Cursor::new(buf)) {
            Ok(ig) => ig,
            Err(_) => continue,
        };
        let offsets = animation_section_offsets(&ig);
        let mut clips = Vec::with_capacity(offsets.len());
        for off in offsets {
            if let Ok(h) = read_animation_header_at(&mut ig, off) {
                let looping = h.is_looping();
                clips.push(AnimsetClipMeta {
                    name: h.name,
                    num_frames: h.num_frames,
                    frame_rate: h.frame_rate,
                    looping,
                });
            }
        }
        out.push(AnimsetSummary {
            hash: format!("0x{:016X}", ptr.tuid),
            clips,
        });
    }
    Ok(out)
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
        rfom_anim_offsets: Vec::new(),
    }
}

