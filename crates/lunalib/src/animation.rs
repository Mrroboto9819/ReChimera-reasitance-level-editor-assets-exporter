//! Animation parser — decodes per-clip skeletal animation tracks from
//! `animsets.dat`.
//!
//! ## Format
//!
//! Each animset is its own IGHW chunk inside `animsets.dat`, sliced via
//! `assetlookup.dat`'s `0x1D700` table (see [`crate::assetlookup::AssetKind::Animset`]).
//!
//! Inside an animset, every `Animation` clip is a section with
//! ID `0xF000`. Layout per InsomniaToolset's
//! [animation.hpp](../../../../InsomniaToolset/common/include/insomnia/classes/animation.hpp):
//!
//! - `Animation` header (0x40 bytes):
//!   - `0x00` u16  animIndex
//!   - `0x02` u16  flags          (bit 0=Looping, 1=Additive, 2=PackedFrames)
//!   - `0x04` u16  numBones
//!   - `0x06` u16  numFrames
//!   - `0x08` u32  namePtr        — pointer to NUL-terminated clip name
//!   - `0x0C` u32  loadedTag
//!   - `0x10` f32  unk4
//!   - `0x14` f32  linearSpeed
//!   - `0x18` f32  frameRate      — frames per second
//!   - `0x1C` u32  rootMotionPtr
//!   - `0x20` u32  controlPtr     — header for ref pose + track masks
//!   - `0x24` u32  framesPtr      — packed per-frame quantized track data
//!   - `0x28-0x2F` u32 null0[2]
//!   - `0x30` u16  refPoseBufferSize
//!   - `0x32` u16  frameStride    — bytes per frame in the `frames` buffer
//!   - `0x34` u16  numReferenceValues
//!   - `0x36` u16  num16BitTracks
//!   - `0x38` u16  num8BitTracks
//!   - `0x3A` u16  unk10
//!   - `0x3C` u32  null1
//!
//! ### `control` buffer layout (16-byte alignment between sections)
//!
//! ```text
//!   offset 0                                 SVector4[numBones]   // ref pose rotations (i16 quantized quaternion)
//!   ↑ + numBones*8 + pad16                   int16[numReferenceValues]   // ref pose values
//!   ↑ + numReferenceValues*2 + pad16         TrackMask[numReferenceValues]
//!   ↑ + numReferenceValues*2 + pad16         TrackMask[num16BitTracks]
//!   ↑ + num16BitTracks*2 + pad16             TrackMask[num8BitTracks]
//!   ↑ + num8BitTracks*2 + pad16              int16[num8BitTracks]   // 8-bit track base values
//!   ↑ + num8BitTracks*2 + pad16              uint8[numBones]   // blend masks
//! ```
//!
//! ### `frames` buffer layout (per frame, frame_index * frameStride):
//!
//! ```text
//!   offset 0                                 int16[num16BitTracks]
//!   ↑ + num16BitTracks*2 + pad16             int8[num8BitTracks]
//! ```
//!
//! ### `TrackMask` (u16 packed bitfield)
//!
//! - bits 0-1   `unk`        (2 bits, ignored)
//! - bits 2-3   `component`  (2 bits) — which xyzw component this track drives
//! - bits 4-5   `type`       (2 bits) — 0=Rotation, 1=Scale, 2=Position
//! - bits 6-15  `boneIndex`  (10 bits) — which bone the track applies to

use std::io::{Read, Seek};

use crate::error::Result;
use crate::igfile::IgFile;

/// Section ID inside an animset's IGHW chunk holding `Animation` clips.
pub const SECT_ANIMATION: u32 = 0xF000;

/// Round `value` up to the next multiple of `align`. Animation buffers
/// pad 16-byte-aligned between subsections per IT's helper offsets.
const fn pad_to(value: u32, align: u32) -> u32 {
    (value + align - 1) & !(align - 1)
}

#[derive(Debug, Clone, Copy)]
pub enum TrackKind {
    Rotation,
    Scale,
    Position,
    /// 0b11 — undocumented. Treat as opaque; passes through to the dump.
    Unknown,
}

impl TrackKind {
    fn from_bits(bits: u16) -> Self {
        match bits & 0b11 {
            0 => Self::Rotation,
            1 => Self::Scale,
            2 => Self::Position,
            _ => Self::Unknown,
        }
    }
}

/// Decoded `TrackMask` — 2 bits unk, 2 bits component, 2 bits type, 10
/// bits bone index. We drop the `unk` field since it's never referenced.
#[derive(Debug, Clone, Copy)]
pub struct TrackMask {
    pub bone_index: u16,
    pub component: u8,
    pub kind: TrackKind,
}

impl TrackMask {
    fn unpack(raw: u16) -> Self {
        TrackMask {
            // bits 6..15 (10 bits)
            bone_index: (raw >> 6) & 0x3FF,
            // bits 2..3
            component: ((raw >> 2) & 0b11) as u8,
            // bits 4..5
            kind: TrackKind::from_bits(raw >> 4),
        }
    }
}

/// One clip header. Track decompression is done lazily via separate
/// helpers — we surface enough metadata for callers (the dump CLI, the
/// frontend) to decide which clips to actually decode.
#[derive(Debug, Clone)]
pub struct AnimationHeader {
    pub anim_index: u16,
    pub flags: u16,
    pub num_bones: u16,
    pub num_frames: u16,
    /// Optional name from `namePtr`. Empty when the pointer was null.
    pub name: String,
    pub frame_rate: f32,
    pub linear_speed: f32,
    pub frame_stride: u16,
    pub num_reference_values: u16,
    pub num_16bit_tracks: u16,
    pub num_8bit_tracks: u16,
    /// Raw control / frames pointers. Kept around so callers can decode
    /// tracks without having to re-parse the header.
    pub control_ptr: u32,
    pub frames_ptr: u32,
}

impl AnimationHeader {
    pub const fn duration_seconds(&self) -> f32 {
        if self.frame_rate <= 0.0 {
            0.0
        } else {
            (self.num_frames as f32) / self.frame_rate
        }
    }

    pub const fn is_looping(&self) -> bool {
        self.flags & 0x01 != 0
    }
    pub const fn is_additive(&self) -> bool {
        self.flags & 0x02 != 0
    }
    pub const fn is_packed_frames(&self) -> bool {
        self.flags & 0x04 != 0
    }
}

/// Parse an `Animation` header from the chunk's section `0xF000`. Returns
/// `Ok(None)` when the section is absent (some animsets contain only
/// metadata, no clips).
pub fn read_animation_header<R: Read + Seek>(
    ig: &mut IgFile<R>,
) -> Result<Option<AnimationHeader>> {
    let Some(section) = ig.section(SECT_ANIMATION) else {
        return Ok(None);
    };
    let off = u64::from(section.offset);
    ig.stream.seek_to(off + 0x00)?;
    let anim_index = ig.stream.read_u16()?;
    let flags = ig.stream.read_u16()?;
    let num_bones = ig.stream.read_u16()?;
    let num_frames = ig.stream.read_u16()?;
    let name_ptr = u64::from(ig.stream.read_u32()?);
    let _loaded_tag = ig.stream.read_u32()?;
    let _unk4 = ig.stream.read_f32()?;
    let linear_speed = ig.stream.read_f32()?;
    let frame_rate = ig.stream.read_f32()?;
    let _root_motion_ptr = ig.stream.read_u32()?;
    let control_ptr = ig.stream.read_u32()?;
    let frames_ptr = ig.stream.read_u32()?;

    ig.stream.seek_to(off + 0x32)?;
    let frame_stride = ig.stream.read_u16()?;
    let num_reference_values = ig.stream.read_u16()?;
    let num_16bit_tracks = ig.stream.read_u16()?;
    let num_8bit_tracks = ig.stream.read_u16()?;

    let name = if name_ptr != 0 {
        ig.stream.read_cstring_at(name_ptr).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(Some(AnimationHeader {
        anim_index,
        flags,
        num_bones,
        num_frames,
        name,
        frame_rate,
        linear_speed,
        frame_stride,
        num_reference_values,
        num_16bit_tracks,
        num_8bit_tracks,
        control_ptr,
        frames_ptr,
    }))
}

/// All the static (non-per-frame) data extracted from the `control` buffer.
/// Kept as a separate struct so callers can choose to read just the header
/// (cheap) or the full control block (when actually decoding the clip).
#[derive(Debug, Clone)]
pub struct AnimationControl {
    /// Reference-pose rotations as quantized quaternions — one per bone.
    /// Each entry is `[i16; 4]` in (x, y, z, w) order. To convert to a
    /// unit quaternion: divide by `i16::MAX as f32` and re-normalize.
    pub ref_pose_rotations: Vec<[i16; 4]>,
    /// Reference-pose scalar values, indexed by `ref_pose_masks`.
    pub ref_pose_values: Vec<i16>,
    pub ref_pose_masks: Vec<TrackMask>,
    pub track16_masks: Vec<TrackMask>,
    pub track8_masks: Vec<TrackMask>,
    pub track8_base_values: Vec<i16>,
    /// Per-bone blend mask byte. One entry per bone in the rig.
    pub blend_masks: Vec<u8>,
}

/// Read the `control` buffer for a parsed animation header.
pub fn read_animation_control<R: Read + Seek>(
    ig: &mut IgFile<R>,
    h: &AnimationHeader,
) -> Result<AnimationControl> {
    if h.control_ptr == 0 {
        return Ok(AnimationControl {
            ref_pose_rotations: Vec::new(),
            ref_pose_values: Vec::new(),
            ref_pose_masks: Vec::new(),
            track16_masks: Vec::new(),
            track8_masks: Vec::new(),
            track8_base_values: Vec::new(),
            blend_masks: Vec::new(),
        });
    }

    let base = u64::from(h.control_ptr);

    // Sub-section offsets inside `control`. Mirrors the helper functions
    // in IT's animation.hpp — every block is followed by 16-byte padding.
    let nb = h.num_bones as u32;
    let nrv = h.num_reference_values as u32;
    let n16 = h.num_16bit_tracks as u32;
    let n8 = h.num_8bit_tracks as u32;

    let off_rotations = 0u32;
    let off_values = pad_to(off_rotations + nb * 8, 16);
    let off_value_masks = pad_to(off_values + nrv * 2, 16);
    let off_t16_masks = pad_to(off_value_masks + nrv * 2, 16);
    let off_t8_masks = pad_to(off_t16_masks + n16 * 2, 16);
    let off_t8_base = pad_to(off_t8_masks + n8 * 2, 16);
    let off_blend = pad_to(off_t8_base + n8 * 2, 16);

    // 1. Ref-pose rotations: SVector4 (i16[4]) per bone.
    ig.stream.seek_to(base + off_rotations as u64)?;
    let mut ref_pose_rotations = Vec::with_capacity(nb as usize);
    for _ in 0..nb {
        let x = ig.stream.read_i16()?;
        let y = ig.stream.read_i16()?;
        let z = ig.stream.read_i16()?;
        let w = ig.stream.read_i16()?;
        ref_pose_rotations.push([x, y, z, w]);
    }

    // 2. Ref-pose scalar values.
    ig.stream.seek_to(base + off_values as u64)?;
    let mut ref_pose_values = Vec::with_capacity(nrv as usize);
    for _ in 0..nrv {
        ref_pose_values.push(ig.stream.read_i16()?);
    }

    // 3. Ref-pose track masks.
    ig.stream.seek_to(base + off_value_masks as u64)?;
    let mut ref_pose_masks = Vec::with_capacity(nrv as usize);
    for _ in 0..nrv {
        let raw = ig.stream.read_u16()?;
        ref_pose_masks.push(TrackMask::unpack(raw));
    }

    // 4. 16-bit track masks.
    ig.stream.seek_to(base + off_t16_masks as u64)?;
    let mut track16_masks = Vec::with_capacity(n16 as usize);
    for _ in 0..n16 {
        let raw = ig.stream.read_u16()?;
        track16_masks.push(TrackMask::unpack(raw));
    }

    // 5. 8-bit track masks.
    ig.stream.seek_to(base + off_t8_masks as u64)?;
    let mut track8_masks = Vec::with_capacity(n8 as usize);
    for _ in 0..n8 {
        let raw = ig.stream.read_u16()?;
        track8_masks.push(TrackMask::unpack(raw));
    }

    // 6. 8-bit track base values.
    ig.stream.seek_to(base + off_t8_base as u64)?;
    let mut track8_base_values = Vec::with_capacity(n8 as usize);
    for _ in 0..n8 {
        track8_base_values.push(ig.stream.read_i16()?);
    }

    // 7. Blend masks (one byte per bone).
    ig.stream.seek_to(base + off_blend as u64)?;
    let blend_masks = ig.stream.read_bytes(nb as usize)?;

    Ok(AnimationControl {
        ref_pose_rotations,
        ref_pose_values,
        ref_pose_masks,
        track16_masks,
        track8_masks,
        track8_base_values,
        blend_masks,
    })
}

/// Read raw per-frame track values for a single frame index.
///
/// Returns `(values16, values8)` as raw quantized integers — the caller
/// is responsible for combining them with `AnimationControl` (ref-pose +
/// masks + 8-bit base values) to produce the final per-bone TRS. Most
/// callers want [`decode_animation`] instead, which does this combining
/// for every bone across every frame.
pub fn read_animation_frame<R: Read + Seek>(
    ig: &mut IgFile<R>,
    h: &AnimationHeader,
    frame_index: u16,
) -> Result<(Vec<i16>, Vec<i8>)> {
    if h.frames_ptr == 0 || h.frame_stride == 0 {
        return Ok((Vec::new(), Vec::new()));
    }
    let frame_off = u64::from(h.frames_ptr) + (frame_index as u64) * (h.frame_stride as u64);

    // 16-bit track values come first.
    ig.stream.seek_to(frame_off)?;
    let mut values16 = Vec::with_capacity(h.num_16bit_tracks as usize);
    for _ in 0..h.num_16bit_tracks {
        values16.push(ig.stream.read_i16()?);
    }

    // 8-bit track values follow at +num16BitTracks*2 padded to 16.
    let n16 = h.num_16bit_tracks as u32;
    let off8 = pad_to(n16 * 2, 16) as u64;
    ig.stream.seek_to(frame_off + off8)?;
    let mut values8 = Vec::with_capacity(h.num_8bit_tracks as usize);
    for _ in 0..h.num_8bit_tracks {
        values8.push(ig.stream.read_i8()?);
    }

    Ok((values16, values8))
}

/// Fully-decoded clip — per-bone TRS keyframes, ready to feed to
/// `THREE.QuaternionKeyframeTrack` / `VectorKeyframeTrack`.
#[derive(Debug, Clone)]
pub struct DecodedClip {
    pub name: String,
    pub num_frames: u16,
    pub frame_rate: f32,
    pub looping: bool,
    /// Per-bone tracks. Length == animation header `num_bones`.
    pub bones: Vec<DecodedBone>,
}

/// One bone's animated TRS — three keyframe arrays. Each is either:
/// - `frames * stride` floats (animated bone), OR
/// - `stride` floats (constant bone — emitted as a single keyframe so
///   the consumer can flatten with `tile()`-style replication if it
///   wants per-frame storage).
#[derive(Debug, Clone)]
pub struct DecodedBone {
    /// Quaternion keyframes — flat `[x,y,z,w, x,y,z,w, ...]`.
    /// `keyframe_count == rotations.len() / 4`. For un-animated bones
    /// this contains a single keyframe (the ref-pose rotation).
    pub rotations: Vec<f32>,
    /// Translation keyframes — flat `[x,y,z, x,y,z, ...]`. Empty when
    /// the bone has no position track AND no static position override
    /// (the caller should fall back to the bind-pose translation in
    /// that case).
    pub translations: Vec<f32>,
    /// Scale keyframes — flat `[x,y,z, x,y,z, ...]`. Empty when the
    /// bone has no scale track AND no static scale override (caller
    /// uses `[1,1,1]`).
    pub scales: Vec<f32>,
    /// True when this bone has at least one per-frame track. False
    /// when only a static value was emitted (single keyframe).
    pub rotation_animated: bool,
    pub translation_animated: bool,
    pub scale_animated: bool,
}

/// Quantized i16 quaternion → normalized f32 quaternion. Insomniac
/// stores each component as `i16 / 0x7FFF`, then re-normalizes (the
/// quantization can push the magnitude slightly off unit length).
fn dequantize_quaternion(qi: [i16; 4]) -> [f32; 4] {
    const INV: f32 = 1.0 / 32767.0;
    let mut q = [
        qi[0] as f32 * INV,
        qi[1] as f32 * INV,
        qi[2] as f32 * INV,
        qi[3] as f32 * INV,
    ];
    let len_sq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if len_sq > 0.0 {
        let inv_len = 1.0 / len_sq.sqrt();
        q[0] *= inv_len;
        q[1] *= inv_len;
        q[2] *= inv_len;
        q[3] *= inv_len;
    } else {
        // Degenerate input — emit identity rather than NaN.
        q = [0.0, 0.0, 0.0, 1.0];
    }
    q
}

/// Decode a full animation clip — combines the ref-pose, the static
/// per-bone overrides, and the per-frame quantized track deltas into
/// flat keyframe arrays, one set of three (rot/pos/scale) per bone.
///
/// `position_scale` and `scale_scale` are the float multipliers applied
/// to the i16 raw values — typically `2 ^ moby.bindPoseInverseOffset`
/// and `2 ^ moby.skeleton.scaleShift` per IT's
/// [gltf_shared.cpp `LoadAnimation`](../../../../InsomniaToolset/common/src/gltf_shared.cpp).
/// Pass `1.0`/`1.0` if you want raw units without scaling (the dump
/// CLI does this for spot-checking).
///
/// Returns `Err(_)` only on I/O failure reading the frames buffer.
pub fn decode_animation<R: Read + Seek>(
    ig: &mut IgFile<R>,
    h: &AnimationHeader,
    ctrl: &AnimationControl,
    position_scale: f32,
    scale_scale: f32,
) -> Result<DecodedClip> {
    let nb = h.num_bones as usize;
    let nf = h.num_frames as usize;

    // Per-bone, per-component scratch values. We accumulate from least-
    // specific to most-specific (ref pose → static masks → 16-bit tracks
    // → 8-bit tracks) so later writes win.
    //
    // For rotations: bones[bone].rot[frame] = [x,y,z,w] as raw i16
    // (dequantized at the very end). This is cheaper than re-running
    // sqrt during track application.
    //
    // For positions/scales: per-component "set" bit + i16 value, with
    // missing components falling back to ref-pose at finalization.
    let mut rot_values: Vec<[i16; 4]> = vec![[0; 4]; nb * nf];
    let mut rot_animated: Vec<bool> = vec![false; nb];

    // Initialize rotations from RefPoseRotations — every frame for every
    // bone defaults to the ref pose. Track masks then overwrite per-
    // (bone, frame, component).
    for b in 0..nb {
        let r = ctrl.ref_pose_rotations.get(b).copied().unwrap_or([0, 0, 0, 32767]);
        for f in 0..nf {
            rot_values[b * nf + f] = r;
        }
    }

    // Position + scale storage: per-(bone, frame) i16 value + a 4-bit
    // "component set" mask. The .w bit pattern says which xyz components
    // were explicitly set — unset ones fall back to ref-pose (or 0/1).
    let mut pos_values: Vec<[i16; 3]> = vec![[0; 3]; nb * nf];
    let mut pos_set: Vec<u8> = vec![0u8; nb * nf];
    let mut pos_static_value: Vec<[i16; 3]> = vec![[0; 3]; nb];
    let mut pos_static_set: Vec<u8> = vec![0u8; nb];
    let mut pos_animated: Vec<bool> = vec![false; nb];

    let mut scl_values: Vec<[i16; 3]> = vec![[0; 3]; nb * nf];
    let mut scl_set: Vec<u8> = vec![0u8; nb * nf];
    let mut scl_static_value: Vec<[i16; 3]> = vec![[0; 3]; nb];
    let mut scl_static_set: Vec<u8> = vec![0u8; nb];
    let mut scl_animated: Vec<bool> = vec![false; nb];

    // Step 1: ref-pose static masks (per IT lines 122-132).
    // RefPoseMasks have the same length as RefPoseValues — value[i] is
    // the (component, type, bone) override at index i.
    for (i, m) in ctrl.ref_pose_masks.iter().enumerate() {
        let v = match ctrl.ref_pose_values.get(i) {
            Some(&v) => v,
            None => continue,
        };
        let b = m.bone_index as usize;
        if b >= nb {
            continue;
        }
        let c = m.component as usize;
        if c >= 3 {
            continue;
        }
        match m.kind {
            TrackKind::Position => {
                pos_static_value[b][c] = v;
                pos_static_set[b] |= 1 << c;
            }
            TrackKind::Scale => {
                scl_static_value[b][c] = v;
                scl_static_set[b] |= 1 << c;
            }
            // Rotations don't use ref-pose-masks — they're stored
            // directly in RefPoseRotations as full quaternions.
            TrackKind::Rotation | TrackKind::Unknown => {}
        }
    }

    // Step 2: seed per-frame position/scale arrays from static values
    // for every bone that has a 16-bit OR 8-bit track on that channel
    // (matches IT lines 134-177). Bones without any track stay at their
    // static value (single keyframe).
    let mark_pos_seed = |b: usize, set: &mut [u8]| {
        if pos_static_set[b] != 0 {
            for f in 0..nf {
                set[b * nf + f] = pos_static_set[b];
            }
        }
    };
    let mark_scl_seed = |b: usize, set: &mut [u8]| {
        if scl_static_set[b] != 0 {
            for f in 0..nf {
                set[b * nf + f] = scl_static_set[b];
            }
        }
    };

    let mut seed_for_bone_kind = |b: usize, kind: TrackKind| {
        if b >= nb {
            return;
        }
        match kind {
            TrackKind::Rotation => {
                rot_animated[b] = true;
            }
            TrackKind::Position => {
                if !pos_animated[b] {
                    // Seed per-frame from static (or zero). Copy static
                    // value into every frame slot so a track that only
                    // animates one component keeps the others stable.
                    if pos_static_set[b] != 0 {
                        let v = pos_static_value[b];
                        for f in 0..nf {
                            pos_values[b * nf + f] = v;
                        }
                        mark_pos_seed(b, &mut pos_set);
                    }
                    pos_animated[b] = true;
                }
            }
            TrackKind::Scale => {
                if !scl_animated[b] {
                    if scl_static_set[b] != 0 {
                        let v = scl_static_value[b];
                        for f in 0..nf {
                            scl_values[b * nf + f] = v;
                        }
                        mark_scl_seed(b, &mut scl_set);
                    }
                    scl_animated[b] = true;
                }
            }
            TrackKind::Unknown => {}
        }
    };

    for m in &ctrl.track16_masks {
        seed_for_bone_kind(m.bone_index as usize, m.kind);
    }
    for m in &ctrl.track8_masks {
        seed_for_bone_kind(m.bone_index as usize, m.kind);
    }

    // Step 3: read every frame, apply 16-bit and 8-bit track values.
    for f in 0..nf {
        let (v16, v8) = read_animation_frame(ig, h, f as u16)?;

        for (i, m) in ctrl.track16_masks.iter().enumerate() {
            let v = match v16.get(i) {
                Some(&v) => v,
                None => continue,
            };
            let b = m.bone_index as usize;
            if b >= nb {
                continue;
            }
            let c = m.component as usize;
            match m.kind {
                TrackKind::Rotation => {
                    if c < 4 {
                        rot_values[b * nf + f][c] = v;
                    }
                }
                TrackKind::Position => {
                    if c < 3 {
                        pos_values[b * nf + f][c] = v;
                        pos_set[b * nf + f] |= 1 << c;
                    }
                }
                TrackKind::Scale => {
                    if c < 3 {
                        scl_values[b * nf + f][c] = v;
                        scl_set[b * nf + f] |= 1 << c;
                    }
                }
                TrackKind::Unknown => {}
            }
        }

        for (i, m) in ctrl.track8_masks.iter().enumerate() {
            let delta = match v8.get(i) {
                Some(&v) => v as i32,
                None => continue,
            };
            let base = ctrl
                .track8_base_values
                .get(i)
                .copied()
                .unwrap_or(0) as i32;
            // Saturate to i16 range — base+delta should already fit but
            // a malformed clip could overflow.
            let value = (base + delta).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
            let b = m.bone_index as usize;
            if b >= nb {
                continue;
            }
            let c = m.component as usize;
            match m.kind {
                TrackKind::Rotation => {
                    if c < 4 {
                        rot_values[b * nf + f][c] = value;
                    }
                }
                TrackKind::Position => {
                    if c < 3 {
                        pos_values[b * nf + f][c] = value;
                        pos_set[b * nf + f] |= 1 << c;
                    }
                }
                TrackKind::Scale => {
                    if c < 3 {
                        scl_values[b * nf + f][c] = value;
                        scl_set[b * nf + f] |= 1 << c;
                    }
                }
                TrackKind::Unknown => {}
            }
        }
    }

    // Step 4: convert raw scratch into final keyframe arrays per bone.
    let mut bones = Vec::with_capacity(nb);
    for b in 0..nb {
        // Rotations: emit per-frame when animated, else single keyframe.
        let rotations = if rot_animated[b] {
            let mut out = Vec::with_capacity(nf * 4);
            for f in 0..nf {
                let q = dequantize_quaternion(rot_values[b * nf + f]);
                out.extend_from_slice(&q);
            }
            out
        } else {
            // Static — single keyframe at ref pose.
            let q = dequantize_quaternion(
                ctrl.ref_pose_rotations.get(b).copied().unwrap_or([0, 0, 0, 32767]),
            );
            q.to_vec()
        };

        // Translations / scales: only emit when there's at least a
        // static OR animated value. Bones with neither get an empty
        // array and the consumer falls back to the bind pose.
        let translations = if pos_animated[b] {
            let mut out = Vec::with_capacity(nf * 3);
            for f in 0..nf {
                let raw = pos_values[b * nf + f];
                out.push(raw[0] as f32 * position_scale);
                out.push(raw[1] as f32 * position_scale);
                out.push(raw[2] as f32 * position_scale);
            }
            out
        } else if pos_static_set[b] != 0 {
            let raw = pos_static_value[b];
            vec![
                raw[0] as f32 * position_scale,
                raw[1] as f32 * position_scale,
                raw[2] as f32 * position_scale,
            ]
        } else {
            Vec::new()
        };

        let scales = if scl_animated[b] {
            let mut out = Vec::with_capacity(nf * 3);
            for f in 0..nf {
                let raw = scl_values[b * nf + f];
                out.push(raw[0] as f32 * scale_scale);
                out.push(raw[1] as f32 * scale_scale);
                out.push(raw[2] as f32 * scale_scale);
            }
            out
        } else if scl_static_set[b] != 0 {
            let raw = scl_static_value[b];
            vec![
                raw[0] as f32 * scale_scale,
                raw[1] as f32 * scale_scale,
                raw[2] as f32 * scale_scale,
            ]
        } else {
            Vec::new()
        };

        bones.push(DecodedBone {
            rotations,
            translations,
            scales,
            rotation_animated: rot_animated[b],
            translation_animated: pos_animated[b],
            scale_animated: scl_animated[b],
        });
    }

    Ok(DecodedClip {
        name: h.name.clone(),
        num_frames: h.num_frames,
        frame_rate: h.frame_rate,
        looping: h.is_looping(),
        bones,
    })
}

