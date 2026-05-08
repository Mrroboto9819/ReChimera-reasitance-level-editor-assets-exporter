import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: string;
  onValueChange: (next: string) => void;
  /** Optional leading icon (LucideIcon component or any ReactNode). */
  leading?: ReactNode;
  /** Optional trailing slot — useful for clear buttons or counters. */
  trailing?: ReactNode;
  /** "text" by default; "search" gets the browser's clear-X on some
   *  platforms but otherwise renders identically. */
  type?: "text" | "search" | "url" | "email";
}

/// Text input with optional leading icon + trailing slot. Adapts the
/// `.cache-library-search` layout (icon + input + counter) into a
/// single reusable element. For modals that want the bigger "field"
/// look (label above + bordered input) — that's a separate concern;
/// this component is the inline-input variant.
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    {
      value,
      onValueChange,
      leading,
      trailing,
      type = "text",
      className,
      placeholder,
      ...rest
    },
    ref,
  ) {
    const cls = ["text-input", className].filter(Boolean).join(" ");
    return (
      <div className={cls}>
        {leading}
        <input
          ref={ref}
          type={type}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          {...rest}
        />
        {trailing}
      </div>
    );
  },
);
