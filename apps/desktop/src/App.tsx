import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// Static logo URL resolved by Vite at build time. Used here for the
// persistent title-bar logo so the brand is visible even when the
// main thread is blocked during heavy level loading — the <img> is
// rendered once on first paint and the browser caches the bytes;
// nothing in the runtime can "lose" it.
import brandIconUrl from "../icon.png?url";
import { Channel } from "@tauri-apps/api/core";
import {
  cacheStatus,
  dumpSoundBank,
  readCachedManifest,
  reextractLevelCache,
  extractLevelSounds,
  extractLevelStreamSounds,
  extractLevelToCache,
  extractRawStreamingSounds,
  levelLayout,
  listAnimsetClips,
  listEntitiesGltfs,
  listGltfsInFolder,
  getLevelTexturesBulk,
  listLevelFiles,
  listLevelSounds,
  openLevel,
  streamLevelMeshes,
  wavBlobUrl,
  type AnimsetSummary,
  type AssetMeshes,
  type CacheEvent,
  type CacheStatus,
  type ExtractedSound,
  type GltfFile,
  type Instance,
  type LevelFile,
  type LevelMeshes,
  type LevelSummary,
  type PhaseId,
  type SoundEntry,
  type TextureBlobMap,
  type TexturePayload,
  type UFragBounds,
  type UFragMesh,
} from "./api";
import { AboutModal } from "./AboutModal";
import { BottomPanel, type ConsoleEntry } from "./BottomPanel";
import { CacheLibraryModal } from "./CacheLibraryModal";
import { GltfCharacterModal } from "./GltfCharacterModal";
import { RawCharacterModal } from "./RawCharacterModal";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";
import { LoadProgress, type LoadPhaseState } from "./LoadProgress";
import { Menu, MenuBar, MenuCheckItem, MenuItem, MenuSpacer } from "./MenuBar";
import { Modal } from "./Modal";
import { OpenLevelModal } from "./OpenLevelModal";
import { PsarcModal } from "./PsarcModal";
import { SettingsModal } from "./SettingsModal";
import { useApplySettings } from "./useApplySettings";
import { SoundPlayer, type NowPlaying } from "./SoundPlayer";
import { Splash } from "./Splash";
import { UpdateChecker } from "./UpdateChecker";
import { useUpdater } from "./useUpdater";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Toolbar } from "./Toolbar";
import { Viewport } from "./Viewport";
import { useEdits } from "./edits";
import {
  exportToGlb,
  pickGlbExportPath,
  type ExportProgressState,
} from "./export";
import { ExportProgress } from "./ExportProgress";
import { useSelection } from "./selection";
import { APP_VERSION, APP_REPO_URL, APP_ISSUES_URL, openExternal } from "./version";
import {
  resetAll,
  setBottomPct,
  setHierarchyPct,
  setInspectorPct,
  toggleConsoleCollapsed,
  toggleHierarchyHidden,
  toggleInspectorHidden,
  toggleView,
  useAppDispatch,
  useAppSelector,
  type ViewSettingsState,
} from "./store";

export function App() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const view = useAppSelector((s) => s.view);
  const layout = useAppSelector((s) => s.layout);

  useApplySettings();

  useEffect(() => {
    const panel = bottomPanelRef.current;
    if (!panel) return;
    if (layout.consoleCollapsed) {
      if (!panel.isCollapsed()) panel.collapse();
    } else {
      if (panel.isCollapsed()) panel.expand();
    }
  }, [layout.consoleCollapsed]);

  useEffect(() => {
    const panel = hierarchyPanelRef.current;
    if (!panel) return;
    if (layout.hierarchyHidden) {
      if (!panel.isCollapsed()) panel.collapse();
    } else {
      if (panel.isCollapsed()) panel.expand();
    }
  }, [layout.hierarchyHidden]);

  useEffect(() => {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    if (layout.inspectorHidden) {
      if (!panel.isCollapsed()) panel.collapse();
    } else {
      if (panel.isCollapsed()) panel.expand();
    }
  }, [layout.inspectorHidden]);

  const [summary, setSummary] = useState<LevelSummary | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [ufrags, setUFrags] = useState<UFragBounds[]>([]);
  const [meshes, setMeshes] = useState<LevelMeshes | null>(null);
  // Texture bytes — fetched in one binary IPC call after the streaming
  // pipeline finishes emitting metadata events. Keyed by texture id.
  // Null until the bulk fetch resolves; consumers (Viewport, export,
  // AssetPreview, RawCharacterModal) treat null as "no textures yet"
  // and render with placeholder materials until it arrives.
  const [textureBlobs, setTextureBlobs] = useState<TextureBlobMap | null>(null);
  const selection = useSelection(useCallback(() => instances, [instances]));
  const edits = useEdits();
  const bottomPanelRef = useRef<ImperativePanelHandle>(null);
  const hierarchyPanelRef = useRef<ImperativePanelHandle>(null);
  const inspectorPanelRef = useRef<ImperativePanelHandle>(null);
  const primaryInstance = selection.primary
    ? instances.find((i) => i.tuid === selection.primary) ?? null
    : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      switch (e.code) {
        case "Numpad1":
          setViewSnap((s) => ({ direction: "front", version: s.version + 1 }));
          e.preventDefault();
          return;
        case "Numpad3":
          setViewSnap((s) => ({ direction: "right", version: s.version + 1 }));
          e.preventDefault();
          return;
        case "Numpad7":
          setViewSnap((s) => ({ direction: "top", version: s.version + 1 }));
          e.preventDefault();
          return;
      }
      if (!selection.primary) return;
      switch (e.key.toLowerCase()) {
        case "g":
          edits.setMode("translate");
          e.preventDefault();
          break;
        case "r":
          edits.setMode("rotate");
          e.preventDefault();
          break;
        case "s":
          edits.setMode("scale");
          e.preventDefault();
          break;
        case "f":
          setFocusVersion((v) => v + 1);
          e.preventDefault();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection.primary, edits.setMode]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadPhase, setLoadPhase] = useState<LoadPhaseState | null>(null);
  const [meshLoadPhase, setMeshLoadPhase] = useState<LoadPhaseState | null>(null);
  const [completedPhases, setCompletedPhases] = useState<PhaseId[]>([]);
  const [consoleLog, setConsoleLog] = useState<ConsoleEntry[]>([]);
  const updater = useUpdater();
  // About / credits modal — opened from `Help → About ReChimera…`.
  // Rendered always (not gated on level state) so Help is reachable
  // from a fresh splash.
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [openLevelModalOpen, setOpenLevelModalOpen] = useState(false);
  const [psarcModalOpen, setPsarcModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [exportState, setExportState] = useState<ExportProgressState | null>(null);
  // (Removed: legacy `<level>/character/` filesystem lookup state. The
  // path-grouped Asset Library tree built from `assetlookup.dat` is
  // the canonical browser now — no filesystem dependency.)
  // GLTF library — files from InsomniaToolset's extract_assets command.
  // Preferred path because they already include skeleton + animations.
  const [gltfLibrary, setGltfLibrary] = useState<GltfFile[] | null>(null);
  const [gltfLibraryStatus, setGltfLibraryStatus] = useState<string | null>(null);
  const [previewGltfFile, setPreviewGltfFile] = useState<GltfFile | null>(null);
  // Browseable list of every animset in the open level. Loaded once on
  // level open via `list_animset_clips`. Drives the Hierarchy's
  // "Animations" section — user clicks any clip to override the active
  // playback on the primary-selected character.
  const [animsetClips, setAnimsetClips] = useState<AnimsetSummary[]>([]);
  // When non-null, the primary-selected SkinnedMesh plays this clip
  // instead of the moby's own `animset_hash` clip. Cleared on selection
  // change. Also fed into the export pipeline so the chosen clip lands
  // in the .glb as a Blender Action.
  const [overrideAnimsetHash, setOverrideAnimsetHash] = useState<string | null>(null);
  // Asset library preview — when non-null, the RawCharacterModal opens
  // for this asset_tuid. Sourced from a Hierarchy click on the Asset
  // Library tree; lets the user preview ANY asset from `assetlookup.dat`
  // (including ones not placed in the world) with mesh + textures +
  // animations + export.
  const [previewAssetTuid, setPreviewAssetTuid] = useState<string | null>(null);
  // Level sounds — listed cheaply on level open from `resident_sound.dat`
  // headers. Drives the Hierarchy's Sounds section. The actual WAV
  // bytes are fetched lazily on first click via `extractLevelSounds`
  // and cached so subsequent clicks just re-find the entry by name.
  const [levelSounds, setLevelSounds] = useState<SoundEntry[]>([]);
  // File-level inventory — every notable file in the level folder
  // categorized by type, including ones we don't parse yet (streaming
  // dialogue, lighting, vfx, cinematics). Drives the Hierarchy's
  // "Files" section, which acts as a survey of the level's full
  // contents + a visible roadmap of what's left to port.
  const [levelFiles, setLevelFiles] = useState<LevelFile[]>([]);
  // Disk cache (`<level>/_rechimera_cache/`) — populated in the background
  // after openLevel succeeds. `null` until we've checked or extracted; when
  // populated the StatusBar shows per-kind counts and downstream UIs
  // (Library modal, GLB export) can `read_cached_asset` without going
  // through the streaming pipeline.
  const [cacheState, setCacheState] = useState<CacheStatus | null>(null);
  // Cache manifest — populated alongside cacheState when extraction
  // finishes (or on level open if cache already exists). Drives the
  // Hierarchy's "Cache" section so the user can browse the extracted
  // assets without first opening the Cache Library modal.
  const [cacheManifest, setCacheManifest] =
    useState<import("./api").CacheManifest | null>(null);
  const [cacheProgress, setCacheProgress] = useState<{
    phase: "mobys" | "ties" | "textures";
    current: number;
    total: number;
  } | null>(null);
  const [cacheLibraryOpen, setCacheLibraryOpen] = useState(false);
  // Cache prompt — when a level is opened that already has `_rechimera_cache/`,
  // set this to `{ sum, status }` so the user can pick between using the
  // existing cache (skip re-extraction; just load the manifest) or rebuilding
  // it from scratch (`reextract_level_cache`). Null = no decision pending.
  const [cachePrompt, setCachePrompt] = useState<{
    sum: LevelSummary;
    status: CacheStatus;
  } | null>(null);
  // Per-source cache keyed by `${kind}:${filename}`. Separates bank
  // and stream extracts so re-clicking a stream sound doesn't trigger
  // a fresh bank decode and vice-versa. Stream extracts can be slow
  // (multi-GB streaming files) so caching matters even more there.
  const [extractedSoundsCache, setExtractedSoundsCache] = useState<
    Map<string, ExtractedSound[]>
  >(new Map());
  // Currently-playing sound. State (not ref) so the SoundPlayer can
  // re-render when it changes — the player UI subscribes to the live
  // Audio element's events for transport state. Setting to null both
  // stops playback (handled in handlePlaySound / handleClosePlayer)
  // and hides the player bar.
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const playingSoundName = nowPlaying?.name ?? null;

  // (handlePlaySound is defined further down — needs `log` + `summary`
  // both declared first. See block right after `log = useCallback(...)`.)

  // Cleanup any in-flight audio when the App unmounts. Captured into
  // a ref-style closure: we read `nowPlaying` at unmount time via a
  // ref mirror so we don't have to re-run this effect on every state
  // change. Without the mirror, putting `nowPlaying` in deps would
  // tear down the audio on every play/pause UI tick.
  const nowPlayingMirror = useRef<NowPlaying | null>(null);
  nowPlayingMirror.current = nowPlaying;
  useEffect(() => {
    return () => {
      const np = nowPlayingMirror.current;
      if (np) {
        np.audio.pause();
        URL.revokeObjectURL(np.blobUrl);
      }
    };
  }, []);
  // Bumps every time the user explicitly asks to re-frame on the selection
  // (e.g. via the Inspector's "Go to" button). The Viewport's CameraFocus
  // watches it as a dep so it re-runs the focus tween even when the
  // primary selection hasn't changed.
  const [focusVersion, setFocusVersion] = useState(0);
  const [viewSnap, setViewSnap] = useState<{
    direction: "front" | "right" | "top" | null;
    version: number;
  }>({ direction: null, version: 0 });
  // Splash screen visibility. Stays up for at least 1.2s after mount so
  // the user actually sees it instead of a flash. Goes to false → Splash
  // runs its GSAP fade-out → onExit unmounts it.
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashMounted, setSplashMounted] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setSplashVisible(false), 1200);
    return () => clearTimeout(id);
  }, []);

  const log = useCallback(
    (level: ConsoleEntry["level"], msg: string) =>
      setConsoleLog((cur) => [...cur, { ts: Date.now(), level, msg }]),
    [],
  );

  useEffect(() => {
    if (error) log("error", error);
  }, [error, log]);

  const handleExportSelection = useCallback(async () => {
    if (selection.ids.size === 0 || !meshes) return;

    // Step 1: open the OS save dialog FIRST, before any in-app modal.
    // The progress modal we show after picking covers the screen and on
    // Windows / Linux the OS save dialog can end up behind it without
    // ever getting focus — opening the picker first avoids the trap.
    let path: string | null = null;
    try {
      const selectedInstances = instances.filter((i) =>
        selection.ids.has(i.tuid),
      );
      path = await pickGlbExportPath(selectedInstances);
    } catch (err) {
      log("error", `Save dialog failed: ${err}`);
      return;
    }
    if (!path) {
      log("info", "Export cancelled");
      return;
    }

    // Step 2: now show the modal and run the actual encode + write.
    setExportState({
      phase: "preparing",
      label: "Building scene from selection",
      fraction: 0,
      detail: path,
    });
    try {
      const result = await exportToGlb(
        selection.ids,
        instances,
        meshes,
        textureBlobs,
        path,
        (state) => setExportState(state),
        summary?.folder ?? null,
        overrideAnimsetHash,
      );
      log(
        "ok",
        `Exported ${result.bytes.toLocaleString()} bytes → ${result.path}`,
      );
    } catch (err) {
      log("error", `Export failed: ${err}`);
      setExportState({
        phase: "done",
        label: `Export failed: ${err}`,
        fraction: 0,
        cancelled: true,
      });
    }
  }, [selection.ids, instances, meshes, log]);

  /// Export a single cached library asset to GLB. The cache holds
  /// AssetMeshes for assets that aren't placed in the level (characters,
  /// weapons, etc.); we wrap one in a synthetic Instance + LevelMeshes so
  /// the existing exportToGlb pipeline can run unchanged. Animset clips
  /// are still resolved live from `animsets.dat` via the export's
  /// internal `fetchAnimsetClip` call, so the resulting .glb has the
  /// rig's full animation library baked in as Blender Actions.
  const handleCacheLibraryExport = useCallback(
    async (asset: AssetMeshes, textureBlobs: TextureBlobMap) => {
      // Cache stores both moby and tie JSONs in the same shape; the
      // export pipeline only cares which of `moby_assets` / `tie_assets`
      // it appears in. Detect by skeleton presence — ties are static
      // and have none.
      const isTie = asset.skeleton == null;
      const synthInstance: Instance = {
        tuid: `${asset.asset_tuid}#cache`,
        asset_tuid: asset.asset_tuid,
        kind: isTie ? "tie" : "moby",
        name: asset.name || asset.asset_tuid,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
      const synthMeshes: LevelMeshes = {
        moby_assets: isTie ? [] : [asset],
        tie_assets: isTie ? [asset] : [],
        ufrag_meshes: [],
        textures: [...textureBlobs.keys()].map((id) => ({
          id,
          width: 0,
          height: 0,
        })),
      };
      let path: string | null = null;
      try {
        path = await pickGlbExportPath([synthInstance]);
      } catch (err) {
        log("error", `Save dialog failed: ${err}`);
        return;
      }
      if (!path) {
        log("info", "Export cancelled");
        return;
      }
      setExportState({
        phase: "preparing",
        label: "Building scene from cached asset",
        fraction: 0,
        detail: path,
      });
      try {
        const result = await exportToGlb(
          new Set([synthInstance.tuid]),
          [synthInstance],
          synthMeshes,
          textureBlobs.size > 0 ? textureBlobs : null,
          path,
          (state) => setExportState(state),
          summary?.folder ?? null,
          null,
        );
        log(
          "ok",
          `Exported ${result.bytes.toLocaleString()} bytes → ${result.path}`,
        );
      } catch (err) {
        log("error", `Export failed: ${err}`);
        setExportState({
          phase: "done",
          label: `Export failed: ${err}`,
          fraction: 0,
          cancelled: true,
        });
      }
    },
    [summary?.folder, log],
  );

  const toggle = useCallback(
    (key: keyof ViewSettingsState) => dispatch(toggleView(key)),
    [dispatch],
  );

  // Click a sound row → play it. First click on any sound triggers a
  // bulk extraction (the whole bank decoded server-side, returned as
  // a list of WAV blobs). After that, we just look up the WAV by name
  // and play it. Re-clicking the same sound stops it; clicking a
  // different one swaps. Single-Audio policy keeps the playback
  // model trivial — no overlapping clips.
  const handlePlaySound = useCallback(
    async (name: string) => {
      // Same sound clicked again → stop playback + close player.
      if (nowPlayingMirror.current?.name === name) {
        const np = nowPlayingMirror.current;
        np.audio.pause();
        URL.revokeObjectURL(np.blobUrl);
        setNowPlaying(null);
        return;
      }
      // Stop the previous sound (if any) before starting a new one.
      if (nowPlayingMirror.current) {
        const prev = nowPlayingMirror.current;
        prev.audio.pause();
        URL.revokeObjectURL(prev.blobUrl);
      }

      if (!summary) return;
      // Find the SoundEntry to know whether this is a bank or stream
      // sound + which source file backs it. Different cache keys for
      // each kind keep bank and stream extracts independent.
      const entry = levelSounds.find((s) => s.name === name);
      if (!entry) {
        log("warn", `Sound metadata missing: ${name}`);
        return;
      }
      const cacheKey = `${entry.kind}:${entry.source}`;
      let extracted: ExtractedSound[];
      const cached = extractedSoundsCache.get(cacheKey);
      if (cached) {
        extracted = cached;
      } else {
        try {
          // Dispatch on entry.kind:
          //   bank   → in-bank SCREAM, source = bank file
          //   stream → bank-paired stream, source = bank file (sibling
          //            stream file resolved server-side)
          //   raw    → orphan stream (no bank in folder), source =
          //            stream file itself; brute-force header scan
          if (entry.kind === "raw") {
            extracted = await extractRawStreamingSounds(summary.folder, entry.source);
            log(
              "ok",
              `Raw streams decoded from ${entry.source}: ${extracted.length} WAVs`,
            );
          } else if (entry.kind === "stream") {
            extracted = await extractLevelStreamSounds(summary.folder, entry.source);
            log(
              "ok",
              `Stream sounds decoded for ${entry.source}: ${extracted.length} WAVs`,
            );
          } else {
            extracted = await extractLevelSounds(summary.folder);
            log("ok", `Sound bank decoded: ${extracted.length} WAVs`);
          }
          const fresh = extracted;
          setExtractedSoundsCache((prev) => {
            const next = new Map(prev);
            next.set(cacheKey, fresh);
            return next;
          });
        } catch (e) {
          log("error", `Sound extract failed: ${e}`);
          // Self-diagnose: dump the bank structure into the Console so
          // bad pointers / wrong section IDs are visible without
          // manual hexdumping. Skip for "raw" — that path doesn't go
          // through a SCREAM bank, so the dumper has nothing to read.
          if (entry.kind !== "raw" && summary) {
            dumpSoundBank(summary.folder, entry.source)
              .then((dump) => log("info", `Bank dump for ${entry.source}:\n${dump}`))
              .catch((de) => log("warn", `Bank dump failed: ${de}`));
          }
          return;
        }
      }

      const found = extracted.find((s) => s.name === name);
      if (!found) {
        log("warn", `Sound not found: ${name}`);
        return;
      }
      const blobUrl = wavBlobUrl(found.wav_b64);
      const audio = new Audio(blobUrl);
      audio.addEventListener("ended", () => {
        // After a track finishes, leave the player visible so the
        // user can re-play / export — only revoke the blob URL +
        // close if they explicitly dismissed it elsewhere.
      });
      audio.play().catch((e) => log("error", `Audio play failed: ${e}`));
      setNowPlaying({
        name,
        source: entry.source,
        audio,
        blobUrl,
        entry: found,
      });
    },
    [extractedSoundsCache, levelSounds, summary, log],
  );

  /** Manual GLTF library entry point. Opens an OS folder picker, scans
   *  the chosen folder recursively for .gltf/.glb, and replaces the
   *  current GLTF library in the Hierarchy. Useful when auto-detection
   *  doesn't find your specific InsomniaToolset extract layout. */
  const handleBrowseGltfFolder = useCallback(async () => {
    let picked: string | null = null;
    try {
      const result = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a GLTF library folder",
      });
      picked = typeof result === "string" ? result : null;
    } catch (err) {
      log("error", `GLTF folder picker failed: ${err}`);
      return;
    }
    if (!picked) return;

    setGltfLibraryStatus(`Scanning ${picked}…`);
    try {
      const lib = await listGltfsInFolder(picked);
      if (lib.files.length === 0) {
        log("warn", `No .gltf/.glb files in ${picked}`);
        setGltfLibrary([]);
      } else {
        log("ok", `Loaded ${lib.files.length} GLTF files from ${picked}`);
        setGltfLibrary(lib.files);
      }
    } catch (e) {
      log("error", `GLTF scan failed: ${e}`);
      setGltfLibrary(null);
    } finally {
      setGltfLibraryStatus(null);
    }
  }, [log]);

  // cacheMode controls what happens after streaming "done" fires:
  //   "auto"            — extract only if no fresh cache exists (legacy default)
  //   "use-cache"       — never extract; just load the existing manifest
  //   "force-reextract" — wipe the cache and rebuild it from disk
  // The Cache prompt at level-open chooses one of the latter two; programmatic
  // callers (re-load after edits) leave it at "auto".
  type CacheMode = "auto" | "use-cache" | "force-reextract";
  const loadFullMeshes = useCallback(async (
    sum: LevelSummary,
    cacheMode: CacheMode = "auto",
  ) => {
    setError(null);
    setBusy(true);
    setMeshes(null);
    setTextureBlobs(null);
    setMeshLoadPhase({
      phase: "layout",
      label: "Preparing mesh stream",
      current: 0,
      total: 1,
      chunkSize: 1,
    });
    setCompletedPhases([]);

    // Give the proxy editor a paint before starting the expensive path.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const acc: LevelMeshes = {
      moby_assets: [],
      tie_assets: [],
      ufrag_meshes: [],
      textures: [],
    };
    let flushPending = false;
    const flushMeshes = () => {
      setMeshes({
        moby_assets: [...acc.moby_assets],
        tie_assets: [...acc.tie_assets],
        ufrag_meshes: [...acc.ufrag_meshes],
        textures: [...acc.textures],
      });
    };
    const scheduleMeshFlush = () => {
      if (flushPending) return;
      flushPending = true;
      requestAnimationFrame(() => {
        flushPending = false;
        flushMeshes();
      });
    };

    const completedLocal: PhaseId[] = [];
    let activePhase: PhaseId | null = null;

    try {
      await streamLevelMeshes(sum.folder, (e) => {
        switch (e.type) {
          case "phase":
            if (activePhase && activePhase !== e.phase) {
              completedLocal.push(activePhase);
              log("ok", `Phase complete: ${activePhase}`);
            }
            activePhase = e.phase;
            setMeshLoadPhase({
              phase: e.phase,
              label: e.label,
              current: 0,
              total: e.total,
              chunkSize: e.chunk_size,
            });
            setCompletedPhases([...completedLocal]);
            log("info", `${e.label} (${e.total.toLocaleString()})`);
            break;
          case "progress":
            setMeshLoadPhase((p) => (p ? { ...p, current: e.current } : p));
            break;
          case "moby_asset":
            acc.moby_assets.push(e.asset as AssetMeshes);
            scheduleMeshFlush();
            break;
          case "tie_asset":
            acc.tie_assets.push(e.asset as AssetMeshes);
            scheduleMeshFlush();
            break;
          case "ufrag_mesh":
            acc.ufrag_meshes.push(e.mesh as UFragMesh);
            scheduleMeshFlush();
            break;
          case "texture":
            acc.textures.push(e.texture as TexturePayload);
            scheduleMeshFlush();
            break;
          case "done":
            if (activePhase) completedLocal.push(activePhase);
            setCompletedPhases([...completedLocal]);
            flushMeshes();
            setMeshLoadPhase(null);
            log(
              "ok",
              `Level decode finished: ${acc.moby_assets.length} mobys, ${acc.tie_assets.length} ties, ${acc.ufrag_meshes.length} terrain, ${acc.textures.length} textures`,
            );
            // Fetch every texture's PNG bytes in one binary IPC call.
            // The streaming pipeline now ships only metadata, so this
            // is where the actual pixels arrive. We deliberately do
            // NOT await — the level can render with placeholder
            // materials until bytes arrive, and a hung fetch
            // shouldn't keep the busy spinner stuck.
            {
              const ids = acc.textures.map((t) => t.id);
              if (ids.length > 0) {
                const t0 = performance.now();
                getLevelTexturesBulk(sum.folder, ids)
                  .then((map) => {
                    const dt = performance.now() - t0;
                    let totalBytes = 0;
                    for (const b of map.values()) totalBytes += b.size;
                    console.log(
                      `[texture-bulk-ipc] ${map.size}/${ids.length} textures · ${(totalBytes / 1024 / 1024).toFixed(2)} MB · ${dt.toFixed(0)} ms`,
                    );
                    setTextureBlobs(map);
                  })
                  .catch((err) => {
                    log("error", `Texture bulk fetch failed: ${err}`);
                  });
              } else {
                setTextureBlobs(new Map());
              }
            }

            // Cache extraction runs SEQUENTIALLY after streaming, not in
            // parallel. Both pipelines decode the same `mobys.dat` /
            // `ties.dat` files and contend for Tauri's worker pool;
            // running them concurrently caused the streaming pipeline
            // to either stall or never emit its "done" event, leaving
            // the viewport stuck on proxy boxes only.
            //
            // Branching by `cacheMode`:
            //   "use-cache" — user explicitly chose the existing cache;
            //                 just load the manifest, no decode work.
            //   "force-reextract" — user asked to rebuild; wipe + redo.
            //   "auto" — legacy default: extract iff no fresh cache.
            const runExtract = (force: boolean) => {
              log(
                "info",
                force
                  ? "Rebuilding disk cache (user-requested re-extract)…"
                  : "Building disk cache in background…",
              );
              const channel = new Channel<CacheEvent>();
              let phaseTotals = { phase: "mobys" as const, total: 0 };
              channel.onmessage = (event) => {
                switch (event.type) {
                  case "phase":
                    phaseTotals = {
                      phase: event.phase,
                      total: event.total,
                    } as never;
                    setCacheProgress({
                      phase: event.phase,
                      current: 0,
                      total: event.total,
                    });
                    break;
                  case "progress":
                    setCacheProgress({
                      phase: phaseTotals.phase,
                      current: event.current,
                      total: phaseTotals.total,
                    });
                    break;
                  case "done":
                    setCacheProgress(null);
                    cacheStatus(sum.folder)
                      .then(setCacheState)
                      .catch(() => {});
                    readCachedManifest(sum.folder)
                      .then(setCacheManifest)
                      .catch(() => {});
                    log("ok", `Cache built: ${event.entry_count} entries`);
                    break;
                  case "error":
                    setCacheProgress(null);
                    log("warn", `Cache extraction failed: ${event.message}`);
                    break;
                }
              };
              const fn = force ? reextractLevelCache : extractLevelToCache;
              fn(sum.folder, channel).catch((e) => {
                setCacheProgress(null);
                log("warn", `Cache extraction failed: ${e}`);
              });
            };

            if (cacheMode === "use-cache") {
              cacheStatus(sum.folder)
                .then((status) => {
                  setCacheState(status);
                  log(
                    "ok",
                    `Using cached data: ${status.mobys}M / ${status.ties}T / ${status.textures}tex`,
                  );
                  readCachedManifest(sum.folder)
                    .then(setCacheManifest)
                    .catch((e) => log("warn", `Cache manifest read failed: ${e}`));
                })
                .catch((e) => log("warn", `Cache status check failed: ${e}`));
            } else if (cacheMode === "force-reextract") {
              runExtract(true);
            } else {
              cacheStatus(sum.folder)
                .then((status) => {
                  setCacheState(status);
                  if (status.exists) {
                    log(
                      "ok",
                      `Cache ready: ${status.mobys}M / ${status.ties}T / ${status.textures}tex`,
                    );
                    readCachedManifest(sum.folder)
                      .then(setCacheManifest)
                      .catch((e) =>
                        log("warn", `Cache manifest read failed: ${e}`),
                      );
                    return;
                  }
                  runExtract(false);
                })
                .catch((e) => log("warn", `Cache status check failed: ${e}`));
            }
            break;
          case "error":
            setError(e.message);
            setMeshLoadPhase(null);
            break;
        }
      });
    } catch (e) {
      setError(`Mesh decode failed: ${e}`);
      setMeshLoadPhase(null);
    } finally {
      setBusy(false);
    }
  }, [log]);


  const handleOpen = useCallback(async (rawFolder: string) => {
    const folder = rawFolder.trim();
    if (!folder) return;
    setOpenLevelModalOpen(false);
    setError(null);
    setBusy(true);
    selection.clear();
    edits.resetAll();
    setMeshes(null);
    setTextureBlobs(null);
    setGltfLibrary(null);
    setGltfLibraryStatus(null);
    setPreviewGltfFile(null);
    setAnimsetClips([]);
    setOverrideAnimsetHash(null);
    setPreviewAssetTuid(null);
    // Stop any playing sound + drop cached extraction state — the
    // new level has its own sound bank.
    if (nowPlayingMirror.current) {
      nowPlayingMirror.current.audio.pause();
      URL.revokeObjectURL(nowPlayingMirror.current.blobUrl);
    }
    setNowPlaying(null);
    setLevelSounds([]);
    setExtractedSoundsCache(new Map());
    setLevelFiles([]);
    setLoadPhase(null);
    setMeshLoadPhase(null);
    setCompletedPhases([]);
    log("info", `Opening level: ${folder}`);
    try {
      const sum = await openLevel(folder);
      setSummary(sum);
      log(
        "ok",
        `IGHW v${sum.version_major}.${sum.version_minor} · ${sum.sections.length} sections`,
      );
      const lyt = await levelLayout(sum.folder);
      // Dedupe by tuid — some R2 levels emit the same instance_tuid in
      // multiple region/zone metadata entries, which makes React choke on
      // duplicate keys downstream. First occurrence wins.
      const seen = new Set<string>();
      const dedupedInstances = lyt.instances.filter((i) => {
        if (seen.has(i.tuid)) return false;
        seen.add(i.tuid);
        return true;
      });
      const dropped = lyt.instances.length - dedupedInstances.length;
      setInstances(dedupedInstances);
      setUFrags(lyt.ufrags);
      log(
        "info",
        `Layout: ${dedupedInstances.length} instances` +
          (dropped > 0 ? ` (deduped ${dropped})` : "") +
          `, ${lyt.ufrags.length} UFrags`,
      );

      setBusy(false);

      // Kick off the full mesh decode automatically. Safe now that:
      //   1. Texture uploads skip mipmap generation (was the #1 cause of
      //      WebGL context loss on bayou)
      //   2. Geometry build runs in `requestIdleCallback` slots, one
      //      asset at a time, off the render path
      //   3. `computeVertexNormals` is skipped (~150ms saved per moby)
      //   4. WebGL context-loss handler shows a banner instead of
      //      letting the canvas silently freeze
      //
      // The decode runs concurrently with idle-time mesh building, so
      // the proxy-box view stays responsive while real meshes stream in
      // and progressively replace the boxes. No await — let it run in
      // the background.
      // Probe for an existing cache BEFORE the streaming pipeline starts.
      // If the level was already extracted, ask the user whether to use the
      // cached data or rebuild from scratch — cheaper than always extracting,
      // and lets them recover from a stale/corrupt cache without leaving the
      // app. If no cache exists yet, the auto path runs the legacy flow.
      let existing: CacheStatus | null = null;
      try {
        existing = await cacheStatus(sum.folder);
      } catch (e) {
        log("warn", `Cache status check failed: ${e}`);
      }
      if (existing && existing.exists) {
        log(
          "info",
          `Cache detected (${existing.mobys}M / ${existing.ties}T / ${existing.textures}tex) — awaiting user choice`,
        );
        setCachePrompt({ sum, status: existing });
      } else {
        log("info", "Auto-loading meshes (idle-paced; safe to interact while it runs)");
        void loadFullMeshes(sum, "auto");
      }

      // Pre-fetch the animset directory in parallel with the mesh
      // decode. Cheap (only the 0x40 header per animset, 39 entries
      // on bayou ≈ < 100 KB read) and lets the Hierarchy populate the
      // Animations section immediately instead of waiting for the
      // user to open a preview modal.
      listAnimsetClips(sum.folder)
        .then((clips) => {
          setAnimsetClips(clips);
          log("ok", `Animset library: ${clips.length} clips`);
        })
        .catch((e) => {
          log("warn", `Animset list failed: ${e}`);
        });

      // Sound table — cheap header read of resident_sound.dat. The
      // ADPCM decoding for any specific sound happens lazily on first
      // play; this just gives the UI the names + indices.
      listLevelSounds(sum.folder)
        .then((sounds) => {
          setLevelSounds(sounds);
          if (sounds.length > 0) {
            log("ok", `Sound bank: ${sounds.length} entries`);
          }
        })
        .catch((e) => {
          log("warn", `Sound list failed: ${e}`);
        });

      // Survey the level folder — every notable file classified by
      // type, with a `parsed` flag so the user can see at a glance
      // which formats we already extract vs which are still on the
      // roadmap. Cheap (one read_dir).
      listLevelFiles(sum.folder)
        .then((files) => {
          setLevelFiles(files);
          if (files.length > 0) {
            const parsedCount = files.filter((f) => f.parsed).length;
            log(
              "info",
              `Level files: ${files.length} total · ${parsedCount} parsed · ${files.length - parsedCount} roadmap`,
            );
          }
        })
        .catch((e) => {
          log("warn", `File listing failed: ${e}`);
        });

      // The old `<level>/character/` filesystem lookup
      // (streamCharacterLibrary) is gone — the path-grouped Asset
      // Library tree built directly from `assetlookup.dat` is the
      // canonical source now. No filesystem dependency, works on any
      // level whether or not InsomniaToolset has been run.
      //
      // Cache extraction was here previously but ran concurrently with
      // the streaming pipeline, contending for the same `.dat` files
      // and Tauri worker threads. It now fires from inside
      // loadFullMeshes' "done" handler so streaming completes first,
      // then the cache builds afterwards. Fire-and-forget either way.

      // Step 4: scan ALL of the `entities/` tree (character, object,
      // unique, …) for InsomniaToolset GLTF outputs. Files come back
      // tagged with their first-level subfolder so the Hierarchy can
      // group them — same way Mobys/Ties are grouped for placed
      // instances. Skeleton + animations are already baked in by
      // extract_assets, so three.js's GLTFLoader can render them
      // directly at preview time without any extra Rust work.
      try {
        setGltfLibraryStatus("Scanning entities/ for GLTF assets…");
        const lib = await listEntitiesGltfs(folder);
        if (lib.folder && lib.files.length > 0) {
          log(
            "ok",
            `Entities GLTFs found at ${lib.folder} (${lib.files.length} files)`,
          );
          setGltfLibrary(lib.files);
        } else if (lib.folder) {
          log("info", `Entities folder ${lib.folder} contains no .gltf/.glb`);
          setGltfLibrary([]);
        } else {
          log("info", "No entities/ folder found near this level");
          setGltfLibrary(null);
        }
      } catch (e) {
        log("warn", `Entities GLTF scan failed: ${e}`);
        setGltfLibrary(null);
      } finally {
        setGltfLibraryStatus(null);
      }
    } catch (e) {
      setError(String(e));
      setSummary(null);
      setInstances([]);
      setUFrags([]);
      setLoadPhase(null);
      setMeshLoadPhase(null);
    } finally {
      setBusy(false);
    }
  }, [log, selection, edits, loadFullMeshes]);

  // Resolve the cache prompt: kick off the load with the chosen mode.
  // Always called from the modal's two action buttons.
  const resolveCachePrompt = useCallback(
    (mode: "use-cache" | "force-reextract") => {
      const pending = cachePrompt;
      if (!pending) return;
      setCachePrompt(null);
      log(
        "info",
        mode === "use-cache"
          ? "Loading meshes — will reuse the existing cache"
          : "Loading meshes — will rebuild the cache after streaming",
      );
      void loadFullMeshes(pending.sum, mode);
    },
    [cachePrompt, loadFullMeshes, log],
  );

  const handleClose = useCallback(() => {
    setSummary(null);
    setInstances([]);
    setUFrags([]);
    setMeshes(null);
    setTextureBlobs(null);
    setGltfLibrary(null);
    setGltfLibraryStatus(null);
    setPreviewGltfFile(null);
    setPreviewAssetTuid(null);
    setAnimsetClips([]);
    setOverrideAnimsetHash(null);
    setCacheState(null);
    setCacheManifest(null);
    setCacheProgress(null);
    setCachePrompt(null);
    selection.clear();
    edits.resetAll();
    setError(null);
    setLoadPhase(null);
    setMeshLoadPhase(null);
    setCompletedPhases([]);
    log("info", "Level closed");
  }, [log, selection, edits]);

  const toolbarInfo = meshes
    ? `${meshes.moby_assets.length} mobys · ${meshes.tie_assets.length} ties · ${meshes.ufrag_meshes.length} terrain · ${meshes.textures.length} textures`
    : summary
      ? `${instances.length.toLocaleString()} instances · ${ufrags.length.toLocaleString()} UFrags`
      : "";

  const errorCount = consoleLog.filter((e) => e.level === "error").length;
  const warnCount = consoleLog.filter((e) => e.level === "warn").length;

  return (
    <div className="app">
      {splashMounted && (
        <Splash
          visible={splashVisible}
          onExit={() => setSplashMounted(false)}
        />
      )}
      <TitleBar>
        <MenuBar>
          <span
            className="brand"
            onClick={() => setAboutModalOpen(true)}
            role="button"
            tabIndex={0}
            title="About ReChimera"
          >
            <img
              src={brandIconUrl}
              alt=""
              className="brand-icon"
              draggable={false}
            />
            ReChimera
            <span className="brand-version mono small">v{APP_VERSION}</span>
          </span>

          <Menu label={t("menu.file")}>
            <MenuItem onSelect={() => setOpenLevelModalOpen(true)}>
              {t("menu.openLevel")}
            </MenuItem>
            <MenuItem onSelect={handleClose} disabled={!summary}>
              {t("menu.closeLevel")}
            </MenuItem>
          </Menu>

          <Menu label={t("menu.view")}>
            <MenuCheckItem
              checked={view.showGrid}
              onToggle={() => toggle("showGrid")}
            >
              {t("menu.grid")}
            </MenuCheckItem>
            <MenuCheckItem
              checked={view.showAxes}
              onToggle={() => toggle("showAxes")}
            >
              {t("menu.axes")}
            </MenuCheckItem>
            <MenuCheckItem
              checked={view.showStats}
              onToggle={() => toggle("showStats")}
            >
              {t("menu.fpsGraph")}
            </MenuCheckItem>
          </Menu>

          <Menu label="Render">
            <MenuItem
              onSelect={() => {
                if (summary) void loadFullMeshes(summary);
              }}
              disabled={!summary || busy || meshLoadPhase !== null}
            >
              {meshes ? "Reload Full Meshes" : "Load Full Meshes"}
            </MenuItem>
            <MenuCheckItem
              checked={view.showMobys}
              onToggle={() => toggle("showMobys")}
              disabled={!summary}
            >
              Mobys
            </MenuCheckItem>
            <MenuCheckItem
              checked={view.showTies}
              onToggle={() => toggle("showTies")}
              disabled={!summary}
            >
              Ties
            </MenuCheckItem>
            <MenuCheckItem
              checked={view.showUFrags}
              onToggle={() => toggle("showUFrags")}
              disabled={!summary}
            >
              UFrag Terrain
            </MenuCheckItem>
            <MenuCheckItem
              checked={view.showUFragBounds}
              onToggle={() => toggle("showUFragBounds")}
              disabled={!summary}
            >
              UFrag Bounds (debug)
            </MenuCheckItem>
          </Menu>

          <Menu label="Layout">
            <MenuItem onSelect={() => resetAll(dispatch)}>
              Reset to default
            </MenuItem>
          </Menu>

          <Menu label="Tools">
            <MenuItem onSelect={() => setPsarcModalOpen(true)}>
              {t("menu.extractPsarc")}
            </MenuItem>
            <MenuItem onSelect={() => handleBrowseGltfFolder()}>
              Browse GLTF folder…
            </MenuItem>
            <MenuSpacer />
            <MenuItem onSelect={() => setSettingsModalOpen(true)}>
              {t("menu.settings")}
            </MenuItem>
          </Menu>

          <Menu label="Help">
            <MenuItem onSelect={() => void openExternal(APP_REPO_URL)}>
              GitHub Repository
            </MenuItem>
            <MenuItem onSelect={() => void openExternal(APP_ISSUES_URL)}>
              Report an issue…
            </MenuItem>
            <MenuItem onSelect={() => setAboutModalOpen(true)}>
              About ReChimera…
            </MenuItem>
          </Menu>

          <MenuSpacer />

          <div className="menubar-panel-toggles" data-tauri-drag-region="false">
            <button
              className={`menubar-icon-btn ${layout.hierarchyHidden ? "" : "active"}`}
              onClick={() => dispatch(toggleHierarchyHidden())}
              title="Toggle left panel (Hierarchy)"
              aria-label="Toggle left panel"
              data-tauri-drag-region="false"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1.5" y="2.5" width="4.5" height="11" rx="1.5" fill="currentColor" />
              </svg>
            </button>
            <button
              className={`menubar-icon-btn ${layout.consoleCollapsed ? "" : "active"}`}
              onClick={() => dispatch(toggleConsoleCollapsed())}
              title="Toggle bottom panel (Console)"
              aria-label="Toggle bottom panel"
              data-tauri-drag-region="false"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1.5" y="9.5" width="13" height="4" rx="1.5" fill="currentColor" />
              </svg>
            </button>
            <button
              className={`menubar-icon-btn ${layout.inspectorHidden ? "" : "active"}`}
              onClick={() => dispatch(toggleInspectorHidden())}
              title="Toggle right panel (Inspector)"
              aria-label="Toggle right panel"
              data-tauri-drag-region="false"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <rect x="10" y="2.5" width="4.5" height="11" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          </div>

          <button
            className="menubar-icon-btn"
            onClick={() => setSettingsModalOpen(true)}
            title={t("menu.settings")}
            aria-label={t("menu.settings")}
            data-tauri-drag-region="false"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          {updater.phase.kind === "available" && (
            <button
              className="btn btn-update"
              onClick={() => void updater.install()}
              title={`Update available — v${updater.phase.update.version}`}
              data-tauri-drag-region="false"
            >
              ↑ Update available
            </button>
          )}
          {updater.phase.kind === "downloading" && (
            <button
              className="btn"
              disabled
              data-tauri-drag-region="false"
            >
              Downloading update…
            </button>
          )}
        </MenuBar>
      </TitleBar>

      <Toolbar
        view={view}
        onToggle={toggle}
        hasLevel={summary != null}
        info={toolbarInfo}
        modifiedCount={edits.count}
        onResetAllEdits={edits.resetAll}
      />

      <div className="workspace">
        {/* The IDE shell renders unconditionally — even with no level
            loaded, the user sees the same Hierarchy / Viewport /
            Inspector / Console layout as when a level is open, just
            with each panel's empty state instead of populated content.
            That keeps the title bar's "Open Level…" CTA as the single
            entry point and avoids the layout reflow that used to happen
            on level open. */}
        <PanelGroup
            direction="horizontal"
            autoSaveId="rechimera-workspace-h"
            className="workspace-h"
          >
            <Panel
              ref={hierarchyPanelRef}
              collapsible
              collapsedSize={0}
              defaultSize={layout.hierarchyHidden ? 0 : layout.hierarchyPct}
              minSize={10}
              maxSize={40}
              onResize={(size) => {
                if (size > 1) dispatch(setHierarchyPct(size));
              }}
              className="workspace-pane"
            >
              <Hierarchy
                instances={instances}
                selection={selection}
                gltfLibrary={gltfLibrary}
                gltfLibraryStatus={gltfLibraryStatus}
                onPreviewGltfFile={(f) => setPreviewGltfFile(f)}
                animsetClips={animsetClips}
                activeAnimsetHash={overrideAnimsetHash}
                onSelectAnimset={(hash) =>
                  setOverrideAnimsetHash(
                    overrideAnimsetHash === hash ? null : hash,
                  )
                }
                mobyAssets={meshes?.moby_assets}
                tieAssets={meshes?.tie_assets}
                cacheManifest={cacheManifest}
                onPreviewRawAsset={(tuid) => setPreviewAssetTuid(tuid)}
                sounds={levelSounds}
                playingSoundName={playingSoundName}
                onPlaySound={handlePlaySound}
                textures={meshes?.textures}
                levelFolder={summary?.folder}
                levelFiles={levelFiles}
              />
            </Panel>

            <PanelResizeHandle className="resize-handle resize-handle-h" />

            <Panel minSize={30} className="workspace-pane">
              <PanelGroup
                direction="vertical"
                autoSaveId="rechimera-workspace-v"
              >
                <Panel
                  minSize={20}
                  className="workspace-pane"
                >
                  <div className="panel pane-viewport">
                    <Viewport
                      instances={instances}
                      ufrags={ufrags}
                      meshes={meshes}
                      textureBlobs={textureBlobs}
                      selection={selection}
                      view={view}
                      onToggle={toggle}
                      focusVersion={focusVersion}
                      viewSnap={viewSnap}
                      edits={edits}
                      meshLoadPhase={meshLoadPhase}
                      levelFolder={summary?.folder ?? null}
                      overrideAnimsetHash={overrideAnimsetHash}
                    />
                    {!summary && (
                      <div className="viewport-empty-toast">
                        <div className="viewport-empty-title">No level loaded</div>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => setOpenLevelModalOpen(true)}
                        >
                          Open Level…
                        </button>
                        <div className="viewport-empty-sub small dim">
                          Pick any folder containing{" "}
                          <code>assetlookup.dat</code> — Resistance 2/3,
                          Ratchet &amp; Clank Future, and other Insomniac
                          PS3 titles.
                        </div>
                      </div>
                    )}
                  </div>
                </Panel>

                <PanelResizeHandle className="resize-handle resize-handle-v" />

                <Panel
                  ref={bottomPanelRef}
                  collapsible
                  collapsedSize={3}
                  defaultSize={
                    layout.consoleCollapsed ? 3 : layout.bottomPct
                  }
                  minSize={12}
                  maxSize={60}
                  onResize={(size) => {
                    if (size > 4) dispatch(setBottomPct(size));
                  }}
                  className="workspace-pane"
                >
                  <BottomPanel
                    summary={summary}
                    console={consoleLog}
                    collapsed={layout.consoleCollapsed}
                    onToggleCollapsed={() =>
                      dispatch(toggleConsoleCollapsed())
                    }
                    errorCount={errorCount}
                    warnCount={warnCount}
                  />
                </Panel>
              </PanelGroup>
            </Panel>

            <PanelResizeHandle className="resize-handle resize-handle-h" />

            <Panel
              ref={inspectorPanelRef}
              collapsible
              collapsedSize={0}
              defaultSize={layout.inspectorHidden ? 0 : layout.inspectorPct}
              minSize={14}
              maxSize={45}
              onResize={(size) => {
                if (size > 1) dispatch(setInspectorPct(size));
              }}
              className="workspace-pane"
            >
              <Inspector
                selected={primaryInstance}
                selectionCount={selection.count}
                meshes={meshes}
                textureBlobs={textureBlobs}
                instances={instances}
                edits={edits}
                onExportSelected={handleExportSelection}
                onLoadMeshes={() => {
                  if (summary) void loadFullMeshes(summary);
                }}
                loadingMeshes={meshLoadPhase !== null}
                onFocusSelected={() => setFocusVersion((v) => v + 1)}
              />
            </Panel>
          </PanelGroup>
      </div>

      <SoundPlayer
        nowPlaying={nowPlaying}
        onLog={log}
        onClose={() => {
          if (nowPlayingMirror.current) {
            nowPlayingMirror.current.audio.pause();
            URL.revokeObjectURL(nowPlayingMirror.current.blobUrl);
          }
          setNowPlaying(null);
        }}
      />

      <StatusBar
        summary={summary}
        meshesCount={meshes?.moby_assets.length ?? 0}
        instanceCount={instances.length}
        ufragCount={ufrags.length}
        meshes={meshes}
        loadPhase={loadPhase}
        meshLoadPhase={meshLoadPhase}
        error={error}
        cacheState={cacheState}
        cacheProgress={cacheProgress}
        onOpenCacheLibrary={() => setCacheLibraryOpen(true)}
      />

      <OpenLevelModal
        open={openLevelModalOpen}
        busy={busy}
        onClose={() => setOpenLevelModalOpen(false)}
        onOpen={(folder) => handleOpen(folder)}
      />

      <PsarcModal
        open={psarcModalOpen}
        onClose={() => setPsarcModalOpen(false)}
      />

      <SettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
      />

      <GltfCharacterModal
        file={previewGltfFile}
        onClose={() => setPreviewGltfFile(null)}
        levelFolder={summary?.folder ?? null}
      />

      <RawCharacterModal
        assetTuid={previewAssetTuid}
        meshes={meshes}
        textureBlobs={textureBlobs}
        levelFolder={summary?.folder ?? null}
        animsetClips={animsetClips}
        onClose={() => setPreviewAssetTuid(null)}
      />

      {/* CharacterPreviewModal removed — RawCharacterModal above
          handles all asset previews from `assetlookup.dat` directly. */}

      <CacheLibraryModal
        open={cacheLibraryOpen}
        onClose={() => setCacheLibraryOpen(false)}
        folder={summary?.folder ?? null}
        onExport={handleCacheLibraryExport}
      />

      <Modal
        open={cachePrompt !== null}
        dismissable={false}
        title={
          cachePrompt?.status.incomplete
            ? t("cachePrompt.titleIncomplete")
            : t("cachePrompt.titleFound")
        }
        subtitle={
          cachePrompt
            ? t("cachePrompt.subtitle", {
                mobys: cachePrompt.status.mobys,
                ties: cachePrompt.status.ties,
                textures: cachePrompt.status.textures,
              })
            : undefined
        }
        size="md"
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              className="btn"
              onClick={() => resolveCachePrompt("use-cache")}
              disabled={cachePrompt?.status.incomplete}
              title={
                cachePrompt?.status.incomplete
                  ? t("cachePrompt.useCachedDisabledTitle")
                  : undefined
              }
            >
              {t("cachePrompt.useCached")}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => resolveCachePrompt("force-reextract")}
            >
              {t("cachePrompt.reextract")}
            </button>
          </div>
        }
      >
        {cachePrompt?.status.incomplete ? (
          <>
            <p className="small" style={{ marginTop: 0, lineHeight: 1.5 }}>
              {t("cachePrompt.cacheBodyIncomplete")}
            </p>
            <p className="small dim" style={{ lineHeight: 1.5 }}>
              {t("cachePrompt.cacheBodyIncompleteHint")}
            </p>
          </>
        ) : (
          <>
            <p className="small dim" style={{ marginTop: 0, lineHeight: 1.5 }}>
              {t("cachePrompt.cacheBodyOk")}
            </p>
            <p className="small dim" style={{ lineHeight: 1.5 }}>
              {t("cachePrompt.cacheBodyOkHint")}
            </p>
          </>
        )}
        {cachePrompt?.status.stale && !cachePrompt.status.incomplete && (
          <p
            className="small"
            style={{
              marginTop: 8,
              color: "var(--warn-fg, #d97706)",
              lineHeight: 1.5,
            }}
          >
            ⚠ {t("cachePrompt.staleWarning")}
          </p>
        )}
      </Modal>

      <Modal
        open={loadPhase !== null}
        dismissable={false}
        title="Loading level"
        subtitle="Reading the level summary from disk"
        size="md"
      >
        <LoadProgress active={loadPhase} completed={completedPhases} />
        <p className="small dim" style={{ marginTop: 16, lineHeight: 1.5 }}>
          Heavy decoding may briefly freeze the window.{" "}
          <strong>Don't close the app</strong> — it keeps working in the
          background and will return as soon as the current phase finishes.
        </p>
      </Modal>

      <AboutModal
        open={aboutModalOpen}
        onClose={() => setAboutModalOpen(false)}
      />

      <UpdateChecker state={updater} />

      {meshLoadPhase && (
        <div className="loading-banner" role="status" aria-live="polite">
          <span className="loading-banner-spinner" aria-hidden />
          <div className="loading-banner-body">
            <div className="loading-banner-title">
              Loading assets — {meshLoadPhase.label}
            </div>
            {meshLoadPhase.total > 0 && (
              <>
                <div className="loading-banner-bar">
                  <div
                    className="loading-banner-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(
                          (meshLoadPhase.current / meshLoadPhase.total) * 100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
                <div className="loading-banner-progress small dim mono">
                  {meshLoadPhase.current.toLocaleString()} /{" "}
                  {meshLoadPhase.total.toLocaleString()}
                </div>
              </>
            )}
            <div className="loading-banner-warning small dim">
              Heavy decoding — the window may briefly freeze.{" "}
              <strong>Don't close the app</strong>; it keeps working in the
              background and will return when the current phase finishes.
            </div>
          </div>
        </div>
      )}

      <Modal
        // Stay open while in-flight; auto-close when done or cancelled.
        open={
          exportState !== null &&
          exportState.phase !== "done" &&
          !exportState.cancelled
        }
        onClose={() => setExportState(null)}
        // Allow dismiss only after the dialog returns (i.e. picking is done).
        dismissable={
          exportState?.phase === "done" || exportState?.cancelled === true
        }
        title="Exporting selection"
        subtitle="Building scene → encoding glTF → writing to disk"
        size="md"
      >
        {exportState && <ExportProgress state={exportState} />}
      </Modal>
    </div>
  );
}
