import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { psarcExtractStream, psarcList, } from "./api";













export function PsarcTools() {
    const [inputPath, setInputPath] = useState("");
    const [outputPath, setOutputPath] = useState("");
    const [info, setInfo] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState("");
    const [progress, setProgress] = useState(null);
    // Mirror of progress.total — used inside the streaming callback so we
    // don't capture a stale value from the React render closure.
    const totalRef = useRef(0);
    const handleBrowseInput = useCallback(async () => {
        try {
            const picked = await openDialog({
                directory: false,
                multiple: false,
                title: "Pick a .psarc archive",
                filters: [
                    { name: "PlayStation Archive", extensions: ["psarc", "PSARC"] },
                    { name: "All files", extensions: ["*"] },
                ],
            });
            if (typeof picked === "string")
                setInputPath(picked);
        }
        catch (e) {
            setError(`File picker failed: ${e}`);
        }
    }, []);
    const handleBrowseOutput = useCallback(async () => {
        try {
            const picked = await openDialog({
                directory: true,
                multiple: false,
                title: "Pick an output folder",
            });
            if (typeof picked === "string")
                setOutputPath(picked);
        }
        catch (e) {
            setError(`Folder picker failed: ${e}`);
        }
    }, []);
    const handleList = useCallback(async () => {
        if (!inputPath.trim())
            return;
        setBusy(true);
        setError(null);
        try {
            const list = await psarcList(inputPath.trim());
            setInfo(list);
        }
        catch (e) {
            setError(String(e));
            setInfo(null);
        }
        finally {
            setBusy(false);
        }
    }, [inputPath]);
    const handleExtract = useCallback(async () => {
        if (!inputPath.trim() || !outputPath.trim())
            return;
        setBusy(true);
        setError(null);
        totalRef.current = 0;
        setProgress({ total: 0, current: 0, lastFile: "" });
        try {
            await psarcExtractStream(inputPath.trim(), outputPath.trim(), (e) => {
                switch (e.type) {
                    case "total":
                        totalRef.current = e.total;
                        setProgress({ total: e.total, current: 0, lastFile: "" });
                        break;
                    case "file":
                        setProgress({
                            total: totalRef.current,
                            current: e.index,
                            lastFile: e.name,
                        });
                        break;
                    case "done":
                        setProgress((p) => p ? { ...p, current: p.total, lastFile: "Done." } : p);
                        break;
                    case "error":
                        setError(e.message);
                        break;
                }
            });
        }
        catch (e) {
            setError(String(e));
        }
        finally {
            setBusy(false);
        }
    }, [inputPath, outputPath]);
    const filteredEntries = info?.entries.filter((e) => filter ? e.name.toLowerCase().includes(filter.toLowerCase()) : true);
    const pct = progress && progress.total > 0
        ? Math.min(100, (progress.current / progress.total) * 100)
        : 0;
    return (_jsxs("div", { className: "psarc-tools", children: [_jsxs("div", { className: "psarc-controls", children: [_jsxs("div", { className: "psarc-row", children: [_jsx("label", { className: "psarc-label", children: "Input archive" }), _jsx("input", { type: "text", value: inputPath, onChange: (e) => setInputPath(e.target.value), placeholder: "Click Browse\u2026 or paste a path to a .psarc", spellCheck: false, disabled: busy }), _jsx("button", { className: "btn", onClick: handleBrowseInput, disabled: busy, title: "Pick a .psarc file via the OS dialog", children: "Browse\u2026" }), _jsx("button", { className: "btn", onClick: handleList, disabled: busy || !inputPath.trim(), children: "List" })] }), _jsxs("div", { className: "psarc-row", children: [_jsx("label", { className: "psarc-label", children: "Output folder" }), _jsx("input", { type: "text", value: outputPath, onChange: (e) => setOutputPath(e.target.value), placeholder: "Click Browse\u2026 or paste a destination folder", spellCheck: false, disabled: busy }), _jsx("button", { className: "btn", onClick: handleBrowseOutput, disabled: busy, title: "Pick an output folder via the OS dialog", children: "Browse\u2026" }), _jsx("button", { className: "btn btn-primary", onClick: handleExtract, disabled: busy || !inputPath.trim() || !outputPath.trim(), children: busy && progress ? "Extracting…" : "Extract all" })] })] }), error && _jsx("div", { className: "error-banner", children: error }), info && (_jsxs("div", { className: "psarc-info", children: [_jsxs("div", { className: "psarc-meta", children: [_jsxs("span", { children: [_jsx("span", { className: "dim", children: "v" }), info.major, ".", info.minor] }), _jsxs("span", { children: [_jsx("span", { className: "dim", children: "comp" }), " ", info.compression] }), _jsxs("span", { children: [_jsx("span", { className: "dim", children: "block" }), " ", info.block_size.toLocaleString(), "B"] }), _jsxs("span", { children: [_jsx("strong", { children: info.entry_count.toLocaleString() }), " files"] })] }), progress && progress.total > 0 && (_jsxs("div", { className: "psarc-progress", children: [_jsx("div", { className: "load-progress-bar", children: _jsx("div", { className: "load-progress-fill", style: { width: `${pct}%` } }) }), _jsxs("div", { className: "psarc-progress-meta", children: [_jsxs("span", { className: "mono small", children: [progress.current.toLocaleString(), " /", " ", progress.total.toLocaleString()] }), _jsx("span", { className: "mono small dim", style: {
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            maxWidth: "60%",
                                        }, children: progress.lastFile })] })] })), _jsx("div", { className: "psarc-search", children: _jsx("input", { type: "text", placeholder: "Filter files\u2026", value: filter, onChange: (e) => setFilter(e.target.value), spellCheck: false }) }), _jsx("div", { className: "psarc-table-wrap", children: _jsxs("table", { className: "psarc-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Path" }), _jsx("th", { style: { width: 90, textAlign: "right" }, children: "Size" })] }) }), _jsxs("tbody", { children: [(filteredEntries ?? []).slice(0, 1000).map((e, i) => (_jsxs("tr", { children: [_jsx("td", { className: "mono small", children: e.name || _jsx("em", { children: "unnamed" }) }), _jsx("td", { className: "mono small", style: { textAlign: "right" }, children: e.uncompressed_size.toLocaleString() })] }, `${e.name}-${i}`))), (filteredEntries?.length ?? 0) > 1000 && (_jsx("tr", { children: _jsxs("td", { colSpan: 2, className: "dim small", style: { padding: 6 }, children: ["showing first 1000 of", " ", (filteredEntries?.length ?? 0).toLocaleString()] }) }))] })] }) })] })), !info && !error && (_jsxs("div", { className: "tree-empty", children: ["Enter a path to a ", _jsx("code", { children: ".psarc" }), " file and click", " ", _jsx("strong", { children: "List" }), " to inspect it.", _jsx("p", { className: "dim small", style: { marginTop: 6 }, children: "Supports ZLIB-compressed PSAR v1.3 / v1.4 archives (most PS3-era games). LZMA and OODLE are recognized but not yet decoded." })] }))] }));
}
