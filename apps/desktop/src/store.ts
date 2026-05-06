import {
  combineReducers,
  configureStore,
  createSlice,
  type PayloadAction,
} from "@reduxjs/toolkit";
import { useDispatch, useSelector, type TypedUseSelectorHook } from "react-redux";
import {
  FLUSH,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  REHYDRATE,
  persistReducer,
  persistStore,
} from "redux-persist";
import storage from "redux-persist/lib/storage";

/* ────────────────────────────────────────────────────────────────────────
 * View settings — what to render in the viewport. Persisted so a user's
 * "I always want grid off" preference survives reloads.
 * ──────────────────────────────────────────────────────────────────────── */

export interface ViewSettingsState {
  showMobys: boolean;
  showTies: boolean;
  showUFrags: boolean;
  showUFragBounds: boolean;
  showGrid: boolean;
  showAxes: boolean;
  /** When true, the viewport FPS overlay shows a graph instead of a counter. */
  showStats: boolean;
  /** Draw bone hierarchies as cyan line segments for selected mobys whose
   *  IGHW chunk includes section 0xD300. Useful for verifying skeleton
   *  parse before skin weights / animation playback land. */
  showBones: boolean;
  /** Drive the selected character's SkinnedMesh via AnimationMixer using
   *  its animset clip. Off → bind pose. */
  playAnimation: boolean;
}

const DEFAULT_VIEW: ViewSettingsState = {
  showMobys: true,
  showTies: true,
  showUFrags: true,
  showUFragBounds: false,
  showGrid: true,
  showAxes: true,
  showStats: false,
  showBones: false,
  playAnimation: true,
};

const viewSlice = createSlice({
  name: "view",
  initialState: DEFAULT_VIEW,
  reducers: {
    toggleView(state, action: PayloadAction<keyof ViewSettingsState>) {
      state[action.payload] = !state[action.payload];
    },
    resetView() {
      return DEFAULT_VIEW;
    },
  },
});

/* ────────────────────────────────────────────────────────────────────────
 * Layout — panel sizes (as percentages 0–100) and collapsed states.
 * Mirrors the structure of <PanelGroup> usage so each id maps to one
 * splitter position.
 * ──────────────────────────────────────────────────────────────────────── */

export interface LayoutState {
  /** Horizontal split: hierarchy / center / inspector */
  hierarchyPct: number;
  inspectorPct: number;
  /** Vertical split inside center: viewport / bottom panel */
  bottomPct: number;
  consoleCollapsed: boolean;
}

const DEFAULT_LAYOUT: LayoutState = {
  hierarchyPct: 18,
  inspectorPct: 22,
  bottomPct: 24,
  // Start folded — the bottom panel only has useful content when there's a
  // log/asset/tools state worth seeing. The user expands it explicitly.
  consoleCollapsed: true,
};

const layoutSlice = createSlice({
  name: "layout",
  initialState: DEFAULT_LAYOUT,
  reducers: {
    setHierarchyPct(state, action: PayloadAction<number>) {
      state.hierarchyPct = action.payload;
    },
    setInspectorPct(state, action: PayloadAction<number>) {
      state.inspectorPct = action.payload;
    },
    setBottomPct(state, action: PayloadAction<number>) {
      state.bottomPct = action.payload;
    },
    toggleConsoleCollapsed(state) {
      state.consoleCollapsed = !state.consoleCollapsed;
    },
    resetLayout() {
      return DEFAULT_LAYOUT;
    },
  },
});

export const { toggleView, resetView } = viewSlice.actions;
export const {
  setHierarchyPct,
  setInspectorPct,
  setBottomPct,
  toggleConsoleCollapsed,
  resetLayout,
} = layoutSlice.actions;

/* ────────────────────────────────────────────────────────────────────────
 * Persistence — stash everything in localStorage. The whitelist keeps us
 * from accidentally persisting transient state if we add slices later.
 * Bumping `version` invalidates old saved state when the schema changes.
 * ──────────────────────────────────────────────────────────────────────── */

const rootReducer = combineReducers({
  view: viewSlice.reducer,
  layout: layoutSlice.reducer,
});

const persistedReducer = persistReducer(
  {
    key: "rechimera-config",
    // v2: changed `consoleCollapsed` default to true so the bottom panel
    // starts folded. Bumping the version invalidates v1 saves.
    version: 2,
    storage,
    whitelist: ["view", "layout"],
  },
  rootReducer,
);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (gdm) =>
    gdm({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

/** Reset everything to defaults — bound to a "Reset Layout" menu item. */
export function resetAll(dispatch: AppDispatch) {
  dispatch(resetView());
  dispatch(resetLayout());
}
