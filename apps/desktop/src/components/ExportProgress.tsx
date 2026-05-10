import type { ExportPhase, ExportProgressState } from "../export";

interface ExportProgressProps {
  state: ExportProgressState;
}

const PHASE_ORDER: ExportPhase[] = [
  "preparing",
  "decoding-textures",
  "encoding",
  "writing",
  "done",
];

const PHASE_LABEL: Record<ExportPhase, string> = {
  preparing: "Prep",
  "decoding-textures": "Tex",
  encoding: "Encode",
  writing: "Write",
  done: "Done",
};

export function ExportProgress({ state }: ExportProgressProps) {
  const pct = Math.round(Math.min(1, Math.max(0, state.fraction)) * 100);
  const activeIdx = PHASE_ORDER.indexOf(state.phase);

  return (
    <div className="export-progress">
      <div className="export-progress-header">
        <span className="export-progress-label">{state.label}</span>
        <span className="export-progress-pct mono small">{pct}%</span>
      </div>
      <div className="load-progress-bar">
        <div
          className="load-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="export-progress-pips">
        {PHASE_ORDER.filter((p) => p !== "done").map((p, i) => {
          const isActive = state.phase === p;
          const isDone = activeIdx > i || state.phase === "done";
          return (
            <span
              key={p}
              className={`pip ${
                isActive ? "pip-active" : isDone ? "pip-done" : "pip-pending"
              }`}
              title={p}
            >
              <span className="pip-tag">{PHASE_LABEL[p]}</span>
            </span>
          );
        })}
      </div>
      {state.detail && (
        <div className="export-progress-detail mono small dim">
          {state.detail}
        </div>
      )}
    </div>
  );
}
