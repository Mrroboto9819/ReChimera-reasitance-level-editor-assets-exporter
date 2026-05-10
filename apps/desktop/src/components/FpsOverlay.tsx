import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";

interface FpsOverlayProps {
  
  mode: "counter" | "graph";
}






interface RenderStats {
  
  calls: number;
  
  triangles: number;
  
  geometries: number;
  
  textures: number;
  
  programs: number;
}











type FpsWindow = Window & {
  __rechimera_fps?: (n: number) => void;
  __rechimera_fps_history?: { ring: Float32Array; index: { i: number } };
  __rechimera_stats?: (s: RenderStats) => void;
};

export function FpsSampler() {
  const lastReport = useRef(performance.now());
  const frames = useRef(0);
  
  
  const { gl } = useThree();

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
      
      
      
      const info = gl.info;
      w.__rechimera_stats?.({
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
      });
      frames.current = 0;
      lastReport.current = now;
    }
  });

  return null;
}

const RING_SIZE = 64;

export function FpsOverlay({ mode }: FpsOverlayProps) {
  
  
  
  const [fps, setFps] = useState(0);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const ringRef = useRef<Float32Array>(new Float32Array(RING_SIZE));
  const indexRef = useRef<{ i: number }>({ i: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  
  
  
  useEffect(() => {
    const w = window as FpsWindow;
    w.__rechimera_fps = setFps;
    w.__rechimera_fps_history = { ring: ringRef.current, index: indexRef.current };
    w.__rechimera_stats = setStats;
    return () => {
      delete w.__rechimera_fps;
      delete w.__rechimera_fps_history;
      delete w.__rechimera_stats;
    };
  }, []);

  
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
      
      ctx.fillStyle = "rgba(7, 8, 10, 0.85)";
      ctx.fillRect(0, 0, w, h);

      
      const ring = ringRef.current;
      const n = ring.length;
      const startI = indexRef.current.i;
      const max = 120; 
      const barW = w / n;
      for (let k = 0; k < n; k++) {
        const v = ring[(startI + k) % n] ?? 0;
        const norm = Math.min(1, v / max);
        const barH = norm * h;
        const hue = norm > 0.5 ? 151 : norm > 0.25 ? 43 : 0;
        ctx.fillStyle = `hsl(${hue}, 60%, 55%)`;
        ctx.fillRect(k * barW, h - barH, Math.max(1, barW - 0.5), barH);
      }

      
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
      {stats && (
        <div className="fps-stats">
          <div title="Draw calls per frame — each is a GPU submission. Lower is better.">
            <span className="fps-stat-label">draws</span>
            <span className="fps-stat-num">{stats.calls.toLocaleString()}</span>
          </div>
          <div title="Triangles rendered per frame.">
            <span className="fps-stat-label">tris</span>
            <span className="fps-stat-num">{formatBigNum(stats.triangles)}</span>
          </div>
          <div title="Live BufferGeometry objects on the GPU.">
            <span className="fps-stat-label">geom</span>
            <span className="fps-stat-num">{stats.geometries}</span>
          </div>
          <div title="Live textures on the GPU.">
            <span className="fps-stat-label">tex</span>
            <span className="fps-stat-num">{stats.textures}</span>
          </div>
          <div title="Compiled shader programs.">
            <span className="fps-stat-label">prog</span>
            <span className="fps-stat-num">{stats.programs}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBigNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}
