//! Skeleton parser — reads section `0xD300` of a moby IGHW chunk.
//!
//! Layout per [InsomniaToolset/animation.hpp](../../../../../InsomniaToolset/common/include/insomnia/classes/moby.hpp)
//! `Skeleton` and `Bone`:
//!
//! - section `0xD300` — single 0x20-byte `Skeleton` header:
//!   - `0x00` u16 numBones
//!   - `0x02` u16 rootBone
//!   - `0x04` u32 bonesPtr           — file-relative pointer to `Bone[numBones]`
//!   - `0x08` u32 tms0Ptr            — pointer to `Matrix44[numBones]`
//!     (per-bone local bind-pose; consumed by THREE.js as a column-major
//!     matrix decomposed into bone TRS — no transpose required for R2)
//!   - `0x0C` u32 tms1Ptr            — pointer to `Matrix44[numBones]`
//!     (per-bone world-space inverse bind, used as `boneInverses`)
//!   - `0x10` u16 scaleShift
//!   - `0x12` u16 translationShift
//!   - `0x14` u32 spuRefPoseBuffer   — pointer (unused for our needs)
//!   - `0x18` u32 unkOffset
//!   - `0x1C` padding to 0x20
//!
//! - `Bone` is 8 bytes:
//!   - `0x00` u16 flags          — bit 0 = FLAG_DONT_INHERIT_SCALE
//!   - `0x02` i16 parentIndex    — -1 for root
//!   - `0x04` u16 child          — first child bone index (0xFFFF = none)
//!   - `0x06` u16 sibling        — next sibling at same depth (0xFFFF = none)
//!
//! Phase 1 just exposes the hierarchy + the two matrix arrays. Skin weights
//! and animation playback layer on top in later phases.

use std::io::{Read, Seek};

use crate::error::Result;
use crate::igfile::IgFile;

/// Section ID where the skeleton header lives inside a moby IGHW chunk.
pub const SECT_MOBY_SKELETON: u32 = 0xD300;

const BONE_BYTES: u64 = 0x08;

/// Sanity cap on bone count. Insomniac PS3 mobys have at most a few hundred
/// bones (humans / chimeran are ~100, big bosses maybe ~300). Anything above
/// this is overwhelmingly likely to be misinterpreted bytes — either wrong
/// section layout or wrong endianness — so we bail with `Ok(None)` rather
/// than allocate gigabytes and seek into garbage.
const MAX_REASONABLE_BONES: usize = 4096;

#[derive(Debug, Clone, Copy)]
pub struct Bone {
    pub flags: u16,
    /// `-1` for the root bone.
    pub parent_index: i16,
    /// `0xFFFF` when the bone has no children.
    pub child: u16,
    /// `0xFFFF` when there's no next sibling.
    pub sibling: u16,
}

impl Bone {
    pub fn is_root(self) -> bool {
        self.parent_index < 0
    }
    pub fn dont_inherit_scale(self) -> bool {
        self.flags & 0x01 != 0
    }
    /// Convenience: clean parent option (`None` for root, `Some(idx)` else).
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
    /// On-disk `tms0` array — empirically the per-bone LOCAL bind
    /// matrix in a layout `THREE.Matrix4.fromArray` consumes directly
    /// (matches develop branch's working render). Empty when the
    /// moby has no `tms0` pointer.
    pub bind_local: Vec<[f32; 16]>,
    /// On-disk `tms1` array — per-bone WORLD-INVERSE bind. Used
    /// directly as `THREE.Skeleton.boneInverses` / glTF
    /// `inverseBindMatrices`.
    pub bind_world_inverse: Vec<[f32; 16]>,
    /// Alias of `bind_local` (raw `tms0`). Kept as a separate field
    /// so the FE strategy switcher in `RawCharacterModal` has stable
    /// data to feed into alternative interpretations (`direct` /
    /// `relunacy` / `it`) without needing a Rust rebuild.
    pub tms0_col: Vec<[f32; 16]>,
    /// Alias of `bind_world_inverse` (raw `tms1`). Same reason as above.
    pub tms1_col: Vec<[f32; 16]>,
    pub scale_shift: u16,
    pub translation_shift: u16,
}

impl Skeleton {
    pub fn bone_count(&self) -> usize {
        self.bones.len()
    }
}

/// Parse the skeleton from a per-moby IGHW chunk. Returns `Ok(None)` when
/// section `0xD300` isn't present (props with no rig — e.g. crates) so the
/// moby decoder can still succeed for rigless mobys.
pub fn read_skeleton<R: Read + Seek>(ig: &mut IgFile<R>) -> Result<Option<Skeleton>> {
    let Some(section) = ig.section(SECT_MOBY_SKELETON) else {
        return Ok(None);
    };
    let header_off = u64::from(section.offset);

    ig.stream.seek_to(header_off + 0x00)?;
    let num_bones = ig.stream.read_u16()? as usize;
    let root_bone = ig.stream.read_u16()?;
    let bones_ptr = u64::from(ig.stream.read_u32()?);
    let tms0_ptr = u64::from(ig.stream.read_u32()?);
    let tms1_ptr = u64::from(ig.stream.read_u32()?);
    let scale_shift = ig.stream.read_u16()?;
    let translation_shift = ig.stream.read_u16()?;

    if num_bones == 0 || bones_ptr == 0 {
        return Ok(None);
    }
    if num_bones > MAX_REASONABLE_BONES {
        // Malformed skeleton header — most likely the section layout for
        // R2/R3 differs from the InsomniaToolset C++ struct we ported.
        // Bail rather than allocate gigabytes / seek into garbage.
        eprintln!(
            "warn: skeleton numBones={num_bones} exceeds cap {MAX_REASONABLE_BONES} — \
             skipping skeleton (file layout may differ from spec)"
        );
        return Ok(None);
    }

    // Read Bone[numBones]. We seek-and-read per bone; if any seek lands past
    // EOF the inner reader returns ErrorKind::UnexpectedEof which propagates
    // as Error::Io, killing the whole moby parse. Catch at call site.
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

    // Matrix arrays are best-effort — if either pointer is bad, return
    // what we have rather than failing the whole skeleton. Raw bytes
    // straight from disk: empirically these are already in a layout
    // `THREE.Matrix4.fromArray` reads correctly without transpose
    // (verified against the develop branch's working render). The IT
    // C++ `GenerateSkeleton` does parent-multiplication for its own
    // glTF output pipeline, but the on-disk PS3 matrices for R2 are
    // already per-bone LOCAL — at least for the cases we render.
    //
    // tms0_col / tms1_col are aliases shipped through the API so the
    // FE strategy switcher in RawCharacterModal has data to swap
    // between alternative interpretations without a Rust rebuild.
    let bind_local = read_matrix_array(ig, tms0_ptr, num_bones).unwrap_or_default();
    let bind_world_inverse =
        read_matrix_array(ig, tms1_ptr, num_bones).unwrap_or_default();
    let tms0_col = bind_local.clone();
    let tms1_col = bind_world_inverse.clone();

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
