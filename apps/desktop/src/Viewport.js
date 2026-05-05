import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, Stats } from "@react-three/drei";
import * as THREE from "three";
const KIND_COLOR = {
    moby: "#ff8a3d",
    tie: "#3dd0ff",
    zone: "#9d6dff",
    shader: "#888",
    highmip: "#888",
};
const SELECTED_COLOR = new THREE.Color("#ffbc33");
/* ────────────────────────────────────────────────────────────────────────
 * Texture cache: PNG bytes → THREE.Texture, keyed by albedo_id.
 * ──────────────────────────────────────────────────────────────────────── */
function buildTextureMap(textures) {
    const map = new Map();
    for (const t of textures) {
        const blob = new Blob([new Uint8Array(t.png)], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.flipY = false; // PS3 UVs already match three.js convention.
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        img.onload = () => {
            tex.needsUpdate = true;
            URL.revokeObjectURL(url);
        };
        img.src = url;
        map.set(t.id, tex);
    }
    return map;
}
/* ────────────────────────────────────────────────────────────────────────
 * Per-asset BufferGeometry.
 * ──────────────────────────────────────────────────────────────────────── */
function buildGeometry(positions, uvs, indices) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (uvs.length > 0)
        geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    return geom;
}
function InstancedAssetSubmesh({ geometry, material, instances, selectedTuid, onPick, baseColor, }) {
    const meshRef = useRef(null);
    useEffect(() => {
        const mesh = meshRef.current;
        if (!mesh)
            return;
        const m = new THREE.Matrix4();
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        for (let i = 0; i < instances.length; i++) {
            const inst = instances[i];
            pos.set(inst.position[0], inst.position[1], inst.position[2]);
            quat.set(inst.quaternion[0], inst.quaternion[1], inst.quaternion[2], inst.quaternion[3]);
            scl.set(inst.scale[0], inst.scale[1], inst.scale[2]);
            m.compose(pos, quat, scl);
            mesh.setMatrixAt(i, m);
            const color = inst.tuid === selectedTuid ? SELECTED_COLOR : baseColor;
            mesh.setColorAt(i, color);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor)
            mesh.instanceColor.needsUpdate = true;
        mesh.count = instances.length;
    }, [instances, selectedTuid, baseColor]);
    if (instances.length === 0)
        return null;
    return (_jsx("instancedMesh", { ref: meshRef, args: [geometry, material, instances.length], onClick: (e) => {
            e.stopPropagation();
            const id = e.instanceId;
            if (id != null) {
                const inst = instances[id];
                if (inst)
                    onPick(inst);
            }
        } }));
}
function AssetGroup({ kind, meshes, textures, instances, selectedTuid, onPick, visible, }) {
    // Per-asset list of (geometry, material) pairs. Materials are keyed by
    // albedo_id so identical-textured submeshes share a material.
    const assetData = useMemo(() => {
        const result = new Map();
        const materialCache = new Map();
        const baseColor = new THREE.Color(KIND_COLOR[kind]);
        function getMaterial(albedoId) {
            const key = albedoId == null ? "null" : `tex:${albedoId}`;
            let m = materialCache.get(key);
            if (m)
                return m;
            const tex = albedoId != null ? textures.get(albedoId) ?? null : null;
            if (tex) {
                m = new THREE.MeshStandardMaterial({
                    map: tex,
                    color: 0xffffff,
                    roughness: 0.85,
                    metalness: 0,
                });
            }
            else {
                m = new THREE.MeshStandardMaterial({
                    color: 0xffffff,
                    roughness: 0.85,
                    metalness: 0,
                });
            }
            // Prevent vertexColors from blowing out the texture; per-instance color
            // (used for selection highlight) is multiplied with the base color.
            materialCache.set(key, m);
            return m;
        }
        void baseColor;
        for (const a of meshes) {
            const submeshes = a.submeshes.map((s) => ({
                geom: buildGeometry(s.positions, s.uvs, s.indices),
                material: getMaterial(s.albedo_id),
            }));
            result.set(a.asset_tuid, submeshes);
        }
        return { byAsset: result, materials: materialCache };
    }, [meshes, textures, kind]);
    useEffect(() => {
        return () => {
            for (const list of assetData.byAsset.values()) {
                for (const s of list)
                    s.geom.dispose();
            }
            for (const m of assetData.materials.values())
                m.dispose();
        };
    }, [assetData]);
    // Group instances by asset_tuid for instanced rendering.
    const grouped = useMemo(() => {
        const m = new Map();
        for (const inst of instances) {
            if (inst.kind !== kind)
                continue;
            let arr = m.get(inst.asset_tuid);
            if (!arr) {
                arr = [];
                m.set(inst.asset_tuid, arr);
            }
            arr.push(inst);
        }
        return m;
    }, [instances, kind]);
    const baseColor = useMemo(() => new THREE.Color("#ffffff"), []);
    if (!visible)
        return null;
    return (_jsx("group", { children: Array.from(grouped.entries()).map(([assetTuid, insts]) => {
            const submeshes = assetData.byAsset.get(assetTuid);
            if (!submeshes || submeshes.length === 0)
                return null;
            return (_jsx("group", { children: submeshes.map((s, idx) => (_jsx(InstancedAssetSubmesh, { geometry: s.geom, material: s.material, instances: insts, selectedTuid: selectedTuid, onPick: onPick, baseColor: baseColor }, `${assetTuid}-${idx}`))) }, assetTuid));
        }) }));
}
/* ────────────────────────────────────────────────────────────────────────
 * UFrag terrain — one mesh per UFrag chunk.
 * ──────────────────────────────────────────────────────────────────────── */
function UFragMeshNode({ ufrag, texture, fallbackColor, }) {
    const geom = useMemo(() => buildGeometry(ufrag.mesh.positions, ufrag.mesh.uvs, ufrag.mesh.indices), [ufrag]);
    useEffect(() => () => geom.dispose(), [geom]);
    return (_jsx("mesh", { position: ufrag.position, geometry: geom, children: texture ? (_jsx("meshStandardMaterial", { map: texture, color: 0xffffff, roughness: 0.9, metalness: 0 })) : (_jsx("meshStandardMaterial", { color: fallbackColor, roughness: 0.9, metalness: 0 })) }));
}
function zoneColorOf(zoneTuid) {
    const lo = parseInt(zoneTuid.slice(-8), 16) || 0;
    const hue = lo % 360;
    return new THREE.Color().setHSL(hue / 360, 0.45, 0.45);
}
function UFragMeshGroup({ meshes, textures, visible, }) {
    const colorByZone = useMemo(() => {
        const m = new Map();
        for (const u of meshes) {
            if (!m.has(u.zone_tuid))
                m.set(u.zone_tuid, zoneColorOf(u.zone_tuid));
        }
        return m;
    }, [meshes]);
    if (!visible)
        return null;
    return (_jsx("group", { children: meshes.map((u) => (_jsx(UFragMeshNode, { ufrag: u, texture: u.mesh.albedo_id != null ? textures.get(u.mesh.albedo_id) ?? null : null, fallbackColor: colorByZone.get(u.zone_tuid) }, u.tuid))) }));
}
/* ────────────────────────────────────────────────────────────────────────
 * Bounding-sphere wireframes (debug overlay).
 * ──────────────────────────────────────────────────────────────────────── */
function UFragBoundsGroup({ ufrags, visible, }) {
    if (!visible || ufrags.length === 0)
        return null;
    return (_jsx("group", { children: ufrags.map((u) => (_jsxs("mesh", { position: u.position, children: [_jsx("sphereGeometry", { args: [u.radius, 8, 6] }), _jsx("meshBasicMaterial", { wireframe: true, transparent: true, opacity: 0.2, color: "#3dd0ff" })] }, u.tuid))) }));
}
/* ────────────────────────────────────────────────────────────────────────
 * Camera framing.
 * ──────────────────────────────────────────────────────────────────────── */
function CameraFrame({ center, extent }) {
    const { camera } = useThree();
    useEffect(() => {
        const cam = camera;
        const dist = extent * 0.9;
        cam.position.set(center[0] + dist * 0.6, center[1] + dist * 0.5, center[2] + dist * 0.6);
        cam.far = Math.max(2000, extent * 6);
        cam.updateProjectionMatrix();
    }, [camera, center, extent]);
    return null;
}
function computeBounds(positions) {
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const p of positions) {
        any = true;
        for (let i = 0; i < 3; i++) {
            if (p[i] < min[i])
                min[i] = p[i];
            if (p[i] > max[i])
                max[i] = p[i];
        }
    }
    if (!any) {
        return { center: [0, 0, 0], extent: 50 };
    }
    const center = [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
    ];
    const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 50);
    return { center, extent };
}
export function Viewport({ instances, ufrags, meshes, selected, onSelect, view, }) {
    const { center, extent } = useMemo(() => {
        function* positions() {
            for (const i of instances)
                yield i.position;
            for (const u of ufrags)
                yield u.position;
        }
        return computeBounds(positions());
    }, [instances, ufrags]);
    // Decode all textures once when meshes load.
    const textureMap = useMemo(() => (meshes ? buildTextureMap(meshes.textures) : new Map()), [meshes]);
    useEffect(() => {
        return () => {
            for (const t of textureMap.values())
                t.dispose();
        };
    }, [textureMap]);
    return (_jsxs("div", { className: "viewport", children: [_jsxs(Canvas, { camera: { position: [50, 50, 50], fov: 55, near: 0.1, far: 2000 }, onPointerMissed: () => onSelect(null), children: [_jsx(CameraFrame, { center: center, extent: extent }), _jsx("color", { attach: "background", args: ["#050608"] }), _jsx("ambientLight", { intensity: 0.6 }), _jsx("directionalLight", { position: [100, 200, 50], intensity: 1.0 }), _jsx("directionalLight", { position: [-100, 100, -50], intensity: 0.5 }), view.showGrid && (_jsx(Grid, { position: [center[0], 0, center[2]], args: [extent * 2, extent * 2], cellColor: "#1a1c20", sectionColor: "#262830", sectionSize: Math.max(10, Math.round(extent / 20)), cellSize: Math.max(1, Math.round(extent / 200)), fadeDistance: extent * 1.5, fadeStrength: 1, infiniteGrid: true })), view.showAxes && _jsx("axesHelper", { args: [Math.max(5, extent * 0.05)] }), meshes && (_jsxs(_Fragment, { children: [_jsx(AssetGroup, { kind: "tie", meshes: meshes.tie_assets, textures: textureMap, instances: instances, selectedTuid: selected?.tuid ?? null, onPick: onSelect, visible: view.showTies }), _jsx(AssetGroup, { kind: "moby", meshes: meshes.moby_assets, textures: textureMap, instances: instances, selectedTuid: selected?.tuid ?? null, onPick: onSelect, visible: view.showMobys }), _jsx(UFragMeshGroup, { meshes: meshes.ufrag_meshes, textures: textureMap, visible: view.showUFrags })] })), _jsx(UFragBoundsGroup, { ufrags: ufrags, visible: view.showUFragBounds }), _jsx(OrbitControls, { makeDefault: true, enableDamping: true, dampingFactor: 0.1, panSpeed: 1.2, target: center, maxDistance: extent * 3 }), view.showStats && _jsx(Stats, { className: "r3f-stats" })] }), _jsxs("div", { className: "viewport-overlay", children: ["drag ", _jsx("span", { className: "kbd", children: "LMB" }), " orbit \u00B7 scroll zoom \u00B7 drag", " ", _jsx("span", { className: "kbd", children: "RMB" }), " pan"] })] }));
}
