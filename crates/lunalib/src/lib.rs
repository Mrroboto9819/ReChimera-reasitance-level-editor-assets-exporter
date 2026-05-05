//! Parser for Insomniac's IGHW asset containers used on PS3.
//!
//! Initial scope: read the `assetlookup.dat` table for Resistance 2/3 and the
//! Ratchet & Clank Future series. Higher-level decoders (mobys, ties, textures,
//! shaders, zones) come later — see the corresponding C# parser in
//! `LibLunacy/` and the C++ struct definitions in
//! `InsomniaToolset/common/include/insomnia/classes/`.

pub mod assetlookup;
pub mod error;
pub mod gameplay;
pub mod igfile;
pub mod math;
pub mod moby;
pub mod shader;
pub mod stream;
pub mod texture;
pub mod tie;
pub mod zone;

pub use assetlookup::{AssetKind, AssetLookup, AssetPointer};
pub use error::{Error, Result};
pub use gameplay::{read_gameplay, GameplayLayout, MobyInstance, Region};
pub use igfile::{IgFile, SectionHeader, Version};
pub use moby::{read_moby_assets, MobyAsset, MobyBangle, MobyMesh};
pub use shader::{read_shaders, ShaderInfo};
pub use stream::{Endian, StreamHelper};
pub use texture::{encode_png, read_textures, TexFormat, Texture};
pub use tie::{read_tie_assets, TieAsset, TieMeshGeom};
pub use zone::{read_zones, TieInstance, UFrag, Zone};
