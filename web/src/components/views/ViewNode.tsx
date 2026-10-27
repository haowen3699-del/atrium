import { memo } from "react";
import { AgentState, STATE_LABELS } from "../../hooks/useSnapshot.js";
import { Cast } from "../../lib/iching.js";
import HexGlyph from "../HexGlyph.js";

export interface ViewNodeProps {
  id: string;
  label: string;
  machine?: string;
  showMachine?: boolean;
  state: AgentState;
  color: string;
  selected: boolean;
  pinned?: boolean;
  server?: boolean;
  tag?: string;
  awaitingCount?: number;
  /** 该球对应的会话有通知 → 显示角标 */
  notice?: boolean;
  hex?: Cast | null;
  hexOn?: boolean;
  onSelect: () => void;
  onContext: (e: React.MouseEvent) => void;
  onEnter?: () => void;
  onLeave?: () => void;
  onUnpin?: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}

/** 圆形 agent 视觉单元（用于轨道展示风格） */
function ViewNode({
  label, machine, showMachine, state, color, selected, pinned, server, tag, awaitingCount, notice, hex, hexOn,
  onSelect, onContext, onEnter, onLeave, onUnpin, innerRef,
}: ViewNodeProps) {
  return (
    <div
      ref={innerRef}
      className={`vnode vglyph s-${state} ${selected ? "sel" : ""}`}
      style={{ ["--c" as any]: color }}
      title={`${label}${machine && machine !== label ? ` · ${machine}` : ""} · ${STATE_LABELS[state]}`}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onContextMenu={onContext}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {pinned && (
        <span className="orb-pin" title="取消置顶" onClick={(e) => { e.stopPropagation(); onUnpin?.(); }}>◆</span>
      )}
      <span className="orb-body">
        {server && <span className="orb-outer" />}
        {state === "writing" && (
          <>
            <span className="orb-arc" />
            <span className="orb-p" />
            <span className="orb-p" />
            <span className="orb-p" />
          </>
        )}
        <span className="orb-core" />
        {hexOn && hex ? <HexGlyph cast={hex} /> : null}
        {state === "done" && <span className="orb-check">✓</span>}
        {tag && <span className="orb-tag">{tag}</span>}
      </span>
      {state === "awaiting" && (awaitingCount ?? 0) > 0 && <span className="orb-badge" />}
      {notice && <span className="orb-notice" title="该会话有通知">!</span>}
      <span className="vnode-label">{label}</span>
      {showMachine && machine && machine !== label && <span className="vnode-machine">{machine}</span>}
    </div>
  );
}

export default memo(ViewNode);