import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type ThreeEvent, useThree } from "@react-three/fiber";
import { Grid, Html, OrbitControls, TransformControls } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type {
  AssetKind,
  AssetMeshes,
  Instance as InstanceData,
  LevelMeshes,
  TexturePayload,
  UFragBounds,
  UFragMesh,
} from "./api";
import { FpsOverlay, FpsSampler } from "./FpsOverlay";
import { clickMods, type useSelection } from "./selection";
import { resolvedTransform, type InstanceEdit, type useEdits } from "./edits";

type Selection = ReturnType<typeof useSelection>;
type Edits = ReturnType<typeof useEdits>;

const EMPTY_TEXTURES: TexturePayload[] = [];

const SELECTED_COLOR = new THREE.Color("#ffbc33");

export interface ViewSettings {
  showMobys: boolean;
  showTies: boolean;
  showUFrags: boolean;
  showUFragBounds: boolean;
  showGrid: boolean;
  showAxes: boolean;
  showStats: boolean;
  showBones: boolean;
}

/* ────────────────────────────────────────────────────────────────────────
 * Texture cache: PNG bytes → THREE.Texture, keyed by albedo_id.
 *
 * `useTextureMap` builds incrementally: only NEW payloads (id not yet in
 * the cache) get decoded. Repeated calls with the same payload list reuse
 * the same THREE.Texture instances so materials stay stable.
 * ──────────────────────────────────────────────────────────────────────── */

function buildOneTexture(t: TexturePayload): THREE.Texture {
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

function useTextureMap(textures: TexturePayload[]): Map<number, THREE.Texture> {
  const cacheRef = useRef<Map<number, THREE.Texture>>(new Map());
  const [bumpVersion, setBumpVersion] = useState(0);

  // Build at most TEX_BATCH new THREE.Texture objects per render. Each
  // build allocates a Blob, an Object URL, an Image element, and a
  // GPU-backed THREE.Texture — fast individually but bursty when 16+
  // textures arrive in one rAF window. Cap matches AssetGroup's BUILD_BATCH.
  const TEX_BATCH = 8;
  let builtThisRender = 0;
  let pendingMore = false;
  for (const t of textures) {
    if (cacheRef.current.has(t.id)) continue;
    if (builtThisRender >= TEX_BATCH) {
      pendingMore = true;
      break;
    }
    cacheRef.current.set(t.id, buildOneTexture(t));
    builtThisRender++;
  }

  // Defer the rest to the next paint via setTimeout(0) — yields to the
  // browser between batches so the cursor + progress bar stay responsive.
  useEffect(() => {
    if (!pendingMore) return;
    const id = setTimeout(() => setBumpVersion((v) => v + 1), 0);
    return () => clearTimeout(id);
  }, [pendingMore, bumpVersion]);

  // Dispose textures on unmount.
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const tex of cache.values()) tex.dispose();
      cache.clear();
    };
  }, []);

  return cacheRef.current;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-asset BufferGeometry.
 * ──────────────────────────────────────────────────────────────────────── */

function buildGeometry(positions: number[], uvs: number[], indices: number[]): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (uvs.length > 0) geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

interface InstancedAssetSubmeshProps {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  instances: InstanceData[];
  selectedIds: Set<string>;
  onPick: (instance: InstanceData, e: ThreeEvent<MouseEvent>) => void;
  baseColor: THREE.Color;
  /** Per-instance overrides from the edits store. */
  edits: Edits["edits"];
}

function InstancedAssetSubmesh({
  geometry,
  material,
  instances,
  selectedIds,
  onPick,
  baseColor,
  edits,
}: InstancedAssetSubmeshProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]!;
      const t = resolvedTransform(inst, edits);
      pos.set(t.position[0]!, t.position[1]!, t.position[2]!);
      quat.set(
        t.quaternion[0]!,
        t.quaternion[1]!,
        t.quaternion[2]!,
        t.quaternion[3]!,
      );
      scl.set(t.scale[0]!, t.scale[1]!, t.scale[2]!);
      m.compose(pos, quat, scl);
      mesh.setMatrixAt(i, m);
      const color = selectedIds.has(inst.tuid) ? SELECTED_COLOR : baseColor;
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.count = instances.length;
  }, [instances, selectedIds, baseColor, edits]);

  if (instances.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, instances.length]}
      // Selection requires DOUBLE-click. Single click is reserved for
      // OrbitControls (orbit / pan) and explicit gizmo drags. This matches
      // Unity / Godot conventions: viewport interactions don't change
      // selection on every drag-start.
      onDoubleClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        const id = e.instanceId;
        if (id != null) {
          const inst = instances[id];
          if (inst) onPick(inst, e);
        }
      }}
    />
  );
}

interface AssetGroupProps {
  kind: AssetKind;
  meshes: AssetMeshes[];
  textures: Map<number, THREE.Texture>;
  instances: InstanceData[];
  selectedIds: Set<string>;
  onPick: (instance: InstanceData, e: ThreeEvent<MouseEvent>) => void;
  visible: boolean;
  edits: Edits["edits"];
  /** When true, skip the geometry-building loop entirely. Used during
   *  the level-load phase so JS isn't trying to build BufferGeometries
   *  while the load modal is showing progress. */
  paused: boolean;
}

function AssetGroup({
  kind,
  meshes,
  textures,
  instances,
  selectedIds,
  onPick,
  visible,
  edits,
  paused,
}: AssetGroupProps) {
  // Per-asset cache: keyed by asset_tuid so streaming flushes only build
  // newly-arrived assets instead of rebuilding every asset on every flush.
  // Material cache is shared per-instance of AssetGroup, keyed by albedo_id
  // so identical-textured submeshes share a material.
  const cacheRef = useRef<{
    byAsset: Map<
      string,
      { geom: THREE.BufferGeometry; material: THREE.Material }[]
    >;
    materials: Map<string, THREE.Material>;
  } | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = {
      byAsset: new Map(),
      materials: new Map(),
    };
  }
  const cache = cacheRef.current;

  /** Material cache keyed on the triple (albedo, normal, emissive) — three
   *  meshes that share all three texture refs share one material. The
   *  emissive channel is given a low intensity so it shows up but doesn't
   *  blow out (we don't know the actual emission strength from the asset). */
  function getMaterial(
    albedoId: number | null,
    normalId: number | null,
    emissiveId: number | null,
  ): THREE.Material {
    const key = `tex:${albedoId ?? "_"}|n:${normalId ?? "_"}|e:${emissiveId ?? "_"}`;
    const albedo = albedoId != null ? textures.get(albedoId) ?? null : null;
    const normal = normalId != null ? textures.get(normalId) ?? null : null;
    const emissive = emissiveId != null ? textures.get(emissiveId) ?? null : null;
    let m = cache.materials.get(key) as THREE.MeshStandardMaterial | undefined;
    if (m) {
      // Patch in textures that arrived after the material was first built.
      if (albedo && m.map !== albedo) {
        m.map = albedo;
        m.needsUpdate = true;
      }
      if (normal && m.normalMap !== normal) {
        m.normalMap = normal;
        m.needsUpdate = true;
      }
      if (emissive && m.emissiveMap !== emissive) {
        m.emissiveMap = emissive;
        m.needsUpdate = true;
      }
      return m;
    }
    m = new THREE.MeshStandardMaterial({
      map: albedo,
      normalMap: normal,
      emissiveMap: emissive,
      // Light gray emission tint so the emissive map's bright pixels
      // actually contribute. Set to white when the map is present.
      emissive: emissive ? 0xffffff : 0x000000,
      emissiveIntensity: emissive ? 0.7 : 0,
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
  //
  // Cap at BUILD_BATCH per render. Diagnostic showed Rust decodes 35
  // mobys (verts up to 51,732 each) and freeze hits AFTER all 35 arrive
  // — so the cost is in JSON-parse + BufferGeometry build, both on the
  // main thread. Reduced from 8 to 2 to keep per-render work under
  // ~30ms even on the 50k-vert assets.
  const BUILD_BATCH = 2;
  const [buildVersion, setBuildVersion] = useState(0);
  let builtThisRender = 0;
  let pendingMore = false;
  // While the level is loading, skip every build. We come back when the
  // load completes (paused flips false → re-render → loop runs).
  for (const a of paused ? [] : meshes) {
    if (cache.byAsset.has(a.asset_tuid)) {
      // Already built — but still walk submeshes to refresh material refs in
      // case a texture arrived since first build. (Cheap; do for everyone.)
      const existing = cache.byAsset.get(a.asset_tuid)!;
      for (let i = 0; i < a.submeshes.length && i < existing.length; i++) {
        const s = a.submeshes[i]!;
        existing[i]!.material = getMaterial(
          s.albedo_id,
          s.normal_id,
          s.emissive_id,
        );
      }
      continue;
    }
    if (builtThisRender >= BUILD_BATCH) {
      pendingMore = true;
      break;
    }
    const submeshes = a.submeshes.map((s) => ({
      geom: buildGeometry(s.positions, s.uvs, s.indices),
      material: getMaterial(s.albedo_id, s.normal_id, s.emissive_id),
    }));
    cache.byAsset.set(a.asset_tuid, submeshes);
    builtThisRender++;
  }

  // Schedule the next build pass via a microtask + state bump. setTimeout(0)
  // so the browser gets to paint (and process input) between batches —
  // this is what keeps the UI feeling responsive.
  useEffect(() => {
    if (!pendingMore) return;
    const id = setTimeout(() => setBuildVersion((v) => v + 1), 0);
    return () => clearTimeout(id);
  }, [pendingMore, buildVersion]);

  // Dispose everything when the AssetGroup unmounts (level close).
  useEffect(() => {
    return () => {
      for (const list of cache.byAsset.values()) {
        for (const s of list) s.geom.dispose();
      }
      for (const m of cache.materials.values()) m.dispose();
      cache.byAsset.clear();
      cache.materials.clear();
    };
  }, [cache]);

  // Group instances by asset_tuid for instanced rendering.
  const grouped = useMemo(() => {
    const m = new Map<string, InstanceData[]>();
    for (const inst of instances) {
      if (inst.kind !== kind) continue;
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

  if (!visible) return null;

  return (
    <group>
      {Array.from(grouped.entries()).map(([assetTuid, insts]) => {
        const submeshes = cache.byAsset.get(assetTuid);
        if (!submeshes || submeshes.length === 0) return null;
        return (
          <group key={assetTuid}>
            {submeshes.map((s, idx) => (
              <InstancedAssetSubmesh
                key={`${assetTuid}-${idx}`}
                geometry={s.geom}
                material={s.material}
                instances={insts}
                selectedIds={selectedIds}
                onPick={onPick}
                baseColor={baseColor}
                edits={edits}
              />
            ))}
          </group>
        );
      })}
    </group>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * UFrag terrain — one mesh per UFrag chunk.
 * ──────────────────────────────────────────────────────────────────────── */

function UFragMeshNode({
  ufrag,
  texture,
  fallbackColor,
}: {
  ufrag: UFragMesh;
  texture: THREE.Texture | null;
  fallbackColor: THREE.Color;
}) {
  const geom = useMemo(
    () =>
      buildGeometry(ufrag.mesh.positions, ufrag.mesh.uvs, ufrag.mesh.indices),
    [ufrag],
  );
  useEffect(() => () => geom.dispose(), [geom]);

  return (
    <mesh position={ufrag.position} geometry={geom}>
      {texture ? (
        <meshStandardMaterial map={texture} color={0xffffff} roughness={0.9} metalness={0} />
      ) : (
        <meshStandardMaterial color={fallbackColor} roughness={0.9} metalness={0} />
      )}
    </mesh>
  );
}

function zoneColorOf(zoneTuid: string): THREE.Color {
  const lo = parseInt(zoneTuid.slice(-8), 16) || 0;
  const hue = lo % 360;
  return new THREE.Color().setHSL(hue / 360, 0.45, 0.45);
}

function UFragMeshGroup({
  meshes,
  textures,
  visible,
}: {
  meshes: UFragMesh[];
  textures: Map<number, THREE.Texture>;
  visible: boolean;
}) {
  const colorByZone = useMemo(() => {
    const m = new Map<string, THREE.Color>();
    for (const u of meshes) {
      if (!m.has(u.zone_tuid)) m.set(u.zone_tuid, zoneColorOf(u.zone_tuid));
    }
    return m;
  }, [meshes]);

  if (!visible) return null;

  return (
    <group>
      {meshes.map((u) => (
        <UFragMeshNode
          key={u.tuid}
          ufrag={u}
          texture={u.mesh.albedo_id != null ? textures.get(u.mesh.albedo_id) ?? null : null}
          fallbackColor={colorByZone.get(u.zone_tuid)!}
        />
      ))}
    </group>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Bounding-sphere wireframes (debug overlay).
 * ──────────────────────────────────────────────────────────────────────── */

function UFragBoundsGroup({
  ufrags,
  visible,
}: {
  ufrags: UFragBounds[];
  visible: boolean;
}) {
  if (!visible || ufrags.length === 0) return null;
  return (
    <group>
      {ufrags.map((u) => (
        <mesh key={u.tuid} position={u.position}>
          <sphereGeometry args={[u.radius, 8, 6]} />
          <meshBasicMaterial wireframe transparent opacity={0.2} color={"#3dd0ff"} />
        </mesh>
      ))}
    </group>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Camera framing — runs ONCE per level open. Subsequent rerenders (from
 * stream flushes adding more instances/ufrags) shouldn't yank the camera
 * around once the user has started orbiting.
 * ──────────────────────────────────────────────────────────────────────── */

function CameraFrame({ center, extent }: { center: [number, number, number]; extent: number }) {
  const { camera } = useThree();
  const framedRef = useRef(false);
  useEffect(() => {
    if (framedRef.current) return;
    if (extent <= 0) return;
    const cam = camera as THREE.PerspectiveCamera;
    const dist = extent * 0.9;
    cam.position.set(center[0] + dist * 0.6, center[1] + dist * 0.5, center[2] + dist * 0.6);
    cam.far = Math.max(2000, extent * 6);
    cam.updateProjectionMatrix();
    framedRef.current = true;
  }, [camera, center, extent]);
  return null;
}

/* ────────────────────────────────────────────────────────────────────────
 * EditGizmo — drag handles + floating info badge for the primary selection.
 *
 * TransformControls needs an Object3D to attach to; InstancedMesh entries
 * aren't Object3Ds (they're matrices in a buffer), so we mount an invisible
 * helper group at the instance's transform and let the gizmo manipulate
 * THAT. On every drag, we read the helper's TRS and write it back to the
 * edits store, which the InstancedMesh re-reads on its next render.
 *
 * The Html badge floats above the helper position with the object's name
 * + kind + edit-mode hint. When TransformControls is active it disables
 * OrbitControls so the gizmo drag doesn't also pan/orbit the camera.
 * ──────────────────────────────────────────────────────────────────────── */

function EditGizmo({
  primary,
  instances,
  edits,
  onTransform,
}: {
  primary: string | null;
  instances: InstanceData[];
  edits: Edits;
  onTransform: (
    tuid: string,
    next: {
      position: [number, number, number];
      quaternion: [number, number, number, number];
      scale: [number, number, number];
    },
  ) => void;
}) {
  const helperRef = useRef<THREE.Group>(null);
  const transformRef = useRef<unknown>(null);
  const { controls } = useThree();

  const inst = useMemo(
    () => (primary ? instances.find((i) => i.tuid === primary) ?? null : null),
    [primary, instances],
  );

  // Sync the helper to the current resolved transform whenever the
  // selection or its edits change (so click-and-drag picks up where the
  // last edit left off rather than snapping back to the original).
  useEffect(() => {
    const helper = helperRef.current;
    if (!helper || !inst) return;
    const t = resolvedTransform(inst, edits.edits);
    helper.position.set(t.position[0]!, t.position[1]!, t.position[2]!);
    helper.quaternion.set(
      t.quaternion[0]!,
      t.quaternion[1]!,
      t.quaternion[2]!,
      t.quaternion[3]!,
    );
    helper.scale.set(t.scale[0]!, t.scale[1]!, t.scale[2]!);
  }, [inst, edits.edits]);

  if (!inst) return null;

  return (
    <>
      <group ref={helperRef}>
        <Html
          center
          distanceFactor={20}
          // Keep the badge small & always-on-top relative to the scene.
          style={{ pointerEvents: "none" }}
          position={[0, 1.2, 0]}
        >
          <div className="scene-badge">
            <span className={`scene-badge-icon kind-${inst.kind}`}>
              {inst.kind[0]?.toUpperCase()}
            </span>
            <span className="scene-badge-name">
              {inst.name || inst.tuid.split("#")[0]}
            </span>
            {edits.isModified(inst.tuid) && (
              <span className="scene-badge-mod">●</span>
            )}
          </div>
        </Html>
      </group>

      <TransformControls
        ref={transformRef as never}
        object={helperRef as never}
        mode={edits.mode}
        size={0.8}
        // While the user is dragging, disable OrbitControls so we don't
        // pan the camera at the same time. drei's <TransformControls> emits
        // a `dragging-changed` event we hook into.
        onMouseDown={() => {
          if (controls) (controls as { enabled?: boolean }).enabled = false;
        }}
        onMouseUp={() => {
          if (controls) (controls as { enabled?: boolean }).enabled = true;
        }}
        onObjectChange={() => {
          const helper = helperRef.current;
          if (!helper) return;
          onTransform(inst.tuid, {
            position: [helper.position.x, helper.position.y, helper.position.z],
            quaternion: [
              helper.quaternion.x,
              helper.quaternion.y,
              helper.quaternion.z,
              helper.quaternion.w,
            ],
            scale: [helper.scale.x, helper.scale.y, helper.scale.z],
          });
        }}
      />
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Camera focus — animates the OrbitControls target + camera position to
 * the primary-selected instance whenever it changes. Lives inside the
 * Canvas (needs useThree to grab the controls instance set by `makeDefault`).
 * ──────────────────────────────────────────────────────────────────────── */

function CameraFocus({
  primary,
  instances,
  focusVersion,
}: {
  primary: string | null;
  instances: InstanceData[];
  /** Bump from the parent to force a re-frame even if `primary` is unchanged. */
  focusVersion: number;
}) {
  const { camera, controls } = useThree();
  const lastFocusedRef = useRef<string | null>(null);
  const lastVersionRef = useRef<number>(-1);

  useEffect(() => {
    if (!primary) return;
    if (!controls) return;
    // Refocus when EITHER the primary selection changed OR the version
    // counter bumped (an explicit "Go to" request from the Inspector).
    const versionChanged = focusVersion !== lastVersionRef.current;
    const primaryChanged = primary !== lastFocusedRef.current;
    if (!versionChanged && !primaryChanged) return;
    const inst = instances.find((i) => i.tuid === primary);
    if (!inst) return;
    lastFocusedRef.current = primary;
    lastVersionRef.current = focusVersion;

    const orbit = controls as unknown as OrbitControlsImpl;
    const cam = camera as THREE.PerspectiveCamera;
    const targetPos = new THREE.Vector3(
      inst.position[0]!,
      inst.position[1]!,
      inst.position[2]!,
    );

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
  }, [primary, focusVersion, instances, camera, controls]);

  return null;
}

/* ────────────────────────────────────────────────────────────────────────
 * BoneOverlay — draws cyan line segments along the skeleton hierarchy of
 * every selected moby that has a parsed skeleton (section 0xD300). One
 * line per (parent → bone) pair, computed by walking bind_local matrices.
 *
 * Phase 1a of the animation/skinning effort: lets us visually confirm the
 * skeleton parser produces correct bone topology before we wire up skin
 * weights or animation playback. Render-only, no interaction.
 * ──────────────────────────────────────────────────────────────────────── */

const BONE_COLOR = new THREE.Color("#33d5ff");

function buildBoneSegments(
  parents: number[],
  bindLocal: number[][],
): Float32Array | null {
  const n = parents.length;
  if (n === 0 || bindLocal.length !== n) return null;

  // Cumulative world-space matrices per bone.
  const worlds: THREE.Matrix4[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Matrix4();
    // bindLocal is column-major float[16]; THREE.Matrix4 also stores
    // column-major in `elements`, so a direct copy is correct.
    m.fromArray(bindLocal[i]!);
    const pi = parents[i]!;
    if (pi >= 0 && pi < i) {
      worlds[i] = worlds[pi]!.clone().multiply(m);
    } else {
      worlds[i] = m;
    }
  }

  // One segment per non-root bone — (parent_pos → bone_pos).
  const positions: number[] = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const pi = parents[i]!;
    if (pi < 0) continue;
    tmp.setFromMatrixPosition(worlds[pi]!);
    positions.push(tmp.x, tmp.y, tmp.z);
    tmp.setFromMatrixPosition(worlds[i]!);
    positions.push(tmp.x, tmp.y, tmp.z);
  }
  if (positions.length === 0) return null;
  return new Float32Array(positions);
}

interface BoneOverlayProps {
  instances: InstanceData[];
  selectedIds: Set<string>;
  mobyAssets: AssetMeshes[];
  edits: Map<string, InstanceEdit>;
}

function BoneOverlay({
  instances,
  selectedIds,
  mobyAssets,
  edits,
}: BoneOverlayProps) {
  // Per-asset cached segment buffer — bone topology is intrinsic to the
  // asset, so we build the line geometry once and re-use it across all
  // selected instances of the same asset.
  const segmentsByAsset = useMemo(() => {
    const m = new Map<string, Float32Array>();
    for (const a of mobyAssets) {
      const sk = a.skeleton;
      if (!sk || sk.parents.length === 0) continue;
      const seg = buildBoneSegments(sk.parents, sk.bind_local);
      if (seg) m.set(a.asset_tuid, seg);
    }
    return m;
  }, [mobyAssets]);

  // Render one <lineSegments> per selected, skinned moby instance. Gated by
  // selection because drawing every level moby's bones at once would melt.
  const overlays = useMemo(() => {
    const out: {
      key: string;
      segments: Float32Array;
      transform: ReturnType<typeof resolvedTransform>;
    }[] = [];
    for (const inst of instances) {
      if (inst.kind !== "moby") continue;
      if (!selectedIds.has(inst.tuid)) continue;
      const seg = segmentsByAsset.get(inst.asset_tuid);
      if (!seg) continue;
      out.push({
        key: inst.tuid,
        segments: seg,
        transform: resolvedTransform(inst, edits),
      });
    }
    return out;
  }, [instances, selectedIds, segmentsByAsset, edits]);

  if (overlays.length === 0) return null;

  return (
    <group>
      {overlays.map(({ key, segments, transform }) => (
        <BoneLines
          key={key}
          segments={segments}
          position={transform.position}
          quaternion={transform.quaternion}
          scale={transform.scale}
        />
      ))}
      {/* Show a quiet badge if user toggled bones on but no selected moby
          has a skeleton — otherwise the toggle silently does nothing and
          looks broken. Off-screen by default; logged via console only when
          dev. */}
      {/* (Intentionally no in-scene UI — Hierarchy/Inspector show the
          per-asset skeleton info already.) */}
    </group>
  );
}

function BoneLines({
  segments,
  position,
  quaternion,
  scale,
}: {
  segments: Float32Array;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(segments, 3));
    return g;
  }, [segments]);
  // Cleanup on unmount or when segments swap so we don't leak GPU buffers.
  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <lineSegments
      position={position}
      quaternion={quaternion}
      scale={scale}
      // Render on top of the mesh so cyan lines are visible inside dense
      // characters. Slight depth-bias is cheaper than `depthTest=false`
      // because the latter draws bones over the entire UI underneath.
      renderOrder={1000}
    >
      <primitive object={geometry} attach="geometry" />
      <lineBasicMaterial
        color={BONE_COLOR}
        depthTest={false}
        transparent
        opacity={0.95}
      />
    </lineSegments>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * SkinnedSelectionOverlay — for the primary-selected moby with both a
 * skeleton AND per-vertex skin weights, mount a real `THREE.SkinnedMesh`
 * at the instance transform. In bind pose this looks identical to the
 * InstancedMesh underneath, but it gives us a real Skeleton attached to
 * a SkinnedMesh that an AnimationMixer can drive in Phase 2.
 *
 * Scoped to the primary selection (one mesh max) to keep the per-instance
 * cost out of the hot path. Static and unselected mobys keep using
 * InstancedMesh.
 * ──────────────────────────────────────────────────────────────────────── */

interface SkinnedOverlayProps {
  primary: string | null;
  instances: InstanceData[];
  mobyAssets: AssetMeshes[];
  textures: Map<number, THREE.Texture>;
  edits: Map<string, InstanceEdit>;
}

function SkinnedSelectionOverlay({
  primary,
  instances,
  mobyAssets,
  textures,
  edits,
}: SkinnedOverlayProps) {
  // Resolve the primary instance + matching asset (only mobys can have
  // skeletons, so we filter on kind).
  const primaryInst = useMemo(() => {
    if (!primary) return null;
    const inst = instances.find((i) => i.tuid === primary);
    return inst && inst.kind === "moby" ? inst : null;
  }, [primary, instances]);

  const asset = useMemo(() => {
    if (!primaryInst) return null;
    const found = mobyAssets.find((a) => a.asset_tuid === primaryInst.asset_tuid);
    if (!found) return null;
    if (!found.skeleton || found.skeleton.bone_count === 0) return null;
    // Need at least one submesh with skin attributes for SkinnedMesh to
    // make sense. Fall back to nothing otherwise — let the InstancedMesh
    // do its thing.
    const anySkinned = found.submeshes.some((s) => s.bone_indices.length > 0);
    if (!anySkinned) return null;
    return found;
  }, [primaryInst, mobyAssets]);

  // Build the SkinnedMesh + Skeleton + GPU resources whenever the asset
  // changes. Heavy step — disposed on cleanup.
  const built = useMemo(() => {
    if (!asset || !asset.skeleton) return null;
    return buildSkinnedAsset(asset);
  }, [asset]);

  // Patch material textures on every render so late-arriving textures
  // attach without rebuilding the SkinnedMesh.
  useEffect(() => {
    if (!built || !asset) return;
    for (let i = 0; i < built.materials.length; i++) {
      const mat = built.materials[i]! as THREE.MeshStandardMaterial;
      const sub = asset.submeshes[i];
      if (!sub) continue;
      const albedo = sub.albedo_id != null ? textures.get(sub.albedo_id) ?? null : null;
      const normal = sub.normal_id != null ? textures.get(sub.normal_id) ?? null : null;
      const emissive = sub.emissive_id != null ? textures.get(sub.emissive_id) ?? null : null;
      let touched = false;
      if (albedo && mat.map !== albedo) { mat.map = albedo; touched = true; }
      if (normal && mat.normalMap !== normal) { mat.normalMap = normal; touched = true; }
      if (emissive && mat.emissiveMap !== emissive) {
        mat.emissiveMap = emissive;
        mat.emissive = new THREE.Color(0xffffff);
        mat.emissiveIntensity = 0.7;
        touched = true;
      }
      if (touched) mat.needsUpdate = true;
    }
  }, [built, asset, textures]);

  // Free GPU resources when the overlay unmounts (selection cleared) or
  // when we swap to a different asset. Cleanup function captured at
  // memo-resolve time so it runs against the right `built`.
  useEffect(() => {
    return () => built?.dispose();
  }, [built]);

  if (!built || !primaryInst) return null;

  const t = resolvedTransform(primaryInst, edits);

  return (
    <primitive
      object={built.root}
      position={t.position}
      quaternion={t.quaternion}
      scale={t.scale}
    />
  );
}

interface BuiltSkinnedAsset {
  /** Top-level Object3D containing every SkinnedMesh + the bone tree. */
  root: THREE.Group;
  materials: THREE.Material[];
  dispose: () => void;
}

/**
 * Construct the THREE-side rig for a moby: bones (with bind-local
 * transforms + parent hierarchy), THREE.Skeleton (with bind world-inverse
 * matrices), and one SkinnedMesh per submesh that has skin attributes.
 *
 * Fallback: submeshes WITHOUT skin attributes get rendered as plain Mesh
 * (still parented to the same group, so they move with the rig). Real
 * mobys mix-and-match — e.g. a character's body is skinned but its
 * weapon attachment might be a static prop sub-mesh.
 */
function buildSkinnedAsset(asset: AssetMeshes): BuiltSkinnedAsset | null {
  const sk = asset.skeleton!;
  const bones: THREE.Bone[] = [];
  const tmpMat = new THREE.Matrix4();

  // Phase 1: allocate Bone objects + decompose bind_local into TRS so
  // Three.js's bone-update loop can re-assemble them after animation.
  for (let i = 0; i < sk.bone_count; i++) {
    const bone = new THREE.Bone();
    bone.name = `bone_${i}`;
    const local = sk.bind_local[i];
    if (local && local.length === 16) {
      tmpMat.fromArray(local);
      tmpMat.decompose(bone.position, bone.quaternion, bone.scale);
    }
    bones.push(bone);
  }

  // Phase 2: parent bones using `parents[i]`. Parents come before
  // children in the array (Insomniac's convention); roots go directly
  // under the asset root group.
  const root = new THREE.Group();
  root.name = `skin_${asset.asset_tuid}`;
  for (let i = 0; i < sk.bone_count; i++) {
    const pi = sk.parents[i] ?? -1;
    if (pi < 0 || pi >= bones.length) {
      root.add(bones[i]!);
    } else {
      bones[pi]!.add(bones[i]!);
    }
  }

  // Phase 3: bone-inverses (world-space inverse bind matrices). When the
  // backend couldn't read tms1, fall back to deriving them from the bone
  // hierarchy — Three.js will compute them at bind() time if missing,
  // but relying on Insomniac's stored values stays faithful to the rig.
  let boneInverses: THREE.Matrix4[] | undefined;
  if (sk.bind_world_inverse.length === sk.bone_count) {
    boneInverses = sk.bind_world_inverse.map((m) =>
      new THREE.Matrix4().fromArray(m),
    );
  }
  const skeleton = new THREE.Skeleton(bones, boneInverses);

  // Phase 4: per-submesh SkinnedMesh (or Mesh fallback for unskinned
  // sub-pieces). Materials kept in a parallel array so the parent can
  // patch textures in without rebuilding.
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  for (const s of asset.submeshes) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(s.positions, 3));
    if (s.uvs.length > 0) geom.setAttribute("uv", new THREE.Float32BufferAttribute(s.uvs, 2));
    geom.setIndex(s.indices);
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
    });
    materials.push(mat);
    geometries.push(geom);

    if (s.bone_indices.length > 0 && s.bone_weights.length === s.bone_indices.length) {
      // Wire skin attributes. THREE expects skinIndex as Uint16
      // (4-component) and skinWeight as Float (4-component, normalized
      // 0..1). Our backend ships bone_weights as u8 0..255 — divide here.
      const skinIdx = new Uint16Array(s.bone_indices);
      const skinW = new Float32Array(s.bone_weights.length);
      for (let i = 0; i < s.bone_weights.length; i++) {
        skinW[i] = s.bone_weights[i]! / 255;
      }
      geom.setAttribute("skinIndex", new THREE.BufferAttribute(skinIdx, 4));
      geom.setAttribute("skinWeight", new THREE.BufferAttribute(skinW, 4));

      const skinnedMesh = new THREE.SkinnedMesh(geom, mat);
      // The skeleton's root bone needs to be a descendant of the
      // SkinnedMesh (or a sibling under a common parent) for the mesh's
      // bind matrix to track correctly. We've already parented bones
      // under `root`, and we add the SkinnedMesh under the same `root`,
      // so they're siblings — bind() handles the rest.
      skinnedMesh.bind(skeleton);
      root.add(skinnedMesh);
    } else {
      // Unskinned submesh — plain Mesh. Still parented to root so it
      // follows the instance transform, just doesn't deform with bones.
      const mesh = new THREE.Mesh(geom, mat);
      root.add(mesh);
    }
  }

  return {
    root,
    materials,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      // THREE.Skeleton has its own internal texture for GPU bone matrices;
      // dispose() releases it. Bones are plain Object3Ds, no GPU state.
      skeleton.dispose();
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Main viewport.
 * ──────────────────────────────────────────────────────────────────────── */

interface ViewportProps {
  instances: InstanceData[];
  ufrags: UFragBounds[];
  meshes: LevelMeshes | null;
  selection: Selection;
  view: ViewSettings;
  /** Bumps when the user clicks the Inspector's "Go to" button. */
  focusVersion: number;
  /** Per-instance transform overrides + edit-mode toggle. */
  edits: Edits;
  /** True while the level is still streaming. Tells AssetGroups to skip
   *  geometry construction so the JS thread isn't blocked while events
   *  arrive. After the level finishes, this flips false and the meshes
   *  build in the background (chunked). */
  loading: boolean;
}

function computeBounds(positions: Iterable<[number, number, number]>) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const p of positions) {
    any = true;
    for (let i = 0; i < 3; i++) {
      if (p[i]! < min[i]!) min[i] = p[i]!;
      if (p[i]! > max[i]!) max[i] = p[i]!;
    }
  }
  if (!any) {
    return { center: [0, 0, 0] as [number, number, number], extent: 50 };
  }
  const center: [number, number, number] = [
    (min[0]! + max[0]!) / 2,
    (min[1]! + max[1]!) / 2,
    (min[2]! + max[2]!) / 2,
  ];
  const extent = Math.max(
    max[0]! - min[0]!,
    max[1]! - min[1]!,
    max[2]! - min[2]!,
    50,
  );
  return { center, extent };
}

export function Viewport({
  instances,
  ufrags,
  meshes,
  selection,
  view,
  focusVersion,
  edits,
  loading,
}: ViewportProps) {
  const onPick = (inst: InstanceData, e: ThreeEvent<MouseEvent>) =>
    selection.select(inst, clickMods(e.nativeEvent));
  const { center, extent } = useMemo(() => {
    function* positions(): Generator<[number, number, number]> {
      for (const i of instances) yield i.position;
      for (const u of ufrags) yield u.position;
    }
    return computeBounds(positions());
  }, [instances, ufrags]);

  // Incremental texture decode: builds new payloads, reuses cached.
  // Adds happen during render; AssetGroup patches materials in the same
  // pass via getMaterial(), so textures attach to already-built materials.
  const textureMap = useTextureMap(meshes?.textures ?? EMPTY_TEXTURES);

  return (
    <div className="viewport">
      <Canvas
        camera={{ position: [50, 50, 50], fov: 55, near: 0.1, far: 2000 }}
        // Selection is double-click only; single-click on empty space is
        // reserved for OrbitControls. Use onDoubleClick + check it really
        // landed on empty space (no instance hit).
        onDoubleClick={(e) => {
          // Three-fiber sets the canvas's onPointerMissed for empty hits;
          // we get here too because Three's onClick runs through the same
          // raycaster. If the raycaster hit something, an `<instancedMesh>`
          // already handled the pick and stopped propagation — so reaching
          // this handler means the user clicked through to the canvas
          // itself (empty space).
          selection.select(null, clickMods(e.nativeEvent));
        }}
      >
        <CameraFrame center={center} extent={extent} />
        <color attach="background" args={["#050608"]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[100, 200, 50]} intensity={1.0} />
        <directionalLight position={[-100, 100, -50]} intensity={0.5} />

        {view.showGrid && (
          <Grid
            position={[center[0], 0, center[2]]}
            args={[extent * 2, extent * 2]}
            cellColor="#1a1c20"
            sectionColor="#262830"
            sectionSize={Math.max(10, Math.round(extent / 20))}
            cellSize={Math.max(1, Math.round(extent / 200))}
            fadeDistance={extent * 1.5}
            fadeStrength={1}
            infiniteGrid
          />
        )}
        {view.showAxes && <axesHelper args={[Math.max(5, extent * 0.05)]} />}

        {meshes && (
          <>
            <AssetGroup
              kind="tie"
              meshes={meshes.tie_assets}
              textures={textureMap}
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showTies}
              edits={edits.edits}
              paused={loading}
            />
            <AssetGroup
              kind="moby"
              meshes={meshes.moby_assets}
              textures={textureMap}
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showMobys}
              edits={edits.edits}
              paused={loading}
            />
            <UFragMeshGroup
              meshes={meshes.ufrag_meshes}
              textures={textureMap}
              visible={view.showUFrags}
            />
          </>
        )}

        <UFragBoundsGroup ufrags={ufrags} visible={view.showUFragBounds} />

        {view.showBones && meshes && (
          <BoneOverlay
            instances={instances}
            selectedIds={selection.ids}
            mobyAssets={meshes.moby_assets}
            edits={edits.edits}
          />
        )}

        {meshes && (
          <SkinnedSelectionOverlay
            primary={selection.primary}
            instances={instances}
            mobyAssets={meshes.moby_assets}
            textures={textureMap}
            edits={edits.edits}
          />
        )}

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.1}
          panSpeed={1.2}
          target={center}
          maxDistance={extent * 3}
        />
        <CameraFocus
          primary={selection.primary}
          instances={instances}
          focusVersion={focusVersion}
        />
        <EditGizmo
          primary={selection.primary}
          instances={instances}
          edits={edits}
          onTransform={(tuid, next) => {
            const inst = instances.find((i) => i.tuid === tuid);
            if (inst) edits.setEdit(tuid, next, inst);
          }}
        />
        <FpsSampler />
      </Canvas>

      <FpsOverlay mode={view.showStats ? "graph" : "counter"} />

      <div className="viewport-overlay">
        drag <span className="kbd">LMB</span> orbit · scroll zoom · drag{" "}
        <span className="kbd">RMB</span> pan
      </div>
    </div>
  );
}
