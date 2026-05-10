import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";

type Os = "macos" | "windows" | "linux" | "other";

function classifyPlatform(p: string): Os {
  if (p === "macos") return "macos";
  if (p === "windows") return "windows";
  if (p === "linux") return "linux";
  return "other";
}














export function TitleBar({ children }: { children: ReactNode }) {
  const [os, setOs] = useState<Os>("other");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = platform();
        if (!cancelled) setOs(classifyPlatform(p));
      } catch {
        
        
        if (!cancelled) {
          const ua = navigator.userAgent.toLowerCase();
          setOs(ua.includes("mac") ? "macos" : "windows");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  
  
  useEffect(() => {
    if (os !== "windows" && os !== "linux" && os !== "other") return;
    const win = getCurrentWindow();
    const update = async () => {
      try {
        setMaximized(await win.isMaximized());
      } catch {
        
      }
    };
    update();
    const unlisten = win.onResized(update);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [os]);

  const win = getCurrentWindow();

  
  
  
  
  
  
  
  const isInteractive = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return !!target.closest(
      'button, input, a, select, textarea, [data-tauri-drag-region="false"]',
    );
  };

  const onTitleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (isInteractive(e.target)) return;
    if (e.detail === 2) {
      win.toggleMaximize().catch((err) => console.warn("toggleMaximize:", err));
      return;
    }
    win
      .startDragging()
      .catch((err) =>
        console.warn(
          "startDragging failed — check core:window:allow-start-dragging capability + restart `tauri dev`:",
          err,
        ),
      );
  };

  const onTitlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.pointerType !== "mouse") return;
    if (isInteractive(e.target)) return;
    
    if (e.detail === 2) return;
    win.startDragging().catch(() => {
      
    });
  };

  return (
    <div
      className={`titlebar titlebar-${os}`}
      data-tauri-drag-region=""
      onMouseDown={onTitleMouseDown}
      onPointerDown={onTitlePointerDown}
    >
      {os === "macos" && (
        <div className="titlebar-traffic" data-tauri-drag-region="false">
          <button
            type="button"
            className="traffic-btn traffic-close"
            aria-label="Close"
            onClick={() => win.close()}
          >
            <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden>
              <path
                d="M1 1 L5 5 M5 1 L1 5"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="traffic-btn traffic-min"
            aria-label="Minimize"
            onClick={() => win.minimize()}
          >
            <svg width="6" height="2" viewBox="0 0 6 2" aria-hidden>
              <rect width="6" height="1" y="0.5" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="traffic-btn traffic-max"
            aria-label="Maximize"
            onClick={() => win.toggleMaximize()}
          >
            <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden>
              <path
                d="M1 3 L3 1 M3 5 L5 3"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}

      <div className="titlebar-content" data-tauri-drag-region="">
        {children}
      </div>

      {os !== "macos" && (
        <div className="titlebar-caption" data-tauri-drag-region="false">
          <button
            type="button"
            className="caption-btn caption-min"
            aria-label="Minimize"
            onClick={() => win.minimize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <rect x="1" y="5" width="8" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="caption-btn caption-max"
            aria-label={maximized ? "Restore" : "Maximize"}
            onClick={() => win.toggleMaximize()}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect
                  x="2"
                  y="0.5"
                  width="7"
                  height="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
                <rect
                  x="0.5"
                  y="2.5"
                  width="7"
                  height="7"
                  fill="var(--surface-100)"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect
                  x="0.5"
                  y="0.5"
                  width="9"
                  height="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="caption-btn caption-close"
            aria-label="Close"
            onClick={() => win.close()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path
                d="M1 1 L9 9 M9 1 L1 9"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
