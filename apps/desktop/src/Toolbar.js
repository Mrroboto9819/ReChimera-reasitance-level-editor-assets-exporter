import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const RENDER_TOGGLES = [
    { key: "showMobys", label: "Mobys", scope: "render" },
    { key: "showTies", label: "Ties", scope: "render" },
    { key: "showUFrags", label: "Terrain", scope: "render" },
];
const VIEW_TOGGLES = [
    { key: "showGrid", label: "Grid", scope: "view" },
    { key: "showAxes", label: "Axes", scope: "view" },
    { key: "showStats", label: "Stats", scope: "view" },
    { key: "showUFragBounds", label: "UFrag bounds", scope: "view" },
];





export function Toolbar({ view, onToggle, hasLevel, info }) {
    return (_jsxs("div", { className: "toolbar", children: [_jsx("div", { className: "toolbar-group", title: "Render layers", children: RENDER_TOGGLES.map((t) => (_jsx("button", { type: "button", className: `toolbar-btn ${view[t.key] ? "active" : ""}`, onClick: () => onToggle(t.key), disabled: !hasLevel, children: t.label }, t.key))) }), _jsx("div", { className: "toolbar-divider" }), _jsx("div", { className: "toolbar-group", title: "Viewport overlays", children: VIEW_TOGGLES.map((t) => (_jsx("button", { type: "button", className: `toolbar-btn ${view[t.key] ? "active" : ""}`, onClick: () => onToggle(t.key), children: t.label }, t.key))) }), _jsx("div", { className: "toolbar-spacer" }), info && _jsx("span", { className: "toolbar-info", children: info })] }));
}
