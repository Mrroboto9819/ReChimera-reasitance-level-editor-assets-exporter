# 03 — Skeleton & bind matrices

Source: `crates/lunalib/src/skeleton.rs`.

## What a skeleton is

A `Skeleton` (section id `0xD300`) is:

```rust
pub struct Skeleton {
    pub root_bone: u16,
    pub bones: Vec<Bone>,                  // parent_index, flags, child, sibling
    pub bind_local: Vec<[f32; 16]>,        // per-bone local-bind, COL-MAJOR
    pub bind_world_inverse: Vec<[f32; 16]>, // per-bone IBM (= tms1 cleaned), COL-MAJOR
    pub tms0_col: Vec<[f32; 16]>,           // raw world-bind from disk, COL-MAJOR (cleaned)
    pub tms1_col: Vec<[f32; 16]>,           // raw inverse-world-bind from disk (cleaned)
    pub scale_shift: u16,                   // animation quantization knob
    pub translation_shift: u16,             // animation quantization knob
}
```

`tms0[i]` = bone `i`'s world-bind transform.
`tms1[i]` = bone `i`'s inverse-world-bind. In a clean rig, `tms1[i] = inverse(tms0[i])`.

## The col-major col-vector convention

PS3 stores rigid 4×4 transforms as **col-major col-vector** matrices:

- Translation is at flat indices `[12], [13], [14]`.
- The 3×3 rotation/scale block is at columns 0..2 (flat indices
  `[0,1,2]`, `[4,5,6]`, `[8,9,10]`).
- The bottom row `[3], [7], [11], [15]` should be `(0, 0, 0, 1)`.

This is **the same convention** glTF and Three.js use — so the bytes can
go straight to the GPU without transposition. The previous version of
this code transposed them, which double-flipped the rotations into their
inverses. We don't transpose any more.

## Insomniac root-bone convention

Critical: roots are marked `parent_index == own_index`, **not** `-1`.
A bone whose `parent_index` equals its own index is the root marker.

Treating this naively as a real parent reference (i.e. computing
`tms1[parent_i] * tms0[i]` when `parent_i == i`) injects the bone's
own inverse into its local bind and ends up with three.js's
`GLTFLoader` recursing forever and stack-overflowing. Every walker
in `skeleton.rs` checks `i == parent_index` and treats it as root.

The same convention is honored across V2, RFOM, and TOD because the
0xD300 skeleton struct is shared across engines (only the moby
header that points at it differs).

## Computing local-bind

For each non-root bone, the local-bind transform is:

```
bind_local[i] = tms1[parent_i] * tms0[i]    // col-vector convention
```

`tms1[parent]` cancels the parent's accumulated world-bind, leaving only
the child's offset relative to the parent.

The catch: our matrix multiply utility `mat4_mul_row_major(A_flat, B_flat)`
does flat-row-major math regardless of input convention. When fed
col-major bytes A and B, the bytes it returns — re-interpreted as col-major
— represent `B × A`. So to get `tms1[parent] × tms0[i]` we have to swap
operands at the call site:

```rust
// reads as col-major: tms1[parent] × tms0[i]   (i.e. local-bind)
let local_col = mat4_mul_row_major(&tms0_raw[child], &tms1_raw[parent]);
```

That single line is the heart of the bind chain. Get the order wrong and
the entire mesh goes inside-out.

## Cleaning the raw matrices

PS3 quantization leaves FP noise in the bottom row (`5.96e-8` instead of
`0`, `0.99999994` instead of `1`). The downstream consumers care:

- glTF validator flags any node `matrix` whose bottom row isn't exactly
  `(0,0,0,1)` as `NODE_MATRIX_NON_TRS`.
- Three.js `Matrix4.decompose` on a skewed matrix yields a TRS approximation,
  not the original — so accumulated bone chains drift.

`clean_rigid_col_major` zeros out the noise:

```rust
fn clean_rigid_col_major(mut m: [f32; 16]) -> [f32; 16] {
    for v in m.iter_mut() {
        if !v.is_finite() { *v = 0.0; }
    }
    m[3] = 0.0; m[7] = 0.0; m[11] = 0.0; m[15] = 1.0;
    m
}
```

This is applied to `bind_local`, `bind_world_inverse`, `tms0_col`, and
`tms1_col` at parse time. Both the GLB writer and the modal preview see
clean rigid matrices.

## Decomposing for glTF nodes

glTF spec: a Node may set **either** `matrix` **or** `translation/rotation/scale`,
never both. Animation channels can only target T/R/S, so we decompose at
export time (`gltf_export.rs::emit_skin`):

```rust
let (translation, scale, quat) = decompose_col_major(&clean(local));
nodes.push(Node { matrix: None, translation: Some(t), rotation: Some(q), scale: Some(s), ... });
```

`decompose_col_major` (in `math.rs`) extracts:
- T from `[12,13,14]`
- per-column scale lengths from the 3×3 block
- normalized rotation matrix → quaternion via Shepperd's method

This matches IT's `GenerateSkeleton` in `extract_gltf.cpp:7-32`.

## Quantization shifts

`scale_shift` and `translation_shift` aren't used at bind time; they are
fixed-point divisors used during animation decode (see
[`06-animation.md`](06-animation.md)).

### The byte-order quirk

IT's `FByteswapper<Skeleton>` deliberately **skips** `scaleShift` and
`translationShift` (see `common/src/serialize.cpp:186-201`). On PS3
big-endian files, our `read_u16()` over-swaps them. The recovery rule
in `skeleton.rs::recover_shift`:

1. If `raw <= 15` — already in the valid 0..15 range, use as-is.
2. Else try `raw.swap_bytes()` — works for 99% of rigs (`0x0400 → 0x0004 = 4`).
3. Else mask with `0x1F` (lowest 5 bits) — works for the **14 RFOM viseme
   head rigs** (soldier / cartwright / Winters etc.) where the raw value
   is `0x0103`. The swapped value `0x0301 = 769` and `769 & 0x1F = 1`.

Step 3 was discovered after step 2 left these heads animating with
`pos_scale = 1/32768` (30 000× too small), causing all viseme bones to
collapse to origin during clip playback. The `& 0x1F` mask matches the
x86 `SHR` instruction's count-masking behaviour — i.e., what IT's own
extracted-then-shifted value would compute to on the host CPU.

When `RECHIMERA_LOG_PROBES=1` is set, every viseme rig that took the
step-3 fallback logs a `[skel-shift]` line documenting the path.

The fix is also captured in the `project_skeleton_shift_byte_quirk`
memory entry for cross-session continuity.
