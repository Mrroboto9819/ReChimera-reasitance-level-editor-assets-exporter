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
pub mod gltf_export;

/// Hard cap on a single asset payload (slice of `mobys.dat` / `ties.dat` /
/// `zones.dat` etc.). Disk-derived `length` fields are attacker-controllable;
/// without a cap a crafted `assetlookup.dat` could request a 4 GiB allocation.
pub const MAX_ASSET_SIZE: u32 = 512 * 1024 * 1024;

/// Hard cap on the per-section entry count derived from `section.length`.
/// Real levels have at most a few thousand entries per section; this cap
/// stops a crafted IGHW with a 4 GiB section length from seeding a multi-GiB
/// `Vec::with_capacity` before we've read a single entry.
pub const MAX_SECTION_ENTRIES: usize = 4 * 1024 * 1024;
pub mod gameplay;
pub mod igfile;
pub mod math;
pub mod moby;
pub mod shader;
pub mod skeleton;
pub mod sound;
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
pub use gltf_export::{
    write_moby_geometry_glb, write_moby_glb_full, write_moby_glb_with_animations,
};
pub use gameplay::{read_gameplay, GameplayLayout, MobyInstance, Region};
pub use igfile::{IgFile, SectionHeader, Version};
pub use moby::{
    read_moby_assets, read_moby_assets_streaming, read_moby_assets_with_total, MobyAsset,
    MobyBangle, MobyMesh,
};
pub use shader::{read_shaders, ShaderInfo};
pub use skeleton::{read_skeleton, Bone, Skeleton};
pub use sound::{
    bank_pair_for, decode_adpcm_block, decode_adpcm_stream, dump_sound_bank_info,
    extract_bank_sounds, extract_raw_streaming, extract_stream_sounds, list_raw_streaming,
    list_sounds, scan_raw_audio_offsets, streaming_sibling_for, write_wav_pcm16,
    write_wav_pcm16_mono, ExtractedSound, SoundKind, SoundSummary,
};
pub use stream::{Endian, StreamHelper};
pub use texture::{
    bulk_extract_pngs, downsample_rgba, encode_png, read_textures, read_textures_streaming,
    read_textures_with_total, TexFormat, Texture,
};
pub use tie::{
    read_tie_assets, read_tie_assets_streaming, read_tie_assets_with_total, TieAsset, TieMeshGeom,
};
pub use zone::{read_zones, read_zones_streaming, read_zones_with_total, TieInstance, UFrag, Zone};
