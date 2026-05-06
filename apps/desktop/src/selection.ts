import { useCallback, useMemo, useState } from "react";
import type { Instance } from "./api";

export interface SelectionState {
  /** Set of selected instance TUIDs (the unique placement key). */
  ids: Set<string>;
  /** The "primary" selection — last clicked. Drives the inspector and the
   *  anchor for shift-range selection. */
  primary: string | null;
  /** Anchor for the next shift-range selection (also the primary after
   *  click — separate field so deselect doesn't lose the anchor). */
  anchor: string | null;
}

const EMPTY: SelectionState = {
  ids: new Set(),
  primary: null,
  anchor: null,
};

export type ClickMods = {
  ctrl?: boolean;
  shift?: boolean;
  /** Force-additive behavior — always adds the target to the selection,
   *  never toggles off. The viewport's double-click sets this so picking
   *  several meshes in a row accumulates them (Unity-style multi-pick)
   *  without forcing the user to hold a modifier. Modifier-held clicks
   *  go through the regular ctrl/shift paths and ignore this flag. */
  forceAdd?: boolean;
};

/** Normalize cross-platform mod-keys: on macOS metaKey (⌘) acts as ctrl. */
export function clickMods(e: React.MouseEvent | MouseEvent): ClickMods {
  return {
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
  };
}

export function useSelection(orderedItems: () => Instance[]) {
  const [state, setState] = useState<SelectionState>(EMPTY);

  const items = orderedItems;

  const select = useCallback(
    (target: Instance | null, mods: ClickMods = {}) => {
      setState((prev) => {
        if (!target) {
          // Click in empty space — clear selection but PRESERVE the anchor
          // so a subsequent shift-click still has a starting point. This
          // matches Windows Explorer / VS Code behavior.
          if (mods.ctrl || mods.shift) return prev;
          return { ids: new Set(), primary: null, anchor: prev.anchor };
        }
        const id = target.tuid;

        // Shift+click: range from anchor to target (within current ordering).
        if (mods.shift && prev.anchor) {
          const list = items();
          const anchorIdx = list.findIndex((i) => i.tuid === prev.anchor);
          const targetIdx = list.findIndex((i) => i.tuid === id);
          if (anchorIdx >= 0 && targetIdx >= 0) {
            const [from, to] =
              anchorIdx < targetIdx
                ? [anchorIdx, targetIdx]
                : [targetIdx, anchorIdx];
            const next = new Set(prev.ids);
            for (let i = from; i <= to; i++) {
              const item = list[i];
              if (item) next.add(item.tuid);
            }
            return { ids: next, primary: id, anchor: prev.anchor };
          }
        }

        // forceAdd: always accumulate. No toggle, no replace. Used by
        // the viewport so plain picks build up a multi-selection without
        // requiring the user to hold ctrl. Setting this also makes the
        // newly-clicked instance the new primary + anchor.
        if (mods.forceAdd) {
          const next = new Set(prev.ids);
          next.add(id);
          return { ids: next, primary: id, anchor: id };
        }

        // Ctrl/Cmd+click: toggle this id, keep others.
        if (mods.ctrl) {
          const next = new Set(prev.ids);
          if (next.has(id)) {
            next.delete(id);
            return {
              ids: next,
              primary: next.size > 0 ? Array.from(next).pop()! : null,
              anchor: id,
            };
          }
          next.add(id);
          return { ids: next, primary: id, anchor: id };
        }

        // Plain click — single select.
        return {
          ids: new Set([id]),
          primary: id,
          anchor: id,
        };
      });
    },
    [items],
  );

  const clear = useCallback(() => setState(EMPTY), []);

  return useMemo(
    () => ({
      ids: state.ids,
      primary: state.primary,
      anchor: state.anchor,
      count: state.ids.size,
      isSelected: (id: string) => state.ids.has(id),
      select,
      clear,
    }),
    [state, select, clear],
  );
}
