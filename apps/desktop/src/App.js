import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useRef, useState } from "react";
import { levelLayout, levelMeshes, openLevel, } from "./api";
import { Inspector } from "./Inspector";
import { Menu, MenuBar, MenuCheckItem, MenuItem, MenuSpacer } from "./MenuBar";
import { Viewport } from "./Viewport";
function folderName(path) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}
const DEFAULT_VIEW = {
    showMobys: true,
    showTies: true,
    showUFrags: true,
    showUFragBounds: false,
    showGrid: true,
    showAxes: true,
    showStats: false,
};
export function App() {
    const [path, setPath] = useState("");
    const [summary, setSummary] = useState(null);
    const [instances, setInstances] = useState([]);
    const [ufrags, setUFrags] = useState([]);
    const [meshes, setMeshes] = useState(null);
    const [selected, setSelected] = useState(null);
    const [activeKind, setActiveKind] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [meshStatus, setMeshStatus] = useState(null);
    const [view, setView] = useState(DEFAULT_VIEW);
    const pathRef = useRef(null);
    const handleOpen = useCallback(async () => {
        const folder = path.trim();
        if (!folder)
            return;
        setError(null);
        setBusy(true);
        setSelected(null);
        setActiveKind(null);
        setMeshes(null);
        setMeshStatus(null);
        try {
            const sum = await openLevel(folder);
            setSummary(sum);
            const layout = await levelLayout(sum.folder);
            setInstances(layout.instances);
            setUFrags(layout.ufrags);
            // Mesh decoding can take a moment for a full level — kick it off after
            // the layout renders so the user sees instances immediately.
            setMeshStatus("Decoding meshes…");
            try {
                const m = await levelMeshes(sum.folder);
                setMeshes(m);
                setMeshStatus(null);
            }
            catch (e) {
                setMeshStatus(`Mesh decode failed: ${e}`);
            }
        }
        catch (e) {
            setError(String(e));
            setSummary(null);
            setInstances([]);
            setUFrags([]);
        }
        finally {
            setBusy(false);
        }
    }, [path]);
    const handleClose = useCallback(() => {
        setSummary(null);
        setInstances([]);
        setUFrags([]);
        setMeshes(null);
        setSelected(null);
        setActiveKind(null);
        setError(null);
        setMeshStatus(null);
    }, []);
    const toggle = useCallback((key) => setView((v) => ({ ...v, [key]: !v[key] })), []);
    return (_jsxs("div", { className: "app", children: [_jsxs(MenuBar, { children: [_jsx("span", { className: "brand", children: "ReChimera" }), _jsxs(Menu, { label: "File", children: [_jsx(MenuItem, { onSelect: () => pathRef.current?.focus(), children: "Open Level\u2026" }), _jsx(MenuItem, { onSelect: handleClose, disabled: !summary, children: "Close Level" })] }), _jsxs(Menu, { label: "View", children: [_jsx(MenuCheckItem, { checked: view.showGrid, onToggle: () => toggle("showGrid"), children: "Grid" }), _jsx(MenuCheckItem, { checked: view.showAxes, onToggle: () => toggle("showAxes"), children: "Axes" }), _jsx(MenuCheckItem, { checked: view.showStats, onToggle: () => toggle("showStats"), children: "Stats Overlay" })] }), _jsxs(Menu, { label: "Render", children: [_jsx(MenuCheckItem, { checked: view.showMobys, onToggle: () => toggle("showMobys"), disabled: !summary, children: "Mobys" }), _jsx(MenuCheckItem, { checked: view.showTies, onToggle: () => toggle("showTies"), disabled: !summary, children: "Ties" }), _jsx(MenuCheckItem, { checked: view.showUFrags, onToggle: () => toggle("showUFrags"), disabled: !summary, children: "UFrag Terrain" }), _jsx(MenuCheckItem, { checked: view.showUFragBounds, onToggle: () => toggle("showUFragBounds"), disabled: !summary, children: "UFrag Bounds (debug)" })] }), _jsx(Menu, { label: "About", children: _jsx(MenuItem, { onSelect: () => window.open("https://github.com/Mrroboto9819/ReLunacy", "_blank"), children: "GitHub" }) }), _jsx(MenuSpacer, {}), _jsx("input", { ref: pathRef, className: "menubar-path", type: "text", placeholder: "Path to level folder containing assetlookup.dat", value: path, onChange: (e) => setPath(e.target.value), onKeyDown: (e) => e.key === "Enter" && handleOpen(), disabled: busy, spellCheck: false }), _jsx("button", { className: "btn btn-primary", onClick: handleOpen, disabled: busy || !path.trim(), children: busy ? "…" : "Open" })] }), summary && (_jsxs("div", { className: "status-strip", children: [_jsx("strong", { children: folderName(summary.folder) }), _jsxs("span", { className: "meta", children: ["IGHW v", summary.version_major, ".", summary.version_minor, " \u00B7", " ", summary.sections.length, " sections \u00B7", " ", instances.length.toLocaleString(), " instances \u00B7", " ", ufrags.length.toLocaleString(), " UFrags", meshes && (_jsxs(_Fragment, { children: [" · ", meshes.moby_assets.length, " mobys / ", meshes.tie_assets.length, " ties /", " ", meshes.ufrag_meshes.length, " terrain chunks decoded"] })), meshStatus && _jsxs("span", { className: "dim", children: [" \u00B7 ", meshStatus] })] })] })), error && _jsx("div", { className: "error-banner", children: error }), summary ? (_jsxs("main", { className: "workspace", children: [_jsx(Viewport, { instances: instances, ufrags: ufrags, meshes: meshes, selected: selected, onSelect: setSelected, view: view }), _jsx(Inspector, { summary: summary, selected: selected, activeKind: activeKind, onActiveKindChange: setActiveKind })] })) : (!error && (_jsx("div", { className: "workspace-empty", children: _jsxs("div", { className: "hint", children: [_jsxs("p", { children: ["Use ", _jsx("span", { className: "kbd", children: "File \u25B8 Open Level\u2026" }), " or paste a level folder path above."] }), _jsxs("p", { className: "dim", children: ["The folder must contain ", _jsx("code", { children: "assetlookup.dat" }), " (Resistance 2/3 or R&C Future)."] }), _jsxs("p", { className: "small dim", children: ["e.g. ", _jsx("code", { children: "C:\\Users\\you\\Documents\\mods\\resistance 2\\axbridge_coop" })] })] }) })))] }));
}
