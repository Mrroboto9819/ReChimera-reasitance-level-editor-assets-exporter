# 09 — Debugging methodology for unknown bytes

The loop we run every time a new section / struct / format byte shows up
in a `.dat` and we don't yet know how to decode it. It applies equally to
**textures**, **mesh layouts**, **lights**, **env-samplers**, **skybox**,
**animations**, and anything else hidden behind an opaque IGHW section.

Skipping any step is allowed only when the previous time we did skip it
we got back to it within an hour. In practice we never have.

---

## The loop

### 1. Cross-reference the canonical source *first*

- **RFOM / V2 (Resistance / R&C Future)** → InsomniaToolset (C++) is
  authoritative. See `/insomnia-toolset` skill or
  `C:\Users\flast\Documents\mods\tools\InsomniaToolset-master\`.
- **TOD / V2 (R&C ToD specifically, and the high-level CPU asset graph)**
  → ReLunacy (C#). See `/relunacy` skill or
  `C:\Users\flast\Documents\mods\tools\ReLunacy\`.

Read the struct + its `FByteswapper<T>` specialization (IT) or its
serializer (ReLunacy). Write down field offsets, strides, and any
ranges/flags. **Never guess from the section ID alone.**

If neither reference has it (e.g. RFOM gameplay placements, TOD
animations), say so out loud and accept that the probe step is the only
source of truth.

### 2. Probe before decoding

Build a small probe — pattern is `crates/lunalib/src/rfom_probe.rs` — that
dumps the first N bytes of the suspect section in **multiple
interpretations side-by-side**: hex, `u32` BE, `f32` BE, sometimes `i16`
BE for animation frame data. The f32 column is what made env-sampler
matrix layout and skybox sphere geometry visually obvious.

The probe is read-only and lives behind a feature flag or an `if probe {…}`
guard, so leaving it in the tree between sessions is free.

### 3. `eprintln!("[tag] …")` diagnostics in the live decoder path

Not asserts. Not panics. Tag prefixes like `[rfom-anim]`,
`[rfom-anim-probe]`, `[skybox]`, `[envsampler]` so the user can grep
their logs. Include:
- The thing being decoded (`moby_{:04X}`, file offset),
- The count it expected vs. what it got (`{} offsets → {} clips`),
- The header bytes / first few struct fields,
- A `warn:` line for the unknown variant whenever the match falls
  through (this is how the dual-range tex format was caught — see
  `05-textures.md`).

Cheap, reversible, lives in the codebase as a permanent debug aid.

### 4. Re-extract and wait for logs

We **never** guess from the diff alone — we wait for the bytes. Ask the
user to re-run the cache extraction (or a focused export) and paste the
relevant `[tag]` lines. If re-extracting is slow (full level rebuild),
narrow the test to a single asset and dump raw frames to a file alongside
the probe (see §6 below).

### 5. Decide from observed data, not theory

Real-world ranges are the tell:

| Decoding | Sanity check |
|---|---|
| World-space positions | 200–600 m / 218–656 yd (RFOM levels). Match against ground-truth mobys/ties already placed in the scene. |
| Shift bytes (skeleton scale/translation) | 0–15. Anything > 15 → byte-swap issue (see `skeleton_shift_byte_quirk` memory). |
| Sphere / dome geometry | `radius² == x² + y² + z²` per vertex within ε. |
| Quaternion components | Each f32 in [-1, 1], 4-component sum-of-squares ≈ 1. |
| Bone count | Always ≤ rig's `numBones` from skeleton header; equal for non-additive clips, often differs for additive (see `insomniac_additive_anim_numbones` memory). |
| Texture format byte | Either `0x03..0x0A` (R2) or `0x81..0x8B` + `0xA6` (FFA) — both coexist; see `texture_format_dual_range` memory. |

If a candidate offset gives values outside the expected range for **any**
sample, the offset is wrong. Don't paper over with a clamp.

### 6. Save a raw capture when re-extract is slow

If iterating is expensive (e.g. TOD animations where each anim is a few
KB of opaque packed frame data and we need to compare patterns across
multiple clips), **save raw bytes to a memory doc** alongside the
hypothesis. The `project_tod_anim_format` memory is the template — it
holds the raw frame bytes for `clank_idle` so future sessions can reason
offline without making the user re-extract a 3 GB level.

### 7. Lock invariants once confirmed

When the decoder works:

1. **Memory file** — write `project_<format>.md` with the offsets,
   ranges, and any byte-swap quirks. Add an index line to `MEMORY.md`.
2. **Doc chapter** — update the relevant chapter in
   `docs/internal/lunalib-and-IT/`.
3. **Comment-override exception** — only when the invariant is critical
   AND non-obvious (e.g. dual-range format bytes, root-bone
   self-parent, skeleton shift-byte quirk, additive anim numBones).
   The default is still **no inline comments** (see
   `feedback_no_code_comments`) — the override is reserved for cases
   where missing the comment will silently corrupt output. List of
   current overrides lives in `feedback_comment_override_for_critical_invariants`.

---

## Anti-patterns

- **Guessing offsets from a hex dump without a reference.** Always at
  least one cross-check against IT or ReLunacy. If neither has it, do
  two independent samples (different moby, different level) and confirm
  the offset holds.
- **Asserts / panics in decoders.** A real PS3 file with an unhandled
  variant must produce a `warn:` line and an empty result, not a crash.
- **Silently clamping** values that look wrong. If shifts > 15 or
  positions look like (-0.2, 0, 0.3) instead of (293, 0, 558), the
  *layout* is wrong, not the data.
- **"Fix" without diagnostic.** If the user reports "X is broken" and
  we haven't seen an `[X]` log line in stderr, our first move is to add
  the log and re-extract — not to rewrite the decoder.
- **Letting the probe rot.** Keep the probe module compiling. When the
  format is locked in, leave a one-line `// see rfom_probe::dump_lights`
  -style breadcrumb only if the override-exception rule applies;
  otherwise just keep the probe code itself.

---

## Worked example: env-sampler position (the playbook in 10 lines)

1. IT has no V0.2 env-sampler reader → no canonical reference. Note that.
2. Probe dumps first 224 bytes of section `0x9700`, hex + f32 BE side-by-side.
3. First vector at +0x00 reads as (-0.22, 0, 0.30) — not a world coord.
4. Inspect f32 grid: rows 0..2 look like rotation columns
   (each row sum-of-squares ≈ 1), row 3 has values in the 200–600 range.
5. Hypothesis: rotation matrix at +0x00..+0x30, translation at +0x30.
6. Decode with new offsets; positions land where mobys/ties are.
7. Wire into `level_layout` Tauri command, render boxes in viewport,
   eyeball alignment against known map landmarks.
8. Done. Memory note + doc update if/when this becomes the third
   "matrix-then-row" placement struct (RFOM placements all follow this
   pattern — already documented under `rfom_format_layout`).

Total iteration cost: one re-extract + one diff. This is the target.
