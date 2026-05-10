<p align="center">
  <img src="apps/desktop/icon.png" width="140" alt="ReChimera logo" />
</p>

<h1 align="center">ReChimera</h1>

<p align="center">
  <strong>Offline level inspector and asset extractor for Insomniac Games' PS3 titles</strong><br/>
  <sub>Resistance: Fall of Man · Resistance 2 · Resistance 3 · Ratchet &amp; Clank: Tools of Destruction · Full Frontal Assault · All 4 One</sub>
</p>

<p align="center">
  <a href="#status"><img src="https://img.shields.io/badge/status-beta-orange?style=for-the-badge" alt="Status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=for-the-badge" alt="License" /></a>
</p>

<p align="center">
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust" /></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri%202-FFC131?style=for-the-badge&logo=tauri&logoColor=black" alt="Tauri" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" /></a>
  <a href="https://threejs.org"><img src="https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white" alt="Three.js" /></a>
</p>

<img src="assets/demo.png" alt="ReChimera demo" width="100%" />

---

ReChimera loads a level folder from disk, decodes its meshes, textures,
skeletons, animations, and sound banks, and lets you preview / export them
through a desktop UI. It's a clean-room reimplementation in **Rust + Tauri 2 +
React + Three.js**, ported from the file-format research maintained by the
Insomniac modding community (see [Acknowledgements](#acknowledgements)).
No game data is shipped — only format readers and a viewer. **Use it on game
files you legally own.**

> 📚 For architecture, parser internals, build scripts, headless dumpers and
> contributor notes, see the [`docs/`](docs/) folder. The same content is
> also available **inside the app** under **Help → Documentation**.

## How this app was built

Built with **[Claude Code](https://claude.com/claude-code)** paired with
the developer experience of [Pablo Cabrera
Castrejón](https://github.com/Mrroboto9819), on top of the format work
done by **[Lunacy](https://github.com/NefariousTechSupport) /
[ReLunacy](https://github.com/RatchetModding/ReLunacy)** (originally by
[@NefariousTechSupport](https://github.com/NefariousTechSupport),
maintained today by [@VELD-Dev](https://github.com/VELD-Dev)) and
**[InsomniaToolset](https://github.com/PredatorCZ/InsomniaToolset)** (by
[@PredatorCZ](https://github.com/PredatorCZ)). ReChimera is a port and
a viewer — see [Acknowledgements](#acknowledgements) for the full
dependency / reference list.

---

## Before you start

A level needs **every `.psarc` that ships with it extracted into the
same folder**. The parser walks `assetlookup.dat` and expects its
siblings (`mobys.dat`, `ties.dat`, `shaders.dat`, `textures.dat`,
`highmips.dat`, `animsets.dat`, `zones.dat`, plus the level's
`resident_*.dat` / `streaming_*.dat` audio companions) to live in the
same directory. Use any PSARC extractor — including the **Extract a
PSARC** flow built into ReChimera — and point every archive at one
common output folder. Missing siblings surface as `no audio` badges or
empty meshes; they don't crash the loader.

## What it does

- Browse a level folder by pointing at any directory containing `assetlookup.dat`.
- 3D viewport (Three.js) with orbit / pan / zoom, selection gizmos, hierarchy panel.
- Per-instance Inspector with a live mini 3D preview, transform editing, and "Go to" framing.
- Texture decode (DXT1/3/5 + Morton-swizzled R5G6B5/A8R8G8B8) with inline previews.
- Skinned-mesh rigs with per-animset clip playback; pick any clip to override on a character.
- Sound banks (V1 RFOM + V2 R2/R3/RCF SCREAM), VAGp / VPK / XVAG decoders, in-app player + WAV export.
- Asset Library tree with a per-asset preview modal that renders straight from cache.
- GLB export with bones, skinning weights, materials, textures, and selectable animations from any animset in the level.
- PSARC list + extract.

## Supported games

| Game | Layout | IGHW | SCREAM | Mesh | Tex | Skel | Anim | Notes |
|---|---|---|---|---|---|---|---|---|
| Resistance: Fall of Man | `ps3levelmain.dat` | v1.1 | V1 | ✅ | ✅ | ✅ | ✅ | extract `game.psarc` first |
| Resistance 2 | `assetlookup.dat` (V2) | v1.1 | V2 | ✅ | ✅ | ✅ | ✅ | tested end-to-end |
| Resistance 3 | `assetlookup.dat` (V2) | v1.1 | V2 | ✅ | ✅ | ✅ | ✅ | tested end-to-end |
| R&C: Tools of Destruction | `main.dat` (TOD) | v1.1 | V2 | ✅ | ✅ | ✅ | ⚠️ T-pose | per-frame anim format unsolved |
| R&C: Full Frontal Assault | `assetlookup.dat` (V2) | v1.1 | V2 | ✅ | ⚠️ | ✅ | ✅ | a few textures still missing |
| R&C: All 4 One | `assetlookup.dat` (V2) | v1.1 | V2 | ✅ | ✅ | ✅ | ✅ | tested |

---

## Installation

Builds are produced for all three desktop platforms.

| Platform | Format | Build status | Tested? | Auto-update |
|---|---|---|---|---|
| 🪟 Windows 10 / 11 (x86_64) | `.msi` + portable `.exe` | ✅ | ✅ | ✅ Built-in |
| 🐧 Linux (x86_64) | `.AppImage` + `.deb` | ✅ | ⚠️ Untested | ❌ Manual — download new release from GitHub |
| 🍎 macOS 12+ (Apple Silicon + Intel) | `.dmg` | ✅ | ⚠️ Untested | ❌ Manual — download new release from GitHub |

When a new version is available the app shows an **Update** button:
- **Windows**: clicking it downloads + installs in place and relaunches.
- **macOS / Linux**: clicking it opens [the GitHub Releases page](https://github.com/Mrroboto9819/ReChimera/releases/latest); replace the binary manually.

Releases live at <https://github.com/Mrroboto9819/ReChimera/releases>.

---

## Developers

**Toolchain**

| Tool | Required version |
|---|---|
| **Rust** | 1.75+ (`rustup default stable`). Edition 2021. Workspace `rust-version = "1.75"`. |
| **Cargo** | ships with rustup |
| **WebView2** | Windows 11 pre-installed; Windows 10 install from Microsoft |
| **Node-compatible package manager** | [Bun](https://bun.sh) (recommended) or `npm` 10+ |

**Run from source**

```sh
cd apps/desktop

# pick one — they're interchangeable for these scripts
bun install                   # or:  npm install

bun run tauri:dev             # or:  npm run tauri:dev
```

`tauri:dev` builds the Rust backend, starts Vite on `localhost:1420`,
and opens the desktop window with hot-reload (TS / CSS reload
instantly, Rust changes need a `Ctrl+C` and re-run).

**Build a release bundle**

```sh
cd apps/desktop
bun run tauri:build           # or:  npm run tauri:build
```

Outputs `.msi` + portable `.exe` on Windows, `.AppImage` + `.deb` on
Linux, `.dmg` on macOS, into `apps/desktop/src-tauri/target/release/bundle/`.

**Headless parser dumpers** (no UI — handy for sanity-checking a parse
against a real file without booting the app):

```sh
# Container & top-level lookups
cargo run -p lunalib --example dump_assetlookup -- "<level-folder>/assetlookup.dat"

# Per-asset content
cargo run -p lunalib --example dump_moby_meshes -- "<level-folder>"
cargo run -p lunalib --example dump_moby_skin   -- "<level-folder>" [--first N]
cargo run -p lunalib --example dump_tie_meshes  -- "<level-folder>"
cargo run -p lunalib --example dump_shaders     -- "<level-folder>"
cargo run -p lunalib --example dump_textures    -- "<level-folder>" [output_dir] [max_pngs]

# Animation
cargo run -p lunalib --example dump_animsets    -- "<level-folder>" [--decode N]

# Level-scope: terrain, zones, gameplay placements
cargo run -p lunalib --example dump_zones       -- "<level-folder>"
cargo run -p lunalib --example dump_ufrags      -- "<level-folder>"
cargo run -p lunalib --example dump_gameplay    -- "<level-folder>"
```

All ten examples build under `cargo build -p lunalib --examples` and
read the same `<level-folder>` your app would. They auto-detect engine
era (V2 / RFOM / TOD) via [`level_layout.rs`](crates/lunalib/src/level_layout.rs)
so the same command works against every supported game.

For the architecture, parser internals, and the full IT / ReLunacy
cross-references, see [`docs/`](docs/) — the same content is
available inside the running app under **Help → Documentation**.

---

## Status

### Shipped
- IGHW container + asset parsers (mobys, ties, skeletons, animsets, textures, shaders, zones, gameplay).
- SCREAM V1/V2 sound banks + VAGp / VPK / XVAG stream decoders, in-app player, WAV export.
- PSARC list + extract.
- 3D viewport, hierarchy, inspector, asset library, sound player.
- Cache library: per-level cache writes one `.glb` per moby/tie; exports use this directly.
- GLB export — bones, weights, materials, textures, multi-mesh layout, selectable animations from any animset.
- Animation picker burger menu on the GLB preview — play any clip on the current rig, tick clips for export.
- Multi-step Export modal — scope toggles (mesh / materials+textures / armature) + texture quality presets (Low/Medium/High/Original) + animation picker.

### In progress
- Sound playback verification on R2 / R3 / RCF.
- MPEG-encoded XVAG decode (currently errors cleanly).

### Roadmap
- World repackaging — write edited transforms back to disk.
- Bulk exporters (textures, sounds, meshes, animations).
- Lighting + cubemap parse, scene-level lighting in viewport.
- VFX / cinematics / foliage parsers.
- Cross-platform build verification (macOS + Linux).
- Headless `rechimera-cli` for batch jobs without WebView2.
- Built-in PSARC repacker.

---

## Acknowledgements

ReChimera builds on years of community reverse-engineering on Insomniac's PS3 engine.

### People
- **[@VELD-Dev](https://github.com/VELD-Dev)** — author of [ReLunacy](https://github.com/RatchetModding/ReLunacy) (the C# / Unity predecessor this project ports its core parser approach from) and lead maintainer here.
- **[@NefariousTechSupport](https://github.com/NefariousTechSupport)** — original developer of Lunacy and one of the key reverse engineers for these titles. ReChimera's renderer is directly inspired by their [7th igRewrite](https://github.com/NefariousTechSupport/7thigRewrite).
- **[@PredatorCZ](https://github.com/PredatorCZ)** — author of [InsomniaToolset](https://github.com/PredatorCZ/InsomniaToolset) and the [Spike framework](https://github.com/PredatorCZ/Spike). Many section IDs and struct layouts here come from cross-referencing their headers.
- **[@Nooga](https://github.com/Nooga)** — artist behind ReLunacy's logo, which set the visual identity this project follows.

### Reference projects
- **[ReLunacy / LibLunacy](https://github.com/RatchetModding/ReLunacy)** (GPL-3.0) — the C# / Unity predecessor this project ports from.
- **[InsomniaToolset](https://github.com/PredatorCZ/InsomniaToolset)** (GPL-3.0) — canonical reference for the new-engine path (R2 / R3 / RCF).
- **[Spike framework](https://github.com/PredatorCZ/Spike)** (BSD-3-Clause).
- **[7th igRewrite](https://github.com/NefariousTechSupport/7thigRewrite)**.

All runtime dependencies are GPL-3.0-compatible. The full list lives in [`docs/`](docs/).

---

## License

This project is licensed under **GPL-3.0-or-later**. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). The licence is dictated by upstream — InsomniaToolset and ReLunacy / LibLunacy are GPL-3.0, and that propagates into derivative works.

**Game data is not included.** ReChimera ships only format readers and a viewer. You must supply your own legitimately-acquired game files.
