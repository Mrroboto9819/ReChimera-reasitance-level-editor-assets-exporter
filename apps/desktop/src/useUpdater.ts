import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const STORAGE_KEY = "rechimera.update.remindLaterAt";
const REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 3000;

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; progress: number; total: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface UpdaterState {
  phase: UpdatePhase;
  hidden: boolean;
  install: () => Promise<void>;
  remindLater: () => void;
  dismiss: () => void;
}

export function useUpdater(): UpdaterState {
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const [hidden, setHidden] = useState(false);
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
      console.warn("[useUpdater] check failed:", e);
    } finally {
      inFlightRef.current = false;
    }
  }, [remindLaterStillActive]);

  useEffect(() => {
    const id = setTimeout(() => void runCheck(), INITIAL_DELAY_MS);
    return () => clearTimeout(id);
  }, [runCheck]);

  useEffect(() => {
    const id = setInterval(() => void runCheck(), RECHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runCheck]);

  const remindLater = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      
    }
    setHidden(true);
  }, []);

  const dismiss = useCallback(() => setHidden(true), []);

  const install = useCallback(async () => {
    setPhase((prev) => {
      if (prev.kind !== "available") return prev;
      void (async () => {
        try {
          let downloaded = 0;
          let totalSize: number | null = null;
          await prev.update.downloadAndInstall((event) => {
            if (event.event === "Started") {
              totalSize = event.data.contentLength ?? null;
              setPhase({ kind: "downloading", progress: 0, total: totalSize });
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
          await relaunch();
        } catch (e) {
          setPhase({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return { kind: "downloading", progress: 0, total: null };
    });
  }, []);

  return { phase, hidden, install, remindLater, dismiss };
}
