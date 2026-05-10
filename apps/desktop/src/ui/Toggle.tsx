import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

interface ToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onChange"> {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
  icon?: LucideIcon;
  label: string;
  size?: number;
}




export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  {
    pressed,
    onPressedChange,
    icon: Icon,
    label,
    size = 14,
    className,
    onClick,
    ...rest
  },
  ref,
) {
  const cls = [
    "toolbar-btn",
    pressed ? "active" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      type="button"
      className={cls}
      aria-pressed={pressed}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onPressedChange(!pressed);
      }}
      {...rest}
    >
      {Icon && <Icon size={size} strokeWidth={2} />}
      {label}
    </button>
  );
});
