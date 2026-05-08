import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const PHASE_ORDER = [
    "layout",
    "shaders",
    "mobys",
    "ties",
    "ufrags",
    "textures",
];
export function LoadProgress({ active, completed }) {
    if (!active)
        return null;
    const pct = active.total > 0
        ? Math.min(100, Math.round((active.current / active.total) * 100))
        : 100;
    
    const completedSet = new Set(completed);
    return (_jsxs("div", { className: "load-progress", role: "status", "aria-live": "polite", children: [_jsxs("div", { className: "load-progress-header", children: [_jsx("span", { className: "load-progress-label", children: active.label }), _jsx("span", { className: "load-progress-count mono small", children: active.total > 0
                            ? `${active.current.toLocaleString()} / ${active.total.toLocaleString()}`
                            : "…" })] }), _jsx("div", { className: "load-progress-bar", children: _jsx("div", { className: "load-progress-fill", style: { width: `${pct}%` } }) }), _jsx("div", { className: "load-progress-pips", children: PHASE_ORDER.map((p) => (_jsx("span", { className: `pip ${p === active.phase
                        ? "pip-active"
                        : completedSet.has(p)
                            ? "pip-done"
                            : "pip-pending"}`, title: p }, p))) })] }));
}
