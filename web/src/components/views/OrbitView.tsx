import { useEffect, useRef } from "react";
import ParticleFX from "../ParticleFX.js";
import Starfield from "../Starfield.js";
import { AgentState, NodeView, RunAgentView } from "../../hooks/useSnapshot.js";
import { Cast } from "../../lib/iching.js";
import ViewNode from "./ViewNode.js";
import { assignSlots, maxSlot } from "./slots.js";

export interface ViewSharedProps {
  items: (NodeView | RunAgentView)[];
  colorOf: (n: any) => string;
  aliasOf: (n: any) => string;
  machineOf: (n: any) => string;
  stateOf: (n: NodeView | RunAgentView) => AgentState;
  tagOf: (n: any) => string | undefined;
  pins: string[];
  selectedId: string | null;
  /** 运行中的会话数：供粒子特效动态调节密度/强度 */
  activity?: number;
  /** 有通知的球 id 集合：显示角标 */
  noticeIds?: Set<string>;
  hexOf?: (id: string) => Cast | null;
  hexOn?: boolean;
  onSelect: (id: string) => void;
  onContext: (e: React.MouseEvent, id: string) => void;
  onUnpin: (id: string) => void;
}

export interface OrbitLane {
  key: string;
  label: string;
  status: string;
  latency: number | null;
  items: (NodeView | RunAgentView)[];
}

const TILT = 0.4;
const FOCUS = 900;

/** 星系轨道：每个机器一圈，agent 沿环运行，近大远小 */
export default function OrbitView(props: ViewSharedProps & { lanes: OrbitLane[] }) {
  const { items, lanes, colorOf, aliasOf, machineOf, stateOf, tagOf, pins, selectedId, onSelect, onContext, onUnpin, noticeIds } = props;
  const hexOf = props.hexOf;
  const hexOn = props.hexOn;

  const stageRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef<(HTMLDivElement | null)[]>([]);
  const ringEls = useRef<(SVGEllipseElement | null)[]>([]);
  const labelEls = useRef<(HTMLDivElement | null)[]>([]);
  const hubRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<string | null>(null);
  const angleRef = useRef(0);
  const velRef = useRef(0);
  const dragRef = useRef<{ x: number; t: number } | null>(null);
  const dragMovedRef = useRef(false);
  const speedRef = useRef(1);

  // 每圈一个稳定槽位表：圈内 agent 增删时，其它球的角度不变（不会整体跳）
  const laneSlots = useRef<Record<string, Map<string, number>>>({});
  const flat: { nd: NodeView | RunAgentView; lane: number; slot: number; denom: number }[] = [];
  lanes.forEach((l, li) => {
    const m = assignSlots(laneSlots.current[l.key] ?? new Map(), l.items.map((i) => i.id));
    laneSlots.current[l.key] = m;
    const denom = Math.max(1, maxSlot(m) + 1);
    for (const nd of l.items) flat.push({ nd, lane: li, slot: m.get(nd.id) ?? 0, denom });
  });

  const live = useRef({ lanes, flat, colorOf, aliasOf, stateOf, tagOf, pins, selectedId });
  live.current = { lanes, flat, colorOf, aliasOf, stateOf, tagOf, pins, selectedId };

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let warned = false;
    const loop = (now: number) => {
      // 先把下一帧排上：单帧异常不至于把轨道永久停住
      raf = requestAnimationFrame(loop);
      try {
        tick(now);
      } catch (err) {
        if (!warned) { warned = true; console.warn("[orbit] frame error", err); }
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const stage = stageRef.current;
      const l = live.current;
      if (stage && l.flat.length + l.lanes.length > 0) {
        const W = stage.clientWidth || 1;
        const H = stage.clientHeight || 1;
        const cx = W / 2;
        const cy = H / 2;
        const maxR = Math.max(140, Math.min(W * 0.42, H * 0.86));
        // 只为「有球」的圈分配半径，并把它们铺开到内→外，避免球都挤在内圈/中心（空机器的圈不占位）
        const occupied: number[] = [];
        for (let i = 0; i < l.lanes.length; i++) if ((l.lanes[i].items?.length ?? 0) > 0) occupied.push(i);
        const nOcc = occupied.length;
        const inner = maxR * 0.34;
        const stepOcc = nOcc > 1 ? (maxR - inner) / (nOcc - 1) : 0;
        const laneR: number[] = l.lanes.map(() => NaN);
        occupied.forEach((li, rank) => { laneR[li] = nOcc === 1 ? maxR * 0.6 : inner + rank * stepOcc; });

        if (!dragRef.current) {
          // 悬停平滑压速到 55%，不停转
          const target = hoverRef.current ? 0.55 : 1;
          speedRef.current += (target - speedRef.current) * Math.min(1, dt * 7);
          angleRef.current += (0.26 * speedRef.current + velRef.current) * dt;
          velRef.current *= Math.pow(0.12, dt);
          if (Math.abs(velRef.current) < 0.01) velRef.current = 0;
        }
        const spin = angleRef.current;

        // 环
        for (let i = 0; i < ringEls.current.length; i++) {
          const el = ringEls.current[i];
          if (!el) continue;
          const r = laneR[i];
          if (!Number.isFinite(r)) { el.setAttribute("rx", "0"); el.setAttribute("ry", "0"); continue; }
          el.setAttribute("cx", String(cx));
          el.setAttribute("cy", String(cy));
          el.setAttribute("rx", String(r));
          el.setAttribute("ry", String(r * TILT));
        }
        for (let i = 0; i < labelEls.current.length; i++) {
          const el = labelEls.current[i];
          if (!el) continue;
          const r = laneR[i];
          if (!Number.isFinite(r)) { el.style.opacity = "0"; continue; }
          el.style.opacity = "";
          el.style.transform = `translate(${cx.toFixed(0)}px, ${(cy - r * TILT - 4).toFixed(0)}px) translate(-50%, -50%)`;
        }

        // 球
        for (let i = 0; i < l.flat.length; i++) {
          const el = nodeEls.current[i];
          if (!el) continue;
          const { nd, lane, slot, denom } = l.flat[i];
          const r = Number.isFinite(laneR[lane]) ? laneR[lane] : maxR * 0.6;
          const speed = 0.85 / (1 + lane * 0.42);
          const a = spin * speed + lane * 1.7 + (slot / denom) * Math.PI * 2;
          const sin = Math.sin(a);
          const z = sin * r * 0.5;
          const persp = FOCUS / (FOCUS - z);
          const x = cx + Math.cos(a) * r;
          const y = cy + sin * r * TILT;
          const hot = hoverRef.current === nd.id;
          const isSel = l.selectedId === nd.id;
          const sc = persp * 0.92 * (hot ? 1.26 : isSel ? 1.15 : 1);
          el.style.transform = `translate(calc(${x.toFixed(1)}px - 50%), calc(${y.toFixed(1)}px - 40%)) scale(${sc.toFixed(3)})`;
          el.style.opacity = String(0.3 + ((sin + 1) / 2) * 0.7);
          el.style.zIndex = String(Math.round((sin + 1) * 300) + (hot || isSel ? 900 : 0));
          const blur = persp < 1 ? Math.round((1 - persp) * 8) * 0.5 : 0;
          const f = blur > 0 ? `blur(${blur}px)` : "";
          if (el.dataset.blur !== f) { el.dataset.blur = f; el.style.filter = f; }
        }

        if (hubRef.current) {
          hubRef.current.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.buttons === 0) { dragRef.current = null; return; }
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 4) dragMovedRef.current = true;
      const prev = angleRef.current;
      angleRef.current = d.t + dx * 0.01;
      velRef.current = Math.max(-6, Math.min(6, (angleRef.current - prev) / 0.016));
    };
    const onUp = () => { dragRef.current = null; };
    const onBlur = () => { dragRef.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, []);

  const total = flat.length;

  return (
    <div
      className="vstage ob-stage"
      ref={stageRef}
      onPointerDown={(e) => {
        dragMovedRef.current = false;
        velRef.current = 0;
        dragRef.current = { x: e.clientX, t: angleRef.current };
      }}
      onPointerLeave={() => { hoverRef.current = null; }}
    >
      <div className="ob-aura" />
      <Starfield density={1} />
      <ParticleFX mode="orbit" count={items.length} activity={props.activity ?? 0} />
      <svg className="ob-svg" width="100%" height="100%">
        {lanes.map((l, i) => (
          <ellipse
            key={l.key}
            ref={(el) => { ringEls.current[i] = el; }}
            className={`ob-ring ${l.status}`}
          />
        ))}
      </svg>

      <div className="ob-hub" ref={hubRef}>
        <span className="ob-hub-core" />
        <span className="ob-hub-ring" />
        <span className="ob-hub-count">{total}</span>
      </div>

      {lanes.map((l, i) => (
        <div key={l.key} className="ob-label" ref={(el) => { labelEls.current[i] = el; }}>
          {l.label}
        </div>
      ))}

      {flat.map((f, i) => (
        <ViewNode
          key={f.nd.id}
          id={f.nd.id}
          label={aliasOf(f.nd)}
          machine={machineOf(f.nd)}
          state={stateOf(f.nd)}
          color={colorOf(f.nd)}
          selected={selectedId === f.nd.id}
          pinned={pins.includes(f.nd.id)}
          server={(f.nd as any).kind !== "run"}
          tag={tagOf(f.nd)}
          awaitingCount={(f.nd as NodeView).pendingPermissions?.length + (f.nd as NodeView).pendingQuestions?.length}
          notice={noticeIds?.has(f.nd.id)}
          innerRef={(el) => { nodeEls.current[i] = el; }}
          onEnter={() => { hoverRef.current = f.nd.id; }}
          onLeave={() => { if (hoverRef.current === f.nd.id) hoverRef.current = null; }}
          onUnpin={() => onUnpin(f.nd.id)}
          onSelect={() => { if (!dragMovedRef.current) onSelect(f.nd.id); }}
          onContext={(e) => onContext(e, f.nd.id)}
          hex={hexOf ? hexOf(f.nd.id) : null}
          hexOn={hexOn}
        />
      ))}
      {total === 0 && <div className="v-empty">此状态下没有 agent</div>}
      <div className="v-tip">拖动旋转 · 悬停减速</div>
    </div>
  );
}