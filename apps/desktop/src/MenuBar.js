import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, } from "react";
const MenuContext = createContext(null);
export function MenuBar({ children }) {
    const [openId, setOpenId] = useState(null);
    const ref = useRef(null);
    useEffect(() => {
        if (!openId)
            return;
        const onClick = (e) => {
            if (ref.current && !ref.current.contains(e.target)) {
                setOpenId(null);
            }
        };
        const onKey = (e) => {
            if (e.key === "Escape")
                setOpenId(null);
        };
        document.addEventListener("mousedown", onClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [openId]);
    const value = useMemo(() => ({ openId, setOpenId }), [openId]);
    return (_jsx(MenuContext.Provider, { value: value, children: _jsx("div", { ref: ref, className: "menubar", children: children }) }));
}
export function Menu({ label, children }) {
    const ctx = useContext(MenuContext);
    if (!ctx)
        throw new Error("Menu must be used inside <MenuBar>");
    const open = ctx.openId === label;
    const onTriggerClick = useCallback(() => {
        ctx.setOpenId(open ? null : label);
    }, [ctx, label, open]);
    const onTriggerHover = useCallback(() => {
        if (ctx.openId !== null && ctx.openId !== label)
            ctx.setOpenId(label);
    }, [ctx, label]);
    return (_jsxs("div", { className: "menu", children: [_jsx("button", { type: "button", className: `menu-trigger ${open ? "open" : ""}`, onClick: onTriggerClick, onMouseEnter: onTriggerHover, children: label }), open && (_jsx("div", { className: "menu-popover", onClick: () => ctx.setOpenId(null), children: children }))] }));
}
export function MenuItem({ onSelect, disabled, shortcut, children }) {
    return (_jsxs("button", { type: "button", className: "menu-item", onClick: onSelect, disabled: disabled, children: [_jsx("span", { children: children }), shortcut && _jsx("span", { className: "kbd", children: shortcut })] }));
}
export function MenuCheckItem({ checked, onToggle, disabled, children, }) {
    return (_jsxs("button", { type: "button", className: "menu-item", onClick: onToggle, disabled: disabled, children: [_jsx("span", { children: children }), _jsx("span", { className: "menu-item-check", children: checked ? "✓" : "" })] }));
}
export function MenuSpacer() {
    return _jsx("div", { className: "menubar-spacer" });
}
