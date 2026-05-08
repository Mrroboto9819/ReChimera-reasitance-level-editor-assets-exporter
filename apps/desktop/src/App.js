import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { levelLayout, openLevel, streamLevelMeshes, } from "./api";
import { BottomPanel } from "./BottomPanel";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";
import { LoadProgress } from "./LoadProgress";
import { Menu, MenuBar, MenuCheckItem, MenuItem, MenuSpacer } from "./MenuBar";
import { Modal } from "./Modal";
import { OpenLevelModal } from "./OpenLevelModal";
import { PsarcTools } from "./PsarcTools";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Toolbar } from "./Toolbar";
import { Viewport } from "./Viewport";
import { exportSelectedAsGlb } from "./export";
import { ExportProgress } from "./ExportProgress";
import { useSelection } from "./selection";
import { resetAll, setBottomPct, setHierarchyPct, setInspectorPct, toggleConsoleCollapsed, toggleView, useAppDispatch, useAppSelector, } from "./store";
export function App() {
    const dispatch = useAppDispatch();
    const view = useAppSelector((s) => s.view);
    const layout = useAppSelector((s) => s.layout);
    const [summary, setSummary] = useState(null);
    const [instances, setInstances] = useState([]);
    const [ufrags, setUFrags] = useState([]);
    const [meshes, setMeshes] = useState(null);
    const selection = useSelection(useCallback(() => instances, [instances]));
    const primaryInstance = selection.primary
        ? instances.find((i) => i.tuid === selection.primary) ?? null
        : null;
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [loadPhase, setLoadPhase] = useState(null);
    const [completedPhases, setCompletedPhases] = useState([]);
    const [consoleLog, setConsoleLog] = useState([]);
    const [psarcOpen, setPsarcOpen] = useState(false);
    const [openLevelModalOpen, setOpenLevelModalOpen] = useState(false);
    const [exportState, setExportState] = useState(null);
    const log = useCallback((level, msg) => setConsoleLog((cur) => [...cur, { ts: Date.now(), level, msg }]), []);
    useEffect(() => {
        if (error)
            log("error", error);
    }, [error, log]);
    const handleExportSelection = useCallback(async () => {
        if (selection.ids.size === 0 || !meshes)
            return;
        setExportState({
            phase: "picking",
            label: "Choose where to save",
            fraction: 0,
        });
        try {
            const result = await exportSelectedAsGlb(selection.ids, instances, meshes, (state) => setExportState(state));
            if (result.path) {
                log("ok", `Exported ${result.bytes.toLocaleString()} bytes → ${result.path}`);
            }
            else {
                log("info", "Export cancelled");
            }
        }
        catch (err) {
            log("error", `Export failed: ${err}`);
            setExportState({
                phase: "done",
                label: `Export failed: ${err}`,
                fraction: 0,
                cancelled: true,
            });
        }
    }, [selection.ids, instances, meshes, log]);
    const toggle = useCallback((key) => dispatch(toggleView(key)), [dispatch]);
    const handleOpen = useCallback(async (rawFolder) => {
        const folder = rawFolder.trim();
        if (!folder)
            return;
        setOpenLevelModalOpen(false);
        setError(null);
        setBusy(true);
        selection.clear();
        setMeshes(null);
        setLoadPhase(null);
        setCompletedPhases([]);
        log("info", `Opening level: ${folder}`);
        try {
            const sum = await openLevel(folder);
            setSummary(sum);
            log("ok", `IGHW v${sum.version_major}.${sum.version_minor} · ${sum.sections.length} sections`);
            const lyt = await levelLayout(sum.folder);
            
            
            
            const seen = new Set();
            const dedupedInstances = lyt.instances.filter((i) => {
                if (seen.has(i.tuid))
                    return false;
                seen.add(i.tuid);
                return true;
            });
            const dropped = lyt.instances.length - dedupedInstances.length;
            setInstances(dedupedInstances);
            setUFrags(lyt.ufrags);
            log("info", `Layout: ${dedupedInstances.length} instances` +
                (dropped > 0 ? ` (deduped ${dropped})` : "") +
                `, ${lyt.ufrags.length} UFrags`);
            const acc = {
                moby_assets: [],
                tie_assets: [],
                ufrag_meshes: [],
                textures: [],
            };
            setMeshes(acc);
            let pendingFlush = false;
            const scheduleFlush = () => {
                if (pendingFlush)
                    return;
                pendingFlush = true;
                requestAnimationFrame(() => {
                    pendingFlush = false;
                    setMeshes({
                        moby_assets: acc.moby_assets,
                        tie_assets: acc.tie_assets,
                        ufrag_meshes: acc.ufrag_meshes,
                        textures: acc.textures,
                    });
                });
            };
            const completedLocal = [];
            let activePhase = null;
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
                            });
                            setCompletedPhases([...completedLocal]);
                            log("info", `${e.label} (${e.total.toLocaleString()})`);
                            break;
                        case "progress":
                            setLoadPhase((p) => p ? { ...p, current: e.current } : p);
                            break;
                        case "moby_asset":
                            acc.moby_assets.push(e.asset);
                            scheduleFlush();
                            break;
                        case "tie_asset":
                            acc.tie_assets.push(e.asset);
                            scheduleFlush();
                            break;
                        case "ufrag_mesh":
                            acc.ufrag_meshes.push(e.mesh);
                            scheduleFlush();
                            break;
                        case "texture":
                            acc.textures.push(e.texture);
                            scheduleFlush();
                            break;
                        case "done":
                            if (activePhase)
                                completedLocal.push(activePhase);
                            setCompletedPhases([...completedLocal]);
                            setLoadPhase(null);
                            log("ok", "Level decode finished");
                            break;
                        case "error":
                            setError(e.message);
                            setLoadPhase(null);
                            break;
                    }
                });
            }
            catch (e) {
                setError(`Mesh decode failed: ${e}`);
                setLoadPhase(null);
            }
        }
        catch (e) {
            setError(String(e));
            setSummary(null);
            setInstances([]);
            setUFrags([]);
            setLoadPhase(null);
        }
        finally {
            setBusy(false);
        }
    }, [log, selection]);
    const handleClose = useCallback(() => {
        setSummary(null);
        setInstances([]);
        setUFrags([]);
        setMeshes(null);
        selection.clear();
        setError(null);
        setLoadPhase(null);
        setCompletedPhases([]);
        log("info", "Level closed");
    }, [log, selection]);
    const toolbarInfo = meshes
        ? `${meshes.moby_assets.length} mobys · ${meshes.tie_assets.length} ties · ${meshes.ufrag_meshes.length} terrain · ${meshes.textures.length} textures`
        : summary
            ? `${instances.length.toLocaleString()} instances · ${ufrags.length.toLocaleString()} UFrags`
            : "";
    const errorCount = consoleLog.filter((e) => e.level === "error").length;
    const warnCount = consoleLog.filter((e) => e.level === "warn").length;
    return (_jsxs("div", { className: "app", children: [_jsx(TitleBar, { children: _jsxs(MenuBar, { children: [_jsx("span", { className: "brand", children: "ReChimera" }), _jsxs(Menu, { label: "File", children: [_jsx(MenuItem, { onSelect: () => setOpenLevelModalOpen(true), children: "Open Level\u2026" }), _jsx(MenuItem, { onSelect: handleClose, disabled: !summary, children: "Close Level" })] }), _jsxs(Menu, { label: "View", children: [_jsx(MenuCheckItem, { checked: view.showGrid, onToggle: () => toggle("showGrid"), children: "Grid" }), _jsx(MenuCheckItem, { checked: view.showAxes, onToggle: () => toggle("showAxes"), children: "Axes" }), _jsx(MenuCheckItem, { checked: view.showStats, onToggle: () => toggle("showStats"), children: "FPS Graph (vs counter)" })] }), _jsxs(Menu, { label: "Render", children: [_jsx(MenuCheckItem, { checked: view.showMobys, onToggle: () => toggle("showMobys"), disabled: !summary, children: "Mobys" }), _jsx(MenuCheckItem, { checked: view.showTies, onToggle: () => toggle("showTies"), disabled: !summary, children: "Ties" }), _jsx(MenuCheckItem, { checked: view.showUFrags, onToggle: () => toggle("showUFrags"), disabled: !summary, children: "UFrag Terrain" }), _jsx(MenuCheckItem, { checked: view.showUFragBounds, onToggle: () => toggle("showUFragBounds"), disabled: !summary, children: "UFrag Bounds (debug)" })] }), _jsx(Menu, { label: "Layout", children: _jsx(MenuItem, { onSelect: () => resetAll(dispatch), children: "Reset to default" }) }), _jsx(Menu, { label: "Tools", children: _jsx(MenuItem, { onSelect: () => setPsarcOpen(true), children: "PSARC Extractor\u2026" }) }), _jsx(Menu, { label: "Help", children: _jsx(MenuItem, { onSelect: () => window.open("https://github.com/Mrroboto9819/ReLunacy", "_blank"), children: "GitHub" }) }), _jsx(MenuSpacer, {}), _jsx("button", { className: "btn btn-primary", onClick: () => setOpenLevelModalOpen(true), disabled: busy, title: "Open a level folder", "data-tauri-drag-region": "false", children: busy ? "Loading…" : summary ? "Open another…" : "Open Level…" })] }) }), _jsx(Toolbar, { view: view, onToggle: toggle, hasLevel: summary != null, info: toolbarInfo }), summary ? (_jsx("div", { className: "workspace", children: _jsxs(PanelGroup, { direction: "horizontal", autoSaveId: "rechimera-workspace-h", className: "workspace-h", children: [_jsx(Panel, { defaultSize: layout.hierarchyPct, minSize: 10, maxSize: 40, onResize: (size) => dispatch(setHierarchyPct(size)), className: "workspace-pane", children: _jsx(Hierarchy, { instances: instances, selection: selection }) }), _jsx(PanelResizeHandle, { className: "resize-handle resize-handle-h" }), _jsx(Panel, { minSize: 30, className: "workspace-pane", children: _jsxs(PanelGroup, { direction: "vertical", autoSaveId: "rechimera-workspace-v", children: [_jsx(Panel, { minSize: 20, className: "workspace-pane", children: _jsx("div", { className: "panel pane-viewport", children: _jsx(Viewport, { instances: instances, ufrags: ufrags, meshes: meshes, selection: selection, view: view }) }) }), _jsx(PanelResizeHandle, { className: "resize-handle resize-handle-v" }), _jsx(Panel, { defaultSize: layout.consoleCollapsed ? 4 : layout.bottomPct, minSize: layout.consoleCollapsed ? 4 : 12, maxSize: 60, onResize: (size) => {
                                            if (!layout.consoleCollapsed) {
                                                dispatch(setBottomPct(size));
                                            }
                                        }, className: "workspace-pane", children: _jsx(BottomPanel, { summary: summary, console: consoleLog, collapsed: layout.consoleCollapsed, onToggleCollapsed: () => dispatch(toggleConsoleCollapsed()), errorCount: errorCount, warnCount: warnCount }) })] }) }), _jsx(PanelResizeHandle, { className: "resize-handle resize-handle-h" }), _jsx(Panel, { defaultSize: layout.inspectorPct, minSize: 14, maxSize: 45, onResize: (size) => dispatch(setInspectorPct(size)), className: "workspace-pane", children: _jsx(Inspector, { selected: primaryInstance, selectionCount: selection.count, meshes: meshes, instances: instances, onExportSelected: handleExportSelection }) })] }) })) : (_jsx("div", { className: "workspace-empty", children: _jsxs("div", { className: "hint", children: [_jsx("button", { type: "button", className: "btn btn-primary export-btn", onClick: () => setOpenLevelModalOpen(true), style: { width: "auto", marginBottom: 16 }, children: "Open Level\u2026" }), _jsxs("p", { className: "dim", children: ["Or use ", _jsx("span", { className: "kbd", children: "File \u25B8 Open Level\u2026" })] }), _jsxs("p", { className: "small dim", style: { marginTop: 12 }, children: ["Pick any folder containing ", _jsx("code", { children: "assetlookup.dat" }), " \u2014 Resistance 2/3, Ratchet & Clank Future, and other Insomniac PS3 titles."] })] }) })), _jsx(StatusBar, { summary: summary, meshesCount: meshes?.moby_assets.length ?? 0, instanceCount: instances.length, ufragCount: ufrags.length, meshes: meshes, loadPhase: loadPhase, error: error }), _jsx(OpenLevelModal, { open: openLevelModalOpen, busy: busy, onClose: () => setOpenLevelModalOpen(false), onOpen: (folder) => handleOpen(folder) }), _jsx(Modal, { open: loadPhase !== null, dismissable: false, title: "Loading level", subtitle: "Decoding meshes, terrain, and textures from disk", size: "md", children: _jsx(LoadProgress, { active: loadPhase, completed: completedPhases }) }), _jsx(Modal, { open: psarcOpen, onClose: () => setPsarcOpen(false), title: "PSARC Extractor", subtitle: "Read and extract PlayStation Archive files (PS3 .psarc)", size: "lg", children: _jsx(PsarcTools, {}) }), _jsx(Modal
            
            , { 
                
                open: exportState !== null &&
                    exportState.phase !== "done" &&
                    !exportState.cancelled, onClose: () => setExportState(null), 
                
                dismissable: exportState?.phase === "done" || exportState?.cancelled === true, title: "Exporting selection", subtitle: "Building scene \u2192 encoding glTF \u2192 writing to disk", size: "md", children: exportState && _jsx(ExportProgress, { state: exportState }) })] }));
}
