import { useEffect, useRef } from "react";
import gsap from "gsap";
import iconUrl from "../icon.png?url";

interface SplashProps {
  /** When false, the splash starts its exit animation. */
  visible: boolean;
  /** Called once the exit animation finishes — parent should unmount. */
  onExit: () => void;
}

/**
 * Boot splash. Shows the chimera-skull logo + the "ReChimera" wordmark
 * + a pulsing loader, all fading in in sequence while the rest of the
 * React tree mounts (Redux rehydrate, font load, IDE shell layout).
 *
 * Lives in the same React tree as App but renders ABOVE everything via
 * a full-screen fixed positioning + high z-index. GSAP drives the
 * entry sequence so timing is consistent across machines; the exit is
 * a single opacity tween triggered when the parent flips `visible`.
 */
export function Splash({ visible, onExit }: SplashProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLHeadingElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);

  // Entry sequence:
  //   1. Backdrop fades in (root opacity 0→1) immediately.
  //   2. Logo scales up + fades in.
  //   3. Wordmark slides up + fades in (slight overlap with logo).
  //   4. Loader fades in last so the dots only start their pulse
  //      after the rest is settled — feels more polished than having
  //      everything animate simultaneously.
  useEffect(() => {
    const tl = gsap.timeline();
    tl.from(rootRef.current, {
      opacity: 0,
      duration: 0.25,
      ease: "power2.out",
    })
      .from(
        logoRef.current,
        {
          opacity: 0,
          scale: 0.7,
          y: -8,
          duration: 0.6,
          ease: "back.out(1.4)",
        },
        "-=0.1",
      )
      .from(
        nameRef.current,
        {
          opacity: 0,
          y: 14,
          duration: 0.45,
          ease: "power3.out",
        },
        "-=0.30",
      )
      .from(
        loaderRef.current,
        {
          opacity: 0,
          y: 6,
          duration: 0.35,
          ease: "power2.out",
        },
        "-=0.15",
      );
    return () => {
      tl.kill();
    };
  }, []);

  // Exit: fade the whole splash out when `visible` flips to false.
  useEffect(() => {
    if (visible) return;
    const root = rootRef.current;
    if (!root) {
      onExit();
      return;
    }
    const tween = gsap.to(root, {
      opacity: 0,
      duration: 0.35,
      ease: "power2.in",
      onComplete: onExit,
    });
    return () => {
      tween.kill();
    };
  }, [visible, onExit]);

  return (
    <div ref={rootRef} className="splash" role="status" aria-live="polite">
      <div className="splash-content">
        <div ref={logoRef} className="splash-logo">
          <img src={iconUrl} alt="" draggable={false} />
        </div>
        <h1 ref={nameRef} className="splash-name">
          ReChimera
        </h1>
        <div ref={loaderRef} className="splash-loader" aria-hidden>
          <span className="splash-loader-dot" />
          <span className="splash-loader-dot" />
          <span className="splash-loader-dot" />
        </div>
      </div>
    </div>
  );
}
