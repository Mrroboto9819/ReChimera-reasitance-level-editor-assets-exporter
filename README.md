# ReChimera

An offline level inspector and asset extractor for **Insomniac Games' PS3 titles**
— Resistance: Fall of Man, Resistance 2, Resistance 3, and the Ratchet & Clank
Future trilogy. Loads a level folder straight from disk, decodes its meshes,
textures, skeletons, animations, and sound banks, and lets you preview / export
them through a desktop UI.

ReChimera is a clean-room reimplementation in **Rust + Tauri 2 + React +
Three.js**, ported from the file-format research and reference parsers
maintained by the Insomniac modding community (see [Acknowledgements](#acknowledgements)).
None of the original assets, executables, or proprietary tooling are
distributed — only format readers and a viewer. Use it on game files you
legally own.

License: **GPL-3.0-or-later** (inherited from the reference projects this
work descends from).

---

## What it does

- **Browse a level folder** — point at any directory containing
  `assetlookup.dat` and ReChimera scans every file it recognises.
- **Render the world in 3D** — a Three.js viewport with orbit / pan / zoom,
  selection gizmos (translate / rotate / scale), grid + axes overlays, and an
  IDE-style hierarchy panel listing every moby / tie / terrain UFrag.
- **Inspect assets** — per-instance Inspector with a live mini 3D preview,
  full transform fields editable inline, and a "Go to" button that re-frames
  the main viewport on the selected instance.
- **Decode textures** — handles DXT1 / DXT3 / DXT5 plus the Morton-swizzled
  R5G6B5 / A8R8G8B8 PS3 formats. Inline thumbnail previews from the
  Hierarchy's Textures section; bulk fetch via Tauri 2 binary IPC.
- **Skeleton + animation** — per-moby skinned-mesh rigs with bind-pose
  + per-animset clip playback. The Hierarchy's Animations section overrides
  any skinned character's clip on demand.
- **Decode sound banks** — V1 (RFOM) and V2 (R2/R3/RCF) SCREAM banks. Plays
  in-bank PS-ADPCM sounds, paired streaming containers (VAGp / VPK / XVAG
  PS-ADPCM), and orphan streaming files via brute-force header scanning. A
  bottom-of-app SoundPlayer with scrub / volume / export-to-WAV.
- **Asset Library tree** — every moby / tie referenced by `assetlookup.dat`
  organised by its path-style name (entities/character/weapon/sawgun, …),
  with a per-asset preview modal that opens directly from the tree.
- **GLB export** — the selection (or any single library asset) exports to
  glTF 2.0 binary with bones + skinning weights + animations baked as
  Blender NLA Actions.
- **PSARC tools** — list and extract PlayStation Archive files directly,
  with per-entry progress reporting.

## Supported games

| Game | IGHW version | SCREAM version | Notes |
|---|---|---|---|
| Resistance: Fall of Man | v0.2 / v1.1 | V1 | `ps3sound.dat`, `ps3dialogue*.dat` |
| Resistance 2 | v1.1 | V2 | `resident_sound.dat`, paired or orphan streams |
| Resistance 3 | v1.1 | V2 | Same as R2 |
| Ratchet & Clank Future trilogy | v1.1 | V2 | Tools of Destruction, A Crack in Time, Quest for Booty |

What works depends entirely on whether your extracted level folder includes
the dependent files (e.g. dialogue banks need their `streaming_dialogue.*.dat`
siblings to be playable). The Hierarchy marks unreachable entries with a
"no audio" badge so the difference is visible.

---

## Architecture

```
ReChimera/
├── Cargo.toml                  # virtual workspace
├── crates/
│   ├── lunalib/                # core parser library (Rust)
│   │   ├── igfile.rs           # IGHW container reader (v0.2 + v1.1, BE/LE)
│   │   ├── stream.rs           # endian-aware byte reader
│   │   ├── assetlookup.rs      # asset-table master index
│   │   ├── moby.rs / tie.rs    # geometry + skinning decoders
│   │   ├── texture.rs          # DXT + Morton + bulk parallel PNG encode
│   │   ├── skeleton.rs         # bone hierarchy + bind pose
│   │   ├── animation.rs        # animset clips + per-frame keyframes
│   │   ├── shader.rs           # material → texture id lookups
│   │   ├── zone.rs / ufrag.rs  # streaming terrain
│   │   ├── gameplay.rs         # placed instances + transforms
│   │   ├── sound.rs            # V1/V2 SCREAM bank + VAGp/VPK/XVAG decoders
│   │   └── examples/           # CLI dumpers for headless verification
│   └── psarc/                  # PSARC archive reader (ZLIB only for now)
└── apps/
    └── desktop/                # Tauri 2 + Vite + React + TypeScript
        ├── src-tauri/          # Rust backend — Tauri commands wrap lunalib
        │   └── src/main.rs     # ~50 commands: open_level, level_meshes_stream,
        │                       # extract_level_sounds, dump_sound_bank, …
        └── src/                # React frontend
            ├── Viewport.tsx    # main 3D viewport (Three.js / R3F)
            ├── Hierarchy.tsx   # tree of mobys / ties / library / sounds / …
            ├── Inspector.tsx   # selection details + transform editing
            ├── SoundPlayer.tsx # bottom transport bar
            ├── GltfCharacterModal.tsx + RawCharacterModal.tsx
            └── api.ts          # typed wrappers around `invoke()`
```

**Frontend ↔ backend boundary** uses Tauri 2 IPC. Heavy binary payloads
(textures, mesh buffers) bypass JSON via the binary-IPC `Response` type to
avoid the base64 round-trip — see `get_level_textures_bulk` for the bulk
fetch pattern.

---

## Building & running

**Prerequisites**
- Rust 1.75+ (`rustup default stable`)
- [Bun](https://bun.sh) (Node-compatible package manager)
- WebView2 (Windows 11: pre-installed; Windows 10: install from Microsoft)

**Dev mode (hot-reload)**
```sh
cd apps/desktop
bun install            # one-time
bun run tauri:dev      # launches the desktop app with Vite hot-reload
```

The first build takes ~1–2 min as the Tauri stack compiles. After that:
- TypeScript / CSS changes hot-reload instantly.
- Rust changes need a `Ctrl+C` and re-run of `tauri:dev`.

**Headless dumpers** (no UI, useful for sanity-checking a parser change)
```sh
cargo run -p lunalib --example dump_assetlookup -- "<path>/assetlookup.dat"
cargo run -p lunalib --example dump_textures    -- "<path>"
cargo run -p lunalib --example dump_moby_meshes -- "<path>"
```

**Release build**
```sh
cd apps/desktop
bun run build
cd ../..
cargo build -p rechimera-desktop --release
```

---

## Acknowledgements

ReChimera could not exist without the reverse-engineering work that came before.
The format documentation, struct layouts, and reference implementations from
the projects below were the input we ported from. **Heartfelt thanks to their
authors and contributors.**

### Primary references — format research

- **[InsomniaToolset](https://github.com/PredatorCZ/InsomniaToolset)** by
  **Lukas Cone** ([@PredatorCZ](https://github.com/PredatorCZ)).
  GPL-3.0. The canonical reference for the new-engine path (R2 / R3 / RCF
  trilogy). The C++ struct headers in
  `common/include/insomnia/classes/` are what nailed every section ID,
  pointer-resolution rule, and codec layout in this codebase. The SCREAM
  V1/V2 detection, VAGp / VPK / XVAG decoders, and SoundStreams pointer-table
  format all came directly from cross-referencing their `extract_sound.cpp`
  and class definitions.
- **[ReLunacy](https://github.com/Dnawrkshp/ReLunacy) / LibLunacy**.
  GPL-3.0. The C# / Unity-based predecessor. Our IGHW container reader,
  endian detection, and texture-decode path (DXT + Morton inverse) port
  directly from `IGFile.cs`, `AssetLoader.cs`, `Texture.cs`, etc.
- **[Spike framework](https://github.com/PredatorCZ/Spike)** by Lukas Cone.
  BSD-3-Clause. Powers InsomniaToolset's reflective struct loading; we
  reimplement equivalent logic in Rust per-struct rather than depending on
  the framework directly.

### Runtime stack — open-source libraries we ship

#### Rust crates
| Crate | License | Used for |
|---|---|---|
| [tauri](https://tauri.app) (+ plugins: dialog, os) | MIT / Apache-2.0 | Desktop shell, IPC |
| [serde](https://serde.rs) | MIT / Apache-2.0 | DTO (de)serialization |
| [byteorder](https://github.com/BurntSushi/byteorder) | Unlicense / MIT | Endian-safe reads |
| [thiserror](https://github.com/dtolnay/thiserror) | MIT / Apache-2.0 | Error types |
| [rayon](https://github.com/rayon-rs/rayon) | MIT / Apache-2.0 | Parallel texture / sound decode |
| [texpresso](https://github.com/Lokathor/texpresso) | MIT / Apache-2.0 | DXT block decoding |
| [image](https://github.com/image-rs/image) | MIT / Apache-2.0 | PNG encode + image resize |
| [flate2](https://github.com/rust-lang/flate2-rs) | MIT / Apache-2.0 | PSARC ZLIB decompression |
| [md-5](https://github.com/RustCrypto/hashes) | MIT / Apache-2.0 | PSARC integrity hashes |
| [base64](https://github.com/marshallpierce/rust-base64) | MIT / Apache-2.0 | DTO encoding for legacy paths |

#### JavaScript / TypeScript dependencies
| Package | License | Used for |
|---|---|---|
| [React](https://react.dev) + React DOM | MIT | UI framework |
| [Three.js](https://threejs.org) | MIT | WebGL renderer |
| [@react-three/fiber](https://github.com/pmndrs/react-three-fiber) | MIT | React reconciler for Three.js |
| [@react-three/drei](https://github.com/pmndrs/drei) | MIT | OrbitControls, Bounds, Grid helpers |
| [Redux Toolkit](https://redux-toolkit.js.org/) + react-redux + redux-persist | MIT | App-state container |
| [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) | MIT | IDE-style splitters |
| [GSAP](https://gsap.com/) | Standard "No Charge" license | Modal enter/exit animations |
| [@tauri-apps/api](https://tauri.app) (+ plugins) | MIT / Apache-2.0 | Frontend↔Rust IPC bindings |

All listed licenses are GPL-3.0-compatible. GSAP's free license explicitly
permits use in open-source projects.

---

## License

This project is licensed under **GPL-3.0-or-later** ([LICENSE](LICENSE)). The
choice of license is dictated by upstream: InsomniaToolset and LibLunacy /
ReLunacy — the projects we port from — are GPL-3.0, and that licence
propagates into derivative works.

If you find this useful, please credit the upstream authors above. Patches
to ReChimera are welcome under the same licence.
