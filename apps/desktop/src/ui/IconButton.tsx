import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

type Variant = "default" | "warn" | "active";

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  icon: LucideIcon;
  /** Optional inline label rendered next to the icon (toolbar/tabs style). */
  label?: string;
  /** Visual treatment. `active` matches the toolbar's pressed state; `warn`
   *  reuses the yellow accent we use on stale-cache and pending-edits
   *  buttons. */
  variant?: Variant;
  /** Size in px for the SVG. Default 14 — matches Toolbar text height. */
  size?: number;
  type?: "button" | "submit" | "reset";
}

const CLASS_BY_VARIANT: Record<Variant, string> = {
  default: "toolbar-btn",
  active: "toolbar-btn active",
  warn: "toolbar-btn toolbar-btn-warn",
};

/// Icon-led button. Wraps the existing `.toolbar-btn` family, which is
/// the same flexbox pill used by Toolbar, CacheLibraryModal tabs, and
/// the StatusBar's clickable cell. Use this for any button whose
/// primary signal is its icon — labels are optional.
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon: Icon,
      label,
      variant = "default",
      size = 14,
      type = "button",
      className,
      ...rest
    },
    ref,
  ) {
    const cls = [CLASS_BY_VARIANT[variant], className].filter(Boolean).join(" ");
    return (
      <button ref={ref} type={type} className={cls} {...rest}>
        <Icon size={size} strokeWidth={2} />
        {label}
      </button>
    );
  },
);
