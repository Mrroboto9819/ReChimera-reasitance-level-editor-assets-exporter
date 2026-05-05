import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface MenuContextValue {
  openId: string | null;
  setOpenId: (id: string | null) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

interface MenuBarProps {
  children: ReactNode;
}

export function MenuBar({ children }: MenuBarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openId) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpenId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  const value = useMemo(() => ({ openId, setOpenId }), [openId]);

  return (
    <MenuContext.Provider value={value}>
      <div ref={ref} className="menubar">
        {children}
      </div>
    </MenuContext.Provider>
  );
}

interface MenuProps {
  label: string;
  children: ReactNode;
}

export function Menu({ label, children }: MenuProps) {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error("Menu must be used inside <MenuBar>");
  const open = ctx.openId === label;

  const onTriggerClick = useCallback(() => {
    ctx.setOpenId(open ? null : label);
  }, [ctx, label, open]);

  const onTriggerHover = useCallback(() => {
    if (ctx.openId !== null && ctx.openId !== label) ctx.setOpenId(label);
  }, [ctx, label]);

  return (
    <div className="menu">
      <button
        type="button"
        className={`menu-trigger ${open ? "open" : ""}`}
        onClick={onTriggerClick}
        onMouseEnter={onTriggerHover}
        data-tauri-drag-region="false"
      >
        {label}
      </button>
      {open && (
        <div
          className="menu-popover"
          onClick={() => ctx.setOpenId(null)}
          data-tauri-drag-region="false"
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface MenuItemProps {
  onSelect?: () => void;
  disabled?: boolean;
  shortcut?: string;
  children: ReactNode;
}

export function MenuItem({ onSelect, disabled, shortcut, children }: MenuItemProps) {
  return (
    <button
      type="button"
      className="menu-item"
      onClick={onSelect}
      disabled={disabled}
    >
      <span>{children}</span>
      {shortcut && <span className="kbd">{shortcut}</span>}
    </button>
  );
}

interface MenuCheckItemProps {
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
}

export function MenuCheckItem({
  checked,
  onToggle,
  disabled,
  children,
}: MenuCheckItemProps) {
  return (
    <button
      type="button"
      className="menu-item"
      onClick={onToggle}
      disabled={disabled}
    >
      <span>{children}</span>
      <span className="menu-item-check">{checked ? "✓" : ""}</span>
    </button>
  );
}

export function MenuSpacer() {
  return <div className="menubar-spacer" />;
}
