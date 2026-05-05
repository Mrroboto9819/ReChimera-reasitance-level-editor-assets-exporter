import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";

interface FpsOverlayProps {
  /** "counter" = compact text, "graph" = inline sparkline */
  mode: "counter" | "graph";
}

/**
 * Lightweight always-on FPS sampler. Lives inside the R3F `<Canvas>`
 * because it needs `useFrame` for per-frame deltas. Reports samples to
 * the DOM-side `<FpsOverlay>` via window-scoped globals — they can't
 * share React context across the Canvas boundary.
 *
 * `useFrame` runs once per render. We accumulate frames in a ref and
 * report the smoothed value at most 4× per second so React state
 * updates stay cheap.
 */
type FpsWindow = Window & {
  __rechimera_fps?: (n: number) => void;
  __rechimera_fps_history?: { ring: Float32Array; index: { i: number } };
};

export function FpsSampler() {
  const lastReport = useRef(performance.now());
  const frames = useRef(0);

  useFrame(() => {
    frames.current++;
    const now = performance.now();
    const elapsed = now - lastReport.current;
    if (elapsed >= 250) {
      const fps = (frames.current * 1000) / elapsed;
      const w = window as FpsWindow;
      w.__rechimera_fps?.(fps);
      const hist = w.__rechimera_fps_history;
      if (hist) {
        hist.ring[hist.index.i] = fps;
        hist.index.i = (hist.index.i + 1) % hist.ring.length;
      }
      frames.current = 0;
      lastReport.current = now;
    }
  });

  return null;
}

const RING_SIZE = 64;

export function FpsOverlay({ mode }: FpsOverlayProps) {
  // Note: the renderer-side sampler lives inside the Canvas (via FpsSampler).
  // This overlay is the DOM-side display. They communicate via a window-
  // scoped event emitter set up below.
  const [fps, setFps] = useState(0);
  const ringRef = useRef<Float32Array>(new Float32Array(RING_SIZE));
  const indexRef = useRef<{ i: number }>({ i: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Wire the sampler. Because Viewport renders this overlay AS A SIBLING
  // of the Canvas (DOM, not three.js), we expose the setter via a global
  // hook that the in-canvas FpsSampler picks up.
  useEffect(() => {
    (window as Window & { __rechimera_fps?: typeof setFps }).__rechimera_fps =
      setFps;
    (window as Window & {
      __rechimera_fps_history?: { ring: Float32Array; index: { i: number } };
    }).__rechimera_fps_history = { ring: ringRef.current, index: indexRef.current };
    return () => {
      delete (window as Window & { __rechimera_fps?: typeof setFps })
        .__rechimera_fps;
      delete (window as Window & {
        __rechimera_fps_history?: unknown;
      }).__rechimera_fps_history;
    };
  }, []);

  // Draw the sparkline graph
  useEffect(() => {
    if (mode !== "graph") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      // Background
      ctx.fillStyle = "rgba(7, 8, 10, 0.85)";
      ctx.fillRect(0, 0, w, h);

      // Bars from ring buffer
      const ring = ringRef.current;
      const n = ring.length;
      const startI = indexRef.current.i;
      const max = 120; // FPS cap for normalization
      const barW = w / n;
      for (let k = 0; k < n; k++) {
        const v = ring[(startI + k) % n] ?? 0;
        const norm = Math.min(1, v / max);
        const barH = norm * h;
        const hue = norm > 0.5 ? 151 : norm > 0.25 ? 43 : 0;
        ctx.fillStyle = `hsl(${hue}, 60%, 55%)`;
        ctx.fillRect(k * barW, h - barH, Math.max(1, barW - 0.5), barH);
      }

      // 60 FPS reference line
      const refY = h - (60 / max) * h;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.beginPath();
      ctx.moveTo(0, refY);
      ctx.lineTo(w, refY);
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  const color =
    fps >= 55 ? "var(--accent-green)" : fps >= 30 ? "var(--accent-yellow)" : "var(--accent-red)";

  if (mode === "counter") {
    return (
      <div className="fps-overlay">
        <span className="fps-dot" style={{ background: color }} />
        <span className="fps-num">{fps.toFixed(0)}</span>
        <span className="fps-unit">fps</span>
      </div>
    );
  }

  return (
    <div className="fps-overlay fps-overlay-graph">
      <canvas
        ref={canvasRef}
        width={120}
        height={32}
        className="fps-canvas"
      />
      <div className="fps-legend">
        <span className="fps-dot" style={{ background: color }} />
        <span className="fps-num">{fps.toFixed(0)}</span>
        <span className="fps-unit">fps</span>
      </div>
    </div>
  );
}
