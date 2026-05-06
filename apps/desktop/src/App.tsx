import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// Static logo URL resolved by Vite at build time. Used here for the
// persistent title-bar logo so the brand is visible even when the
// main thread is blocked during heavy level loading — the <img> is
// rendered once on first paint and the browser caches the bytes;
// nothing in the runtime can "lose" it.
import brandIconUrl from "../icon.png?url";
import {
  dumpSoundBank,
  extractLevelSounds,
  extractLevelStreamSounds,
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
import { GltfCharacterModal } from "./GltfCharacterModal";
import { RawCharacterModal } from "./RawCharacterModal";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";
import { LoadProgress, type LoadPhaseState } from "./LoadProgress";
import { Menu, MenuBar, MenuCheckItem, MenuItem, MenuSpacer } from "./MenuBar";
import { Modal } from "./Modal";
import { OpenLevelModal } from "./OpenLevelModal";
import { PsarcTools } from "./PsarcTools";
import { SoundPlayer, type NowPlaying } from "./SoundPlayer";
import { Splash } from "./Splash";
import { UpdateChecker } from "./UpdateChecker";
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
  toggleView,
  useAppDispatch,
  useAppSelector,
  type ViewSettingsState,
} from "./store";

export function App() {
  const dispatch = useAppDispatch();
  const view = useAppSelector((s) => s.view);
  const layout = useAppSelector((s) => s.layout);

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
  const primaryInstance = selection.primary
    ? instances.find((i) => i.tuid === selection.primary) ?? null
    : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadPhase, setLoadPhase] = useState<LoadPhaseState | null>(null);
  const [meshLoadPhase, setMeshLoadPhase] = useState<LoadPhaseState | null>(null);
  const [completedPhases, setCompletedPhases] = useState<PhaseId[]>([]);
  const [consoleLog, setConsoleLog] = useState<ConsoleEntry[]>([]);
  const [psarcOpen, setPsarcOpen] = useState(false);
  // About / credits modal — opened from `Help → About ReChimera…`.
  // Rendered always (not gated on level state) so Help is reachable
  // from a fresh splash.
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [openLevelModalOpen, setOpenLevelModalOpen] = useState(false);
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

  const loadFullMeshes = useCallback(async (sum: LevelSummary) => {
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
      log("info", "Auto-loading meshes (idle-paced; safe to interact while it runs)");
      void loadFullMeshes(sum);

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

          <Menu label="File">
            <MenuItem onSelect={() => setOpenLevelModalOpen(true)}>
              Open Level…
            </MenuItem>
            <MenuItem onSelect={handleClose} disabled={!summary}>
              Close Level
            </MenuItem>
          </Menu>

          <Menu label="View">
            <MenuCheckItem
              checked={view.showGrid}
              onToggle={() => toggle("showGrid")}
            >
              Grid
            </MenuCheckItem>
            <MenuCheckItem
              checked={view.showAxes}
              onToggle={() => toggle("showAxes")}
            >
              Axes
            </MenuCheckItem>
            <MenuCheckItem
              checked={view.showStats}
              onToggle={() => toggle("showStats")}
            >
              FPS Graph (vs counter)
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
            <MenuItem onSelect={() => setPsarcOpen(true)}>
              PSARC Extractor…
            </MenuItem>
            <MenuItem onSelect={() => handleBrowseGltfFolder()}>
              Browse GLTF folder…
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

          <button
            className="btn btn-primary"
            onClick={() => setOpenLevelModalOpen(true)}
            disabled={busy}
            title="Open a level folder"
            data-tauri-drag-region="false"
          >
            {busy ? "Loading…" : summary ? "Open another…" : "Open Level…"}
          </button>
        </MenuBar>
      </TitleBar>

      <Toolbar
        view={view}
        onToggle={toggle}
        hasLevel={summary != null}
        info={toolbarInfo}
        editMode={edits.mode}
        onEditModeChange={edits.setMode}
        modifiedCount={edits.count}
        onResetAllEdits={edits.resetAll}
        hasSelection={selection.count > 0}
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
              defaultSize={layout.hierarchyPct}
              minSize={10}
              maxSize={40}
              onResize={(size) => dispatch(setHierarchyPct(size))}
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
                      focusVersion={focusVersion}
                      edits={edits}
                      meshLoadPhase={meshLoadPhase}
                      levelFolder={summary?.folder ?? null}
                      overrideAnimsetHash={overrideAnimsetHash}
                    />
                    {!summary && (
                      <div className="viewport-empty-hint">
                        <p className="dim">
                          Open a level to begin
                        </p>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => setOpenLevelModalOpen(true)}
                        >
                          Open Level…
                        </button>
                        <p className="small dim" style={{ marginTop: 12 }}>
                          Pick any folder containing{" "}
                          <code>assetlookup.dat</code> — Resistance 2/3,
                          Ratchet &amp; Clank Future, and other Insomniac
                          PS3 titles.
                        </p>
                      </div>
                    )}
                  </div>
                </Panel>

                <PanelResizeHandle className="resize-handle resize-handle-v" />

                <Panel
                  defaultSize={
                    layout.consoleCollapsed ? 4 : layout.bottomPct
                  }
                  minSize={layout.consoleCollapsed ? 4 : 12}
                  maxSize={60}
                  onResize={(size) => {
                    if (!layout.consoleCollapsed) {
                      dispatch(setBottomPct(size));
                    }
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
              defaultSize={layout.inspectorPct}
              minSize={14}
              maxSize={45}
              onResize={(size) => dispatch(setInspectorPct(size))}
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
      />

      <OpenLevelModal
        open={openLevelModalOpen}
        busy={busy}
        onClose={() => setOpenLevelModalOpen(false)}
        onOpen={(folder) => handleOpen(folder)}
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

      <Modal
        open={loadPhase !== null}
        dismissable={false}
        title="Loading level"
        subtitle="Decoding meshes, terrain, and textures from disk"
        size="md"
      >
        <LoadProgress active={loadPhase} completed={completedPhases} />
      </Modal>

      <Modal
        open={psarcOpen}
        onClose={() => setPsarcOpen(false)}
        title="PSARC Extractor"
        subtitle="Read and extract PlayStation Archive files (PS3 .psarc)"
        size="lg"
      >
        <PsarcTools />
      </Modal>

      <AboutModal
        open={aboutModalOpen}
        onClose={() => setAboutModalOpen(false)}
      />

      <UpdateChecker />

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
