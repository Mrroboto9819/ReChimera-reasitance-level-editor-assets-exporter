import { useCallback, useMemo, useRef, useState } from "react";
import type { Instance } from "./api";

export interface SelectionState {
  
  ids: Set<string>;
  

  primary: string | null;
  

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
  




  forceAdd?: boolean;
};


export function clickMods(e: React.MouseEvent | MouseEvent): ClickMods {
  return {
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
  };
}

export function useSelection(orderedItems: () => Instance[]) {
  const [state, setState] = useState<SelectionState>(EMPTY);

  
  
  
  
  
  
  const itemsRef = useRef(orderedItems);
  itemsRef.current = orderedItems;

  const select = useCallback(
    (target: Instance | null, mods: ClickMods = {}) => {
      setState((prev) => {
        if (!target) {
          
          
          
          if (mods.ctrl || mods.shift) return prev;
          return { ids: new Set(), primary: null, anchor: prev.anchor };
        }
        const id = target.tuid;

        
        if (mods.shift && prev.anchor) {
          const list = itemsRef.current();
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

        
        
        
        
        if (mods.forceAdd) {
          const next = new Set(prev.ids);
          next.add(id);
          return { ids: next, primary: id, anchor: id };
        }

        
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

        
        return {
          ids: new Set([id]),
          primary: id,
          anchor: id,
        };
      });
    },
    [],
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
