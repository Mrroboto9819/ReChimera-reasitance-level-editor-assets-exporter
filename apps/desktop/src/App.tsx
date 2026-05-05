import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  levelLayout,
  listEntitiesGltfs,
  listGltfsInFolder,
  openLevel,
  streamCharacterLibrary,
  streamLevelMeshes,
  type AssetMeshes,
  type GltfFile,
  type Instance,
  type LevelMeshes,
  type LevelSummary,
  type PhaseId,
  type TexturePayload,
  type UFragBounds,
  type UFragMesh,
} from "./api";
import { BottomPanel, type ConsoleEntry } from "./BottomPanel";
import { CharacterPreviewModal } from "./CharacterPreviewModal";
import { GltfCharacterModal } from "./GltfCharacterModal";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";
import { LoadProgress, type LoadPhaseState } from "./LoadProgress";
import { Menu, MenuBar, MenuCheckItem, MenuItem, MenuSpacer } from "./MenuBar";
import { Modal } from "./Modal";
import { OpenLevelModal } from "./OpenLevelModal";
import { PsarcTools } from "./PsarcTools";
import { Splash } from "./Splash";
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
  const selection = useSelection(useCallback(() => instances, [instances]));
  const edits = useEdits();
  const primaryInstance = selection.primary
    ? instances.find((i) => i.tuid === selection.primary) ?? null
    : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadPhase, setLoadPhase] = useState<LoadPhaseState | null>(null);
  const [completedPhases, setCompletedPhases] = useState<PhaseId[]>([]);
  const [consoleLog, setConsoleLog] = useState<ConsoleEntry[]>([]);
  const [psarcOpen, setPsarcOpen] = useState(false);
  const [openLevelModalOpen, setOpenLevelModalOpen] = useState(false);
  const [exportState, setExportState] = useState<ExportProgressState | null>(null);
  // Character / weapon / enemy mobys from `<level>/character/` if present.
  // Decoupled from the main `meshes` state because they're not placed in
  // the world — they're a browseable asset library shown in the Hierarchy.
  const [characterLib, setCharacterLib] = useState<{
    assets: AssetMeshes[];
    textures: TexturePayload[];
  } | null>(null);
  const [characterLibStatus, setCharacterLibStatus] = useState<string | null>(null);
  // Currently-previewed character (opens a modal). null when closed.
  const [previewCharTuid, setPreviewCharTuid] = useState<string | null>(null);
  // GLTF library — files from InsomniaToolset's extract_assets command.
  // Preferred path because they already include skeleton + animations.
  const [gltfLibrary, setGltfLibrary] = useState<GltfFile[] | null>(null);
  const [gltfLibraryStatus, setGltfLibraryStatus] = useState<string | null>(null);
  const [previewGltfFile, setPreviewGltfFile] = useState<GltfFile | null>(null);
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
        path,
        (state) => setExportState(state),
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


  const handleOpen = useCallback(async (rawFolder: string) => {
    const folder = rawFolder.trim();
    if (!folder) return;
    setOpenLevelModalOpen(false);
    setError(null);
    setBusy(true);
    selection.clear();
    edits.resetAll();
    setMeshes(null);
    setCharacterLib(null);
    setCharacterLibStatus(null);
    setPreviewCharTuid(null);
    setGltfLibrary(null);
    setGltfLibraryStatus(null);
    setPreviewGltfFile(null);
    setLoadPhase(null);
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

      const acc: LevelMeshes = {
        moby_assets: [],
        tie_assets: [],
        ufrag_meshes: [],
        textures: [],
      };
      // NOTE: deliberately NOT calling setMeshes(acc) here. During the
      // load, every setMeshes triggers a React re-render of the entire
      // workspace (Viewport, Hierarchy, etc.) — even with the AssetGroup
      // pause it still walks the tree, runs effects, etc. With 35+ events
      // arriving fast, those re-renders pile up and freeze the JS thread.
      //
      // Instead: accumulate silently into `acc`. The progress modal updates
      // via setLoadPhase only. Once the Done event arrives, ONE setMeshes
      // call hands React the full level — and only then does AssetGroup
      // build geometries (chunked, in the background, with paused=false).
      const flushOnce = () => {
        setMeshes({
          moby_assets: acc.moby_assets,
          tie_assets: acc.tie_assets,
          ufrag_meshes: acc.ufrag_meshes,
          textures: acc.textures,
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
              setLoadPhase({
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
              setLoadPhase((p) =>
                p ? { ...p, current: e.current } : p,
              );
              break;
            case "moby_asset":
              // Silent accumulation — no console.log (DevTools choked on 35
              // huge mesh payloads), no setMeshes (would re-render the
              // workspace on every event).
              acc.moby_assets.push(e.asset as AssetMeshes);
              break;
            case "tie_asset":
              acc.tie_assets.push(e.asset as AssetMeshes);
              break;
            case "ufrag_mesh":
              acc.ufrag_meshes.push(e.mesh as UFragMesh);
              break;
            case "texture":
              acc.textures.push(e.texture as TexturePayload);
              break;
            case "done":
              if (activePhase) completedLocal.push(activePhase);
              setCompletedPhases([...completedLocal]);
              // Single setMeshes call — hands the WHOLE level to React at
              // once. AssetGroup then builds geometries chunked (BUILD_BATCH
              // per render with setTimeout(0) continuation) AFTER the modal
              // has closed.
              flushOnce();
              setLoadPhase(null);
              log(
                "ok",
                `Level decode finished: ${acc.moby_assets.length} mobys, ${acc.tie_assets.length} ties, ${acc.ufrag_meshes.length} terrain, ${acc.textures.length} textures`,
              );
              break;
            case "error":
              setError(e.message);
              setLoadPhase(null);
              break;
          }
        });
      } catch (e) {
        setError(`Mesh decode failed: ${e}`);
        setLoadPhase(null);
      }

      // Step 3: try to load the character/weapon library if the level has
      // a `<level>/character/` folder. Doesn't block the main flow — if it
      // fails or is absent we just skip silently.
      const libAcc = {
        assets: [] as AssetMeshes[],
        textures: [] as TexturePayload[],
      };
      let libPending = false;
      const libFlush = () => {
        if (libPending) return;
        libPending = true;
        requestAnimationFrame(() => {
          libPending = false;
          setCharacterLib({
            assets: libAcc.assets,
            textures: libAcc.textures,
          });
        });
      };
      try {
        setCharacterLibStatus("Looking for character library…");
        await streamCharacterLibrary(folder, (e) => {
          switch (e.type) {
            case "missing":
              setCharacterLibStatus(null);
              log("info", "No entities/character folder found near this level");
              break;
            case "located":
              log("ok", `Character library found: ${e.path}`);
              setCharacterLibStatus("Character library found, decoding…");
              break;
            case "total":
              setCharacterLibStatus(
                `Decoding character library (${e.total.toLocaleString()})…`,
              );
              setCharacterLib({ assets: [], textures: [] });
              log("info", `Character library: ${e.total} assets`);
              break;
            case "asset":
              libAcc.assets.push(e.asset);
              libFlush();
              break;
            case "texture":
              libAcc.textures.push(e.texture);
              libFlush();
              break;
            case "done":
              setCharacterLibStatus(null);
              if (libAcc.assets.length > 0) {
                log(
                  "ok",
                  `Character library decoded: ${libAcc.assets.length} assets, ${libAcc.textures.length} textures`,
                );
              }
              break;
            case "error":
              setCharacterLibStatus(null);
              log("warn", `Character library: ${e.message}`);
              break;
          }
        });
      } catch (e) {
        setCharacterLibStatus(null);
        log("warn", `Character library skipped: ${e}`);
      }

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
    } finally {
      setBusy(false);
    }
  }, [log, selection, edits]);

  const handleClose = useCallback(() => {
    setSummary(null);
    setInstances([]);
    setUFrags([]);
    setMeshes(null);
    setCharacterLib(null);
    setCharacterLibStatus(null);
    setPreviewCharTuid(null);
    setGltfLibrary(null);
    setGltfLibraryStatus(null);
    setPreviewGltfFile(null);
    selection.clear();
    edits.resetAll();
    setError(null);
    setLoadPhase(null);
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
          <span className="brand">ReChimera</span>

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
            <MenuItem
              onSelect={() =>
                window.open("https://github.com/Mrroboto9819/ReLunacy", "_blank")
              }
            >
              GitHub
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

      {summary ? (
        <div className="workspace">
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
                library={characterLib}
                libraryStatus={characterLibStatus}
                onPreviewLibraryAsset={(tuid) => setPreviewCharTuid(tuid)}
                gltfLibrary={gltfLibrary}
                gltfLibraryStatus={gltfLibraryStatus}
                onPreviewGltfFile={(f) => setPreviewGltfFile(f)}
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
                      selection={selection}
                      view={view}
                      focusVersion={focusVersion}
                      edits={edits}
                      loading={loadPhase !== null}
                    />
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
                instances={instances}
                edits={edits}
                onExportSelected={handleExportSelection}
                onFocusSelected={() => setFocusVersion((v) => v + 1)}
              />
            </Panel>
          </PanelGroup>
        </div>
      ) : (
        <div className="workspace-empty">
          <div className="hint">
            <button
              type="button"
              className="btn btn-primary export-btn"
              onClick={() => setOpenLevelModalOpen(true)}
              style={{ width: "auto", marginBottom: 16 }}
            >
              Open Level…
            </button>
            <p className="dim">
              Or use <span className="kbd">File ▸ Open Level…</span>
            </p>
            <p className="small dim" style={{ marginTop: 12 }}>
              Pick any folder containing <code>assetlookup.dat</code> —
              Resistance 2/3, Ratchet &amp; Clank Future, and other Insomniac
              PS3 titles.
            </p>
          </div>
        </div>
      )}

      <StatusBar
        summary={summary}
        meshesCount={meshes?.moby_assets.length ?? 0}
        instanceCount={instances.length}
        ufragCount={ufrags.length}
        meshes={meshes}
        loadPhase={loadPhase}
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
      />

      <CharacterPreviewModal
        charTuid={previewCharTuid}
        library={characterLib}
        onClose={() => setPreviewCharTuid(null)}
        onExport={async (asset) => {
          // Build a synthetic single-instance selection from the library
          // asset, then run the existing GLB export pipeline. The
          // exporter pulls geometry by asset_tuid from the meshes object,
          // so we hand it the library-as-meshes mapping.
          const synth: Instance = {
            tuid: `${asset.asset_tuid}#library`,
            asset_tuid: asset.asset_tuid,
            kind: "moby",
            name: `library_${asset.asset_tuid.slice(-10)}`,
            position: [0, 0, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            real: false,
          };
          const path = await pickGlbExportPath([synth]);
          if (!path) {
            log("info", "Library export cancelled");
            return;
          }
          setExportState({
            phase: "preparing",
            label: "Building scene from library asset",
            fraction: 0,
            detail: path,
          });
          try {
            const result = await exportToGlb(
              new Set([synth.tuid]),
              [synth],
              characterLib
                ? {
                    moby_assets: characterLib.assets,
                    tie_assets: [],
                    ufrag_meshes: [],
                    textures: characterLib.textures,
                  }
                : null,
              path,
              (state) => setExportState(state),
            );
            log(
              "ok",
              `Library exported ${result.bytes.toLocaleString()} bytes → ${result.path}`,
            );
          } catch (err) {
            log("error", `Library export failed: ${err}`);
            setExportState({
              phase: "done",
              label: `Library export failed: ${err}`,
              fraction: 0,
              cancelled: true,
            });
          }
        }}
      />

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
