import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { clickMods } from "./selection";
const KIND_LABELS = {
    moby: "Mobys",
    tie: "Ties",
};
const KIND_GLYPHS = {
    moby: "M",
    tie: "T",
};
/**
 * Hierarchy/Outliner-style tree (Unity Hierarchy / Unreal World Outliner /
 * Godot Scene). Two-level tree: Kind → Instance.
 *
 * Click semantics:
 * - plain click: single select
 * - ctrl/cmd-click: toggle one
 * - shift-click: range from anchor (last single-clicked) to target
 */
export function Hierarchy({ instances, selection }) {
    const [collapsed, setCollapsed] = useState(new Set());
    const [filter, setFilter] = useState("");
    const groups = useMemo(() => {
        const byKind = new Map();
        for (const inst of instances) {
            let arr = byKind.get(inst.kind);
            if (!arr) {
                arr = [];
                byKind.set(inst.kind, arr);
            }
            arr.push(inst);
        }
        const out = [];
        for (const [kind, list] of byKind) {
            out.push({
                kind,
                label: KIND_LABELS[kind] ?? kind,
                instances: list,
            });
        }
        out.sort((a, b) => a.label.localeCompare(b.label));
        return out;
    }, [instances]);
    const toggle = (kind) => setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(kind))
            next.delete(kind);
        else
            next.add(kind);
        return next;
    });
    const filterLower = filter.trim().toLowerCase();
    return (_jsxs("div", { className: "panel pane-hierarchy", children: [_jsxs("div", { className: "panel-header", children: [_jsx("span", { children: "Hierarchy" }), _jsxs("span", { className: "panel-actions", children: [selection.count > 0 && (_jsxs("span", { className: "badge badge-neutral", children: [selection.count.toLocaleString(), " sel"] })), _jsx("span", { className: "tree-count", children: instances.length.toLocaleString() })] })] }), _jsx("div", { className: "hierarchy-search", children: _jsx("input", { type: "text", placeholder: "Filter\u2026", value: filter, onChange: (e) => setFilter(e.target.value), spellCheck: false }) }), _jsx("div", { className: "panel-body", children: groups.length === 0 ? (_jsx("div", { className: "tree-empty", children: "No instances loaded" })) : (_jsx("div", { className: "hierarchy-tree", children: groups.map((g) => {
                        const isCollapsed = collapsed.has(g.kind);
                        const filtered = filterLower
                            ? g.instances.filter((i) => i.name.toLowerCase().includes(filterLower))
                            : g.instances;
                        return (_jsxs("div", { children: [_jsxs("div", { className: "tree-node", onClick: () => toggle(g.kind), children: [_jsx("span", { className: "tree-toggle", children: isCollapsed ? "▸" : "▾" }), _jsx("span", { className: `tree-icon kind-${g.kind}`, children: KIND_GLYPHS[g.kind] ?? "?" }), _jsx("span", { className: "tree-label", children: g.label }), _jsx("span", { className: "tree-count", children: filtered.length === g.instances.length
                                                ? g.instances.length.toLocaleString()
                                                : `${filtered.length}/${g.instances.length}` })] }), !isCollapsed && (_jsxs("div", { className: "tree-children", children: [filtered.slice(0, 500).map((inst, idx) => (_jsxs("div", { className: `tree-node ${selection.isSelected(inst.tuid) ? "selected" : ""} ${selection.primary === inst.tuid ? "primary" : ""}`, onClick: (e) => {
                                                e.stopPropagation();
                                                selection.select(inst, clickMods(e));
                                            }, children: [_jsx("span", { className: "tree-toggle" }), _jsx("span", { className: `tree-icon kind-${inst.kind}`, children: KIND_GLYPHS[inst.kind] ?? "?" }), _jsx("span", { className: "tree-label", children: inst.name || (_jsx("span", { className: "dim", children: "unnamed" })) })] }, `${inst.tuid}-${idx}`))), filtered.length > 500 && (_jsxs("div", { className: "tree-empty small", children: ["showing first 500 of", " ", filtered.length.toLocaleString()] }))] }))] }, g.kind));
                    }) })) })] }));
}
