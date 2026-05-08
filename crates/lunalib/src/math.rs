//! Tiny math helpers: Euler→quaternion conversion and 4×4 affine decomposition.
//!
//! Quaternions are stored as `[x, y, z, w]` (three.js / glTF convention).
//! Matrices are read from disk in `.NET Matrix4x4` row-major layout (standard
//! row-vector convention: M11..M44 in field order, translation at M41–M43).
//! Decompose returns components ready for column-vector consumers like three.js.

/// Convert a Lunacy `Vector3` rotation (ZYX intrinsic = XYZ extrinsic) to a
/// unit quaternion. Field components are interpreted as
/// `(angle_x, angle_y, angle_z)` regardless of application order.
///
/// The composite rotation is `R = Rx * Ry * Rz` applied as `v' = R * v`, which
/// matches `q = qx * qy * qz`.
pub fn zyx_euler_to_quat(angles: [f32; 3]) -> [f32; 4] {
    let (ax, ay, az) = (angles[0], angles[1], angles[2]);
    let (cx, sx) = ((ax * 0.5).cos(), (ax * 0.5).sin());
    let (cy, sy) = ((ay * 0.5).cos(), (ay * 0.5).sin());
    let (cz, sz) = ((az * 0.5).cos(), (az * 0.5).sin());

    [
        sx * cy * cz - cx * sy * sz, // x
        cx * sy * cz + sx * cy * sz, // y
        cx * cy * sz - sx * sy * cz, // z
        cx * cy * cz + sx * sy * sz, // w
    ]
}

/// Decompose a row-major 4×4 affine matrix into translation, per-axis scale,
/// and a quaternion. Input layout: `m[r*4 + c] = M(r+1)(c+1)` (.NET
/// `Matrix4x4` field order).
///
/// Returns `(translation, scale_xyz, quaternion_xyzw)` suitable for direct use
/// in a column-vector renderer (three.js / glTF).
pub fn decompose_row_major(m: &[f32; 16]) -> ([f32; 3], [f32; 3], [f32; 4]) {
    let translation = [m[12], m[13], m[14]];

    // Row vectors of the .NET matrix — these are the post-transform basis
    // vectors under row-vector multiplication.
    let rx = [m[0], m[1], m[2]];
    let ry = [m[4], m[5], m[6]];
    let rz = [m[8], m[9], m[10]];

    let sx = (rx[0] * rx[0] + rx[1] * rx[1] + rx[2] * rx[2]).sqrt();
    let sy = (ry[0] * ry[0] + ry[1] * ry[1] + ry[2] * ry[2]).sqrt();
    let sz = (rz[0] * rz[0] + rz[1] * rz[1] + rz[2] * rz[2]).sqrt();
    let scale = [sx, sy, sz];

    if sx == 0.0 || sy == 0.0 || sz == 0.0 {
        return (translation, scale, [0.0, 0.0, 0.0, 1.0]);
    }

    // Pure rotation matrix in *column-vector* convention: R = transpose of the
    // .NET upper-3×3 with rows normalized. r[row][col] addressing below.
    let r = [
        [rx[0] / sx, ry[0] / sy, rz[0] / sz],
        [rx[1] / sx, ry[1] / sy, rz[1] / sz],
        [rx[2] / sx, ry[2] / sy, rz[2] / sz],
    ];

    let trace = r[0][0] + r[1][1] + r[2][2];
    let quat = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        [
            (r[2][1] - r[1][2]) / s,
            (r[0][2] - r[2][0]) / s,
            (r[1][0] - r[0][1]) / s,
            0.25 * s,
        ]
    } else if r[0][0] > r[1][1] && r[0][0] > r[2][2] {
        let s = (1.0 + r[0][0] - r[1][1] - r[2][2]).sqrt() * 2.0;
        [
            0.25 * s,
            (r[0][1] + r[1][0]) / s,
            (r[0][2] + r[2][0]) / s,
            (r[2][1] - r[1][2]) / s,
        ]
    } else if r[1][1] > r[2][2] {
        let s = (1.0 + r[1][1] - r[0][0] - r[2][2]).sqrt() * 2.0;
        [
            (r[0][1] + r[1][0]) / s,
            0.25 * s,
            (r[1][2] + r[2][1]) / s,
            (r[0][2] - r[2][0]) / s,
        ]
    } else {
        let s = (1.0 + r[2][2] - r[0][0] - r[1][1]).sqrt() * 2.0;
        [
            (r[0][2] + r[2][0]) / s,
            (r[1][2] + r[2][1]) / s,
            0.25 * s,
            (r[1][0] - r[0][1]) / s,
        ]
    };

    (translation, scale, quat)
}

/// Multiply two 4×4 row-major matrices: `c = a * b`. Both inputs and
/// the output use the same `m[r*4 + c]` indexing as `decompose_row_major`.
pub fn mat4_mul_row_major(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut out = [0f32; 16];
    for r in 0..4 {
        for c in 0..4 {
            let mut sum = 0.0f32;
            for k in 0..4 {
                sum += a[r * 4 + k] * b[k * 4 + c];
            }
            out[r * 4 + c] = sum;
        }
    }
    out
}

pub fn transpose_4x4(m: &[f32; 16]) -> [f32; 16] {
    [
        m[0], m[4], m[8],  m[12],
        m[1], m[5], m[9],  m[13],
        m[2], m[6], m[10], m[14],
        m[3], m[7], m[11], m[15],
    ]
}

pub fn mat4_inverse_row_major(m: &[f32; 16]) -> Option<[f32; 16]> {
    let a = |r: usize, c: usize| m[r * 4 + c];
    let mut inv = [0f32; 16];

    inv[0] =
        a(1, 1) * a(2, 2) * a(3, 3) - a(1, 1) * a(2, 3) * a(3, 2)
            - a(2, 1) * a(1, 2) * a(3, 3) + a(2, 1) * a(1, 3) * a(3, 2)
            + a(3, 1) * a(1, 2) * a(2, 3) - a(3, 1) * a(1, 3) * a(2, 2);
    inv[1] =
        -a(0, 1) * a(2, 2) * a(3, 3) + a(0, 1) * a(2, 3) * a(3, 2)
            + a(2, 1) * a(0, 2) * a(3, 3) - a(2, 1) * a(0, 3) * a(3, 2)
            - a(3, 1) * a(0, 2) * a(2, 3) + a(3, 1) * a(0, 3) * a(2, 2);
    inv[2] =
        a(0, 1) * a(1, 2) * a(3, 3) - a(0, 1) * a(1, 3) * a(3, 2)
            - a(1, 1) * a(0, 2) * a(3, 3) + a(1, 1) * a(0, 3) * a(3, 2)
            + a(3, 1) * a(0, 2) * a(1, 3) - a(3, 1) * a(0, 3) * a(1, 2);
    inv[3] =
        -a(0, 1) * a(1, 2) * a(2, 3) + a(0, 1) * a(1, 3) * a(2, 2)
            + a(1, 1) * a(0, 2) * a(2, 3) - a(1, 1) * a(0, 3) * a(2, 2)
            - a(2, 1) * a(0, 2) * a(1, 3) + a(2, 1) * a(0, 3) * a(1, 2);

    inv[4] =
        -a(1, 0) * a(2, 2) * a(3, 3) + a(1, 0) * a(2, 3) * a(3, 2)
            + a(2, 0) * a(1, 2) * a(3, 3) - a(2, 0) * a(1, 3) * a(3, 2)
            - a(3, 0) * a(1, 2) * a(2, 3) + a(3, 0) * a(1, 3) * a(2, 2);
    inv[5] =
        a(0, 0) * a(2, 2) * a(3, 3) - a(0, 0) * a(2, 3) * a(3, 2)
            - a(2, 0) * a(0, 2) * a(3, 3) + a(2, 0) * a(0, 3) * a(3, 2)
            + a(3, 0) * a(0, 2) * a(2, 3) - a(3, 0) * a(0, 3) * a(2, 2);
    inv[6] =
        -a(0, 0) * a(1, 2) * a(3, 3) + a(0, 0) * a(1, 3) * a(3, 2)
            + a(1, 0) * a(0, 2) * a(3, 3) - a(1, 0) * a(0, 3) * a(3, 2)
            - a(3, 0) * a(0, 2) * a(1, 3) + a(3, 0) * a(0, 3) * a(1, 2);
    inv[7] =
        a(0, 0) * a(1, 2) * a(2, 3) - a(0, 0) * a(1, 3) * a(2, 2)
            - a(1, 0) * a(0, 2) * a(2, 3) + a(1, 0) * a(0, 3) * a(2, 2)
            + a(2, 0) * a(0, 2) * a(1, 3) - a(2, 0) * a(0, 3) * a(1, 2);

    inv[8] =
        a(1, 0) * a(2, 1) * a(3, 3) - a(1, 0) * a(2, 3) * a(3, 1)
            - a(2, 0) * a(1, 1) * a(3, 3) + a(2, 0) * a(1, 3) * a(3, 1)
            + a(3, 0) * a(1, 1) * a(2, 3) - a(3, 0) * a(1, 3) * a(2, 1);
    inv[9] =
        -a(0, 0) * a(2, 1) * a(3, 3) + a(0, 0) * a(2, 3) * a(3, 1)
            + a(2, 0) * a(0, 1) * a(3, 3) - a(2, 0) * a(0, 3) * a(3, 1)
            - a(3, 0) * a(0, 1) * a(2, 3) + a(3, 0) * a(0, 3) * a(2, 1);
    inv[10] =
        a(0, 0) * a(1, 1) * a(3, 3) - a(0, 0) * a(1, 3) * a(3, 1)
            - a(1, 0) * a(0, 1) * a(3, 3) + a(1, 0) * a(0, 3) * a(3, 1)
            + a(3, 0) * a(0, 1) * a(1, 3) - a(3, 0) * a(0, 3) * a(1, 1);
    inv[11] =
        -a(0, 0) * a(1, 1) * a(2, 3) + a(0, 0) * a(1, 3) * a(2, 1)
            + a(1, 0) * a(0, 1) * a(2, 3) - a(1, 0) * a(0, 3) * a(2, 1)
            - a(2, 0) * a(0, 1) * a(1, 3) + a(2, 0) * a(0, 3) * a(1, 1);

    inv[12] =
        -a(1, 0) * a(2, 1) * a(3, 2) + a(1, 0) * a(2, 2) * a(3, 1)
            + a(2, 0) * a(1, 1) * a(3, 2) - a(2, 0) * a(1, 2) * a(3, 1)
            - a(3, 0) * a(1, 1) * a(2, 2) + a(3, 0) * a(1, 2) * a(2, 1);
    inv[13] =
        a(0, 0) * a(2, 1) * a(3, 2) - a(0, 0) * a(2, 2) * a(3, 1)
            - a(2, 0) * a(0, 1) * a(3, 2) + a(2, 0) * a(0, 2) * a(3, 1)
            + a(3, 0) * a(0, 1) * a(2, 2) - a(3, 0) * a(0, 2) * a(2, 1);
    inv[14] =
        -a(0, 0) * a(1, 1) * a(3, 2) + a(0, 0) * a(1, 2) * a(3, 1)
            + a(1, 0) * a(0, 1) * a(3, 2) - a(1, 0) * a(0, 2) * a(3, 1)
            - a(3, 0) * a(0, 1) * a(1, 2) + a(3, 0) * a(0, 2) * a(1, 1);
    inv[15] =
        a(0, 0) * a(1, 1) * a(2, 2) - a(0, 0) * a(1, 2) * a(2, 1)
            - a(1, 0) * a(0, 1) * a(2, 2) + a(1, 0) * a(0, 2) * a(2, 1)
            + a(2, 0) * a(0, 1) * a(1, 2) - a(2, 0) * a(0, 2) * a(1, 1);

    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if det.abs() < 1e-12 {
        return None;
    }
    let inv_det = 1.0 / det;
    for v in inv.iter_mut() {
        *v *= inv_det;
    }
    Some(inv)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn mat4_identity_mul_returns_other() {
        #[rustfmt::skip]
        let id = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
        #[rustfmt::skip]
        let other = [
            2.0, 0.0, 0.0, 0.0,
            0.0, 3.0, 0.0, 0.0,
            0.0, 0.0, 4.0, 0.0,
            5.0, 6.0, 7.0, 1.0,
        ];
        let r = mat4_mul_row_major(&id, &other);
        assert_eq!(r, other);
        let r2 = mat4_mul_row_major(&other, &id);
        assert_eq!(r2, other);
    }

    #[test]
    fn transpose_swaps_translation_row_and_col() {
        // Row-major translation: r4 = (5, 6, 7, 1).
        #[rustfmt::skip]
        let row = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            5.0, 6.0, 7.0, 1.0,
        ];
        // After transpose, translation becomes the last column (indices 3, 7, 11).
        let col = transpose_4x4(&row);
        assert!(approx(col[3], 5.0));
        assert!(approx(col[7], 6.0));
        assert!(approx(col[11], 7.0));
    }

    #[test]
    fn identity_decomposes_to_unit_quat() {
        #[rustfmt::skip]
        let m = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
        let (t, s, q) = decompose_row_major(&m);
        assert_eq!(t, [0.0, 0.0, 0.0]);
        assert_eq!(s, [1.0, 1.0, 1.0]);
        assert!(approx(q[3].abs(), 1.0)); // w = ±1
    }

    #[test]
    fn translation_and_scale_recovered() {
        // .NET row-major: scale 2 on X, 3 on Y, 4 on Z, translate (5, 6, 7).
        #[rustfmt::skip]
        let m = [
            2.0, 0.0, 0.0, 0.0,
            0.0, 3.0, 0.0, 0.0,
            0.0, 0.0, 4.0, 0.0,
            5.0, 6.0, 7.0, 1.0,
        ];
        let (t, s, _) = decompose_row_major(&m);
        assert_eq!(t, [5.0, 6.0, 7.0]);
        assert_eq!(s, [2.0, 3.0, 4.0]);
    }

    #[test]
    fn zero_euler_gives_identity_quat() {
        let q = zyx_euler_to_quat([0.0, 0.0, 0.0]);
        assert!(approx(q[0], 0.0));
        assert!(approx(q[1], 0.0));
        assert!(approx(q[2], 0.0));
        assert!(approx(q[3], 1.0));
    }
}
