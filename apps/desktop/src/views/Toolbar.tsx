import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ViewSettings } from "./Viewport";
import { IconButton } from "../ui";

interface ToolbarProps {
  view: ViewSettings;
  onToggle: (key: keyof ViewSettings) => void;
  hasLevel: boolean;
  info?: string;
  modifiedCount: number;
  onResetAllEdits: () => void;
}

export function Toolbar({
  info,
  modifiedCount,
  onResetAllEdits,
}: ToolbarProps) {
  const { t } = useTranslation();
  if (modifiedCount === 0 && !info) return null;
  return (
    <div className="toolbar toolbar-slim">
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
