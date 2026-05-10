import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "warn";
type Size = "sm" | "md";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  iconPosition?: "left" | "right";
  
  loading?: boolean;
  type?: "button" | "submit" | "reset";
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "btn btn-primary",
  secondary: "btn",
  ghost: "btn btn-ghost",
  warn: "btn btn-warn",
};

const SIZE_CLASS: Record<Size, string> = {
  sm: "btn-sm",
  md: "",
};

const ICON_SIZE: Record<Size, number> = {
  sm: 12,
  md: 14,
};

/// Standard pill-style action button. Wraps the existing `.btn` /
/// `.btn-primary` / `.btn-ghost` CSS classes — no new selectors needed.
/// Loading state shows a Lucide spinner reusing the `.spin` keyframe
/// added with the StatusBar refactor.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon: Icon,
    iconPosition = "left",
    loading,
    type = "button",
    disabled,
    className,
    children,
    ...rest
  },
  ref,
) {
  const cls = [
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const px = ICON_SIZE[size];
  const leftIcon = loading ? (
    <Loader2 size={px} className="spin" />
  ) : Icon && iconPosition === "left" ? (
    <Icon size={px} strokeWidth={2} />
  ) : null;
  const rightIcon =
    !loading && Icon && iconPosition === "right" ? (
      <Icon size={px} strokeWidth={2} />
    ) : null;
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled || loading}
      {...rest}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
