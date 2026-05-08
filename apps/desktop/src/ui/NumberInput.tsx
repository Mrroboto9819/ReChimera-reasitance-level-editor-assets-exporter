import { forwardRef, type InputHTMLAttributes } from "react";

interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: number;
  onValueChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Decimal places to render. Doesn't constrain input — the user can
   *  still type more precision; the rendered display rounds. */
  precision?: number;
}

/// Number input with float-safe value handling. Inspector uses these
/// for transform XYZ values; without onValueChange wrapper, every
/// caller would re-implement the parseFloat dance.
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      value,
      onValueChange,
      step,
      min,
      max,
      precision,
      className,
      ...rest
    },
    ref,
  ) {
    const display =
      precision != null && Number.isFinite(value)
        ? +value.toFixed(precision)
        : value;
    return (
      <input
        ref={ref}
        type="number"
        className={["number-input", className].filter(Boolean).join(" ")}
        value={display}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (Number.isFinite(next)) onValueChange(next);
        }}
        {...rest}
      />
    );
  },
);
