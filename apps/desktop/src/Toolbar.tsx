import {
  Activity,
  Bone,
  Box,
  Compass,
  Grid3x3,
  type LucideIcon,
  Mountain,
  Play,
  RotateCcw,
  Square,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ViewSettings } from "./Viewport";
import { IconButton, Toggle } from "./ui";

interface ToolbarProps {
  view: ViewSettings;
  onToggle: (key: keyof ViewSettings) => void;
  hasLevel: boolean;
  info?: string;
  modifiedCount: number;
  onResetAllEdits: () => void;
}

interface ToggleSpec {
  key: keyof ViewSettings;
  label: string;
  Icon: LucideIcon;
}

export function Toolbar({
  view,
  onToggle,
  hasLevel,
  info,
  modifiedCount,
  onResetAllEdits,
}: ToolbarProps) {
  const { t } = useTranslation();

  const renderToggles: ToggleSpec[] = [
    { key: "showMobys", label: "Mobys", Icon: Users },
    { key: "showTies", label: "Ties", Icon: Box },
    { key: "showUFrags", label: t("toolbar.terrain"), Icon: Mountain },
  ];

  const viewToggles: ToggleSpec[] = [
    { key: "showGrid", label: t("toolbar.grid"), Icon: Grid3x3 },
    { key: "showAxes", label: t("toolbar.axes"), Icon: Compass },
    { key: "showStats", label: t("toolbar.stats"), Icon: Activity },
    { key: "showUFragBounds", label: t("toolbar.ufragBounds"), Icon: Square },
    { key: "showBones", label: t("toolbar.bones"), Icon: Bone },
    { key: "playAnimation", label: t("toolbar.play"), Icon: Play },
  ];

  return (
    <div className="toolbar">
      <div className="toolbar-group" title={t("toolbar.renderLayers")}>
        {renderToggles.map((tg) => (
          <Toggle
            key={tg.key}
            icon={tg.Icon}
            label={tg.label}
            pressed={view[tg.key]}
            onPressedChange={() => onToggle(tg.key)}
            disabled={!hasLevel}
          />
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group" title={t("toolbar.viewportOverlays")}>
        {viewToggles.map((tg) => (
          <Toggle
            key={tg.key}
            icon={tg.Icon}
            label={tg.label}
            pressed={view[tg.key]}
            onPressedChange={() => onToggle(tg.key)}
          />
        ))}
      </div>

      <div className="toolbar-spacer" />

      {modifiedCount > 0 && (
        <IconButton
          icon={RotateCcw}
          label={t("toolbar.modifiedReset", { count: modifiedCount })}
          variant="warn"
          onClick={onResetAllEdits}
          title={t("toolbar.discardEdits")}
        />
      )}

      {info && <span className="toolbar-info">{info}</span>}
    </div>
  );
}
