import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { listAssets, } from "./api";
import { PsarcTools } from "./PsarcTools";
function hex(n, width = 8) {
    return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}
function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}
export function BottomPanel({ summary, console, collapsed, onToggleCollapsed, errorCount = 0, warnCount = 0, }) {
    const [tab, setTab] = useState("console");
    const [activeKind, setActiveKind] = useState(null);
    const [assets, setAssets] = useState([]);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (tab !== "assets" || !activeKind || !summary) {
            setAssets([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        listAssets(summary.folder, activeKind)
            .then((a) => {
            if (!cancelled)
                setAssets(a);
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [tab, activeKind, summary]);
    return (_jsxs("div", { className: `panel pane-bottom ${collapsed ? "collapsed" : ""}`, children: [_jsxs("div", { className: "panel-header", children: [_jsxs("div", { className: "panel-header-tabs", children: [_jsxs("button", { type: "button", className: `panel-tab ${tab === "console" ? "active" : ""}`, onClick: () => {
                                    setTab("console");
                                    if (collapsed)
                                        onToggleCollapsed?.();
                                }, children: ["Console", _jsxs("span", { className: "badge-cluster", children: [console.length > 0 && (_jsx("span", { className: "badge badge-neutral", children: console.length })), warnCount > 0 && (_jsx("span", { className: "badge badge-warn", children: warnCount })), errorCount > 0 && (_jsx("span", { className: "badge badge-error", children: errorCount }))] })] }), _jsx("button", { type: "button", className: `panel-tab ${tab === "assets" ? "active" : ""}`, onClick: () => {
                                    setTab("assets");
                                    if (collapsed)
                                        onToggleCollapsed?.();
                                }, disabled: !summary, children: "Assets" }), _jsx("button", { type: "button", className: `panel-tab ${tab === "tools" ? "active" : ""}`, onClick: () => {
                                    setTab("tools");
                                    if (collapsed)
                                        onToggleCollapsed?.();
                                }, children: "Tools" })] }), onToggleCollapsed && (_jsx("button", { type: "button", className: "panel-icon-btn", onClick: onToggleCollapsed, title: collapsed ? "Expand panel" : "Collapse panel", children: collapsed ? "▴" : "▾" }))] }), !collapsed && (_jsx("div", { className: "panel-body", children: tab === "console" ? (_jsx("div", { className: "console-log", children: console.length === 0 ? (_jsx("div", { className: "tree-empty", children: "No log entries yet." })) : (console.map((e, i) => (_jsxs("div", { className: `console-line ${e.level}`, children: [_jsx("span", { className: "console-time", children: formatTime(e.ts) }), _jsx("span", { className: "console-msg", children: e.msg })] }, i)))) })) : tab === "tools" ? (_jsx(PsarcTools, {})) : !summary ? (_jsx("div", { className: "tree-empty", children: "Open a level to browse assets." })) : (_jsxs("div", { className: "asset-browser", children: [_jsx("div", { className: "kind-row", children: summary.asset_counts.map((c) => (_jsxs("button", { className: [
                                    "kind",
                                    activeKind === c.kind ? "active" : "",
                                    c.present ? "" : "absent",
                                ]
                                    .join(" ")
                                    .trim(), onClick: () => setActiveKind(activeKind === c.kind ? null : c.kind), disabled: !c.present, title: `section ${hex(c.section_id, 6)}`, children: [_jsx("span", { className: "kind-name", children: c.kind }), _jsx("span", { className: "kind-count", children: c.count.toLocaleString() })] }, c.kind))) }), activeKind && (_jsx("div", { className: "asset-scroll", children: loading ? (_jsx("p", { className: "dim small", style: { padding: "6px 12px" }, children: "Loading\u2026" })) : (_jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "TUID" }), _jsx("th", { children: "Offset" }), _jsx("th", { children: "Length" })] }) }), _jsx("tbody", { children: assets.map((a, i) => (_jsxs("tr", { children: [_jsx("td", { className: "mono", children: a.tuid }), _jsx("td", { className: "mono", children: hex(a.offset) }), _jsx("td", { className: "mono", children: hex(a.length, 1) })] }, `${a.tuid}-${i}`))) })] })) }))] })) }))] }));
}
