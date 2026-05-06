import type { PhaseId } from "./api";

export interface LoadPhaseState {
  phase: PhaseId;
  label: string;
  current: number;
  total: number;
  /** Legacy progress hint from the backend. Kept for wire compatibility. */
  chunkSize: number;
}

interface LoadProgressProps {
  /** Currently-active phase, or null when nothing is loading. */
  active: LoadPhaseState | null;
  /** Phases already completed, in order. Used to show overall progress. */
  completed: PhaseId[];
}

const PHASE_ORDER: PhaseId[] = [
  "layout",
  "shaders",
  "mobys",
  "ties",
  "ufrags",
  "textures",
];

export function LoadProgress({ active, completed }: LoadProgressProps) {
  if (!active) return null;

  const pct =
    active.total > 0
      ? Math.min(100, Math.round((active.current / active.total) * 100))
      : 100;

  const completedSet = new Set(completed);

  return (
    <div className="load-progress" role="status" aria-live="polite">
      <div className="load-progress-header">
        <span className="load-progress-label">{active.label}</span>
        <span className="load-progress-count mono small">
          {active.total > 0
            ? `${active.current.toLocaleString()} / ${active.total.toLocaleString()}`
            : "…"}
        </span>
      </div>
      <div className="load-progress-bar">
        <div
          className="load-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="load-progress-pips">
        {PHASE_ORDER.map((p) => (
          <span
            key={p}
            className={`pip ${
              p === active.phase
                ? "pip-active"
                : completedSet.has(p)
                  ? "pip-done"
                  : "pip-pending"
            }`}
            title={p}
          />
        ))}
      </div>
    </div>
  );
}
