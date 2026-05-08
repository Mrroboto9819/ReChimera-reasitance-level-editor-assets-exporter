import { useCallback, useMemo, useState } from "react";
const EMPTY = {
    ids: new Set(),
    primary: null,
    anchor: null,
};

export function clickMods(e) {
    return {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
    };
}
export function useSelection(orderedItems) {
    const [state, setState] = useState(EMPTY);
    const items = orderedItems;
    const select = useCallback((target, mods = {}) => {
        setState((prev) => {
            if (!target) {
                
                
                
                if (mods.ctrl || mods.shift)
                    return prev;
                return { ids: new Set(), primary: null, anchor: prev.anchor };
            }
            const id = target.tuid;
            
            if (mods.shift && prev.anchor) {
                const list = items();
                const anchorIdx = list.findIndex((i) => i.tuid === prev.anchor);
                const targetIdx = list.findIndex((i) => i.tuid === id);
                if (anchorIdx >= 0 && targetIdx >= 0) {
                    const [from, to] = anchorIdx < targetIdx
                        ? [anchorIdx, targetIdx]
                        : [targetIdx, anchorIdx];
                    const next = new Set(prev.ids);
                    for (let i = from; i <= to; i++) {
                        const item = list[i];
                        if (item)
                            next.add(item.tuid);
                    }
                    return { ids: next, primary: id, anchor: prev.anchor };
                }
            }
            
            if (mods.ctrl) {
                const next = new Set(prev.ids);
                if (next.has(id)) {
                    next.delete(id);
                    return {
                        ids: next,
                        primary: next.size > 0 ? Array.from(next).pop() : null,
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
    }, [items]);
    const clear = useCallback(() => setState(EMPTY), []);
    return useMemo(() => ({
        ids: state.ids,
        primary: state.primary,
        anchor: state.anchor,
        count: state.ids.size,
        isSelected: (id) => state.ids.has(id),
        select,
        clear,
    }), [state, select, clear]);
}
