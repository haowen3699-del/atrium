import { useEffect, useRef } from "react";

/** 星空粒子背景：闪烁星点 + 缓慢漂移 + 偶发流星 + 星座连线 + 远方星系(星云) */
export default function Starfield({ className = "", density = 1 }: { className?: string; density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const densityRef = useRef(density);
  densityRef.current = density;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const parent = canvas.parentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0, h = 0, raf = 0, t = 0, lastKey = "";

    interface Star { x: number; y: number; r: number; a: number; tw: number; sp: number; hue: number; }
    interface Shoot { x: number; y: number; vx: number; vy: number; life: number; len: number; }
    interface Neb { x: number; y: number; rx: number; ry: number; rot: number; dr: number; c: number; a: number; }
    interface Cons { stars: number[]; edges: [number, number][]; ph: number; }
    let stars: Star[] = [];
    let shoots: Shoot[] = [];
    let nebs: Neb[] = [];
    let cons: Cons[] = [];

    const colorOf = (hue: number) => (hue < 0.72 ? [255, 255, 255] : hue < 0.9 ? [200, 214, 255] : [236, 222, 255]);

    const count = () => Math.round(Math.max(120, Math.min(560, (w * h) / 5000)) * densityRef.current);

    const build = () => {
      const n = count();
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: Math.random() * 1.5 + 0.3, a: Math.random() * 0.6 + 0.25,
        tw: Math.random() * 6.28, sp: Math.random() * 0.06 + 0.02, hue: Math.random(),
      }));
      // 远方星系 / 星云：几个旋转的椭圆柔光团
      const nb = Math.max(3, Math.min(6, Math.round(n / 90)));
      nebs = Array.from({ length: nb }, (_, i) => ({
        x: Math.random() * w, y: Math.random() * h,
        rx: (60 + Math.random() * 160), ry: (40 + Math.random() * 110),
        rot: Math.random() * Math.PI, dr: (Math.random() - 0.5) * 0.0006,
        c: i % 3, a: 0.05 + Math.random() * 0.05,
      }));
      // 星座：取若干组相距较近的星，组内按最近邻连线
      cons = [];
      const groups = Math.max(2, Math.min(6, Math.round(n / 70)));
      for (let g = 0; g < groups; g++) {
        const cx = Math.random() * w, cy = Math.random() * h, rad = 90 + Math.random() * 120;
        const idx = stars.map((s, i) => ({ i, d: Math.hypot(s.x - cx, s.y - cy) }))
          .filter((o) => o.d < rad).sort((a, b) => a.d - b.d).slice(0, 5 + Math.floor(Math.random() * 3)).map((o) => o.i);
        if (idx.length < 3) continue;
        const edges: [number, number][] = [];
        for (let a = 0; a < idx.length; a++) {
          let best = -1, bd = Infinity;
          for (let b = 0; b < idx.length; b++) {
            if (a === b) continue;
            const d = Math.hypot(stars[idx[a]].x - stars[idx[b]].x, stars[idx[a]].y - stars[idx[b]].y);
            if (d < bd) { bd = d; best = b; }
          }
          if (best >= 0 && bd < rad * 0.9) edges.push([idx[a], idx[best]]);
        }
        cons.push({ stars: idx, edges, ph: Math.random() * 6.28 });
      }
      lastKey = `${w}:${h}`;
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

    const acc = [200, 173, 255];   // 星云色：紫
    const acc2 = [125, 211, 192];  // 青
    const acc3 = [255, 210, 120];  // 暖

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      t++;
      if (`${w}:${h}` !== lastKey) build();

      // 1) 远方星系 / 星云（最底层）
      for (const n of nebs) {
        n.rot += n.dr;
        const col = n.c === 0 ? acc : n.c === 1 ? acc2 : acc3;
        ctx.save();
        ctx.translate(n.x, n.y);
        ctx.rotate(n.rot);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(n.rx, n.ry));
        g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${n.a})`);
        g.addColorStop(0.5, `rgba(${col[0]},${col[1]},${col[2]},${n.a * 0.4})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.scale(1, n.ry / n.rx);
        ctx.beginPath(); ctx.arc(0, 0, n.rx, 0, 6.283); ctx.fillStyle = g; ctx.fill();
        ctx.restore();
      }

      // 2) 星座连线（淡入淡出脉动）
      for (const c of cons) {
        const base = 0.1 + 0.07 * Math.sin(t * 0.01 + c.ph);
        ctx.strokeStyle = `rgba(190,205,255,${Math.max(0.02, base)})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (const [a, b] of c.edges) {
          ctx.moveTo(stars[a].x, stars[a].y);
          ctx.lineTo(stars[b].x, stars[b].y);
        }
        ctx.stroke();
      }

      // 3) 星点
      for (const s of stars) {
        s.tw += 0.02 + s.sp * 0.4;
        s.y += s.sp;
        if (s.y > h + 2) { s.y = -2; s.x = Math.random() * w; }
        const tw = 0.55 + 0.45 * Math.sin(s.tw);
        const alpha = s.a * tw;
        const col = colorOf(s.hue);
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 5);
        g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${alpha})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 5, 0, 6.283); ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${Math.min(1, alpha * 1.4)})`; ctx.fill();
      }

      // 4) 偶发流星
      if (shoots.length < 2 && Math.random() < 0.004) {
        const fromLeft = Math.random() < 0.5;
        shoots.push({
          x: fromLeft ? Math.random() * w * 0.3 : w * (0.6 + Math.random() * 0.3),
          y: Math.random() * h * 0.4,
          vx: (fromLeft ? 1 : -1) * (5 + Math.random() * 3), vy: 2 + Math.random() * 1.5,
          life: 1, len: 90 + Math.random() * 80,
        });
      }
      for (const sh of shoots) {
        sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.012;
        const nx = sh.x - sh.vx * (sh.len / 12), ny = sh.y - sh.vy * (sh.len / 12);
        const grad = ctx.createLinearGradient(sh.x, sh.y, nx, ny);
        grad.addColorStop(0, `rgba(255,255,255,${0.9 * Math.max(0, sh.life)})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = grad; ctx.lineWidth = 1.6; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(nx, ny); ctx.stroke();
      }
      shoots = shoots.filter((sh) => sh.life > 0 && sh.x > -200 && sh.x < w + 200 && sh.y < h + 200);
    };

    const loop = () => { draw(); raf = requestAnimationFrame(loop); };

    resize();
    const ro = new ResizeObserver(() => resize());
    if (parent) ro.observe(parent);
    if (!reduce) loop();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} className={`starfield ${className}`} aria-hidden="true" />;
}