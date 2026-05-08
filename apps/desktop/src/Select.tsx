import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  ariaLabel?: string;
}

export function Select({
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled,
  className,
  buttonClassName,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    placement: "below" | "above";
    maxHeight: number;
  } | null>(null);

  const current = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );

  const computeRect = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const margin = 8;
    const spaceBelow = viewportH - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const desiredMax = 320;
    let placement: "below" | "above" = "below";
    let maxHeight = Math.min(desiredMax, spaceBelow);
    if (spaceBelow < 160 && spaceAbove > spaceBelow) {
      placement = "above";
      maxHeight = Math.min(desiredMax, spaceAbove);
    }
    maxHeight = Math.max(maxHeight, 120);
    setRect({
      left: r.left,
      top: placement === "below" ? r.bottom + 4 : r.top - 4,
      width: r.width,
      placement,
      maxHeight,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computeRect();
    const handle = () => computeRect();
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [open, computeRect]);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        triggerRef.current?.contains(target) ||
        listRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const buttonLabel = current?.label ?? placeholder;
  const buttonHint = current?.hint;

  return (
    <div className={`select-root ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger ${buttonClassName ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((v) => !v);
        }}
      >
        <span className={`select-trigger-label${current ? "" : " dim"}`}>
          {buttonLabel}
          {buttonHint && <span className="select-trigger-hint dim small"> {buttonHint}</span>}
        </span>
        <span className="select-trigger-caret" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open &&
        rect &&
        createPortal(
          <ul
            ref={listRef}
            className="select-popover"
            role="listbox"
            style={{
              position: "fixed",
              left: rect.left,
              width: rect.width,
              ...(rect.placement === "below"
                ? { top: rect.top, maxHeight: rect.maxHeight }
                : {
                    bottom: window.innerHeight - rect.top,
                    maxHeight: rect.maxHeight,
                  }),
            }}
          >
            {options.length === 0 && (
              <li className="select-empty dim small">No options</li>
            )}
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={selected}
                  className={`select-option${selected ? " is-selected" : ""}${opt.disabled ? " is-disabled" : ""}`}
                  onClick={() => {
                    if (opt.disabled) return;
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <span className="select-option-label">{opt.label}</span>
                  {opt.hint && (
                    <span className="select-option-hint dim small">{opt.hint}</span>
                  )}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
