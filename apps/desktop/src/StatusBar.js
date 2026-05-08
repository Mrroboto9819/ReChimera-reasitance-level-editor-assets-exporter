import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
function folderName(path) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}





export function StatusBar({ summary, meshesCount, instanceCount, ufragCount, meshes, loadPhase, error, }) {
    const dotClass = error
        ? "error"
        : loadPhase
            ? "busy"
            : summary
                ? "ok"
                : "";
    const dotLabel = error
        ? "Error"
        : loadPhase
            ? loadPhase.label
            : summary
                ? "Ready"
                : "Idle";
    return (_jsxs("div", { className: "statusbar", children: [_jsxs("span", { className: "statusbar-cell", children: [_jsx("span", { className: `statusbar-dot ${dotClass}` }), _jsx("span", { children: dotLabel })] }), summary && (_jsxs(_Fragment, { children: [_jsx("span", { className: "statusbar-divider" }), _jsx("span", { className: "statusbar-cell", title: summary.folder, children: folderName(summary.folder) }), _jsx("span", { className: "statusbar-divider" }), _jsxs("span", { className: "statusbar-cell", children: ["IGHW v", summary.version_major, ".", summary.version_minor] }), _jsx("span", { className: "statusbar-divider" }), _jsxs("span", { className: "statusbar-cell", children: [summary.sections.length, " sections"] })] })), _jsx("span", { className: "toolbar-spacer" }), summary && (_jsxs(_Fragment, { children: [_jsxs("span", { className: "statusbar-cell", children: [instanceCount.toLocaleString(), " instances"] }), _jsx("span", { className: "statusbar-divider" }), _jsxs("span", { className: "statusbar-cell", children: [ufragCount.toLocaleString(), " UFrags"] }), meshes && (_jsxs(_Fragment, { children: [_jsx("span", { className: "statusbar-divider" }), _jsxs("span", { className: "statusbar-cell", children: [meshes.moby_assets.length, "M / ", meshes.tie_assets.length, "T /", " ", meshes.ufrag_meshes.length, "U"] }), _jsx("span", { className: "statusbar-divider" }), _jsxs("span", { className: "statusbar-cell", children: [meshes.textures.length, " tex"] })] }))] })), meshesCount < 0 && null] }));
}
