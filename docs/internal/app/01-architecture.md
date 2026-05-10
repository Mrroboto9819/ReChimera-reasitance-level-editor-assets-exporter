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

### Parsers (`crates/lunalib/`)

| File | Role |
|---|---|
| `igfile.rs` | IGHW container header + section table |
| `stream.rs` | Endian-aware byte reader |
| `level_layout.rs` | Detects engine era (V2 / RFOM / TOD) from marker file |
| `assetlookup.rs` | `assetlookup.dat` master index (V2 path) |
| `moby.rs`, `moby_rfom.rs`, `moby_old.rs` | Moby parsers — V2 / RFOM / TOD |
| `tie.rs`, `tie_rfom.rs`, `tie_old.rs` | Tie parsers — V2 / RFOM / TOD |
| `tie_inst_rfom.rs` | RFOM tie instance placement |
| `skeleton.rs` | Bone hierarchy, tms0/tms1, bind matrices (shared across engines) |
| `animation.rs` | Animation decode, all clips per animset |
| `texture.rs`, `texture_rfom.rs`, `texture_old.rs` | DXT + Morton decode, PNG encode (per-engine) |
| `shader.rs`, `shader_rfom.rs`, `shader_old.rs` | Material → texture id lookup (per-engine) |
| `zone.rs`, `zone_old.rs`, `region_rfom.rs` | Streaming terrain (V2 / TOD / RFOM) |
| `gameplay.rs`, `gameplay_old.rs`, `gameplay_rfom.rs` | Placed instances + transforms (per-engine) |
| `sound.rs` | SCREAM banks + audio decoders (V1 RFOM + V2 V2-era) |
| `gltf_export.rs` | GLB writer (skinned + multi-mesh, engine-agnostic) |

### Tauri backend (`apps/desktop/src-tauri/`)

| File | Role |
|---|---|
| `src/cache.rs` | Cache pipeline + ~50 Tauri commands; layout-dispatched per game |
| `src/main.rs` | Tauri command registration |

### Frontend (`apps/desktop/src/`)

| File | Role |
|---|---|
| `App.tsx` | Top-level layout + state wiring |
| `views/Viewport.tsx` | Main 3D viewport |
| `views/AssetPreview.tsx` | Routes between JSON-based and GLB-based preview |
| `views/GlbPreview.tsx` | GLB-based modal preview + skeleton helper overlay + animation burger menu |
| `views/Hierarchy.tsx`, `views/Inspector.tsx`, etc. | Side panels |
| `components/OpenLevelModal.tsx` | 4-step wizard (Game → Source → optional PSARC extract → Open) |
| `components/ExportOptionsModal.tsx` | Multi-step export modal |
| `components/Modal.tsx` | Base modal with header / subheader / body / footer slots |

## Reading order

If you're new: read this file, then jump to
[`lunalib-and-IT/01-ighw-container.md`](../lunalib-and-IT/01-ighw-container.md)
to understand the byte format. Everything after that builds on the IGHW
section table iterator. App-side concerns (cache, frontend, updater)
continue in the rest of `internal/app/`.

## Per-engine support matrix

The `LevelLayout` enum (`level_layout.rs`) dispatches to one of three
parser families based on which marker file lives in the level folder:

| Layout marker | `LevelLayout` | Games | Moby parser | Anim decode |
|---|---|---|---|---|
| `assetlookup.dat` | `V2` | R2, R3, R&C: FFA, R&C: A4O | `moby.rs` | animset-based via `decode_clips_for_moby` |
| `ps3levelmain.dat` | `Rfom` | Resistance: Fall of Man | `moby_rfom.rs` | inline anim offsets via `decode_clips_for_moby_inline` |
| `main.dat` | `Tod` | R&C: Tools of Destruction | `moby_old.rs` | currently disabled (T-pose only) — frame format unsolved |

All three parsers produce the same `MobyAsset` struct so the cache
pipeline, GLB writer, and frontend stay engine-agnostic. The split is
necessary because each engine era has different on-disk byte layouts
for the moby/tie/texture/shader containers.
