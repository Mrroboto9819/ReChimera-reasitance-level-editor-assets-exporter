import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "type" | "checked"> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: ReactNode;
}

/// Labeled checkbox. The `<label>` wrapper makes the entire row a
/// click target, which matches the inline-checkbox UX in the modals
/// (Skeleton toggle, Show bind pose, etc.) without each caller having
/// to re-implement the wrapper.
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(
    {
      checked,
      onCheckedChange,
      label,
      className,
      disabled,
      ...rest
    },
    ref,
  ) {
    return (
      <label
        className={["checkbox", disabled ? "disabled" : "", className]
          .filter(Boolean)
          .join(" ")}
      >
        <input
          ref={ref}
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
          disabled={disabled}
          {...rest}
        />
        {label}
      </label>
    );
  },
);
