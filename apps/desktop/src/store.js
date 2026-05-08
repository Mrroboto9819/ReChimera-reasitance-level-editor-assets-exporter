import { combineReducers, configureStore, createSlice, } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";
import { FLUSH, PAUSE, PERSIST, PURGE, REGISTER, REHYDRATE, persistReducer, persistStore, } from "redux-persist";
import storage from "redux-persist/lib/storage";
const DEFAULT_VIEW = {
    showMobys: true,
    showTies: true,
    showUFrags: true,
    showUFragBounds: false,
    showGrid: true,
    showAxes: true,
    showStats: false,
};
const viewSlice = createSlice({
    name: "view",
    initialState: DEFAULT_VIEW,
    reducers: {
        toggleView(state, action) {
            state[action.payload] = !state[action.payload];
        },
        resetView() {
            return DEFAULT_VIEW;
        },
    },
});
const DEFAULT_LAYOUT = {
    hierarchyPct: 18,
    inspectorPct: 22,
    bottomPct: 24,
    
    
    consoleCollapsed: true,
};
const layoutSlice = createSlice({
    name: "layout",
    initialState: DEFAULT_LAYOUT,
    reducers: {
        setHierarchyPct(state, action) {
            state.hierarchyPct = action.payload;
        },
        setInspectorPct(state, action) {
            state.inspectorPct = action.payload;
        },
        setBottomPct(state, action) {
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
export const { setHierarchyPct, setInspectorPct, setBottomPct, toggleConsoleCollapsed, resetLayout, } = layoutSlice.actions;





const rootReducer = combineReducers({
    view: viewSlice.reducer,
    layout: layoutSlice.reducer,
});
const persistedReducer = persistReducer({
    key: "rechimera-config",
    
    
    version: 2,
    storage,
    whitelist: ["view", "layout"],
}, rootReducer);
export const store = configureStore({
    reducer: persistedReducer,
    middleware: (gdm) => gdm({
        serializableCheck: {
            ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
        },
    }),
});
export const persistor = persistStore(store);
export const useAppDispatch = useDispatch;
export const useAppSelector = useSelector;

export function resetAll(dispatch) {
    dispatch(resetView());
    dispatch(resetLayout());
}
