use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::error::Result;
use crate::igfile::IgFile;

const SECT_SKY_VERTS: u32 = 0x9150;
const SECT_SKY_DESC: u32 = 0xDA00;
const VERTEX_STRIDE: u64 = 16;

#[derive(Debug, Clone)]
pub struct SkyboxMesh {
    pub vertices: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub aabb_min: [f32; 3],
    pub aabb_max: [f32; 3],
    pub texture_offset: Option<u32>,
}

pub fn read_skybox_rfom(level_folder: &Path) -> Result<Option<SkyboxMesh>> {
    let main_path = level_folder.join("ps3levelmain.dat");
    let mut ig = IgFile::open(BufReader::new(File::open(&main_path)?))?;

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

    eprintln!(
        "[rfom-sky] reading {} dome vertices @ 0x9150",
        vert_count
    );

    let mut vertices = Vec::with_capacity(vert_count);
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for i in 0..vert_count {
        ig.stream.seek_to(base + (i as u64) * VERTEX_STRIDE)?;
        let x = ig.stream.read_f32()?;
        let y = ig.stream.read_f32()?;
        let z = ig.stream.read_f32()?;
        let _w = ig.stream.read_f32()?;
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

    let texture_offset = ig.section(SECT_SKY_DESC).and_then(|desc| {
        ig.stream.seek_to(u64::from(desc.offset) + 0x74).ok()?;
        ig.stream.read_u32().ok()
    });

    let indices = triangulate_dome(&vertices);
    eprintln!(
        "[rfom-sky] generated {} triangles ({} indices) — bbox=[{:.2}..{:.2}, {:.2}..{:.2}, {:.2}..{:.2}]",
        indices.len() / 3,
        indices.len(),
        min[0], max[0], min[1], max[1], min[2], max[2]
    );

    Ok(Some(SkyboxMesh {
        vertices,
        indices,
        aabb_min: min,
        aabb_max: max,
        texture_offset,
    }))
}

fn triangulate_dome(verts: &[[f32; 3]]) -> Vec<u32> {
    let n = verts.len();
    if n < 3 {
        return Vec::new();
    }

    let mut neighbors: Vec<Vec<u32>> = vec![Vec::new(); n];
    let max_neighbors = 6usize;
    let mut buf: Vec<(f32, u32)> = Vec::with_capacity(n);
    for i in 0..n {
        buf.clear();
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
                if !neighbors[ja as usize].contains(&jb) {
                    continue;
                }
                let mut tri = [i_u, ja, jb];
                tri.sort();
                let key = (tri[0], tri[1], tri[2]);
                if tri_set.insert(key) {
                    let pa = verts[i];
                    let pb = verts[ja as usize];
                    let pc = verts[jb as usize];
                    let ux = pb[0] - pa[0];
                    let uy = pb[1] - pa[1];
                    let uz = pb[2] - pa[2];
                    let vx = pc[0] - pa[0];
                    let vy = pc[1] - pa[1];
                    let vz = pc[2] - pa[2];
                    let nx = uy * vz - uz * vy;
                    let ny = uz * vx - ux * vz;
                    let nz = ux * vy - uy * vx;
                    let cx = (pa[0] + pb[0] + pc[0]) / 3.0;
                    let cy = (pa[1] + pb[1] + pc[1]) / 3.0;
                    let cz = (pa[2] + pb[2] + pc[2]) / 3.0;
                    if nx * cx + ny * cy + nz * cz < 0.0 {
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
