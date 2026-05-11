use std::io::{Read, Seek};

use crate::error::Result;
use crate::igfile::IgFile;
use crate::math::mat4_mul_row_major;

pub const SECT_MOBY_SKELETON: u32 = 0xD300;

const BONE_BYTES: u64 = 0x08;

const MAX_REASONABLE_BONES: usize = 4096;

#[derive(Debug, Clone, Copy)]
pub struct Bone {
    pub flags: u16,

    pub parent_index: i16,

    pub child: u16,

    pub sibling: u16,
}

impl Bone {
    pub fn is_root(self) -> bool {
        self.parent_index < 0
    }
    pub fn dont_inherit_scale(self) -> bool {
        self.flags & 0x01 != 0
    }

    pub fn parent(self) -> Option<usize> {
        if self.parent_index < 0 {
            None
        } else {
            Some(self.parent_index as usize)
        }
    }
}

#[derive(Debug, Clone)]
pub struct Skeleton {
    pub root_bone: u16,
    pub bones: Vec<Bone>,

    pub bind_local: Vec<[f32; 16]>,

    pub bind_world_inverse: Vec<[f32; 16]>,

    pub tms0_col: Vec<[f32; 16]>,

    pub tms1_col: Vec<[f32; 16]>,
    pub scale_shift: u16,
    pub translation_shift: u16,
}

impl Skeleton {
    pub fn bone_count(&self) -> usize {
        self.bones.len()
    }
}

/// Dump per-bone bind-pose data for a single moby. Gated by env var
/// `RECHIMERA_DEBUG_MOBY=<hex>` matching the trailing hex of the moby tuid
/// (e.g. `=00CD` matches `0x00000000000000CD`).
pub fn dump_skeleton_bind(moby_tuid: u64, skel: &Skeleton) {
    let want = match std::env::var("RECHIMERA_DEBUG_MOBY") {
        Ok(s) => s,
        Err(_) => return,
    };
    let tuid_hex = format!("{:016X}", moby_tuid);
    let any_match = want
        .split(',')
        .map(|s| s.trim().trim_start_matches("0x").trim_start_matches("0X").to_ascii_uppercase())
        .filter(|s| !s.is_empty())
        .any(|s| tuid_hex.ends_with(&s));
    if !any_match {
        return;
    }
    eprintln!(
        "[skel-dump] === moby_{:04X} ({} bones, root={}, scaleShift={}, translationShift={}) ===",
        moby_tuid & 0xFFFF,
        skel.bones.len(),
        skel.root_bone,
        skel.scale_shift,
        skel.translation_shift,
    );
    eprintln!(
        "[skel-dump]  layout: tms0_t = raw bone-to-world translation; tms1_t = raw world-to-bone (inv-bind) translation; bind_local_t = current mul-order result"
    );
    for i in 0..skel.bones.len() {
        let p = skel.bones[i].parent_index;
        let t0 = skel.tms0_col.get(i).map(|m| [m[12], m[13], m[14]]).unwrap_or([0.0; 3]);
        let t1 = skel.tms1_col.get(i).map(|m| [m[12], m[13], m[14]]).unwrap_or([0.0; 3]);
        let tb = skel.bind_local.get(i).map(|m| [m[12], m[13], m[14]]).unwrap_or([0.0; 3]);
        eprintln!(
            "[skel-dump] bone[{:3}] parent={:4} flags=0x{:04X} tms0_t=[{:>8.3},{:>8.3},{:>8.3}] tms1_t=[{:>8.3},{:>8.3},{:>8.3}] bind_local_t=[{:>8.3},{:>8.3},{:>8.3}]",
            i, p, skel.bones[i].flags,
            t0[0], t0[1], t0[2],
            t1[0], t1[1], t1[2],
            tb[0], tb[1], tb[2],
        );
    }
}

pub fn read_skeleton<R: Read + Seek>(ig: &mut IgFile<R>) -> Result<Option<Skeleton>> {
    let Some(section) = ig.section(SECT_MOBY_SKELETON) else {
        return Ok(None);
    };
    read_skeleton_at(ig, u64::from(section.offset))
}

pub fn read_skeleton_at<R: Read + Seek>(
    ig: &mut IgFile<R>,
    header_off: u64,
) -> Result<Option<Skeleton>> {
    ig.stream.seek_to(header_off + 0x00)?;
    let num_bones = ig.stream.read_u16()? as usize;
    let root_bone = ig.stream.read_u16()?;
    let bones_ptr = u64::from(ig.stream.read_u32()?);
    let tms0_ptr = u64::from(ig.stream.read_u32()?);
    let tms1_ptr = u64::from(ig.stream.read_u32()?);
    let scale_shift_raw = ig.stream.read_u16()?;
    let translation_shift_raw = ig.stream.read_u16()?;
    // IT's FByteswapper<Skeleton> deliberately skips these two u16s (see
    // common/src/serialize.cpp:186 — only numBones/rootBone/bones/tms0/tms1
    // get swapped). On PS3 BE files our read_u16 over-swaps them. The real
    // shift is always 0..15 in IT; if we read > 15, swap_bytes recovers it.
    // Without this fix `pos_scale` in cache.rs falls through to 1/32768
    // → animation translations decode 30000x too small → bones collapse to
    // origin when anims override bind pose. See memory:
    // `skeleton_shift_byte_quirk` for the long story.
    //
    // Some 49-bone head rigs (soldierHead/cartwright/Winters viseme rigs)
    // have raw values like 0x0103 — both raw (259) and swapped (769) are
    // > 15. We leave those as-is and let cache.rs fall back to its default
    // pos_scale=1/32768. The low-byte heuristic (0x0103 → 3) was tried and
    // made anims worse, so the real fix needs option 2 (probe IT's
    // animation_machine.cpp for whatever shift handling those rigs use).
    let scale_shift = recover_shift(scale_shift_raw);
    let translation_shift = recover_shift(translation_shift_raw);

    if num_bones == 0 || bones_ptr == 0 {
        return Ok(None);
    }
    if num_bones > MAX_REASONABLE_BONES {

        eprintln!(
            "warn: skeleton numBones={num_bones} exceeds cap {MAX_REASONABLE_BONES} — \
             skipping skeleton (file layout may differ from spec)"
        );
        return Ok(None);
    }

    if (scale_shift_raw > 15 && scale_shift_raw.swap_bytes() > 15
        || translation_shift_raw > 15 && translation_shift_raw.swap_bytes() > 15)
        && std::env::var("RECHIMERA_LOG_PROBES").is_ok()
    {
        eprintln!(
            "[skel-shift] hdr=0x{:X} bones={} viseme-rig: raw {:#06X}/{:#06X} → swap & 0x1F = {}/{} \
             (matching IT's x86 SHR mask). pos_scale = 1/(0x8000 >> {}).",
            header_off, num_bones, scale_shift_raw, translation_shift_raw,
            scale_shift, translation_shift, translation_shift,
        );
    }

    let mut bones = Vec::with_capacity(num_bones);
    for i in 0..num_bones {
        ig.stream.seek_to(bones_ptr + (i as u64) * BONE_BYTES)?;
        let flags = ig.stream.read_u16()?;
        let parent_index = ig.stream.read_i16()?;
        let child = ig.stream.read_u16()?;
        let sibling = ig.stream.read_u16()?;
        bones.push(Bone {
            flags,
            parent_index,
            child,
            sibling,
        });
    }

    let tms0_raw = read_matrix_array(ig, tms0_ptr, num_bones).unwrap_or_default();
    let tms1_raw = read_matrix_array(ig, tms1_ptr, num_bones).unwrap_or_default();

    let mut bind_local = Vec::with_capacity(num_bones);
    let mut root_count = 0usize;
    let mut self_parent_count = 0usize;
    if tms0_raw.len() == num_bones && tms1_raw.len() == num_bones {
        for i in 0..num_bones {
            let parent = bones[i].parent_index;
            let is_self_parent = parent >= 0 && (parent as usize) == i;
            let is_root = parent < 0
                || (parent as usize) >= num_bones
                || (parent as usize) == i;
            if is_self_parent {
                self_parent_count += 1;
            }
            if is_root {
                root_count += 1;
            }
            let local_col = if is_root {
                tms0_raw[i]
            } else {
                mat4_mul_row_major(&tms0_raw[i], &tms1_raw[parent as usize])
            };
            bind_local.push(clean_rigid_col_major(local_col));
        }
    }

    let _ = root_count;
    let _ = self_parent_count;

    let bind_world_inverse: Vec<[f32; 16]> =
        tms1_raw.iter().copied().map(clean_rigid_col_major).collect();
    let tms0_col: Vec<[f32; 16]> =
        tms0_raw.iter().copied().map(clean_rigid_col_major).collect();
    let tms1_col: Vec<[f32; 16]> =
        tms1_raw.iter().copied().map(clean_rigid_col_major).collect();

    Ok(Some(Skeleton {
        root_bone,
        bones,
        bind_local,
        bind_world_inverse,
        tms0_col,
        tms1_col,
        scale_shift,
        translation_shift,
    }))
}

fn recover_shift(raw: u16) -> u16 {
    if raw <= 15 {
        return raw;
    }
    let swapped = raw.swap_bytes();
    if swapped <= 15 {
        return swapped;
    }
    // For the 14 viseme head rigs, raw=0x0103 → swap=0x0301=769. IT reads
    // these bytes as LE (the field is deliberately skipped by FByteswapper<Skeleton>)
    // and passes the resulting u16 directly to `0x8000 >> shift`. On x86 the
    // SHR instruction masks the shift count to 5 bits, so the effective value
    // is `swap & 0x1F` = `769 & 0x1F` = 1. We replicate that masking to match
    // IT's runtime behavior (shift=1 → pos_scale=1/16384 → ~5cm viseme deltas).
    // The low-byte heuristic (raw & 0xFF = 3) was tried first and gave the
    // wrong magnitude; this 5-bit-mask matches the actual silicon.
    swapped & 0x1F
}

fn clean_rigid_col_major(mut m: [f32; 16]) -> [f32; 16] {
    for v in m.iter_mut() {
        if !v.is_finite() {
            *v = 0.0;
        }
    }
    m[3] = 0.0;
    m[7] = 0.0;
    m[11] = 0.0;
    m[15] = 1.0;
    m
}

fn read_matrix_array<R: Read + Seek>(
    ig: &mut IgFile<R>,
    ptr: u64,
    count: usize,
) -> Result<Vec<[f32; 16]>> {
    if ptr == 0 || count == 0 {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        ig.stream.seek_to(ptr + (i as u64) * 64)?;
        let mut m = [0f32; 16];
        for slot in m.iter_mut() {
            *slot = ig.stream.read_f32()?;
        }
        out.push(m);
    }
    Ok(out)
}
