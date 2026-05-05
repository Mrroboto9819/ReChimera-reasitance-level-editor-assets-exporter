import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
/**
 * Export the current selection to a `.glb` file the user picks via the
 * native save dialog. Reports progress through `onProgress` callbacks so
 * the UI can show a phased modal (similar to the level-load progress).
 *
 * The phases:
 *   1. picking          — native dialog open, waiting on user
 *   2. preparing        — assemble three.js scene from selection + cached meshes
 *   3. decoding-textures — decode any textures the selection references
 *   4. encoding         — GLTFExporter serializes the scene to a binary glTF
 *   5. writing          — bytes flushed to disk via the `write_bytes` Tauri command
 *   6. done             — final state; modal can close
 *
 * If the user cancels the picker, the promise resolves with `path: null`
 * and an `ExportProgressState` with `cancelled: true` is emitted.
 */
export async function exportSelectedAsGlb(selectedIds, instances, meshes, onProgress) {
    const emit = (s) => onProgress?.(s);
    if (selectedIds.size === 0 || !meshes) {
        emit({
            phase: "done",
            label: "Nothing to export",
            fraction: 1,
            cancelled: true,
        });
        return { path: null, bytes: 0 };
    }
    const selectedInstances = instances.filter((i) => selectedIds.has(i.tuid));
    if (selectedInstances.length === 0) {
        emit({
            phase: "done",
            label: "No matching instances",
            fraction: 1,
            cancelled: true,
        });
        return { path: null, bytes: 0 };
    }
    // ── Phase 1: ask the user where to save.
    emit({
        phase: "picking",
        label: "Choose where to save",
        fraction: 0,
    });
    const defaultName = `rechimera-${selectedInstances.length}-objects.glb`;
    const path = await save({
        title: "Export selection as glTF binary (.glb)",
        defaultPath: defaultName,
        filters: [{ name: "Binary glTF", extensions: ["glb"] }],
    });
    if (!path) {
        emit({
            phase: "done",
            label: "Export cancelled",
            fraction: 0,
            cancelled: true,
        });
        return { path: null, bytes: 0 };
    }
    // ── Phase 2: build the three.js scene from the streamed payloads.
    emit({
        phase: "preparing",
        label: "Building scene from selection",
        fraction: 0.05,
        detail: path,
    });
    await yieldToBrowser();
    const assetLib = new Map();
    for (const a of meshes.moby_assets)
        assetLib.set(a.asset_tuid, a);
    for (const a of meshes.tie_assets)
        assetLib.set(a.asset_tuid, a);
    const root = new THREE.Group();
    root.name = `ReChimera-export-${selectedInstances.length}`;
    // Track which texture ids we'll need.
    const neededAlbedos = new Set();
    for (let idx = 0; idx < selectedInstances.length; idx++) {
        const inst = selectedInstances[idx];
        const asset = assetLib.get(inst.asset_tuid);
        if (!asset)
            continue;
        const node = new THREE.Group();
        node.name = inst.name || inst.tuid;
        node.position.set(inst.position[0], inst.position[1], inst.position[2]);
        node.quaternion.set(inst.quaternion[0], inst.quaternion[1], inst.quaternion[2], inst.quaternion[3]);
        node.scale.set(inst.scale[0], inst.scale[1], inst.scale[2]);
        node.userData = {
            tuid: inst.tuid,
            asset_tuid: inst.asset_tuid,
            kind: inst.kind,
        };
        for (let i = 0; i < asset.submeshes.length; i++) {
            const s = asset.submeshes[i];
            const geom = new THREE.BufferGeometry();
            geom.setAttribute("position", new THREE.Float32BufferAttribute(s.positions, 3));
            if (s.uvs.length > 0) {
                geom.setAttribute("uv", new THREE.Float32BufferAttribute(s.uvs, 2));
            }
            geom.setIndex(s.indices);
            // Note: deliberately NOT calling computeVertexNormals() here. Three.js
            // stores normals as Float32, but GLTFExporter wants them as normalized
            // Int8 — the conversion produces a "Creating normalized normal
            // attribute…" warning per mesh. Skipping the computation lets the
            // importer (Blender / glTF viewer) generate them on load instead.
            // The exported .glb is valid and smaller without baked normals.
            const material = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                roughness: 0.85,
                metalness: 0,
                name: s.albedo_id != null ? `albedo_${s.albedo_id}` : "untextured",
            });
            if (s.albedo_id != null)
                neededAlbedos.add(s.albedo_id);
            const mesh = new THREE.Mesh(geom, material);
            mesh.name = `${inst.name || inst.tuid}_sm${i}`;
            node.add(mesh);
        }
        root.add(node);
        // Yield every 32 instances so we don't block the event loop on huge selections.
        if (idx % 32 === 0) {
            const frac = 0.05 + (idx / selectedInstances.length) * 0.25;
            emit({
                phase: "preparing",
                label: `Building scene (${idx + 1}/${selectedInstances.length})`,
                fraction: frac,
                detail: path,
            });
            await yieldToBrowser();
        }
    }
    // ── Phase 3: decode textures (PNG bytes → THREE.Texture).
    emit({
        phase: "decoding-textures",
        label: `Decoding ${neededAlbedos.size} texture(s)`,
        fraction: 0.35,
        detail: path,
    });
    await yieldToBrowser();
    const textureMap = new Map();
    let texCount = 0;
    for (const id of neededAlbedos) {
        const payload = meshes.textures.find((t) => t.id === id);
        if (!payload)
            continue;
        const tex = await loadOneTexture(payload.png);
        textureMap.set(id, tex);
        texCount++;
        const frac = 0.35 + (texCount / Math.max(1, neededAlbedos.size)) * 0.2;
        emit({
            phase: "decoding-textures",
            label: `Decoded ${texCount}/${neededAlbedos.size} textures`,
            fraction: frac,
            detail: path,
        });
    }
    // Attach textures to materials.
    root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
            const mat = obj.material;
            if (mat.name?.startsWith("albedo_")) {
                const id = Number(mat.name.slice(7));
                const tex = textureMap.get(id);
                if (tex) {
                    mat.map = tex;
                    mat.needsUpdate = true;
                }
            }
        }
    });
    // ── Phase 4: GLTFExporter — synchronous and the slowest single step.
    emit({
        phase: "encoding",
        label: "Encoding binary glTF",
        fraction: 0.6,
        detail: path,
    });
    await yieldToBrowser();
    const exporter = new GLTFExporter();
    // Silence GLTFExporter's per-mesh "Creating normalized normal attribute…"
    // warning. It fires whether or not we precompute normals — the exporter
    // re-derives them as packed Int8 for the GLB and warns each time. The
    // output is fine; the warning is just noise that floods DevTools.
    const origWarn = console.warn;
    console.warn = (...args) => {
        if (typeof args[0] === "string" &&
            args[0].includes("Creating normalized normal attribute")) {
            return;
        }
        origWarn.apply(console, args);
    };
    let bytes;
    try {
        bytes = await new Promise((resolve, reject) => {
            exporter.parse(root, (gltf) => {
                if (gltf instanceof ArrayBuffer)
                    resolve(gltf);
                else
                    reject(new Error("GLTFExporter returned JSON; expected binary"));
            }, (err) => reject(err), { binary: true, includeCustomExtensions: false, embedImages: true });
        });
    }
    finally {
        console.warn = origWarn;
    }
    // ── Phase 5: write to disk via the Tauri command.
    emit({
        phase: "writing",
        label: `Writing ${formatBytes(bytes.byteLength)} to disk`,
        fraction: 0.9,
        detail: path,
    });
    await yieldToBrowser();
    await invoke("write_bytes", {
        path,
        bytes: Array.from(new Uint8Array(bytes)),
    });
    emit({
        phase: "done",
        label: `Saved ${formatBytes(bytes.byteLength)}`,
        fraction: 1,
        detail: path,
    });
    return { path, bytes: bytes.byteLength };
}
/** Yield to the browser between heavy synchronous chunks. */
function yieldToBrowser() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => resolve());
        }
        else {
            setTimeout(resolve, 0);
        }
    });
}
function loadOneTexture(png) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([new Uint8Array(png)], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const tex = new THREE.Texture(img);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.flipY = false;
            tex.needsUpdate = true;
            URL.revokeObjectURL(url);
            resolve(tex);
        };
        img.onerror = (e) => {
            URL.revokeObjectURL(url);
            reject(e);
        };
        img.src = url;
    });
}
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
