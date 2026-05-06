import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, OrbitControls, TransformControls } from "@react-three/drei";
import gsap from "gsap";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type {
  AssetKind,
  AssetMeshes,
  DecodedClip,
  Instance as InstanceData,
  LevelMeshes,
  MeshGeom,
  TextureBlobMap,
  UFragBounds,
  UFragMesh,
} from "./api";
import { decodeMeshGeom, fetchAnimsetClip } from "./api";
import { buildAnimationClipFromDecoded, buildSkinnedAsset } from "./skinning";
import { FpsOverlay, FpsSampler } from "./FpsOverlay";
import type { LoadPhaseState } from "./LoadProgress";
import { clickMods, type useSelection } from "./selection";
import { resolvedTransform, type InstanceEdit, type useEdits } from "./edits";

type Selection = ReturnType<typeof useSelection>;
type Edits = ReturnType<typeof useEdits>;

const EMPTY_TEXTURE_BLOBS: TextureBlobMap = new Map();

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
  /** Toggle SkinnedMesh AnimationMixer playback for the selected
   *  character. False keeps the rig in bind pose. */
  playAnimation: boolean;
}

/* ────────────────────────────────────────────────────────────────────────
 * Texture cache: PNG bytes → THREE.Texture, keyed by albedo_id.
 *
 * `useTextureMap` builds incrementally: only NEW payloads (id not yet in
 * the cache) get decoded. Repeated calls with the same payload list reuse
 * the same THREE.Texture instances so materials stay stable.
 * ──────────────────────────────────────────────────────────────────────── */

function buildOneTexture(blob: Blob): THREE.Texture {
  const tex = new THREE.Texture();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false; // PS3 UVs already match three.js convention.
  // Mipmap generation is the #1 source of WebGL context loss during level
  // load: every `gl.generateMipmap()` call walks all texel levels on the
  // GPU, and 50+ of those firing in one frame is enough to make the
  // driver kill the context. We accept slightly aliased distant textures
  // in exchange for survival.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // Use `createImageBitmap` instead of `<Image>` so PNG decode runs in
  // the browser's image-decoder thread, never on the main thread.
  // For our 50+ texture batches, this alone removes ~5-15ms of
  // synchronous decode work per frame during level load. Falls back to
  // <Image> on (very rare) browsers without the API.
  if (typeof createImageBitmap === "function") {
    createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "none" })
      .then((bitmap) => {
        tex.image = bitmap;
        tex.needsUpdate = true;
      })
      .catch(() => {
        // Fall back to the Image() path below (rare browsers).
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          tex.image = img;
          tex.needsUpdate = true;
          URL.revokeObjectURL(url);
        };
        img.src = url;
      });
  } else {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    tex.image = img;
    img.onload = () => {
      tex.needsUpdate = true;
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
  return tex;
}

function useTextureMap(blobs: TextureBlobMap): Map<number, THREE.Texture> {
  const cacheRef = useRef<Map<number, THREE.Texture>>(new Map());
  const [bumpVersion, setBumpVersion] = useState(0);

  // Build textures in the render body, capped at TEX_BATCH per render.
  // We tried `requestIdleCallback` here but it rarely fires when r3f
  // renders at 60fps (the browser is never "idle"), so textures stalled
  // and materials kept their white placeholders forever. Render-body
  // build is reliable: every render eats up to TEX_BATCH new textures
  // and `setBumpVersion(v+1)` schedules another render via setTimeout.
  //
  // The actual freeze fix that lets us be aggressive here is the
  // `generateMipmaps = false` in `buildOneTexture` — without that, 8
  // texture uploads in one frame would kill the WebGL context. With it
  // off, each upload is just a `gl.texImage2D` call, very cheap.
  const TEX_BATCH = 8;
  let builtThisRender = 0;
  let pendingMore = false;
  for (const [id, blob] of blobs) {
    if (cacheRef.current.has(id)) continue;
    if (builtThisRender >= TEX_BATCH) {
      pendingMore = true;
      break;
    }
    cacheRef.current.set(id, buildOneTexture(blob));
    builtThisRender++;
  }

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

function buildGeometry(
  positions: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (uvs.length > 0) geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  // Skipping `computeVertexNormals()` deliberately — at ~150ms per 50k-vert
  // moby, this was the dominant single cost during level load and the main
  // cause of the visible freeze. Three.js's MeshStandardMaterial falls back
  // to derivative normals (`dFdx`/`dFdy`) when no `normal` attribute is
  // present, which produces flat-shaded faces; the per-pixel normal map
  // (when shaders provide one) then perturbs those, which is how Insomniac's
  // assets are authored anyway. If you ever want smooth-shaded geometry
  // without a normal map, compute it in a Web Worker — never on the main
  // thread.
  geom.computeBoundingSphere();
  return geom;
}

function buildMeshGeometry(mesh: MeshGeom): THREE.BufferGeometry {
  const decoded = decodeMeshGeom(mesh);
  return buildGeometry(decoded.positions, decoded.uvs, decoded.indices);
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

function ProxyPlacementGroup({
  kind,
  instances,
  selectedIds,
  onPick,
  visible,
  edits,
}: {
  kind: AssetKind;
  instances: InstanceData[];
  selectedIds: Set<string>;
  onPick: (instance: InstanceData, e: ThreeEvent<MouseEvent>) => void;
  visible: boolean;
  edits: Edits["edits"];
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const filtered = useMemo(
    () => instances.filter((inst) => inst.kind === kind),
    [instances, kind],
  );
  const color = kind === "moby" ? "#55b3ff" : "#5fc992";

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    for (let i = 0; i < filtered.length; i++) {
      const inst = filtered[i]!;
      const t = resolvedTransform(inst, edits);
      pos.set(t.position[0]!, t.position[1]!, t.position[2]!);
      quat.set(
        t.quaternion[0]!,
        t.quaternion[1]!,
        t.quaternion[2]!,
        t.quaternion[3]!,
      );
      const size = kind === "moby" ? 1.4 : 2.2;
      scl.set(
        Math.max(0.25, Math.abs(t.scale[0]!) * size),
        Math.max(0.25, Math.abs(t.scale[1]!) * size),
        Math.max(0.25, Math.abs(t.scale[2]!) * size),
      );
      m.compose(pos, quat, scl);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, selectedIds.has(inst.tuid) ? SELECTED_COLOR : new THREE.Color(color));
    }
    mesh.count = filtered.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Recompute the union bounding sphere — see InstancedAssetSubmesh
    // for why this is essential for proper frustum culling.
    mesh.computeBoundingSphere();
  }, [filtered, selectedIds, edits, kind, color]);

  if (!visible || filtered.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, filtered.length]}
      // Single click selects — R3F's pointer-event system distinguishes
      // click from drag using a movement threshold, so OrbitControls
      // panning/orbit doesn't fire spurious selections.
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        const id = e.instanceId;
        if (id != null) {
          const inst = filtered[id];
          if (inst) onPick(inst, e);
        }
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial wireframe transparent opacity={0.45} color={color} />
    </instancedMesh>
  );
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
  const prevColorStateRef = useRef<{
    selectedIds: Set<string>;
    indexByTuid: Map<string, number>;
    baseColor: THREE.Color;
  } | null>(null);
  const indexByTuid = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < instances.length; i++) {
      m.set(instances[i]!.tuid, i);
    }
    return m;
  }, [instances]);

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
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = instances.length;
    // Recompute the union bounding sphere across all instance matrices.
    // Without this, three.js's frustum culling tests the GEOMETRY's
    // local sphere — which only describes the asset's local extent and
    // ignores instance translations — so the InstancedMesh is treated
    // as if it lives at the world origin and never gets culled. With
    // proper instance bounds, off-screen instance groups are skipped
    // entirely, which is the InstancedMesh equivalent of LOD-distance
    // culling and the closest analogue to the LOD technique for our
    // many-instances setup.
    mesh.computeBoundingSphere();
  }, [instances, edits]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const colorAt = (index: number) => {
      const inst = instances[index]!;
      mesh.setColorAt(
        index,
        selectedIds.has(inst.tuid) ? SELECTED_COLOR : baseColor,
      );
    };

    const prev = prevColorStateRef.current;
    const needsFullRefresh =
      prev === null ||
      prev.indexByTuid !== indexByTuid ||
      prev.baseColor !== baseColor;

    if (needsFullRefresh) {
      for (let i = 0; i < instances.length; i++) colorAt(i);
    } else {
      for (const id of selectedIds) {
        if (!prev.selectedIds.has(id)) {
          const index = indexByTuid.get(id);
          if (index != null) colorAt(index);
        }
      }
      for (const id of prev.selectedIds) {
        if (!selectedIds.has(id)) {
          const index = indexByTuid.get(id);
          if (index != null) colorAt(index);
        }
      }
    }

    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    prevColorStateRef.current = {
      selectedIds: new Set(selectedIds),
      indexByTuid,
      baseColor,
    };
  }, [instances, indexByTuid, selectedIds, baseColor]);

  if (instances.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, instances.length]}
      // Single click selects. R3F's event system uses a small pixel
      // threshold to distinguish click-vs-drag, so OrbitControls'
      // orbit/pan drags don't fire onClick. This restores the original
      // behavior from before the brief double-click experiment.
      onClick={(e: ThreeEvent<MouseEvent>) => {
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
  /** Asset_tuid the user just selected. When non-null, the build queue
   *  promotes this asset to the front so the user sees their pick render
   *  before the rest of the level finishes. */
  prioritizedAssetTuid?: string | null;
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
  prioritizedAssetTuid,
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
      // We never cast/receive shadows — disable the shadow pass per
      // the optimization checklist (no dynamic shadows). Three.js's
      // default Material.shadowSide etc. don't bypass the program
      // permutation, but we also never enable `castShadow` / `recv`
      // on meshes, so the shadow shader variants never compile. Kept
      // here as documentation: these defaults assume `Renderer.shadowMap.enabled = false`.
      flatShading: false, // we skipped computeVertexNormals; renderer falls back to dFdx
    });
    cache.materials.set(key, m);
    return m;
  }

  // Group instances by asset_tuid first — we need this to (a) decide which
  // assets actually deserve building, and (b) emit one InstancedMesh per
  // asset that has placements. Orphan assets (e.g. shader-only references
  // with no world placements) are skipped entirely, which alone removes
  // ~30% of the build work on bayou.
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

  // Materials are cheap to build, so refresh material refs on every render
  // (so late-arriving textures attach without rebuilding). Geometries are
  // the expensive part — those go through the idle queue below.
  for (const [assetTuid] of grouped) {
    const existing = cache.byAsset.get(assetTuid);
    if (!existing) continue;
    const a = meshes.find((x) => x.asset_tuid === assetTuid);
    if (!a) continue;
    for (let i = 0; i < a.submeshes.length && i < existing.length; i++) {
      const s = a.submeshes[i]!;
      existing[i]!.material = getMaterial(
        s.albedo_id,
        s.normal_id,
        s.emissive_id,
      );
    }
  }

  // Idle-driven progressive build. Geometry construction (b64 decode +
  // typed-array allocation + GPU upload) is the dominant cost during level
  // load — running it inside the render body blocked React commits for
  // hundreds of milliseconds, which is what produced the visible freeze.
  //
  // Strategy:
  //   1. Render body is pure — no build work happens here, ever.
  //   2. A useEffect picks ONE pending asset per `requestIdleCallback`
  //      slot, builds it, then bumps a version counter so the parent
  //      re-renders with the new cache entry.
  //   3. The browser decides the rate — under heavy interaction (orbiting
  //      the camera, opening menus) idle slots arrive less often, so the
  //      build naturally yields. Under no interaction (level just loaded,
  //      user is reading the splash) builds run back-to-back.
  //   4. Only assets with placements get queued — orphans are ignored.
  //
  // No `BUILD_BATCH` constant: each idle tick builds exactly one asset
  // and re-schedules. This keeps each tick under ~50ms even on 50k-vert
  // mobys, well below the 16ms-frame target.
  const [, bumpBuildVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;

    const buildOne = () => {
      if (cancelled) return;
      // Priority pass — if the user just selected an asset, build that
      // first so they see their pick before the rest of the level
      // catches up.
      let next: (typeof meshes)[number] | null = null;
      if (prioritizedAssetTuid) {
        const p = meshes.find(
          (a) =>
            a.asset_tuid === prioritizedAssetTuid &&
            !cache.byAsset.has(a.asset_tuid),
        );
        if (p) next = p;
      }
      // Otherwise, build the first asset that has placements + isn't built.
      if (!next) {
        for (const a of meshes) {
          if (cache.byAsset.has(a.asset_tuid)) continue;
          if (!grouped.has(a.asset_tuid)) continue;
          next = a;
          break;
        }
      }
      if (!next) return; // Nothing left.

      const submeshes = next.submeshes.map((s) => ({
        geom: buildMeshGeometry(s),
        material: getMaterial(s.albedo_id, s.normal_id, s.emissive_id),
      }));
      cache.byAsset.set(next.asset_tuid, submeshes);

      // Force a re-render so React picks up the new cache entry, then
      // schedule the next build.
      bumpBuildVersion((v) => v + 1);
      schedule();
    };

    const schedule = () => {
      if (cancelled) return;
      // requestIdleCallback yields to user input + paint; browsers without
      // it (Safari historically) fall back to setTimeout(0).
      const ric =
        (window as Window & {
          requestIdleCallback?: (cb: () => void) => number;
        }).requestIdleCallback;
      if (typeof ric === "function") {
        ric(buildOne);
      } else {
        setTimeout(buildOne, 0);
      }
    };

    schedule();
    return () => {
      cancelled = true;
    };
    // `meshes` ref changes when streaming flushes. `grouped` changes when
    // instances arrive. `prioritizedAssetTuid` changes when the user picks
    // a new selection. All trigger a rescan; the cache check inside
    // buildOne prevents duplicate work.
  }, [meshes, grouped, cache, prioritizedAssetTuid]);

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
      buildMeshGeometry(ufrag.mesh),
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
      {meshes.map((u, idx) => (
        <UFragMeshNode
          // Bayou's data emits duplicate ufrag tuids across zones (the
          // `tuid` is local to a zone, not globally unique). Suffix with
          // the array index to dedupe the React keys — we already store
          // the actual ufrag identity inside the node's userData, so the
          // index suffix only matters for React's reconciliation.
          key={`${u.tuid}-${idx}`}
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
      {ufrags.map((u, idx) => (
        <mesh key={`${u.tuid}-${idx}`} position={u.position}>
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
  /** Tuid of the primary selected instance — when set, this overlay
   *  skips that one because `SkinnedSelectionOverlay` already draws a
   *  live, animated `THREE.SkeletonHelper` for it. Avoids drawing two
   *  bone wireframes on top of each other (one bind-pose static, one
   *  animated). */
  skipInstanceTuid?: string | null;
}

function BoneOverlay({
  instances,
  selectedIds,
  mobyAssets,
  edits,
  skipInstanceTuid,
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
      // The primary's animated skeleton is drawn by SkinnedSelectionOverlay
      // via THREE.SkeletonHelper, which tracks live bone matrices. Drawing
      // our static bind-pose lines on top of that would visually
      // contradict the animated rig.
      if (skipInstanceTuid && inst.tuid === skipInstanceTuid) continue;
      const seg = segmentsByAsset.get(inst.asset_tuid);
      if (!seg) continue;
      out.push({
        key: inst.tuid,
        segments: seg,
        transform: resolvedTransform(inst, edits),
      });
    }
    return out;
  }, [instances, selectedIds, segmentsByAsset, edits, skipInstanceTuid]);

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
  /** Level folder — needed so we can fetch the animset clip from
   *  `<level>/animsets.dat`. When null, animation playback is skipped
   *  (mesh stays in bind pose). */
  levelFolder: string | null;
  /** When true, play the loaded clip via AnimationMixer. False keeps
   *  the rig in bind pose. Driven by a Toolbar toggle. */
  playAnimation: boolean;
  /** When true, attach a `THREE.SkeletonHelper` to the rig so the user
   *  sees bones moving in lockstep with the animation. Driven by the
   *  same Toolbar "Bones" toggle that drives BoneOverlay. */
  showBones: boolean;
  /** Optional override for which clip to play. When set, this hash is
   *  fetched + applied instead of the moby's own `animset_hash`. Null
   *  falls back to the moby's default. */
  overrideAnimsetHash: string | null;
}

function SkinnedSelectionOverlay({
  primary,
  instances,
  mobyAssets,
  textures,
  edits,
  levelFolder,
  playAnimation,
  showBones,
  overrideAnimsetHash,
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
    const anySkinned = found.submeshes.some((s) => s.bone_indices_b64.length > 0);
    if (!anySkinned) return null;
    return found;
  }, [primaryInst, mobyAssets]);

  // Build the SkinnedMesh + Skeleton + GPU resources whenever the asset
  // changes. Heavy step — disposed on cleanup.
  const built = useMemo(() => {
    if (!asset || !asset.skeleton) return null;
    return buildSkinnedAsset(asset);
  }, [asset]);

  // Patch material textures every render. Originally this lived in a
  // `useEffect([built, asset, textures])` — but `textures` is a Map whose
  // identity never changes when entries are added (the hook mutates it).
  // That meant late-arriving textures (decoded via the idle queue after
  // the user selected a character) never reached the SkinnedMesh and the
  // rig rendered with white placeholder materials forever.
  //
  // Doing it in render body is correct because the operation is purely
  // idempotent property assignment — the `mat.map !== albedo` guard
  // makes redundant re-runs free, and `needsUpdate` only flips when a
  // texture actually changed.
  if (built && asset) {
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
  }

  // Free GPU resources when the overlay unmounts (selection cleared) or
  // when we swap to a different asset. Cleanup function captured at
  // memo-resolve time so it runs against the right `built`.
  useEffect(() => {
    return () => built?.dispose();
  }, [built]);

  // Fetch the animset clip whenever the asset's animset_hash OR the
  // user-selected override changes. Override wins when set — that's
  // how the Hierarchy "Animations" section retargets the active clip
  // onto whichever character is selected, even if the moby's own
  // animset_hash points elsewhere (or doesn't exist at all).
  const [clip, setClip] = useState<DecodedClip | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  useEffect(() => {
    setClip(null);
    setClipError(null);
    if (!asset || !levelFolder) return;
    const targetHash = overrideAnimsetHash ?? asset.animset_hash;
    if (!targetHash) return;
    let cancelled = false;
    const bpio = asset.bind_pose_inverse_offset ?? 0;
    const ss = asset.skeleton?.scale_shift ?? 0;
    fetchAnimsetClip(levelFolder, targetHash, bpio, ss)
      .then((c) => {
        if (!cancelled) setClip(c);
      })
      .catch((e) => {
        if (!cancelled) setClipError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [asset, levelFolder, overrideAnimsetHash]);

  // Build a THREE.AnimationClip from the decoded data + drive it with an
  // AnimationMixer. Re-runs when the clip swaps. Static rigs (no clip
  // available, or playAnimation toggle off) skip the mixer entirely so
  // the bones stay at bind pose.
  const mixerData = useMemo(() => {
    if (!built || !clip || !playAnimation) return null;
    const aclip = buildAnimationClipFromDecoded(clip, built.bones.length);
    if (aclip.tracks.length === 0) return null;
    const mixer = new THREE.AnimationMixer(built.root);
    const action = mixer.clipAction(aclip);
    action.play();
    return { mixer, clip: aclip };
  }, [built, clip, playAnimation]);

  // Per-frame mixer.update — react-three-fiber's useFrame fires every
  // render. delta is in seconds.
  useFrame((_state, delta) => {
    mixerData?.mixer.update(delta);
  });

  // Stop + free the mixer when the rig changes. (THREE doesn't have a
  // `dispose()` for AnimationMixer but stopping all action releases
  // the runtime caches.)
  useEffect(() => {
    return () => {
      if (mixerData) {
        mixerData.mixer.stopAllAction();
        mixerData.mixer.uncacheRoot(built!.root);
      }
    };
  }, [mixerData, built]);

  // SkeletonHelper tracks live bone matrices every frame — exactly what
  // we want when animation is playing. Memoized on `built` so the helper
  // is re-created only when the rig changes (selection swap), not on
  // every showBones toggle.
  const skeletonHelper = useMemo(() => {
    if (!built) return null;
    const helper = new THREE.SkeletonHelper(built.root);
    // Default LineBasicMaterial color is hard-coded inside SkeletonHelper;
    // override to match BoneOverlay's cyan so the look is consistent.
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.color = BONE_COLOR;
    mat.depthTest = false;
    mat.transparent = true;
    mat.opacity = 0.95;
    helper.renderOrder = 1000;
    return helper;
  }, [built]);

  // Make the entire rig transparent to picking — clicks should reach the
  // InstancedMesh underneath so the user can switch selection by clicking
  // a different character. Without this, the SkinnedMesh swallows the
  // hit (no handler → R3F doesn't always fall through to the instance
  // beneath) and clicks on the rig area become no-ops.
  useEffect(() => {
    if (!built) return;
    built.root.traverse((obj) => {
      // `Object3D.raycast` is the per-object hit test. Replacing it with
      // a no-op makes the raycaster skip this subtree entirely. The
      // SkinnedMesh still RENDERS — only picking is bypassed.
      obj.raycast = () => {};
    });
  }, [built]);

  // Dispose the SkeletonHelper alongside the rig.
  useEffect(() => {
    return () => {
      // SkeletonHelper has no `.dispose()` of its own — its geometry +
      // material are owned by it; just drop the reference.
      if (skeletonHelper) {
        (skeletonHelper.geometry as THREE.BufferGeometry).dispose();
        (skeletonHelper.material as THREE.Material).dispose();
      }
    };
  }, [skeletonHelper]);

  if (!built || !primaryInst) return null;
  // Ignore clipError display — the Inspector will surface it. The rig
  // still renders in bind pose.
  void clipError;

  const t = resolvedTransform(primaryInst, edits);

  return (
    <group
      position={t.position}
      quaternion={t.quaternion}
      scale={t.scale}
    >
      <primitive object={built.root} />
      {showBones && skeletonHelper && (
        <primitive object={skeletonHelper} />
      )}
    </group>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Main viewport.
 * ──────────────────────────────────────────────────────────────────────── */

interface ViewportProps {
  instances: InstanceData[];
  ufrags: UFragBounds[];
  meshes: LevelMeshes | null;
  /** Texture PNG bytes keyed by id. Null while the bulk binary IPC
   *  fetch is still in flight after the streaming pipeline finishes
   *  emitting metadata. Materials render with placeholders until
   *  this resolves. */
  textureBlobs: TextureBlobMap | null;
  selection: Selection;
  view: ViewSettings;
  /** Bumps when the user clicks the Inspector's "Go to" button. */
  focusVersion: number;
  /** Per-instance transform overrides + edit-mode toggle. */
  edits: Edits;
  meshLoadPhase?: LoadPhaseState | null;
  /** Path to the currently-open level. Threaded through to the
   *  SkinnedSelectionOverlay so it can fetch animset clips from
   *  `<level>/animsets.dat`. Null when no level is loaded. */
  levelFolder: string | null;
  /** When non-null, the SkinnedSelectionOverlay plays this clip on the
   *  primary selection instead of the moby's own animset. Driven by
   *  the Hierarchy's "Animations" section — clicking a clip there
   *  flips this on/off. */
  overrideAnimsetHash: string | null;
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
  textureBlobs,
  selection,
  view,
  focusVersion,
  edits,
  meshLoadPhase,
  levelFolder,
  overrideAnimsetHash,
}: ViewportProps) {
  const onPick = (inst: InstanceData, e: ThreeEvent<MouseEvent>) =>
    // Plain double-click in the viewport behaves identically to a
    // click in the Hierarchy: replaces the selection with this single
    // instance, sets it as primary (drives the Inspector), and becomes
    // the new shift-range anchor. ctrl/shift modifiers extend through
    // the regular selection paths.
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
  const textureMap = useTextureMap(textureBlobs ?? EMPTY_TEXTURE_BLOBS);

  // Lifted state so the in-canvas effect can flip on/off based on the
  // canvas element it gets handed at mount time. Set once.
  const [contextLost, setContextLost] = useState(false);

  // Asset_tuid of the primary selection — passed to AssetGroup as a
  // priority hint so a clicked-but-not-yet-built moby skips the queue.
  const prioritizedAssetTuid = useMemo(() => {
    if (!selection.primary) return null;
    const inst = instances.find((i) => i.tuid === selection.primary);
    return inst?.asset_tuid ?? null;
  }, [selection.primary, instances]);
  return (
    <div className="viewport">
      {contextLost && (
        <div className="viewport-overlay" style={{ top: 12, right: 12, color: "#ffbc33" }}>
          ⚠ WebGL context lost — reload to recover
        </div>
      )}
      <Canvas
        camera={{ position: [50, 50, 50], fov: 55, near: 0.1, far: 2000 }}
        // Use a low-power preference + disable antialias on the secondary
        // pass — this leaves more GPU memory for the level's textures
        // and reduces the chance of a context loss on resource-tight
        // integrated GPUs (some users hit this on default settings).
        gl={{
          antialias: true,
          // `powerPreference: "high-performance"` asks the browser to
          // use the discrete GPU on hybrid systems. Without it, Chromium
          // sometimes routes the canvas to the integrated GPU which
          // chokes on the level's texture set.
          powerPreference: "high-performance",
          // `failIfMajorPerformanceCaveat: false` (default) lets the
          // canvas survive on weaker GPUs instead of refusing creation.
        }}
        // Listen for context loss so we can show a recoverable error
        // instead of silently freezing. If the GPU drops the context
        // mid-frame (driver killed it under load), the Canvas's render
        // loop keeps running but every gl call is a no-op — visually
        // looks identical to a hang.
        onCreated={({ gl }) => {
          const canvas = gl.domElement;
          canvas.addEventListener(
            "webglcontextlost",
            (e) => {
              // Default behavior is "lose forever". Calling preventDefault
              // tells the browser we want a chance to restore.
              e.preventDefault();
              setContextLost(true);
              // eslint-disable-next-line no-console
              console.error("WebGL context lost. Reduce open levels / textures.");
            },
            false,
          );
          canvas.addEventListener(
            "webglcontextrestored",
            () => {
              setContextLost(false);
              // eslint-disable-next-line no-console
              console.log("WebGL context restored.");
            },
            false,
          );
        }}
        // Selection is double-click only; single-click on empty space is
        // reserved for OrbitControls. Use onDoubleClick + check it really
        // landed on empty space (no instance hit).
        onPointerMissed={(e) => {
          // R3F fires `onPointerMissed` when a click lands on the canvas
          // but doesn't hit any object. This is the proper empty-space
          // hook (vs `onDoubleClick` which fires for every click on the
          // root canvas regardless of whether something was hit). Single
          // click on empty space clears the selection.
          selection.select(null, clickMods(e as MouseEvent));
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

        {(meshLoadPhase || !meshes) && (
          <>
            <ProxyPlacementGroup
              kind="tie"
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showTies}
              edits={edits.edits}
            />
            <ProxyPlacementGroup
              kind="moby"
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showMobys}
              edits={edits.edits}
            />
          </>
        )}

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
              prioritizedAssetTuid={prioritizedAssetTuid}
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
              prioritizedAssetTuid={prioritizedAssetTuid}
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
            skipInstanceTuid={selection.primary}
          />
        )}

        {meshes && (
          <SkinnedSelectionOverlay
            primary={selection.primary}
            instances={instances}
            mobyAssets={meshes.moby_assets}
            textures={textureMap}
            edits={edits.edits}
            levelFolder={levelFolder}
            playAnimation={view.playAnimation}
            showBones={view.showBones}
            overrideAnimsetHash={overrideAnimsetHash}
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
