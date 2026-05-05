import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { listAssets, } from "./api";
function hex(n, width = 8) {
    return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}
export function Inspector({ summary, selected, activeKind, onActiveKindChange, }) {
    const [assets, setAssets] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        if (!activeKind) {
            setAssets([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        listAssets(summary.folder, activeKind)
            .then((list) => {
            if (!cancelled)
                setAssets(list);
        })
            .catch((e) => {
            if (!cancelled)
                setError(String(e));
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [summary.folder, activeKind]);
    return (_jsxs("aside", { className: "inspector", children: [_jsxs("div", { className: "inspector-section", children: [_jsx("h3", { children: "Inspector" }), selected ? (_jsxs("dl", { className: "kv", children: [_jsx("dt", { children: "Name" }), _jsx("dd", { children: selected.name || _jsx("span", { className: "dim", children: "\u2014" }) }), _jsx("dt", { children: "Kind" }), _jsx("dd", { children: selected.kind }), _jsx("dt", { children: "Instance" }), _jsx("dd", { className: "mono small", children: selected.tuid.split("#")[0] }), _jsx("dt", { children: "Asset" }), _jsx("dd", { className: "mono small", children: selected.asset_tuid }), _jsx("dt", { children: "Position" }), _jsxs("dd", { className: "mono", children: ["[", selected.position.map((v) => v.toFixed(2)).join(", "), "]"] }), _jsx("dt", { children: "Quaternion" }), _jsxs("dd", { className: "mono small", children: ["[", selected.quaternion.map((v) => v.toFixed(3)).join(", "), "]"] }), _jsx("dt", { children: "Scale" }), _jsxs("dd", { className: "mono", children: ["[", selected.scale.map((v) => v.toFixed(3)).join(", "), "]"] }), _jsx("dt", { children: "Source" }), _jsx("dd", { className: selected.real ? "" : "dim", children: selected.real ? "gameplay.dat / zones.dat" : "debug spiral" })] })) : (_jsx("p", { className: "dim small", children: "Click an instance in the viewport to inspect it." }))] }), _jsxs("div", { className: "inspector-section", children: [_jsx("h3", { children: "Asset table" }), _jsx("div", { className: "kind-row", children: summary.asset_counts.map((c) => (_jsxs("button", { className: [
                                "kind",
                                activeKind === c.kind ? "active" : "",
                                c.present ? "" : "absent",
                            ]
                                .join(" ")
                                .trim(), onClick: () => onActiveKindChange(activeKind === c.kind ? null : c.kind), disabled: !c.present, title: `section ${hex(c.section_id, 6)}`, children: [_jsx("span", { className: "kind-name", children: c.kind }), _jsx("span", { className: "kind-count", children: c.count.toLocaleString() })] }, c.kind))) }), error && _jsx("div", { className: "error small", children: error }), activeKind && !error && (_jsx("div", { className: "asset-scroll inspector-scroll", children: loading ? (_jsx("p", { className: "dim small", children: "Loading\u2026" })) : (_jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "TUID" }), _jsx("th", { children: "Offset" }), _jsx("th", { children: "Length" })] }) }), _jsx("tbody", { children: assets.map((a, i) => (_jsxs("tr", { children: [_jsx("td", { className: "mono", children: a.tuid }), _jsx("td", { className: "mono", children: hex(a.offset) }), _jsx("td", { className: "mono", children: hex(a.length, 1) })] }, `${a.tuid}-${i}`))) })] })) }))] })] }));
}
