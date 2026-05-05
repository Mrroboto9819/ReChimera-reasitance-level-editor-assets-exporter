import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import { FpsOverlay, FpsSampler } from "./FpsOverlay";
import { clickMods } from "./selection";
const EMPTY_TEXTURES = [];
const SELECTED_COLOR = new THREE.Color("#ffbc33");
/* ────────────────────────────────────────────────────────────────────────
 * Texture cache: PNG bytes → THREE.Texture, keyed by albedo_id.
 *
 * `useTextureMap` builds incrementally: only NEW payloads (id not yet in
 * the cache) get decoded. Repeated calls with the same payload list reuse
 * the same THREE.Texture instances so materials stay stable.
 * ──────────────────────────────────────────────────────────────────────── */
function buildOneTexture(t) {
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
    return tex;
}
function useTextureMap(textures) {
    const cacheRef = useRef(new Map());
    // Add new textures during render. AssetGroup's getMaterial reads the same
    // ref later in the same render pass and patches existing materials' .map
    // — that pair (in-render add + in-render patch) is what makes textures
    // attach to materials that were built in an earlier flush.
    //
    // The previous useEffect-based variant deferred the add to after-commit,
    // and `[textures]` deps never changed (we mutate the same array each
    // flush), so the effect only ran once on mount before any texture event.
    for (const t of textures) {
        if (!cacheRef.current.has(t.id)) {
            cacheRef.current.set(t.id, buildOneTexture(t));
        }
    }
    // Dispose textures on unmount.
    useEffect(() => {
        const cache = cacheRef.current;
        return () => {
            for (const tex of cache.values())
                tex.dispose();
            cache.clear();
        };
    }, []);
    return cacheRef.current;
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
function InstancedAssetSubmesh({ geometry, material, instances, selectedIds, onPick, baseColor, }) {
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
            const color = selectedIds.has(inst.tuid) ? SELECTED_COLOR : baseColor;
            mesh.setColorAt(i, color);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor)
            mesh.instanceColor.needsUpdate = true;
        mesh.count = instances.length;
    }, [instances, selectedIds, baseColor]);
    if (instances.length === 0)
        return null;
    return (_jsx("instancedMesh", { ref: meshRef, args: [geometry, material, instances.length], onClick: (e) => {
            e.stopPropagation();
            const id = e.instanceId;
            if (id != null) {
                const inst = instances[id];
                if (inst)
                    onPick(inst, e);
            }
        } }));
}
function AssetGroup({ kind, meshes, textures, instances, selectedIds, onPick, visible, }) {
    // Per-asset cache: keyed by asset_tuid so streaming flushes only build
    // newly-arrived assets instead of rebuilding every asset on every flush.
    // Material cache is shared per-instance of AssetGroup, keyed by albedo_id
    // so identical-textured submeshes share a material.
    const cacheRef = useRef(null);
    if (cacheRef.current === null) {
        cacheRef.current = {
            byAsset: new Map(),
            materials: new Map(),
        };
    }
    const cache = cacheRef.current;
    function getMaterial(albedoId) {
        const key = albedoId == null ? "null" : `tex:${albedoId}`;
        let m = cache.materials.get(key);
        const tex = albedoId != null ? textures.get(albedoId) ?? null : null;
        if (m) {
            // Patch in a texture that arrived after the material was first built.
            if (tex && m.map !== tex) {
                m.map = tex;
                m.needsUpdate = true;
            }
            return m;
        }
        m = new THREE.MeshStandardMaterial({
            map: tex,
            color: 0xffffff,
            roughness: 0.85,
            metalness: 0,
        });
        cache.materials.set(key, m);
        return m;
    }
    // Append-only build: only build geometry for assets we haven't seen yet.
    // Materials always go through getMaterial() so they pick up the latest
    // texture each render.
    for (const a of meshes) {
        if (cache.byAsset.has(a.asset_tuid)) {
            // Already built — but still walk submeshes to refresh material refs in
            // case a texture arrived since first build.
            const existing = cache.byAsset.get(a.asset_tuid);
            for (let i = 0; i < a.submeshes.length && i < existing.length; i++) {
                existing[i].material = getMaterial(a.submeshes[i].albedo_id);
            }
            continue;
        }
        const submeshes = a.submeshes.map((s) => ({
            geom: buildGeometry(s.positions, s.uvs, s.indices),
            material: getMaterial(s.albedo_id),
        }));
        cache.byAsset.set(a.asset_tuid, submeshes);
    }
    // Dispose everything when the AssetGroup unmounts (level close).
    useEffect(() => {
        return () => {
            for (const list of cache.byAsset.values()) {
                for (const s of list)
                    s.geom.dispose();
            }
            for (const m of cache.materials.values())
                m.dispose();
            cache.byAsset.clear();
            cache.materials.clear();
        };
    }, [cache]);
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
            const submeshes = cache.byAsset.get(assetTuid);
            if (!submeshes || submeshes.length === 0)
                return null;
            return (_jsx("group", { children: submeshes.map((s, idx) => (_jsx(InstancedAssetSubmesh, { geometry: s.geom, material: s.material, instances: insts, selectedIds: selectedIds, onPick: onPick, baseColor: baseColor }, `${assetTuid}-${idx}`))) }, assetTuid));
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
 * Camera framing — runs ONCE per level open. Subsequent rerenders (from
 * stream flushes adding more instances/ufrags) shouldn't yank the camera
 * around once the user has started orbiting.
 * ──────────────────────────────────────────────────────────────────────── */
function CameraFrame({ center, extent }) {
    const { camera } = useThree();
    const framedRef = useRef(false);
    useEffect(() => {
        if (framedRef.current)
            return;
        if (extent <= 0)
            return;
        const cam = camera;
        const dist = extent * 0.9;
        cam.position.set(center[0] + dist * 0.6, center[1] + dist * 0.5, center[2] + dist * 0.6);
        cam.far = Math.max(2000, extent * 6);
        cam.updateProjectionMatrix();
        framedRef.current = true;
    }, [camera, center, extent]);
    return null;
}
/* ────────────────────────────────────────────────────────────────────────
 * Camera focus — animates the OrbitControls target + camera position to
 * the primary-selected instance whenever it changes. Lives inside the
 * Canvas (needs useThree to grab the controls instance set by `makeDefault`).
 * ──────────────────────────────────────────────────────────────────────── */
function CameraFocus({ primary, instances, }) {
    const { camera, controls } = useThree();
    const lastFocusedRef = useRef(null);
    useEffect(() => {
        if (!primary || primary === lastFocusedRef.current)
            return;
        if (!controls)
            return;
        const inst = instances.find((i) => i.tuid === primary);
        if (!inst)
            return;
        lastFocusedRef.current = primary;
        const orbit = controls;
        const cam = camera;
        const targetPos = new THREE.Vector3(inst.position[0], inst.position[1], inst.position[2]);
        // Preserve the user's current viewing angle/distance, just shift so
        // the new target is at the instance position. Clamp distance to a
        // sensible range so tiny objects don't get the camera glued to them.
        const currentOffset = cam.position.clone().sub(orbit.target);
        const distance = Math.max(20, Math.min(currentOffset.length(), 100));
        const newOffset = currentOffset.clone().normalize().multiplyScalar(distance);
        const newCamPos = targetPos.clone().add(newOffset);
        gsap.to(orbit.target, {
            x: targetPos.x,
            y: targetPos.y,
            z: targetPos.z,
            duration: 0.5,
            ease: "power2.out",
            onUpdate: () => orbit.update(),
        });
        gsap.to(cam.position, {
            x: newCamPos.x,
            y: newCamPos.y,
            z: newCamPos.z,
            duration: 0.5,
            ease: "power2.out",
        });
    }, [primary, instances, camera, controls]);
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
export function Viewport({ instances, ufrags, meshes, selection, view, }) {
    const onPick = (inst, e) => selection.select(inst, clickMods(e.nativeEvent));
    const { center, extent } = useMemo(() => {
        function* positions() {
            for (const i of instances)
                yield i.position;
            for (const u of ufrags)
                yield u.position;
        }
        return computeBounds(positions());
    }, [instances, ufrags]);
    // Incremental texture decode: builds new payloads, reuses cached.
    // Adds happen during render; AssetGroup patches materials in the same
    // pass via getMaterial(), so textures attach to already-built materials.
    const textureMap = useTextureMap(meshes?.textures ?? EMPTY_TEXTURES);
    return (_jsxs("div", { className: "viewport", children: [_jsxs(Canvas, { camera: { position: [50, 50, 50], fov: 55, near: 0.1, far: 2000 }, onPointerMissed: (e) => {
                    // Empty-space click goes through select(null) which preserves the
                    // shift-click anchor — calling selection.clear() here would wipe
                    // it and break the next range-select.
                    selection.select(null, clickMods(e));
                }, children: [_jsx(CameraFrame, { center: center, extent: extent }), _jsx("color", { attach: "background", args: ["#050608"] }), _jsx("ambientLight", { intensity: 0.6 }), _jsx("directionalLight", { position: [100, 200, 50], intensity: 1.0 }), _jsx("directionalLight", { position: [-100, 100, -50], intensity: 0.5 }), view.showGrid && (_jsx(Grid, { position: [center[0], 0, center[2]], args: [extent * 2, extent * 2], cellColor: "#1a1c20", sectionColor: "#262830", sectionSize: Math.max(10, Math.round(extent / 20)), cellSize: Math.max(1, Math.round(extent / 200)), fadeDistance: extent * 1.5, fadeStrength: 1, infiniteGrid: true })), view.showAxes && _jsx("axesHelper", { args: [Math.max(5, extent * 0.05)] }), meshes && (_jsxs(_Fragment, { children: [_jsx(AssetGroup, { kind: "tie", meshes: meshes.tie_assets, textures: textureMap, instances: instances, selectedIds: selection.ids, onPick: onPick, visible: view.showTies }), _jsx(AssetGroup, { kind: "moby", meshes: meshes.moby_assets, textures: textureMap, instances: instances, selectedIds: selection.ids, onPick: onPick, visible: view.showMobys }), _jsx(UFragMeshGroup, { meshes: meshes.ufrag_meshes, textures: textureMap, visible: view.showUFrags })] })), _jsx(UFragBoundsGroup, { ufrags: ufrags, visible: view.showUFragBounds }), _jsx(OrbitControls, { makeDefault: true, enableDamping: true, dampingFactor: 0.1, panSpeed: 1.2, target: center, maxDistance: extent * 3 }), _jsx(CameraFocus, { primary: selection.primary, instances: instances }), _jsx(FpsSampler, {})] }), _jsx(FpsOverlay, { mode: view.showStats ? "graph" : "counter" }), _jsxs("div", { className: "viewport-overlay", children: ["drag ", _jsx("span", { className: "kbd", children: "LMB" }), " orbit \u00B7 scroll zoom \u00B7 drag", " ", _jsx("span", { className: "kbd", children: "RMB" }), " pan"] })] }));
}
