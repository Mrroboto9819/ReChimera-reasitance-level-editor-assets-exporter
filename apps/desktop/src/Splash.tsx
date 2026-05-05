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
 * Boot splash. Shows the app logo + name big and centered while the rest
 * of the React tree mounts (Redux rehydrate, font load, IDE shell layout).
 *
 * Lives in the same React tree as App but renders ABOVE everything via a
 * full-screen fixed positioning + high z-index. GSAP handles the entrance
 * pulse and the exit fade so the timing is consistent across machines.
 */
export function Splash({ visible, onExit }: SplashProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLHeadingElement>(null);

  // Entry: short fade + scale-in for the logo, slide-up for the wordmark.
  // Runs once on mount.
  useEffect(() => {
    const tl = gsap.timeline();
    tl.from(logoRef.current, {
      opacity: 0,
      scale: 0.85,
      duration: 0.5,
      ease: "power3.out",
    })
      .from(
        nameRef.current,
        { opacity: 0, y: 8, duration: 0.4, ease: "power2.out" },
        "-=0.25",
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
        <div className="splash-tagline">
          Insomniac PS3 level viewer
        </div>
        <div className="splash-loader" aria-hidden>
          <span className="splash-loader-dot" />
          <span className="splash-loader-dot" />
          <span className="splash-loader-dot" />
        </div>
      </div>
    </div>
  );
}
