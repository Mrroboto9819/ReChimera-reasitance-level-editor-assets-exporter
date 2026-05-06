import * as THREE from "three";
import {
  decodeMeshGeom,
  type AssetMeshes,
  type DecodedClip,
} from "./api";

/**
 * Three.js side rig for one moby asset — bones, skeleton, per-submesh
 * SkinnedMeshes (or plain Meshes for unskinned sub-pieces). Returned by
 * `buildSkinnedAsset`. Used by both:
 *
 *  - Viewport's `SkinnedSelectionOverlay` (live playback)
 *  - export.ts (bake into GLB with optional AnimationClip array)
 */
export interface BuiltSkinnedAsset {
  /** Top-level Object3D containing the bone tree + every SkinnedMesh /
   *  Mesh. Position/quaternion/scale are NOT set — the caller places it
   *  at the world transform. */
  root: THREE.Group;
  materials: THREE.Material[];
  /** Shared skeleton — animation tracks target bones (descendants of
   *  `root`), and every SkinnedMesh in `skinnedMeshes` binds to it. */
  skeleton: THREE.Skeleton;
  bones: THREE.Bone[];
  skinnedMeshes: THREE.SkinnedMesh[];
  /** Free GPU resources (geometries, materials, skeleton bone-texture). */
  dispose: () => void;
}

/**
 * Construct the THREE-side rig for a moby. See module doc for callers.
 * Returns `null` when the asset has no skeleton — caller should fall back
 * to a non-skinned path.
 */
export function buildSkinnedAsset(asset: AssetMeshes): BuiltSkinnedAsset | null {
  const sk = asset.skeleton;
  if (!sk || sk.bone_count === 0) return null;

  const bones: THREE.Bone[] = [];
  const tmpMat = new THREE.Matrix4();

  // Phase 1: allocate Bone objects + decompose bind_local into TRS so
  // Three.js's bone-update loop can re-assemble after animation.
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

  // Phase 2: parent bones via `parents[i]`. Roots go directly under the
  // asset root group.
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
  // backend couldn't read tms1 we let THREE compute them at bind() time.
  let boneInverses: THREE.Matrix4[] | undefined;
  if (sk.bind_world_inverse.length === sk.bone_count) {
    boneInverses = sk.bind_world_inverse.map((m) =>
      new THREE.Matrix4().fromArray(m),
    );
  }
  const skeleton = new THREE.Skeleton(bones, boneInverses);

  // Phase 4: per-submesh SkinnedMesh (or Mesh fallback).
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  for (const s of asset.submeshes) {
    const decoded = decodeMeshGeom(s);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
    if (decoded.uvs.length > 0) {
      geom.setAttribute("uv", new THREE.BufferAttribute(decoded.uvs, 2));
    }
    geom.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      // Material name encodes texture slot ids so the export pipeline
      // can attach albedo/normal/emissive after building.
      name: `slots_a${s.albedo_id ?? "_"}_n${s.normal_id ?? "_"}_e${s.emissive_id ?? "_"}`,
      emissive: s.emissive_id != null ? 0xffffff : 0x000000,
      emissiveIntensity: s.emissive_id != null ? 0.7 : 0,
    });
    materials.push(mat);
    geometries.push(geom);

    if (
      decoded.bone_indices.length > 0 &&
      decoded.bone_weights.length === decoded.bone_indices.length
    ) {
      const skinIdx = decoded.bone_indices;
      const skinW = new Float32Array(decoded.bone_weights.length);
      for (let i = 0; i < decoded.bone_weights.length; i++) {
        skinW[i] = decoded.bone_weights[i]! / 255;
      }
      geom.setAttribute("skinIndex", new THREE.BufferAttribute(skinIdx, 4));
      geom.setAttribute("skinWeight", new THREE.BufferAttribute(skinW, 4));

      const skinnedMesh = new THREE.SkinnedMesh(geom, mat);
      skinnedMesh.bind(skeleton);
      root.add(skinnedMesh);
      skinnedMeshes.push(skinnedMesh);
    } else {
      const mesh = new THREE.Mesh(geom, mat);
      root.add(mesh);
    }
  }

  return {
    root,
    materials,
    skeleton,
    bones,
    skinnedMeshes,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      skeleton.dispose();
    },
  };
}

/**
 * Build a `THREE.AnimationClip` from a `DecodedClip` returned by
 * `fetch_animset_clip`. Track names target `bone_${i}`, matching
 * `buildSkinnedAsset`'s naming.
 *
 * Animated bones get one keyframe per source frame at `i / fps`; static
 * bones get a single keyframe at t=0. Tracks beyond the rig's bone count
 * (e.g. viseme clips driving extended rigs) are dropped.
 */
export function buildAnimationClipFromDecoded(
  decoded: DecodedClip,
  numBonesInRig: number,
): THREE.AnimationClip {
  const fps = decoded.frame_rate > 0 ? decoded.frame_rate : 30;
  const dt = 1 / fps;
  const tracks: THREE.KeyframeTrack[] = [];

  const animatedTimes: number[] = [];
  for (let i = 0; i < decoded.num_frames; i++) animatedTimes.push(i * dt);
  const staticTimes: number[] = [0];

  const bonesToUse = Math.min(decoded.bones.length, numBonesInRig);
  for (let b = 0; b < bonesToUse; b++) {
    const bone = decoded.bones[b];
    if (!bone) continue;
    if (bone.rotations.length > 0) {
      const t = bone.rotation_animated ? animatedTimes : staticTimes;
      tracks.push(
        new THREE.QuaternionKeyframeTrack(`bone_${b}.quaternion`, t, bone.rotations),
      );
    }
    if (bone.translations.length > 0) {
      const t = bone.translation_animated ? animatedTimes : staticTimes;
      tracks.push(
        new THREE.VectorKeyframeTrack(`bone_${b}.position`, t, bone.translations),
      );
    }
    if (bone.scales.length > 0) {
      const t = bone.scale_animated ? animatedTimes : staticTimes;
      tracks.push(
        new THREE.VectorKeyframeTrack(`bone_${b}.scale`, t, bone.scales),
      );
    }
  }

  const duration = decoded.num_frames > 0 ? (decoded.num_frames - 1) * dt : 0;
  return new THREE.AnimationClip(decoded.name || "clip", duration, tracks);
}

/** True when the asset has a skeleton + at least one skinned submesh.
 *  Used to decide whether to use the SkinnedMesh export path. */
export function isSkinnedAsset(asset: AssetMeshes): boolean {
  if (!asset.skeleton || asset.skeleton.bone_count === 0) return false;
  return asset.submeshes.some((s) => s.bone_indices_b64.length > 0);
}
