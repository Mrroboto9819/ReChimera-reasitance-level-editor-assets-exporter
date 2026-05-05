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

export type AssetKind = "shader" | "highmip" | "tie" | "moby" | "zone";

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
  /** True when sourced from real gameplay data, false for debug spiral. */
  real: boolean;
}

export const openLevel = (folder: string) =>
  invoke<LevelSummary>("open_level", { folder });

export const listAssets = (folder: string, kind: AssetKind) =>
  invoke<AssetPointer[]>("list_assets", { folder, kind });

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
  positions: number[];
  uvs: number[];
  indices: number[];
  /** Albedo texture ID (lower 32 bits of highmip TUID), or null when none. */
  albedo_id: number | null;
  /** Tangent-space normal map ID, or null. */
  normal_id: number | null;
  /** "Expensive" texture (often emission / specular pack), or null.
   *  Attached as the glTF emissiveMap on export. */
  emissive_id: number | null;
  /** Per-vertex global bone indices `[i0,i1,i2,i3, …]` (vertex_count * 4).
   *  Empty when this submesh isn't skinned. */
  bone_indices: number[];
  /** Per-vertex weights as u8 (0..255). Same length as `bone_indices`. */
  bone_weights: number[];
}

export interface SkeletonInfo {
  /** Bone count — convenience so the UI doesn't have to count parents. */
  bone_count: number;
  /** Index of the root bone in `parents`. */
  root_bone: number;
  /** Per-bone parent index. -1 = root. */
  parents: number[];
  /** Local bind-pose matrices (column-major 4x4). May be empty if the
   *  source moby's `tms0` pointer was null. */
  bind_local: number[][];
  /** World-space inverse bind-pose. Required by THREE.Skeleton. */
  bind_world_inverse: number[][];
  /** Exponent used to scale animation scale-track values. */
  scale_shift: number;
  /** Exponent used to scale animation translation-track values
   *  (informational — moby.bind_pose_inverse_offset is what we pass to
   *  the backend). */
  translation_shift: number;
}

export interface AssetMeshes {
  asset_tuid: string;
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

export interface TexturePayload {
  id: number;
  width: number;
  height: number;
  /** PNG-encoded RGBA8 bytes. */
  png: number[];
}

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
export const readFileBytes = (path: string) =>
  invoke<number[]>("read_file_bytes", { path });

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
