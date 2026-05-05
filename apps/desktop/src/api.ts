import { invoke } from "@tauri-apps/api/core";

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
}

export interface AssetMeshes {
  asset_tuid: string;
  submeshes: MeshGeom[];
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

export const levelMeshes = (folder: string) =>
  invoke<LevelMeshes>("level_meshes", { folder });
