import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bone,
  Box,
  Compass,
  Download,
  Grid3x3,
  type LucideIcon,
  Mountain,
  Play,
  Square,
  Users,
} from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import {
  GizmoHelper,
  Grid,
  Html,
  OrbitControls,
  TransformControls,
  useGizmoContext,
} from "@react-three/drei";
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
} from "../api";
import {
  decodeMeshGeom,
  exportLevelGlb,
  fetchAnimsetClip,
  readCachedBytes,
  type LevelGlbExportEvent,
} from "../api";
import { buildAnimationClipFromDecoded, buildSkinnedAsset } from "../skinning";
import { FpsOverlay, FpsSampler } from "../components/FpsOverlay";
import type { LoadPhaseState } from "../components/LoadProgress";
import { clickMods, type useSelection } from "../selection";
import { resolvedTransform, type InstanceEdit, type useEdits } from "../edits";
import { useAssetColors } from "../useApplySettings";

type Selection = ReturnType<typeof useSelection>;
type Edits = ReturnType<typeof useEdits>;

const EMPTY_TEXTURE_BLOBS: TextureBlobMap = new Map();





const EMISSIVE_TINT_WHITE = new THREE.Color(0xffffff);

export type BooleanViewSetting = {
  [K in keyof ViewSettings]: ViewSettings[K] extends boolean ? K : never;
}[keyof ViewSettings];

export interface ViewSettings {
  showMobys: boolean;
  showTies: boolean;
  showDetails: boolean;
  showShrubs: boolean;
  showFoliage: boolean;
  showLights: boolean;
  showEnvSamplers: boolean;
  showCollision: boolean;
  showSkyDome: boolean;
  showUFrags: boolean;
  skyboxTextureId: number | null;
  showUFragBounds: boolean;
  showGrid: boolean;
  showAxes: boolean;
  showStats: boolean;
  showBones: boolean;


  playAnimation: boolean;
}









function buildOneTexture(blob: Blob): THREE.Texture {
  const tex = new THREE.Texture();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false; 
  
  
  
  
  
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  
  
  
  
  
  if (typeof createImageBitmap === "function") {
    createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "none" })
      .then((bitmap) => {
        tex.image = bitmap;
        tex.needsUpdate = true;
      })
      .catch(() => {
        
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

  
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const tex of cache.values()) tex.dispose();
      cache.clear();
    };
  }, []);

  return cacheRef.current;
}





function buildGeometry(
  positions: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (uvs.length > 0) geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  
  
  
  
  
  
  
  
  
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
  const assetColors = useAssetColors();
  const color =
    kind === "moby"
      ? assetColors.moby
      : kind === "detail"
        ? assetColors.detail
        : kind === "shrub"
          ? assetColors.shrub
          : kind === "foliage"
            ? assetColors.foliage
            : assetColors.tie;
  const selectionColor = assetColors.selection;

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const baseColor = new THREE.Color(color);
    const selColor = new THREE.Color(selectionColor);
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
      mesh.setColorAt(i, selectedIds.has(inst.tuid) ? selColor : baseColor);
    }
    mesh.count = filtered.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    
    
    mesh.computeBoundingSphere();
  }, [filtered, selectedIds, edits, kind, color, selectionColor]);

  if (!visible || filtered.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, filtered.length]}
      
      
      
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

function LightGizmoGroup({
  instances,
  selectedIds,
  onPick,
  visible,
}: {
  instances: InstanceData[];
  selectedIds: Set<string>;
  onPick: (instance: InstanceData, e: ThreeEvent<MouseEvent>) => void;
  visible: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const filtered = useMemo(
    () => instances.filter((i) => i.kind === "light"),
    [instances],
  );
  const assetColors = useAssetColors();
  const baseColor = useMemo(
    () => new THREE.Color(assetColors.light),
    [assetColors.light],
  );
  const selColor = useMemo(
    () => new THREE.Color(assetColors.selection),
    [assetColors.selection],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion(0, 0, 0, 1);
    const scl = new THREE.Vector3(1, 1, 1);
    const tint = new THREE.Color();
    for (let i = 0; i < filtered.length; i++) {
      const inst = filtered[i]!;
      pos.set(inst.position[0]!, inst.position[1]!, inst.position[2]!);
      const r = Math.max(0.05, inst.scale[0] ?? 0.1);
      const g = Math.max(0.05, inst.scale[1] ?? 0.1);
      const b = Math.max(0.05, inst.scale[2] ?? 0.1);
      tint.setRGB(r, g, b);
      const max = Math.max(tint.r, tint.g, tint.b, 1);
      tint.r /= max;
      tint.g /= max;
      tint.b /= max;
      tint.lerp(baseColor, 0.5);
      scl.set(0.6, 0.6, 0.6);
      m.compose(pos, quat, scl);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, selectedIds.has(inst.tuid) ? selColor : tint);
    }
    mesh.count = filtered.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [filtered, selectedIds, baseColor, selColor]);

  if (!visible || filtered.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, filtered.length]}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        const id = e.instanceId;
        if (id != null) {
          const inst = filtered[id];
          if (inst) onPick(inst, e);
        }
      }}
    >
      <icosahedronGeometry args={[1, 1]} />
      <meshBasicMaterial wireframe transparent opacity={0.85} />
    </instancedMesh>
  );
}

function SkyboxBackground({
  textureId,
  levelFolder,
}: {
  textureId: number | null;
  levelFolder: string | null;
}) {
  const { scene } = useThree();
  const [tex, setTex] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    if (textureId == null || !levelFolder) {
      setTex(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    let loadedTex: THREE.Texture | null = null;
    void (async () => {
      try {
        const bytes = await readCachedBytes(
          levelFolder,
          `textures/${textureId}.png`,
        );
        if (cancelled) return;
        const blob = new Blob([bytes as ArrayBuffer], { type: "image/png" });
        url = URL.createObjectURL(blob);
        const loader = new THREE.TextureLoader();
        loader.load(url, (t) => {
          if (cancelled) {
            t.dispose();
            return;
          }
          t.colorSpace = THREE.SRGBColorSpace;
          t.mapping = THREE.EquirectangularReflectionMapping;
          loadedTex = t;
          setTex(t);
        });
      } catch {
        if (!cancelled) setTex(null);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      if (loadedTex) loadedTex.dispose();
    };
  }, [textureId, levelFolder]);

  useEffect(() => {
    scene.background = tex;
    return () => {
      if (scene.background === tex) scene.background = null;
    };
  }, [scene, tex]);

  return null;
}

function CollisionWireframeGroup({
  visible,
  cacheFolder: _cacheFolder,
}: {
  visible: boolean;
  cacheFolder: string | null;
}) {
  if (!visible) return null;
  return null;
}

function EnvSamplerGizmoGroup({
  instances,
  selectedIds,
  onPick,
  visible,
}: {
  instances: InstanceData[];
  selectedIds: Set<string>;
  onPick: (instance: InstanceData, e: ThreeEvent<MouseEvent>) => void;
  visible: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const filtered = useMemo(
    () => instances.filter((i) => i.kind === "envsampler"),
    [instances],
  );
  const assetColors = useAssetColors();
  const baseColor = useMemo(
    () => new THREE.Color(assetColors.envsampler),
    [assetColors.envsampler],
  );
  const selColor = useMemo(
    () => new THREE.Color(assetColors.selection),
    [assetColors.selection],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion(0, 0, 0, 1);
    const scl = new THREE.Vector3();
    for (let i = 0; i < filtered.length; i++) {
      const inst = filtered[i]!;
      pos.set(inst.position[0]!, inst.position[1]!, inst.position[2]!);
      const sx = Math.max(0.1, (inst.scale[0] ?? 1) * 2);
      const sy = Math.max(0.1, (inst.scale[1] ?? 1) * 2);
      const sz = Math.max(0.1, (inst.scale[2] ?? 1) * 2);
      scl.set(sx, sy, sz);
      m.compose(pos, quat, scl);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, selectedIds.has(inst.tuid) ? selColor : baseColor);
    }
    mesh.count = filtered.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [filtered, selectedIds, baseColor, selColor]);

  if (!visible || filtered.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, filtered.length]}
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
      <meshBasicMaterial wireframe transparent opacity={0.55} />
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
    selectedColor: THREE.Color;
  } | null>(null);
  const indexByTuid = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < instances.length; i++) {
      m.set(instances[i]!.tuid, i);
    }
    return m;
  }, [instances]);
  const assetColors = useAssetColors();
  
  
  
  const selectedColor = useMemo(
    () => new THREE.Color(assetColors.selection),
    [assetColors.selection],
  );

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
    
    
    
    
    
    
    
    
    
    mesh.computeBoundingSphere();
  }, [instances, edits]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const colorAt = (index: number) => {
      const inst = instances[index]!;
      mesh.setColorAt(
        index,
        selectedIds.has(inst.tuid) ? selectedColor : baseColor,
      );
    };

    const prev = prevColorStateRef.current;
    const needsFullRefresh =
      prev === null ||
      prev.indexByTuid !== indexByTuid ||
      prev.baseColor !== baseColor ||
      prev.selectedColor !== selectedColor;

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
      selectedColor,
    };
  }, [instances, indexByTuid, selectedIds, baseColor, selectedColor]);

  if (instances.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, instances.length]}
      
      
      
      
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
      
      
      emissive: emissive ? 0xffffff : 0x000000,
      emissiveIntensity: emissive ? 0.7 : 0,
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      
      
      
      
      
      
      flatShading: false, 
    });
    cache.materials.set(key, m);
    return m;
  }

  
  
  
  
  
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

  
  
  
  
  
  const meshesByTuid = useMemo(() => {
    const m = new Map<string, AssetMeshes>();
    for (const a of meshes) m.set(a.asset_tuid, a);
    return m;
  }, [meshes]);

  
  
  
  for (const [assetTuid] of grouped) {
    const existing = cache.byAsset.get(assetTuid);
    if (!existing) continue;
    const a = meshesByTuid.get(assetTuid);
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

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const [, bumpBuildVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;

    const buildOne = () => {
      if (cancelled) return;
      
      
      
      let next: (typeof meshes)[number] | null = null;
      if (prioritizedAssetTuid) {
        const p = meshes.find(
          (a) =>
            a.asset_tuid === prioritizedAssetTuid &&
            !cache.byAsset.has(a.asset_tuid),
        );
        if (p) next = p;
      }
      
      if (!next) {
        for (const a of meshes) {
          if (cache.byAsset.has(a.asset_tuid)) continue;
          if (!grouped.has(a.asset_tuid)) continue;
          next = a;
          break;
        }
      }
      if (!next) return; 

      const submeshes = next.submeshes.map((s) => ({
        geom: buildMeshGeometry(s),
        material: getMaterial(s.albedo_id, s.normal_id, s.emissive_id),
      }));
      cache.byAsset.set(next.asset_tuid, submeshes);

      
      
      bumpBuildVersion((v) => v + 1);
      schedule();
    };

    const schedule = () => {
      if (cancelled) return;
      
      
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
    
    
    
    
  }, [meshes, grouped, cache, prioritizedAssetTuid]);

  
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

  const assetColorMap = useAssetColors();
  const baseColor = useMemo(
    () =>
      kind === "detail"
        ? new THREE.Color(assetColorMap.detail).lerp(
            new THREE.Color("#ffffff"),
            0.55,
          )
        : kind === "shrub"
          ? new THREE.Color(assetColorMap.shrub).lerp(
              new THREE.Color("#ffffff"),
              0.55,
            )
          : kind === "foliage"
            ? new THREE.Color(assetColorMap.foliage).lerp(
                new THREE.Color("#ffffff"),
                0.55,
              )
            : new THREE.Color("#ffffff"),
    [kind, assetColorMap.detail, assetColorMap.shrub, assetColorMap.foliage],
  );

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





function UFragMeshNode({
  ufrag,
  texture,
  fallbackColor,
  selected,
  onClick,
}: {
  ufrag: UFragMesh;
  texture: THREE.Texture | null;
  fallbackColor: THREE.Color;
  selected: boolean;
  onClick: (ufrag: UFragMesh, e: ThreeEvent<MouseEvent>) => void;
}) {
  const geom = useMemo(
    () =>
      buildMeshGeometry(ufrag.mesh),
    [ufrag],
  );
  useEffect(() => () => geom.dispose(), [geom]);

  return (
    <mesh
      position={ufrag.position}
      geometry={geom}
      onClick={(e) => {
        e.stopPropagation();
        onClick(ufrag, e);
      }}
    >
      {texture ? (
        <meshStandardMaterial
          map={texture}
          color={selected ? 0xff8855 : 0xffffff}
          roughness={0.9}
          metalness={0}
        />
      ) : (
        <meshStandardMaterial
          color={selected ? 0xff8855 : fallbackColor}
          roughness={0.9}
          metalness={0}
        />
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
  selectedTuid,
  onPickUFrag,
}: {
  meshes: UFragMesh[];
  textures: Map<number, THREE.Texture>;
  visible: boolean;
  selectedTuid: string | null;
  onPickUFrag: (ufrag: UFragMesh, e: ThreeEvent<MouseEvent>) => void;
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
          key={`${u.tuid}-${idx}`}
          ufrag={u}
          texture={u.mesh.albedo_id != null ? textures.get(u.mesh.albedo_id) ?? null : null}
          fallbackColor={colorByZone.get(u.zone_tuid)!}
          selected={selectedTuid === u.tuid}
          onClick={onPickUFrag}
        />
      ))}
    </group>
  );
}





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







function CameraFocus({
  primary,
  instances,
  focusVersion,
}: {
  primary: string | null;
  instances: InstanceData[];
  
  focusVersion: number;
}) {
  const { camera, controls } = useThree();
  const lastFocusedRef = useRef<string | null>(null);
  const lastVersionRef = useRef<number>(-1);
  
  
  
  
  
  const tweensRef = useRef<gsap.core.Tween[]>([]);

  
  useEffect(() => {
    return () => {
      for (const t of tweensRef.current) t.kill();
      tweensRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!primary) return;
    if (!controls) return;
    
    
    const versionChanged = focusVersion !== lastVersionRef.current;
    const primaryChanged = primary !== lastFocusedRef.current;
    if (!versionChanged && !primaryChanged) return;
    const inst = instances.find((i) => i.tuid === primary);
    if (!inst) return;
    lastFocusedRef.current = primary;
    lastVersionRef.current = focusVersion;

    
    
    for (const t of tweensRef.current) t.kill();
    tweensRef.current = [];

    const orbit = controls as unknown as OrbitControlsImpl;
    const cam = camera as THREE.PerspectiveCamera;
    const targetPos = new THREE.Vector3(
      inst.position[0]!,
      inst.position[1]!,
      inst.position[2]!,
    );

    
    
    
    const currentOffset = cam.position.clone().sub(orbit.target);
    const distance = Math.max(20, Math.min(currentOffset.length(), 100));
    const newOffset = currentOffset.clone().normalize().multiplyScalar(distance);
    const newCamPos = targetPos.clone().add(newOffset);

    tweensRef.current.push(
      gsap.to(orbit.target, {
        x: targetPos.x,
        y: targetPos.y,
        z: targetPos.z,
        duration: 0.5,
        ease: "power2.out",
        onUpdate: () => orbit.update(),
      }),
    );
    tweensRef.current.push(
      gsap.to(cam.position, {
        x: newCamPos.x,
        y: newCamPos.y,
        z: newCamPos.z,
        duration: 0.5,
        ease: "power2.out",
      }),
    );
  }, [primary, focusVersion, instances, camera, controls]);

  return null;
}

function CameraSnap({
  direction,
  version,
}: {
  direction: "front" | "right" | "top" | null;
  version: number;
}) {
  const { camera, controls } = useThree();
  const lastVersionRef = useRef<number>(-1);

  useEffect(() => {
    if (!direction) return;
    if (!controls) return;
    if (version === lastVersionRef.current) return;
    lastVersionRef.current = version;

    const orbit = controls as unknown as OrbitControlsImpl;
    const cam = camera as THREE.PerspectiveCamera;
    const target = orbit.target.clone();
    const distance = Math.max(20, cam.position.distanceTo(target));

    const offset = new THREE.Vector3();
    const upTarget = new THREE.Vector3(0, 1, 0);
    switch (direction) {
      case "front":
        offset.set(0, 0, distance);
        break;
      case "right":
        offset.set(distance, 0, 0);
        break;
      case "top":
        offset.set(0, distance, 0);
        upTarget.set(0, 0, -1);
        break;
    }
    const newCamPos = target.clone().add(offset);

    gsap.to(cam.position, {
      x: newCamPos.x,
      y: newCamPos.y,
      z: newCamPos.z,
      duration: 0.4,
      ease: "power2.out",
      onUpdate: () => {
        cam.lookAt(target);
        orbit.update();
      },
    });
    gsap.to(cam.up, {
      x: upTarget.x,
      y: upTarget.y,
      z: upTarget.z,
      duration: 0.4,
      ease: "power2.out",
    });
  }, [direction, version, camera, controls]);

  return null;
}

const AXIS_X_COLOR = "#ff5577";
const AXIS_Y_COLOR = "#7dd957";
const AXIS_Z_COLOR = "#3aa3ff";
const AXIS_LABEL_FG = "#0b0c0e";

type AxisKey = "x" | "y" | "z";

function AxisHead({
  position,
  arcStyle,
  label,
  faded,
  onActivate,
}: {
  position: [number, number, number];
  arcStyle: string;
  label: string;
  faded?: boolean;
  onActivate: () => void;
}) {
  const gl = useThree((s) => s.gl);
  const [hover, setHover] = useState(false);

  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(32, 32, 16, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = arcStyle;
    ctx.fill();
    if (faded) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = arcStyle;
      ctx.stroke();
    }
    ctx.font = "bold 18px Inter, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = AXIS_LABEL_FG;
    ctx.fillText(label, 32, 33);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [arcStyle, label, faded]);

  const baseScale = faded ? 0.85 : 1.0;
  const scale = baseScale * (hover ? 1.2 : 1);

  return (
    <sprite
      position={position}
      scale={scale}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHover(false);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onActivate();
      }}
    >
      <spriteMaterial
        map={texture}
        map-anisotropy={gl.capabilities.getMaxAnisotropy() || 1}
        alphaTest={0.3}
        opacity={faded ? 0.55 : 1}
        toneMapped={false}
      />
    </sprite>
  );
}

function AxisLine({
  rotation,
  color,
}: {
  rotation: [number, number, number];
  color: string;
}) {
  return (
    <group rotation={rotation}>
      <mesh position={[0.4, 0, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.05]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

function GizmoViewportSixAxis() {
  const { tweenCamera } = useGizmoContext();
  const lastSignedAxisRef = useRef<string | null>(null);

  const handleClick = useCallback(
    (axis: AxisKey, sign: 1 | -1) => {
      const key = `${sign > 0 ? "+" : "-"}${axis}`;
      const flip = lastSignedAxisRef.current === key;
      const finalSign = flip ? -sign : sign;
      const dir = new THREE.Vector3(
        axis === "x" ? finalSign : 0,
        axis === "y" ? finalSign : 0,
        axis === "z" ? finalSign : 0,
      );
      tweenCamera(dir);
      lastSignedAxisRef.current = `${finalSign > 0 ? "+" : "-"}${axis}`;
    },
    [tweenCamera],
  );

  return (
    <group scale={40}>
      <AxisLine rotation={[0, 0, 0]} color={AXIS_X_COLOR} />
      <AxisLine rotation={[0, 0, Math.PI / 2]} color={AXIS_Y_COLOR} />
      <AxisLine rotation={[0, -Math.PI / 2, 0]} color={AXIS_Z_COLOR} />

      <AxisHead
        position={[1, 0, 0]}
        arcStyle={AXIS_X_COLOR}
        label="X"
        onActivate={() => handleClick("x", 1)}
      />
      <AxisHead
        position={[0, 1, 0]}
        arcStyle={AXIS_Y_COLOR}
        label="Y"
        onActivate={() => handleClick("y", 1)}
      />
      <AxisHead
        position={[0, 0, 1]}
        arcStyle={AXIS_Z_COLOR}
        label="Z"
        onActivate={() => handleClick("z", 1)}
      />

      <AxisHead
        position={[-1, 0, 0]}
        arcStyle={AXIS_X_COLOR}
        label="-X"
        faded
        onActivate={() => handleClick("x", -1)}
      />
      <AxisHead
        position={[0, -1, 0]}
        arcStyle={AXIS_Y_COLOR}
        label="-Y"
        faded
        onActivate={() => handleClick("y", -1)}
      />
      <AxisHead
        position={[0, 0, -1]}
        arcStyle={AXIS_Z_COLOR}
        label="-Z"
        faded
        onActivate={() => handleClick("z", -1)}
      />
    </group>
  );
}











const BONE_COLOR = new THREE.Color("#33d5ff");

function buildBoneSegments(
  parents: number[],
  bindLocal: number[][],
): Float32Array | null {
  const n = parents.length;
  if (n === 0 || bindLocal.length !== n) return null;

  
  const worlds: THREE.Matrix4[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Matrix4();
    
    
    m.fromArray(bindLocal[i]!);
    const pi = parents[i]!;
    if (pi >= 0 && pi < i) {
      worlds[i] = worlds[pi]!.clone().multiply(m);
    } else {
      worlds[i] = m;
    }
  }

  
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
  




  skipInstanceTuid?: string | null;
}

function BoneOverlay({
  instances,
  selectedIds,
  mobyAssets,
  edits,
  skipInstanceTuid,
}: BoneOverlayProps) {
  
  
  
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

  
  
  const overlays = useMemo(() => {
    const out: {
      key: string;
      segments: Float32Array;
      transform: ReturnType<typeof resolvedTransform>;
    }[] = [];
    for (const inst of instances) {
      if (inst.kind !== "moby") continue;
      if (!selectedIds.has(inst.tuid)) continue;
      
      
      
      
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
      {


}
      {
}
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
  
  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <lineSegments
      position={position}
      quaternion={quaternion}
      scale={scale}
      
      
      
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













interface SkinnedOverlayProps {
  primary: string | null;
  instances: InstanceData[];
  mobyAssets: AssetMeshes[];
  textures: Map<number, THREE.Texture>;
  edits: Map<string, InstanceEdit>;
  


  levelFolder: string | null;
  

  playAnimation: boolean;
  


  showBones: boolean;
  


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
    
    
    
    const anySkinned = found.submeshes.some((s) => s.bone_indices_b64.length > 0);
    if (!anySkinned) return null;
    return found;
  }, [primaryInst, mobyAssets]);

  
  
  const built = useMemo(() => {
    if (!asset || !asset.skeleton) return null;
    return buildSkinnedAsset(asset);
  }, [asset]);

  
  
  
  
  
  
  
  
  
  
  
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
        mat.emissive = EMISSIVE_TINT_WHITE;
        mat.emissiveIntensity = 0.7;
        touched = true;
      }
      if (touched) mat.needsUpdate = true;
    }
  }

  
  
  
  useEffect(() => {
    return () => built?.dispose();
  }, [built]);

  
  
  
  
  
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

  
  
  
  
  const mixerData = useMemo(() => {
    if (!built || !clip || !playAnimation) return null;
    const aclip = buildAnimationClipFromDecoded(clip, built.bones.length);
    if (aclip.tracks.length === 0) return null;
    const mixer = new THREE.AnimationMixer(built.root);
    const action = mixer.clipAction(aclip);
    action.play();
    return { mixer, clip: aclip };
  }, [built, clip, playAnimation]);

  
  
  useFrame((_state, delta) => {
    mixerData?.mixer.update(delta);
  });

  
  
  
  useEffect(() => {
    return () => {
      if (mixerData) {
        mixerData.mixer.stopAllAction();
        mixerData.mixer.uncacheRoot(built!.root);
      }
    };
  }, [mixerData, built]);

  
  
  
  
  const skeletonHelper = useMemo(() => {
    if (!built) return null;
    const helper = new THREE.SkeletonHelper(built.root);
    
    
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.color = BONE_COLOR;
    mat.depthTest = false;
    mat.transparent = true;
    mat.opacity = 0.95;
    helper.renderOrder = 1000;
    return helper;
  }, [built]);

  
  
  
  
  
  useEffect(() => {
    if (!built) return;
    built.root.traverse((obj) => {
      
      
      
      obj.raycast = () => {};
    });
  }, [built]);

  
  useEffect(() => {
    return () => {
      
      
      if (skeletonHelper) {
        (skeletonHelper.geometry as THREE.BufferGeometry).dispose();
        (skeletonHelper.material as THREE.Material).dispose();
      }
    };
  }, [skeletonHelper]);

  if (!built || !primaryInst) return null;
  
  
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





interface ViewportProps {
  instances: InstanceData[];
  ufrags: UFragBounds[];
  meshes: LevelMeshes | null;
  



  textureBlobs: TextureBlobMap | null;
  selection: Selection;
  view: ViewSettings;
  onToggle: (key: BooleanViewSetting) => void;
  focusVersion: number;
  viewSnap: {
    direction: "front" | "right" | "top" | null;
    version: number;
  };
  edits: Edits;
  meshLoadPhase?: LoadPhaseState | null;
  


  levelFolder: string | null;




  overrideAnimsetHash: string | null;

  hasCachedSky?: boolean;
  cacheVersion?: number;
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
  onToggle,
  focusVersion,
  viewSnap,
  edits,
  meshLoadPhase,
  levelFolder,
  overrideAnimsetHash,
}: ViewportProps) {
  const [mapExportPhase, setMapExportPhase] = useState<{
    label: string;
    current: number;
    total: number;
  } | null>(null);
  const [mapExportError, setMapExportError] = useState<string | null>(null);
  const [mapExportStatus, setMapExportStatus] = useState<string | null>(null);

  const headerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostBtnWidths = useRef<number[]>([]);
  const ghostDividerWidth = useRef<number>(0);
  const moreBtnWidth = useRef<number>(72);
  const [visibleToggleCount, setVisibleToggleCount] = useState<number>(99);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);

  const recomputeCollapse = useCallback(() => {
    const headerEl = headerRef.current;
    const ghostEl = ghostRef.current;
    if (!headerEl || !ghostEl) return;
    const buttons = Array.from(
      ghostEl.querySelectorAll<HTMLElement>("[data-toggle-key]"),
    );
    const widths = buttons.map((b) => b.getBoundingClientRect().width + 2);
    ghostBtnWidths.current = widths;
    const dividerEl = ghostEl.querySelector<HTMLElement>(".viewport-header-divider");
    if (dividerEl) {
      ghostDividerWidth.current = dividerEl.getBoundingClientRect().width + 12;
    }
    if (widths.length === 0) return;

    const exportSlot = 200;
    const moreSlot = moreBtnWidth.current + 6;
    const headerW = headerEl.clientWidth;

    let total = ghostDividerWidth.current;
    for (const w of widths) total += w;
    if (total + exportSlot <= headerW) {
      setVisibleToggleCount(widths.length);
      return;
    }

    let used = exportSlot + moreSlot + ghostDividerWidth.current;
    let count = 0;
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i]!;
      if (used + w > headerW) break;
      used += w;
      count = i + 1;
    }
    setVisibleToggleCount(count);
  }, []);

  useEffect(() => {
    const headerEl = headerRef.current;
    if (!headerEl) return;
    const ro = new ResizeObserver(() => recomputeCollapse());
    ro.observe(headerEl);
    recomputeCollapse();
    return () => ro.disconnect();
  }, [recomputeCollapse]);

  useEffect(() => {
    if (!viewMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".viewport-view-menu") || target?.closest?.(".viewport-view-trigger")) {
        return;
      }
      setViewMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [viewMenuOpen]);

  const handleExportMap = useCallback(async () => {
    if (!levelFolder || mapExportPhase) return;
    let outPath: string | null = null;
    try {
      outPath = (await saveDialog({
        title: "Export full map to GLB",
        defaultPath: "level.glb",
        filters: [{ name: "glTF binary", extensions: ["glb"] }],
      })) as string | null;
    } catch (err) {
      setMapExportError(String(err));
      return;
    }
    if (!outPath) return;

    setMapExportError(null);
    setMapExportStatus(null);
    setMapExportPhase({ label: "Starting…", current: 0, total: 1 });

    const channel = new Channel<LevelGlbExportEvent>();
    let phaseTotal = 1;
    let phaseLabel = "Starting…";
    channel.onmessage = (e) => {
      switch (e.type) {
        case "phase":
          phaseLabel = e.label;
          phaseTotal = Math.max(1, e.total);
          setMapExportPhase({ label: phaseLabel, current: 0, total: phaseTotal });
          break;
        case "progress":
          setMapExportPhase({
            label: phaseLabel,
            current: e.current,
            total: phaseTotal,
          });
          break;
        case "done":
          setMapExportPhase(null);
          setMapExportStatus(
            `Exported ${e.instance_count} instances across ${e.asset_count} assets · ${(e.bytes_written / 1024 / 1024).toFixed(1)} MB`,
          );
          break;
        case "error":
          setMapExportPhase(null);
          setMapExportError(e.message);
          break;
      }
    };

    try {
      await exportLevelGlb(levelFolder, outPath, channel);
    } catch (err) {
      setMapExportPhase(null);
      setMapExportError(String(err));
    }
  }, [levelFolder, mapExportPhase]);

  const onPick = (inst: InstanceData, e: ThreeEvent<MouseEvent>) =>





    selection.select(inst, clickMods(e.nativeEvent));
  const { center, extent } = useMemo(() => {
    function* positions(): Generator<[number, number, number]> {
      for (const i of instances) yield i.position;
      for (const u of ufrags) yield u.position;
    }
    return computeBounds(positions());
  }, [instances, ufrags]);

  
  
  
  const textureMap = useTextureMap(textureBlobs ?? EMPTY_TEXTURE_BLOBS);

  
  
  const [contextLost, setContextLost] = useState(false);

  
  
  const prioritizedAssetTuid = useMemo(() => {
    if (!selection.primary) return null;
    const inst = instances.find((i) => i.tuid === selection.primary);
    return inst?.asset_tuid ?? null;
  }, [selection.primary, instances]);

  const statusInfo = useMemo(() => {
    const primaryInst = selection.primary
      ? instances.find((i) => i.tuid === selection.primary)
      : null;
    const primaryAsset = primaryInst && meshes
      ? meshes.moby_assets.find((a) => a.asset_tuid === primaryInst.asset_tuid) ??
        meshes.tie_assets.find((a) => a.asset_tuid === primaryInst.asset_tuid) ??
        null
      : null;
    let verts = 0;
    let tris = 0;
    if (primaryAsset) {
      for (const sm of primaryAsset.submeshes) {
        const posBytes = Math.floor((sm.positions_b64.length * 3) / 4);
        verts += Math.floor(posBytes / 12);
        const idxBytes = Math.floor((sm.indices_b64.length * 3) / 4);
        tris += Math.floor(idxBytes / 4 / 3);
      }
    }
    return {
      primaryName:
        primaryInst?.name || primaryInst?.tuid.split("#")[0] || null,
      primaryKind: primaryInst?.kind ?? null,
      verts,
      tris,
    };
  }, [selection.primary, instances, meshes]);

  const { t: tr } = useTranslation();
  const hasLevel = instances.length > 0;

  type HeaderToggle = {
    key: BooleanViewSetting;
    label: string;
    Icon: LucideIcon;
    title?: string;
    disabled?: boolean;
  };
  const renderLayerToggles: HeaderToggle[] = [
    { key: "showMobys", label: "Mobys", Icon: Users, disabled: !hasLevel },
    { key: "showTies", label: "Ties", Icon: Box, disabled: !hasLevel },
    { key: "showDetails", label: "Details", Icon: Box, disabled: !hasLevel },
    { key: "showShrubs", label: "Shrubs", Icon: Box, disabled: !hasLevel },
    { key: "showFoliage", label: "Foliage", Icon: Box, disabled: !hasLevel },
    { key: "showLights", label: "Lights", Icon: Box, disabled: !hasLevel },
    {
      key: "showEnvSamplers",
      label: "Env probes",
      Icon: Box,
      disabled: !hasLevel,
    },
    {
      key: "showCollision",
      label: "Collision",
      Icon: Box,
      disabled: !hasLevel,
    },
    {
      key: "showUFrags",
      label: tr("toolbar.terrain"),
      Icon: Mountain,
      disabled: !hasLevel,
    },
  ];
  const overlayToggles: HeaderToggle[] = [
    { key: "showGrid", label: tr("toolbar.grid"), Icon: Grid3x3 },
    { key: "showAxes", label: tr("toolbar.axes"), Icon: Compass },
    { key: "showStats", label: tr("toolbar.stats"), Icon: Activity },
    {
      key: "showUFragBounds",
      label: tr("toolbar.ufragBounds"),
      Icon: Square,
    },
    { key: "showBones", label: tr("toolbar.bones"), Icon: Bone },
    { key: "playAnimation", label: tr("toolbar.play"), Icon: Play },
  ];

  useLayoutEffect(() => {
    recomputeCollapse();
  });

  return (
    <div className="viewport">
      <div className="viewport-header" ref={headerRef}>
        <div className="viewport-header-ghost" ref={ghostRef} aria-hidden>
          {renderLayerToggles.map((tg) => {
            const Icon = tg.Icon;
            return (
              <span
                key={`g-${tg.key}`}
                className="viewport-header-btn"
                data-toggle-key={tg.key}
              >
                <Icon size={13} aria-hidden />
                <span>{tg.label}</span>
              </span>
            );
          })}
          <span className="viewport-header-divider" />
          {overlayToggles.map((tg) => {
            const Icon = tg.Icon;
            return (
              <span
                key={`g-${tg.key}`}
                className="viewport-header-btn"
                data-toggle-key={tg.key}
              >
                <Icon size={13} aria-hidden />
                <span>{tg.label}</span>
              </span>
            );
          })}
        </div>
        {(() => {
          const allToggles: HeaderToggle[] = [];
          for (const tg of renderLayerToggles) allToggles.push(tg);
          for (const tg of overlayToggles) allToggles.push(tg);
          const layerCount = renderLayerToggles.length;
          const visible = allToggles.slice(0, visibleToggleCount);
          const overflow = allToggles.slice(visibleToggleCount);
          const dividerStillInline =
            visibleToggleCount > layerCount && visibleToggleCount <= allToggles.length;
          return (
            <>
              {visible.map((tg, i) => {
                const Icon = tg.Icon;
                const showDivider = dividerStillInline && i === layerCount;
                return (
                  <span key={tg.key} style={{ display: "inline-flex", alignItems: "center" }}>
                    {showDivider && <span className="viewport-header-divider" />}
                    <button
                      type="button"
                      className={`viewport-header-btn ${view[tg.key] ? "active" : ""}`}
                      onClick={() => onToggle(tg.key)}
                      title={tg.title ?? tg.label}
                      disabled={tg.disabled}
                    >
                      <Icon size={13} aria-hidden />
                      <span>{tg.label}</span>
                    </button>
                  </span>
                );
              })}
              {overflow.length > 0 && (
                <div className="viewport-view-trigger-wrap">
                  <button
                    type="button"
                    className="viewport-header-btn viewport-view-trigger"
                    onClick={() => setViewMenuOpen((p) => !p)}
                    aria-expanded={viewMenuOpen}
                    title="More view options"
                  >
                    <span>More</span>
                    <span className="viewport-view-trigger-caret" aria-hidden>
                      ▾
                    </span>
                    <span className="viewport-view-trigger-count">
                      {overflow.length}
                    </span>
                  </button>
                  {viewMenuOpen && (
                    <div className="viewport-view-menu" role="menu">
                      {(() => {
                        const overflowLayerCount = Math.max(
                          0,
                          layerCount - visibleToggleCount,
                        );
                        const overflowLayers = overflow.slice(0, overflowLayerCount);
                        const overflowOverlay = overflow.slice(overflowLayerCount);
                        return (
                          <>
                            {overflowLayers.length > 0 && (
                              <>
                                <div className="viewport-view-menu-section-label">
                                  Layers
                                </div>
                                {overflowLayers.map((tg) => {
                                  const Icon = tg.Icon;
                                  return (
                                    <button
                                      key={tg.key}
                                      type="button"
                                      className={`viewport-view-menu-item ${view[tg.key] ? "active" : ""}`}
                                      onClick={() => onToggle(tg.key)}
                                      disabled={tg.disabled}
                                    >
                                      <Icon size={13} aria-hidden />
                                      <span>{tg.label}</span>
                                      {view[tg.key] && (
                                        <span className="viewport-view-menu-check">
                                          ✓
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </>
                            )}
                            {overflowOverlay.length > 0 && (
                              <>
                                <div className="viewport-view-menu-section-label">
                                  Overlay
                                </div>
                                {overflowOverlay.map((tg) => {
                                  const Icon = tg.Icon;
                                  return (
                                    <button
                                      key={tg.key}
                                      type="button"
                                      className={`viewport-view-menu-item ${view[tg.key] ? "active" : ""}`}
                                      onClick={() => onToggle(tg.key)}
                                      disabled={tg.disabled}
                                    >
                                      <Icon size={13} aria-hidden />
                                      <span>{tg.label}</span>
                                      {view[tg.key] && (
                                        <span className="viewport-view-menu-check">
                                          ✓
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}
        <div className="viewport-header-spacer" />
        <button
          type="button"
          className="viewport-header-export-btn"
          onClick={handleExportMap}
          disabled={!levelFolder || mapExportPhase !== null}
          title={
            !levelFolder
              ? "Open a level first"
              : mapExportPhase
                ? "Exporting…"
                : "Export the full map (placed mobys + ties) to a single GLB"
          }
        >
          <Download size={14} aria-hidden />
          <span className="viewport-header-export-label">
            {mapExportPhase
              ? `${mapExportPhase.label} ${mapExportPhase.current}/${mapExportPhase.total}`
              : "Export map"}
          </span>
          {mapExportPhase && (
            <span
              className="viewport-header-export-progress"
              style={{
                width: `${Math.min(100, (mapExportPhase.current / Math.max(1, mapExportPhase.total)) * 100)}%`,
              }}
              aria-hidden
            />
          )}
        </button>
      </div>
      <div className="viewport-canvas-wrap">
      {contextLost && (
        <div className="viewport-overlay" style={{ top: 12, right: 12, color: "#ffbc33" }}>
          ⚠ WebGL context lost — reload to recover
        </div>
      )}
      {mapExportError && (
        <div
          className="viewport-overlay viewport-export-map-toast error"
          onClick={() => setMapExportError(null)}
          title="Click to dismiss"
        >
          ❌ {mapExportError}
        </div>
      )}
      {mapExportStatus && !mapExportPhase && (
        <div
          className="viewport-overlay viewport-export-map-toast success"
          onClick={() => setMapExportStatus(null)}
          title="Click to dismiss"
        >
          ✓ {mapExportStatus}
        </div>
      )}
      <Canvas
        camera={{ position: [50, 50, 50], fov: 55, near: 0.1, far: 2000 }}
        
        
        
        
        gl={{
          antialias: true,
          
          
          
          
          powerPreference: "high-performance",
          
          
        }}
        
        
        
        
        
        onCreated={({ gl }) => {
          const canvas = gl.domElement;
          canvas.addEventListener(
            "webglcontextlost",
            (e) => {
              
              
              e.preventDefault();
              setContextLost(true);
              
              console.error("WebGL context lost. Reduce open levels / textures.");
            },
            false,
          );
          canvas.addEventListener(
            "webglcontextrestored",
            () => {
              setContextLost(false);
              
              console.log("WebGL context restored.");
            },
            false,
          );
        }}
        
        
        
        onPointerMissed={(e) => {
          
          
          
          
          
          selection.select(null, clickMods(e as MouseEvent));
        }}
      >
        <CameraFrame center={center} extent={extent} />
        <color attach="background" args={["#050608"]} />
        <SkyboxBackground
          textureId={view.skyboxTextureId}
          levelFolder={levelFolder}
        />
        <CollisionWireframeGroup
          visible={view.showCollision}
          cacheFolder={levelFolder}
        />
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
              kind="detail"
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showDetails}
              edits={edits.edits}
            />
            <ProxyPlacementGroup
              kind="shrub"
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showShrubs}
              edits={edits.edits}
            />
            <ProxyPlacementGroup
              kind="foliage"
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showFoliage}
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
              kind="detail"
              meshes={meshes.detail_assets ?? []}
              textures={textureMap}
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showDetails}
              edits={edits.edits}
              prioritizedAssetTuid={prioritizedAssetTuid}
            />
            <AssetGroup
              kind="shrub"
              meshes={meshes.shrub_assets ?? []}
              textures={textureMap}
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showShrubs}
              edits={edits.edits}
              prioritizedAssetTuid={prioritizedAssetTuid}
            />
            <AssetGroup
              kind="foliage"
              meshes={meshes.foliage_assets ?? []}
              textures={textureMap}
              instances={instances}
              selectedIds={selection.ids}
              onPick={onPick}
              visible={view.showFoliage}
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
              selectedTuid={selection.primary}
              onPickUFrag={(u, e) => {
                const synthetic: InstanceData = {
                  tuid: u.tuid,
                  asset_tuid: u.tuid,
                  kind: "ufrag",
                  name: `UFrag ${u.tuid.slice(-8)}`,
                  position: u.position,
                  quaternion: [0, 0, 0, 1],
                  scale: [1, 1, 1],
                };
                selection.select(synthetic, clickMods(e.nativeEvent));
              }}
            />
          </>
        )}

        <LightGizmoGroup
          instances={instances}
          selectedIds={selection.ids}
          onPick={onPick}
          visible={view.showLights}
        />

        <EnvSamplerGizmoGroup
          instances={instances}
          selectedIds={selection.ids}
          onPick={onPick}
          visible={view.showEnvSamplers}
        />

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
        <CameraSnap
          direction={viewSnap.direction}
          version={viewSnap.version}
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
        <GizmoHelper alignment="top-right" margin={[72, 72]}>
          <GizmoViewportSixAxis />
        </GizmoHelper>
      </Canvas>

      <FpsOverlay mode={view.showStats ? "graph" : "counter"} />

      <div
        className="viewport-tool-strip"
        title="Transform tools (apply to selected instance)"
      >
        {(
          [
            { mode: "translate" as const, icon: "⇄", label: "Move" },
            { mode: "rotate" as const, icon: "↻", label: "Rotate" },
            { mode: "scale" as const, icon: "⤢", label: "Scale" },
          ]
        ).map((m) => (
          <button
            key={m.mode}
            type="button"
            className={`viewport-tool-btn ${edits.mode === m.mode ? "active" : ""}`}
            onClick={() => edits.setMode(m.mode)}
            disabled={!selection.primary}
            title={`${m.label} (${m.mode === "translate" ? "G" : m.mode === "rotate" ? "R" : "S"})`}
          >
            <span aria-hidden>{m.icon}</span>
          </button>
        ))}
      </div>

      <div className="viewport-overlay">
        drag <span className="kbd">LMB</span> orbit · scroll zoom · drag{" "}
        <span className="kbd">RMB</span> pan ·{" "}
        <span className="kbd">G</span>/<span className="kbd">R</span>/
        <span className="kbd">S</span> transform · <span className="kbd">F</span> focus ·{" "}
        <span className="kbd">Num1</span>/<span className="kbd">Num3</span>/
        <span className="kbd">Num7</span> view
      </div>
      </div>

      <div className="viewport-statusbar">
        <span className="viewport-status-segment">
          {selection.count > 0
            ? `${selection.count.toLocaleString()} selected`
            : "Nothing selected"}
        </span>
        {statusInfo.primaryName && (
          <span className="viewport-status-segment">
            <span className="dim">Primary:</span> {statusInfo.primaryName}
            {statusInfo.primaryKind && (
              <span className="dim small"> · {statusInfo.primaryKind}</span>
            )}
          </span>
        )}
        {statusInfo.verts > 0 && (
          <span className="viewport-status-segment mono small">
            {statusInfo.verts.toLocaleString()} v ·{" "}
            {statusInfo.tris.toLocaleString()} tri
          </span>
        )}
        <span className="viewport-status-spacer" />
        {edits.count > 0 && (
          <span className="viewport-status-segment viewport-status-warn">
            ● {edits.count} modified
          </span>
        )}
        <span className="viewport-status-segment dim small">
          gizmo: {edits.mode}
        </span>
      </div>
    </div>
  );
}
