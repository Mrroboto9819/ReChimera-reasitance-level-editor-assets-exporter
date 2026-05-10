# 01 — Architecture overview

ReChimera is a Cargo workspace with a Tauri 2 desktop app on top:

```
ReChimera/
├── Cargo.toml                # virtual workspace
├── crates/
│   ├── lunalib/              # IGHW + asset parsers (no Tauri deps)
│   └── psarc/                # PSARC archive reader (zlib only)
└── apps/
    └── desktop/
        ├── src-tauri/        # Rust backend (~50 Tauri commands wrap lunalib)
        └── src/              # React + Three.js frontend
```

## The cache-first flow

The single most important architectural decision: there is no runtime
streaming of geometry into the viewport. Every consumer (viewport, modal
preview, exports, library tree) reads from the **same on-disk cache**:

```
.dat files                 extract_level_to_cache (Rust)            _rechimera_cache/                    consumers
─────────────────          ─────────────────────────                ──────────────────────              ───────────
assetlookup.dat ─┐                                                  manifest.json                       loadFromCache  → viewport
mobys.dat        │  read_moby_assets_with_total                     mobys/0x{tuid}.json                 readCachedAsset → modal preview
ties.dat         │  read_tie_assets_with_total                      mobys/0x{tuid}.glb   ← whole asset  exportCachedMobyGlb → user .glb
zones.dat        ├─ read_zones                                      ties/0x{tuid}.json
shaders.dat      │  read_shaders                                    ties/0x{tuid}.glb
textures.dat     │  bulk_extract_pngs                               textures/{id}.png    ← shared maps
highmips.dat     │  write_moby_glb_full (per moby/tie)
animsets.dat     ┘  decode_clips_for_moby (all clips per animset)
```

The same bytes that build the modal preview's GLB are the bytes that exit
through the Export button. There is no preview/export divergence.

## Component boundaries

- **`lunalib`** — pure parsing. No Tauri, no I/O, no async. Functions take
  `&Path` or `IgFile<Cursor<Vec<u8>>>` and return strongly-typed structs.
- **`psarc`** — same shape, but only handles the PSARC container.
- **`apps/desktop/src-tauri`** — thin Tauri command layer. Each command
  opens files, calls into lunalib, serializes results into DTOs, and
  streams progress through `tauri::ipc::Channel`. Heavy binary payloads
  (textures, GLBs) bypass JSON via `tauri::ipc::Response` to skip the
  base64 round-trip.
- **`apps/desktop/src`** — React app. State in Redux Toolkit (with
  redux-persist). 3D in `@react-three/fiber`. Modal previews use
  `THREE.GLTFLoader` straight on the cached GLB bytes.

## What lives where

| File | Role |
|---|---|
| `crates/lunalib/src/igfile.rs` | IGHW container header + section table |
| `crates/lunalib/src/stream.rs` | Endian-aware byte reader |
| `crates/lunalib/src/assetlookup.rs` | `assetlookup.dat` master index |
| `crates/lunalib/src/moby.rs` | Moby (animated) parser |
| `crates/lunalib/src/tie.rs` | Tie (static) parser |
| `crates/lunalib/src/skeleton.rs` | Bone hierarchy, tms0/tms1, bind matrices |
| `crates/lunalib/src/animation.rs` | Animation decode, all clips per animset |
| `crates/lunalib/src/texture.rs` | DXT + Morton decode, PNG encode, downsample |
| `crates/lunalib/src/shader.rs` | Material → texture id lookup |
| `crates/lunalib/src/zone.rs` / `ufrag.rs` | Streaming terrain |
| `crates/lunalib/src/gameplay.rs` | Placed instances + transforms |
| `crates/lunalib/src/sound.rs` | SCREAM banks + audio decoders |
| `crates/lunalib/src/gltf_export.rs` | GLB writer (skinned + multi-mesh) |
| `apps/desktop/src-tauri/src/cache.rs` | Cache pipeline + Tauri commands |
| `apps/desktop/src-tauri/src/main.rs` | Command registration |
| `apps/desktop/src/App.tsx` | Top-level layout + state wiring |
| `apps/desktop/src/Viewport.tsx` | Main 3D viewport |
| `apps/desktop/src/AssetPreview.tsx` | Routes between JSON-based and GLB-based preview |
| `apps/desktop/src/GlbPreview.tsx` | GLB-based modal preview + animation burger menu |
| `apps/desktop/src/ExportOptionsModal.tsx` | Multi-step export modal |

## Reading order

If you're new: read this file, then jump to
[`lunarlib-and-IT/01-ighw-container.md`](../lunarlib-and-IT/01-ighw-container.md)
to understand the byte format. Everything after that builds on the IGHW
section table iterator. App-side concerns (cache, frontend, updater)
continue in the rest of `internal/app/`.
