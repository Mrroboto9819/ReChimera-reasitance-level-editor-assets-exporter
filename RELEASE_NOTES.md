# Changes vs `origin/develop`

This release is `feature/cache-mdoels-and-optimize-flow-base-on-IT` →
`develop` merge. **7 commits, ~8.5k insertions across 39 files.**
Source-of-truth delta (`git diff origin/develop..HEAD --stat`):

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

## World content

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

## Wizard / UX

- **Franchise tab strip** at the top of the game picker — switch between Resistance and Ratchet & Clank with a single click instead of scrolling stacked sections. Your last choice is remembered.
- **Cleaner default output.** Per-record byte dumps and probe scaffolding now stay quiet unless you opt in with `RECHIMERA_LOG_PROBES=1`. Default extraction output is ~10 summary lines plus any `warn:` lines for real problems.
- **Multi-moby debug filter.** Set `RECHIMERA_DEBUG_MOBY=0212,00CD,0326` to extract only those mobys — skips ties / details / ufrags / sky entirely. Useful for tight iteration when investigating a specific asset; ~seconds per re-extract vs minutes for a full level.

## Documentation

- **Byte-level annotations** in every parser module (`skybox_rfom`, `shrub_rfom`, `foliage_rfom`, `gameplay_rfom`, ...). Each struct field's offset, type, and meaning is documented inline with hex offsets — so the next person porting from IT or reverse-engineering on top of this can audit the bytes without re-reading the C++ source.
- **Methodology doc + skill.** The "probe → log → re-extract → range-check → lock" loop we've been running is codified in `docs/internal/lunalib-and-IT/09-debugging-methodology.md` and mirrored into the `/insomnia-toolset` and `/relunacy` skills for future contributors.

# Per-game changes this release

## Resistance: Fall of Man (the heaviest update this round)

- 🌳 **Foliage extraction.** Both `Shrub` (mesh-based bushes/trees) and `Foliage` (branch meshes + sprite quads for grass/leaves) now extract, render in the viewport behind their own toggles, and ship in full-map GLBs.
- 🪵 **Details clusters** surface as a dedicated asset type — small static debris and props get their own hierarchy entry and a configurable Settings color.
- ☁️ **Skybox** — dome geometry decoded and emitted as a GLB; the texture (when found) renders as the viewport background. Cleaner than the previous "no sky" state.
- 😀 **Viseme rigs fixed** — the 14 head rigs (soldier, cartwright, Winters, ...) that previously animated frozen or radiated bones from one point now play their `*_visemes`, `*_expressions`, `*_blink` clips correctly. Root cause was a u16 byte-order quirk on `Skeleton.translationShift`; fix is documented in `project_skeleton_shift_byte_quirk` memory.
- 🎮 **Gameplay placements** — `ps3gameplay.dat` is parsed and 184-ish moby placements feed the viewport / Godot. Probing scaffold added for the 6 unidentified sub-arrays (triggers / volumes / spawns) — set `RECHIMERA_LOG_PROBES=1` to dump them and help reverse-engineer.
- 🌐 **Full-map GLB export** — now bakes everything (mobys, ties, details, shrubs, foliage, terrain, sky) into a single drag-into-Godot file.

## Resistance 2 / Resistance 3 / R&C: Full Frontal Assault / R&C: All 4 One

- 🔊 **Sound tab categorised** — SFX / Dialog / Music sub-tabs with counts. Source-filename classifier works the same across all V2 games.
- 🎚️ **Wizard franchise tabs** — top-of-step-1 tab strip groups Resistance vs Ratchet & Clank with persisted state.
- 🛠️ **Internal methodology consolidated** — same parser robustness improvements benefit the V2 path; nothing game-specific to flag.

## R&C: Tools of Destruction

- 🚧 **No specific changes this round.** Mesh / texture / skeleton loading is still solid; animations still export T-pose. ToD is the focus of the **next patch** (see below).

# Coming next

- 🎯 **ToD animation format.** The per-frame data layout in TOD doesn't match IT's V2 or RFOM paths, and IT itself has no ToD support, so we have to reverse-engineer from raw bytes. Captured frame data for `clank_idle` is already saved in `project_tod_anim_format` memory as a starting probe. The next release patch will focus on cracking this open so ToD characters actually move on export, not just sit in T-pose.
- 🎯 **RFOM lights and gameplay sub-arrays.** If anyone wants to help, see "Help wanted" — both are reverse-engineering tasks gated on raw byte probes from real levels.

# Game support

| Game | Status |
| --- | --- |
| Resistance 2 | ✅ stable end-to-end |
| Resistance 3 | ✅ stable end-to-end |
| Resistance: Fall of Man | ✅ full pipeline + foliage + skybox + visemes + sound (extract `game.psarc` first) |
| R&C: All 4 One | ✅ all features working |
| R&C: Full Frontal Assault | ✅ working — a few textures still missing |
| R&C: Tools of Destruction | ⚠️ meshes / textures / skeletons load; animations export T-pose only (**focus of next patch**) |

# Known limitations

- **Light placements (RFOM)** — no light section identified yet. The previously-rendered "lights" at world origin were a mislabel (the section turned out to be `Foliage`); we've removed the bogus render. Real lights await a future probe pass.
- **Trigger / volume / spawn placements** — IT doesn't decode RFOM's `GameplayInstances.other[6]` arrays, so they remain opaque. Set `RECHIMERA_LOG_PROBES=1` and re-extract to dump the raw bytes if you want to help reverse-engineer them.
- **Collision geometry** — no IT reference exists for RFOM collision; Godot users can auto-generate collision from the GLB mesh geometry on import as a workaround.
- **ToD animations** — frame format remains unsolved; clips export as T-pose.

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
- [@VELD-Dev](https://github.com/VELD-Dev) — [ReLunacy / LibLunacy](https://github.com/RatchetModding/ReLunacy) (the C# predecessor that the moby / tie / texture decode paths port from).
- [@PredatorCZ](https://github.com/PredatorCZ) — [InsomniaToolset / Spike](https://github.com/PredatorCZ/InsomniaToolset) (canonical reference for IGHW container, RFOM `levelmain` extract, foliage / shrub / animation decode, and the V2 GLTF emit pipeline).

Thanks to anyone willing to use, test, or try the tool — every game / level you run through it helps validate the parsers work outside my own small sample.
