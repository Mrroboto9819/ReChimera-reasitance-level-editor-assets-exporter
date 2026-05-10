# 06 — Animation decode

Source: `crates/lunalib/src/animation.rs`.

## The animset → clips relationship

An **animset** is one IGHW file inside `animsets.dat`. It contains
**multiple animations** (clips) — usually all the clips for a particular
character role (idle, walk, attack, death, …).

Two ways the multiple clips are stored:
- One section `0xF000` per clip, repeated.
- One section `0xF000` with `count > 1` and `length = sizeof(AnimationHeader)`,
  i.e. an array of clip headers.

Our reader handles **both** via:

```rust
pub fn animation_section_offsets<R>(ig: &IgFile<R>) -> Vec<u64> {
    let mut out = Vec::new();
    for s in ig.sections.iter().filter(|s| s.id == SECT_ANIMATION) {
        let count = s.count.max(1);
        let stride = u64::from(s.length);
        for i in 0..count {
            out.push(u64::from(s.offset) + (i as u64) * stride);
        }
    }
    out
}
```

This was a real bug we shipped through one iteration: the previous
version returned only the section's base offset, missing all but the
first clip in array-style animsets. The user spotted it from the modal
preview only ever showing one animation. Walking each section's `count`
and `length` recovered every clip.

## What a clip stores

```rust
pub struct AnimationHeader {
    pub anim_index: u16,
    pub flags: u16,                    // looping / additive / packed-frames
    pub num_bones: u16,
    pub num_frames: u16,
    pub name: String,                  // e.g. "hyb_death_crouch_sighted_f"
    pub frame_rate: f32,
    pub linear_speed: f32,
    pub frame_stride: u16,
    pub num_reference_values: u16,
    pub num_16bit_tracks: u16,
    pub num_8bit_tracks: u16,
    pub control_ptr: u32,              // → AnimationControl block
    pub frames_ptr: u32,                // → per-frame i16/i8 tracks
}
```

## Quantization shifts

From `Skeleton`:

```rust
pub scale_shift: u16,
pub translation_shift: u16,
```

The decoded values are `i16` quantized; reconstructing floats uses IT's
formula (`gltf_shared.cpp:569`):

```rust
let pos_scale   = 1.0 / (0x8000u32 >> translation_shift) as f32;
let scale_scale = 1.0 / (0x8000u32 >> scale_shift)       as f32;
```

For typical R2 mobys these come out to small fractions like `1/32768` or
`1/16384`. The scaled values become metres-ish. The previous version of
this code used `2f32.powi(scale_shift)` which exploded to infinity when
the shifted value was ≥ 128, baking NaN into every animation track. The
gltf-validator caught it as `ACCESSOR_INVALID_FLOAT`.

We guard against shifts ≥ 15 to avoid `0x8000 >> 15 = 1` then divide-by-1
producing huge multipliers; in practice valid skeletons have small shifts.

## Decode flow

```rust
let header = read_animation_header_at(&mut ig, offset_for_clip)?;
let ctrl   = read_animation_control(&mut ig, &header)?;
let clip   = decode_animation(&mut ig, &header, &ctrl, pos_scale, scale_scale)?;
```

`AnimationControl` holds the **reference pose** (rotations, translations,
scales used as the "base" frame) plus the per-track masks indicating
which bone × component each track maps to. `decode_animation`:

1. For each frame, reads the 16-bit track values (rotations) and 8-bit
   track values (deltas off the 16-bit base).
2. Multiplies translations by `pos_scale`, scales by `scale_scale`.
3. Returns one `DecodedClip` containing per-bone arrays of rotations
   (4 floats per frame), translations (3), scales (3), plus
   `rotation_animated`/`translation_animated`/`scale_animated` flags so
   downstream code knows whether to emit a static-time keyframe or the
   full per-frame array.

## DecodedClip shape

```rust
pub struct DecodedClip {
    pub name: String,
    pub num_frames: u16,
    pub frame_rate: f32,
    pub looping: bool,
    pub bones: Vec<DecodedBone>,
}

pub struct DecodedBone {
    pub rotations: Vec<f32>,     // 4 per frame, or 4 once for static
    pub translations: Vec<f32>,  // 3 per frame, or 3 once for static
    pub scales: Vec<f32>,        // 3 per frame, or 3 once for static
    pub rotation_animated: bool,
    pub translation_animated: bool,
    pub scale_animated: bool,
}
```

## Per-moby decode in the cache

`decode_clips_for_moby(level_folder, animset_index, animsets_file, hash, pos_scale, scale_scale)`:

1. Look up `(offset, length)` in the animset index.
2. Read the slice into a `Vec<u8>`, open as IGHW.
3. Walk every animation offset, read header → control → decode.
4. Return `Vec<DecodedClip>`.

For one Hybrid character with 27-frame death animation, this yields one
clip with 143 bones × 27 frames of data. For a multi-clip animset
(typical for protagonists) the result is the full library.

## Decoding clips on demand for the modal

The export modal can pull clips from animsets that the original moby
isn't bound to. The `decode_animset_clip` Tauri command takes
`(folder, asset_tuid_hex, animset_hash, clip_index)` and returns one
`DecodedClipDto` (the same shape, JSON-friendly). The modal's burger
menu calls this when the user clicks ▶ on a clip from a different
animset. The result gets converted to `THREE.AnimationClip` via
`animClipBuilder.ts:buildAnimationClip` and bound to the loaded GLB's
skeleton via track names like `bone_42.quaternion`.
