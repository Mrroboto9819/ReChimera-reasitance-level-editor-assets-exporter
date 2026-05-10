


use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use crate::assetlookup::{AssetKind, AssetLookup};
use crate::error::Result;
use crate::igfile::IgFile;

const SECT_SHADER_REFS: u32 = 0x5D00;

#[derive(Debug, Clone, Copy)]
pub struct ShaderInfo {
    pub tuid: u64,

    pub albedo_tex_id: Option<u32>,
    pub normal_tex_id: Option<u32>,
    pub expensive_tex_id: Option<u32>,
}


pub fn read_shaders(level_folder: &Path) -> Result<HashMap<u64, ShaderInfo>> {
    let assetlookup_path = level_folder.join("assetlookup.dat");
    let mut lookup = AssetLookup::open(BufReader::new(File::open(&assetlookup_path)?))?;
    let ptrs = lookup.pointers(AssetKind::Shader)?;
    if ptrs.is_empty() {
        return Ok(HashMap::new());
    }

    let shaders_path = level_folder.join("shaders.dat");
    let mut shaders_file = File::open(&shaders_path)?;

    let mut out = HashMap::with_capacity(ptrs.len());
    for ptr in ptrs {
        if ptr.length > crate::MAX_ASSET_SIZE {
            return Err(crate::error::Error::AllocLimitExceeded {
                size: u64::from(ptr.length),
                limit: u64::from(crate::MAX_ASSET_SIZE),
            });
        }
        shaders_file.seek(SeekFrom::Start(u64::from(ptr.offset)))?;
        let mut buf = vec![0u8; ptr.length as usize];
        shaders_file.read_exact(&mut buf)?;
        let mut shader_ig = IgFile::open(Cursor::new(buf))?;

        match parse_shader(&mut shader_ig, ptr.tuid) {
            Ok(info) => {
                out.insert(info.tuid, info);
            }
            Err(_e) => {

            }
        }
    }
    Ok(out)
}

fn parse_shader<R: Read + Seek>(ig: &mut IgFile<R>, tuid: u64) -> Result<ShaderInfo> {
    let Some(refs) = ig.section(SECT_SHADER_REFS) else {
        return Ok(ShaderInfo {
            tuid,
            albedo_tex_id: None,
            normal_tex_id: None,
            expensive_tex_id: None,
        });
    };

    let base = u64::from(refs.offset);
    ig.stream.seek_to(base + 0x10)?;
    let albedo = ig.stream.read_u32()?;
    let normal = ig.stream.read_u32()?;
    let expensive = ig.stream.read_u32()?;

    Ok(ShaderInfo {
        tuid,
        albedo_tex_id: (albedo != 0).then_some(albedo),
        normal_tex_id: (normal != 0).then_some(normal),
        expensive_tex_id: (expensive != 0).then_some(expensive),
    })
}
