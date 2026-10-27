import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import ParticleField from "./ParticleField.js";
import Markdown from "./Markdown.js";

interface MsgPart { type: string; text?: string; tool?: string; state?: { status?: string; title?: string }; }
interface Msg { info: { id: string; role: string }; parts: MsgPart[]; }

const THINK_STEPS = [
  "解析意图…",
  "检索上下文…",
  "组织推理链路…",
  "调用工具…",
  "整合结果…",
];

/** 低语工作台：独立页面呈现，输入 → 思考（粒子连线特效）→ 结果卡片，不隐藏 */
export default function WhisperLab({
  targetLabel,
  sessLabel,
  nodeId,
  sessionId,
  disabled,
  onSend,
  onClose,
  onThinkingChange,
  onWheelSwitch,
  wheelCount = 5,
}: {
  targetLabel: string;
  sessLabel: string;
  nodeId: string;
  sessionId: string | null;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
  onThinkingChange?: (thinking: boolean) => void;
  onWheelSwitch?: (direction: number) => void;
  wheelCount?: number;
}) {
  const [phase, setPhase] = useState<"input" | "thinking" | "done">("input");
  const [text, setText] = useState("");
  const [stepIdx, setStepIdx] = useState(0);
  const [lastMsg, setLastMsg] = useState<Msg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const subRef = useRef<number>(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef(onWheelSwitch);
  wheelRef.current = onWheelSwitch;

  useEffect(() => { onThinkingChange?.(phase === "thinking"); }, [phase]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !wheelRef.current) return;
    const onWheel = (e: WheelEvent) => {
      if (phase === "thinking") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea") && t.scrollHeight > t.clientHeight + 4) return;
      e.preventDefault();
      wheelRef.current?.(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [phase]);

  // 思考中 → 轮询会话消息，取最新 assistant 回复作为结果
  useEffect(() => {
    if (phase !== "thinking" || !nodeId || !sessionId) return;
    setStepIdx(0);
    const stepIv = window.setInterval(() => setStepIdx((i) => (i + 1) % THINK_STEPS.length), 1300);
    let tries = 0;
    const iv = window.setInterval(async () => {
      tries++;
      try {
        const r = await apiFetch(`/api/nodes/${nodeId}/sessions/${sessionId}/messages`);
        const j = await r.json();
        const msgs: Msg[] = j.messages ?? [];
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          if (last.info.role === "assistant" && (last.parts ?? []).some((p) => p.type === "text" && p.text?.trim())) {
            subRef.current = last.info.id as any;
            setLastMsg(last);
            setPhase("done");
          }
        }
        if (tries > 20) { setPhase("done"); }
      } catch { /* keep polling */ }
    }, 1500);
    return () => { clearInterval(iv); clearInterval(stepIv); };
  }, [phase, nodeId, sessionId]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setPhase("thinking");
    setLastMsg(null);
    setErr(null);
    const ok = await onSend(t);
    if (!ok) { setPhase("input"); setText(t); setErr("发送失败"); }
    else setText("");
  };

  return (
    <div ref={rootRef} className={`wlab ${phase === "input" ? "wlab-card-big" : "wlab-card-small"}`} onClick={(e) => e.stopPropagation()}>
      {phase === "input" && (
        <>
          <button className="wlab-x" onClick={onClose} title="关闭">×</button>
          <div className="wlab-head">
            <div className="wlab-title">
              <span className="wlab-logo-orb" aria-hidden="true" />
              <span className="wlab-logo">低语</span>
              <span className="wlab-target">→ {targetLabel}</span>
              {sessLabel && <span className="wlab-sess">· {sessLabel}</span>}
            </div>
          </div>
          <div className="wlab-input-zone">
            <div className="wlab-ta-wrap">
              <span className="wlab-ta-ic" aria-hidden="true">✦</span>
              <textarea
                className="wlab-ta"
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="向它低语些什么…（回车寄出，Shift+Enter 换行）"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                  else if (e.key === "Escape") onClose();
                }}
              />
              <span className="wlab-spark s1" aria-hidden="true">✧</span>
              <span className="wlab-spark s2" aria-hidden="true">✦</span>
              <span className="wlab-spark s3" aria-hidden="true">✧</span>
            </div>
            {err && <div className="wlab-err"><span aria-hidden="true">⚠ </span>{err}</div>}
            <div className="wlab-actions">
              <span className="wlab-hint"><kbd>⏎</kbd>寄出 · <kbd>⇧⏎</kbd>换行 · 滚轮切最近 {wheelCount} 个 · <kbd>esc</kbd>关闭</span>
              <button className="wlab-send" onClick={submit} disabled={disabled || !text.trim()}>
                寄出 <span className="wlab-send-ic" aria-hidden="true">➤</span>
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "thinking" && (
        <div className="wlab-thinking">
          <div className="wlab-pulse">
            <span className="wlab-pulse-core" />
          </div>
          <div className="wlab-step">{THINK_STEPS[stepIdx]}</div>
          <div className="wlab-dots"><i /><i /><i /></div>
        </div>
      )}

      {phase === "done" && (
        <div className="wlab-result">
          <button className="wlab-x" onClick={onClose} title="关闭">×</button>
          {lastMsg ? (
            <div className="wlab-card">
              <div className="wlab-card-head">结果 · {sessLabel || targetLabel}</div>
              <div className="wlab-card-body">
                {lastMsg.parts.filter((p) => p.type === "text" && p.text?.trim()).map((p, i) => (
                  <Markdown key={i} text={p.text!} />
                ))}
                {lastMsg.parts.some((p) => p.type === "tool") && (
                  <div className="wlab-tools">
                    {lastMsg.parts.filter((p) => p.type === "tool").length} 次工具调用
                  </div>
                )}
              </div>
              <div className="wlab-card-foot">
                <button className="wlab-again" onClick={() => setPhase("input")}>再问一次</button>
                <button className="wlab-close" onClick={onClose}>完成</button>
              </div>
            </div>
          ) : (
            <div className="wlab-card">
              <div className="wlab-card-head">已寄出</div>
              <div className="wlab-card-body p-empty">指令已发送到会话，等待 agent 处理…（可在右侧详情查看对话）</div>
              <div className="wlab-card-foot"><button className="wlab-close" onClick={onClose}>完成</button></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}