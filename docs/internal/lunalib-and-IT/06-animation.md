# 06 — Animation decode

Source: `crates/lunalib/src/animation.rs`.

## Per-engine landscape

| Layout | Where animations live | How they're addressed | Decoder entry point |
|---|---|---|---|
| V2 | `animsets.dat` (each animset = one IGHW file) | by animset hash + clip index | `decode_clips_for_moby` (cache.rs) |
| RFOM | inline inside `ps3levelmain.dat`, per-moby offset list | by absolute byte offset | `decode_clips_for_moby_inline("ps3levelmain.dat")` |
| TOD | inline inside `main.dat` | per-moby offset list, partial decoder | `decode_clips_for_moby_inline("main.dat")` — see "TOD pair-frame" below |

The header / control / per-frame track decoder below is shared between
V2 and RFOM. Only the *addressing* differs — RFOM mobys carry a list
of absolute offsets into `ps3levelmain.dat` instead of an animset
hash, so the inline path opens the per-engine `.dat` and seeks to
each offset before running the same decode logic.

## TOD pair-frame encoding (partial)

Neither IT (`Version::TOD` exists in the enum but has no decoder
module) nor ReLunacy (no animation code at all) supports TOD anims.
This project RE'd one of the two TOD encodings from raw bytes:

- **Simple anims** (`num_8bit_tracks == 0` AND `frame_stride ==
  min_data_size`): TOD stores keyframes as **(zero-filler,
  real-data) pairs** at half the apparent rate. To decode we offset
  `frames_ptr` by one stride, double the stride, halve `num_frames`
  and `frame_rate`, then run the standard IT-style decoder. Example:
  `animate_spin` (4 bones, 6 rotation tracks, 8001 disk frames → 4000
  real keyframes at 15 fps).
- **Complex anims** (`num_8bit_tracks > 0`): the per-frame i8 delta
  track encoding remains unsolved. Applying the IT-style decoder
  produces wildly distorted bones radiating from origin. Until this
  is cracked, all TOD anims with `n8 > 0` skip decode and the
  character renders the bind pose. Probe scaffold logs
  `[tod-anim] T-POSE moby_XXXX 'anim_name' n16=N n8=N ...`.

See memory `project_tod_anim_format` for the RE state and the byte
dumps that led to the pair-frame discovery.

## The animset → clips relationship (V2)

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

**RFOM viseme rigs** (soldier / cartwright / Winters head rigs — 14 of
them per typical level) ship with a raw `translationShift = 0x0103` that
doesn't fit either the raw or byte-swapped 0..15 range. The recovery
chain (in `skeleton.rs::recover_shift`) falls through to
`swapped & 0x1F`, which mirrors what IT's effective behaviour on x86
ends up being (the `SHR` instruction masks the count to 5 bits). For
the viseme rigs this yields shift = 1 → `pos_scale = 1/16384`, giving
sensible head-bone translation magnitudes. Without this mask the
animations decoded with `pos_scale = 1/32768` (3× too small) and the
viseme bones visibly collapsed to origin during playback. See chapter
[03 — Skeleton & bind matrices](03-skeleton.md#the-byte-order-quirk).

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

This command is V2-only — `list_animsets` returns an empty `Vec` for
RFOM and TOD because their animations aren't addressable by animset
hash. The burger menu still works on those games but only shows the
GLB's built-in clips (the ones baked at cache-build time), which are
the per-moby inline anims for RFOM and an empty list for TOD.

## RFOM additive-anim quirk

Per IT's `LoadAnimations`, additive animations (flag bit `0x02`) lie
about `num_bones` in their header. The decoder overrides
`header.num_bones` with the skeleton's bone count before walking
track masks; otherwise the masks get range-clipped and the clip
stays at rest pose. This convention is preserved through
`decode_animation_with_skeleton` (RFOM's IT-style decoder). See
`project_insomniac_additive_anim_numbones` in memory for the
incident detail.
