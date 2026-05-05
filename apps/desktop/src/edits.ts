import { useCallback, useMemo, useState } from "react";
import type { Instance } from "./api";

/**
 * Per-instance transform override. When present in the edits map, the
 * viewport + inspector use these values instead of the original ones from
 * `level_layout`. Saving back to disk (Phase B) will diff this map against
 * the originals and write the delta to gp_prius.dat / zone files.
 */
export interface InstanceEdit {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export type EditMode = "translate" | "rotate" | "scale";

/**
 * Central edits store. Held in App-level state so the Viewport (gizmo +
 * mesh placement) and Inspector (editable fields + Modified badge) see the
 * same data. Reseting on level close is the parent's responsibility.
 */
export function useEdits() {
  const [edits, setEdits] = useState<Map<string, InstanceEdit>>(new Map());
  const [mode, setMode] = useState<EditMode>("translate");

  const setEdit = useCallback(
    (tuid: string, patch: Partial<InstanceEdit>, baseline: Instance) => {
      setEdits((prev) => {
        const next = new Map(prev);
        const existing = next.get(tuid) ?? {
          position: baseline.position,
          quaternion: baseline.quaternion,
          scale: baseline.scale,
        };
        next.set(tuid, { ...existing, ...patch });
        return next;
      });
    },
    [],
  );

  const resetEdit = useCallback((tuid: string) => {
    setEdits((prev) => {
      if (!prev.has(tuid)) return prev;
      const next = new Map(prev);
      next.delete(tuid);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => setEdits(new Map()), []);

  const isModified = useCallback(
    (tuid: string) => edits.has(tuid),
    [edits],
  );

  return useMemo(
    () => ({
      edits,
      mode,
      setMode,
      setEdit,
      resetEdit,
      resetAll,
      isModified,
      count: edits.size,
    }),
    [edits, mode, setEdit, resetEdit, resetAll, isModified],
  );
}

/**
 * Resolve the effective transform for an instance — edit if present, else
 * the original. Cheap pure function so the viewport can call it inside
 * its render loop.
 */
export function resolvedTransform(
  inst: Instance,
  edits: Map<string, InstanceEdit>,
): InstanceEdit {
  const e = edits.get(inst.tuid);
  if (e) return e;
  return {
    position: inst.position,
    quaternion: inst.quaternion,
    scale: inst.scale,
  };
}

/**
 * Convenience: produce a new Instance object with the edit applied. Used
 * by the Inspector so `selected.position` reflects the live values.
 */
export function applyEdit(
  inst: Instance,
  edits: Map<string, InstanceEdit>,
): Instance {
  const e = edits.get(inst.tuid);
  if (!e) return inst;
  return { ...inst, ...e };
}
