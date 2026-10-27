import { CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HostMetrics } from "../hooks/useSnapshot.js";

const fmtGB = (b: number) => (b / 1073741824).toFixed(1) + "G";
const pct = (n: number) => `${Math.max(0, Math.min(100, Math.round(n * 10) / 10))}%`;
const clampPct = (n: number) => Math.max(0, Math.min(100, n));
const platformCN = (p: string) => (p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p === "linux" ? "Linux" : p || "未知");
const lvl = (v: number) => (v >= 85 ? "hi" : v >= 60 ? "mid" : "ok");
const LVL_VAR: Record<string, string> = { ok: "var(--ready)", mid: "var(--awaiting)", hi: "var(--danger)" };
const HIST = 48;
const ORB_SIZE = 56;
const POS_KEY = "atrium.hostLoadPos";
const hostKey = (h: HostMetrics) => `${h.machine}::${h.hostname || ""}::${h.label || ""}`;
const hostName = (h: HostMetrics) => h.machine || h.label || h.hostname || "未知机器";
const hostMeta = (h: HostMetrics) => {
  const name = hostName(h);
  const parts = [h.hostname, h.label, `${h.cpuCount}核`, platformCN(h.platform)].filter(Boolean) as string[];
  return [...new Set(parts)].filter((p) => p !== name).join(" · ");
};
const loadPos = (): { l: number; t: number } | null => {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    return v && typeof v.l === "number" && typeof v.t === "number" ? v : null;
  } catch {
    return null;
  }
};

function wavePath(vals: number[], w: number, h: number): string {
  const n = vals.length;
  if (n < 2) return "";
  const pad = 2;
  const pts = vals.map((v, i) => [
    (i / (n - 1)) * w,
    pad + (1 - clampPct(v) / 100) * (h - pad * 2),
  ]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function Wave({ vals, level, w, h, fluid }: { vals: number[]; level: string; w: number; h: number; fluid?: boolean }) {
  const line = useMemo(() => wavePath(vals, w, h), [vals, w, h]);
  return (
    <svg
      className={`hl-wave ${fluid ? "fluid" : ""}`}
      width={fluid ? "100%" : w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio={fluid ? "none" : undefined}
      style={{ color: LVL_VAR[level] ?? LVL_VAR.ok }}
      aria-hidden="true"
    >
      {line && <path d={`${line}L${w},${h}L0,${h}Z`} fill="currentColor" className="hl-wave-fill" />}
      {line && <path d={line} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" vectorEffect={fluid ? "non-scaling-stroke" : undefined} className="hl-wave-line" />}
    </svg>
  );
}

function MiniMetric({ label, value, vals, sub }: { label: string; value: number; vals: number[]; sub: string }) {
  const level = lvl(value);
  return (
    <div className={`hl-mini ${level}`} title={`${label} ${value.toFixed(0)}% · ${sub}`}>
      <div className="hl-mini-top">
        <span className="hl-rl">{label}</span>
        <Wave vals={vals} level={level} w={64} h={12} fluid />
        <b className={`hl-rv ${level}`}>{value.toFixed(0)}%</b>
      </div>
      <div className="hl-bar">
        <i style={{ width: pct(value), background: LVL_VAR[level] }} />
      </div>
      <div className="hl-mini-sub">{sub}</div>
    </div>
  );
}

export default function HostLoad({
  hosts,
  gen,
  visible,
  onHide,
}: {
  hosts: HostMetrics[];
  gen?: number;
  visible: boolean;
  onHide: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ l: number; t: number } | null>(loadPos);
  const [dragging, setDragging] = useState(false);
  const [popPos, setPopPos] = useState<{ l: number; t: number } | null>(null);
  const hist = useRef(new Map<string, { cpu: number[]; mem: number[] }>());
  const lastGen = useRef(-1);
  const orbRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; l: number; t: number; moved: boolean } | null>(null);

  if ((gen ?? 0) !== lastGen.current) {
    lastGen.current = gen ?? 0;
    for (const h of hosts) {
      const k = hostKey(h);
      const e = hist.current.get(k);
      if (!e) {
        hist.current.set(k, { cpu: new Array(18).fill(h.cpuPct), mem: new Array(18).fill(h.memPct) });
      } else {
        e.cpu.push(h.cpuPct);
        e.mem.push(h.memPct);
        if (e.cpu.length > HIST) e.cpu.splice(0, e.cpu.length - HIST);
        if (e.mem.length > HIST) e.mem.splice(0, e.mem.length - HIST);
      }
    }
  }
  const histOf = (h: HostMetrics) => hist.current.get(hostKey(h)) ?? { cpu: [h.cpuPct, h.cpuPct], mem: [h.memPct, h.memPct] };

  const self = hosts.find((h) => h.self) ?? hosts[0] ?? null;
  const sortedHosts = useMemo(() => hosts.slice().sort((a, b) => (
    Number(!!b.self) - Number(!!a.self) ||
    Math.max(b.cpuPct, b.memPct) - Math.max(a.cpuPct, a.memPct)
  )), [hosts]);
  const fleet = useMemo(() => ({
    cpu: hosts.reduce((m, h) => Math.max(m, h.cpuPct), 0),
    mem: hosts.reduce((m, h) => Math.max(m, h.memPct), 0),
  }), [hosts]);

  const clamp = (p: { l: number; t: number }) => ({
    l: Math.max(8, Math.min(p.l, Math.max(8, window.innerWidth - ORB_SIZE - 8))),
    t: Math.max(8, Math.min(p.t, Math.max(8, window.innerHeight - ORB_SIZE - 8))),
  });

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p) : null));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && (Math.abs(e.clientX - d.px) > 3 || Math.abs(e.clientY - d.py) > 3)) d.moved = true;
      if (d.moved) setPos(clamp({ l: d.l + e.clientX - d.px, t: d.t + e.clientY - d.py }));
    };
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDragging(false);
      if (d.moved) {
        setPos((p) => {
          if (p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch {} }
          return p;
        });
      } else {
        setOpen((o) => !o);
      }
    };
    const cancel = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !visible || !self || !orbRef.current || !popRef.current) {
      setPopPos(null);
      return;
    }
    const b = orbRef.current.getBoundingClientRect();
    const p = popRef.current.getBoundingClientRect();
    const gap = 12;
    const l = Math.max(12, Math.min(b.left + b.width / 2 - p.width / 2, window.innerWidth - p.width - 12));
    let t = b.top - p.height - gap;
    if (t < 12) t = b.bottom + gap;
    t = Math.max(12, Math.min(t, window.innerHeight - p.height - 12));
    setPopPos({ l, t });
  }, [open, visible, self, pos, hosts.length]);

  if (!visible || !self) return null;

  const cpuLevel = lvl(self.cpuPct);
  const memLevel = lvl(self.memPct);
  const worst = lvl(Math.max(self.cpuPct, self.memPct));
  const cOuter = 2 * Math.PI * 24;
  const cInner = 2 * Math.PI * 18;
  const dockStyle: CSSProperties = pos ? { left: pos.l, top: pos.t, bottom: "auto", right: "auto" } : {};
  const popStyle: CSSProperties = popPos ? { left: popPos.l, top: popPos.t } : { left: -9999, top: -9999 };

  const onPointerDown = (e: ReactPointerEvent) => {
    const el = orbRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { px: e.clientX, py: e.clientY, l: r.left, t: r.top, moved: false };
    setDragging(true);
    setPos(clamp({ l: r.left, t: r.top }));
    e.stopPropagation();
  };

  return (
    <>
      <div
        ref={orbRef}
        className={`hl-orb ${open ? "open" : ""} ${dragging ? "dragging" : ""} ${worst}`}
        style={dockStyle}
        title={`本机 CPU ${self.cpuPct.toFixed(0)}% · 内存 ${self.memPct.toFixed(0)}%\n外环 CPU · 内环内存 · 拖动移动 · 点击展开`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="hl-orb-btn" onPointerDown={onPointerDown}>
          <svg className="hl-orb-svg" viewBox="0 0 56 56" aria-hidden="true">
            <circle className="hl-ring-track outer" cx="28" cy="28" r="24" />
            <circle
              className="hl-ring outer"
              cx="28" cy="28" r="24"
              strokeDasharray={cOuter}
              strokeDashoffset={cOuter * (1 - clampPct(self.cpuPct) / 100)}
              transform="rotate(-90 28 28)"
              style={{ color: LVL_VAR[cpuLevel] }}
            />
            <circle className="hl-ring-track inner" cx="28" cy="28" r="18" />
            <circle
              className="hl-ring inner"
              cx="28" cy="28" r="18"
              strokeDasharray={cInner}
              strokeDashoffset={cInner * (1 - clampPct(self.memPct) / 100)}
              transform="rotate(-90 28 28)"
              style={{ color: LVL_VAR[memLevel] }}
            />
          </svg>
          <div className="hl-orb-core">
            <span>{Math.round(Math.max(self.cpuPct, self.memPct))}</span>
          </div>
        </div>
        <button
          className="hl-orb-x"
          title="隐藏负载球（可在「设置」里再打开）"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setOpen(false); onHide(); }}
        >✕</button>
      </div>

      <div ref={popRef} className={`hl-pop ${popPos ? "show" : ""}`} style={popStyle} onClick={(e) => e.stopPropagation()}>
        <div className="hl-pop-h">
          <span className="hl-pop-title">机器负载</span>
          <span className="hl-pop-n">{hosts.length} 台</span>
          <span className="hl-peak">
            <span>CPU 峰值 <b className={lvl(fleet.cpu)}>{fleet.cpu.toFixed(0)}%</b></span>
            <span>内存峰值 <b className={lvl(fleet.mem)}>{fleet.mem.toFixed(0)}%</b></span>
          </span>
          <button className="hl-pop-x" title="关闭" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>×</button>
        </div>
        <div className="hl-pop-body">
          {sortedHosts.map((h) => {
            const hh = histOf(h);
            const level = lvl(Math.max(h.cpuPct, h.memPct));
            const meta = hostMeta(h);
            return (
              <div key={hostKey(h)} className={`hl-line ${level}`}>
                <span className={`hl-dot ${h.self ? "self" : ""} ${level}`} />
                <div className="hl-id">
                  <div className="hl-name">
                    <span title={hostName(h)}>{hostName(h)}</span>
                    <em className={`hl-loc ${h.self ? "local" : "remote"}`}>{h.self ? "本机" : "远程"}</em>
                  </div>
                  {meta && <div className="hl-meta" title={meta}>{meta}</div>}
                </div>
                <MiniMetric label="CPU" value={h.cpuPct} vals={hh.cpu} sub={`负载 ${(h.loadavg ?? []).map((x) => x.toFixed(1)).join(" / ")}`} />
                <MiniMetric label="内存" value={h.memPct} vals={hh.mem} sub={`${fmtGB(h.memUsed)} / ${fmtGB(h.memTotal)}`} />
              </div>
            );
          })}
        </div>
        <div className="hl-pop-f">
          <span>拖动圆球可移动位置</span>
          <span>每 4s 刷新</span>
        </div>
      </div>
    </>
  );
}
