//! Parser for Insomniac's IGHW asset containers used on PS3.
//!
//! Initial scope: read the `assetlookup.dat` table for Resistance 2/3 and the
//! Ratchet & Clank Future series. Higher-level decoders (mobys, ties, textures,
//! shaders, zones) come later — see the corresponding C# parser in
//! `LibLunacy/` and the C++ struct definitions in
//! `InsomniaToolset/common/include/insomnia/classes/`.

pub mod animation;
pub mod assetlookup;
pub mod error;
pub mod gameplay;
pub mod igfile;
pub mod math;
pub mod moby;
pub mod shader;
pub mod skeleton;
pub mod stream;
pub mod texture;
pub mod tie;
pub mod zone;

pub use animation::{
    decode_animation, read_animation_control, read_animation_frame, read_animation_header,
    AnimationControl, AnimationHeader, DecodedBone, DecodedClip, TrackKind, TrackMask,
};
pub use assetlookup::{AssetKind, AssetLookup, AssetPointer};
pub use error::{Error, Result};
pub use gameplay::{read_gameplay, GameplayLayout, MobyInstance, Region};
pub use igfile::{IgFile, SectionHeader, Version};
pub use moby::{
    read_moby_assets, read_moby_assets_streaming, read_moby_assets_with_total, MobyAsset,
    MobyBangle, MobyMesh,
};
pub use shader::{read_shaders, ShaderInfo};
pub use skeleton::{read_skeleton, Bone, Skeleton};
pub use stream::{Endian, StreamHelper};
pub use texture::{
    downsample_rgba, encode_png, read_textures, read_textures_streaming,
    read_textures_with_total, TexFormat, Texture,
};
pub use tie::{
    read_tie_assets, read_tie_assets_streaming, read_tie_assets_with_total, TieAsset, TieMeshGeom,
};
pub use zone::{read_zones, read_zones_streaming, read_zones_with_total, TieInstance, UFrag, Zone};
