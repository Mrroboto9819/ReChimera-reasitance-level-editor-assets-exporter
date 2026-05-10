# 03 — Frontend & modal preview

Source: `apps/desktop/src/`.

## Folder layout

```
apps/desktop/src/
├── App.tsx                      # top-level layout + state wiring
├── store.ts                     # Redux Toolkit + redux-persist
├── api.ts                       # typed Tauri command wrappers
├── viewMeta.ts                  # registry of available views
├── views/                       # large content surfaces (mounted into tabs)
│   ├── Viewport.tsx             # main 3D scene
│   ├── AssetPreview.tsx         # routes between JSON / GLB preview
│   ├── GlbPreview.tsx           # cached-GLB modal preview + skeleton overlay
│   ├── Hierarchy.tsx
│   ├── Inspector.tsx
│   ├── BottomPanel.tsx
│   ├── MenuBar.tsx, TitleBar.tsx, Toolbar.tsx, StatusBar.tsx
│   ├── TabContainer.tsx, Splash.tsx
│   └── PsarcTools.tsx
└── components/                  # modals + reusable widgets
    ├── Modal.tsx                # base modal with header / subheader / body / footer slots
    ├── OpenLevelModal.tsx       # 4-step wizard (Game → Source → optional PSARC → Open)
    ├── PsarcModal.tsx           # standalone PSARC extractor (advanced flow)
    ├── ExportOptionsModal.tsx, CacheLibraryModal.tsx
    ├── DocsModal.tsx, AboutModal.tsx, SettingsModal.tsx
    ├── CharacterPreviewModal.tsx, GltfCharacterModal.tsx
    ├── LoadProgress.tsx, ExportProgress.tsx, FpsOverlay.tsx
    ├── SoundPlayer.tsx, UpdateChecker.tsx
    └── Select.tsx               # portal-rendered dropdown
```

`views/` are full panels that the tab system can mount; `components/`
are modals and reusable widgets that overlay or compose with the tab
content.

## Top-level layout

`App.tsx` mounts:

```
TitleBar (window controls + Update button)
  Toolbar (project / file / view actions)
  Workspace
    PanelGroup (horizontal splitter)
      Panel: TabContainer (left)
      Panel: PanelGroup (vertical) [center]
        Panel: TabContainer (top)        ← Viewport / GLB previews live here
        Panel: BottomPanel               ← Sound player + console
      Panel: TabContainer (right)
  ExportOptionsModal (lazy)
  CacheLibraryModal (lazy)
  OpenLevelModal (lazy)
```

Layout state is in Redux Toolkit (`src/store.ts`) with `redux-persist`
hydrating user preferences from `localStorage`.

On cold start, `App.tsx` shows `Splash.tsx` and then auto-opens
`OpenLevelModal` so the user lands directly in the game-selection step
instead of an empty viewport. The selected game is **not persisted** —
every fresh launch starts the wizard from step 1.

## Tab system

`TabContainer.tsx` manages a panel of tabs:

- HTML5 drag-and-drop between panels (`onTabDragStart` → set
  `application/x-rechimera-tab` MIME → drop on another `TabContainer`
  fires `moveTab` redux action).
- v-if rendering — only the active tab's view is mounted, so inactive
  3D views don't consume CPU/GPU. Switching tabs unmounts the previous
  view and remounts the new one (state inside views is not preserved
  across tab switches).
- "+" button opens a picker of available views to add (powered by
  `viewMeta.ts`).

Drag-and-drop only works because we set `dragDropEnabled: false` on the
Tauri window — the OS-level file-drop overlay would otherwise capture
all drag events. File drops still work via
`getCurrentWebview().onDragDropEvent()` independently.

## Open-level wizard

`components/OpenLevelModal.tsx` — a stepped wizard with up to four steps:

```
[1 Game] ───── [2 Source] ───── [3 PSARC?] ───── [4 Open]
```

The PSARC step is conditionally inserted — it only appears when the
user picks the "Extract a PSARC" card on step 2 (or if a previous
extraction already ran in this session).

### Step 1 — Game

Games are grouped by **franchise** (`FRANCHISES` array) and rendered
as cards inside per-franchise sections:

| Franchise | Games |
|---|---|
| Resistance | Resistance: Fall of Man · Resistance 2 · Resistance 3 |
| Ratchet & Clank | R&C: Tools of Destruction · R&C: Full Frontal Assault · R&C: All 4 One |

Each game card carries **capability badges** drawn from
`GAMES[i].capabilities`. Each capability resolves to one of four
states:

| State | Color | Meaning |
|---|---|---|
| `ok` | green | feature works end-to-end |
| `partial` | amber | works with caveats (e.g. some textures missing) |
| `tpose` | blue | rig + mesh load, animations export at rest pose |
| `missing` | grey | feature not supported on this game yet |

Capabilities cover: levels, mobys, ties, textures, skeleton,
animations, gameplay, sound. The badges let the user see at a glance
which games exit the pipeline cleanly before they pick one.

### Step 2 — Source

Two cards: **Open extracted folder** (the normal path — point at a
folder that already has `assetlookup.dat` / `ps3levelmain.dat` /
`main.dat`) or **Extract a PSARC** (jump into the PSARC step).

### Step 3 — PSARC (conditional)

A guided form:

- "PSARC archive" file picker → `psarcInput`
- "Extract to" folder picker → `psarcOutput`
- **Extract** button → calls `psarcExtractStream(input, output, onEvent)`
  with a per-file progress channel
- Per-game help text reminding the user which archives to extract:
  - V2 / RCFFA / RCA4O: `level_cached.psarc` **and** `level_uncached.psarc`
  - RFOM: `game.psarc` first
  - TOD: varies per disc
- After a successful extraction, the **Continue →** button advances to
  step 4 with `psarcOutput` pre-filled as the level folder.

Re-opens of the wizard reset PSARC state so a stale extraction path
never leaks into a fresh flow.

### Step 4 — Open

Folder picker pre-filled from PSARC output (if applicable). Recent
levels are stored **per game** under `localStorage` key
`rechimera.recentLevelsByGame` so each game shows its own recent list.

The stepbar uses GSAP timeline animations: connected red circles,
white text on the active/done state, grey on pending. The component
sits in `Modal`'s new `subheader` slot so it stays pinned at the top
while the body scrolls.

## 3D Viewport

`views/Viewport.tsx` is the main scene:

- `<Canvas>` from `@react-three/fiber`.
- `OrbitControls` for camera, custom Move/Rotate/Scale gizmos for edits.
- Per-instance materials lit with a hemisphere light (no scene lighting yet).
- Selection state (single / ctrl-toggle / shift-range) lives in Redux.
- Edit overrides (per-instance T/R/S deltas) also in Redux, applied at
  render time without mutating the cached source data.

The Three.js canvas is wrapped in CSS that always shrinks with its
parent (`.tab-panel.active { min-width: 0; min-height: 0; overflow: hidden; }`).
Without `min-width: 0`, flex items refuse to shrink below the canvas's
intrinsic width — which is whatever it was first sized to — so the
canvas would bleed across into adjacent panels when the user drags the
splitter. Now it resizes cleanly via R3F's internal ResizeObserver.

## Asset preview routing

`views/AssetPreview.tsx` decides how to render a moby/tie selection:

```tsx
if (cacheFolder && (instance.kind === "moby" || instance.kind === "tie")) {
    return <GlbPreview folder={cacheFolder} assetTuidHex={...} kind={...}
                       exportPicks={...} onExportPicksChange={...} />;
}
// else: fall back to JSON-driven PreviewScene (used by Inspector)
```

Cache modal → `GlbPreview` (loads the cached GLB). Inspector →
JSON-driven `PreviewScene` (faster for the inline inspector mini-render,
no GLB file fetch needed).

## GLB preview + burger menu

`views/GlbPreview.tsx`:

1. Calls `readCachedBytes(folder, "mobys/0x{tuid}.glb")` and parses with
   `THREE.GLTFLoader().parse(bytes, "", onLoad)`.
2. Renders `gltf.scene` via `<primitive object={...}>` inside a `<Canvas>`.
3. Adds a `THREE.SkeletonHelper` overlay (`0x00ff88` lines, depth-test
   disabled) so the rig is visible on every preview, every game.
4. Drives an `AnimationMixer` so `gltf.animations` (or any extra clip
   the user plays) loops on the rig.
5. Top control bar: a custom portal-rendered `<Select>` (auto up/down
   placement, fixed-position so it can render outside modal bounds)
   showing the GLB's built-in clips + any extras the user has loaded.
6. Burger button → side panel (`<aside>`) listing **every animset in
   the level** via `listAnimsets(folder)`. On RFOM and TOD this list
   is empty (animsets only exist on V2 layouts), so the burger menu
   only shows the GLB's built-in clips. Each clip row has:
   - **▶ play button** — calls `decodeAnimsetClip` on demand, builds a
     `THREE.AnimationClip` via `animClipBuilder.ts:buildAnimationClip`
     (track names `bone_{i}.{position|quaternion|scale}` retarget onto
     the loaded scene).
   - **☑ checkbox** — adds the clip to the export picks (and to the
     dropdown, so it's playable).
   - **Per-animset tri-state checkbox** — selects all clips at once.
   - **Master "All animsets" tri-state** — selects every clip in every
     animset.
   - **Expand all / Collapse all** — toggle every animset's
     visibility.

The picks state lives one level up in `CacheLibraryModal` so the burger
menu and the Export modal share the same selections.

## Multi-step Export modal

`components/ExportOptionsModal.tsx` — a 2-step flow:

**Step 1 — Scope**:
- ☑ Mesh (vertex/index buffers)
- ☑ Materials & textures (with quality presets: Low 256 / Medium 512 / High 1024 / Original)
- ☑ Armature (bones + IBMs — disabled if asset has no skeleton)

**Step 2 — Animations**:
- Lists every animset; the asset's primary one is highlighted and
  pre-checked. Pre-fills with whatever the user already ticked in the
  burger menu (`initialExtraPicks`).
- Tri-state checkboxes per animset. "All / None" buttons. Expandable
  clip rows with `(num_frames f @ frame_rate fps · loop?)` metadata.
- Final button: "Export (N clips)" → opens save dialog → invokes
  `exportMobyGlbWithOptions(folder, tuid, path, options)`.

The export pipeline is layout-aware on the Rust side, so the same
modal works on every supported game (V2 / RFOM / TOD). For TOD the
animation step still lists clips but they export as T-pose because
the per-frame format is unsolved.

## Updater UI

`components/UpdateChecker.tsx` + `useUpdater.ts` handle the in-app
update lifecycle:

- On mount, schedules a check after 3s. Recheck every 6h.
- "Remind me later" persists 24h in `localStorage`.
- On Windows: `available` → button calls `update.downloadAndInstall()`,
  shows a download-progress indicator, then `relaunch()`.
- On macOS / Linux: `available.manual = true` → button opens the
  GitHub Releases page via `@tauri-apps/plugin-opener`. Auto-update
  isn't yet built/tested for those platforms; users replace the binary
  manually.

## Custom select component

`components/Select.tsx` — portal-rendered dropdown used in `GlbPreview`:

- Trigger button + portal-rendered `<ul>` list.
- Position via `getBoundingClientRect`; auto-flips above the trigger if
  there isn't enough room below.
- Fixed-position so it renders outside any clipping ancestor (essential
  inside modals and inside small panels with `overflow: hidden`).
- Closes on outside click and Escape.
