import { useEffect, useRef } from "react";

function hexToRgbStr(hex: string): string {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function cssRGB(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) return fallback;
    return v.startsWith("#") ? hexToRgbStr(v) : v;
  } catch {
    return fallback;
  }
}

export default function ParticleFX({ mode, count = 0, activity = 0, className = "" }: { mode: "orbit"; count?: number; activity?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const countRef = useRef(count);
  countRef.current = count;
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const parent = canvas.parentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0, h = 0, raf = 0, lastKey = "", t = 0;
    let A = cssRGB("--acc-rgb", "167, 139, 250");
    let B = cssRGB("--ready-rgb", "125, 211, 192");
    let C = cssRGB("--awaiting-rgb", "251, 191, 36");
    const readTheme = () => {
      A = cssRGB("--acc-rgb", A); B = cssRGB("--ready-rgb", B); C = cssRGB("--awaiting-rgb", C);
    };

    interface OrbitP { a: number; sp: number; rx: number; ry: number; r: number; c: string; }
    let orbit: OrbitP[] = [];

    const density = () => Math.max(28, Math.min(300, 30 + countRef.current * 4 + activityRef.current * 18));
    const energy = () => 0.5 + Math.min(2.2, activityRef.current * 0.26 + countRef.current * 0.02);

    const build = () => {
      const n = density();
      const rings = Math.max(3, Math.min(9, Math.round(n / 16)));
      orbit = [];
      const base = Math.min(w, h) * 0.46;
      for (let i = 0; i < rings; i++) {
        const rx = base * (0.34 + i * 0.085);
        const ry = rx * (0.5 + Math.random() * 0.18);
        const cnt = Math.max(4, Math.round(n / rings));
        for (let j = 0; j < cnt; j++) {
          orbit.push({
            a: Math.random() * 6.28,
            sp: (0.0016 + Math.random() * 0.0028) * (1 + i * 0.12),
            rx, ry, r: Math.random() * 2 + 1,
            c: Math.random() < 0.6 ? A : (Math.random() < 0.5 ? B : C),
          });
        }
      }
      lastKey = countRef.current + ":" + activityRef.current;
    };

    const resize = () => {
      w = parent?.clientWidth ?? window.innerWidth;
      h = parent?.clientHeight ?? window.innerHeight;
      canvas.width = Math.max(1, Math.floor(w * DPR));
      canvas.height = Math.max(1, Math.floor(h * DPR));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      build();
      if (reduce) draw();
    };

    const dot = (x: number, y: number, r: number, c: string, a: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, `rgba(${c}, ${a * 0.85})`);
      g.addColorStop(1, `rgba(${c}, 0)`);
      ctx.beginPath(); ctx.arc(x, y, r * 4, 0, 6.283); ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fillStyle = `rgba(${c}, ${a})`; ctx.fill();
    };

    const draw = () => {
      t += 1; // 帧计数：驱动星系核光晕的缓慢脉动（Math.sin(t*0.02)）
      ctx.clearRect(0, 0, w, h);
      const k = countRef.current + ":" + activityRef.current;
      if (k !== lastKey) build();
      const cx = w / 2, cy = h / 2;
      const e = energy();
      // 星系核光晕：强化中央"当前星系"
      const coreR = Math.min(w, h) * (0.16 + 0.02 * Math.sin(t * 0.02));
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      cg.addColorStop(0, `rgba(${A}, ${0.20 + 0.05 * e})`);
      cg.addColorStop(0.45, `rgba(${A}, 0.06)`);
      cg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, 6.283); ctx.fillStyle = cg; ctx.fill();

      const seen = new Set<number>();
      for (const o of orbit) {
        const key = Math.round(o.rx);
        if (!seen.has(key)) {
          seen.add(key);
          ctx.strokeStyle = `rgba(${A}, 0.16)`;
          ctx.lineWidth = 0.9;
          ctx.beginPath(); ctx.ellipse(cx, cy, o.rx, o.ry, 0, 0, 6.283); ctx.stroke();
        }
      }
      for (const o of orbit) {
        o.a += o.sp * e;
        const x = cx + Math.cos(o.a) * o.rx;
        const y = cy + Math.sin(o.a) * o.ry;
        const ta = o.a - o.sp * e * 10;
        const tx = cx + Math.cos(ta) * o.rx, ty = cy + Math.sin(ta) * o.ry;
        ctx.strokeStyle = `rgba(${o.c}, 0.5)`;
        ctx.lineWidth = o.r * 0.8;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
        dot(x, y, o.r * 1.15, o.c, 0.85);
      }
    };

    const loop = () => { draw(); raf = requestAnimationFrame(loop); };

    resize();
    const ro = new ResizeObserver(() => resize());
    if (parent) ro.observe(parent);
    const mo = new MutationObserver(readTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (!reduce) loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect(); mo.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={`pfx pfx-${mode} ${className}`} aria-hidden="true" />;
}
