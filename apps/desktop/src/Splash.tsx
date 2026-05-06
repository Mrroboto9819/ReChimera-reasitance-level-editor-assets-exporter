import { useEffect, useLayoutEffect, useRef } from "react";
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

  // Entry sequence — runs in useLayoutEffect (synchronous, before
  // browser paint) so the user never sees a flash of fully-visible
  // splash before GSAP grabs it. The inline `opacity: 0` styles in
  // JSX below hide each element on first paint; GSAP then animates
  // them to their final state in this sequence:
  //   1. Backdrop fades in.
  //   2. Logo scales up + slides down + fades in (with a soft bounce
  //      via back.out for personality).
  //   3. Wordmark slides up + fades in (slight overlap with logo).
  //   4. Loader fades in last so the dots only start their pulse
  //      after the rest has settled — feels more polished than
  //      animating everything at once.
  useLayoutEffect(() => {
    const tl = gsap.timeline();
    tl.to(rootRef.current, {
      opacity: 1,
      duration: 0.25,
      ease: "power2.out",
    })
      .to(
        logoRef.current,
        {
          opacity: 1,
          scale: 1,
          y: 0,
          duration: 0.6,
          ease: "back.out(1.4)",
        },
        "-=0.1",
      )
      .to(
        nameRef.current,
        {
          opacity: 1,
          y: 0,
          duration: 0.45,
          ease: "power3.out",
        },
        "-=0.30",
      )
      .to(
        loaderRef.current,
        {
          opacity: 1,
          y: 0,
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

  // Inline opacity:0 + transforms on each element so the first
  // browser paint shows them already in their "starting" state.
  // Without this, React renders them at default visibility for one
  // frame before GSAP's useLayoutEffect runs — the user would see a
  // brief full-opacity flash before the animation begins.
  return (
    <div
      ref={rootRef}
      className="splash"
      role="status"
      aria-live="polite"
      style={{ opacity: 0 }}
    >
      <div className="splash-content">
        <div
          ref={logoRef}
          className="splash-logo"
          style={{ opacity: 0, transform: "scale(0.7) translateY(-8px)" }}
        >
          <img src={iconUrl} alt="" draggable={false} />
        </div>
        <h1
          ref={nameRef}
          className="splash-name"
          style={{ opacity: 0, transform: "translateY(14px)" }}
        >
          ReChimera
        </h1>
        <div
          ref={loaderRef}
          className="splash-loader"
          aria-hidden
          style={{ opacity: 0, transform: "translateY(6px)" }}
        >
          <span className="splash-loader-dot" />
          <span className="splash-loader-dot" />
          <span className="splash-loader-dot" />
        </div>
      </div>
    </div>
  );
}
