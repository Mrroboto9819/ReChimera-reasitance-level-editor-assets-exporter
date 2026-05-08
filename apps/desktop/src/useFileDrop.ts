import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

type DragDropPhase = "idle" | "over";

interface UseFileDropOptions {
  /** Only fire `onDrop` when at least one dropped path passes this filter.
   *  Receives lowercased paths. Default: accept all. */
  accept?: (lowercasedPath: string) => boolean;
  /** Called once per drop with the matching paths (filtered by `accept`).
   *  Empty array means a drop happened but nothing matched. */
  onDrop: (paths: string[]) => void;
  /** Skip wiring listeners when false — useful so closed modals don't
   *  hijack drops meant for other surfaces. */
  enabled?: boolean;
}

/**
 * Tauri v2 file-drop hook. HTML5 `ondrop` events are intercepted by the
 * native webview and don't deliver disk paths — we need
 * `onDragDropEvent` to get the actual filesystem paths the user dragged
 * in. The hook also tracks whether a drag is currently over the window
 * so callers can flip a "drop here" highlight without writing the
 * subscription themselves.
 */
export function useFileDrop({
  accept,
  onDrop,
  enabled = true,
}: UseFileDropOptions): DragDropPhase {
  const [phase, setPhase] = useState<DragDropPhase>("idle");

  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
          case "over":
            setPhase("over");
            break;
          case "leave":
            setPhase("idle");
            break;
          case "drop": {
            setPhase("idle");
            const paths = event.payload.paths;
            const filtered = accept
              ? paths.filter((p) => accept(p.toLowerCase()))
              : paths;
            onDrop(filtered);
            break;
          }
        }
      })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      setPhase("idle");
    };
  }, [enabled, accept, onDrop]);

  return phase;
}
