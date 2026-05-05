import type { PhaseId } from "./api";

export interface LoadPhaseState {
  phase: PhaseId;
  label: string;
  current: number;
  total: number;
  /** Items per chunk — backend pauses between chunks to keep the JS
   *  thread responsive on big levels. We display "Chunk X/Y" so the user
   *  can see they're not stuck. */
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

  // Derive chunk index/total from the running counter so the UI shows
  // "Chunk 3/8 · 96/256". Cap at 1 if total is 0 to avoid divide-by-zero
  // on the trivially-fast phases (layout / shaders).
  const chunkSize = Math.max(1, active.chunkSize);
  const chunkTotal = Math.max(1, Math.ceil(active.total / chunkSize));
  const chunkCurrent = Math.min(
    chunkTotal,
    Math.max(1, Math.ceil(active.current / chunkSize) || 1),
  );
  const showChunks = active.total > chunkSize;

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
      {showChunks && (
        <div className="load-progress-chunks mono small">
          Chunk {chunkCurrent} / {chunkTotal}{" "}
          <span className="dim">· {chunkSize} per chunk</span>
        </div>
      )}
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
