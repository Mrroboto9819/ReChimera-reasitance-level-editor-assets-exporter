# Changes vs `origin/develop`

This release is `feature/cache-mdoels-and-optimize-flow-base-on-IT` →
`develop` merge. The previous RFOM-heavy round shipped foliage / shrubs
/ skybox / visemes; **this round is focused on Tools of Destruction**
plus cross-game cache modal + texture pipeline improvements.

**New lunalib modules** (parsers / writers)
- `crates/lunalib/src/foliage_rfom.rs` — RFOM Foliage (`0xC200` + `0x9700`) branch meshes + sprite quads
- `crates/lunalib/src/shrub_rfom.rs` — RFOM Shrub (`0xC700` + `0xC650`) mesh vegetation
- `crates/lunalib/src/skybox_rfom.rs` — RFOM sky dome (`0x9150` + `0xDA00`) + GLB/OBJ/PLY/JSON writers
- `crates/lunalib/src/detail_rfom.rs` — RFOM DetailCluster (`0xB200`/`0xB300`/`0x9500`) static debris
- `crates/lunalib/src/lighting_rfom.rs` *(superseded — see notes below)*
- `crates/lunalib/src/envsampler_rfom.rs` *(superseded — see notes below)*
- `crates/lunalib/src/level_glb.rs` — static level-scope GLB writer for the full-map exporter
- `crates/lunalib/src/rfom_probe.rs` — multi-interpretation byte-dump helpers (hex + f32 BE + u32 BE)

**Significantly extended**
- `crates/lunalib/src/skeleton.rs` — viseme-rig fix (`swap & 0x1F` mask for the 14 RFOM head rigs)
- `crates/lunalib/src/sound.rs` — bank + stream extraction polish, V1/V2 ID detection
- `crates/lunalib/src/animation.rs` — RFOM inline-anim decode path
- `crates/lunalib/src/gameplay_rfom.rs` — `GameplayInstances.other[6]` raw-byte probe
- `crates/lunalib/src/region_rfom.rs`, `tie_rfom.rs`, `tie_inst_rfom.rs` — UFrag/tie placement decode hardening
- `crates/lunalib/src/tie_old.rs` *(TOD)* — per-axis scale per-vertex; pre-walk meshes to compute `max_v_local_end` and slurp only what's needed (fixes the 61 failing ties)
- `crates/lunalib/src/moby_old.rs`, `tie_old.rs`, `moby_rfom.rs`, `tie_rfom.rs` — new `_with_total` variants firing `on_total` callback with section count upfront so cache modal shows real progress
- `crates/lunalib/src/zone_old.rs` *(TOD)* — extended from tie-instances-only to also read UFrag terrain at `0x6200` + identity shader table sized to `main.dat:0x5000`
- `apps/desktop/src-tauri/src/cache.rs` — pair-frame anim transform (when `stride==min_data && n8==0`), 3-phase texture write (materials → normalmaps → textures), `[tod-anim]` + `[tod-trans-probe]` diagnostic probes, `[anim-bytes]` byte-dump probe gated on `RECHIMERA_LOG_PROBES`

**App / UI**
- `apps/desktop/src-tauri/src/cache.rs` (+855 lines) — full-map export, multi-moby debug filter, foliage/shrub/sky/gameplay cache writers
- `apps/desktop/src-tauri/src/main.rs` (+521 lines) — 7 Tauri sound commands, foliage/shrub instance routing
- `apps/desktop/src/components/CacheLibraryModal.tsx` (+1738 lines) — Sound tab playlist + SFX/Dialog/Music sub-tabs
- `apps/desktop/src/components/OpenLevelModal.tsx` — wizard franchise tab strip (Resistance / R&C)
- `apps/desktop/src/views/Viewport.tsx`, `Hierarchy.tsx`, `Settings`, store — shrub / foliage / detail kinds wired through

**Docs**
- `docs/internal/lunalib-and-IT/09-debugging-methodology.md` — codified "probe → log → re-extract → range-check → lock" loop
- `docs/internal/lunalib-and-IT/10-vegetation-and-sky.md` — RFOM shrub/foliage/skybox layouts
- Inline byte-offset comments in every new module — IT struct references + every `+0xNN field` documented
- Cache + frontend + export-pipeline chapters updated with new kinds, phases, and the franchise tab

**Mislabel fix worth knowing about**

Sections `0xC200` and `0x9700` were previously routed through
`lighting_rfom.rs` and `envsampler_rfom.rs` (producing bogus instances
at world origin). An IT lookup found their real definitions in
`foliage.hpp:42-72` — they're `Foliage` and `FoliageInstance`. The
mislabeled readers still exist as files but are no longer called from
`level_layout`. Cleanup pass pending.

---

# What's new

## R&C: Tools of Destruction pipeline

- **All 142 ties extract** (was failing at indices 81-141 due to an over-allocated `vbuf_size` header field that overruns `vertices.dat:0x9000`). Fixed by pre-walking each tie's per-mesh structs to compute the actual `max_v_local_end`, then slurping only that — same pattern `moby_old.rs` already uses for mobys.
- **Per-axis tie scale applied per-vertex.** Was using raw `i16` positions producing 30 km buildings. Now multiplies `x/y/z` by `scale[0..2]` at decode time, matching ReLunacy `Tie.cs:93-95` and the V2 `tie.rs:220-222` path.
- **Zone reader ported** — TOD's single-zone-per-level "art zone" loads cleanly. 5684 tie instances + 5410 ufrag terrain pieces on `stratus city`. Tie instance section `0x9240` (matrix → TRS decompose). UFrag terrain section `0x6200` (`OldUFrag` 0x80 struct, `indexOffset` is a u16 COUNT not bytes per ReLunacy `Zone.cs:286`). Vertex stride 0x18 `OldUFragVertex`. Identity shader table for ufrags per `Zone.cs:308` — TOD ufrags look up shaders directly in the global `main.dat:0x5000` DB.
- **Pair-frame animation encoding RE'd** for simple anims. TOD stores `animate_spin` and a handful of door/spin/fill anims as `(zero-filler, real-keyframe)` pairs at half the apparent rate. Detection signal: `frame_stride == min_data_size AND num_8bit_tracks == 0`. When matched, we offset `frames_ptr` by one stride, double the stride, halve `num_frames` and `frame_rate`, then decode with the standard IT-style path.
- **Complex animations T-pose** (n8>0). Roughly 95% of TOD's character anims use a per-frame i8 delta-track encoding we haven't RE'd yet — applying the IT decoder produces visible distortion. To avoid shipping broken motion, every TOD anim with `n8>0` skips decode and renders the bind pose. Probe scaffold logs `[tod-anim] T-POSE moby_XXXX 'anim_name' ...`.

## World content (RFOM, from prior round, still shipping)

- **Foliage extraction.** RFOM levels now surface both vegetation systems — `Shrub` (mesh-based bushes and trees) and `Foliage` (branch meshes + sprite quads for grass/leaves). Auto-toggle in the viewport via the **Shrubs** and **Foliage** buttons. Both are included in full-map GLB exports.
- **Details clusters.** Small static debris and props (RFOM-specific) are now surfaced as their own asset type in the hierarchy with a configurable color in Settings → Colors. They render in the viewport and ship in level GLBs.
- **Skybox.** Dome geometry is decoded and emitted as a GLB on extraction; the texture (when found) renders as a viewport background. Future investigation needed on the descriptor's texture-ID offset, but for most levels the sky shows up correctly.
- **Full-map GLB export upgraded.** Exports now include mobys, ties, details, shrubs, foliage, terrain (UFrags), and the skybox dome in one file — drag the result straight into Godot, Blender, or Unreal.

## Animations

- **Viseme head rigs.** The 14 head rigs in RFOM (soldier, cartwright, Winters, ...) that previously animated frozen or radiated bones from a single point now play their `*_visemes`, `*_expressions`, and `*_blink` clips correctly. Fix: byte-swap-plus-5-bit-mask on the skeleton's translation/scale shift fields (matches what IT's effective behaviour ends up being on x86).
- **Skinning works in Godot.** The full weapon suite (carbine, magnum, auger, bullseye, sawgun, shotgun, sniper, sharpshooter, medicator, minigun, rocket / grenade launchers, uranium cannon) drives the mesh end-to-end through `AnimationPlayer`. Soldier walk / idle / fire / reload / get-hit clips bind cleanly.

## Sound

- **Sound tab now categorised.** SFX / Dialog / Music sub-tabs above the playlist, with counts per category. Classification by source filename — works for RFOM and the V2 games (R2 / R3 / RCF / A4O). Click the sub-tab to filter, search across the filtered set, batch-export only what you need.
- **Dialogue / music stream extraction.** Both bank sounds (SCREAM banks → WAV) and stream sounds (VPK / VAGp / XVAG → WAV) are decoded across all supported games. Cached as WAVs so playback in the modal is instant on second open.

## Cache pipeline / UX

- **Texture cache split into 3 phases.** Materials (albedo) → Normal maps → Textures (other). Each unique PNG is written exactly once, deduped via a `written` set. The cache-build modal shows three meaningful progress bars instead of one monolithic one. Works for V2 / RFOM / TOD uniformly. Backend event `CacheEvent::Phase { phase: "materials" | "normalmaps" | "textures", total: N }`.
- **Real mobys / ties progress counts.** Cache modal no longer shows `123/1` placeholder during the mobys/ties phases. Added `_with_total` variants of every streaming reader (TOD + RFOM moby/tie) that fire an `on_total` callback with the section count upfront so the progress bar fills from real values.
- **Toolbar info expanded.** Status line shows `N mobys · N ties · N terrain · N materials · N textures · N anims`. Materials count is the number of distinct `(albedo, normal, emissive)` shader triples (matches what `Viewport.tsx::getMaterial` keys by). Anims count sums `embedded_animation_count` across all moby assets.
- **Collision viewport toggle removed.** The "Collision (wireframe)" button never had a backend reader and rendered an empty group. Pulled from both the View menu and the floating toolbar across all games until a real `collision.dat` decoder lands.
- **`RECHIMERA_SKIP_TEXTURES` env var fixed.** Was treating any value as "skip" (including `0`). Now correctly off for `0`, `false`, `no`, or empty — on for any other value. Useful for fast anim/decode iteration without re-encoding 1500 PNGs each run.

## Wizard / UX

- **Franchise tab strip** at the top of the game picker — switch between Resistance and Ratchet & Clank with a single click instead of scrolling stacked sections. Your last choice is remembered.
- **Cleaner default output.** Per-record byte dumps and probe scaffolding now stay quiet unless you opt in with `RECHIMERA_LOG_PROBES=1`. Default extraction output is ~10 summary lines plus any `warn:` lines for real problems.
- **Multi-moby debug filter.** Set `RECHIMERA_DEBUG_MOBY=0212,00CD,0326` to extract only those mobys — skips ties / details / ufrags / sky entirely. Useful for tight iteration when investigating a specific asset; ~seconds per re-extract vs minutes for a full level.

## Documentation

- **Byte-level annotations** in every parser module (`skybox_rfom`, `shrub_rfom`, `foliage_rfom`, `gameplay_rfom`, ...). Each struct field's offset, type, and meaning is documented inline with hex offsets — so the next person porting from IT or reverse-engineering on top of this can audit the bytes without re-reading the C++ source.
- **Methodology doc + skill.** The "probe → log → re-extract → range-check → lock" loop we've been running is codified in `docs/internal/lunalib-and-IT/09-debugging-methodology.md` and mirrored into the `/insomnia-toolset` and `/relunacy` skills for future contributors.

# Per-game changes this release

## Resistance: Fall of Man (the heaviest update this round)

- **Foliage extraction.** Both `Shrub` (mesh-based bushes/trees) and `Foliage` (branch meshes + sprite quads for grass/leaves) now extract, render in the viewport behind their own toggles, and ship in full-map GLBs.
- **Details clusters** surface as a dedicated asset type — small static debris and props get their own hierarchy entry and a configurable Settings color.
-  **Skybox** — dome geometry decoded and emitted as a GLB; the texture (when found) renders as the viewport background. Cleaner than the previous "no sky" state.
- **Viseme rigs fixed** — the 14 head rigs (soldier, cartwright, Winters, ...) that previously animated frozen or radiated bones from one point now play their `*_visemes`, `*_expressions`, `*_blink` clips correctly. Root cause was a u16 byte-order quirk on `Skeleton.translationShift`; fix is documented in `project_skeleton_shift_byte_quirk` memory.
- **Gameplay placements** — `ps3gameplay.dat` is parsed and 184-ish moby placements feed the viewport / Godot. Probing scaffold added for the 6 unidentified sub-arrays (triggers / volumes / spawns) — set `RECHIMERA_LOG_PROBES=1` to dump them and help reverse-engineer.
- **Full-map GLB export** — now bakes everything (mobys, ties, details, shrubs, foliage, terrain, sky) into a single drag-into-Godot file.

## Resistance 2 / Resistance 3 / R&C: Full Frontal Assault / R&C: All 4 One

- **Sound tab categorised** — SFX / Dialog / Music sub-tabs with counts. Source-filename classifier works the same across all V2 games.
-  **Wizard franchise tabs** — top-of-step-1 tab strip groups Resistance vs Ratchet & Clank with persisted state.
- **Materials / Normalmaps / Textures phase split** in the cache build modal. Texture extraction is split into three sequential passes (albedos → normals → other) so the progress UI shows three meaningful bars instead of one monolithic one. Each unique PNG is written exactly once, deduped via a `written` set. Works uniformly for V2 / RFOM / TOD.
- **Real mobys / ties progress counts.** Cache build modal no longer shows `123/1` placeholder during the mobys/ties phases — added `_with_total` variants of every streaming reader (TOD + RFOM moby/tie) that emit the section count upfront so the bar fills from real values.
- **Toolbar info expanded.** Status line now shows `N mobys · N ties · N terrain · N materials · N textures · N anims` — added distinct `(albedo, normal, emissive)` shader-triple count and total embedded animation clip count.
-  **`RECHIMERA_SKIP_TEXTURES` env var fixed.** Was treating any value as on (including `0`). Now correctly off for `0`, `false`, `no`, or empty — on for any other value. Useful for fast anim/decode iteration without re-encoding 1500 PNGs each run.
-  **Internal methodology consolidated** — same parser robustness improvements benefit the V2 path; nothing game-specific to flag.

## R&C: Tools of Destruction (the main focus this round)

-  **Tie pipeline fixed end-to-end.** All 142 ties extract cleanly. Previously the last 61 (indices 81–141) failed with `io: failed to fill whole buffer` because the on-disk `vbuf_size` header field is wildly over-allocated (for many ties it claims 8–20 MB of vertex data when the actual per-tie data is ~100 KB). The fix walks the per-mesh structs first to compute the real `max_v_local_end`, then slurps only that much — same pattern `moby_old.rs` already uses for mobys. Also added per-vertex `* scale.{x,y,z}` multiplication that was missing (positions used to come out at i16 raw scale = 30 km tall buildings; ReLunacy `Tie.cs:93-95` applies the per-axis scale at decode time, we now do the same).
-  **Zone reader ported.** TOD's single-zone-per-level art zone now loads — `5684 tie instances + 3613 ufrag terrain pieces` on stratus city. Ported from ReLunacy `Zone.cs::CZone(isOld)`. Tie instance section `0x9240` (matrix-row-major transform → decomposed TRS, tie key as `main.dat` byte offset). UFrag terrain at `0x6200` (`OldUFrag` 0x80 record per ReLunacy `Zone.cs:77-111`; `indexOffset` is a u16 COUNT not bytes per `Zone.cs:286`, we multiply by 2 when seeking). Vertices stride 0x18 `OldUFragVertex`. Identity shader table for ufrags per `Zone.cs:308` — TOD ufrags lookup shaders directly in the global `main.dat:0x5000` DB.
- **Animation pair-frame encoding RE'd (partial).** Simple TOD anims (`animate_spin`, doors, fills, `kerchuu_roller_roll`) store keyframes as `(zero-filler, real-data)` pairs at half the apparent rate — even-index frames are zero padding, real keyframes at odd indices. Signal: `frame_stride == min_data_size AND num_8bit_tracks == 0`. When those conditions match, we offset `frames_ptr` by one stride, double the stride, halve `num_frames` and `frame_rate`, then run the standard IT-style decoder.
- **Complex animations (n8>0) ship as T-pose.** ~95% of TOD's character anims (wasp, beetle, pterodactyl, ratchet, all idles/walks/attacks) use a per-frame i8 delta-track encoding we haven't RE'd yet. Applying the IT-style decoder produces visible distortion (bones radiating from origin, mesh stretched into wing/blade shapes). Rather than ship a mix of working + broken motion, **every TOD anim now skips decode and renders bind pose**. Probe scaffold at `[tod-anim] T-POSE moby_XXXX ...` shows which anims are affected.
-  **Texture loading restored to async streaming.** Fixed a regression where awaiting all 1422 textures before mounting meshes made level open feel slow. Reverted to fire-and-forget: meshes appear instantly, textures stream in over a couple seconds while three.js's material cache picks up late-arriving texture references via `m.map = tex; m.needsUpdate = true`. The race we originally awaited for is now handled at the material-cache layer.
- **Collision viewport toggle removed.** The "Collision (wireframe)" button never had a backend reader and only rendered an empty group — pulled from the View menu and the floating toolbar across all games until a real `collision.dat` decoder lands.

# Coming next

- **TOD complex animations (n8>0).** Pair-frame encoding for simple anims is RE'd this round — `animate_spin` and a handful of door/spin/fill anims play correctly. The i8-delta encoding used by ~95% of TOD content (every character idle, attack, walk) remains unsolved. Next probe target: byte-level audit of the i8 region for a known-correct anim like `beetle_idle` to crack the encoding. Probe scaffold lives in `cache.rs::probe_anim_bytes` + `[tod-trans-probe]`.
- **TOD `collision.dat`.** Separate file in every TOD level folder — not opened anywhere yet. Format unknown to us, no IT/ReLunacy reference. Adding a parser would unlock Godot/Unity import with real collision volumes rather than mesh-derived approximations.
- **TOD lighting data.** TOD definitely has dynamic lighting in-game; the section IDs that hold light placements aren't identified. RFOM has its own (different) lighting sections and ReLunacy doesn't cover this for TOD.
- **TOD skybox.** No working reference exists — IT has no TOD decoder, and every ReLunacy branch we audited (`master`, `dev`, `bliss`, `bliss-old-loader`) lacks one (only an unused stub in `dev`). TOD levels currently render with no sky. Would need raw-byte probing of `main.dat` for the dome / texture descriptor sections; no candidate section IDs identified yet.
- **RFOM lights and gameplay sub-arrays.** If anyone wants to help, see "Help wanted" — both are reverse-engineering tasks gated on raw byte probes from real levels.

# Game support

| Game | Status |
| --- | --- |
| Resistance 2 | stable end-to-end |
| Resistance 3 | stable end-to-end |
| Resistance: Fall of Man | full pipeline + foliage + skybox + visemes + sound (extract `game.psarc` first) |
| R&C: All 4 One | all features working |
| R&C: Full Frontal Assault | working — a few textures still missing |
| R&C: Tools of Destruction | meshes / textures / skeletons / ties / terrain / tie placements all load. Animations export T-pose (pair-frame encoding RE'd for simple anims, complex i8-delta encoding unsolved — see Coming next). No skybox (no IT/ReLunacy reference exists). |

# Known limitations

- **Light placements (RFOM)** — no light section identified yet. The previously-rendered "lights" at world origin were a mislabel (the section turned out to be `Foliage`); we've removed the bogus render. Real lights await a future probe pass.
- **Trigger / volume / spawn placements** — IT doesn't decode RFOM's `GameplayInstances.other[6]` arrays, so they remain opaque. Set `RECHIMERA_LOG_PROBES=1` and re-extract to dump the raw bytes if you want to help reverse-engineer them.
- **Collision geometry** — no IT reference exists for RFOM collision, and TOD's `collision.dat` isn't parsed yet either. Godot users can auto-generate collision from the GLB mesh geometry on import as a workaround. The viewport "Collision" toggle was removed this round since it had no backend.
- **TOD complex animations** — i8 delta-track encoding (n8>0) remains unsolved; ~95% of TOD anims export as T-pose. Simple anims (n8=0, pair-frame encoded) play correctly. See Coming next.
- **TOD skybox** — not extracted. No reference in any audited ReLunacy branch (`master` / `dev` / `bliss` / `bliss-old-loader`) and no IT support. TOD levels render without a sky background; the cache produces no `skybox/` folder.

# Install

Pick the bundle below for your OS. Windows users with the previous build installed will see an **Update** button in the title bar — click it to install in place. macOS / Linux still need a manual reinstall from this page.

# Help wanted

- **Testers per game.** Even just running the tool on a level you own and confirming it works is genuinely helpful. If something breaks (placements off, textures missing, foliage in the wrong spot, animations not driving the mesh, exports failing) let me know which game + which level so I can reproduce. Logs from the bottom panel are gold — especially anything starting with `warn:`.
- **Real lights / triggers data.** If you're comfortable poking at hex, set `RECHIMERA_LOG_PROBES=1` and re-extract a level — share the `[rfom-gp-other]` slot dumps so we can pattern-match the unidentified gameplay sub-arrays.
- **GIFs / screenshots / Godot integration examples.** Visual examples for the README and releases page. Short clips of a MAP loading, an asset preview, or an export-to-Blender / -Godot flow on any of the games are very welcome — I'll credit you and use them in the docs.

# Bugs / requests

Open a GitHub issue if you can reproduce something, otherwise feel free to DM. I'll answer in my free time.

# Acknowledgements

- [@NefariousTechSupport](https://github.com/NefariousTechSupport) — original Lunacy and the [7thigRewrite](https://github.com/NefariousTechSupport/7thigRewrite) architecture this project draws from.
- [@VELD-Dev](https://github.com/VELD-Dev) — [ReLunacy / LibLunacy](https://github.com/VELD-Dev/ReLunacy) (the C# predecessor that the moby / tie / texture decode paths port from).
- [@PredatorCZ](https://github.com/PredatorCZ) — [InsomniaToolset / Spike](https://github.com/PredatorCZ/InsomniaToolset) (canonical reference for IGHW container, RFOM `levelmain` extract, foliage / shrub / animation decode, and the V2 GLTF emit pipeline).

Thanks to anyone willing to use, test, or try the tool — every game / level you run through it helps validate the parsers work outside my own small sample.
