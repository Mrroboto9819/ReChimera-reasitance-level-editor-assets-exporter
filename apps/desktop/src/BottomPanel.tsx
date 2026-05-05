import { useEffect, useState } from "react";
import {
  listAssets,
  type AssetKind,
  type AssetPointer,
  type LevelSummary,
} from "./api";
import { PsarcTools } from "./PsarcTools";

export interface ConsoleEntry {
  ts: number;
  level: "info" | "ok" | "warn" | "error";
  msg: string;
}

interface BottomPanelProps {
  summary: LevelSummary | null;
  console: ConsoleEntry[];
  /** Optional toggle for collapsing the panel (delegated to the parent). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Counts shown in the header even when collapsed. */
  errorCount?: number;
  warnCount?: number;
}

type Tab = "console" | "assets" | "tools";

function hex(n: number, width = 8): string {
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function BottomPanel({
  summary,
  console,
  collapsed,
  onToggleCollapsed,
  errorCount = 0,
  warnCount = 0,
}: BottomPanelProps) {
  const [tab, setTab] = useState<Tab>("console");
  const [activeKind, setActiveKind] = useState<AssetKind | null>(null);
  const [assets, setAssets] = useState<AssetPointer[]>([]);
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
        if (!cancelled) setAssets(a);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, activeKind, summary]);

  return (
    <div className={`panel pane-bottom ${collapsed ? "collapsed" : ""}`}>
      <div className="panel-header">
        <div className="panel-header-tabs">
          <button
            type="button"
            className={`panel-tab ${tab === "console" ? "active" : ""}`}
            onClick={() => {
              setTab("console");
              if (collapsed) onToggleCollapsed?.();
            }}
          >
            Console
            <span className="badge-cluster">
              {console.length > 0 && (
                <span className="badge badge-neutral">{console.length}</span>
              )}
              {warnCount > 0 && (
                <span className="badge badge-warn">{warnCount}</span>
              )}
              {errorCount > 0 && (
                <span className="badge badge-error">{errorCount}</span>
              )}
            </span>
          </button>
          <button
            type="button"
            className={`panel-tab ${tab === "assets" ? "active" : ""}`}
            onClick={() => {
              setTab("assets");
              if (collapsed) onToggleCollapsed?.();
            }}
            disabled={!summary}
          >
            Assets
          </button>
          <button
            type="button"
            className={`panel-tab ${tab === "tools" ? "active" : ""}`}
            onClick={() => {
              setTab("tools");
              if (collapsed) onToggleCollapsed?.();
            }}
          >
            Tools
          </button>
        </div>
        {onToggleCollapsed && (
          <button
            type="button"
            className="panel-icon-btn"
            onClick={onToggleCollapsed}
            title={collapsed ? "Expand panel" : "Collapse panel"}
          >
            {collapsed ? "▴" : "▾"}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="panel-body">
          {tab === "console" ? (
            <div className="console-log">
              {console.length === 0 ? (
                <div className="tree-empty">No log entries yet.</div>
              ) : (
                console.map((e, i) => (
                  <div key={i} className={`console-line ${e.level}`}>
                    <span className="console-time">{formatTime(e.ts)}</span>
                    <span className="console-msg">{e.msg}</span>
                  </div>
                ))
              )}
            </div>
          ) : tab === "tools" ? (
            <PsarcTools />
          ) : !summary ? (
            <div className="tree-empty">Open a level to browse assets.</div>
          ) : (
            <div className="asset-browser">
              <div className="kind-row">
                {summary.asset_counts.map((c) => (
                  <button
                    key={c.kind}
                    className={[
                      "kind",
                      activeKind === c.kind ? "active" : "",
                      c.present ? "" : "absent",
                    ]
                      .join(" ")
                      .trim()}
                    onClick={() =>
                      setActiveKind(activeKind === c.kind ? null : c.kind)
                    }
                    disabled={!c.present}
                    title={`section ${hex(c.section_id, 6)}`}
                  >
                    <span className="kind-name">{c.kind}</span>
                    <span className="kind-count">
                      {c.count.toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
              {activeKind && (
                <div className="asset-scroll">
                  {loading ? (
                    <p className="dim small" style={{ padding: "6px 12px" }}>
                      Loading…
                    </p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>TUID</th>
                          <th>Offset</th>
                          <th>Length</th>
                        </tr>
                      </thead>
                      <tbody>
                        {assets.map((a, i) => (
                          <tr key={`${a.tuid}-${i}`}>
                            <td className="mono">{a.tuid}</td>
                            <td className="mono">{hex(a.offset)}</td>
                            <td className="mono">{hex(a.length, 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
