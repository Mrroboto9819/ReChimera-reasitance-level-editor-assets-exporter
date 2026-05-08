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

export function BottomPanel({ console }: BottomPanelProps) {
  return (
    <div className="panel pane-bottom view-flush">
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
    </div>
  );
}
