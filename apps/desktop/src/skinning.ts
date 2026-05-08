import * as THREE from "three";
import {
  decodeMeshGeom,
  type AssetMeshes,
  type DecodedClip,
} from "./api";

/// Bind-pose interpretation strategy. None has been empirically verified
/// for R2; the modal exposes a runtime switcher so the user can pick
/// whichever produces a recognizable rig. See skeleton.rs for the data
/// shapes and the on-disk semantics in dispute.
export type BindStrategy = "it" | "direct" | "relunacy";

const tmpMatA = new THREE.Matrix4();
const tmpMatB = new THREE.Matrix4();
const tmpMatC = new THREE.Matrix4();

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
 *
 * `bindStrategy` picks how the on-disk `tms0`/`tms1` arrays map to
 * per-bone local TRS + boneInverses. Default `"it"` uses the IT-derived
 * matrices already shipped in `bind_local`/`bind_world_inverse`. The
 * other strategies recompute on the fly from `tms0_col`/`tms1_col`,
 * useful for the modal's A/B test until we lock in the empirical
 * answer for R2.
 */
export function buildSkinnedAsset(
  asset: AssetMeshes,
  bindStrategy: BindStrategy = "it",
): BuiltSkinnedAsset | null {
  const sk = asset.skeleton;
  if (!sk || sk.bone_count === 0) return null;

  // Resolve effective bind matrices given the chosen strategy. Falls
  // back to the default IT-derived `bind_local` when the cache JSON
  // doesn't carry the raw tms0/tms1 (pre-switcher caches).
  const { localBindMatrices, worldInverseMatrices } = resolveBindMatrices(
    sk,
    bindStrategy,
  );

  const bones: THREE.Bone[] = [];

  // Phase 1: allocate Bone objects + decompose the per-bone local
  // matrix into TRS so Three.js's bone-update loop can re-assemble
  // after animation.
  for (let i = 0; i < sk.bone_count; i++) {
    const bone = new THREE.Bone();
    bone.name = `bone_${i}`;
    const local = localBindMatrices[i];
    if (local && local.length === 16) {
      tmpMatA.fromArray(local);
      tmpMatA.decompose(bone.position, bone.quaternion, bone.scale);
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
  if (worldInverseMatrices.length === sk.bone_count) {
    boneInverses = worldInverseMatrices.map((m) =>
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

interface BindMatrices {
  /** Per-bone local TRS — what gets decomposed onto each `THREE.Bone`. */
  localBindMatrices: number[][];
  /** Per-bone world-inverse — handed to `THREE.Skeleton` as `boneInverses`. */
  worldInverseMatrices: number[][];
}

/// Compute the effective bind matrices for the requested strategy.
/// Falls back to whatever the Rust backend shipped as the default if
/// the raw tms0/tms1 columns aren't present (older caches).
function resolveBindMatrices(
  sk: AssetMeshes["skeleton"] & {},
  strategy: BindStrategy,
): BindMatrices {
  if (strategy === "it" || !sk.tms0_col || !sk.tms1_col) {
    return {
      localBindMatrices: sk.bind_local,
      worldInverseMatrices: sk.bind_world_inverse,
    };
  }

  if (strategy === "direct") {
    // tms0 IS the local bind directly (no parent-relative reconstruction).
    return {
      localBindMatrices: sk.tms0_col,
      worldInverseMatrices: sk.tms1_col,
    };
  }

  // strategy === "relunacy" — tms1 is local, tms0 is world inverse.
  return {
    localBindMatrices: sk.tms1_col,
    worldInverseMatrices: sk.tms0_col,
  };
}

/// Re-compute bind matrices for an asset under a new strategy without
/// rebuilding the entire SkinnedMesh. Updates each existing bone's
/// position/quaternion/scale + replaces the skeleton's `boneInverses`.
/// Lets the modal flip strategies on a live rig in O(numBones) work.
export function applyBindStrategy(
  rig: BuiltSkinnedAsset,
  asset: AssetMeshes,
  strategy: BindStrategy,
): void {
  const sk = asset.skeleton;
  if (!sk) return;
  const { localBindMatrices, worldInverseMatrices } = resolveBindMatrices(
    sk,
    strategy,
  );
  for (let i = 0; i < rig.bones.length; i++) {
    const local = localBindMatrices[i];
    if (!local || local.length !== 16) continue;
    tmpMatB.fromArray(local);
    tmpMatB.decompose(
      rig.bones[i]!.position,
      rig.bones[i]!.quaternion,
      rig.bones[i]!.scale,
    );
  }
  if (worldInverseMatrices.length === rig.bones.length) {
    for (let i = 0; i < rig.bones.length; i++) {
      tmpMatC.fromArray(worldInverseMatrices[i]!);
      rig.skeleton.boneInverses[i]!.copy(tmpMatC);
    }
  }
  // Force the skeleton to recompute the bone-matrix texture on next
  // render; without this Three.js keeps using the cached uniforms.
  rig.skeleton.update();
}
