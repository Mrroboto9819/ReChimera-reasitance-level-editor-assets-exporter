import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

type DragDropPhase = "idle" | "over";

interface UseFileDropOptions {
  

  accept?: (lowercasedPath: string) => boolean;
  

  onDrop: (paths: string[]) => void;
  

  enabled?: boolean;
}









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
