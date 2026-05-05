import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useRef, } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
const SIZE_WIDTH = {
    sm: 360,
    md: 480,
    lg: 640,
};
/**
 * Reusable modal with GSAP-driven enter/exit. Designed to layer on top of
 * any view — uses a portal mounted on `document.body` so z-index never
 * fights with the rest of the app.
 *
 * The component keeps its DOM mounted across `open` toggles so GSAP can run
 * the exit timeline; once the exit completes, it sets `display: none` to
 * keep the document tree small.
 */
export function Modal({ open, onClose, dismissable = true, title, subtitle, footer, size = "md", children, }) {
    const backdropRef = useRef(null);
    const dialogRef = useRef(null);
    // Tracks the currently-running tween so we can interrupt cleanly when the
    // user toggles `open` faster than the animation can settle.
    const tlRef = useRef(null);
    // Drive enter/exit with GSAP. useLayoutEffect ensures the timeline starts
    // from the correct initial state before the browser paints.
    useLayoutEffect(() => {
        const backdrop = backdropRef.current;
        const dialog = dialogRef.current;
        if (!backdrop || !dialog)
            return;
        tlRef.current?.kill();
        if (open) {
            backdrop.style.display = "flex";
            const tl = gsap.timeline();
            tl.fromTo(backdrop, { autoAlpha: 0, backdropFilter: "blur(0px)" }, { autoAlpha: 1, backdropFilter: "blur(8px)", duration: 0.18, ease: "power2.out" }).fromTo(dialog, { autoAlpha: 0, y: 12, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power3.out" }, "-=0.10");
            tlRef.current = tl;
        }
        else {
            const tl = gsap.timeline({
                onComplete: () => {
                    if (backdropRef.current)
                        backdropRef.current.style.display = "none";
                },
            });
            tl.to(dialog, {
                autoAlpha: 0,
                y: 6,
                scale: 0.98,
                duration: 0.14,
                ease: "power2.in",
            }).to(backdrop, {
                autoAlpha: 0,
                backdropFilter: "blur(0px)",
                duration: 0.16,
                ease: "power2.in",
            }, "-=0.06");
            tlRef.current = tl;
        }
    }, [open]);
    // Escape closes when dismissable.
    useEffect(() => {
        if (!open || !dismissable)
            return;
        const handler = (e) => {
            if (e.key === "Escape")
                onClose?.();
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [open, dismissable, onClose]);
    // Lock body scroll while the modal is open.
    useEffect(() => {
        if (!open)
            return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = prev;
        };
    }, [open]);
    const onBackdropClick = useCallback((e) => {
        if (!dismissable)
            return;
        if (e.target === e.currentTarget)
            onClose?.();
    }, [dismissable, onClose]);
    const node = (_jsx("div", { ref: backdropRef, className: "modal-backdrop", onClick: onBackdropClick, style: { display: "none" }, role: "presentation", children: _jsxs("div", { ref: dialogRef, className: "modal-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": title ? "modal-title" : undefined, style: { width: SIZE_WIDTH[size] }, children: [(title || dismissable) && (_jsxs("header", { className: "modal-header", children: [_jsxs("div", { className: "modal-header-text", children: [title && (_jsx("h2", { id: "modal-title", className: "modal-title", children: title })), subtitle && _jsx("p", { className: "modal-subtitle", children: subtitle })] }), dismissable && (_jsx("button", { type: "button", className: "modal-close", onClick: () => onClose?.(), "aria-label": "Close", children: "\u00D7" }))] })), _jsx("div", { className: "modal-body", children: children }), footer && _jsx("footer", { className: "modal-footer", children: footer })] }) }));
    return createPortal(node, document.body);
}
