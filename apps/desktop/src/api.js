import { Channel, invoke } from "@tauri-apps/api/core";
export const openLevel = (folder) => invoke("open_level", { folder });
export const listAssets = (folder, kind) => invoke("list_assets", { folder, kind });
export const levelLayout = (folder) => invoke("level_layout", { folder });


export function streamLevelMeshes(folder, onEvent) {
    const ch = new Channel();
    ch.onmessage = onEvent;
    return invoke("level_meshes_stream", { folder, onEvent: ch });
}
export const psarcList = (path) => invoke("psarc_list", { path });
export function psarcExtractStream(input, output, onEvent) {
    const ch = new Channel();
    ch.onmessage = onEvent;
    return invoke("psarc_extract_stream", { input, output, onEvent: ch });
}
