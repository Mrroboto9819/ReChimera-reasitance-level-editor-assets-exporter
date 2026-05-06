# ReChimera — Third-Party Notices and Attributions

ReChimera is licensed under **GPL-3.0-or-later** (see [LICENSE](LICENSE)).
This file documents the upstream projects whose work this codebase was
ported from or builds on, and the third-party libraries it ships /
links against — together with their licenses and attribution
requirements.

This document is kept up-to-date as dependencies and references
change. If you are redistributing ReChimera, you must preserve this
notice file alongside [LICENSE](LICENSE).

---

## 1. ReChimera copyright

```
ReChimera — offline level inspector and asset extractor for Insomniac
Games' PS3 titles (Resistance: Fall of Man, Resistance 2, Resistance 3,
and the Ratchet & Clank Future trilogy).

Copyright (C) 2024–2025 ReChimera contributors.
Lead maintainer: VELD-Dev (https://github.com/VELD-Dev).

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your
option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
Public License for more details.

You should have received a copy of the GNU General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.
```

---

## 2. Upstream projects we port from

ReChimera is a clean-room reimplementation in Rust + Tauri of work
originally written in C# (ReLunacy / LibLunacy) and C++ (InsomniaToolset).
Format documentation, struct layouts, pointer-resolution rules, and
codec algorithms come from cross-referencing those projects against real
PS3 game files. Their licenses propagate into this derivative work,
which is why ReChimera is GPL-3.0-or-later.

### 2.1 ReLunacy / LibLunacy

- **Repository:** https://github.com/RatchetModding/ReLunacy
- **Author:** [@VELD-Dev](https://github.com/VELD-Dev) and contributors
- **License:** GPL-3.0
- **Copyright:** © VELD-Dev and ReLunacy contributors
- **What ReChimera ports from it:** IGHW container reader (v0.2 + v1.1,
  big/little-endian detection), AssetLookup table walker, texture
  decode pipeline (DXT + Morton inverse), the 7th-gen-engine asset
  hierarchy (mobys / ties / shaders / zones), and the overall editor
  approach.

### 2.2 InsomniaToolset

- **Repository:** https://github.com/PredatorCZ/InsomniaToolset
- **Author:** Lukas Cone
  ([@PredatorCZ](https://github.com/PredatorCZ)) and contributors
- **License:** GPL-3.0
- **Copyright:** © 2021–2025 Lukas Cone
- **What ReChimera ports from it:** SCREAM sound bank V1/V2 detection
  + section IDs + struct layouts; VAGp / VPK / XVAG audio container
  decoders; SoundStreams pointer-table format; PS-ADPCM block decoder
  + filter coefficients; cross-references for moby / tie / texture
  format edge cases; new-engine class definitions in
  `common/include/insomnia/classes/`.

### 2.3 Spike framework (transitive)

- **Repository:** https://github.com/PredatorCZ/Spike
- **Author:** Lukas Cone ([@PredatorCZ](https://github.com/PredatorCZ))
- **License:** BSD-3-Clause (compatible with GPL-3.0)
- **Copyright:** © Lukas Cone
- **What ReChimera ports from it:** Reflective struct loading and
  PointerX86 resolution semantics. ReChimera reimplements this in
  Rust per-struct rather than depending on the framework directly.

### 2.4 Lunacy / 7th igRewrite (renderer / editor inspiration)

- **Repository:** https://github.com/NefariousTechSupport/7thigRewrite
- **Author:** [@NefariousTechSupport](https://github.com/NefariousTechSupport)
- **What ReChimera takes from it:** Renderer / scene-graph design
  patterns. Direct code is not copied; the inspiration is documented
  here for due credit.

### 2.5 Replanetizer (editor architecture inspiration)

- **Repository:** https://github.com/RatchetModding/Replanetizer
- **Maintainer:** [@MilchRatchet](https://github.com/MilchRatchet) and
  contributors
- **What ReChimera takes from it:** The Frames-based pane layout
  approach that ReLunacy adopted for its global level editor — that
  influence carries through into ReChimera's panel / split-region UX.

### 2.6 Additional contributors

- **[@chaoticgd](https://github.com/chaoticgd)** — guidance on the 3D
  rendering implementation in ReLunacy, which ReChimera inherits.
- **[@Nooga](https://github.com/Nooga)** — artist of the ReLunacy
  logo, which set the visual identity ReChimera follows.

---

## 3. Third-party Rust crates (linked into the binary)

All listed crates are dual-licensed MIT / Apache-2.0 (or compatible
permissive licenses). All are GPL-3.0-compatible.

| Crate | License | Project URL |
|---|---|---|
| tauri (and plugins: `tauri-plugin-dialog`, `tauri-plugin-os`) | MIT OR Apache-2.0 | https://tauri.app |
| serde, serde_json | MIT OR Apache-2.0 | https://serde.rs |
| byteorder | Unlicense OR MIT | https://github.com/BurntSushi/byteorder |
| thiserror | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| rayon | MIT OR Apache-2.0 | https://github.com/rayon-rs/rayon |
| texpresso | MIT OR Apache-2.0 | https://github.com/Lokathor/texpresso |
| image | MIT OR Apache-2.0 | https://github.com/image-rs/image |
| flate2 | MIT OR Apache-2.0 | https://github.com/rust-lang/flate2-rs |
| md-5 (and `RustCrypto/hashes`) | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| base64 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |

**Apache-2.0 attribution:** Where a crate is dual-licensed under
Apache-2.0 and MIT, ReChimera distributes under the MIT branch by
default (so no separate `NOTICE` propagation is required), but where
applicable any upstream `NOTICE` files are preserved per Apache-2.0 §4.

The full license text for each crate is shipped with that crate's
`LICENSE` / `LICENSE-MIT` / `LICENSE-APACHE` files inside the
`Cargo` registry cache; running
`cargo about generate about.hbs` regenerates a one-stop attribution
report if you want a flat file.

---

## 4. Third-party JavaScript / TypeScript packages (bundled into the
desktop frontend)

All listed packages are MIT-licensed (or have an explicit free-use
clause for open-source projects). All are GPL-3.0-compatible.

| Package | License | Project URL |
|---|---|---|
| react, react-dom | MIT | https://react.dev |
| three (Three.js) | MIT | https://threejs.org |
| @react-three/fiber | MIT | https://github.com/pmndrs/react-three-fiber |
| @react-three/drei | MIT | https://github.com/pmndrs/drei |
| @reduxjs/toolkit, react-redux, redux-persist | MIT | https://redux-toolkit.js.org |
| react-resizable-panels | MIT | https://github.com/bvaughn/react-resizable-panels |
| gsap | Standard "No Charge" license — explicitly permits use in free, non-commercial, and open-source projects (see https://gsap.com/standard-license) | https://gsap.com |
| @tauri-apps/api, @tauri-apps/plugin-dialog, @tauri-apps/plugin-os | MIT OR Apache-2.0 | https://tauri.app |

---

## 5. Game data

ReChimera does **not** include, distribute, or redistribute any game
assets, executables, scripts, audio data, textures, geometry, or other
content owned by Sony Interactive Entertainment, Insomniac Games, or
their affiliates. The project provides format readers and a desktop
viewer; you supply your own legitimately-acquired game files.

The Resistance and Ratchet & Clank trademarks and content are the
property of their respective owners. ReChimera is a fan-made tool
created for offline preservation, modding, and educational study.

---

## 6. License compatibility summary

| Source | License | GPL-3.0 compatible? |
|---|---|---|
| ReLunacy / LibLunacy | GPL-3.0 | ✅ identical |
| InsomniaToolset | GPL-3.0 | ✅ identical |
| Spike framework (referenced) | BSD-3-Clause | ✅ permissive → can be incorporated |
| All Rust deps in §3 | MIT / Apache-2.0 / Unlicense | ✅ permissive |
| All JS deps in §4 | MIT (or open-source-compatible) | ✅ permissive |

The combined work is distributed under GPL-3.0-or-later, which is
required by the strongest copyleft input (the GPL-3.0 upstream
projects in §2). All other inputs are permissive and impose only
attribution / notice preservation, which this file handles.
