import type { UpdaterState } from "../useUpdater";

interface UpdateCheckerProps {
  state: UpdaterState;
}

export function UpdateChecker({ state }: UpdateCheckerProps) {
  const { phase, hidden, install, remindLater, dismiss } = state;

  if (hidden) return null;
  if (phase.kind === "idle") return null;

  return (
    <div className="update-banner" role="status" aria-live="polite">
      {phase.kind === "available" && (
        <>
          <div className="update-banner-text">
            <div className="update-banner-title">
              Update available — v{phase.update.version}
            </div>
            <div className="update-banner-subtitle small dim">
              {phase.update.body
                ? phase.update.body.split("\n")[0]
                : "A newer release is ready to install."}
            </div>
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={remindLater}
            >
              Remind me later
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void install()}
            >
              Install &amp; restart
            </button>
          </div>
        </>
      )}

      {phase.kind === "downloading" && (
        <>
          <div className="update-banner-text">
            <div className="update-banner-title">Downloading update…</div>
            <div className="update-banner-subtitle small dim">
              {phase.total
                ? `${formatBytes(phase.progress)} / ${formatBytes(phase.total)}`
                : `${formatBytes(phase.progress)}`}
            </div>
          </div>
          <div
            className="update-banner-progress"
            style={{
              width: phase.total
                ? `${Math.min(100, (phase.progress / phase.total) * 100).toFixed(1)}%`
                : "30%",
            }}
            aria-hidden
          />
        </>
      )}

      {phase.kind === "ready" && (
        <div className="update-banner-text">
          <div className="update-banner-title">Restarting…</div>
        </div>
      )}

      {phase.kind === "error" && (
        <>
          <div className="update-banner-text">
            <div className="update-banner-title">Update failed</div>
            <div
              className="update-banner-subtitle small dim"
              title={phase.message}
            >
              {phase.message}
            </div>
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={dismiss}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
