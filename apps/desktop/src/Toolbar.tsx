import {
  Activity,
  Bone,
  Box,
  Compass,
  Grid3x3,
  type LucideIcon,
  Move,
  Mountain,
  Play,
  RotateCcw,
  RotateCw,
  Scaling,
  Square,
  Users,
} from "lucide-react";
import type { EditMode } from "./edits";
import type { ViewSettings } from "./Viewport";
import { IconButton, Toggle } from "./ui";

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
  Icon: LucideIcon;
}

const RENDER_TOGGLES: ToggleSpec[] = [
  { key: "showMobys", label: "Mobys", Icon: Users },
  { key: "showTies", label: "Ties", Icon: Box },
  { key: "showUFrags", label: "Terrain", Icon: Mountain },
];

const VIEW_TOGGLES: ToggleSpec[] = [
  { key: "showGrid", label: "Grid", Icon: Grid3x3 },
  { key: "showAxes", label: "Axes", Icon: Compass },
  { key: "showStats", label: "Stats", Icon: Activity },
  { key: "showUFragBounds", label: "UFrag bounds", Icon: Square },
  { key: "showBones", label: "Bones", Icon: Bone },
  { key: "playAnimation", label: "Play", Icon: Play },
];

const EDIT_MODES: { mode: EditMode; label: string; Icon: LucideIcon }[] = [
  { mode: "translate", label: "Move", Icon: Move },
  { mode: "rotate", label: "Rotate", Icon: RotateCw },
  { mode: "scale", label: "Scale", Icon: Scaling },
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
          <IconButton
            key={m.mode}
            icon={m.Icon}
            label={m.label}
            variant={editMode === m.mode ? "active" : "default"}
            onClick={() => onEditModeChange(m.mode)}
            disabled={!hasSelection}
            title={m.label}
          />
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group" title="Render layers">
        {RENDER_TOGGLES.map((t) => (
          <Toggle
            key={t.key}
            icon={t.Icon}
            label={t.label}
            pressed={view[t.key]}
            onPressedChange={() => onToggle(t.key)}
            disabled={!hasLevel}
          />
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group" title="Viewport overlays">
        {VIEW_TOGGLES.map((t) => (
          <Toggle
            key={t.key}
            icon={t.Icon}
            label={t.label}
            pressed={view[t.key]}
            onPressedChange={() => onToggle(t.key)}
          />
        ))}
      </div>

      <div className="toolbar-spacer" />

      {modifiedCount > 0 && (
        <IconButton
          icon={RotateCcw}
          label={`${modifiedCount} modified — Reset all`}
          variant="warn"
          onClick={onResetAllEdits}
          title="Discard all pending edits"
        />
      )}

      {info && <span className="toolbar-info">{info}</span>}
    </div>
  );
}
