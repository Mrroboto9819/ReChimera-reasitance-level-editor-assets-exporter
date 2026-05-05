import type { EditMode } from "./edits";
import type { ViewSettings } from "./Viewport";

interface ToolbarProps {
  view: ViewSettings;
  onToggle: (key: keyof ViewSettings) => void;
  /** Disabled when no level is open. */
  hasLevel: boolean;
  /** Optional info string shown right-aligned (mesh count / triangles / etc.) */
  info?: string;

  /** Current edit gizmo mode (translate / rotate / scale). */
  editMode: EditMode;
  onEditModeChange: (mode: EditMode) => void;
  /** Number of instances with pending in-memory edits. */
  modifiedCount: number;
  /** Reset every pending edit. */
  onResetAllEdits: () => void;
  /** Whether anything is selected — controls whether mode buttons are enabled. */
  hasSelection: boolean;
}

interface ToggleSpec {
  key: keyof ViewSettings;
  label: string;
}

const RENDER_TOGGLES: ToggleSpec[] = [
  { key: "showMobys", label: "Mobys" },
  { key: "showTies", label: "Ties" },
  { key: "showUFrags", label: "Terrain" },
];

const VIEW_TOGGLES: ToggleSpec[] = [
  { key: "showGrid", label: "Grid" },
  { key: "showAxes", label: "Axes" },
  { key: "showStats", label: "Stats" },
  { key: "showUFragBounds", label: "UFrag bounds" },
  { key: "showBones", label: "Bones" },
];

const EDIT_MODES: { mode: EditMode; label: string; icon: string }[] = [
  { mode: "translate", label: "Move", icon: "↔" },
  { mode: "rotate", label: "Rotate", icon: "↺" },
  { mode: "scale", label: "Scale", icon: "⤢" },
];

/**
 * IDE-style toolbar. Sits between the titlebar and the workspace and
 * exposes the most-used view toggles as grouped pill buttons (Unity-style).
 * The lower-priority menus stay in the titlebar's MenuBar.
 */
export function Toolbar({
  view,
  onToggle,
  hasLevel,
  info,
  editMode,
  onEditModeChange,
  modifiedCount,
  onResetAllEdits,
  hasSelection,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-group" title="Edit gizmo mode">
        {EDIT_MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            className={`toolbar-btn ${editMode === m.mode ? "active" : ""}`}
            onClick={() => onEditModeChange(m.mode)}
            disabled={!hasSelection}
            title={m.label}
          >
            <span aria-hidden>{m.icon}</span>
            {m.label}
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group" title="Render layers">
        {RENDER_TOGGLES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`toolbar-btn ${view[t.key] ? "active" : ""}`}
            onClick={() => onToggle(t.key)}
            disabled={!hasLevel}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group" title="Viewport overlays">
        {VIEW_TOGGLES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`toolbar-btn ${view[t.key] ? "active" : ""}`}
            onClick={() => onToggle(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="toolbar-spacer" />

      {modifiedCount > 0 && (
        <button
          type="button"
          className="toolbar-btn toolbar-btn-warn"
          onClick={onResetAllEdits}
          title="Discard all pending edits"
        >
          ● {modifiedCount} modified — Reset all
        </button>
      )}

      {info && <span className="toolbar-info">{info}</span>}
    </div>
  );
}
