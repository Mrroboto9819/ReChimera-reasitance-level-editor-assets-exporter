import { invoke } from "@tauri-apps/api/core";
export const openLevel = (folder) => invoke("open_level", { folder });
export const listAssets = (folder, kind) => invoke("list_assets", { folder, kind });
export const levelLayout = (folder) => invoke("level_layout", { folder });
export const levelMeshes = (folder) => invoke("level_meshes", { folder });
