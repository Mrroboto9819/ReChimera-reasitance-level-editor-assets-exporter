//! RFOM skybox reader. Decodes two sections in `ps3levelmain.dat`:
//!
//! - **`0x9150` Sky-dome vertices** — N × 16-byte records. Each record is a
//!   `Vector4` (4 × f32 BE) holding the dome vertex in world-ish space
//!   (yards, dome-local). The `w` component is unused (usually 1.0).
//!
//! - **`0xDA00` Sky descriptor** — single 336-byte record. Layout we've
//!   confirmed via byte-dump:
//!
//!   ```text
//!   +0x00..+0x40  es::Matrix44 transform     — identity in the levels we've seen
//!   +0x40..+0x44  f32 ?                       — small float (~-0.01)
//!   +0x44..+0x48  f32 ?                       — ~2.0
//!   +0x48..+0x4C  f32 ?                       — ~0.24
//!   +0x4C..+0x50  f32 ?                       — ~2.88
//!   +0x50..+0x70  more bound-ish floats
//!   +0x70..+0x74  u32 count?                  — 0x000003C4 = 964
//!   +0x74..+0x78  u32 (texture pointer? UNVERIFIED — see read_skybox_rfom)
//!   +0x78..+0x90  more u32 offsets/sentinels
//!   +0x90..+0xD0  es::Matrix44 scale (diag 2.0 + translation row)
//!   +0xD0..+0xD8  u32 sentinels (0xFFFFF800, 0xFFFFFF00)
//!   +0xD8..+0x150 padding / unknown
//!   ```
//!
//!   **Known limitations:**
//!   1. The `+0x74 texture_offset` field is a guess — needs cross-check
//!      against where the actual skybox texture lives in `ps3leveltextures.dat`.
//!   2. Triangulation of the 806 dome vertices uses a 6-nearest-neighbor
//!      heuristic. It might miss triangles at the dome rim or produce a
//!      non-watertight mesh. IT has no triangulation reference for us to
//!      port — this is reverse-engineered.
//!   3. The dome's AABB is offset from world origin (~-3, 31, -5 in the
//!      probed level). Skybox rendering should follow the camera regardless,
//!      so this doesn't visually matter — but Godot/Blender importers might
//!      place the dome at a confusing location.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;

/// Section ID for sky-dome vertex array (RFOM only).
const SECT_SKY_VERTS: u32 = 0x9150;
/// Section ID for sky descriptor (RFOM only). Single 336-byte record.
const SECT_SKY_DESC: u32 = 0xDA00;
/// Each dome vertex is 4 × f32 BE = 16 bytes (xyz + ignored w).
const VERTEX_STRIDE: u64 = 16;

#[derive(Debug, Clone)]
pub struct SkyboxMesh {
    /// Dome vertices in yards (local sky space). Y is up; the dome is a
    /// hemisphere with base near Y=0.
    pub vertices: Vec<[f32; 3]>,
    /// Triangle indices (CCW winding facing outward from dome centroid).
    pub indices: Vec<u32>,
    /// Axis-aligned bounding box of the dome verts.
    pub aabb_min: [f32; 3],
    pub aabb_max: [f32; 3],
    /// **UNVERIFIED**: u32 at +0x74 of the sky descriptor. Believed to point
    /// to the skybox texture in `ps3leveltextures.dat`. Needs validation —
    /// see header doc comment.
    pub texture_offset: Option<u32>,
}

pub fn read_skybox_rfom(level_folder: &Path) -> Result<Option<SkyboxMesh>> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

    // --- Dome vertices (section 0x9150) ----------------------------------
    let verts_section = match ig.section(SECT_SKY_VERTS) {
        Some(s) => s,
        None => return Ok(None),
    };
    if (verts_section.length as u64) < VERTEX_STRIDE {
        return Ok(None);
    }

    let total_bytes = verts_section.length as u64;
    let vert_count = (total_bytes / VERTEX_STRIDE) as usize;
    let base = u64::from(verts_section.offset);

    if std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
        eprintln!(
            "[rfom-sky] reading {} dome vertices @ 0x9150",
            vert_count
        );
    }

    let mut vertices = Vec::with_capacity(vert_count);
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for i in 0..vert_count {
        // Vertex record (16 bytes per vert, BE f32):
        //   +0x00..+0x04  x
        //   +0x04..+0x08  y  (up)
        //   +0x08..+0x0C  z
        //   +0x0C..+0x10  w  (unused, usually 1.0)
        ig.stream.seek_to(base + (i as u64) * VERTEX_STRIDE)?;
        let x = ig.stream.read_f32()?;
        let y = ig.stream.read_f32()?;
        let z = ig.stream.read_f32()?;
        let _w = ig.stream.read_f32()?;
        // Skip NaN/inf vertices — file corruption guard, IT does the same.
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            continue;
        }
        for (i, v) in [x, y, z].iter().enumerate() {
            if *v < min[i] {
                min[i] = *v;
            }
            if *v > max[i] {
                max[i] = *v;
            }
        }
        vertices.push([x, y, z]);
    }
    if vertices.is_empty() {
        return Ok(None);
    }

    // --- Sky descriptor (section 0xDA00) ---------------------------------
    // Single 336-byte record. We only pull the suspected texture-offset
    // field at +0x74. Everything else (transform matrices, sentinel u32s,
    // bounds floats) is currently unused. If/when we identify what the
    // other fields mean (e.g. dome-radius hint, fog colour, atmosphere
    // tint), document the byte offset in the file header and add it here.
    //
    // Caveat: +0x74 holding a texture id is an educated guess based on the
    // raw byte dump (0x00646D00 looks pointer-ish). If skybox textures
    // come out wrong in the viewport / Godot, this is the first place to
    // look — see the `texture_offset` field in `SkyboxMesh`.
    let texture_offset = ig.section(SECT_SKY_DESC).and_then(|desc| {
        ig.stream.seek_to(u64::from(desc.offset) + 0x74).ok()?;
        ig.stream.read_u32().ok()
    });

    // --- Triangulate the dome --------------------------------------------
    // No IT reference for dome triangulation. We use a 6-nearest-neighbor
    // common-edge dedupe heuristic. See `triangulate_dome` for details.
    let indices = triangulate_dome(&vertices);
    if std::env::var("RECHIMERA_LOG_PROBES").is_ok() {
        eprintln!(
            "[rfom-sky] generated {} triangles ({} indices) — bbox=[{:.2}..{:.2}, {:.2}..{:.2}, {:.2}..{:.2}]",
            indices.len() / 3,
            indices.len(),
            min[0], max[0], min[1], max[1], min[2], max[2]
        );
    }

    Ok(Some(SkyboxMesh {
        vertices,
        indices,
        aabb_min: min,
        aabb_max: max,
        texture_offset,
    }))
}

/// Triangulate the sky dome from a sphere-projected vertex cloud.
///
/// **No IT reference exists for dome triangulation** — Insomniac's original
/// engine likely streams pre-computed indices from elsewhere on disk. We
/// reconstruct triangles heuristically:
///
/// 1. For each vertex, find its 6 nearest neighbors (typical sphere
///    triangulation has each vertex shared by ~6 triangles).
/// 2. For each pair (a, b) of a vertex's neighbors, check if a and b are
///    *also* neighbors of each other. If yes, (vertex, a, b) forms a triangle.
/// 3. Dedupe via a sorted-index hash set.
/// 4. Choose winding by comparing the face normal against the centroid-to-face
///    vector — flip if pointing inward.
///
/// **Known limitations:**
/// - Vertices near the dome rim may have fewer than 6 neighbors, causing
///   missing rim triangles.
/// - The centroid-facing winding test assumes the dome's center of mass is
///   inside the dome. For non-spherical dome shapes it can produce inverted
///   triangles.
/// - O(n²) neighbor search — 806 verts × 806 = 650k comparisons. Fine for
///   one dome, but if multi-domes ever appear, this will need a kd-tree.
fn triangulate_dome(verts: &[[f32; 3]]) -> Vec<u32> {
    let n = verts.len();
    if n < 3 {
        return Vec::new();
    }

    // Step 1: build adjacency list — each vertex's 6 closest neighbors.
    let mut neighbors: Vec<Vec<u32>> = vec![Vec::new(); n];
    let max_neighbors = 6usize;
    let mut buf: Vec<(f32, u32)> = Vec::with_capacity(n);
    for i in 0..n {
        buf.clear();
        // Squared distance to every other vertex.
        for j in 0..n {
            if i == j {
                continue;
            }
            let dx = verts[i][0] - verts[j][0];
            let dy = verts[i][1] - verts[j][1];
            let dz = verts[i][2] - verts[j][2];
            buf.push((dx * dx + dy * dy + dz * dz, j as u32));
        }
        buf.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for &(_, j) in buf.iter().take(max_neighbors) {
            neighbors[i].push(j);
        }
    }

    // Step 2-4: emit triangles where 3 verts are mutually adjacent.
    use std::collections::HashSet;
    let mut tri_set: HashSet<(u32, u32, u32)> = HashSet::new();
    let mut indices: Vec<u32> = Vec::new();

    for i in 0..n {
        let i_u = i as u32;
        let nb = &neighbors[i];
        for a in 0..nb.len() {
            for b in (a + 1)..nb.len() {
                let ja = nb[a];
                let jb = nb[b];
                // Triangle exists only if a–b is also an edge in the graph.
                if !neighbors[ja as usize].contains(&jb) {
                    continue;
                }
                let mut tri = [i_u, ja, jb];
                tri.sort();
                let key = (tri[0], tri[1], tri[2]);
                if tri_set.insert(key) {
                    // Winding test: face normal vs centroid-to-face direction.
                    // If they point opposite (dot < 0), swap b and c to flip.
                    let pa = verts[i];
                    let pb = verts[ja as usize];
                    let pc = verts[jb as usize];
                    // Edge vectors u = pb - pa, v = pc - pa.
                    let ux = pb[0] - pa[0];
                    let uy = pb[1] - pa[1];
                    let uz = pb[2] - pa[2];
                    let vx = pc[0] - pa[0];
                    let vy = pc[1] - pa[1];
                    let vz = pc[2] - pa[2];
                    // Cross product n = u × v.
                    let nx = uy * vz - uz * vy;
                    let ny = uz * vx - ux * vz;
                    let nz = ux * vy - uy * vx;
                    // Centroid of triangle.
                    let cx = (pa[0] + pb[0] + pc[0]) / 3.0;
                    let cy = (pa[1] + pb[1] + pc[1]) / 3.0;
                    let cz = (pa[2] + pb[2] + pc[2]) / 3.0;
                    if nx * cx + ny * cy + nz * cz < 0.0 {
                        // Normal points inward → flip winding to face outward.
                        indices.extend_from_slice(&[tri[0], tri[2], tri[1]]);
                    } else {
                        indices.extend_from_slice(&[tri[0], tri[1], tri[2]]);
                    }
                }
            }
        }
    }

    indices
}

pub fn write_skybox_obj(mesh: &SkyboxMesh) -> String {
    let mut out = String::with_capacity(mesh.vertices.len() * 32);
    out.push_str("# ReChimera RFOM skybox dome\n");
    out.push_str(&format!(
        "# {} vertices, {} triangles\n",
        mesh.vertices.len(),
        mesh.indices.len() / 3
    ));
    out.push_str("o sky_dome\n");
    for v in &mesh.vertices {
        out.push_str(&format!("v {:.6} {:.6} {:.6}\n", v[0], v[1], v[2]));
    }
    for tri in mesh.indices.chunks_exact(3) {
        out.push_str(&format!(
            "f {} {} {}\n",
            tri[0] + 1,
            tri[1] + 1,
            tri[2] + 1
        ));
    }
    out
}

pub fn write_skybox_ply(mesh: &SkyboxMesh) -> String {
    let mut out = String::with_capacity(mesh.vertices.len() * 24);
    out.push_str("ply\n");
    out.push_str("format ascii 1.0\n");
    out.push_str("comment ReChimera RFOM skybox\n");
    out.push_str(&format!("element vertex {}\n", mesh.vertices.len()));
    out.push_str("property float x\n");
    out.push_str("property float y\n");
    out.push_str("property float z\n");
    out.push_str(&format!("element face {}\n", mesh.indices.len() / 3));
    out.push_str("property list uchar int vertex_indices\n");
    out.push_str("end_header\n");
    for v in &mesh.vertices {
        out.push_str(&format!("{:.6} {:.6} {:.6}\n", v[0], v[1], v[2]));
    }
    for tri in mesh.indices.chunks_exact(3) {
        out.push_str(&format!("3 {} {} {}\n", tri[0], tri[1], tri[2]));
    }
    out
}

pub fn write_skybox_glb(mesh: &SkyboxMesh) -> Result<Vec<u8>> {
    use std::io::Write;

    let pos_bytes_len = mesh.vertices.len() * 12;
    let idx_bytes_len = mesh.indices.len() * 4;
    let bin_len = pos_bytes_len + idx_bytes_len;
    let bin_padded = (bin_len + 3) & !3;

    let json = format!(
        r#"{{"asset":{{"generator":"ReChimera","version":"2.0"}},"scene":0,"scenes":[{{"nodes":[0]}}],"nodes":[{{"mesh":0,"name":"sky_dome"}}],"meshes":[{{"name":"sky_dome","primitives":[{{"attributes":{{"POSITION":0}},"indices":1,"mode":4}}]}}],"buffers":[{{"byteLength":{bin_padded}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{pos_bytes_len},"target":34962}},{{"buffer":0,"byteOffset":{pos_bytes_len},"byteLength":{idx_bytes_len},"target":34963}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":{vc},"type":"VEC3","min":[{minx},{miny},{minz}],"max":[{maxx},{maxy},{maxz}]}},{{"bufferView":1,"componentType":5125,"count":{ic},"type":"SCALAR"}}]}}"#,
        vc = mesh.vertices.len(),
        ic = mesh.indices.len(),
        minx = mesh.aabb_min[0],
        miny = mesh.aabb_min[1],
        minz = mesh.aabb_min[2],
        maxx = mesh.aabb_max[0],
        maxy = mesh.aabb_max[1],
        maxz = mesh.aabb_max[2],
    );
    let json_bytes = json.into_bytes();
    let json_padded_len = (json_bytes.len() + 3) & !3;
    let json_pad = json_padded_len - json_bytes.len();

    let total_len = 12 + 8 + json_padded_len + 8 + bin_padded;
    let mut out = Vec::with_capacity(total_len);

    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total_len as u32).to_le_bytes());

    out.extend_from_slice(&(json_padded_len as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_bytes);
    for _ in 0..json_pad {
        out.push(b' ');
    }

    out.extend_from_slice(&(bin_padded as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    let mut bin = Vec::with_capacity(bin_padded);
    for v in &mesh.vertices {
        bin.write_all(&v[0].to_le_bytes()).ok();
        bin.write_all(&v[1].to_le_bytes()).ok();
        bin.write_all(&v[2].to_le_bytes()).ok();
    }
    for &i in &mesh.indices {
        bin.write_all(&i.to_le_bytes()).ok();
    }
    let bin_pad = bin_padded - bin_len;
    for _ in 0..bin_pad {
        bin.push(0);
    }
    out.extend_from_slice(&bin);

    Ok(out)
}
