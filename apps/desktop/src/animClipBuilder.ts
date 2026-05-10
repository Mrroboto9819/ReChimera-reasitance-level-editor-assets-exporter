import * as THREE from "three";
import type { DecodedClipDto } from "./api";

export function buildAnimationClip(
  dto: DecodedClipDto,
  bonePrefix = "bone_",
): THREE.AnimationClip {
  const fps = dto.frame_rate > 0 ? dto.frame_rate : 30;
  const dt = 1 / fps;
  const tracks: THREE.KeyframeTrack[] = [];

  const animatedTimes = new Float32Array(dto.num_frames);
  for (let i = 0; i < dto.num_frames; i++) {
    animatedTimes[i] = i * dt;
  }
  const staticTimes = new Float32Array([0]);

  for (let b = 0; b < dto.bones.length; b++) {
    const bone = dto.bones[b]!;
    const targetName = `${bonePrefix}${b}`;

    if (bone.rotations.length >= 4) {
      const times = bone.rotation_animated ? animatedTimes : staticTimes;
      const values = new Float32Array(bone.rotations);
      tracks.push(
        new THREE.QuaternionKeyframeTrack(`${targetName}.quaternion`, Array.from(times), Array.from(values)),
      );
    }
    if (bone.translations.length >= 3) {
      const times = bone.translation_animated ? animatedTimes : staticTimes;
      const values = new Float32Array(bone.translations);
      tracks.push(
        new THREE.VectorKeyframeTrack(`${targetName}.position`, Array.from(times), Array.from(values)),
      );
    }
    if (bone.scales.length >= 3) {
      const times = bone.scale_animated ? animatedTimes : staticTimes;
      const values = new Float32Array(bone.scales);
      tracks.push(
        new THREE.VectorKeyframeTrack(`${targetName}.scale`, Array.from(times), Array.from(values)),
      );
    }
  }

  const duration = dto.num_frames > 1 ? (dto.num_frames - 1) * dt : 0;
  return new THREE.AnimationClip(dto.name || "clip", duration, tracks);
}
