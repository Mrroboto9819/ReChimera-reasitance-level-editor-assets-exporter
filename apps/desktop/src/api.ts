import { Channel, invoke } from "@tauri-apps/api/core";

export interface Section {
  id: number;
  offset: number;
  count: number;
  length: number;
}

export interface AssetCount {
  kind: AssetKind;
  section_id: number;
  count: number;
  present: boolean;
}

export interface LevelSummary {
  folder: string;
  version_major: number;
  version_minor: number;
  sections: Section[];
  asset_counts: AssetCount[];
}

export interface AssetPointer {
  /** 64-bit TUID rendered as `0x` + 16 hex chars (JS `number` would lose precision). */
  tuid: string;
  offset: number;
  length: number;
}

export type AssetKind =
  | "shader"
  | "texture"
  | "highmip"
  | "cubemap"
  | "tie"
  | "foliage"
  | "shrub"
  | "moby"
  | "animset"
  | "cinematic"
  | "zone"
  | "lighting";

export interface Instance {
  /** Unique placement key — instance TUID for real instances, synthetic for debug. */
  tuid: string;
  /** TUID of the underlying asset this is an instance of. */
  asset_tuid: string;
  kind: AssetKind;
  name: string;
  /** [x, y, z] world position. */
  position: [number, number, number];
  /** Unit quaternion `[x, y, z, w]` (three.js / glTF convention). */
  quaternion: [number, number, number, number];
  /** Per-axis scale. */
  scale: [number, number, number];
}

export const openLevel = (folder: string) =>
  invoke<LevelSummary>("open_level", { folder });

export const listAssets = (folder: string, kind: AssetKind) =>
  invoke<AssetPointer[]>("list_assets", { folder, kind });

export interface ManifestEntry {
  /** Hex TUID. */
  tuid: string;
  offset: number;
  length: number;
}

export interface ManifestGroup {
  kind: AssetKind;
  section_id: number;
  /** False for asset kinds enumerated but not yet decoded by lunalib
   *  (cubemap, foliage, shrub, cinematic, lighting, texture). The Hierarchy
   *  shows a "decoder pending" tag for these. */
  decoded: boolean;
  count: number;
  entries: ManifestEntry[];
}

export interface LevelManifest {
  folder: string;
  /** Engine generation. Currently always `"new"` (R2/R3/R&C ToD share the
   *  assetlookup-based path); RFOM old-engine reader will report `"old"`. */
  engine: "new" | "old";
  version_major: number;
  version_minor: number;
  sections: Section[];
  groups: ManifestGroup[];
}

export const buildLevelManifest = (folder: string) =>
  invoke<LevelManifest>("build_level_manifest", { folder });

// ── Disk cache (`<level_folder>/_rechimera_cache/`) ──

export interface CacheManifestEntry {
  /** `"moby"` | `"tie"` | `"texture"`. */
  kind: "moby" | "tie" | "texture";
  /** Hex TUID for mobys/ties; decimal id-as-string for textures. */
  tuid: string;
  /** Asset path-style name (mobys); empty for ties and textures. */
  name: string;
  /** Path under the cache root, e.g. `"mobys/0xABC.json"`. */
  file: string;
  size_bytes: number;
}

export interface CacheManifest {
  version: number;
  folder: string;
  entries: CacheManifestEntry[];
}

export interface CacheStatus {
  exists: boolean;
  folder: string;
  /** Absolute path to the cache root (whether it exists or not). */
  cache_path: string;
  entry_count: number;
  mobys: number;
  ties: number;
  textures: number;
  /** `true` when at least one source `.dat` is newer than the cache's
   *  mtime snapshot, OR when the manifest is from a pre-mtime version,
   *  OR when the previous extraction did not finish (`incomplete`).
   *  UI shows a "Stale — re-extract?" hint when this is set. */
  stale: boolean;
  /** `true` when the previous extraction was interrupted: either the
   *  manifest is missing entirely (recovered from a directory scan) or
   *  it's on disk but with `complete: false`. The prompt distinguishes
   *  this from plain "stale source files" so the message can read
   *  "last extraction did not finish". */
  incomplete: boolean;
}

export type CacheEvent =
  | { type: "phase"; phase: "mobys" | "ties" | "textures"; total: number }
  | { type: "item"; kind: "moby" | "tie" | "texture"; name: string }
  | { type: "progress"; current: number }
  | { type: "done"; entry_count: number }
  | { type: "error"; message: string };

export const cacheStatus = (folder: string) =>
  invoke<CacheStatus>("cache_status", { folder });

export const readCachedManifest = (folder: string) =>
  invoke<CacheManifest>("read_cached_manifest", { folder });

/** Returns parsed JSON of any file in the cache (typed as `unknown`; the
 *  caller knows the shape per `kind`). For mobys/ties this is the
 *  `AssetMeshesDto` shape — matches what the streaming pipeline emits. */
export const readCachedAsset = (folder: string, file: string) =>
  invoke<unknown>("read_cached_asset", { folder, file });

/** Raw bytes of a cache file. Used for PNGs since JSON-wrapping a binary
 *  payload is wasteful. Tauri returns an `ArrayBuffer` directly. */
export const readCachedBytes = (folder: string, file: string) =>
  invoke<ArrayBuffer>("read_cached_bytes", { folder, file });

export const extractLevelToCache = (
  folder: string,
  onEvent: Channel<CacheEvent>,
) => invoke<void>("extract_level_to_cache", { folder, onEvent });

export const reextractLevelCache = (
  folder: string,
  onEvent: Channel<CacheEvent>,
) => invoke<void>("reextract_level_cache", { folder, onEvent });

/** Copy a moby's cached `.glb` (with skeleton + animations + textures
 *  baked in by the Rust G4 pipeline) to the user-chosen path. Replaces
 *  the buggy `exportToGlb` (Three.js GLTFExporter) flow for cached
 *  assets — the pre-baked file works correctly in Blender. */
export const exportCachedMobyGlb = (
  levelFolder: string,
  assetTuidHex: string,
  outPath: string,
) =>
  invoke<number>("export_cached_moby_glb", {
    levelFolder,
    assetTuidHex,
    outPath,
  });

/** Helper: load a list of cached texture ids into a `TextureBlobMap` (the
 *  same shape `getLevelTexturesBulk` returns). Used by the cache library
 *  modal preview + GLB export so cached assets render with materials. */
export async function loadCachedTextures(
  folder: string,
  ids: number[],
): Promise<TextureBlobMap> {
  const out: TextureBlobMap = new Map();
  // Sequential for now — typical asset references 1-3 textures, so the
  // per-IPC overhead dominates anyway. If large materials become common
  // we'd switch to a `bulk` cache command similar to
  // `get_level_textures_bulk`.
  for (const id of ids) {
    try {
      const buf = await readCachedBytes(folder, `textures/${id}.png`);
      out.set(id, new Blob([buf], { type: "image/png" }));
    } catch {
      // Texture missing from cache — skip; the renderer falls back to
      // the default material.
    }
  }
  return out;
}

export interface UFragBounds {
  tuid: string;
  zone_tuid: string;
  position: [number, number, number];
  radius: number;
  vertex_count: number;
  triangle_count: number;
}

export interface LevelLayout {
  instances: Instance[];
  ufrags: UFragBounds[];
}

export const levelLayout = (folder: string) =>
  invoke<LevelLayout>("level_layout", { folder });

export interface MeshGeom {
  positions_b64: string;
  uvs_b64: string;
  indices_b64: string;
  /** Albedo texture ID (lower 32 bits of highmip TUID), or null when none. */
  albedo_id: number | null;
  /** Tangent-space normal map ID, or null. */
  normal_id: number | null;
  /** "Expensive" texture (often emission / specular pack), or null.
   *  Attached as the glTF emissiveMap on export. */
  emissive_id: number | null;
  /** Per-vertex global bone indices `[i0,i1,i2,i3, …]` (vertex_count * 4).
   *  Empty when this submesh isn't skinned. */
  bone_indices_b64: string;
  /** Per-vertex weights as u8 (0..255). Same length as `bone_indices`. */
  bone_weights_b64: string;
}

export interface DecodedMeshGeom {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  bone_indices: Uint16Array;
  bone_weights: Uint8Array<ArrayBuffer>;
}

export interface SkeletonInfo {
  /** Bone count — convenience so the UI doesn't have to count parents. */
  bone_count: number;
  /** Index of the root bone in `parents`. */
  root_bone: number;
  /** Per-bone parent index. -1 = root. */
  parents: number[];
  /** Local bind-pose matrices (column-major 4x4). IT-derived default:
   *  `tms1[parent] * tms0[child]`. Use `buildSkinnedAsset` with a
   *  `bindStrategy` other than `"it"` to have skinning.ts recompute
   *  these from `tms0_col` / `tms1_col`. */
  bind_local: number[][];
  /** World-space inverse bind-pose. Required by THREE.Skeleton. */
  bind_world_inverse: number[][];
  /** Raw on-disk `tms0` (column-major). Per IT, world FORWARD bind.
   *  Used by `buildSkinnedAsset` when `bindStrategy !== "it"`. May be
   *  missing on older cache JSONs that pre-date the strategy switcher. */
  tms0_col?: number[][];
  /** Raw on-disk `tms1` (column-major). Per IT, world INVERSE bind. */
  tms1_col?: number[][];
  /** Exponent used to scale animation scale-track values. */
  scale_shift: number;
  /** Exponent used to scale animation translation-track values
   *  (informational — moby.bind_pose_inverse_offset is what we pass to
   *  the backend). */
  translation_shift: number;
}

export interface AssetMeshes {
  asset_tuid: string;
  /** Path-style asset name from moby section 0xD200, e.g.
   *  `"entities/character/weapon/sawgun"`. Empty string for ties (no
   *  name section in tie data) or for mobys whose chunk has no name. */
  name: string;
  submeshes: MeshGeom[];
  /** Optional rig — present for animated mobys (characters, enemies,
   *  weapons), null for static props. Phase 1 surfaces metadata; full
   *  SkinnedMesh / animation playback come in later phases. */
  skeleton: SkeletonInfo | null;
  /** `MobyV2.animsetHash` — `"0x"`-prefixed 16-hex u64. Pass back to
   *  `fetchAnimsetClip` to load this character's animation. Null when
   *  the moby has no animset (props, ties, etc.). */
  animset_hash: string | null;
  /** Power-of-2 exponent — `position_scale = 2 ^ bind_pose_inverse_offset`.
   *  Used when calling `fetchAnimsetClip` so translation keyframes come
   *  back in the same space as the bind-pose. */
  bind_pose_inverse_offset: number;
}

export interface UFragMesh {
  tuid: string;
  zone_tuid: string;
  /** World-space position offset (apply as a translation when rendering). */
  position: [number, number, number];
  mesh: MeshGeom;
}

/** Texture metadata only — `png_b64` is gone. The streaming pipeline
 *  no longer ships PNG bytes; the frontend collects ids during
 *  streaming and fetches every texture's bytes via a single
 *  `getLevelTexturesBulk` call once the stream completes. The actual
 *  Blob bytes live in a parallel `Map<number, Blob>` that's passed
 *  alongside the metadata wherever a renderer needs the pixels. */
export interface TexturePayload {
  id: number;
  width: number;
  height: number;
}

/** Map keyed by texture id → PNG bytes wrapped in a Blob. Built by
 *  `getLevelTexturesBulk`; consumed by every Three.js texture builder
 *  (Viewport, AssetPreview, RawCharacterModal, export). */
export type TextureBlobMap = Map<number, Blob>;

export interface LevelMeshes {
  moby_assets: AssetMeshes[];
  tie_assets: AssetMeshes[];
  ufrag_meshes: UFragMesh[];
  textures: TexturePayload[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Streaming `level_meshes_stream` — events pushed over a Tauri Channel as
 * the backend decodes phases incrementally. Mirrors the `LevelEvent` enum
 * in `apps/desktop/src-tauri/src/main.rs`.
 * ──────────────────────────────────────────────────────────────────────── */

export type PhaseId =
  | "layout"
  | "shaders"
  | "mobys"
  | "ties"
  | "ufrags"
  | "textures";

export type LevelEvent =
  | {
      type: "phase";
      phase: PhaseId;
      label: string;
      total: number;
      /** Items per chunk — the backend pauses between chunks so the UI
       *  can keep up. Frontend derives "Chunk X/Y" from current/total. */
      chunk_size: number;
    }
  | { type: "progress"; current: number }
  | { type: "moby_asset"; asset: AssetMeshes }
  | { type: "tie_asset"; asset: AssetMeshes }
  | { type: "ufrag_mesh"; mesh: UFragMesh }
  | { type: "texture"; texture: TexturePayload }
  | { type: "done" }
  | { type: "error"; message: string };

/** Stream the level-mesh decode. Returns when the backend sends `done`
 *  (or rejects on error). The handler is called once per event. */
export function streamLevelMeshes(
  folder: string,
  onEvent: (e: LevelEvent) => void,
): Promise<void> {
  const ch = new Channel<LevelEvent>();
  ch.onmessage = onEvent;
  return invoke<void>("level_meshes_stream", { folder, onEvent: ch });
}

/* ────────────────────────────────────────────────────────────────────────
 * Character / asset library streaming — loads mobys from `<level>/character/`
 * if it exists. Surfaced in the Hierarchy as a separate "Library" section.
 * ──────────────────────────────────────────────────────────────────────── */

export type CharacterLibraryEvent =
  | { type: "missing" }
  | { type: "located"; path: string }
  | { type: "total"; total: number }
  | { type: "asset"; asset: AssetMeshes }
  | { type: "texture"; texture: TexturePayload }
  | { type: "done" }
  | { type: "error"; message: string };

export function streamCharacterLibrary(
  folder: string,
  onEvent: (e: CharacterLibraryEvent) => void,
): Promise<void> {
  const ch = new Channel<CharacterLibraryEvent>();
  ch.onmessage = onEvent;
  return invoke<void>("level_character_library_stream", {
    folder,
    onEvent: ch,
  });
}

export function decodeMeshGeom(mesh: MeshGeom): DecodedMeshGeom {
  return {
    positions: decodeFloat32(mesh.positions_b64),
    uvs: decodeFloat32(mesh.uvs_b64),
    indices: decodeUint32(mesh.indices_b64),
    bone_indices: decodeUint16(mesh.bone_indices_b64),
    bone_weights: decodeUint8(mesh.bone_weights_b64),
  };
}

function decodeBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (b64.length === 0) return new Uint8Array(new ArrayBuffer(0));
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function decodeFloat32(b64: string): Float32Array {
  const bytes = decodeBytes(b64);
  return new Float32Array(bytes.buffer);
}

function decodeUint32(b64: string): Uint32Array {
  const bytes = decodeBytes(b64);
  return new Uint32Array(bytes.buffer);
}

function decodeUint16(b64: string): Uint16Array {
  const bytes = decodeBytes(b64);
  return new Uint16Array(bytes.buffer);
}

function decodeUint8(b64: string): Uint8Array<ArrayBuffer> {
  return decodeBytes(b64);
}

/* ────────────────────────────────────────────────────────────────────────
 * GLTF library — preferred path for characters / weapons / animations.
 * Loads .gltf/.glb files produced by InsomniaToolset's `extract_assets`,
 * which already does the heavy lifting (skeleton + animations baked in).
 * ──────────────────────────────────────────────────────────────────────── */

export interface GltfFile {
  /** Just the file name, e.g. `chimera_grunt.glb`. */
  name: string;
  /** Absolute path on disk — pass back to `readFileBytes` to load it. */
  path: string;
  /** Lowercase, no dot. `gltf` or `glb`. */
  extension: string;
  size_bytes: number;
  /** First-level subfolder under `entities/` — `character`, `object`,
   *  `unique`, etc. Empty when scanned outside of an entities/ tree. */
  category: string;
}

export interface GltfLibrary {
  /** Empty when no library was found near the level folder. */
  folder: string;
  files: GltfFile[];
}

/** List all .gltf/.glb files reachable from the level's character folder.
 *  Walks `<level>/../entities/character/` and other PSARC-extract-style
 *  candidate locations. */
export const listCharacterGltfs = (folder: string) =>
  invoke<GltfLibrary>("list_character_gltfs", { folder });

/** List all .gltf/.glb files in the level's `entities/` directory, tagged
 *  with their first-level subfolder (character/object/unique/…). Preferred
 *  over `listCharacterGltfs` — gets every InsomniaToolset extract output,
 *  not just the character folder. */
export const listEntitiesGltfs = (folder: string) =>
  invoke<GltfLibrary>("list_entities_gltfs", { folder });

/** List all .gltf/.glb files in an arbitrary folder (recursive). Used
 *  for the manual "Browse GLTF folder…" flow when auto-detection misses
 *  the user's specific extract layout. */
export const listGltfsInFolder = (path: string) =>
  invoke<GltfLibrary>("list_gltfs_in_folder", { path });

/** Read raw bytes from any path. Used to feed GLTF files into three.js's
 *  GLTFLoader.parse() — the loader needs an ArrayBuffer for .glb or a
 *  string for .gltf. */
/** Read raw file bytes from disk via binary IPC. Returns an
 *  `ArrayBuffer` directly — the Rust side delivers `tauri::ipc::Response`
 *  so the bytes don't go through a JSON number-array round-trip. ~5×
 *  faster than the old shape on large payloads (e.g. 20 MB GLBs). */
export const readFileBytes = (path: string) =>
  invoke<ArrayBuffer>("read_file_bytes", { path });

/* ────────────────────────────────────────────────────────────────────────
 * Animation — fetch a decoded clip for a character's animset hash.
 * ──────────────────────────────────────────────────────────────────────── */

export interface DecodedBone {
  /** Quaternion keyframes — flat `[x,y,z,w, x,y,z,w, …]` (numFrames * 4
   *  for animated, single quat (4 floats) for static). */
  rotations: number[];
  /** Translation keyframes — flat `[x,y,z, …]`. Empty when the bone
   *  has no position track (consumer falls back to bind pose). */
  translations: number[];
  scales: number[];
  rotation_animated: boolean;
  translation_animated: boolean;
  scale_animated: boolean;
}

export interface DecodedClip {
  name: string;
  num_frames: number;
  frame_rate: number;
  looping: boolean;
  /** Per-bone keyframe arrays. Length should match the moby's skeleton
   *  bone-count for body clips; viseme/face clips can drive bones from
   *  an extended rig (numBones > head submesh's bone count). */
  bones: DecodedBone[];
}

/** Fetch + decode the animation clip for an animset hash. Computes
 *  `position_scale = 2 ^ bind_pose_inverse_offset` automatically when
 *  the caller passes the moby's offset. */
export const fetchAnimsetClip = (
  level_folder: string,
  animset_hash_hex: string,
  bind_pose_inverse_offset: number,
  scale_shift: number,
) =>
  invoke<DecodedClip>("fetch_animset_clip", {
    levelFolder: level_folder,
    animsetHashHex: animset_hash_hex,
    positionScale: Math.pow(2, bind_pose_inverse_offset),
    scaleScale: Math.pow(2, scale_shift),
  });

export interface AnimsetSummary {
  tuid_hex: string;
  name: string;
  num_frames: number;
  frame_rate: number;
  num_bones: number;
  looping: boolean;
}

/** List every animset clip header in a level's `animsets.dat`. Cheap
 *  enough to call when a modal opens — only reads the 0x40 header per
 *  animset, not the full track data. */
export const listAnimsetClips = (level_folder: string) =>
  invoke<AnimsetSummary[]>("list_animset_clips", {
    levelFolder: level_folder,
  });

export interface GlbMaterialTextures {
  material_name: string;
  /** Absolute path to `_c.dds` (color), or null. */
  albedo_path: string | null;
  /** Absolute path to `_n.dds` (normal), or null. */
  normal_path: string | null;
  /** Absolute path to `_e.dds` (emissive / "expensive" pack), or null. */
  emissive_path: string | null;
}

/** Look up sibling DDS textures for each GLB material name. IT writes
 *  textures as external `.dds` files in `<level>/textures/...`, so the
 *  modal needs to re-attach them after `GLTFLoader.parse()` returns
 *  with empty maps. */
export const findGlbTextures = (
  level_folder: string,
  material_names: string[],
) =>
  invoke<GlbMaterialTextures[]>("find_glb_textures", {
    levelFolder: level_folder,
    materialNames: material_names,
  });

/* ────────────────────────────────────────────────────────────────────────
 * Sound extraction — `resident_sound.dat` SCREAM bank.
 * ──────────────────────────────────────────────────────────────────────── */

export interface SoundEntry {
  name: string;
  /** Index into the source file's Sounds table — stable identifier. */
  index: number;
  /** "bank" = extractable now. "stream" = references a sibling
   *  streaming file (not yet supported). */
  /** Decode dispatch:
   *  - `"bank"`            — in-bank SCREAM, fetched via `extractLevelSounds`.
   *  - `"stream"`          — bank-paired streaming entry, fetched via
   *    `extractLevelStreamSounds(folder, source)` where `source` is
   *    the BANK file (e.g. `resident_dialogue.us.dat`).
   *  - `"raw"`             — orphan streaming file with no bank pair.
   *    Found by brute-force header scan; fetched via
   *    `extractRawStreamingSounds(folder, source)` where `source` is
   *    the STREAM file itself (e.g. `streaming_sound.dat`).
   *  - `"stream-missing"`  — bank entry references a streaming
   *    sibling that ISN'T in this level folder. Surfaced for
   *    visibility (so the user sees what dialogue exists) but
   *    cannot be played back here — the audio data lives in another
   *    folder or PSARC the user hasn't extracted. */
  kind: "bank" | "stream" | "raw" | "stream-missing";
  /** Source filename relative to the level folder. For `"bank"` and
   *  `"stream"` this is the bank file; for `"raw"` it's the stream
   *  file directly. */
  source: string;
}

export interface ExtractedSound {
  name: string;
  sample_rate: number;
  /** Channel count baked into the WAV. 1 for SCREAM bank sounds and
   *  VAGp streams; 2+ possible for VPK / multi-channel XVAG. */
  channels: number;
  sample_count: number;
  /** Base64-encoded RIFF/WAVE bytes. */
  wav_b64: string;
}

/** List sound metadata in the level's `resident_sound.dat`. Cheap —
 *  only reads IGHW headers, not waveform data. */
export const listLevelSounds = (level_folder: string) =>
  invoke<SoundEntry[]>("list_level_sounds", { levelFolder: level_folder });

/** Extract all SCREAM-bank sounds in the level to playable WAVs. */
export const extractLevelSounds = (level_folder: string) =>
  invoke<ExtractedSound[]>("extract_level_sounds", {
    levelFolder: level_folder,
  });

/** Extract every streaming sound for the given bank file. Pairs the
 *  bank with its sibling streaming file (e.g. `resident_sound.dat`
 *  + `streaming_sound.dat`) and decodes VAGp / VPK / XVAG-PS_ADPCM
 *  entries. MPEG-encoded XVAG entries are skipped server-side. */
export const extractLevelStreamSounds = (level_folder: string, bank_filename: string) =>
  invoke<ExtractedSound[]>("extract_level_stream_sounds", {
    levelFolder: level_folder,
    bankFilename: bank_filename,
  });

/** Extract every audio container found by brute-force scanning an
 *  orphan streaming file (one with no paired bank in the same
 *  folder). Synthetic names of the form `stream_NNNNN_0xOFFSET`. */
export const extractRawStreamingSounds = (level_folder: string, stream_filename: string) =>
  invoke<ExtractedSound[]>("extract_raw_streaming_sounds", {
    levelFolder: level_folder,
    streamFilename: stream_filename,
  });

/** Dump the SCREAM bank structure for a given file: detected version,
 *  IGHW sections, SCREAMBankHeader pointers (with resolved file
 *  addresses), SCREAMBank fields, first-N sounds/names/stream
 *  offsets. Use this from the Console when an extract command fails
 *  with cryptic I/O errors — the dump shows exactly which pointer
 *  is bad without manual hexdumping. */
export const dumpSoundBank = (level_folder: string, bank_filename: string) =>
  invoke<string>("dump_sound_bank", {
    levelFolder: level_folder,
    bankFilename: bank_filename,
  });

/** Decode a base64 WAV string to raw bytes plus a Blob URL playable
 *  in `<audio>`. Callers that only need playback can ignore `bytes`;
 *  the export-to-disk path needs them so it can write the same buffer
 *  via Tauri's `write_bytes` command. */
export function wavBlobAndUrl(wav_b64: string): { url: string; bytes: Uint8Array } {
  const bin = atob(wav_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  return { url, bytes };
}

/** Decode a base64 WAV string to a Blob URL playable in `<audio>`. */
export function wavBlobUrl(wav_b64: string): string {
  return wavBlobAndUrl(wav_b64).url;
}

export interface LevelFile {
  name: string;
  size_bytes: number;
  /** Category — drives icon + grouping. */
  category:
    | "lookup"
    | "core"
    | "audio"
    | "audio-stream"
    | "localization"
    | "lipsync"
    | "lighting"
    | "vfx"
    | "cinematic"
    | "foliage"
    | "config"
    | "other";
  /** True when ReChimera has a parser; false = roadmap (file is
   *  visible but contents not yet extractable). */
  parsed: boolean;
}

/** Enumerate notable files in the level folder, classified by what we
 *  do and don't parse. Drives the Hierarchy "Files" section so the
 *  user can SEE the full level contents (audio streams, localization,
 *  cinematics, etc.) even before each format gets a parser. */
export const listLevelFiles = (level_folder: string) =>
  invoke<LevelFile[]>("list_level_files", { levelFolder: level_folder });

/** Lazy single-texture fetch using Tauri 2's binary IPC. Returns the
 *  raw PNG bytes as an `ArrayBuffer` — no base64, no JSON parse. The
 *  caller wraps it in a Blob URL or feeds it to `createImageBitmap`.
 *
 *  This bypasses the eager streaming pipeline (which currently sends
 *  base64 inside JSON events). Use it for previews / on-demand
 *  consumers where holding every texture's base64 in JS memory is
 *  wasteful. The Viewport still uses the streaming pipeline because
 *  it needs every texture to render placed assets. */
export async function getLevelTexturePng(
  level_folder: string,
  texture_id: number,
): Promise<Blob> {
  const buf = await invoke<ArrayBuffer>("get_level_texture_png", {
    levelFolder: level_folder,
    textureId: texture_id,
  });
  return new Blob([buf], { type: "image/png" });
}

/** Bulk binary fetch — primary path for moving texture bytes to the
 *  frontend. Pairs with the streaming pipeline's metadata-only texture
 *  events: collect every texture id during streaming, then call this
 *  once with the full id list to get all PNG bytes in one binary
 *  Tauri response. Returns a `Map<id, Blob>` ready to feed Three.js.
 *
 *  Wire format (little-endian):
 *    [u32 count]
 *    for each: [u32 id][u32 png_len][png_len bytes]
 *
 *  The single round-trip avoids ~200× the per-call overhead of fetching
 *  textures one at a time on a level with hundreds of them. */
export async function getLevelTexturesBulk(
  level_folder: string,
  texture_ids: number[],
): Promise<TextureBlobMap> {
  const out: TextureBlobMap = new Map();
  if (texture_ids.length === 0) return out;
  const buf = await invoke<ArrayBuffer>("get_level_textures_bulk", {
    levelFolder: level_folder,
    textureIds: texture_ids,
  });
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  let offset = 4;
  for (let i = 0; i < count; i++) {
    const id = dv.getUint32(offset, true);
    const len = dv.getUint32(offset + 4, true);
    offset += 8;
    // Slice without copying — Blob takes a view; the underlying
    // ArrayBuffer stays alive as long as the Blob does.
    const slice = new Uint8Array(buf, offset, len);
    out.set(id, new Blob([slice], { type: "image/png" }));
    offset += len;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * PSARC tools — list / extract a PlayStation Archive.
 * ──────────────────────────────────────────────────────────────────────── */

export interface PsarcEntryDto {
  name: string;
  uncompressed_size: number;
  file_offset: number;
}

export interface PsarcListDto {
  major: number;
  minor: number;
  compression: "zlib" | "lzma" | "oodle" | string;
  block_size: number;
  entry_count: number;
  entries: PsarcEntryDto[];
}

export const psarcList = (path: string) =>
  invoke<PsarcListDto>("psarc_list", { path });

export type PsarcEvent =
  | { type: "total"; total: number }
  | { type: "file"; index: number; name: string; bytes: number }
  | { type: "done" }
  | { type: "error"; message: string };

export function psarcExtractStream(
  input: string,
  output: string,
  onEvent: (e: PsarcEvent) => void,
): Promise<void> {
  const ch = new Channel<PsarcEvent>();
  ch.onmessage = onEvent;
  return invoke<void>("psarc_extract_stream", { input, output, onEvent: ch });
}
