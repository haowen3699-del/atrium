import { useEffect, useRef } from "react";

/** 粒子特效背景：多彩发光粒子 + 粒子间连线，模拟"思考/神经网络"脉冲；鼠标悬停斥力反馈 */
export default function ParticleField({ className = "", link = true }: { className?: string; link?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -9999, y: -9999 };

    const COLORS: [string, string][] = [
      ["167, 139, 250", "167, 139, 250"],
      ["34, 211, 238", "34, 211, 238"],
      ["125, 211, 192", "125, 211, 192"],
      ["251, 191, 36", "251, 191, 36"],
      ["192, 132, 252", "192, 132, 252"],
      ["244, 114, 182", "244, 114, 182"],
    ];

    interface P { x: number; y: number; vx: number; vy: number; r: number; ci: number; tw: number; glow: number; }
    const particles: P[] = [];

    const spawn = (count: number) => {
      particles.length = 0;
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.55,
          vy: (Math.random() - 0.5) * 0.55,
          r: Math.random() * 2.6 + 1.2,
          ci: Math.floor(Math.random() * COLORS.length),
          tw: Math.random() * Math.PI * 2,
          glow: Math.random() * 0.5 + 0.4,
        });
      }
    };

    const resize = () => {
      const parent = canvas.parentElement;
      w = parent?.clientWidth ?? window.innerWidth;
      h = parent?.clientHeight ?? window.innerHeight;
      canvas.width = w * DPR;
      canvas.height = h * DPR;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      spawn(Math.min(130, Math.floor((w * h) / 8000)));
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };
    const onLeave = () => { mouse.x = -9999; mouse.y = -9999; };

    const LINK_DIST = 130;
    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.tw += 0.04;
        p.x += p.vx;
        p.y += p.vy;
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        const R = 110;
        if (d2 < R * R && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const f = ((R - d) / R) * 2.4;
          p.x += (dx / d) * f;
          p.y += (dy / d) * f;
        }
        if (p.x < -20) p.x = w + 20;
        if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20;
        if (p.y > h + 20) p.y = -20;
      }
      // 连线（模拟神经连接，距离近的粒子之间画线，靠近鼠标的连线更亮）
      if (link) {
        for (let i = 0; i < particles.length; i++) {
          for (let j = i + 1; j < particles.length; j++) {
            const a = particles[i], b = particles[j];
            const dx = a.x - b.x, dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < LINK_DIST * LINK_DIST) {
              const d = Math.sqrt(d2);
              const alpha = (1 - d / LINK_DIST) * 0.22;
              const nearMouse = (Math.hypot(a.x - mouse.x, a.y - mouse.y) < 150 || Math.hypot(b.x - mouse.x, b.y - mouse.y) < 150);
              ctx.strokeStyle = `rgba(${COLORS[a.ci][1]}, ${nearMouse ? alpha * 2.2 : alpha})`;
              ctx.lineWidth = 0.7;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
        }
      }
      // 粒子本体 + 光晕
      for (const p of particles) {
        const alpha = p.glow * (0.6 + 0.4 * Math.sin(p.tw));
        const c = COLORS[p.ci][0];
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        g.addColorStop(0, `rgba(${c}, ${alpha * 0.85})`);
        g.addColorStop(1, `rgba(${c}, 0)`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${c}, ${alpha})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, [link]);

  return <canvas ref={ref} className={`particle-field ${className}`} />;
}