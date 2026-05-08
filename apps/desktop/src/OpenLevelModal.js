import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "./Modal";












export function OpenLevelModal({ open, busy, onClose, onOpen, }) {
    const [path, setPath] = useState("");
    const [warning, setWarning] = useState(null);
    // Reset on open/close so the field doesn't carry stale paths between
    // sessions. The user typically picks a different level each time.
    useEffect(() => {
        if (open)
            setWarning(null);
    }, [open]);
    const handleBrowse = useCallback(async () => {
        setWarning(null);
        try {
            const picked = await openDialog({
                directory: false,
                multiple: false,
                title: "Pick assetlookup.dat (or any .dat in the level folder)",
                filters: [
                    {
                        name: "Insomniac asset lookup",
                        extensions: ["dat"],
                    },
                    {
                        name: "All files",
                        extensions: ["*"],
                    },
                ],
            });
            if (typeof picked !== "string")
                return;
            
            const lastSep = Math.max(picked.lastIndexOf("/"), picked.lastIndexOf("\\"));
            const folder = lastSep > 0 ? picked.slice(0, lastSep) : picked;
            const filename = lastSep >= 0 ? picked.slice(lastSep + 1) : picked;
            setPath(folder);
            
            
            
            
            if (filename.toLowerCase() !== "assetlookup.dat") {
                setWarning(`You picked “${filename}” — the parser will look for assetlookup.dat in this folder.`);
            }
        }
        catch (e) {
            setWarning(`File picker failed: ${e}`);
        }
    }, []);
    const handleBrowseFolder = useCallback(async () => {
        setWarning(null);
        try {
            const picked = await openDialog({
                directory: true,
                multiple: false,
                title: "Pick a level folder",
            });
            if (typeof picked === "string")
                setPath(picked);
        }
        catch (e) {
            setWarning(`Folder picker failed: ${e}`);
        }
    }, []);
    const handleConfirm = useCallback(() => {
        const trimmed = path.trim();
        if (!trimmed)
            return;
        onOpen(trimmed);
    }, [path, onOpen]);
    return (_jsx(Modal, { open: open, onClose: onClose, title: "Open level", subtitle: "Pick the level folder containing assetlookup.dat", size: "lg", footer: _jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "btn", onClick: onClose, disabled: busy, children: "Cancel" }), _jsx("button", { type: "button", className: "btn btn-primary", onClick: handleConfirm, disabled: busy || !path.trim(), children: busy ? "Loading…" : "Open" })] }), children: _jsxs("div", { className: "open-level", children: [_jsxs("div", { className: "psarc-row", children: [_jsx("label", { className: "psarc-label", children: "Folder" }), _jsx("input", { type: "text", value: path, onChange: (e) => setPath(e.target.value), onKeyDown: (e) => {
                                if (e.key === "Enter")
                                    handleConfirm();
                            }, placeholder: "Pick a file or folder, or paste a path", spellCheck: false, disabled: busy, autoFocus: true })] }), _jsxs("div", { className: "open-level-actions", children: [_jsxs("button", { type: "button", className: "btn", onClick: handleBrowse, disabled: busy, title: "Pick assetlookup.dat \u2014 we'll use the parent folder", children: ["Browse for ", _jsx("code", { children: "assetlookup.dat" }), "\u2026"] }), _jsx("button", { type: "button", className: "btn", onClick: handleBrowseFolder, disabled: busy, title: "Pick a folder directly", children: "Browse folder\u2026" })] }), warning && _jsx("div", { className: "open-level-warning", children: warning }), _jsxs("div", { className: "open-level-hint dim small", children: ["Supports any folder containing ", _jsx("code", { children: "assetlookup.dat" }), " \u2014 Resistance 2/3, Ratchet & Clank Future, and other Insomniac PS3 titles using the new-engine asset format."] })] }) }));
}
