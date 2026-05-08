//! Native GLB writer for moby assets.
//!
//! Mirrors IT's `extract_gltf.cpp::ExtractMobys` workflow but produces the
//! GLB binary directly from Rust. Layered in phases:
//!
//!   - **G1**: positions + UVs + indices (geometry only).
//!   - **G2 (now)**: skin — bone nodes, joints[], inverseBindMatrices,
//!     plus JOINTS_0 + WEIGHTS_0 attributes per skinned primitive. The
//!     resulting GLB opens as a rigged armature in Blender.
//!   - G3: animation tracks per animset clip.
//!   - G4: PBR materials with embedded PNG textures.
//!
//! Output is a self-contained binary glTF (.glb):
//!
//! ```text
//! [12-byte GLB header: magic 'glTF' + version 2 + total length]
//! [JSON chunk: 8-byte header + JSON payload, padded to 4 bytes with 0x20]
//! [BIN chunk:  8-byte header + binary payload, padded to 4 bytes with 0x00]
//! ```
//!
//! Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout

use byteorder::{LittleEndian, WriteBytesExt};
use gltf_json::validation::{Checked, USize64};
use gltf_json::{
    self,
    accessor::{ComponentType, GenericComponentType, Type as AccessorType},
    animation::{Channel, Property, Sampler, Target},
    buffer,
    mesh::{Mode, Primitive, Semantic},
    Index,
};

use std::collections::HashMap;

use crate::animation::DecodedClip;
use crate::error::{Error, Result};
use crate::moby::{MobyAsset, MobyMesh};
use crate::shader::ShaderInfo;
use crate::skeleton::Skeleton;

const GLB_MAGIC: u32 = 0x46546C67; // "glTF"
const GLB_VERSION: u32 = 2;
const CHUNK_TYPE_JSON: u32 = 0x4E4F534A; // "JSON"
const CHUNK_TYPE_BIN: u32 = 0x004E4942; // "BIN\0"

/// Build a binary glTF (`.glb`) for one moby asset.
///
/// Convenience wrapper — no animations, no materials. See
/// `write_moby_glb_full` for the complete version.
pub fn write_moby_geometry_glb(asset: &MobyAsset) -> Result<Vec<u8>> {
    write_moby_glb_full(asset, &[], &HashMap::new(), &HashMap::new())
}

/// Convenience: geometry + skin + animations, no materials.
/// Compatibility entry point for cache.rs's pre-G4 callers.
pub fn write_moby_glb_with_animations(
    asset: &MobyAsset,
    clips: &[DecodedClip],
) -> Result<Vec<u8>> {
    write_moby_glb_full(asset, clips, &HashMap::new(), &HashMap::new())
}

/// Build a binary glTF (`.glb`) with geometry + skeleton + per-clip
/// animations + PBR materials with embedded PNG textures.
///
/// `shaders` maps shader TUID → texture id refs (per-shader albedo /
/// normal / expensive). `textures` maps texture id → PNG bytes; the
/// writer embeds whichever ids the asset's shaders actually reference.
/// Pass empty maps to skip materials entirely.
///
/// Output structure:
///   - One scene (`scenes[0]`)
///   - One asset root node (`nodes[0]`) — holds the mesh
///   - N bone nodes (`nodes[1..1+B]`) — per-bone TRS via `matrix`
///   - One mesh (`meshes[0]`) — N primitives (one per submesh)
///   - One skin (`skins[0]`) when the asset has a skeleton
///   - M animations (`animations[0..M]`) — one per clip
///   - K materials with embedded PNG textures via `bufferView`
///
/// Skinned submeshes get JOINTS_0 (u8 vec4) + WEIGHTS_0 (u8 vec4 UNORM)
/// attributes. Static submeshes get just position+UV+indices.
pub fn write_moby_glb_full(
    asset: &MobyAsset,
    clips: &[DecodedClip],
    shaders: &HashMap<u64, ShaderInfo>,
    textures: &HashMap<u32, Vec<u8>>,
) -> Result<Vec<u8>> {
    let mut bin: Vec<u8> = Vec::new();
    let mut accessors: Vec<gltf_json::Accessor> = Vec::new();
    let mut buffer_views: Vec<gltf_json::buffer::View> = Vec::new();
    let mut nodes: Vec<gltf_json::Node> = Vec::new();
    let mut skins: Vec<gltf_json::Skin> = Vec::new();
    let mut animations: Vec<gltf_json::Animation> = Vec::new();
    let mut images: Vec<gltf_json::Image> = Vec::new();
    let mut gltf_textures: Vec<gltf_json::Texture> = Vec::new();
    let mut materials: Vec<gltf_json::Material> = Vec::new();
    // Cache so duplicate texture-id references reuse the same Image
    // (a level often has albedo+emissive sharing one PNG, etc).
    let mut image_idx_by_tex_id: HashMap<u32, u32> = HashMap::new();

    // ── Asset root node (index 0) holds the mesh.
    // Its children list is filled later if there's a skeleton, since
    // the bone node indices aren't known until we push them.
    nodes.push(gltf_json::Node {
        camera: None,
        children: None,
        extensions: Default::default(),
        extras: Default::default(),
        matrix: None,
        mesh: Some(Index::new(0)),
        name: Some(asset_display_name(asset)),
        rotation: None,
        scale: None,
        translation: None,
        skin: None,
        weights: None,
    });
    let asset_root_idx: u32 = 0;

    // ── Skeleton: emit one Node per bone, build skin
    let skin_idx = if let Some(skel) = asset.skeleton.as_ref() {
        if !skel.bones.is_empty() && !skel.bind_local.is_empty() {
            Some(emit_skin(
                &mut bin,
                &mut accessors,
                &mut buffer_views,
                &mut nodes,
                &mut skins,
                skel,
            ))
        } else {
            None
        }
    } else {
        None
    };

    // Bone-node base index — bones live in `nodes[bone_node_base ..
    // bone_node_base + bone_count]`. Set right after emit_skin so we
    // can target the right node indices from the animation channels.
    let (bone_node_base, bone_count) = match (skin_idx, asset.skeleton.as_ref()) {
        (Some(_), Some(skel)) => (1u32, skel.bones.len()),
        _ => (0u32, 0usize),
    };

    // ── Mesh: one primitive per submesh
    let mut primitives: Vec<Primitive> = Vec::new();
    for bangle in &asset.bangles {
        for mesh in &bangle.meshes {
            // Resolve per-submesh material (albedo only for now; normal
            // / emissive maps land in a follow-up). Returns None when
            // shader/texture data is unavailable — primitive ships
            // material-less in that case.
            let material_idx = build_material(
                &mut bin,
                &mut buffer_views,
                &mut images,
                &mut gltf_textures,
                &mut materials,
                &mut image_idx_by_tex_id,
                &asset.shader_tuids,
                shaders,
                textures,
                mesh.shader_index as usize,
            );
            primitives.push(push_submesh(
                &mut bin,
                &mut accessors,
                &mut buffer_views,
                mesh,
                skin_idx.is_some(),
                material_idx,
            )?);
        }
    }
    if primitives.is_empty() {
        return Err(Error::SectionLengthMismatch {
            id: 0xD100,
            length: 0,
            entry: 1,
        });
    }

    // Wire skin reference onto the mesh node (only when there's a skin).
    if let Some(_skin) = skin_idx {
        nodes[asset_root_idx as usize].skin = Some(Index::new(0));
    }

    // Animations — emit only when the asset has a usable skeleton AND
    // the caller passed at least one clip. Each clip becomes one glTF
    // Animation. Channels target bone Nodes by index.
    if skin_idx.is_some() && !clips.is_empty() && bone_count > 0 {
        emit_animations(
            &mut bin,
            &mut accessors,
            &mut buffer_views,
            &mut animations,
            clips,
            bone_node_base,
            bone_count,
        );
    }

    // ── Pad bin chunk to 4-byte alignment with zero bytes.
    while bin.len() % 4 != 0 {
        bin.push(0);
    }

    let buffer = gltf_json::Buffer {
        byte_length: USize64(bin.len() as u64),
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        uri: None,
    };

    let mesh = gltf_json::Mesh {
        extensions: Default::default(),
        extras: Default::default(),
        name: Some(asset_display_name(asset)),
        primitives,
        weights: None,
    };

    // Scene's root nodes: just the asset root. Bone roots are children
    // of the asset root (set up by `emit_skin` below).
    let scene_root_nodes: Vec<Index<gltf_json::Node>> = vec![Index::new(asset_root_idx)];

    let scene = gltf_json::Scene {
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        nodes: scene_root_nodes,
    };

    let root = gltf_json::Root {
        accessors,
        animations,
        buffers: vec![buffer],
        buffer_views,
        images,
        materials,
        meshes: vec![mesh],
        nodes,
        scene: Some(Index::new(0)),
        scenes: vec![scene],
        skins,
        textures: gltf_textures,
        ..Default::default()
    };

    serialize_glb(&root, &bin)
}

fn asset_display_name(asset: &MobyAsset) -> String {
    if asset.name.is_empty() {
        format!("moby_{:016X}", asset.tuid)
    } else {
        asset.name.clone()
    }
}

/// Append per-bone Nodes + InverseBindMatrices accessor + Skin record.
/// Returns the skin index. Bone Nodes are appended starting at
/// `nodes.len()`. Their parent/child wiring uses the in-disk parent
/// index — bones with `parent_index < 0` are attached as children of
/// the asset root node (index 0).
fn emit_skin(
    bin: &mut Vec<u8>,
    accessors: &mut Vec<gltf_json::Accessor>,
    buffer_views: &mut Vec<gltf_json::buffer::View>,
    nodes: &mut Vec<gltf_json::Node>,
    skins: &mut Vec<gltf_json::Skin>,
    skel: &Skeleton,
) -> u32 {
    let bone_count = skel.bones.len();
    let bone_node_base = nodes.len() as u32;

    // Emit per-bone Nodes with `matrix` set from bind_local. We use the
    // matrix path (rather than decomposed TRS) so we don't have to do
    // matrix decomposition on the Rust side — glTF tools (Blender,
    // three.js) handle it. The on-disk bytes are already in the layout
    // these consumers expect.
    for i in 0..bone_count {
        let matrix: Option<[f32; 16]> = skel.bind_local.get(i).copied();
        nodes.push(gltf_json::Node {
            camera: None,
            children: None,
            extensions: Default::default(),
            extras: Default::default(),
            matrix,
            mesh: None,
            name: Some(format!("bone_{i}")),
            rotation: None,
            scale: None,
            translation: None,
            skin: None,
            weights: None,
        });
    }

    // Wire children. Each non-root bone is added to its parent's
    // `children`; root bones (parent < 0) become children of the
    // asset root node (index 0).
    let mut asset_root_children: Vec<Index<gltf_json::Node>> = Vec::new();
    for i in 0..bone_count {
        let parent_idx = skel.bones[i].parent_index;
        let bone_node_idx = bone_node_base + i as u32;
        if parent_idx < 0 {
            asset_root_children.push(Index::new(bone_node_idx));
        } else {
            let parent_node_idx = bone_node_base + parent_idx as u32;
            let parent = &mut nodes[parent_node_idx as usize];
            let kids = parent.children.get_or_insert_with(Vec::new);
            kids.push(Index::new(bone_node_idx));
        }
    }
    if !asset_root_children.is_empty() {
        let root_kids = nodes[0].children.get_or_insert_with(Vec::new);
        root_kids.extend(asset_root_children);
    }

    // InverseBindMatrices accessor — one MAT4 per bone, contiguous.
    // Falls back to identity matrices when the source skeleton lacks
    // tms1 (rare but possible — see skeleton.rs read_matrix_array).
    let ibm_bytes = pack_ibms(skel, bone_count);
    let ibm_view = push_buffer_view(bin, buffer_views, &ibm_bytes);
    let ibm_accessor_idx = accessors.len() as u32;
    accessors.push(gltf_json::Accessor {
        buffer_view: Some(Index::new(ibm_view)),
        byte_offset: Some(USize64(0)),
        count: USize64(bone_count as u64),
        component_type: Checked::Valid(GenericComponentType(ComponentType::F32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: Checked::Valid(AccessorType::Mat4),
        min: None,
        max: None,
        name: None,
        normalized: false,
        sparse: None,
    });

    // Skin record.
    let joints: Vec<Index<gltf_json::Node>> = (0..bone_count)
        .map(|i| Index::new(bone_node_base + i as u32))
        .collect();
    let skin_idx = skins.len() as u32;
    skins.push(gltf_json::Skin {
        extensions: Default::default(),
        extras: Default::default(),
        inverse_bind_matrices: Some(Index::new(ibm_accessor_idx)),
        joints,
        name: Some("skeleton".into()),
        skeleton: None,
    });
    skin_idx
}

fn pack_ibms(skel: &Skeleton, bone_count: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(bone_count * 64);
    for i in 0..bone_count {
        let m = skel
            .bind_world_inverse
            .get(i)
            .copied()
            .unwrap_or(IDENTITY_MAT4);
        for v in m {
            out.write_f32::<LittleEndian>(v).expect("vec write");
        }
    }
    out
}

const IDENTITY_MAT4: [f32; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

/// Build one glTF primitive from a `MobyMesh`. When `skinned` is true
/// AND the mesh has bone-weight data, JOINTS_0 / WEIGHTS_0 attributes
/// are emitted. The skin reference itself is on the parent Node, not
/// the primitive.
fn push_submesh(
    bin: &mut Vec<u8>,
    accessors: &mut Vec<gltf_json::Accessor>,
    views: &mut Vec<gltf_json::buffer::View>,
    mesh: &MobyMesh,
    skinned: bool,
    material_idx: Option<u32>,
) -> Result<Primitive> {
    use std::collections::BTreeMap;

    if mesh.positions.is_empty() || mesh.indices.is_empty() {
        return Err(Error::SectionLengthMismatch {
            id: 0xDD00,
            length: mesh.positions.len() as u32,
            entry: 12,
        });
    }

    let mut attributes: BTreeMap<Checked<Semantic>, Index<gltf_json::Accessor>> =
        BTreeMap::new();

    // ── POSITION ──
    let pos_view = push_buffer_view(bin, views, &positions_to_bytes(&mesh.positions));
    let (min, max) = position_bounds(&mesh.positions);
    accessors.push(gltf_json::Accessor {
        buffer_view: Some(Index::new(pos_view)),
        byte_offset: Some(USize64(0)),
        count: USize64((mesh.positions.len() / 3) as u64),
        component_type: Checked::Valid(GenericComponentType(ComponentType::F32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: Checked::Valid(AccessorType::Vec3),
        min: Some(serde_json::json!([min[0], min[1], min[2]])),
        max: Some(serde_json::json!([max[0], max[1], max[2]])),
        name: None,
        normalized: false,
        sparse: None,
    });
    attributes.insert(
        Checked::Valid(Semantic::Positions),
        Index::new((accessors.len() - 1) as u32),
    );

    // ── TEXCOORD_0 ──
    if !mesh.uvs.is_empty() {
        let uv_view = push_buffer_view(bin, views, &uvs_to_bytes(&mesh.uvs));
        accessors.push(gltf_json::Accessor {
            buffer_view: Some(Index::new(uv_view)),
            byte_offset: Some(USize64(0)),
            count: USize64((mesh.uvs.len() / 2) as u64),
            component_type: Checked::Valid(GenericComponentType(ComponentType::F32)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: Checked::Valid(AccessorType::Vec2),
            min: None,
            max: None,
            name: None,
            normalized: false,
            sparse: None,
        });
        attributes.insert(
            Checked::Valid(Semantic::TexCoords(0)),
            Index::new((accessors.len() - 1) as u32),
        );
    }

    // ── JOINTS_0 + WEIGHTS_0 (skinned only) ──
    if skinned
        && !mesh.bone_indices.is_empty()
        && mesh.bone_weights.len() == mesh.bone_indices.len()
    {
        let vertex_count = mesh.positions.len() / 3;
        debug_assert_eq!(
            mesh.bone_indices.len(),
            vertex_count * 4,
            "bone_indices must be 4 per vertex"
        );

        // JOINTS_0 — u8 vec4. PS3 source has u16 indices but actual
        // values are < 256 (per-mesh boneMap is small), so u8 is fine.
        let joints_bytes = joints_u8_bytes(&mesh.bone_indices, vertex_count);
        let j_view = push_buffer_view(bin, views, &joints_bytes);
        accessors.push(gltf_json::Accessor {
            buffer_view: Some(Index::new(j_view)),
            byte_offset: Some(USize64(0)),
            count: USize64(vertex_count as u64),
            component_type: Checked::Valid(GenericComponentType(ComponentType::U8)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: Checked::Valid(AccessorType::Vec4),
            min: None,
            max: None,
            name: None,
            normalized: false,
            sparse: None,
        });
        attributes.insert(
            Checked::Valid(Semantic::Joints(0)),
            Index::new((accessors.len() - 1) as u32),
        );

        // WEIGHTS_0 — u8 vec4 UNORM (0..255 → 0..1).
        let w_view = push_buffer_view(bin, views, &mesh.bone_weights);
        accessors.push(gltf_json::Accessor {
            buffer_view: Some(Index::new(w_view)),
            byte_offset: Some(USize64(0)),
            count: USize64(vertex_count as u64),
            component_type: Checked::Valid(GenericComponentType(ComponentType::U8)),
            extensions: Default::default(),
            extras: Default::default(),
            type_: Checked::Valid(AccessorType::Vec4),
            min: None,
            max: None,
            name: None,
            normalized: true,
            sparse: None,
        });
        attributes.insert(
            Checked::Valid(Semantic::Weights(0)),
            Index::new((accessors.len() - 1) as u32),
        );
    }

    // ── INDICES (u32) ──
    let idx_view = push_buffer_view(bin, views, &indices_to_bytes(&mesh.indices));
    accessors.push(gltf_json::Accessor {
        buffer_view: Some(Index::new(idx_view)),
        byte_offset: Some(USize64(0)),
        count: USize64(mesh.indices.len() as u64),
        component_type: Checked::Valid(GenericComponentType(ComponentType::U32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: Checked::Valid(AccessorType::Scalar),
        min: None,
        max: None,
        name: None,
        normalized: false,
        sparse: None,
    });
    let indices_accessor = Index::new((accessors.len() - 1) as u32);

    Ok(Primitive {
        attributes,
        extensions: Default::default(),
        extras: Default::default(),
        indices: Some(indices_accessor),
        material: material_idx.map(Index::new),
        mode: Checked::Valid(Mode::Triangles),
        targets: None,
    })
}

/// Resolve `shader_index` → albedo texture → embed it as a glTF
/// Image+Texture+Material. Returns `Some(material_index)` on success,
/// `None` when any step fails (so the primitive ships material-less,
/// rendering as the default white in glTF viewers).
///
/// Caches Image entries by texture id so submeshes that share a
/// texture don't bloat the GLB with duplicate PNG bytes.
#[allow(clippy::too_many_arguments)]
fn build_material(
    bin: &mut Vec<u8>,
    views: &mut Vec<gltf_json::buffer::View>,
    images: &mut Vec<gltf_json::Image>,
    gltf_textures: &mut Vec<gltf_json::Texture>,
    materials: &mut Vec<gltf_json::Material>,
    image_idx_by_tex_id: &mut HashMap<u32, u32>,
    shader_tuids: &[u64],
    shaders: &HashMap<u64, ShaderInfo>,
    textures: &HashMap<u32, Vec<u8>>,
    shader_index: usize,
) -> Option<u32> {
    let &shader_tuid = shader_tuids.get(shader_index)?;
    let shader = shaders.get(&shader_tuid)?;
    let albedo_id = shader.albedo_tex_id?;
    let png_bytes = textures.get(&albedo_id)?;
    if png_bytes.is_empty() {
        return None;
    }

    let image_idx = match image_idx_by_tex_id.get(&albedo_id) {
        Some(&idx) => idx,
        None => {
            // Embed the PNG bytes in the binary chunk via a buffer view.
            let view = push_buffer_view(bin, views, png_bytes);
            images.push(gltf_json::Image {
                buffer_view: Some(Index::new(view)),
                mime_type: Some(gltf_json::image::MimeType("image/png".into())),
                name: Some(format!("tex_{albedo_id}")),
                uri: None,
                extensions: Default::default(),
                extras: Default::default(),
            });
            let img_idx = (images.len() - 1) as u32;
            // Texture record references the Image. No sampler set —
            // glTF defaults to LINEAR filtering, which is fine.
            gltf_textures.push(gltf_json::Texture {
                name: Some(format!("tex_{albedo_id}")),
                sampler: None,
                source: Index::new(img_idx),
                extensions: Default::default(),
                extras: Default::default(),
            });
            image_idx_by_tex_id.insert(albedo_id, img_idx);
            img_idx
        }
    };
    // Find or create a Texture record pointing at this image. Each
    // image gets its own Texture record (could share, but the size is
    // negligible).
    let texture_idx = (gltf_textures.len() - 1) as u32;

    let mut pbr = gltf_json::material::PbrMetallicRoughness {
        base_color_factor: gltf_json::material::PbrBaseColorFactor([1.0, 1.0, 1.0, 1.0]),
        base_color_texture: Some(gltf_json::texture::Info {
            index: Index::new(texture_idx),
            tex_coord: 0,
            extensions: Default::default(),
            extras: Default::default(),
        }),
        metallic_factor: gltf_json::material::StrengthFactor(0.0),
        roughness_factor: gltf_json::material::StrengthFactor(0.85),
        metallic_roughness_texture: None,
        extensions: Default::default(),
        extras: Default::default(),
    };
    // Suppress unused-mut warning when no roughness texture path runs.
    pbr.metallic_roughness_texture = pbr.metallic_roughness_texture.take();

    materials.push(gltf_json::Material {
        alpha_cutoff: None,
        alpha_mode: Checked::Valid(gltf_json::material::AlphaMode::Opaque),
        double_sided: false,
        name: Some(format!("mat_albedo_{albedo_id}")),
        pbr_metallic_roughness: pbr,
        normal_texture: None,
        occlusion_texture: None,
        emissive_texture: None,
        emissive_factor: gltf_json::material::EmissiveFactor([0.0, 0.0, 0.0]),
        extensions: Default::default(),
        extras: Default::default(),
    });
    let _ = image_idx; // kept for potential reuse logic
    Some((materials.len() - 1) as u32)
}

fn push_buffer_view(
    bin: &mut Vec<u8>,
    views: &mut Vec<gltf_json::buffer::View>,
    bytes: &[u8],
) -> u32 {
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let offset = bin.len() as u64;
    bin.extend_from_slice(bytes);
    views.push(buffer::View {
        buffer: Index::new(0),
        byte_length: USize64(bytes.len() as u64),
        byte_offset: Some(USize64(offset)),
        byte_stride: None,
        extensions: Default::default(),
        extras: Default::default(),
        name: None,
        target: None,
    });
    (views.len() - 1) as u32
}

fn positions_to_bytes(positions: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(positions.len() * 4);
    for v in positions {
        out.write_f32::<LittleEndian>(*v).expect("vec write");
    }
    out
}

fn uvs_to_bytes(uvs: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(uvs.len() * 4);
    for v in uvs {
        out.write_f32::<LittleEndian>(*v).expect("vec write");
    }
    out
}

fn indices_to_bytes(indices: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(indices.len() * 4);
    for v in indices {
        out.write_u32::<LittleEndian>(*v).expect("vec write");
    }
    out
}

/// Convert per-vertex `[u16; 4]` joint indices (which actually hold
/// u8-range values for R2 mobys) into a packed `[u8; 4]` per vertex.
/// Saturates at 0xFF — which is fine since real values fit.
fn joints_u8_bytes(indices: &[u16], vertex_count: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(vertex_count * 4);
    for i in 0..vertex_count {
        for k in 0..4 {
            let v = indices.get(i * 4 + k).copied().unwrap_or(0);
            out.push(v.min(255) as u8);
        }
    }
    out
}

fn position_bounds(positions: &[f32]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in positions.chunks_exact(3) {
        for (i, v) in chunk.iter().enumerate() {
            if *v < min[i] {
                min[i] = *v;
            }
            if *v > max[i] {
                max[i] = *v;
            }
        }
    }
    if !positions.is_empty() {
        (min, max)
    } else {
        ([0.0; 3], [0.0; 3])
    }
}

fn serialize_glb(root: &gltf_json::Root, bin: &[u8]) -> Result<Vec<u8>> {
    let json_string =
        serde_json::to_vec(root).map_err(|e| Error::GltfWrite(e.to_string()))?;
    let mut json_chunk = json_string;
    while json_chunk.len() % 4 != 0 {
        json_chunk.push(0x20);
    }

    let mut bin_chunk = bin.to_vec();
    while bin_chunk.len() % 4 != 0 {
        bin_chunk.push(0);
    }

    let total_len = 12 + 8 + json_chunk.len() + 8 + bin_chunk.len();
    let mut out = Vec::with_capacity(total_len);

    out.write_u32::<LittleEndian>(GLB_MAGIC)
        .map_err(|e| Error::GltfWrite(e.to_string()))?;
    out.write_u32::<LittleEndian>(GLB_VERSION)
        .map_err(|e| Error::GltfWrite(e.to_string()))?;
    out.write_u32::<LittleEndian>(total_len as u32)
        .map_err(|e| Error::GltfWrite(e.to_string()))?;

    out.write_u32::<LittleEndian>(json_chunk.len() as u32)
        .map_err(|e| Error::GltfWrite(e.to_string()))?;
    out.write_u32::<LittleEndian>(CHUNK_TYPE_JSON)
        .map_err(|e| Error::GltfWrite(e.to_string()))?;
    out.extend_from_slice(&json_chunk);

    out.write_u32::<LittleEndian>(bin_chunk.len() as u32)
        .map_err(|e| Error::GltfWrite(e.to_string()))?;
    out.write_u32::<LittleEndian>(CHUNK_TYPE_BIN)
        .map_err(|e| Error::GltfWrite(e.to_string()))?;
    out.extend_from_slice(&bin_chunk);

    Ok(out)
}

/// Emit one glTF Animation per clip. Channels target bone Nodes by
/// index. Skips bones beyond `bone_count` (face-only viseme clips
/// can drive bones the rig doesn't have). Static tracks (single
/// keyframe) use STEP interpolation; animated tracks use LINEAR.
fn emit_animations(
    bin: &mut Vec<u8>,
    accessors: &mut Vec<gltf_json::Accessor>,
    views: &mut Vec<gltf_json::buffer::View>,
    animations: &mut Vec<gltf_json::Animation>,
    clips: &[DecodedClip],
    bone_node_base: u32,
    bone_count: usize,
) {
    for clip in clips {
        let dt = if clip.frame_rate > 0.0 {
            1.0 / clip.frame_rate
        } else {
            1.0 / 30.0
        };

        // Two shared time accessors per clip: one for animated tracks
        // (`num_frames` keyframes at i*dt), one for static tracks
        // (single keyframe at t=0). Building once per clip avoids
        // per-bone duplication of the time array.
        let animated_time_acc = if clip.num_frames > 0 {
            let times: Vec<f32> = (0..clip.num_frames as usize)
                .map(|i| i as f32 * dt)
                .collect();
            Some(push_scalar_f32_accessor(bin, accessors, views, &times))
        } else {
            None
        };
        let static_time_acc = push_scalar_f32_accessor(bin, accessors, views, &[0.0_f32]);

        let mut channels: Vec<Channel> = Vec::new();
        let mut samplers: Vec<Sampler> = Vec::new();

        let bones_to_use = clip.bones.len().min(bone_count);
        for b in 0..bones_to_use {
            let bone = &clip.bones[b];
            let target_node = Index::new(bone_node_base + b as u32);

            // Rotation track (VEC4 quat).
            if !bone.rotations.is_empty() {
                let time_acc = if bone.rotation_animated {
                    animated_time_acc.unwrap_or(static_time_acc)
                } else {
                    static_time_acc
                };
                let val_acc =
                    push_vec4_f32_accessor(bin, accessors, views, &bone.rotations);
                let sampler_idx = samplers.len() as u32;
                samplers.push(Sampler {
                    extensions: Default::default(),
                    extras: Default::default(),
                    input: time_acc,
                    output: val_acc,
                    interpolation: Checked::Valid(
                        gltf_json::animation::Interpolation::Linear,
                    ),
                });
                channels.push(Channel {
                    extensions: Default::default(),
                    extras: Default::default(),
                    sampler: Index::new(sampler_idx),
                    target: Target {
                        extensions: Default::default(),
                        extras: Default::default(),
                        node: target_node,
                        path: Checked::Valid(Property::Rotation),
                    },
                });
            }

            // Translation track (VEC3).
            if !bone.translations.is_empty() {
                let time_acc = if bone.translation_animated {
                    animated_time_acc.unwrap_or(static_time_acc)
                } else {
                    static_time_acc
                };
                let val_acc =
                    push_vec3_f32_accessor(bin, accessors, views, &bone.translations);
                let sampler_idx = samplers.len() as u32;
                samplers.push(Sampler {
                    extensions: Default::default(),
                    extras: Default::default(),
                    input: time_acc,
                    output: val_acc,
                    interpolation: Checked::Valid(
                        gltf_json::animation::Interpolation::Linear,
                    ),
                });
                channels.push(Channel {
                    extensions: Default::default(),
                    extras: Default::default(),
                    sampler: Index::new(sampler_idx),
                    target: Target {
                        extensions: Default::default(),
                        extras: Default::default(),
                        node: target_node,
                        path: Checked::Valid(Property::Translation),
                    },
                });
            }

            // Scale track (VEC3).
            if !bone.scales.is_empty() {
                let time_acc = if bone.scale_animated {
                    animated_time_acc.unwrap_or(static_time_acc)
                } else {
                    static_time_acc
                };
                let val_acc =
                    push_vec3_f32_accessor(bin, accessors, views, &bone.scales);
                let sampler_idx = samplers.len() as u32;
                samplers.push(Sampler {
                    extensions: Default::default(),
                    extras: Default::default(),
                    input: time_acc,
                    output: val_acc,
                    interpolation: Checked::Valid(
                        gltf_json::animation::Interpolation::Linear,
                    ),
                });
                channels.push(Channel {
                    extensions: Default::default(),
                    extras: Default::default(),
                    sampler: Index::new(sampler_idx),
                    target: Target {
                        extensions: Default::default(),
                        extras: Default::default(),
                        node: target_node,
                        path: Checked::Valid(Property::Scale),
                    },
                });
            }
        }

        if !channels.is_empty() {
            animations.push(gltf_json::Animation {
                channels,
                extensions: Default::default(),
                extras: Default::default(),
                name: Some(clip.name.clone()),
                samplers,
            });
        }
    }
}

fn push_scalar_f32_accessor(
    bin: &mut Vec<u8>,
    accessors: &mut Vec<gltf_json::Accessor>,
    views: &mut Vec<gltf_json::buffer::View>,
    values: &[f32],
) -> Index<gltf_json::Accessor> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for v in values {
        bytes.write_f32::<LittleEndian>(*v).expect("vec write");
    }
    let view = push_buffer_view(bin, views, &bytes);
    let min = values.iter().cloned().fold(f32::INFINITY, f32::min);
    let max = values.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    accessors.push(gltf_json::Accessor {
        buffer_view: Some(Index::new(view)),
        byte_offset: Some(USize64(0)),
        count: USize64(values.len() as u64),
        component_type: Checked::Valid(GenericComponentType(ComponentType::F32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: Checked::Valid(AccessorType::Scalar),
        min: Some(serde_json::json!([min])),
        max: Some(serde_json::json!([max])),
        name: None,
        normalized: false,
        sparse: None,
    });
    Index::new((accessors.len() - 1) as u32)
}

fn push_vec3_f32_accessor(
    bin: &mut Vec<u8>,
    accessors: &mut Vec<gltf_json::Accessor>,
    views: &mut Vec<gltf_json::buffer::View>,
    values: &[f32],
) -> Index<gltf_json::Accessor> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for v in values {
        bytes.write_f32::<LittleEndian>(*v).expect("vec write");
    }
    let view = push_buffer_view(bin, views, &bytes);
    accessors.push(gltf_json::Accessor {
        buffer_view: Some(Index::new(view)),
        byte_offset: Some(USize64(0)),
        count: USize64((values.len() / 3) as u64),
        component_type: Checked::Valid(GenericComponentType(ComponentType::F32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: Checked::Valid(AccessorType::Vec3),
        min: None,
        max: None,
        name: None,
        normalized: false,
        sparse: None,
    });
    Index::new((accessors.len() - 1) as u32)
}

fn push_vec4_f32_accessor(
    bin: &mut Vec<u8>,
    accessors: &mut Vec<gltf_json::Accessor>,
    views: &mut Vec<gltf_json::buffer::View>,
    values: &[f32],
) -> Index<gltf_json::Accessor> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for v in values {
        bytes.write_f32::<LittleEndian>(*v).expect("vec write");
    }
    let view = push_buffer_view(bin, views, &bytes);
    accessors.push(gltf_json::Accessor {
        buffer_view: Some(Index::new(view)),
        byte_offset: Some(USize64(0)),
        count: USize64((values.len() / 4) as u64),
        component_type: Checked::Valid(GenericComponentType(ComponentType::F32)),
        extensions: Default::default(),
        extras: Default::default(),
        type_: Checked::Valid(AccessorType::Vec4),
        min: None,
        max: None,
        name: None,
        normalized: false,
        sparse: None,
    });
    Index::new((accessors.len() - 1) as u32)
}
