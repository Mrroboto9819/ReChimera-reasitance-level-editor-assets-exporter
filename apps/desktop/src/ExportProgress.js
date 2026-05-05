import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const PHASE_ORDER = [
    "picking",
    "preparing",
    "decoding-textures",
    "encoding",
    "writing",
    "done",
];
const PHASE_LABEL = {
    picking: "Pick",
    preparing: "Prep",
    "decoding-textures": "Tex",
    encoding: "Encode",
    writing: "Write",
    done: "Done",
};
export function ExportProgress({ state }) {
    const pct = Math.round(Math.min(1, Math.max(0, state.fraction)) * 100);
    const activeIdx = PHASE_ORDER.indexOf(state.phase);
    return (_jsxs("div", { className: "export-progress", children: [_jsxs("div", { className: "export-progress-header", children: [_jsx("span", { className: "export-progress-label", children: state.label }), _jsxs("span", { className: "export-progress-pct mono small", children: [pct, "%"] })] }), _jsx("div", { className: "load-progress-bar", children: _jsx("div", { className: "load-progress-fill", style: { width: `${pct}%` } }) }), _jsx("div", { className: "export-progress-pips", children: PHASE_ORDER.filter((p) => p !== "done").map((p, i) => {
                    const isActive = state.phase === p;
                    const isDone = activeIdx > i || state.phase === "done";
                    return (_jsx("span", { className: `pip ${isActive ? "pip-active" : isDone ? "pip-done" : "pip-pending"}`, title: p, children: _jsx("span", { className: "pip-tag", children: PHASE_LABEL[p] }) }, p));
                }) }), state.detail && (_jsx("div", { className: "export-progress-detail mono small dim", children: state.detail }))] }));
}
