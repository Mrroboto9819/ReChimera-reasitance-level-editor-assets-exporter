import type { LevelSummary } from "./api";

export interface ConsoleEntry {
  ts: number;
  level: "info" | "ok" | "warn" | "error";
  msg: string;
}

interface BottomPanelProps {
  summary: LevelSummary | null;
  console: ConsoleEntry[];
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  errorCount?: number;
  warnCount?: number;
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
  console,
  collapsed,
  onToggleCollapsed,
  errorCount = 0,
  warnCount = 0,
}: BottomPanelProps) {
  return (
    <div className={`panel pane-bottom ${collapsed ? "collapsed" : ""}`}>
      <button
        type="button"
        className="panel-header panel-header-toggle"
        onClick={onToggleCollapsed}
        title={collapsed ? "Expand console" : "Collapse console"}
        aria-expanded={!collapsed}
      >
        <div className="panel-header-tabs">
          <span className={`panel-tab ${collapsed ? "" : "active"}`}>
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
          </span>
        </div>
      </button>
      {!collapsed && (
        <div className="panel-body">
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
        </div>
      )}
    </div>
  );
}
