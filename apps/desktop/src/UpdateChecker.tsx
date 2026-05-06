import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Non-blocking update banner.
 *
 * Lifecycle:
 *   1. On app boot, calls `check()` once after a short delay (so we
 *      don't fight the splash for the main thread).
 *   2. If a newer release is available, surfaces a small banner
 *      pinned to the bottom-right with the version + size + Install
 *      / Remind me later actions.
 *   3. If the user picks "Remind me later", we record the timestamp
 *      in localStorage and skip checks for `REMIND_INTERVAL_MS`.
 *      After that window the banner can re-appear on the next boot
 *      (or on the next periodic re-check).
 *   4. While dismissed, a small periodic re-check (every
 *      `RECHECK_INTERVAL_MS` while the app stays open) ensures
 *      long-running sessions still see new releases without needing
 *      a restart.
 *
 * Intentional non-modal: the user can keep working with a level
 * while the banner sits in the corner. Updates aren't urgent enough
 * to interrupt asset extraction or scrolling through a hierarchy.
 */
const STORAGE_KEY = "rechimera.update.remindLaterAt";
const REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-poll every 6 hours
const INITIAL_DELAY_MS = 3000; // wait past splash + initial layout paint

type Phase =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; progress: number; total: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function UpdateChecker() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hidden, setHidden] = useState(false);
  // Guard against double-checks if the component re-mounts (StrictMode
  // in dev, hot-reload, etc).
  const inFlightRef = useRef(false);

  const remindLaterStillActive = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const ts = Number(raw);
      if (!Number.isFinite(ts)) return false;
      return Date.now() - ts < REMIND_INTERVAL_MS;
    } catch {
      return false;
    }
  }, []);

  const runCheck = useCallback(async () => {
    if (inFlightRef.current) return;
    if (remindLaterStillActive()) return;
    inFlightRef.current = true;
    try {
      const update = await check();
      if (update) {
        setPhase({ kind: "available", update });
        setHidden(false);
      }
    } catch (e) {
      // Network failure / endpoint unreachable / signature mismatch —
      // these are non-fatal for the app. Log and let the next periodic
      // check try again.
      console.warn("[UpdateChecker] check failed:", e);
    } finally {
      inFlightRef.current = false;
    }
  }, [remindLaterStillActive]);

  // Initial check after the splash settles.
  useEffect(() => {
    const id = setTimeout(() => void runCheck(), INITIAL_DELAY_MS);
    return () => clearTimeout(id);
  }, [runCheck]);

  // Periodic re-check while the app stays open.
  useEffect(() => {
    const id = setInterval(() => void runCheck(), RECHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runCheck]);

  const onRemindLater = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // localStorage might be unavailable in private modes; we still
      // hide the banner for this session via `hidden`.
    }
    setHidden(true);
  }, []);

  const onInstall = useCallback(async () => {
    if (phase.kind !== "available") return;
    const update = phase.update;
    setPhase({ kind: "downloading", progress: 0, total: null });
    try {
      // Tauri's `downloadAndInstall` reports progress events through
      // a callback. We translate them into the local Phase so the
      // banner's progress bar can render.
      let downloaded = 0;
      let totalSize: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalSize = event.data.contentLength ?? null;
          setPhase({
            kind: "downloading",
            progress: 0,
            total: totalSize,
          });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setPhase({
            kind: "downloading",
            progress: downloaded,
            total: totalSize,
          });
        } else if (event.event === "Finished") {
          setPhase({ kind: "ready" });
        }
      });
      // Once the install step finishes, kick a clean relaunch so the
      // user lands in the new build immediately.
      await relaunch();
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [phase]);

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
              onClick={onRemindLater}
            >
              Remind me later
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onInstall()}
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
              onClick={() => setHidden(true)}
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
