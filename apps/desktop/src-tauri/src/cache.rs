//! Per-level disk cache.
//!
//! Writes parsed mobys / ties / textures into
//! `<level_folder>/_rechimera_cache/` so the Library / preview / GLB-export
//! flows can read them back without re-parsing the source `.dat` files
//! every time.
//!
//! Layout:
//!
//! ```text
//! _rechimera_cache/
//!   manifest.json              -- index of every cached asset (this file)
//!   mobys/<tuid>.json          -- AssetMeshesDto (geometry + skeleton)
//!   ties/<tuid>.json           -- AssetMeshesDto
//!   textures/<id>.png          -- decoded + downsampled PNG (≤512px)
//! ```
//!
//! The JSON shape inside `mobys/*.json` and `ties/*.json` is the same
//! `AssetMeshesDto` the streaming pipeline emits, so the FE consumes both
//! identically.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use lunalib::{
    decode_animation, downsample_rgba, encode_png, read_animation_control,
    read_animation_header, read_moby_assets_with_total, read_shaders,
    read_textures_with_total, read_tie_assets_with_total,
    AssetKind, AssetLookup, DecodedClip, IgFile, ShaderInfo,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::{build_skeleton_dto, mesh_dto, resolve_shader_textures, AssetMeshesDto};

const CACHE_DIR_NAME: &str = "_rechimera_cache";
const MANIFEST_NAME: &str = "manifest.json";
/// Bumped to 2 when `source_mtimes` was added to the manifest. Older
/// caches (version 1) are always reported stale so a re-extract picks
/// up the new snapshot.
const MANIFEST_VERSION: u32 = 2;
const TEXTURE_MAX_DIM: u32 = 512;

/// Source `.dat` files we snapshot mtimes for. Used to flag cache
/// staleness when any of them change. Missing files are silently
/// skipped — not every level has every kind (e.g. small test maps
/// may lack `animsets.dat`).
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
    /// `"moby"`, `"tie"`, or `"texture"`.
    pub kind: String,
    /// Hex TUID for mobys/ties; decimal id for textures (matches the
    /// streaming pipeline's `albedo_id` / `normal_id` / `emissive_id`).
    pub tuid: String,
    /// Human-readable name when known. Empty for textures and unnamed
    /// assets.
    pub name: String,
    /// Path of the cached file relative to the cache root (e.g.
    /// `"mobys/0xABC.json"` or `"textures/12345.png"`).
    pub file: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Deserialize)]
pub struct CacheManifest {
    pub version: u32,
    pub folder: String,
    pub entries: Vec<CacheManifestEntry>,
    /// Snapshot of source-file mtimes (UNIX seconds) at extract time.
    /// Missing on v1 manifests; we use that as a "always stale" signal
    /// so old caches get rebuilt.
    #[serde(default)]
    pub source_mtimes: HashMap<String, u64>,
}

/// Quick check the FE uses to decide whether to offer "Extract assets" vs
/// "Browse cache". A `false` `exists` means there's no cache directory
/// at all; `true` plus an `entry_count > 0` means we have something
/// browsable.
#[derive(Serialize)]
pub struct CacheStatus {
    pub exists: bool,
    pub folder: String,
    /// Path to the cache root (whether it exists or not — useful for the
    /// FE to display "will be created at: …").
    pub cache_path: String,
    pub entry_count: usize,
    /// Per-kind tally so the UI can show "232 mobys / 411 ties / 503
    /// textures" in the status bar.
    pub mobys: usize,
    pub ties: usize,
    pub textures: usize,
    /// `true` when at least one source `.dat` has a newer mtime than
    /// the snapshot taken at extract time, OR when the manifest is from
    /// a pre-mtime version. Drives the "Cache stale, re-extract?" hint
    /// in the UI.
    pub stale: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CacheEvent {
    /// Start of a new extraction phase. `total` is the item count for
    /// this phase.
    Phase {
        phase: &'static str,
        total: usize,
    },
    /// One asset finished + written to disk.
    Item {
        kind: &'static str,
        name: String,
    },
    /// Items completed within the current phase.
    Progress {
        current: usize,
    },
    /// Whole extraction finished — manifest written.
    Done {
        entry_count: usize,
    },
    /// Fatal error — extraction aborted before completion.
    Error {
        message: String,
    },
}

fn cache_root(folder: &str) -> PathBuf {
    Path::new(folder).join(CACHE_DIR_NAME)
}

/// UNIX seconds for the file's last-modified time. `None` when the
/// file doesn't exist or the platform clock is misbehaving (mtime
/// before 1970 — shouldn't happen on real PS3 dumps, but we don't
/// want to panic on a freshly-set wall clock).
fn mtime_unix_secs(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_secs())
}

/// Snapshot mtimes for all known source `.dat` files in the level
/// folder. Files that don't exist on disk are simply absent from the
/// returned map.
fn snapshot_source_mtimes(folder: &Path) -> HashMap<String, u64> {
    let mut out = HashMap::with_capacity(SOURCE_FILES.len());
    for name in SOURCE_FILES {
        if let Some(mt) = mtime_unix_secs(&folder.join(name)) {
            out.insert((*name).to_string(), mt);
        }
    }
    out
}

/// True when any tracked source has a newer mtime than the manifest's
/// snapshot, OR when the manifest's snapshot is empty (= pre-mtime
/// manifest version). Files that disappeared since extract are NOT
/// considered stale — only the converse direction matters for "should
/// I re-extract".
fn is_cache_stale(folder: &Path, snapshot: &HashMap<String, u64>) -> bool {
    if snapshot.is_empty() {
        return true;
    }
    for (name, &snap) in snapshot {
        let current = match mtime_unix_secs(&folder.join(name)) {
            Some(m) => m,
            None => continue, // file gone — not stale-relevant
        };
        if current > snap {
            return true;
        }
    }
    false
}

/// Per-level lookup `animset_hash → (offset, length)` into `animsets.dat`.
/// Built once at the start of cache extraction so the moby loop can
/// resolve clips with a single HashMap lookup instead of re-walking
/// `assetlookup.dat`'s 0x1D700 table N times.
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

/// Decode the animation clip referenced by a moby's `animset_hash`.
/// Mirrors main.rs's `fetch_animset_clip` but returns the lunalib
/// `DecodedClip` directly so we can pass it into the GLB writer
/// without going through the JSON DTO. Returns `None` when the moby
/// has no animset, the animset isn't in the lookup, or decoding
/// fails — extraction continues with no animation in that case.
fn decode_clip_for_moby(
    level_folder: &Path,
    index: &AnimsetIndex,
    animsets_file: &mut std::fs::File,
    animset_hash: u64,
    position_scale: f32,
    scale_scale: f32,
) -> Option<DecodedClip> {
    let (offset, length) = *index.by_hash.get(&animset_hash)?;
    use std::io::{Read, Seek, SeekFrom};
    if animsets_file
        .seek(SeekFrom::Start(u64::from(offset)))
        .is_err()
    {
        return None;
    }
    let mut buf = vec![0u8; length as usize];
    if animsets_file.read_exact(&mut buf).is_err() {
        return None;
    }
    let mut ig = IgFile::open(std::io::Cursor::new(buf)).ok()?;
    let header = read_animation_header(&mut ig).ok().flatten()?;
    let ctrl = read_animation_control(&mut ig, &header).ok()?;
    decode_animation(&mut ig, &header, &ctrl, position_scale, scale_scale).ok().or_else(
        || {
            eprintln!(
                "warn: animset 0x{animset_hash:016X} decode failed for level {level_folder:?}"
            );
            None
        },
    )
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

    let shaders: HashMap<u64, ShaderInfo> =
        read_shaders(level_path).map_err(|e| e.to_string())?;

    // Animset lookup, built once per level. Per-moby clip decode below
    // hits this O(1) HashMap to find the animset slice in animsets.dat.
    // Missing animsets.dat or empty 0x1D700 table → no animations
    // baked, GLBs ship without anim data (still renderable).
    let animset_index = AnimsetIndex::build(level_path).ok();
    let animsets_path = level_path.join("animsets.dat");
    let mut animsets_file = std::fs::File::open(&animsets_path).ok();

    let mut entries: Vec<CacheManifestEntry> = Vec::new();
    let mut needed_textures: HashSet<u32> = HashSet::new();

    // Hold parsed mobys + ties across phases so phase 4 (GLB writing)
    // can embed texture bytes after phase 3 decodes them. Without this
    // either we'd re-parse everything (wasteful) or write GLBs without
    // material data (regression). Memory cost ~50MB on dense levels.
    let mut moby_assets_for_glb: Vec<lunalib::MobyAsset> = Vec::new();
    let mut tie_assets_for_glb: Vec<lunalib::TieAsset> = Vec::new();

    // ── Phase 1: mobys ──
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
                // Stash a clone for phase 4 (GLB writing — needs to
                // happen AFTER textures decode so material bytes can
                // be embedded).
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

    // ── Phase 2: ties ──
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
            // Stash for phase 4 (GLB writing).
            tie_assets_for_glb.push(asset.clone());
            // Ties don't carry path-style names like mobys do — the FE
            // falls back to a truncated TUID for the leaf label.
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

    // ── Phase 3: textures ──
    // Streamed per-texture (not via `bulk_extract_pngs`): the bulk
    // variant returns ALL pngs in one shot, blocking the worker
    // thread for many seconds and starving the progress channel.
    // Streaming lets us emit a Progress event after each texture's
    // decode + downsample + PNG encode, so the UI never appears
    // frozen during the texture phase.
    let needed_set = needed_textures.clone();
    let texture_count_estimate = needed_set.len();
    let _ = on_event.send(CacheEvent::Phase {
        phase: "textures",
        total: texture_count_estimate,
    });
    let mut tex_done = 0usize;
    let accept = |id: u32| -> bool { needed_set.contains(&id) };
    let on_total = |_total: usize| {};
    // In-memory PNG map for embedding into GLBs in phase 4. Memory
    // peaks at the texture-decode high-water mark (~50MB on bayou
    // for 200-300 textures), then is consumed by phase 4 and dropped.
    let mut texture_pngs: HashMap<u32, Vec<u8>> = HashMap::new();
    let mut on_each = |tex: lunalib::Texture| {
        let id = tex.id;
        if tex.rgba.is_empty() || tex.width == 0 || tex.height == 0 {
            tex_done += 1;
            let _ = on_event.send(CacheEvent::Progress { current: tex_done });
            return;
        }
        let (rgba, w, h) =
            downsample_rgba(tex.rgba, tex.width, tex.height, TEXTURE_MAX_DIM);
        if rgba.is_empty() {
            tex_done += 1;
            let _ = on_event.send(CacheEvent::Progress { current: tex_done });
            return;
        }
        let png = encode_png(&rgba, w, h);
        if png.is_empty() {
            tex_done += 1;
            let _ = on_event.send(CacheEvent::Progress { current: tex_done });
            return;
        }
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
        // Keep PNG bytes in memory for GLB embedding in phase 4.
        texture_pngs.insert(id, png);
        tex_done += 1;
        let _ = on_event.send(CacheEvent::Progress { current: tex_done });
    };
    read_textures_with_total(level_path, accept, on_total, &mut on_each)
        .map_err(|e| e.to_string())?;

    // ── Phase 4: write GLBs with materials embedded ──
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
                let pos_scale = 2f32.powi(asset.bind_pose_inverse_offset as i32);
                let scale_scale = asset
                    .skeleton
                    .as_ref()
                    .map(|s| 2f32.powi(s.scale_shift as i32))
                    .unwrap_or(1.0);
                decode_clip_for_moby(level_path, idx, file, hash, pos_scale, scale_scale)
                    .into_iter()
                    .collect()
            }
            _ => Vec::new(),
        };
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
    // Ties: same shape, no skeleton/animations — but we ship them
    // through the moby GLB writer with empty skeleton so the same
    // material pipeline runs. lunalib's MobyAsset → tie adapter is a
    // future cleanup; for now we'd need a sibling `write_tie_glb_full`.
    // Skipping tie GLBs in this turn since the writer signature is
    // moby-shaped. Ties continue to ship as JSON via the existing
    // path; their GLB conversion is a follow-up.
    let _ = tie_assets_for_glb; // suppress unused warning

    // ── Final: write manifest ──
    let manifest = CacheManifest {
        version: MANIFEST_VERSION,
        folder: folder.to_string(),
        entries,
        source_mtimes: snapshot_source_mtimes(level_path),
    };
    let manifest_path = root.join(MANIFEST_NAME);
    write_json(&manifest_path, &manifest)?;
    Ok(manifest.entries.len())
}

#[tauri::command]
pub fn cache_status(folder: String) -> Result<CacheStatus, String> {
    let root = cache_root(&folder);
    let manifest_path = root.join(MANIFEST_NAME);
    if !manifest_path.is_file() {
        return Ok(CacheStatus {
            exists: false,
            folder,
            cache_path: root.to_string_lossy().into_owned(),
            entry_count: 0,
            mobys: 0,
            ties: 0,
            textures: 0,
            stale: false,
        });
    }
    let bytes = fs::read(&manifest_path)
        .map_err(|e| format!("read {manifest_path:?}: {e}"))?;
    let manifest: CacheManifest = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse manifest: {e}"))?;
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
    Ok(CacheStatus {
        exists: true,
        folder,
        cache_path: root.to_string_lossy().into_owned(),
        entry_count: manifest.entries.len(),
        mobys,
        ties,
        textures,
        stale,
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

/// Copy a moby's cached `.glb` (geometry + skeleton + animations +
/// textures, all baked in by the G4 pipeline) to a user-chosen path.
/// This is the correct export path — `exportToGlb` in `export.ts`
/// goes through Three.js's GLTFExporter and inherits the bind-pose
/// math bugs we've been chasing. Copying the pre-baked GLB sidesteps
/// all of that.
#[tauri::command]
pub fn export_cached_moby_glb(
    level_folder: String,
    asset_tuid_hex: String,
    out_path: String,
) -> Result<u64, String> {
    let cache_glb = cache_root(&level_folder)
        .join("mobys")
        .join(format!("{asset_tuid_hex}.glb"));
    if !cache_glb.is_file() {
        return Err(format!(
            "Cached GLB not found at {} — re-extract the level cache first",
            cache_glb.display()
        ));
    }
    fs::copy(&cache_glb, &out_path).map_err(|e| {
        format!(
            "copy {} → {}: {e}",
            cache_glb.display(),
            out_path
        )
    })
}

#[tauri::command]
pub fn read_cached_asset(folder: String, file: String) -> Result<serde_json::Value, String> {
    let path = sanitized_cache_path(&folder, &file)?;
    let bytes = fs::read(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {file}: {e}"))
}

/// Raw bytes of a cache file. Used for PNGs (textures) — JSON files
/// should go through `read_cached_asset` instead so the FE doesn't
/// double-parse. Returns binary IPC (`tauri::ipc::Response`) so the
/// payload doesn't get JSON-serialized.
#[tauri::command]
pub fn read_cached_bytes(
    folder: String,
    file: String,
) -> Result<tauri::ipc::Response, String> {
    let path = sanitized_cache_path(&folder, &file)?;
    let bytes = fs::read(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Re-extract the cache from scratch. Wipes `_rechimera_cache/` and
/// re-runs the full extraction. Same progress-event channel as the
/// initial extraction.
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

/// Validate a manifest-supplied relative path against the cache root.
/// Any `..` segment, empty segment, or absolute path is rejected — a
/// crafted manifest can't escape the cache directory through this.
fn sanitized_cache_path(folder: &str, file: &str) -> Result<PathBuf, String> {
    if file.split(['/', '\\']).any(|seg| seg == ".." || seg.is_empty()) {
        return Err(format!("rejected path: {file}"));
    }
    if Path::new(file).is_absolute() {
        return Err(format!("rejected absolute path: {file}"));
    }
    Ok(cache_root(folder).join(file))
}

