import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";





export function Inspector({ selected, selectionCount, meshes, onExportSelected, }) {
    const [exporting, setExporting] = useState(false);
    const canExport = selectionCount > 0 && meshes != null;
    const handleExport = async () => {
        if (!onExportSelected || exporting)
            return;
        setExporting(true);
        try {
            await onExportSelected();
        }
        finally {
            setExporting(false);
        }
    };
    return (_jsxs("div", { className: "panel pane-inspector", children: [_jsxs("div", { className: "panel-header", children: [_jsx("span", { children: "Inspector" }), selected && (_jsx("span", { className: `tree-icon kind-${selected.kind}`, children: selected.kind[0]?.toUpperCase() }))] }), _jsxs("div", { className: "panel-body", children: [selectionCount > 1 && (_jsxs("div", { className: "multi-select-banner", children: [_jsx("strong", { children: selectionCount.toLocaleString() }), " objects selected", _jsx("span", { className: "dim small", children: "\u00B7 showing details for the most recent" })] })), _jsx("div", { className: "inspector-actions", children: _jsxs("button", { type: "button", className: `btn btn-primary export-btn ${canExport ? "" : "disabled"}`, onClick: handleExport, disabled: !canExport || exporting, title: canExport
                                ? `Export ${selectionCount} object(s) as .glb`
                                : "Select at least one object to export", children: [_jsx("span", { className: "export-btn-icon", "aria-hidden": true, children: "\u2B07" }), _jsx("span", { className: "export-btn-label", children: exporting
                                        ? "Exporting…"
                                        : selectionCount > 0
                                            ? `Export ${selectionCount} as .glb`
                                            : "Export .glb (select first)" })] }) }), selected ? (_jsxs("div", { className: "inspector-content", children: [_jsxs("div", { className: "inspector-section", children: [_jsx("h4", { children: "Identity" }), _jsxs("dl", { className: "kv", children: [_jsx("dt", { children: "Name" }), _jsx("dd", { children: selected.name || _jsx("span", { className: "dim", children: "unnamed" }) }), _jsx("dt", { children: "Kind" }), _jsx("dd", { children: selected.kind }), _jsx("dt", { children: "Instance" }), _jsx("dd", { className: "mono small", children: selected.tuid.split("#")[0] }), _jsx("dt", { children: "Asset" }), _jsx("dd", { className: "mono small", children: selected.asset_tuid }), _jsx("dt", { children: "Source" }), _jsx("dd", { className: selected.real ? "" : "dim", children: selected.real ? "gameplay / zones" : "debug spiral" })] })] }), _jsxs("div", { className: "inspector-section", children: [_jsx("h4", { children: "Transform" }), _jsxs("dl", { className: "kv", children: [_jsx("dt", { children: "Position" }), _jsxs("dd", { className: "mono small", children: ["[", selected.position.map((v) => v.toFixed(2)).join(", "), "]"] }), _jsx("dt", { children: "Rotation" }), _jsxs("dd", { className: "mono small", children: ["[", selected.quaternion.map((v) => v.toFixed(3)).join(", "), "]"] }), _jsx("dt", { children: "Scale" }), _jsxs("dd", { className: "mono small", children: ["[", selected.scale.map((v) => v.toFixed(3)).join(", "), "]"] })] })] })] })) : (_jsxs("div", { className: "tree-empty", children: ["Click an object in the viewport or hierarchy to inspect.", _jsxs("p", { className: "dim small", style: { marginTop: 8 }, children: ["Hold ", _jsx("span", { className: "kbd", children: "Ctrl" }), " to add to selection,", " ", _jsx("span", { className: "kbd", children: "Shift" }), " for range."] })] }))] })] }));
}
