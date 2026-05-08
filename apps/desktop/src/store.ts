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
  hierarchyPct: number;
  inspectorPct: number;
  bottomPct: number;
  consoleCollapsed: boolean;
  hierarchyHidden: boolean;
  inspectorHidden: boolean;
}

const DEFAULT_LAYOUT: LayoutState = {
  hierarchyPct: 18,
  inspectorPct: 22,
  bottomPct: 24,
  consoleCollapsed: true,
  hierarchyHidden: false,
  inspectorHidden: false,
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
    toggleHierarchyHidden(state) {
      state.hierarchyHidden = !state.hierarchyHidden;
    },
    toggleInspectorHidden(state) {
      state.inspectorHidden = !state.inspectorHidden;
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
  toggleHierarchyHidden,
  toggleInspectorHidden,
  resetLayout,
} = layoutSlice.actions;

/* ────────────────────────────────────────────────────────────────────────
 * Settings — appearance preferences. Theme + brand color flow into CSS
 * custom properties; per-kind asset colors flow into Three.js material
 * tints (proxy boxes, placeholders, selection outline). Persisted so the
 * user's chosen palette survives reloads.
 * ──────────────────────────────────────────────────────────────────────── */

export type ThemeMode = "dark" | "light";

export type Language = "en" | "es" | "fr" | "zh" | "ru";

export interface AssetColors {
  /** Moby proxy boxes + placeholder material tint (orange by default). */
  moby: string;
  /** Tie proxy boxes + placeholder material tint (cyan by default). */
  tie: string;
  /** UFrag (terrain) placeholder when textures haven't arrived. */
  ufrag: string;
  /** Selection outline / highlight color. */
  selection: string;
  /** Untextured proxy boxes — gray by default; drawn while real meshes
   *  are still streaming in. */
  proxy: string;
}

export interface SettingsState {
  theme: ThemeMode;
  brandColor: string;
  assetColors: AssetColors;
  language: Language;
}

const DEFAULT_SETTINGS: SettingsState = {
  theme: "dark",
  brandColor: "#FF6363",
  assetColors: {
    moby: "#ff8a3d",
    tie: "#3dd0ff",
    ufrag: "#97de82",
    selection: "#3eb1ff",
    proxy: "#8a8a8a",
  },
  language: "en",
};

const settingsSlice = createSlice({
  name: "settings",
  initialState: DEFAULT_SETTINGS,
  reducers: {
    setTheme(state, action: PayloadAction<ThemeMode>) {
      state.theme = action.payload;
    },
    toggleTheme(state) {
      state.theme = state.theme === "dark" ? "light" : "dark";
    },
    setBrandColor(state, action: PayloadAction<string>) {
      state.brandColor = action.payload;
    },
    setAssetColor(
      state,
      action: PayloadAction<{ key: keyof AssetColors; value: string }>,
    ) {
      state.assetColors[action.payload.key] = action.payload.value;
    },
    setLanguage(state, action: PayloadAction<Language>) {
      state.language = action.payload;
    },
    resetSettings() {
      return DEFAULT_SETTINGS;
    },
  },
});

export const {
  setTheme,
  toggleTheme,
  setBrandColor,
  setAssetColor,
  setLanguage,
  resetSettings,
} = settingsSlice.actions;

/* ────────────────────────────────────────────────────────────────────────
 * Persistence — stash everything in localStorage. The whitelist keeps us
 * from accidentally persisting transient state if we add slices later.
 * Bumping `version` invalidates old saved state when the schema changes.
 * ──────────────────────────────────────────────────────────────────────── */

const rootReducer = combineReducers({
  view: viewSlice.reducer,
  layout: layoutSlice.reducer,
  settings: settingsSlice.reducer,
});

const persistedReducer = persistReducer(
  {
    key: "rechimera-config",
    version: 4,
    storage,
    whitelist: ["view", "layout", "settings"],
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
  dispatch(resetSettings());
}
