import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

type Variant = "default" | "warn" | "active";

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  icon: LucideIcon;
  
  label?: string;
  


  variant?: Variant;
  
  size?: number;
  type?: "button" | "submit" | "reset";
}

const CLASS_BY_VARIANT: Record<Variant, string> = {
  default: "toolbar-btn",
  active: "toolbar-btn active",
  warn: "toolbar-btn toolbar-btn-warn",
};





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
