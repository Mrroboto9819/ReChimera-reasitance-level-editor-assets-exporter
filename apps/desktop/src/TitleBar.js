import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
function classifyPlatform(p) {
    if (p === "macos")
        return "macos";
    if (p === "windows")
        return "windows";
    if (p === "linux")
        return "linux";
    return "other";
}
/**
 * Custom window chrome — replaces Tauri's native title bar (which is
 * disabled via `decorations: false` in tauri.conf.json).
 *
 * Layout per platform:
 * - macOS:   [traffic lights]   [children — drag region]
 * - Windows: [children — drag region]   [─] [□] [×]
 * - Linux/other: same as Windows for now.
 *
 * The whole bar is `data-tauri-drag-region` so empty space drags the
 * window. Buttons / inputs inside `children` keep their normal click
 * behavior (Tauri ignores drag on elements with their own handlers).
 */
export function TitleBar({ children }) {
    const [os, setOs] = useState("other");
    const [maximized, setMaximized] = useState(false);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const p = platform();
                if (!cancelled)
                    setOs(classifyPlatform(p));
            }
            catch {
                // Plugin unavailable (e.g. running in a plain browser dev preview):
                // fall back to userAgent sniffing so the UI still renders something.
                if (!cancelled) {
                    const ua = navigator.userAgent.toLowerCase();
                    setOs(ua.includes("mac") ? "macos" : "windows");
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);
    // Track maximized state so the maximize button can show the "restore"
    // glyph when appropriate. Listening to resize is the cheapest signal.
    useEffect(() => {
        if (os !== "windows" && os !== "linux" && os !== "other")
            return;
        const win = getCurrentWindow();
        const update = async () => {
            try {
                setMaximized(await win.isMaximized());
            }
            catch {
                /* ignore */
            }
        };
        update();
        const unlisten = win.onResized(update);
        return () => {
            unlisten.then((fn) => fn());
        };
    }, [os]);
    const win = getCurrentWindow();
    // Explicit handler — more reliable than Tauri's auto-injected drag-region
    // script, which has been spotty on Windows 11 WebView2. Bails out for
    // interactive children (buttons/inputs/menus) so they still get clicks.
    //
    // We attach to BOTH mousedown and pointerdown, since some WebView2 builds
    // fire one but not the other before the OS decides what to do with the
    // window. Calling startDragging() twice in the same gesture is a no-op.
    const isInteractive = (target) => {
        if (!(target instanceof HTMLElement))
            return false;
        return !!target.closest('button, input, a, select, textarea, [data-tauri-drag-region="false"]');
    };
    const onTitleMouseDown = (e) => {
        if (e.button !== 0)
            return;
        if (isInteractive(e.target))
            return;
        if (e.detail === 2) {
            win.toggleMaximize().catch((err) => console.warn("toggleMaximize:", err));
            return;
        }
        win
            .startDragging()
            .catch((err) => console.warn("startDragging failed — check core:window:allow-start-dragging capability + restart `tauri dev`:", err));
    };
    const onTitlePointerDown = (e) => {
        if (e.button !== 0)
            return;
        if (e.pointerType !== "mouse")
            return;
        if (isInteractive(e.target))
            return;
        // Don't double-fire on double-click — let mousedown handle that path.
        if (e.detail === 2)
            return;
        win.startDragging().catch(() => {
            /* swallow — mousedown handler will log if both fail */
        });
    };
    return (_jsxs("div", { className: `titlebar titlebar-${os}`, "data-tauri-drag-region": "", onMouseDown: onTitleMouseDown, onPointerDown: onTitlePointerDown, children: [os === "macos" && (_jsxs("div", { className: "titlebar-traffic", "data-tauri-drag-region": "false", children: [_jsx("button", { type: "button", className: "traffic-btn traffic-close", "aria-label": "Close", onClick: () => win.close(), children: _jsx("svg", { width: "6", height: "6", viewBox: "0 0 6 6", "aria-hidden": true, children: _jsx("path", { d: "M1 1 L5 5 M5 1 L1 5", stroke: "currentColor", strokeWidth: "1", strokeLinecap: "round" }) }) }), _jsx("button", { type: "button", className: "traffic-btn traffic-min", "aria-label": "Minimize", onClick: () => win.minimize(), children: _jsx("svg", { width: "6", height: "2", viewBox: "0 0 6 2", "aria-hidden": true, children: _jsx("rect", { width: "6", height: "1", y: "0.5", fill: "currentColor" }) }) }), _jsx("button", { type: "button", className: "traffic-btn traffic-max", "aria-label": "Maximize", onClick: () => win.toggleMaximize(), children: _jsx("svg", { width: "6", height: "6", viewBox: "0 0 6 6", "aria-hidden": true, children: _jsx("path", { d: "M1 3 L3 1 M3 5 L5 3", stroke: "currentColor", strokeWidth: "1", strokeLinecap: "round" }) }) })] })), _jsx("div", { className: "titlebar-content", "data-tauri-drag-region": "", children: children }), os !== "macos" && (_jsxs("div", { className: "titlebar-caption", "data-tauri-drag-region": "false", children: [_jsx("button", { type: "button", className: "caption-btn caption-min", "aria-label": "Minimize", onClick: () => win.minimize(), children: _jsx("svg", { width: "10", height: "10", viewBox: "0 0 10 10", "aria-hidden": true, children: _jsx("rect", { x: "1", y: "5", width: "8", height: "1", fill: "currentColor" }) }) }), _jsx("button", { type: "button", className: "caption-btn caption-max", "aria-label": maximized ? "Restore" : "Maximize", onClick: () => win.toggleMaximize(), children: maximized ? (_jsxs("svg", { width: "10", height: "10", viewBox: "0 0 10 10", "aria-hidden": true, children: [_jsx("rect", { x: "2", y: "0.5", width: "7", height: "7", fill: "none", stroke: "currentColor", strokeWidth: "1" }), _jsx("rect", { x: "0.5", y: "2.5", width: "7", height: "7", fill: "var(--surface-100)", stroke: "currentColor", strokeWidth: "1" })] })) : (_jsx("svg", { width: "10", height: "10", viewBox: "0 0 10 10", "aria-hidden": true, children: _jsx("rect", { x: "0.5", y: "0.5", width: "9", height: "9", fill: "none", stroke: "currentColor", strokeWidth: "1" }) })) }), _jsx("button", { type: "button", className: "caption-btn caption-close", "aria-label": "Close", onClick: () => win.close(), children: _jsx("svg", { width: "10", height: "10", viewBox: "0 0 10 10", "aria-hidden": true, children: _jsx("path", { d: "M1 1 L9 9 M9 1 L1 9", stroke: "currentColor", strokeWidth: "1", strokeLinecap: "round" }) }) })] }))] }));
}
