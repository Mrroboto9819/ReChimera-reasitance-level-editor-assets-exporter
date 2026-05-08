

use std::io::{Read, Seek};

use crate::error::Result;
use crate::igfile::IgFile;

pub const SECT_ANIMATION: u32 = 0xF000;

const fn pad_to(value: u32, align: u32) -> u32 {
    (value + align - 1) & !(align - 1)
}

#[derive(Debug, Clone, Copy)]
pub enum TrackKind {
    Rotation,
    Scale,
    Position,

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

#[derive(Debug, Clone, Copy)]
pub struct TrackMask {
    pub bone_index: u16,
    pub component: u8,
    pub kind: TrackKind,
}

impl TrackMask {
    fn unpack(raw: u16) -> Self {
        TrackMask {

            bone_index: (raw >> 6) & 0x3FF,

            component: ((raw >> 2) & 0b11) as u8,

            kind: TrackKind::from_bits(raw >> 4),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AnimationHeader {
    pub anim_index: u16,
    pub flags: u16,
    pub num_bones: u16,
    pub num_frames: u16,

    pub name: String,
    pub frame_rate: f32,
    pub linear_speed: f32,
    pub frame_stride: u16,
    pub num_reference_values: u16,
    pub num_16bit_tracks: u16,
    pub num_8bit_tracks: u16,

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

pub fn read_animation_header<R: Read + Seek>(
    ig: &mut IgFile<R>,
) -> Result<Option<AnimationHeader>> {
    let Some(section) = ig.section(SECT_ANIMATION) else {
        return Ok(None);
    };
    read_animation_header_at(ig, u64::from(section.offset)).map(Some)
}

pub fn animation_section_offsets<R: Read + Seek>(ig: &IgFile<R>) -> Vec<u64> {
    ig.sections
        .iter()
        .filter(|s| s.id == SECT_ANIMATION)
        .map(|s| u64::from(s.offset))
        .collect()
}

pub fn read_animation_header_at<R: Read + Seek>(
    ig: &mut IgFile<R>,
    off: u64,
) -> Result<AnimationHeader> {
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

    Ok(AnimationHeader {
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
    })
}

#[derive(Debug, Clone)]
pub struct AnimationControl {

    pub ref_pose_rotations: Vec<[i16; 4]>,

    pub ref_pose_values: Vec<i16>,
    pub ref_pose_masks: Vec<TrackMask>,
    pub track16_masks: Vec<TrackMask>,
    pub track8_masks: Vec<TrackMask>,
    pub track8_base_values: Vec<i16>,

    pub blend_masks: Vec<u8>,
}

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

    ig.stream.seek_to(base + off_rotations as u64)?;
    let mut ref_pose_rotations = Vec::with_capacity(nb as usize);
    for _ in 0..nb {
        let x = ig.stream.read_i16()?;
        let y = ig.stream.read_i16()?;
        let z = ig.stream.read_i16()?;
        let w = ig.stream.read_i16()?;
        ref_pose_rotations.push([x, y, z, w]);
    }

    ig.stream.seek_to(base + off_values as u64)?;
    let mut ref_pose_values = Vec::with_capacity(nrv as usize);
    for _ in 0..nrv {
        ref_pose_values.push(ig.stream.read_i16()?);
    }

    ig.stream.seek_to(base + off_value_masks as u64)?;
    let mut ref_pose_masks = Vec::with_capacity(nrv as usize);
    for _ in 0..nrv {
        let raw = ig.stream.read_u16()?;
        ref_pose_masks.push(TrackMask::unpack(raw));
    }

    ig.stream.seek_to(base + off_t16_masks as u64)?;
    let mut track16_masks = Vec::with_capacity(n16 as usize);
    for _ in 0..n16 {
        let raw = ig.stream.read_u16()?;
        track16_masks.push(TrackMask::unpack(raw));
    }

    ig.stream.seek_to(base + off_t8_masks as u64)?;
    let mut track8_masks = Vec::with_capacity(n8 as usize);
    for _ in 0..n8 {
        let raw = ig.stream.read_u16()?;
        track8_masks.push(TrackMask::unpack(raw));
    }

    ig.stream.seek_to(base + off_t8_base as u64)?;
    let mut track8_base_values = Vec::with_capacity(n8 as usize);
    for _ in 0..n8 {
        track8_base_values.push(ig.stream.read_i16()?);
    }

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

pub fn read_animation_frame<R: Read + Seek>(
    ig: &mut IgFile<R>,
    h: &AnimationHeader,
    frame_index: u16,
) -> Result<(Vec<i16>, Vec<i8>)> {
    if h.frames_ptr == 0 || h.frame_stride == 0 {
        return Ok((Vec::new(), Vec::new()));
    }
    let frame_off = u64::from(h.frames_ptr) + (frame_index as u64) * (h.frame_stride as u64);

    ig.stream.seek_to(frame_off)?;
    let mut values16 = Vec::with_capacity(h.num_16bit_tracks as usize);
    for _ in 0..h.num_16bit_tracks {
        values16.push(ig.stream.read_i16()?);
    }

    let n16 = h.num_16bit_tracks as u32;
    let off8 = pad_to(n16 * 2, 16) as u64;
    ig.stream.seek_to(frame_off + off8)?;
    let mut values8 = Vec::with_capacity(h.num_8bit_tracks as usize);
    for _ in 0..h.num_8bit_tracks {
        values8.push(ig.stream.read_i8()?);
    }

    Ok((values16, values8))
}

#[derive(Debug, Clone)]
pub struct DecodedClip {
    pub name: String,
    pub num_frames: u16,
    pub frame_rate: f32,
    pub looping: bool,

    pub bones: Vec<DecodedBone>,
}

#[derive(Debug, Clone)]
pub struct DecodedBone {

    pub rotations: Vec<f32>,

    pub translations: Vec<f32>,

    pub scales: Vec<f32>,

    pub rotation_animated: bool,
    pub translation_animated: bool,
    pub scale_animated: bool,
}

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

        q = [0.0, 0.0, 0.0, 1.0];
    }
    q
}

pub fn decode_animation<R: Read + Seek>(
    ig: &mut IgFile<R>,
    h: &AnimationHeader,
    ctrl: &AnimationControl,
    position_scale: f32,
    scale_scale: f32,
) -> Result<DecodedClip> {
    let nb = h.num_bones as usize;
    let nf = h.num_frames as usize;

    let mut rot_values: Vec<[i16; 4]> = vec![[0; 4]; nb * nf];
    let mut rot_animated: Vec<bool> = vec![false; nb];

    for b in 0..nb {
        let r = ctrl.ref_pose_rotations.get(b).copied().unwrap_or([0, 0, 0, 32767]);
        for f in 0..nf {
            rot_values[b * nf + f] = r;
        }
    }

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

            TrackKind::Rotation | TrackKind::Unknown => {}
        }
    }

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

    let mut bones = Vec::with_capacity(nb);
    for b in 0..nb {

        let rotations = if rot_animated[b] {
            let mut out = Vec::with_capacity(nf * 4);
            for f in 0..nf {
                let q = dequantize_quaternion(rot_values[b * nf + f]);
                out.extend_from_slice(&q);
            }
            out
        } else {

            let q = dequantize_quaternion(
                ctrl.ref_pose_rotations.get(b).copied().unwrap_or([0, 0, 0, 32767]),
            );
            q.to_vec()
        };

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

