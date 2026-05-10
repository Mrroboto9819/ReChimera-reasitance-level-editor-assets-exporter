# 03 — Frontend & modal preview

Source: `apps/desktop/src/`.

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
```

Layout state is in Redux Toolkit (`src/store.ts`) with `redux-persist`
hydrating user preferences from `localStorage`.

## Tab system

`TabContainer.tsx` manages a panel of tabs:

- HTML5 drag-and-drop between panels (`onTabDragStart` → set
  `application/x-rechimera-tab` MIME → drop on another `TabContainer`
  fires `moveTab` redux action).
- v-if rendering — only the active tab's view is mounted, so inactive
  3D views don't consume CPU/GPU. Switching tabs unmounts the previous
  view and remounts the new one (state inside views is not preserved
  across tab switches).
- "+" button opens a picker of available views to add.

Drag-and-drop only works because we set `dragDropEnabled: false` on the
Tauri window — the OS-level file-drop overlay would otherwise capture
all drag events. File drops still work via
`getCurrentWebview().onDragDropEvent()` independently.

## 3D Viewport

`Viewport.tsx` is the main scene:

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

`AssetPreview.tsx` decides how to render a moby/tie selection:

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

`GlbPreview.tsx`:

1. Calls `readCachedBytes(folder, "mobys/0x{tuid}.glb")` and parses with
   `THREE.GLTFLoader().parse(bytes, "", onLoad)`.
2. Renders `gltf.scene` via `<primitive object={...}>` inside a `<Canvas>`.
3. Drives an `AnimationMixer` so `gltf.animations` (or any extra clip
   the user plays) loops on the rig.
4. Top control bar: a custom portal-rendered `<Select>` (auto up/down
   placement, fixed-position so it can render outside modal bounds)
   showing the GLB's built-in clips + any extras the user has loaded.
5. Burger button → side panel (`<aside>`) listing **every animset in
   the level** via `listAnimsets(folder)`. Each animset is collapsible.
   Each clip row has:
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

`ExportOptionsModal.tsx` — a 2-step flow:

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

## Updater UI

`useUpdater.ts` handles the in-app update lifecycle:

- On mount, schedules a check after 3s. Recheck every 6h.
- "Remind me later" persists 24h in `localStorage`.
- On Windows: `available` → button calls `update.downloadAndInstall()`,
  shows a download-progress indicator, then `relaunch()`.
- On macOS / Linux: `available.manual = true` → button opens the
  GitHub Releases page via `@tauri-apps/plugin-opener`. Auto-update
  isn't yet built/tested for those platforms; users replace the binary
  manually.

## Custom select component

`Select.tsx` — portal-rendered dropdown used in `GlbPreview`:

- Trigger button + portal-rendered `<ul>` list.
- Position via `getBoundingClientRect`; auto-flips above the trigger if
  there isn't enough room below.
- Fixed-position so it renders outside any clipping ancestor (essential
  inside modals and inside small panels with `overflow: hidden`).
- Closes on outside click and Escape.
