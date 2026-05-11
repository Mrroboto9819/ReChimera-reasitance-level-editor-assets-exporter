# ReChimera — internal documentation

Two stacks of numbered chapters, organized by what part of the codebase
they cover:

## [`internal/lunalib-and-IT/`](internal/lunalib-and-IT/)
Documentation of the **`lunalib` parser crate** with cross-references
to **InsomniaToolset** (IT). Each chapter cites the corresponding IT
header / `.cpp` so it's easy to confirm or extend our implementation
against the canonical reference.

| # | File | Lunalib source | IT reference |
|---|---|---|---|
| 01 | [IGHW container](internal/lunalib-and-IT/01-ighw-container.md) | `igfile.rs` | `common/include/insomnia/insomnia.hpp`, `common/src/serialize.cpp` |
| 02 | [Asset lookup](internal/lunalib-and-IT/02-asset-lookup.md) | `assetlookup.rs` | `common/include/insomnia/classes/resource.hpp` |
| 03 | [Skeleton & bind](internal/lunalib-and-IT/03-skeleton.md) | `skeleton.rs`, `math.rs` | `extract/extract_gltf.cpp` `GenerateSkeleton` |
| 04 | [Moby & tie geometry](internal/lunalib-and-IT/04-moby-tie-geometry.md) | `moby.rs`, `moby_rfom.rs`, `moby_old.rs`, `tie.rs`, `tie_rfom.rs`, `tie_old.rs` | `classes/moby.hpp`, `classes/tie.hpp`, `internal/vertex.hpp` |
| 05 | [Textures](internal/lunalib-and-IT/05-textures.md) | `texture.rs`, `shader.rs` | `extract/extract_textures.cpp`, `extract/extract_v2.cpp` |
| 06 | [Animation](internal/lunalib-and-IT/06-animation.md) | `animation.rs` | `classes/animation.hpp`, `common/src/gltf_shared.cpp` |
| 07 | [Sound](internal/lunalib-and-IT/07-sound.md) | `sound.rs` | `sound/extract_sound.cpp` |
| 08 | [GLB writer](internal/lunalib-and-IT/08-gltf-export.md) | `gltf_export.rs`, `math.rs` | `extract/extract_gltf.cpp`, `common/src/gltf_shared.cpp` |
| 09 | [Debugging methodology](internal/lunalib-and-IT/09-debugging-methodology.md) | (cross-cutting — every new decoder) | IT + ReLunacy as canonical references; probe → log → re-extract loop |
| 10 | [Vegetation & sky](internal/lunalib-and-IT/10-vegetation-and-sky.md) | `shrub_rfom.rs`, `foliage_rfom.rs`, `skybox_rfom.rs` | `classes/shrub.hpp`, `classes/foliage.hpp`, `levelmain/extract.cpp::ShrubsToGltf` / `FoliageToGltf` (no IT reference for sky) |

## [`internal/app/`](internal/app/)
Documentation of the **Tauri 2 + React + Three.js desktop app** that
sits on top of `lunalib`.

| # | File | Source | Covers |
|---|---|---|---|
| 01 | [Architecture](internal/app/01-architecture.md) | (workspace overview) | Workspace layout, IPC boundary, cache-first flow |
| 02 | [Cache pipeline](internal/app/02-cache.md) | `apps/desktop/src-tauri/src/cache.rs` | `_rechimera_cache/` layout, manifest schema, every Tauri command |
| 03 | [Frontend](internal/app/03-frontend.md) | `apps/desktop/src/` | Tab system, viewport, GLB preview, animation burger menu |
| 04 | [Updater](internal/app/04-updater.md) | `useUpdater.ts`, `tauri.conf.json` | Windows auto-install vs macOS / Linux GitHub redirect |
| 05 | [Export pipeline](internal/app/05-export-pipeline.md) | `cache.rs::export_moby_glb_with_options`, `ExportOptionsModal.tsx` | Multi-step export modal, `GlbExportOptions`, texture quality presets |

## Auxiliary folders
- [`public/`](public/) — **non-technical, end-user-facing** documentation. Currently in development; will hold "Getting started", "Common workflows", FAQ, etc. The in-app **Help → Documentation** viewer reads from here as well as `internal/` so end-users get plain-language guides without having to read parser internals.
- `logs/` — captured validator / debug logs from real runs (large, not for human reading).
