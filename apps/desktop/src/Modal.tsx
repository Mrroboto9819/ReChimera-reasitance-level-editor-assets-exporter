import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";

interface ModalProps {
  /** Controls visibility — render the <Modal> always; toggle this prop. */
  open: boolean;
  /** Called when the user requests close (Escape, backdrop click, or × button). */
  onClose?: () => void;
  /**
   * If false, Escape and backdrop click do nothing (× button is also hidden).
   * Use for blocking states like "loading" where the user shouldn't be able
   * to close mid-operation.
   */
  dismissable?: boolean;
  /** Optional title rendered in the header. */
  title?: ReactNode;
  /** Optional sub-title / hint shown under the title. */
  subtitle?: ReactNode;
  /** Footer slot (action buttons, status text). */
  footer?: ReactNode;
  /** Tailwind-ish width preset; defaults to "md". */
  size?: "sm" | "md" | "lg" | "xl";
  /** Extra class on the body wrapper. Use `modal-body-flex` for modals
   *  whose contents already manage their own scrolling region (e.g. the
   *  character-preview modal where the canvas must fill the height and
   *  the sidebar owns its own scrollbar). Default modal-body has its
   *  own vertical scroll for short text dialogs — that fights inner
   *  scrollers, hence the override. */
  bodyClassName?: string;
  children: ReactNode;
}

const SIZE_WIDTH: Record<NonNullable<ModalProps["size"]>, number> = {
  sm: 360,
  md: 480,
  lg: 640,
  // Wide preset for the GLTF preview modal — the 3D canvas needs room
  // to breathe alongside the inspector sidebar (animations + stats).
  xl: 1100,
};

/**
 * Reusable modal with GSAP-driven enter/exit. Designed to layer on top of
 * any view — uses a portal mounted on `document.body` so z-index never
 * fights with the rest of the app.
 *
 * The component keeps its DOM mounted across `open` toggles so GSAP can run
 * the exit timeline; once the exit completes, it sets `display: none` to
 * keep the document tree small.
 */
export function Modal({
  open,
  onClose,
  dismissable = true,
  title,
  subtitle,
  footer,
  size = "md",
  bodyClassName,
  children,
}: ModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Tracks the currently-running tween so we can interrupt cleanly when the
  // user toggles `open` faster than the animation can settle.
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  // Drive enter/exit with GSAP. useLayoutEffect ensures the timeline starts
  // from the correct initial state before the browser paints.
  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    tlRef.current?.kill();

    if (open) {
      backdrop.style.display = "flex";
      const tl = gsap.timeline();
      tl.fromTo(
        backdrop,
        { autoAlpha: 0, backdropFilter: "blur(0px)" },
        { autoAlpha: 1, backdropFilter: "blur(8px)", duration: 0.18, ease: "power2.out" },
      ).fromTo(
        dialog,
        { autoAlpha: 0, y: 12, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power3.out" },
        "-=0.10",
      );
      tlRef.current = tl;
    } else {
      const tl = gsap.timeline({
        onComplete: () => {
          if (backdropRef.current) backdropRef.current.style.display = "none";
        },
      });
      tl.to(dialog, {
        autoAlpha: 0,
        y: 6,
        scale: 0.98,
        duration: 0.14,
        ease: "power2.in",
      }).to(
        backdrop,
        {
          autoAlpha: 0,
          backdropFilter: "blur(0px)",
          duration: 0.16,
          ease: "power2.in",
        },
        "-=0.06",
      );
      tlRef.current = tl;
    }
  }, [open]);

  // Escape closes when dismissable.
  useEffect(() => {
    if (!open || !dismissable) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, dismissable, onClose]);

  // Lock body scroll while the modal is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const onBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!dismissable) return;
      if (e.target === e.currentTarget) onClose?.();
    },
    [dismissable, onClose],
  );

  const node = (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      onClick={onBackdropClick}
      style={{ display: "none" }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "modal-title" : undefined}
        style={{ width: SIZE_WIDTH[size] }}
      >
        {(title || dismissable) && (
          <header className="modal-header">
            <div className="modal-header-text">
              {title && (
                <h2 id="modal-title" className="modal-title">
                  {title}
                </h2>
              )}
              {subtitle && <p className="modal-subtitle">{subtitle}</p>}
            </div>
            {dismissable && (
              <button
                type="button"
                className="modal-close"
                onClick={() => onClose?.()}
                aria-label="Close"
              >
                ×
              </button>
            )}
          </header>
        )}
        <div className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>
          {children}
        </div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
