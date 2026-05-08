

use std::io::{Read, Seek};

use crate::error::Result;
use crate::igfile::IgFile;

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

        eprintln!(
            "warn: skeleton numBones={num_bones} exceeds cap {MAX_REASONABLE_BONES} — \
             skipping skeleton (file layout may differ from spec)"
        );
        return Ok(None);
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
