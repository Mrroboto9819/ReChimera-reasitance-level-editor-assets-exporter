import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
export function FpsSampler() {
    const lastReport = useRef(performance.now());
    const frames = useRef(0);
    useFrame(() => {
        frames.current++;
        const now = performance.now();
        const elapsed = now - lastReport.current;
        if (elapsed >= 250) {
            const fps = (frames.current * 1000) / elapsed;
            const w = window;
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
export function FpsOverlay({ mode }) {
    
    
    
    const [fps, setFps] = useState(0);
    const ringRef = useRef(new Float32Array(RING_SIZE));
    const indexRef = useRef({ i: 0 });
    const canvasRef = useRef(null);
    
    
    
    useEffect(() => {
        window.__rechimera_fps =
            setFps;
        window.__rechimera_fps_history = { ring: ringRef.current, index: indexRef.current };
        return () => {
            delete window
                .__rechimera_fps;
            delete window.__rechimera_fps_history;
        };
    }, []);
    
    useEffect(() => {
        if (mode !== "graph")
            return;
        const canvas = canvasRef.current;
        if (!canvas)
            return;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return;
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
    const color = fps >= 55 ? "var(--accent-green)" : fps >= 30 ? "var(--accent-yellow)" : "var(--accent-red)";
    if (mode === "counter") {
        return (_jsxs("div", { className: "fps-overlay", children: [_jsx("span", { className: "fps-dot", style: { background: color } }), _jsx("span", { className: "fps-num", children: fps.toFixed(0) }), _jsx("span", { className: "fps-unit", children: "fps" })] }));
    }
    return (_jsxs("div", { className: "fps-overlay fps-overlay-graph", children: [_jsx("canvas", { ref: canvasRef, width: 120, height: 32, className: "fps-canvas" }), _jsxs("div", { className: "fps-legend", children: [_jsx("span", { className: "fps-dot", style: { background: color } }), _jsx("span", { className: "fps-num", children: fps.toFixed(0) }), _jsx("span", { className: "fps-unit", children: "fps" })] })] }));
}
