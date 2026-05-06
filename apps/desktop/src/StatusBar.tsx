import type { LevelMeshes, LevelSummary } from "./api";
import type { LoadPhaseState } from "./LoadProgress";

interface StatusBarProps {
  summary: LevelSummary | null;
  meshesCount: number;
  instanceCount: number;
  ufragCount: number;
  meshes: LevelMeshes | null;
  loadPhase: LoadPhaseState | null;
  meshLoadPhase?: LoadPhaseState | null;
  error: string | null;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Bottom status bar — like VS Code / Unity's footer. Shows the most-relevant
 * status at-a-glance: connection-style dot for activity, file context, raw
 * counts on the right.
 */
export function StatusBar({
  summary,
  meshesCount,
  instanceCount,
  ufragCount,
  meshes,
  loadPhase,
  meshLoadPhase,
  error,
}: StatusBarProps) {
  const activePhase = loadPhase ?? meshLoadPhase ?? null;
  const dotClass = error
    ? "error"
    : activePhase
      ? "busy"
      : summary
        ? "ok"
        : "";

  const dotLabel = error
    ? "Error"
    : activePhase
      ? activePhase.label
      : summary
        ? "Ready"
        : "Idle";

  return (
    <div className="statusbar">
      <span className="statusbar-cell">
        <span className={`statusbar-dot ${dotClass}`} />
        <span>{dotLabel}</span>
      </span>

      {summary && (
        <>
          <span className="statusbar-divider" />
          <span className="statusbar-cell" title={summary.folder}>
            {folderName(summary.folder)}
          </span>
          <span className="statusbar-divider" />
          <span className="statusbar-cell">
            IGHW v{summary.version_major}.{summary.version_minor}
          </span>
          <span className="statusbar-divider" />
          <span className="statusbar-cell">
            {summary.sections.length} sections
          </span>
        </>
      )}

      <span className="toolbar-spacer" />

      {summary && (
        <>
          <span className="statusbar-cell">
            {instanceCount.toLocaleString()} instances
          </span>
          <span className="statusbar-divider" />
          <span className="statusbar-cell">
            {ufragCount.toLocaleString()} UFrags
          </span>
          {meshes && (
            <>
              <span className="statusbar-divider" />
              <span className="statusbar-cell">
                {meshes.moby_assets.length}M / {meshes.tie_assets.length}T /{" "}
                {meshes.ufrag_meshes.length}U
              </span>
              <span className="statusbar-divider" />
              <span className="statusbar-cell">
                {meshes.textures.length} tex
              </span>
            </>
          )}
        </>
      )}
      {/* meshesCount is referenced for future expansion (per-mesh count). */}
      {meshesCount < 0 && null}
    </div>
  );
}
