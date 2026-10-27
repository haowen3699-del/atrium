import { useState, useEffect, useMemo, useRef, useCallback, CSSProperties } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  useSnapshot, stateOf as stateOfBase, sessionStateOf, allNodes, post, ago,
  STATE_COLORS, STATE_LABELS,
  AgentState, NodeView, RunAgentView, SessionView,
} from "./hooks/useSnapshot.js";
import { apiFetch, apiJson, apiPost, setKey } from "./lib/api.js";
import ViewSwitcher, { VIEWS, ViewMode } from "./components/ViewSwitcher.js";
import OrbitView from "./components/views/OrbitView.js";
import ProjectsView, { DirAvatar } from "./components/views/ProjectsView.js";
import EventStream from "./components/EventStream.js";
import NotifyPanel from "./components/NotifyPanel.js";
import Topology from "./components/Topology.js";
import Onboard from "./components/Onboard.js";
import Help from "./components/Help.js";
import { NotifyCfg, loadNotify, saveNotify, desktopNotify, chime, primeAudio } from "./lib/notify.js";
import { cast, Cast } from "./lib/iching.js";
import HexGlyph from "./components/HexGlyph.js";
import Markdown from "./components/Markdown.js";
import ChatMessage, { ChatErrorCard, ChatTyping, Msg, MsgPart } from "./components/ChatMessage.js";
import ParticleField from "./components/ParticleField.js";
import WhisperLab from "./components/WhisperLab.js";
import HostLoad from "./components/HostLoad.js";
import BallRadialMenu, { BallMenuItem } from "./components/BallRadialMenu.js";
import BallHud, { BallHudInfo } from "./components/BallHud.js";
import BallCountMenu from "./components/BallCountMenu.js";
import DirBrowser from "./components/DirBrowser.js";
import SessionDirGuard from "./components/SessionDirGuard.js";
import { HaloBadge } from "@/components/ui/halo-badge";
import { HaloButton } from "@/components/ui/halo-button";
import { HaloSegmented } from "@/components/ui/halo-segmented";
import { HaloInput } from "@/components/ui/halo-input";
import { HaloSwitch } from "@/components/ui/halo-switch";
import { RollingNumber } from "@/components/ui/rolling-number";
import { PolishedToaster, showPolishedToast } from "@/components/ui/halo-toast";
import { PromptComposer } from "@/components/ui/prompt-composer";
import "./index.css";

const STATES: AgentState[] = ["writing", "awaiting", "ready", "asleep", "done"];
const STATE_CN: Record<AgentState, string> = { writing: "书写", awaiting: "待答", ready: "就绪", asleep: "休眠", done: "完成" };

/* ===== 主题 ===== */
const THEMES: { id: string; name: string; acc: string }[] = [
  { id: "galaxy", name: "银河", acc: "#a78bfa" },
  { id: "tech", name: "科技", acc: "#4d9bff" },
  { id: "ocean", name: "深海", acc: "#58c8c8" },
  { id: "frost", name: "极地", acc: "#8bbcff" },
  { id: "ember", name: "暮火", acc: "#f0a571" },
  { id: "forest", name: "林冠", acc: "#7ed69b" },
];
const MODES: { id: "light" | "dark" | "system"; name: string; ico: string }[] = [
  { id: "light", name: "白天", ico: "☀" },
  { id: "dark", name: "黑夜", ico: "🌙" },
  { id: "system", name: "跟随系统", ico: "🖥" },
];
const CTX_CAP = 256000;

const isServer = (n: any): n is NodeView => n.kind !== "run";
const isPiRun = (n: any): boolean => (n as any).proc === "pi" || (n as any).bridge === "pi";

/* ===== agent 类型与功能能力表（用于按 agent 屏蔽不支持的 opencode 功能）===== */
type AgentKind = "opencode" | "pi" | "openclaw" | "hermes";
function agentKindOf(nd: any): AgentKind {
  if (nd.kind !== "run") return "opencode";
  const p = nd.proc ?? nd.bridge;
  if (p === "pi") return "pi";
  if (p === "openclaw") return "openclaw";
  if (p === "hermes") return "hermes";
  return "opencode"; // desktop / cc-connect 的 opencode worker
}
const AGENT_CAPS: Record<string, AgentKind[]> = {
  chat: ["opencode", "pi", "openclaw", "hermes"],
  abort: ["opencode", "pi", "openclaw", "hermes"],
  attach: ["opencode"],
  model: ["opencode"],
  new: ["opencode"],
  compact: ["opencode", "openclaw"],
  undo: ["opencode"],
  redo: ["opencode"],
  share: ["opencode"],
  unshare: ["opencode"],
  fork: ["opencode"],
  rename: ["opencode", "hermes"],
  project: ["opencode"],
  approvals: ["opencode"],
};
const capOk = (nd: any, feat: string) => AGENT_CAPS[feat]?.includes(agentKindOf(nd)) ?? false;

/** ArrayBuffer → base64（分块避免超长参数），用于附件读取 */
function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/* ===== 模型切换 ===== */
interface ModelRef { providerID: string; modelID: string; }
interface ModelsResp {
  ok: boolean;
  providers?: { id: string; name: string; models: { id: string; name: string }[] }[];
  default?: Record<string, string>;
  reason?: string;
}
const MODEL_SEL_KEY = "atrium.modelSel";
const loadModelSel = (): Record<string, ModelRef> => {
  try { const v = JSON.parse(localStorage.getItem(MODEL_SEL_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
};


/** run 进程的类型徽标 */
function tagOf(nd: any): string | undefined {
  if ((nd as any).hostId) return undefined; // 节点会话球：无标签（会话是默认形态）
  if (nd.kind !== "run") return undefined; // server 节点已有双环
  const p = nd.proc ?? nd.bridge;
  if (nd.id.startsWith("run-ccw-") || (nd.bridge === "cc-connect" && p === "opencode")) return "CC";
  switch (p) {
    case "pi": return "π";
    case "openclaw": return "OC";
    case "hermes": return "HE";
    case "desktop": return "DT";
    case "cc-connect": return "CC";
    default: return p ? String(p).slice(0, 2).toUpperCase() : "??";
  }
}
const latestSession = (nd: any) =>
  (nd.sessions ?? []).slice().sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
const sessionErrorOf = (nd: any, sessId?: string | null) => {
  const s = (nd?.sessions ?? []).find((x: any) => x.id === sessId);
  if (s?.lastError) return { msg: String(s.lastError), at: s.lastErrorAt };
  if (s?.busy) return null;
  const ev = (nd?.recentEvents ?? []).find((e: any) => e.type === "session.error" && (!sessId || !e.sessionID || e.sessionID === sessId));
  if (ev?.summary) return { msg: String(ev.summary).replace(/^error:\s*/, ""), at: ev.ts };
  return null;
};

/** 新建会话弹窗：选机器 + 选目录 + 填标题 + 颜色/标签/置顶 */
const PRESET_COLORS = ["#a78bfa", "#7dd3c0", "#fbbf24", "#f87171", "#c084fc", "#f472b6", "#6ee7a8", "#22d3ee"];
function NewSessionModal({ nodes, initialNodeId, initialDir, onClose, onCreate, onToast }: {
  nodes: NodeView[];
  initialNodeId: string | null;
  initialDir?: string;
  onClose: () => void;
  onCreate: (opts: { nodeId: string; directory: string; title: string; color?: string; tags?: string[]; pinned?: boolean }) => void;
  onToast?: (msg: string) => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [nodeId, setNodeId] = useState<string>(initialNodeId ?? nodes[0]?.id ?? "");
  const [dir, setDir] = useState(initialDir ?? "");
  const [open, setOpen] = useState(false);
  const [dirOpen, setDirOpen] = useState(false);
  const [color, setColor] = useState<string>("");
  const [tags, setTags] = useState<string>("");
  const [pinned, setPinned] = useState(false);
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);
  const [dirStat, setDirStat] = useState<{ state: "checking" | "exists" | "missing" | "unknown"; msg?: string } | null>(null);
  const node = nodes.find((n) => n.id === nodeId) ?? null;
  const dirs = node?.dirs ?? [];
  const dirFiltered = dirs.filter((d) => !dir.trim() || d.toLowerCase().includes(dir.trim().toLowerCase()));
  useEffect(() => {
    let alive = true;
    const d = dir.trim();
    if (!nodeId || !d) { setDirStat(null); return; }
    setDirStat({ state: "checking" });
    const t = window.setTimeout(async () => {
      const r = await apiJson(`/api/nodes/${encodeURIComponent(nodeId)}/fs/stat?path=${encodeURIComponent(d)}`);
      if (!alive) return;
      if (!r?.ok) setDirStat({ state: "unknown", msg: r?.error || "无法检查目录" });
      else if (r.exists && r.isDirectory) setDirStat({ state: "exists" });
      else if (r.exists) setDirStat({ state: "unknown", msg: "路径存在但不是目录" });
      else setDirStat({ state: "missing" });
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [nodeId, dir]);
  const commit = () => {
    if (!nodeId) return;
    onCreate({
      nodeId,
      directory: dir.trim(),
      title: titleRef.current?.value.trim() || "",
      color: color || undefined,
      tags: tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean),
      pinned,
    });
  };
  const NODE_STATUS_CN: Record<string, string> = { online: "在线", stale: "波动", offline: "离线" };
  const pick = (id: string) => { setNodeId(id); setDir(""); setOpen(false); };
  return (
    <div className="pj-modal-ov" onClick={onClose}>
      <div className="pj-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pj-modal-h">
          <span className="pj-modal-title">新建会话</span>
          <button className="set-back" onClick={onClose}>关闭</button>
        </div>
        <label className="pj-field">
          <span>机器（服务节点）</span>
          <div className="ns-mpick">
            <button
              type="button"
              className={`ns-mpick-btn ${open ? "open" : ""}`}
              onClick={() => setOpen((o) => !o)}
            >
              {node && (
                <>
                  <span className={`ns-mdot ${node.status}`} />
                  <span className="ns-mname">{node.label}</span>
                  {node.machine && node.machine !== node.label && <span className="ns-mmach">{node.machine}</span>}
                </>
              )}
              <span className="ns-caret">▾</span>
            </button>
            {open && (
              <div className="ns-mpick-list">
                {nodes.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`ns-mitem ${n.id === nodeId ? "on" : ""}`}
                    onClick={() => pick(n.id)}
                  >
                    <span className={`ns-mdot ${n.status}`} />
                    <span className="ns-mname">{n.label}</span>
                    {n.machine && n.machine !== n.label && <span className="ns-mmach">{n.machine}</span>}
                    <span className={`ns-mstat ${n.status}`}>{NODE_STATUS_CN[n.status] ?? n.status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </label>
        <label className="pj-field">
          <span>工作目录</span>
          <div className="ns-mpick">
            <div className="ns-dir-inputrow">
              <input
                className={`ns-dpick-input ${dirOpen ? "open" : ""}`}
                value={dir}
                onChange={(e) => { setDir(e.target.value); setDirOpen(true); }}
                onFocus={() => setDirOpen(true)}
                onBlur={() => { setTimeout(() => setDirOpen(false), 140); }}
                placeholder="输入目录路径（不存在会自动创建），或浏览选择…"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") setDirOpen(false); }}
              />
              <button
                type="button"
                className="ns-dir-browse"
                title="浏览目标机器目录：切换 / 新建 / 重命名"
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDirOpen(false); setDirBrowserOpen(true); }}
              >浏览</button>
            </div>
            {dirOpen && (
              <div className="ns-mpick-list">
                {dirFiltered.length === 0 && <div className="ns-dpick-empty">无匹配目录，可直接回车用当前输入</div>}
                {dirFiltered.map((d) => {
                  const name = d.split(/[\\/]/).filter(Boolean).pop() ?? d;
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`ns-mitem ${d === dir ? "on" : ""} ns-ditem`}
                      onMouseDown={(e) => { e.preventDefault(); setDir(d); setDirOpen(false); }}
                      title={d}
                    >
                      <span className="ns-dirname">{name}</span>
                      <span className="ns-dpath">{d}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {dirStat && (
            <div className={`ns-dir-stat ${dirStat.state}`}>
              {dirStat.state === "checking" && "正在检查目录…"}
              {dirStat.state === "exists" && "目录已存在"}
              {dirStat.state === "missing" && "目录不存在，创建会话时会自动创建"}
              {dirStat.state === "unknown" && (dirStat.msg || "无法检测目录")}
            </div>
          )}
        </label>
        <label className="pj-field">
          <span>会话标题（可选）</span>
          <input ref={titleRef} placeholder="留空则自动命名"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
        </label>
        <div className="pj-field ns-color-field">
          <span>标记颜色</span>
          <div className="ns-color-row">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`ns-color ${color === c ? "on" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(color === c ? "" : c)}
                title={c}
              />
            ))}
            {color && <button type="button" className="ns-color-clear" onClick={() => setColor("")}>✕</button>}
          </div>
        </div>
        <label className="pj-field">
          <span>标签（逗号分隔，可多个）</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="如：重要, 排查中"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
        </label>
        <label className="ns-pin-field">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          <span>创建后置顶</span>
        </label>
        <div className="pj-modal-actions">
          <button className="pj-modal-cancel" onClick={onClose}>取消</button>
          <button className="pj-modal-ok" onClick={commit}>创建</button>
        </div>
      </div>
      {dirBrowserOpen && nodeId && (
        <DirBrowser
          nodeId={nodeId}
          initialPath={dir.trim()}
          onClose={() => setDirBrowserOpen(false)}
          onPick={(p) => { setDir(p); setDirBrowserOpen(false); }}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/* ===== 灵动球视觉（球心 + 光环 + 涟漪 + 环绕粒子，复用于右下角与聊天窗） ===== */
function FloatBallViz({ busy }: { busy?: boolean }) {
  return (
    <>
      <span className="float-ball-halo" />
      <span className="float-ball-halo2" />
      <span className="float-ripple r1" />
      <span className="float-ripple r2" />
      <span className="float-orbit o1" />
      <span className="float-orbit o2" />
      <span className="float-orbit o3" />
      <span className="float-particle p1" />
      <span className="float-particle p2" />
      <span className="float-particle p3" />
      <span className="float-particle p4" />
      <span className="float-particle p5" />
      <span className="float-particle p6" />
      <span className="float-particle p7" />
      <span className="float-particle p8" />
      <span className="float-particle p9" />
      <span className="float-ball-ring" />
      <span className="float-ball-ring2" />
      <span className="float-ball-dot" />
      <span className="float-ball-spark">✦</span>
      {busy && <span className="float-ball-live">●</span>}
    </>
  );
}

/* ===== 聊天视图：拉取并渲染一个会话的完整对话（opencode 风格） ===== */
type ChatStatus = { busy: boolean; stuck: boolean; stuckTool: string; stuckMin: number };
function ChatView({ nodeId, sessionId, busy, pendingUser, lastError, lastErrorAt, onLoadingChange, onStatusChange, onResend }: { nodeId: string; sessionId: string; busy: boolean; pendingUser?: string | null; lastError?: string; lastErrorAt?: number; onLoadingChange?: (v: boolean) => void; onStatusChange?: (s: ChatStatus) => void; onResend?: (text: string) => void }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const lastKeyRef = useRef<string>("");
  /** 回到底部按钮：滚离底部超过阈值时显示 */
  const [showJump, setShowJump] = useState(false);
  const jumpingRef = useRef(false);
  /** 程序化贴底滚动标记：自身滚动不改写吸底状态，避免 scroll anchoring/布局触发的 scroll 事件把吸底打掉 */
  const progScrollRef = useRef(false);
  /** 上次观察到的 scrollTop：只有真正向上移动才判定用户主动上滚 */
  const lastTopRef = useRef(0);
  const applyStick = () => {
    const el = boxRef.current;
    if (!el || !stickBottom.current) return;
    progScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    el.dataset.stick = "1";
    requestAnimationFrame(() => { progScrollRef.current = false; });
  };

  useEffect(() => {
    const key = `${nodeId}:${sessionId}`;
    const switched = lastKeyRef.current !== key;
    lastKeyRef.current = key;

    let stop = false;
    let timer: number | null = null;
    if (switched) {
      setMsgs(null);
      setErr(null);
      onLoadingChange?.(true);
    }
    const schedule = (delayMs: number) => {
      if (stop || delayMs <= 0) return;
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(load, delayMs);
    };
    const load = async () => {
      try {
        const r = await apiFetch(`/api/nodes/${nodeId}/sessions/${sessionId}/messages`);
        const j = await r.json();
        if (stop) return;
        setRetrying(false);
        if (j.ok || j.messages !== undefined) {
          setMsgs(j.messages ?? []);
          setErr(null);
          onLoadingChange?.(false);
          if (busy) schedule(3000);
        } else {
          setErr(j.reason ?? "对话加载失败");
          onLoadingChange?.(false);
          schedule(500);
        }
      } catch (e) {
        if (stop) return;
        setRetrying(false);
        setErr(`请求失败：${(e as Error).message}`);
        onLoadingChange?.(false);
        schedule(500);
      }
    };
    load();
    return () => { stop = true; if (timer) clearTimeout(timer); onLoadingChange?.(false); };
  }, [nodeId, sessionId, busy, onLoadingChange, retryTick]);

  const lastStatRef = useRef<string>("");
  useEffect(() => {
    if (!onStatusChange) return;
    let st: ChatStatus = { busy, stuck: false, stuckTool: "", stuckMin: 0 };
    if (msgs) {
      const lastAsst = [...msgs].reverse().find((m) => m.info?.role === "assistant");
      const rt = lastAsst ? (lastAsst.parts ?? []).find((p) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending")) : null;
      const runStart = rt ? Number(rt.state?.time?.start ?? rt.state?.time?.created ?? 0) : 0;
      const sMin = rt && !lastAsst?.info?.time?.completed && runStart ? Math.floor((Date.now() - runStart) / 60000) : 0;
      st = { busy, stuck: sMin >= 3, stuckTool: rt?.tool ?? "tool", stuckMin: sMin };
    }
    const sig = `${st.busy}|${st.stuck}|${st.stuckTool}|${st.stuckMin}`;
    if (sig === lastStatRef.current) return;
    lastStatRef.current = sig;
    onStatusChange(st);
  }, [msgs, busy, onStatusChange]);

  const chatRoRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    applyStick();
    // 内容流/容器尺寸变化（新消息、流式输出、输入框长高挤压）都保持吸底
    const el = boxRef.current;
    if (el && !chatRoRef.current && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => applyStick());
      const flow = el.querySelector(".chat-flow");
      if (flow) ro.observe(flow);
      ro.observe(el);
      chatRoRef.current = ro;
    }
  }, [msgs?.length, msgs?.[msgs.length - 1]?.parts?.length, lastErrorAt]);

  const lastId = msgs && msgs.length ? msgs[msgs.length - 1].info.id : null;
  /** 最后一条用户消息文本：失败后一键重发用 */
  const lastUserText = useMemo(() => {
    if (!msgs) return "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.info?.role === "user") {
        const t = (m.parts ?? []).filter((p: MsgPart) => p.type === "text").map((p: MsgPart) => (p as any).text ?? "").join("\n").trim();
        if (t) return t;
      }
    }
    return "";
  }, [msgs]);

  /** 会话异常结束检测：消息级错误（info.error）或最后一条用户消息长时间无回复 */
  const [abnormal, setAbnormal] = useState<{ kind: "error" | "no-reply"; msg: string } | null>(null);
  useEffect(() => {
    if (!msgs || busy) { setAbnormal(null); return; }
    const lastAsst = [...msgs].reverse().find((m) => m.info?.role === "assistant");
    const e: any = (lastAsst?.info as any)?.error;
    if (e) {
      const msg = typeof e === "string" ? e : (e?.data?.message || e?.message || e?.name || "");
      setAbnormal({ kind: "error", msg: String(msg || "未知错误").slice(0, 400) });
      return;
    }
    setAbnormal(null);
    const last = msgs[msgs.length - 1];
    if (last?.info?.role === "user" && !pendingUser) {
      const created = Number(last.info?.time?.created ?? 0);
      const wait = created ? Math.max(0, 12000 - (Date.now() - created)) : 12000;
      const timer = window.setTimeout(() => {
        setAbnormal({ kind: "no-reply", msg: "发出后没有产生任何回复，执行可能被中断（服务重启 / 请求被中止 / 上游异常）。" });
      }, wait);
      return () => window.clearTimeout(timer);
    }
  }, [msgs, busy, pendingUser]);

  if (err) {
    return (
      <div className="p-empty">
        <div className="p-err-title"><span className="retry-ic">⟳</span> 对话加载失败</div>
        <div className="p-err-reason">{err}</div>
        <button
          className="p-err-retry"
          disabled={retrying}
          onClick={() => { setRetrying(true); setRetryTick((t) => t + 1); }}
        >
          <span className={`retry-ic ${retrying ? "spinning" : ""}`} aria-hidden><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9" opacity="0.25" /><path d="M21 12a9 9 0 0 0-9-9" /></svg></span> {retrying ? "重试中…" : "立即重试"}
        </button>
        <div className="p-err-hint">每 0.5 秒自动重试，节点恢复后会自己加载出来…</div>
      </div>
    );
  }
  if (msgs === null) return <div className="chat-loading"><span className="chat-loading-dot" />加载对话…</div>;

  const shown = msgs.slice(-120);
  const pending = pendingUser ? pendingUser.trim() : "";
  const pendingShown = pending && !msgs.some((m) => m.info?.role === "user" && (m.parts ?? []).some((p) => p.type === "text" && (p.text ?? "").trim() === pending));
  return (
    <div className="chat-wrap">
      <div
        className="chat"
        ref={boxRef}
        onWheel={(e) => {
          // 滚轮向上 = 用户主动查阅历史 → 关闭吸底
          if (e.deltaY < 0) stickBottom.current = false;
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const st = el.scrollTop;
          const dist = el.scrollHeight - st - el.clientHeight;
          const prevTop = lastTopRef.current;
          lastTopRef.current = st;
          el.dataset.stick = stickBottom.current ? "1" : "0";
          if (progScrollRef.current) {
            // 程序化/平滑回底进行中：不改写吸底标记；真正到底后解除豁免
            if (dist < 4) { progScrollRef.current = false; jumpingRef.current = false; }
            setShowJump(false);
            return;
          }
          // 只有真正向上移动（滚轮/滚动条/键盘）才关闭吸底；内容增长导致 dist 变大不影响
          if (st < prevTop - 24) stickBottom.current = false;
          if (dist < 120) stickBottom.current = true;
          jumpingRef.current = false;
          el.dataset.stick = stickBottom.current ? "1" : "0";
          setShowJump(dist > 320 && !stickBottom.current);
        }}
      >
        <div className="chat-flow">
          {shown.length === 0 && !pendingShown && <div className="p-empty">暂无消息</div>}
          {shown.map((m) => <ChatMessage key={m.info.id} msg={m} />)}
          {pendingShown && <ChatMessage msg={{ info: { id: "pending", role: "user" }, parts: [{ type: "text", text: pending }] }} />}
          {lastError && !busy && (
            <div className="chat-error-wrap">
              <ChatErrorCard msg={lastError} at={lastErrorAt} />
              {lastUserText && onResend && (
                <button
                  className="chat-resend"
                  title="执行失败后，把最后一次发出的内容原样重发"
                  onClick={() => onResend(lastUserText)}
                >
                  <span aria-hidden>↻</span> 重发最后一条
                </button>
              )}
            </div>
          )}
          {busy && <ChatTyping />}
          {!busy && shown.length > 0 && <div className="chat-end" />}
          {abnormal && !busy && !(lastError && abnormal.kind === "error") && (
            <div className="chat-abnormal">
              <div className="chat-abnormal-h"><span className="chat-abnormal-ic">⚠</span> 会话异常结束</div>
              <div className="chat-abnormal-msg">{abnormal.msg}</div>
              <div className="chat-abnormal-hint">排查：查看该机器的服务端日志（atrium / opencode），或直接重发上次内容。</div>
              <div className="chat-abnormal-btns">
                {lastUserText && onResend && (
                  <button className="chat-resend" onClick={() => onResend(lastUserText)}><span aria-hidden>↻</span> 重发最后一条</button>
                )}
                <button
                  className="chat-abnormal-copy"
                  onClick={() => {
                    const diag = `节点: ${nodeId}\n会话: ${sessionId}\n异常: ${abnormal.msg}\n最后发送: ${lastUserText.slice(0, 500)}`;
                    void navigator.clipboard?.writeText(diag).catch(() => {});
                  }}
                >复制诊断信息</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          className="chat-jump"
          title="回到最新消息"
          onClick={() => {
            const el = boxRef.current;
            if (!el) return;
            jumpingRef.current = true;
            stickBottom.current = true;
            progScrollRef.current = true;
            const far = el.scrollHeight - el.scrollTop - el.clientHeight > 20000;
            el.scrollTo({ top: el.scrollHeight, behavior: far ? "auto" : "smooth" });
            // 保险：若滚动结束事件没到（长距离平滑），最多 6s 后强制解除
            window.setTimeout(() => { progScrollRef.current = false; }, 6000);
            setShowJump(false);
          }}
        >↓</button>
      )}
    </div>
  );
}

function PendingCards({ nodeId, permissions, questions, onToast, onIgnore, title = "待你处理 · pending" }: {
  nodeId: string;
  permissions: any[];
  questions: any[];
  onToast: (msg: string) => void;
  onIgnore: (qid: string) => void;
  title?: string;
}) {
  const [qSel, setQSel] = useState<Record<string, string[]>>({});
  const [qText, setQText] = useState<Record<string, string>>({});
  // 乐观反馈：点击后立即把卡片置为「处理中」，异步落库；成功则等快照移除卡片，失败再还原
  const [acting, setActing] = useState<Record<string, string>>({});
  if (!permissions.length && !questions.length) return null;

  const beginAct = (id: string, label: string) => setActing((a) => ({ ...a, [id]: label }));
  const endAct = (id: string) => setActing((a) => { if (!(id in a)) return a; const n = { ...a }; delete n[id]; return n; });

  const replyPerm = async (pid: string, response: "once" | "always" | "reject") => {
    if (acting[pid]) return;
    beginAct(pid, response === "reject" ? "拒绝中" : "允许中");
    const r: any = await post(`/api/nodes/${nodeId}/permissions/${pid}/reply`, { response });
    if (r?.ok) onToast(response === "reject" ? "已拒绝" : response === "always" ? "已始终允许" : "已允许一次");
    else { endAct(pid); onToast(r?.error ?? "操作失败"); }
  };
  const replyQuestion = async (qid: string, answers: string[][]) => {
    if (acting[qid]) return;
    beginAct(qid, "提交中");
    const r: any = await post(`/api/nodes/${nodeId}/questions/${qid}/reply`, { answers });
    if (r?.ok) {
      onToast("已回答");
      setQSel((s) => {
        const n = { ...s };
        for (const k of Object.keys(n)) if (k.startsWith(qid + ":")) delete n[k];
        return n;
      });
      setQText((s) => {
        const n = { ...s };
        for (const k of Object.keys(n)) if (k.startsWith(qid + ":")) delete n[k];
        return n;
      });
    } else {
      endAct(qid);
      onToast(r?.error ?? "操作失败");
    }
  };
  const rejectQuestion = async (qid: string) => {
    if (acting[qid]) return;
    beginAct(qid, "忽略中");
    const r: any = await post(`/api/nodes/${nodeId}/questions/${qid}/reject`, {});
    if (r?.ok) { onToast("已忽略（已让 agent 继续）"); endAct(qid); onIgnore(qid); }
    else { endAct(qid); onToast(r?.error ?? "忽略失败（该节点可能不支持）"); }
  };


  return (
    <div className="chat-pending">
      <div className="p-stream-title">{title}</div>
      {permissions.map((p: any) => (
        <div key={p.id} className={`await-card ${acting[p.id] ? "acting" : ""}`}>
          <div className="await-kind">授权请求</div>
          <div className="await-title">{p.permission}</div>
          {(p.patterns ?? []).length > 0 && (
            <div className="await-pats">
              {(p.patterns ?? []).slice(0, 4).map((pat: string) => (
                <code key={pat} className="await-pat">{pat}</code>
              ))}
            </div>
          )}
          <div className="await-btns">
            {acting[p.id] ? (
              <span className="await-acting"><span className="await-spin" />{acting[p.id]}…</span>
            ) : (
              <>
                <button className="await-btn ok" onClick={() => replyPerm(p.id, "once")}>允许一次</button>
                <button className="await-btn" onClick={() => replyPerm(p.id, "always")}>始终允许</button>
                <button className="await-btn danger" onClick={() => replyPerm(p.id, "reject")}>拒绝</button>
              </>
            )}
          </div>
        </div>
      ))}
      {questions.map((q: any) => {
        const qs: any[] = q.questions ?? [];
        // 每个问题：选项 + 自定义文本都可作为答案（有文本就带上）
        const answerOf = (qi: number): string[] => {
          const key = `${q.id}:${qi}`;
          const sel = qSel[key] ?? [];
          const text = (qText[key] ?? "").trim();
          return text ? [...new Set([...sel, text])] : sel;
        };
        const answered = qs.map((_, qi) => answerOf(qi));
        const allAnswered = qs.length > 0 && answered.every((a) => a.length > 0);
        const act = acting[q.id];
        return (
          <div key={q.id} className={`await-card ${act ? "acting" : ""}`}>
            <div className="await-kind">等待回答</div>
            {qs.map((qq: any, qi: number) => {
              const key = `${q.id}:${qi}`;
              const sel = qSel[key] ?? [];
              const opts: any[] = qq.options ?? [];
              return (
                <div key={key} className="await-q">
                  <div className="await-title">{qq.header ? `${qq.header} · ` : ""}{qq.question}</div>
                  {opts.length > 0 && (
                    <div className="q-opts">
                      {opts.map((o: any) => {
                        const on = sel.includes(o.label);
                        return (
                          <button
                            key={o.label}
                            className={`q-opt ${on ? "on" : ""}`}
                            title={o.description ?? ""}
                            disabled={!!act}
                            onClick={() => {
                              setQSel((s) => {
                                const cur = s[key] ?? [];
                                const next = qq.multiple
                                  ? (on ? cur.filter((x: string) => x !== o.label) : [...cur, o.label])
                                  : [o.label];
                                return { ...s, [key]: next };
                              });
                            }}
                          >{o.label}</button>
                        );
                      })}
                    </div>
                  )}
                  <input
                    className="q-free"
                    placeholder={opts.length ? "或输入自定义答案…" : "输入回答…"}
                    value={qText[key] ?? ""}
                    disabled={!!act}
                    onChange={(e) => setQText((s) => ({ ...s, [key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter" && allAnswered && !act) replyQuestion(q.id, answered); }}
                  />
                </div>
              );
            })}
            <div className="await-btns">
              {act ? (
                <span className="await-acting"><span className="await-spin" />{act}…</span>
              ) : (
                <>
                  <button
                    className="await-btn ok"
                    disabled={!allAnswered}
                    onClick={() => replyQuestion(q.id, answered)}
                  >提交回答</button>
                  <button className="await-btn" onClick={() => rejectQuestion(q.id)} title="不回答，让 agent 继续（忽略该提问）">忽略</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 团队管理：定义团队（成员=机器/进程 + 组长），并把任务按规则派给最空闲的成员 */
function jobClass(s: string) { return s === "done" ? "ok" : s === "partial" ? "warn" : (s === "failed" || s === "timeout" || s === "no-members" || s === "leader-send-failed") ? "fail" : "run"; }
function jobText(j: any) {
  if (!j) return "";
  const A = j.assigns ?? [];
  switch (j.status) {
    case "leader-working": return `已派给组长（${j.leader}），等它出计划…`;
    case "dispatching": return `进行中 · 已派 ${A.filter((a: any) => a.status !== "queued").length}/${A.length}`;
    case "done": return j.summary ?? "已完成";
    case "partial": return j.summary ?? "部分完成";
    case "failed": return j.summary ?? "全部失败";
    case "timeout": return "组长 10 分钟内没给出计划";
    case "no-members": return "没有可派发的在线成员";
    case "leader-send-failed": return "派给组长失败";
    default: return String(j.status);
  }
}
const mkeyOf = (m: any) => `${m?.node ?? ""}\u0000${m?.dir ?? ""}`;
const baseNameOf = (d: string) => (d || "").split(/[\\/]/).filter(Boolean).pop() || d;

/** 从组长消息里抽 ```team-plan [...]``` 计划块 → 渲染成"任务分配"清单；并剔除 atrium 追加的内部指令 */
const TEAM_PLAN_RE = /```team-plan\s*([\s\S]*?)```/;
function teamPlanOf(text: string): { plan: string[]; rest: string } | null {
  const m = TEAM_PLAN_RE.exec(text);
  if (!m) return null;
  let plan: string[] = [];
  try { const a = JSON.parse(m[1]); if (Array.isArray(a)) plan = a.map(String); } catch { /* ignore */ }
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { plan, rest };
}
const stripLeaderInstr = (t: string) => { const i = t.indexOf("[组长指令]"); return (i >= 0 ? t.slice(0, i) : t).trim(); };

/** 团队聊天窗：把「组长会话 + 各子任务会话」合并成一条时间线——
 *  能看见你和组长、组长派给组员、组员干活之间的全部对话；底部是「给组长派活」输入。 */
interface TeamAttach { id: string; name: string; mime: string; data: string; }
interface TeamSessRef { key: string; node: string; sessionId: string; who: string; kind: "leader" | "member"; dir?: string; }

function TeamChat({ id, team, nodes, jobs, onDispatch, onToast, ignoredPending, onIgnorePending, ballDragRef }: {
  id: string;
  team: any;
  nodes: any[];
  jobs: any[];
  onDispatch: (teamId: string, members: any[], leader: any, task: string, opts?: any) => Promise<boolean>;
  onToast: (msg: string) => void;
  ignoredPending: Set<string>;
  onIgnorePending: (qid: string) => void;
  ballDragRef?: React.MutableRefObject<boolean>;
}) {
  const [events, setEvents] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [boost, setBoost] = useState(0);
  const [task, setTask] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ text: string; parts: MsgPart[] } | null>(null);
  const [attachFiles, setAttachFiles] = useState<TeamAttach[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const jumpingRef = useRef(false);
  const tchatProgRef = useRef(false);
  const tchatLastTopRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const tchatStick = () => {
    const el = boxRef.current;
    if (!el || !stickBottom.current) return;
    tchatProgRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { tchatProgRef.current = false; });
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stickBottom = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const leader = team?.leader ?? null;
  const leaderNode = nodes.find((n) => n.id === leader?.node) ?? null;
  const canAttach = Boolean(leaderNode && capOk(leaderNode, "attach"));
  const sessRefs = useMemo<TeamSessRef[]>(() => {
    const out: TeamSessRef[] = [];
    const seen = new Set<string>();
    const add = (node?: string, sessionId?: string, who = "", kind: "leader" | "member" = "member", dir?: string) => {
      if (!node || !sessionId) return;
      const key = `${node}::${sessionId}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ key, node, sessionId, who, kind, dir });
    };
    for (const j of jobs.filter((x: any) => x.teamId === id)) {
      add(j.leaderNode, j.leaderSession, "组长", "leader", j.leaderDir);
      for (const a of j.assigns ?? []) add(a.node, a.sessionId, a.dir ? `组员·${baseNameOf(a.dir)}` : "组员", "member", a.dir);
    }
    return out;
  }, [jobs, id]);
  const busyRefs = sessRefs.filter((ref) => (nodes.find((n) => n.id === ref.node)?.sessions ?? []).some((s: any) => s.id === ref.sessionId && s.busy));
  const jobRunning = jobs.some((j: any) => j.teamId === id && ["leader-working", "dispatching"].includes(j.status));
  const running = busyRefs.length > 0 || jobRunning;
  const pendingGroups = useMemo(() => {
    const out: { key: string; nodeId: string; permissions: any[]; questions: any[]; title: string }[] = [];
    for (const ref of sessRefs) {
      const nd = nodes.find((n) => n.id === ref.node);
      if (!nd) continue;
      const permissions = (nd.pendingPermissions ?? []).filter((p: any) => p.sessionID === ref.sessionId);
      const questions = (nd.pendingQuestions ?? []).filter((q: any) => q.sessionID === ref.sessionId && !ignoredPending.has(q.id));
      if (permissions.length || questions.length) out.push({ key: ref.key, nodeId: ref.node, permissions, questions, title: `${ref.who} · 待你处理` });
    }
    return out;
  }, [sessRefs, nodes, ignoredPending]);
  const errorCards = useMemo(() => {
    const out: { key: string; sender: string; msg: string; at?: number }[] = [];
    for (const ref of sessRefs) {
      const nd = nodes.find((n) => n.id === ref.node);
      if (!nd) continue;
      const s = (nd.sessions ?? []).find((x: any) => x.id === ref.sessionId);
      if (s?.busy) continue;
      const e = sessionErrorOf(nd, ref.sessionId);
      if (e) out.push({ key: `${ref.key}:err`, sender: ref.who, msg: e.msg, at: e.at });
    }
    return out;
  }, [sessRefs, nodes]);
  const attachReady = attachFiles.every((f) => f.data);
  const attachParts = attachFiles.filter((f) => f.data).map((f) => ({ type: "file", mime: f.mime, filename: f.name, url: `data:${f.mime};base64,${f.data}` }));
  const canSend = !sending && Boolean(task.trim()) && attachReady && Boolean(leader);

  useEffect(() => {
    if (!boost) return;
    const t = window.setTimeout(() => setBoost(0), 30000);
    return () => clearTimeout(t);
  }, [boost]);

  useEffect(() => {
    let stop = false;
    let timer: number | null = null;
    const schedule = (delayMs: number) => {
      if (stop || delayMs <= 0) return;
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(load, delayMs);
    };
    const load = async () => {
      try {
        const r = await apiFetch(`/api/teams/${encodeURIComponent(id)}/timeline?limit=400`);
        const j = await r.json();
        if (stop) return;
        setRetrying(false);
        if (j?.ok) {
          setEvents(j.events ?? []);
          setErr(null);
          if (running || boost) schedule(3000);
        } else {
          setErr(j?.error ?? "团队对话加载失败");
          schedule(500);
        }
      } catch (e) {
        if (stop) return;
        setRetrying(false);
        setErr(`请求失败：${(e as Error).message}`);
        schedule(500);
      }
    };
    load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [id, running, boost, refreshTick, retryTick]);

  useEffect(() => {
    const p = pendingRef.current;
    if (!p || !events) return;
    const found = events.some((e: any) => e.role === "user" && e.kind === "leader" && (e.parts ?? []).some((part: any) => part.type === "text" && stripLeaderInstr(part.text ?? "").trim() === p.text.trim()));
    if (found) setPending(null);
  }, [events]);

  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => setPending(null), 20000);
    return () => clearTimeout(t);
  }, [pending]);

  const tchatRoRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    tchatStick();
    const el = boxRef.current;
    if (el && !tchatRoRef.current && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => tchatStick());
      const flow = el.querySelector(".chat-flow");
      if (flow) ro.observe(flow);
      ro.observe(el);
      tchatRoRef.current = ro;
    }
  }, [events?.length, events?.[events.length - 1]?.parts?.length, pending, errorCards.length, running]);

  const pickFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    const list = Array.from(files);
    const items = list.map((f) => ({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: f.name || "文件", mime: f.type || "application/octet-stream", data: "" }));
    setAttachFiles((prev) => [...prev, ...items]);
    list.forEach((f, i) => {
      const it = items[i];
      f.arrayBuffer()
        .then((buf) => { const data = abToBase64(buf); setAttachFiles((prev) => prev.map((x) => (x.id === it.id ? { ...x, data } : x))); })
        .catch((e: any) => {
          setAttachFiles((prev) => prev.filter((x) => x.id !== it.id));
          onToast(`读取失败：${it.name} —— ${(e?.name || "") + (e?.message ? " · " + e.message : "") || "未知错误"}`);
        });
    });
  };

  const send = async () => {
    const t = task.trim();
    if (!t || sending || !attachReady || !leader) return;
    setSending(true);
    const parts = attachParts;
    const ok = await onDispatch(id, team?.members ?? [], leader, t, {
      policy: team?.policy ?? "idle",
      includeLeader: team?.includeLeader !== false,
      concurrency: team?.concurrency ?? 0,
      parts: parts.length ? parts : undefined,
    });
    setSending(false);
    if (!ok) return;
    setPending({ text: t, parts });
    setTask("");
    setAttachFiles([]);
    setBoost(Date.now());
    setRefreshTick((x) => x + 1);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.focus();
    }
  };

  const abortAll = async () => {
    if (!busyRefs.length) {
      onToast("没有进行中的团队会话");
      return;
    }
    await Promise.all(busyRefs.map((ref) => post(`/api/nodes/${encodeURIComponent(ref.node)}/sessions/${encodeURIComponent(ref.sessionId)}/abort`, {})));
    onToast("已中止团队会话");
    setBoost(Date.now());
    setRefreshTick((x) => x + 1);
  };

  const eventText = (e: any) => (e.parts ?? []).filter((p: any) => p.type === "text" && p.text).map((p: any) => p.text).join("\n").trim();
  const isLeaderRelay = (e: any) => e.kind === "leader" && e.role === "user" && /^\[(组员提问|组员请求授权|验收)\]/.test(eventText(e));
  const roleOf = (e: any) => (isLeaderRelay(e) ? "system" : e.role);
  const senderOf = (e: any) => {
    if (e.kind === "leader") {
      if (e.role === "user") return isLeaderRelay(e) ? "系统 → 组长" : "你";
      return "组长";
    }
    return e.role === "user" ? `组长 → ${String(e.who ?? "").replace(/^组员·/, "")}` : e.who;
  };
  const kindOf = (e: any) => {
    if (isLeaderRelay(e)) return "relay";
    return `${e.kind}${e.role === "user" && e.kind !== "leader" ? " assign" : ""}`;
  };
  const renderTeamText = (e: any) => (text: string, role: string) => {
    let txt = text;
    if (e.kind === "leader" && role === "user") txt = stripLeaderInstr(txt);
    if (e.kind === "leader" && role !== "user" && role !== "system") {
      const pl = teamPlanOf(txt);
      if (pl) {
        return (
          <>
            {pl.rest ? <Markdown text={pl.rest} /> : null}
            {pl.plan.length ? (
              <div className="tchat-plan">
                <div className="tchat-plan-h">任务分配 · 一起下发给 {pl.plan.length} 项</div>
                <ol>{pl.plan.map((s, j) => <li key={j}>{s}</li>)}</ol>
              </div>
            ) : null}
          </>
        );
      }
    }
    return <Markdown text={txt} />;
  };
  const shown = (events ?? []).slice(-160);

  return (
    <div
      className="tchat"
      onDragOver={(e) => {
        if (ballDragRef?.current) return;
        if (!canAttach || !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => { if (!e.relatedTarget) setDragOver(false); }}
      onDrop={(e) => {
        if (ballDragRef?.current) return;
        if (!canAttach) return;
        e.preventDefault();
        setDragOver(false);
        const files = e.dataTransfer?.files ?? null;
        if (files && files.length) {
          pickFiles(files);
          onToast(`已添加 ${files.length} 个附件`);
        }
      }}
    >
      {dragOver && canAttach && <div className="drop-overlay"><div className="drop-inner">松开以添加附件</div></div>}
      <div className="chat-wrap">
        <div
          className="chat tchat-body"
          ref={boxRef}
          onWheel={(e) => { if (e.deltaY < 0) stickBottom.current = false; }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const st = el.scrollTop;
            const dist = el.scrollHeight - st - el.clientHeight;
            const prevTop = tchatLastTopRef.current;
            tchatLastTopRef.current = st;
            if (tchatProgRef.current) {
              if (dist < 4) tchatProgRef.current = false;
              return;
            }
            if (st < prevTop - 24) stickBottom.current = false;
            if (dist < 120) stickBottom.current = true;
            jumpingRef.current = false;
            setShowJump(dist > 320 && !stickBottom.current);
          }}
        >
        <div className="chat-flow">
        {err ? (
          <div className="p-empty">
            <div className="p-err-title"><span className="retry-ic">⟳</span> 团队对话加载失败</div>
            <div className="p-err-reason">{err}</div>
            <button className="p-err-retry" disabled={retrying} onClick={() => { setRetrying(true); setRetryTick((t) => t + 1); }}>
              <span className={`retry-ic ${retrying ? "spinning" : ""}`} aria-hidden><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9" opacity="0.25" /><path d="M21 12a9 9 0 0 0-9-9" /></svg></span> {retrying ? "重试中…" : "立即重试"}
            </button>
            <div className="p-err-hint">每 0.5 秒自动重试，节点恢复后会自己加载出来…</div>
          </div>
        ) : events === null ? (
          <div className="chat-loading"><span className="chat-loading-dot" />加载团队对话…</div>
        ) : (
          <>
            {events.length === 0 && !pending && <div className="p-empty">还没有对话——在下面发个任务，组长会在群里拆解并「一起派」给组员。</div>}
            {shown.map((e: any) => (
              <ChatMessage
                key={e.id}
                msg={{ info: { id: e.id, role: roleOf(e), time: { created: e.at } }, parts: e.parts ?? [] }}
                sender={senderOf(e)}
                senderKind={kindOf(e)}
                renderText={renderTeamText(e)}
              />
            ))}
            {pending && (
              <ChatMessage
                msg={{ info: { id: "team-pending", role: "user" }, parts: [...pending.parts, { type: "text", text: pending.text }] }}
                sender="你"
                senderKind="leader"
              />
            )}
            {errorCards.map((e) => <ChatErrorCard key={e.key} msg={e.msg} at={e.at} sender={e.sender} />)}
            {running && <ChatTyping sender="团队进行中" />}
            {!running && shown.length > 0 && <div className="chat-end" />}
          </>
        )}
        </div>
        </div>
        {showJump && (
          <button
            className="chat-jump"
            title="回到最新消息"
            onClick={() => {
              const el = boxRef.current;
              if (!el) return;
              jumpingRef.current = true;
              stickBottom.current = true;
              tchatProgRef.current = true;
              const far = el.scrollHeight - el.scrollTop - el.clientHeight > 20000;
              el.scrollTo({ top: el.scrollHeight, behavior: far ? "auto" : "smooth" });
              window.setTimeout(() => { tchatProgRef.current = false; }, 6000);
              setShowJump(false);
            }}
          >↓</button>
        )}
      </div>
      {pendingGroups.map((g) => (
        <PendingCards
          key={g.key}
          nodeId={g.nodeId}
          permissions={g.permissions}
          questions={g.questions}
          onToast={onToast}
          onIgnore={onIgnorePending}
          title={g.title}
        />
      ))}
      <div className="p-steer-wrap">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }}
        />
        {attachFiles.length > 0 && (
          <div className="attach-preview">
            {attachFiles.map((f) => (
              <span key={f.id} className="attach-chip" title={f.name}>
                <span className="attach-icon">{f.mime.startsWith("image/") ? "🖼" : "📄"}</span>
                <span className="attach-name">{f.name.length > 24 ? f.name.slice(0, 24) + "…" : f.name}</span>
                <button className="attach-x" onClick={() => setAttachFiles((prev) => prev.filter((x) => x.id !== f.id))}>×</button>
              </span>
            ))}
          </div>
        )}
        <PromptComposer
          ref={inputRef}
          className="max-w-none"
          compact
          submitOnEnter
          busy={running}
          isLoading={sending}
          loadingText="派单中…"
          onStop={() => void abortAll()}
          value={task}
          placeholder={leader ? "在群里给组长发任务…（Enter 发送，Shift+Enter 换行）" : "请先在团队设置里指定组长…"}
          disabled={sending || !leader}
          showAttach={canAttach}
          onAttach={() => fileInputRef.current?.click()}
          onSend={() => void send()}
          onChange={(e) => setTask(e.currentTarget.value)}
        />
      </div>
    </div>
  );
}


function TeamsView({ teams, memberOptions, nodes, jobs, onSave, onRemove, onOpenTeam, onToast }: {
  teams: Record<string, any>;
  memberOptions: { node: string; dir: string; label: string; busy: number }[];
  nodes: any[];
  jobs: any[];
  onSave: (t: { id?: string; name: string; members: any[]; leader: any; policy?: string; includeLeader?: boolean; concurrency?: number }) => void;
  onRemove: (id: string) => void;
  onOpenTeam: (id: string) => void;
  onToast: (m: string) => void;
}) {
  const [edit, setEdit] = useState<{ id?: string; name: string; members: any[]; leader: any; policy?: string; includeLeader?: boolean; concurrency?: number } | null>(null);
  const [cNode, setCNode] = useState("");
  const [cDir, setCDir] = useState("");
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);
  const [dirBusy, setDirBusy] = useState<"init" | "">("");
  const list = Object.entries(teams);
  const mkey = (m: any) => `${m?.node ?? ""}\u0000${m?.dir ?? ""}`;
  const memberLabel = (m: any) => (m ? (memberOptions.find((o) => o.node === m.node && o.dir === m.dir)?.label ?? `${m.node} · ${m.dir}`) : "—");
  const nodeName = (node: string) => { const o = memberOptions.find((x) => x.node === node); return o ? o.label.split(" · ")[0] : node; };
  const baseName = (d: string) => (d || "").split(/[\\/]/).filter(Boolean).pop() || d;
  const groupByNode = (ms: any[]) => { const g: Record<string, any[]> = {}; for (const m of ms) (g[m.node] ??= []).push(m); return g; };
  const teamActiveJobs = (teamId: string) => jobs.filter((j: any) => j.teamId === teamId && ["leader-working", "dispatching"].includes(j.status));
  const memberBusy = (m: any, teamId?: string) => {
    const nd = nodes.find((n) => n.id === m?.node);
    if (((nd?.sessions ?? []) as any[]).some((s) => s.directory === m?.dir && s.busy)) return true;
    if (!teamId) return false;
    return teamActiveJobs(teamId).some((j: any) =>
      (j.leaderNode === m.node && j.leaderDir === m.dir) ||
      (j.assigns ?? []).some((a: any) => a.status === "running" && a.node === m.node && a.dir === m.dir)
    );
  };
  const teamWorking = (teamId: string, ms: any[]) => (ms ?? []).filter((m) => memberBusy(m, teamId)).length;
  const blank = () => { setEdit({ name: "", members: [], leader: null, policy: "idle", includeLeader: true, concurrency: 0 }); setCNode(memberOptions[0]?.node ?? ""); setCDir(""); };
  // 加目录：在该机器上初始化目录（不存在则创建，含 git init），再加入成员
  const initDir = async () => {
    const d = cDir.trim();
    if (!cNode || !d) return;
    setDirBusy("init");
    try {
      const r: any = await apiPost(`/api/nodes/${encodeURIComponent(cNode)}/fs/mkdir`, { path: d });
      onToast(r?.ok ? `已在该机器初始化目录：${d}` : `初始化失败：${r?.error ?? ""}`);
    } catch { onToast("初始化失败：服务连不上"); }
    finally { setDirBusy(""); }
  };
  const addDirMember = () => {
    if (!edit) return;
    const d = cDir.trim();
    if (!d || !cNode) return;
    const m = { node: cNode, dir: d };
    if (!edit.members.some((x) => mkey(x) === mkey(m))) setEdit({ ...edit, members: [...edit.members, m] });
    setCDir("");
  };
  const nodeIds = [...new Set(memberOptions.map((o) => o.node))];
  return (
    <div className="teams-page">
        <div className="teams-head">
          <span className="teams-title">团队管理</span>
          <span className="teams-sub">成员 = 机器 + 项目目录 · 派活 = 组长出计划 → 按忙闲自动分发</span>
        </div>
        <div className="teams-body">
          {list.length === 0 && !edit && <div className="teams-empty">还没有团队——点下面「＋ 新建团队」：成员 = 某台机器上的一个**项目目录**（工作区），再指定一个组长。</div>}
<div className="tlist">
          {list.map(([id, t]) => {
            const working = teamWorking(id, t?.members);
            const total = (t?.members ?? []).length;
            const js = jobs.filter((x: any) => x.teamId === id).slice().reverse();
            const latest = js[0];
            return (
            <div
              key={id}
              className={`trow ${working > 0 ? "busy" : ""}`}
              onClick={(e) => { e.stopPropagation(); onOpenTeam(id); }}
              onDoubleClick={(e) => { e.stopPropagation(); onOpenTeam(id); }}
              title="点击 / 双击在右侧打开团队群聊（派活、看组长与组员全过程）"
            >
              <span className={`trow-dot ${working > 0 ? "on" : ""}`} />
              <div className="trow-main">
                <div className="trow-name">{t?.name || id}{working > 0 && <span className="trow-live">● 进行中</span>}</div>
                <div className="trow-sub">组长 · {memberLabel(t?.leader)} · {total} 成员</div>
                {working > 0 && <div className="trow-marquee"><span>{latest ? jobText(latest) : "执行中…"}</span></div>}
              </div>
              <div className="trow-members" title={`${working}/${total} 工作中`}>
                {(t?.members ?? []).map((m: any) => (
                  <span key={mkey(m)} className={`trow-md ${memberBusy(m, id) ? "busy" : ""}`} />
                ))}
              </div>
              <span className={`trow-wk ${working > 0 ? "on" : ""}`}>{working > 0 ? <><RollingNumber value={working} />/<RollingNumber value={total} /> 工作中</> : "待命"}</span>
              <span className={`trow-st ${latest ? jobClass(latest.status) : ""}`} title={latest ? jobText(latest) : ""}>{latest ? jobText(latest) : "还没派过活"}</span>
              <div className="trow-acts" onClick={(e) => e.stopPropagation()}>
                <button className="trow-act" title="打开群聊 / 派活" onClick={() => onOpenTeam(id)}>💬</button>
                <button className="trow-act" title="编辑团队" onClick={() => { setEdit({ id, name: t?.name || "", members: (t?.members ?? []).slice(), leader: t?.leader ?? null, policy: t?.policy ?? "idle", includeLeader: t?.includeLeader !== false, concurrency: t?.concurrency ?? 0 }); setCNode((prev) => prev || (memberOptions[0]?.node ?? "")); }}>✎</button>
                <button className="trow-act danger" title="删除团队" onClick={() => { if (window.confirm(`删除团队「${t?.name || id}」？`)) onRemove(id); }}>🗑</button>
              </div>
              <span className="trow-go">›</span>
            </div>
            );
          })}
          </div>
          {edit && (
            <div className="pj-modal-ov">
            <div className="pj-modal tedit-modal" onClick={(e) => e.stopPropagation()}>
              <div className="pj-modal-h">
                <span className="pj-modal-title">团队设置</span>
                <span className="grow" />
                <button className="p-x" onClick={() => setEdit(null)}>×</button>
              </div>
              <div className="team-edit">
              <HaloInput className="team-name-in text-[13px]" placeholder="团队名" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <div className="team-opt-title">加目录（选机器 → 选/填目录 → 初始化 → 加入成员）</div>
              <div className="team-add-dir">
                <select className="team-sel" value={cNode} onChange={(e) => setCNode(e.target.value)}>
                  {nodeIds.map((n) => <option key={n} value={n}>{nodeName(n)}</option>)}
                </select>
                <HaloInput className="team-dir-in flex-1 text-[13px]" placeholder="目录路径（可浏览选择；不存在可点「初始化」创建）" value={cDir} onChange={(e) => setCDir(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addDirMember(); }} />
                <button className="team-mini" disabled={!cNode} onClick={() => setDirBrowserOpen(true)} title="浏览该机器目录：进入 / 新建 / 改名">浏览</button>
                <button className="team-mini" disabled={!cNode || !cDir.trim() || dirBusy === "init"} onClick={initDir} title="在该机器上创建该目录（不存在则新建，含 git init）">{dirBusy === "init" ? "初始化中…" : "初始化"}</button>
                <button className="team-btn" disabled={!cNode || !cDir.trim()} onClick={addDirMember}>＋ 加入</button>
              </div>
              <div className="team-opt-title">组织结构（团队 → 机器 → 目录；点目录节点设为组长，点 × 移除）</div>
              <div className="org-wrap">
                <ul className="org">
                  <li>
                    <div className="org-node org-root">{edit.name.trim() || "团队"}</div>
                    <ul>
                      {Object.entries(groupByNode(edit.members)).map(([node, ms]) => (
                        <li key={node}>
                          <div className="org-node org-machine">{nodeName(node)}</div>
                          <ul>
                            {ms.map((m) => {
                              const isLead = mkey(edit.leader) === mkey(m);
                              return (
                                <li key={mkey(m)}>
                                  <div
                                    className={`org-node org-leaf ${isLead ? "on" : ""}`}
                                    onClick={() => setEdit({ ...edit, leader: m })}
                                    title={isLead ? "当前组长" : "点此设为组长"}
                                  >
                                    <span className="org-leaf-dir">📁 {baseName(m.dir)}</span>
                                    {isLead && <span className="org-lead">组长</span>}
                                    <button className="org-x" onClick={(e) => { e.stopPropagation(); const ms2 = edit.members.filter((x) => mkey(x) !== mkey(m)); setEdit({ ...edit, members: ms2, leader: isLead ? null : edit.leader }); }}>×</button>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </li>
                      ))}
                      {edit.members.length === 0 && <li><div className="org-node org-blank">还没成员，从下面选</div></li>}
                    </ul>
                  </li>
                </ul>
              </div>
              <div className="team-opt-title">
                可选成员（按机器分组）—— 点击加入 / 移出
                {memberOptions.length > 0 && (
                  <button className="tm-batch" onClick={() => {
                    const allOn = memberOptions.every((o) => edit.members.some((m) => mkey(m) === mkey(o)));
                    setEdit({ ...edit, members: allOn ? [] : memberOptions.map((o) => ({ node: o.node, dir: o.dir })) });
                  }}>{memberOptions.every((o) => edit.members.some((m) => mkey(m) === mkey(o))) ? "清空全部" : "全选全部"}</button>
                )}
              </div>
              <div className="tm-groups">
                {Object.entries(groupByNode(memberOptions)).map(([node, opts]) => {
                  const arr = opts as any[];
                  const allOn = arr.every((o) => edit.members.some((m) => mkey(m) === mkey(o)));
                  return (
                    <div key={node} className="tm-group">
                      <div className="tm-group-h">
                        {nodeName(node)}<span className="tm-group-n">{arr.length}</span>
                        <button className="tm-batch" onClick={() => setEdit({ ...edit, members: allOn ? edit.members.filter((m) => m.node !== node) : [...edit.members.filter((m) => m.node !== node), ...arr.map((o) => ({ node: o.node, dir: o.dir }))] })}>{allOn ? "清空本机" : "全选本机"}</button>
                      </div>
                      <div className="tm-group-opts">
                        {arr.map((o) => {
                          const on = edit.members.some((m) => mkey(m) === mkey(o));
                          return <button key={mkey(o)} className={`team-opt ${on ? "on" : ""}`} title={o.dir} onClick={() => setEdit({ ...edit, members: on ? edit.members.filter((m) => mkey(m) !== mkey(o)) : [...edit.members, { node: o.node, dir: o.dir }] })}>{on ? "✓ " : "📁 "}{baseName(o.dir)}{o.busy > 0 ? ` ·${o.busy}忙` : ""}</button>;
                        })}
                      </div>
                    </div>
                  );
                })}
                {memberOptions.length === 0 && <span className="teams-empty">暂无已知项目目录</span>}
              </div>
              <div className="team-opt-title">调度设置</div>
              <div className="team-settings">
                <label className="tmset">分发策略
                  <select className="team-sel" value={edit.policy ?? "idle"} onChange={(e) => setEdit({ ...edit, policy: e.target.value })}>
                    <option value="idle">按忙闲</option>
                    <option value="roundrobin">轮询</option>
                    <option value="least">最少任务</option>
                  </select>
                </label>
                <label className="tmset">组长也接活
                  <HaloSwitch size="sm" checked={edit.includeLeader !== false} onCheckedChange={(v) => setEdit({ ...edit, includeLeader: v })} />
                </label>
                <label className="tmset">并发上限
                  <HaloInput className="team-sel w-[72px] text-[12px]" type="number" min={0} value={edit.concurrency ?? 0} onChange={(e) => setEdit({ ...edit, concurrency: Number(e.target.value) || 0 })} title="0 = 不限" />
                </label>
              </div>
              <div className="team-edit-btns">
                <HaloButton className="halo-btn-sm" onClick={() => { if (!edit.name.trim()) { onToast("请填团队名"); return; } if (!edit.members.length) { onToast("至少选一个成员"); return; } if (!edit.leader) { onToast("点一个目录节点设为组长"); return; } onSave(edit); setEdit(null); }}>保存</HaloButton>
                <button className="team-mini" onClick={() => setEdit(null)}>取消</button>
              </div>
            </div>
            {dirBrowserOpen && cNode && (
              <DirBrowser nodeId={cNode} initialPath={cDir.trim()} onClose={() => setDirBrowserOpen(false)} onPick={(p) => { setCDir(p); setDirBrowserOpen(false); }} onToast={onToast} />
            )}
            </div>
            </div>
          )}
        </div>
        <div className="teams-foot">
          <HaloButton className="halo-btn-sm" onClick={blank}>＋ 新建团队</HaloButton>
        </div>
    </div>
  );
}

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);
  return <span className="clock">{t.toLocaleTimeString("zh-CN", { hour12: false })}</span>;
}

/** 会话名：自定义别名优先，否则原始 title/id；点击 ✎ 进入行内编辑 */
function SessTitle({ id, fallback, aliases, editing, onStartEdit, onCommit, onCancel, className = "sess-title" }: {
  id: string;
  fallback: string;
  aliases: Record<string, string>;
  editing: boolean;
  onStartEdit: () => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  if (editing) {
    return (
      <input
        className={`sess-edit ${className}`}
        autoFocus
        defaultValue={aliases[id] ?? ""}
        placeholder={fallback}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(e.currentTarget.value.trim());
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={(e) => onCommit(e.currentTarget.value.trim())}
      />
    );
  }
  return <div className={className}>{aliases[id] || fallback}</div>;
}

interface Lane {
  key: string;
  label: string;
  sub: string | null;
  machine: string | null;
  status: "online" | "stale" | "offline";
  latency: number | null;
  items: (NodeView | RunAgentView)[];
}

export default function App() {
  const { snap, connected, gate, unreachable } = useSnapshot();

  /* ===== 团队共享元数据（组网机器互相同步：标签/别名/颜色/置顶）===== */
  // 快照合并视图：snap.teamMeta 已是 last-write-wins 后的 { key: {v, at} }，这里解析成各域对象
  const teamMetaView = useMemo(() => {
    const tm = snap?.teamMeta ?? {};
    const aliases: Record<string, string> = {};
    const sessAliases: Record<string, string> = {};
    const dirAliases: Record<string, string> = {};
    const sessTags: Record<string, string[]> = {};
    const sessColors: Record<string, string> = {};
    const sessPins: [string, number][] = [];
    const pins: [string, number][] = [];
    const colors: Record<string, string> = {};
    const teams: Record<string, any> = {};
    const pinOrder: number[] = [];
    let sessPinOrder: string[] = [];
    let tagOrder: string[] = [];
    let hasTagOrder = false;
    for (const [k, e] of Object.entries(tm)) {
      const v = (e as any)?.v;
      const at = (e as any)?.at ?? 0;
      if (k.startsWith("alias:")) aliases[k.slice(6)] = String(v);
      else if (k.startsWith("sessAlias:")) sessAliases[k.slice(10)] = String(v);
      else if (k.startsWith("dirAlias:")) dirAliases[k.slice(9)] = String(v);
      else if (k.startsWith("sessTag:")) sessTags[k.slice(8)] = Array.isArray(v) ? v.map(String) : [];
      else if (k.startsWith("sessColor:")) sessColors[k.slice(10)] = String(v);
      else if (k === "sessPinOrder") sessPinOrder = Array.isArray(v) ? v.map(String) : [];
      else if (k === "pjTagOrder") { hasTagOrder = true; tagOrder = Array.isArray(v) ? v.map(String) : []; }
      else if (k.startsWith("sessPin:")) sessPins.push([k.slice(8), Number(at) || 0]);
      else if (k.startsWith("pin:")) pins.push([k.slice(4), Number(at) || 0]);
      else if (k.startsWith("color:")) colors[k.slice(6)] = String(v);
      else if (k.startsWith("team:")) teams[k.slice(5)] = v;
    }
    const pinnedByTime = sessPins.sort((a, b) => b[1] - a[1]).map((p) => p[0]);
    return {
      aliases, sessAliases, dirAliases, sessTags, sessColors, colors, teams, tagOrder, hasTagOrder,
      sessPins: [
        ...sessPinOrder.filter((id) => pinnedByTime.includes(id)),
        ...pinnedByTime.filter((id) => !sessPinOrder.includes(id)),
      ],
      pins: pins.sort((a, b) => b[1] - a[1]).map((p) => p[0]),
    };
  }, [snap?.teamMeta]);

  /** 写一条团队共享元数据（key 带命名空间前缀）；value 为 null 表示删除 */
  const writeTeamKV = (key: string, value: unknown) => {
    void post("/api/team-meta", { key, value: value ?? null }).catch(() => {});
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null); // 刚发送、未落库的用户消息（乐观显示）
  useEffect(() => { setPendingUser(null); }, [chatId]);
  const [chatFull, setChatFull] = useState(false); // 聊天全屏
  const [panelOpen, setPanelOpen] = useState(false); // 详情面板展开态：false=收起成右下角灵动球
  /** 团队群聊面板：非空时右侧分栏展示该团队（与单个会话聊天互斥） */
  const [teamPanelId, setTeamPanelId] = useState<string | null>(null);
  const openTeamPanel = (id: string) => { setTeamPanelId(id); setSelectedId(null); setChatId(null); setChatFull(false); setPanelOpen(true); };
  const closeTeamPanel = () => { setTeamPanelId(null); if (!selectedId) setPanelOpen(false); };
  // 分栏宽度（可拖拽调整，持久化）；面板以分栏形式占位，不再覆盖主内容
  const [panelW, setPanelW] = useState<number>(() => {
    const v = Number(localStorage.getItem("atrium.panelW"));
    return Number.isFinite(v) && v >= 320 ? v : 528;
  });
  const [presetY, setPresetY] = useState<number | null>(null); // 档位浮层跟着鼠标 Y
  const [resizing, setResizing] = useState(false);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  // 分栏：面板打开时给顶栏/主区/输入栏预留右侧空间（不再覆盖内容）；全屏聊天除外
  useEffect(() => {
    const on = (Boolean(selectedId) || Boolean(teamPanelId)) && panelOpen && !chatFull;
    document.body.classList.toggle("panel-open", on);
    document.documentElement.style.setProperty("--panel-w", `${panelW}px`);
  }, [selectedId, panelOpen, chatFull, panelW, teamPanelId]);
  const startPanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = panelW;
    const onMove = (ev: PointerEvent) => {
      const maxW = Math.min(920, window.innerWidth * 0.82);
      setPanelW(Math.max(320, Math.min(maxW, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      setPanelW((w) => { try { localStorage.setItem("atrium.panelW", String(w)); } catch {} return w; });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  /** 分屏宽度档位：半屏 / 默认 / 更小 */
  const setPanelPreset = (k: "half" | "default" | "small") => {
    const maxW = Math.min(920, window.innerWidth * 0.82);
    const w = k === "half" ? Math.round(window.innerWidth / 2) : k === "default" ? 528 : 380;
    const clamped = Math.max(320, Math.min(maxW, w));
    setPanelW(clamped);
    try { localStorage.setItem("atrium.panelW", String(clamped)); } catch {}
  };
  /** 会话消息加载中：切换会话时给聊天窗盖遮罩，灵动球到窗口中间放加载特效 */
  const [chatLoading, setChatLoading] = useState(false);
  const [chatStatus, setChatStatus] = useState<ChatStatus | null>(null);
  /** 加载态延迟 180ms 再生效：快切会话不闪遮罩、球不来回跳 */
  const chatLoadTimer = useRef<number | null>(null);
  const onChatLoading = useCallback((v: boolean) => {
    if (v) {
      if (chatLoadTimer.current != null) return;
      chatLoadTimer.current = window.setTimeout(() => {
        chatLoadTimer.current = null;
        setChatLoading(true);
      }, 180);
    } else {
      if (chatLoadTimer.current != null) {
        clearTimeout(chatLoadTimer.current);
        chatLoadTimer.current = null;
      }
      setChatLoading(false);
    }
  }, []);
  const [attachFiles, setAttachFiles] = useState<{ id: string; name: string; mime: string; data: string }[]>([]); // 待发送附件
  const [dragOver, setDragOver] = useState(false); // 拖拽文件到聊天窗
  const [newSessOpen, setNewSessOpen] = useState(false); // 新建会话弹窗
  const [newSessDir, setNewSessDir] = useState<string | undefined>(undefined); // 预填目录（分组里点某个目录的「＋」时带入）
  const openNewSession = (dir?: string) => { setNewSessDir(dir); setNewSessOpen(true); };
  const [floatPos, setFloatPos] = useState<{ l: number | null; t: number | null }>(() => {
    try { const v = JSON.parse(localStorage.getItem("atrium.floatPos") || "null"); return (v && typeof v.l === "number") ? v : { l: null, t: null }; } catch { return { l: null, t: null }; }
  });
  const floatPosRef = useRef(floatPos);
  const [ballVisible, setBallVisible] = useState(() => {
    try { return localStorage.getItem("atrium.floatBall") !== "off"; } catch { return true; }
  });
  const [ballSnap, setBallSnap] = useState<{ edge: "left" | "right" | "top" | "bottom"; off: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem("atrium.floatSnap") || "null");
      return v && ["left", "right", "top", "bottom"].includes(v.edge) && typeof v.off === "number" ? v : null;
    } catch { return null; }
  });
  const [snapPreview, setSnapPreview] = useState<"left" | "right" | "top" | "bottom" | null>(null);
  const [ballMenu, setBallMenu] = useState<{ x: number; y: number } | null>(null);
  const [ballCountMenu, setBallCountMenu] = useState<{ x: number; y: number } | null>(null);
  const [ballWheelCount, setBallWheelCount] = useState(() => {
    try { const n = Number(localStorage.getItem("atrium.ballWheelCount") || "5"); return Number.isFinite(n) ? Math.max(2, Math.min(50, Math.round(n))) : 5; } catch { return 5; }
  });
  const [ballHud, setBallHud] = useState<{ x: number; y: number } | null>(null);
  const [ballDrop, setBallDrop] = useState<{ kind: "session" | "pin" | "panel"; action: string; rect: { x: number; y: number; width: number; height: number }; nodeId?: string; sessionId?: string } | null>(null);
  const ballRef = useRef<HTMLButtonElement | null>(null);
  const [ballEl, setBallEl] = useState<HTMLButtonElement | null>(null);
  const ballMoved = useRef(false);
  const suppressBallClick = useRef(false);
  const longPressTimer = useRef<number | null>(null);
  const hudTimer = useRef<number | null>(null);
  const [ballDrag, setBallDrag] = useState(false);
  const ballDragRef = useRef(false);
  useEffect(() => { ballDragRef.current = ballDrag; }, [ballDrag]);
  const dragStart = useRef<{ px: number; py: number; l: number; t: number } | null>(null);
  /** 灵动球「跳跃提醒」：任务完成或确认操作时飞到事件来源行前方，N 秒后回原位 */
  const [ballFly, setBallFly] = useState<{ l: number; t: number } | null>(null);
  const ballFlyTimer = useRef<number | null>(null);
  const flyBallTo = (sel: string): boolean => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (ballFlyTimer.current != null) clearTimeout(ballFlyTimer.current);
    setBallFly({ l: Math.max(8, r.left - 84), t: Math.max(8, r.top + r.height / 2 - 36) });
    ballFlyTimer.current = window.setTimeout(() => setBallFly(null), 4000);
    return true;
  };
  /** 卡片可能还没渲染完，找不到时按帧重试几次 */
  const flyBallToWhenReady = (sel: string, tries = 4) => {
    if (flyBallTo(sel)) return;
    if (tries <= 0) return;
    window.setTimeout(() => flyBallToWhenReady(sel, tries - 1), 60);
  };
  const [filter, setFilter] = useState<"all" | AgentState>("all");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIdx, setCmdIdx] = useState(0);
  const [whisperOpen, setWhisperOpen] = useState(false); // 低语弹窗
  const [whisperThinking, setWhisperThinking] = useState(false); // 思考中（粒子连线）
  const [settingsFor, setSettingsFor] = useState<string | null>(null); // null=关闭 "all"=列表 否则=单个 id
  /** 负载浮窗（左下角波浪药丸）开关：✕ 隐藏后在「设置」里可再打开 */
  const [loadDockOn, setLoadDockOn] = useState(() => {
    try { return localStorage.getItem("atrium.loadDock") !== "off"; } catch { return true; }
  });
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);

  const [aliases, setAliases] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.aliases") || "{}"); } catch { return {}; }
  });
  /** 设置机器（节点）显示名：写回后端配置（团队共享），空值=恢复原始名。
   *  先乐观更新本地别名做即时反馈，待服务端 label 随快照到达后（~1s）再清掉本地别名，
   *  之后一律以服务端 label 为权威，避免日后他人改名被本地缓存遮挡。 */
  const setNodeAlias = (id: string, name: string) => {
    const v = name.trim();
    const writeLocal = (val: string | null) => setAliases((m) => {
      const n = { ...m };
      if (val) n[id] = val; else delete n[id];
      localStorage.setItem("atrium.aliases", JSON.stringify(n));
      return n;
    });
    writeLocal(v || null); // 本地立即生效，并长期保留为覆盖（避免服务端快照未及时反映时被"弹回"）
    writeTeamKV(`alias:${id}`, v || null); // 同步到组网（团队 LWW 合并，其它机器一致显示）
    void post(`/api/nodes/${id}/label`, { label: v }).then((r: any) => {
      if (r?.ok) showToast(v ? "机器名已保存（团队可见）" : "已恢复原始机器名");
      else showToast(r?.error ?? "服务端未接受，已存为本地名称");
    });
  };
  const nodeById = useMemo(() => new Map((snap?.nodes ?? []).map((n) => [n.id, n])), [snap]);
  const machineNameOf = useCallback((nd: any): string => {
    const host = nd?.hostId ? nodeById.get(nd.hostId) : nd;
    if (!host) return nd?.machine ?? "";
    const custom = snap?.self?.nodeLabels?.[host.id] || (host.baseLabel && host.baseLabel !== host.label ? host.label : "");
    return custom || aliases[host.id] || host.machine || host.label || "";
  }, [aliases, nodeById, snap]);
  const [sessAliases, setSessAliases] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.sessAliases") || "{}"); } catch { return {}; }
  });
  const setSessAlias = (id: string, name: string) => {
    setSessAliases((m) => {
      const n = { ...m };
      if (name) n[id] = name; else delete n[id];
      localStorage.setItem("atrium.sessAliases", JSON.stringify(n));
      return n;
    });
    writeTeamKV(`sessAlias:${id}`, name || null);
  };
  const [sessAliasId, setSessAliasId] = useState<string | null>(null);
  const [dirAliases, setDirAliases] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.dirAliases") || "{}"); } catch { return {}; }
  });
  const setDirAlias = (dir: string, name: string) => {
    setDirAliases((m) => {
      const n = { ...m };
      if (name.trim()) n[dir] = name.trim(); else delete n[dir];
      localStorage.setItem("atrium.dirAliases", JSON.stringify(n));
      return n;
    });
    writeTeamKV(`dirAlias:${dir}`, name.trim() || null);
  };

  /** 会话标签：sessionId -> string[]（本地分类，参照项目目录别名） */
  const [sessTags, setSessTags] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.sessTags") || "{}"); } catch { return {}; }
  });
  const setSessionTags = (id: string, tags: string[]) => {
    setSessTags((m) => {
      const n = { ...m };
      const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
      if (clean.length) n[id] = clean; else delete n[id];
      localStorage.setItem("atrium.sessTags", JSON.stringify(n));
      return n;
    });
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    writeTeamKV(`sessTag:${id}`, clean.length ? clean : null);
  };

  /** 会话颜色：sessionId -> hex（本地标记色） */
  const [sessColors, setSessColors] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.sessColors") || "{}"); } catch { return {}; }
  });
  const setSessionColor = (id: string, color: string) => {
    setSessColors((m) => {
      const n = { ...m };
      if (color) n[id] = color; else delete n[id];
      localStorage.setItem("atrium.sessColors", JSON.stringify(n));
      return n;
    });
    writeTeamKV(`sessColor:${id}`, color || null);
  };

  /** 会话置顶：sessionId 列表（项目视图内跨模式优先展示） */
  const [sessPins, setSessPins] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.sessPins") || "[]"); } catch { return []; }
  });
  const toggleSessPin = (id: string) => {
    const nowPinned = !sessPins.includes(id);
    const n = nowPinned ? [id, ...sessPins.filter((x) => x !== id)] : sessPins.filter((x) => x !== id);
    setSessPins(n);
    try { localStorage.setItem("atrium.sessPins", JSON.stringify(n)); } catch {}
    writeTeamKV(`sessPin:${id}`, nowPinned ? true : null);
    writeTeamKV("sessPinOrder", n);
  };
  const reorderSessPins = (ids: string[]) => {
    const n = [...new Set(ids.filter(Boolean))];
    setSessPins(n);
    try { localStorage.setItem("atrium.sessPins", JSON.stringify(n)); } catch {}
    writeTeamKV("sessPinOrder", n);
  };

  /** 会话改名：优先写回 opencode（双向同步），该会话不支持改名时才存本地别名 */
  const renameSession = async (sessionId: string, hostNodeId: string | null, value: string) => {
    if (!value) {
      setSessAlias(sessionId, "");
      return;
    }
    setSessAlias(sessionId, value); // 先体感：本地立即生效，再异步写回 opencode
    if (!hostNodeId) {
      showToast("已存为本地别名（该会话不在 opencode 里）");
      return;
    }
    const r: any = await post(`/api/nodes/${hostNodeId}/sessions/${sessionId}/title`, { title: value });
    if (r?.ok) {
      showToast("已改名并同步到 opencode");
    } else {
      showToast("已存为本地别名（opencode 拒绝了改名）");
    }
  };
  /** 项目设置（名称/图标/颜色）：写回对应节点的 opencode（与桌面版同一份数据），失败原因带回给弹窗 */
  const saveProject = async (
    nodeId: string,
    dir: string,
    patch: { name?: string; icon?: { color?: string; override?: string; clearImage?: boolean } },
  ): Promise<{ ok: boolean; reason?: string }> => {
    const r: any = await post(`/api/nodes/${nodeId}/projects/update`, { directory: dir, ...patch });
    return { ok: Boolean(r?.ok), reason: r?.reason ?? r?.error };
  };

  const [hintsOff, setHintsOff] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.hintsOff") || "{}"); } catch { return {}; }
  });

  /** 新建会话：在指定节点上创建，成功后打开新会话并应用颜色/标签/置顶 */
  const recreateSessionDir = async (nodeId: string, dir: string) => {
    if (!dir) return;
    const r: any = await post(`/api/nodes/${nodeId}/fs/mkdir`, { path: dir });
    showToast(r?.ok ? `已创建工作目录：${dir}` : (r?.error ?? "目录创建失败"));
  };
  const createSession = async (opts: { nodeId: string; directory: string; title: string; color?: string; tags?: string[]; pinned?: boolean }) => {
    const r: any = await post(`/api/nodes/${opts.nodeId}/sessions/create`, { directory: opts.directory, title: opts.title });
    if (r?.ok && r?.session?.id) {
      const sid = r.session.id;
      if (opts.color) setSessionColor(sid, opts.color);
      if (opts.tags && opts.tags.length) setSessionTags(sid, opts.tags);
      if (opts.pinned) toggleSessPin(sid);
      showToast("已创建新会话" + (opts.tags?.length ? `（${opts.tags.length} 个标签）` : ""));
      setNewSessOpen(false);
      setSelectedId(opts.nodeId);
      pendingOpenRef.current = sid;
      setChatId(sid);
      setPanelOpen(true);
    } else {
      showToast(r?.error ?? "创建失败");
    }
  };
  const toggleHintsOff = (id: string) => {
    setHintsOff((m) => {
      const n = { ...m };
      if (n[id]) delete n[id]; else n[id] = true;
      localStorage.setItem("atrium.hintsOff", JSON.stringify(n));
      return n;
    });
  };
  const [colors, setColors] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.colors") || "{}"); } catch { return {}; }
  });
  const [pins, setPins] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.pins") || "[]"); } catch { return []; }
  });
  const [tagOrder, setTagOrder] = useState<string[]>(() => {
    try { const o = JSON.parse(localStorage.getItem("atrium.pjTagOrder") || "null"); return Array.isArray(o) ? o.map(String) : []; } catch { return []; }
  });
  const reorderTagOrder = (next: string[]) => {
    const clean = [...new Set(next.filter(Boolean))];
    setTagOrder(clean);
    try { localStorage.setItem("atrium.pjTagOrder", JSON.stringify(clean)); } catch {}
    writeTeamKV("pjTagOrder", clean);
  };
  /* ===== 首次迁移：把本机 localStorage 的旧标签/别名/颜色/置顶一次性搬到团队元数据（只搬一次） ===== */
  const teamMigratedRef = useRef(false);
  useEffect(() => {
    if (teamMigratedRef.current) return;
    teamMigratedRef.current = true;
    const readObj = (k: string) => { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; } };
    const readArr = (k: string) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
    for (const [id, v] of Object.entries(readObj("atrium.aliases"))) writeTeamKV(`alias:${id}`, v);
    for (const [id, v] of Object.entries(readObj("atrium.sessAliases"))) writeTeamKV(`sessAlias:${id}`, v);
    for (const [dir, v] of Object.entries(readObj("atrium.dirAliases"))) writeTeamKV(`dirAlias:${dir}`, v);
    for (const [id, v] of Object.entries(readObj("atrium.sessTags"))) writeTeamKV(`sessTag:${id}`, v);
    for (const [id, v] of Object.entries(readObj("atrium.sessColors"))) writeTeamKV(`sessColor:${id}`, v);
    for (const id of readArr("atrium.sessPins")) writeTeamKV(`sessPin:${id}`, true);
    for (const id of readArr("atrium.pins")) writeTeamKV(`pin:${id}`, true);
    for (const [id, v] of Object.entries(readObj("atrium.colors"))) writeTeamKV(`color:${id}`, v);
    // 清掉本地缓存，之后一律以团队元数据为准
    try {
      ["atrium.aliases", "atrium.sessAliases", "atrium.dirAliases", "atrium.sessTags", "atrium.sessColors", "atrium.sessPins", "atrium.pins", "atrium.colors"].forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  }, []);
  /* ===== 团队元数据回灌：组网其它机器写入的标签/别名/颜色/置顶，合并后覆盖本地态 ===== */
  useEffect(() => {
    const v = teamMetaView;
    setAliases((cur) => (JSON.stringify(cur) !== JSON.stringify(v.aliases) ? v.aliases : cur));
  }, [teamMetaView.aliases]);
  useEffect(() => {
    const v = teamMetaView;
    setSessAliases((cur) => (JSON.stringify(cur) !== JSON.stringify(v.sessAliases) ? v.sessAliases : cur));
  }, [teamMetaView.sessAliases]);
  useEffect(() => {
    const v = teamMetaView;
    setDirAliases((cur) => (JSON.stringify(cur) !== JSON.stringify(v.dirAliases) ? v.dirAliases : cur));
  }, [teamMetaView.dirAliases]);
  useEffect(() => {
    const v = teamMetaView;
    setSessTags((cur) => (JSON.stringify(cur) !== JSON.stringify(v.sessTags) ? v.sessTags : cur));
  }, [teamMetaView.sessTags]);
  useEffect(() => {
    const v = teamMetaView;
    setSessColors((cur) => (JSON.stringify(cur) !== JSON.stringify(v.sessColors) ? v.sessColors : cur));
  }, [teamMetaView.sessColors]);
  useEffect(() => {
    const v = teamMetaView;
    setSessPins((cur) => (JSON.stringify(cur) !== JSON.stringify(v.sessPins) ? v.sessPins : cur));
  }, [teamMetaView.sessPins]);
  useEffect(() => {
    const v = teamMetaView;
    setPins((cur) => (JSON.stringify(cur) !== JSON.stringify(v.pins) ? v.pins : cur));
  }, [teamMetaView.pins]);
  useEffect(() => {
    const v = teamMetaView;
    setColors((cur) => (JSON.stringify(cur) !== JSON.stringify(v.colors) ? v.colors : cur));
  }, [teamMetaView.colors]);
  const tagOrderMigratedRef = useRef(false);
  useEffect(() => {
    if (tagOrderMigratedRef.current || !snap) return;
    tagOrderMigratedRef.current = true;
    if (teamMetaView.hasTagOrder) return;
    let local: string[] = [];
    try {
      const o = JSON.parse(localStorage.getItem("atrium.pjTagOrder") || "null");
      if (Array.isArray(o)) local = o.map(String);
    } catch { /* ignore */ }
    if (local.length) reorderTagOrder(local);
  }, [snap?.generatedAt]);
  useEffect(() => {
    if (!teamMetaView.hasTagOrder) return;
    const v = teamMetaView.tagOrder;
    setTagOrder((cur) => {
      if (JSON.stringify(cur) === JSON.stringify(v)) return cur;
      try { localStorage.setItem("atrium.pjTagOrder", JSON.stringify(v)); } catch {}
      return v;
    });
  }, [teamMetaView.hasTagOrder, teamMetaView.tagOrder]);
  const [view, setViewState] = useState<ViewMode>(() => {
    const v = localStorage.getItem("atrium.view");
    if (VIEWS.some((x) => x.id === v)) return v as ViewMode;
    localStorage.setItem("atrium.view", "projects");
    return "projects";
  });
  const setView = (v: ViewMode) => {
    setViewState(v);
    localStorage.setItem("atrium.view", v);
  };
  /** 项目视图显示模式：顶栏「项目」旁的子筛选 tab（分组/时间/标签/置顶） */
  const [projMode, setProjModeState] = useState<"group" | "time" | "tag" | "pin">(() => {
    const v = localStorage.getItem("atrium.pjMode");
    return v === "time" || v === "tag" || v === "pin" ? v : "group";
  });
  const setProjMode = (m: "group" | "time" | "tag" | "pin") => {
    setProjModeState(m);
    try { localStorage.setItem("atrium.pjMode", m); } catch {}
  };
  /* ===== 主题切换 ===== */
  const [mode, setMode] = useState<"light" | "dark" | "system">(() => {
    const m = localStorage.getItem("atrium.mode");
    return m === "light" || m === "dark" || m === "system" ? m : "dark";
  });
  const [theme, setTheme] = useState<string>(() => {
    const t0 = localStorage.getItem("atrium.theme") || "galaxy";
    const t = THEMES.some((x) => x.id === t0) ? t0 : "galaxy";
    const m = localStorage.getItem("atrium.mode");
    const effMode =
      m === "light" ? "light"
        : m === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light"
          : "dark";
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.mode = effMode;
      document.documentElement.classList.toggle("dark", effMode !== "light");
    }
    return t;
  });
  const [themeOpen, setThemeOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const syncTheme = (t: string, m: "light" | "dark" | "system") => {
    const effMode = m === "light" ? "light"
      : m === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : "dark";
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.mode = effMode;
    document.documentElement.classList.toggle("dark", effMode !== "light");
  };
  const applyTheme = (t: string) => {
    setTheme(t);
    localStorage.setItem("atrium.theme", t);
    const effMode =
      mode === "light" ? "light"
        : mode === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
          : "dark";
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.mode = effMode;
    document.documentElement.classList.toggle("dark", effMode !== "light");
  };
  const applyMode = (m: "light" | "dark" | "system") => {
    setMode(m);
    setThemeOpen(false);
    localStorage.setItem("atrium.mode", m);
    syncTheme(theme, m);
  };
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => syncTheme(theme, "system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, theme]);
  const [notify, setNotify] = useState<NotifyCfg>(loadNotify);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const patchNotify = (p: Partial<NotifyCfg>) =>
    setNotify((v) => {
      const n = { ...v, ...p };
      saveNotify(n);
      return n;
    });

  /* ===== 挂画（易经卦象）===== */
  /* ===== 挂画（易经卦象）===== */
  const [hexOn, setHexOn] = useState<boolean>(() => {
    const v = localStorage.getItem("atrium.hexon");
    return v === null ? true : v === "1";
  });
  const toggleHex = () => {
    setHexOn((on) => {
      localStorage.setItem("atrium.hexon", on ? "0" : "1");
      return !on;
    });
  };
  const [hexMap, setHexMap] = useState<Record<string, Cast>>({});
  const [hexViewId, setHexViewId] = useState<string | null>(null);

  const [notifyOpen, setNotifyOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [topoOpen, setTopoOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const steerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(""); // 输入框受控值（支持 / 命令、@ 上下文）
  /** 会话草稿箱：未发送内容按「节点::会话」隔离保存，切换会话即存旧载新，回原会话草稿还在 */
  const draftMapRef = useRef<Record<string, string>>({});
  const draftRef = useRef("");
  draftRef.current = draft;
  const chatKey = selectedId ? `${selectedId}::${chatId ?? ""}` : (chatId ?? "");
  const chatKeyRef = useRef(chatKey);
  chatKeyRef.current = chatKey;
  /** 草稿箱版本号：写入/切换时递增，驱动卡片「草稿」标识刷新 */
  const [draftRev, setDraftRev] = useState(0);
  const writeDraft = useCallback((v: string) => {
    setDraft(v);
    draftMapRef.current[chatKeyRef.current] = v;
    setDraftRev((n) => n + 1);
  }, []);
  /** 有未发送草稿的会话键集合（nodeId::sessionId）→ 卡片「草稿」标识 */
  const draftKeys = useMemo(() => {
    const out = new Set<string>();
    for (const [k, v] of Object.entries(draftMapRef.current)) {
      if (v && v.trim()) out.add(k);
    }
    return out;
  }, [draftRev]);
  const [ment, setMent] = useState<{ kind: "slash" | "at"; q: string; at: number; end: number } | null>(null); // 当前打开的 / 或 @ 面板
  const [mentIdx, setMentIdx] = useState(0);
  const [piPrompt, setPiPrompt] = useState(""); // 给 standalone pi agent 派任务的输入
  const [piSending, setPiSending] = useState(false);

  /** 派任务给 standalone pi agent：续写某个会话（默认最新），fire-and-forget。 */
  const sendPiPrompt = async (sessionId?: string) => {
    const t = piPrompt.trim();
    if (!t) { showToast("指令不能为空"); return; }
    setPiSending(true);
    try {
      const r: any = await post("/api/runagents/pi/prompt", { text: t, sessionId });
      if (r?.ok) { setPiPrompt(""); showToast("已派给 pi agent"); }
      else showToast(r?.error ?? "派发失败");
    } catch (e) {
      showToast("派发失败");
    } finally {
      setPiSending(false);
    }
  };

  /* ===== 通用确认弹窗 ===== */
  interface ConfirmState {
    title: string;
    desc?: string;
    okText?: string;
    danger?: boolean;
    onOk: () => void;
  }
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const askConfirm = (c: ConfirmState) => setConfirm(c);

  // 每个会话生成一个独立"会话球"：轨道视图只显示具体会话，不显示聚合实体。
  // hostId 指向真实节点（对话通道）；raHost 指向自有会话系统的进程（pi/openclaw/hermes，只读）。
  const sessionOrbs = useMemo(() => {
    const out: any[] = [];
    const seenSess = new Set<string>();
    // 非 peer 节点优先，跨节点同一会话只显示一次
    const nodes = (snap?.nodes ?? []).slice().sort((a, b) => (a.id.includes("::") ? 1 : 0) - (b.id.includes("::") ? 1 : 0));
    for (const nd of nodes) {
      const all = (nd.sessions ?? []).slice().sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const keep: any[] = [];
      for (const s of all) {
        if (!s.id || seenSess.has(s.id)) continue;
        if (s.busy || keep.length < 24) { seenSess.add(s.id); keep.push(s); }
      }
      for (const s of keep) {
        out.push({
          ...nd,
          id: `${nd.id}::sess::${s.id}`,
          hostId: nd.id,
          label: sessAliases[s.id] || s.title || (s.directory ?? "").split(/[\\/]/).filter(Boolean).pop() || s.id,
          sessions: [s],
          busyCount: s.busy ? 1 : 0,
          recentEvents: (nd.recentEvents ?? []).filter((e: any) => !e.sessionID || e.sessionID === s.id),
          pendingPermissions: (nd.pendingPermissions ?? []).filter((p: any) => p.sessionID === s.id),
          pendingQuestions: (nd.pendingQuestions ?? []).filter((q: any) => q.sessionID === s.id),
        });
      }
    }
    for (const ra of snap?.runAgents ?? []) {
      const all = (ra.sessions ?? []).slice().sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      for (const s of all.slice(0, 8)) {
        if (!s.id || seenSess.has(s.id)) continue;
        seenSess.add(s.id);
        out.push({ ...ra, id: `${ra.id}::sess::${s.id}`, raHost: ra.id, label: sessAliases[s.id] || s.title || s.id, sessions: [s], busyCount: s.busy ? 1 : 0 });
      }
    }
    return out;
  }, [snap, sessAliases]);

  // run agent 进程本体球：空闲也常驻（灰显），代表"这台机器上有个 agent 进程在跑"
  const processOrbs = useMemo(
    () => (snap?.runAgents ?? []).map((ra) => ({ ...ra, _proc: true as boolean })),
    [snap]
  );

  const items = useMemo(() => [...allNodes(snap), ...sessionOrbs], [snap, sessionOrbs]);
  const apiIdOf = (nd: any) => nd.hostId ?? nd.raHost ?? nd.id;
  // 统一状态判定：会话球按会话语义（busy=writing / 宿主持有审批=awaiting / 空闲=done），实体球按原语义
  const stateOf = (nd: any): AgentState => {
    if ((nd as any).hostId) return sessionStateOf(nd.sessions?.[0]?.busy ?? false, nd);
    if ((nd as any).raHost) return sessionStateOf(nd.sessions?.[0]?.busy ?? false, null);
    return stateOfBase(nd);
  };
  // 挂画：
  //  - 正在执行（writing）且该球还没有卦 → 补一卦（覆盖刷新页面 / 刚打开开关 / 新会话球）
  //  - 空闲 → 忙 且已有旧卦 → 换一卦（同节点的下一个任务）
  //  - 关闭开关 → 清空卦画
  const prevStateRef = useRef<Record<string, AgentState>>({});
  useEffect(() => {
    const prev = prevStateRef.current;
    const next: Record<string, AgentState> = {};
    if (!hexOn) {
      for (const n of items) next[n.id] = stateOf(n);
      prevStateRef.current = next;
      if (Object.keys(hexMap).length > 0) setHexMap({});
      return;
    }
    let changed = false;
    let newHex: Record<string, Cast> | null = null;
    for (const n of items) {
      const st = stateOf(n);
      next[n.id] = st;
      const p = prev[n.id];
      const hasHex = !!hexMap[n.id];
      const needsFirst = st === "writing" && !hasHex;
      const needsNew = st === "writing" && hasHex && !!p && p !== "writing";
      if (needsFirst || needsNew) {
        newHex = newHex ?? { ...hexMap };
        newHex[n.id] = cast();
        changed = true;
      }
    }
    prevStateRef.current = next;
    if (changed && newHex) setHexMap(newHex);
  }, [items, hexOn]);
  const hexOf = (id: string) => hexMap[id] ?? null;
  // 会话球的别名与会话列表的自定义名称共享同一份数据（sessAliases，按 sessionId），
  // 球上直接显示 sessionOrbs 已合成的 label
  const aliasOf = (nd: any) => {
    if ((nd as any).hostId) return nd.label;
    const b = (nd as any).baseLabel;
    if (b && b !== nd.label) return nd.label;   // 服务端已设自定义名 → 权威，避免被本地旧别名遮挡
    return aliases[nd.id] || nd.label;
  };
  const colorOf = (nd: any) => colors[nd.id] || STATE_COLORS[stateOf(nd)];
  // 把 var(--x) 解析成当前主题的实际色值（供 <input type="color"> 用）
  const cssColor = (c: string) => {
    const m = /^var\((--[\w-]+)\)$/.exec(c);
    if (m) return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || "#888888";
    return c;
  };
  const selected = items.find((n) => n.id === selectedId) || null;
  // run 进程（Desktop/CLI）没有 HTTP 接口：找同机器的 server 节点做对话通道
  // 关键：只有进程本身是 opencode 生态（proc=opencode / desktop / sidecar 的 ccw worker）才配得上总控会话；
  // pi/openclaw/hermes 即使是 cc-connect 的子进程，会话也在各自独立的系统里
  const buddyAllowed = selected && !isServer(selected)
    ? (() => {
        const ra = selected as RunAgentView & { proc?: string };
        const notOpencode = ["pi", "openclaw", "hermes"].includes(ra.proc ?? ra.bridge);
        if (notOpencode) return false;
        return ra.proc === "opencode" || ra.bridge === "desktop" || ra.bridge === "opencode" || ra.id.startsWith("run-ccw-") || ra.bridge === "cc-connect";
      })()
    : false;
  const buddy: NodeView | null = buddyAllowed
    ? (items.find((n) =>
        isServer(n) && !(n as any).hostId && (
          // machine 相等（本地/peer 常规路径）
          ((n as NodeView).machine && (n as NodeView).machine === (selected as RunAgentView).machine) ||
          // sidecar 不报 machine 时，球的 machine 就是节点 label
          n.label === (selected as RunAgentView).machine ||
          // 远端 run 球 id 带 "${nodeId}::" 前缀，直接认宿主
          (selected as RunAgentView).id.startsWith(`${n.id}::`)
        )
      ) as NodeView | undefined) ?? null
    : null;
  const chatNode: (NodeView | RunAgentView) | null = selected
    ? (isServer(selected) ? selected : (isPiRun(selected) ? selected : buddy))
    : null;
  const chatSess = chatNode && chatId
    ? (chatNode.sessions ?? []).find((s) => s.id === chatId) ?? null
    : null;
  /** 会话宿主是否"离线到没法对话"：pi 进程球空闲时不算离线（仍可派任务），故排除 pi；无目标时视为禁用 */
  const chatDisabled = chatNode ? (stateOf(chatNode) === "asleep" && !isPiRun(chatNode)) : true;
  const chatError = chatNode && chatId ? sessionErrorOf(chatNode, chatId) : null;

  /* ===== 模型切换：清单按节点缓存，选择按会话记忆（localStorage） ===== */
  const [modelsByNode, setModelsByNode] = useState<Record<string, ModelsResp>>({});
  const [modelSel, setModelSel] = useState<Record<string, ModelRef>>(loadModelSel);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const chatNodeId = chatNode && isServer(chatNode) ? apiIdOf(chatNode) : null;
  useEffect(() => {
    if (!chatNodeId || modelsByNode[chatNodeId]) return;
    let stop = false;
    apiFetch(`/api/nodes/${chatNodeId}/models`)
      .then((r) => r.json())
      .then((j: ModelsResp) => { if (!stop) setModelsByNode((m) => ({ ...m, [chatNodeId]: j })); })
      .catch(() => { if (!stop) setModelsByNode((m) => ({ ...m, [chatNodeId]: { ok: false, reason: "获取失败" } })); });
    return () => { stop = true; };
  }, [chatNodeId]);
  // 切换会话/对象时收起菜单
  useEffect(() => { setModelMenuOpen(false); }, [chatId, chatNodeId]);
  const persistModelSel = (sid: string, ref: ModelRef | null) => {
    setModelSel((prev) => {
      const n = { ...prev };
      if (ref) n[sid] = ref; else delete n[sid];
      try { localStorage.setItem(MODEL_SEL_KEY, JSON.stringify(n)); } catch { /* ignore */ }
      return n;
    });
  };
  const chatModels = chatNodeId ? modelsByNode[chatNodeId] : undefined;
  // 当前生效模型：本地选择优先，否则用会话快照里的 model/providerID
  const effModel: ModelRef | null = (() => {
    if (!chatSess) return null;
    const sel = modelSel[chatSess.id];
    if (sel) return sel;
    if (chatSess.model) return { providerID: chatSess.providerID ?? "", modelID: chatSess.model };
    return null;
  })();
  // 展示名：在清单里找到对应模型的 name，否则回退到 modelID
  const effModelLabel = (() => {
    if (!effModel) return null;
    const prov = chatModels?.providers?.find((p) => p.id === effModel.providerID);
    const m = prov?.models.find((x) => x.id === effModel.modelID);
    return m?.name ?? effModel.modelID;
  })();
  const pickModel = (providerID: string, modelID: string) => {
    if (!chatSess) return;
    persistModelSel(chatSess.id, { providerID, modelID });
    setModelMenuOpen(false);
    const prov = chatModels?.providers?.find((p) => p.id === providerID);
    const name = prov?.models.find((x) => x.id === modelID)?.name ?? modelID;
    showToast(`已选模型 → ${name}（发送后生效）`);
  };

  // run 进程面板要展示的会话：能按工作目录过滤就只显示它自己的
  const runSessInfo = useMemo(() => {
    if (!selected || isServer(selected) || !buddy) return null;
    const ra = selected as RunAgentView;
    // worker 自带精确会话（--session 提取 + 后端已按目录补全），直接用它自己的
    if ((ra as any).sessionId && (ra.sessions ?? []).length) {
      return { list: ra.sessions.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)), filtered: true };
    }
    const dir = ra.activeDir ?? ra.workDir ?? "";
    const isRealDir = dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir);
    const all = (buddy.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (isRealDir) {
      const inDir = all.filter((s) => s.directory === dir);
      if (inDir.length) return { list: inDir, filtered: true };
    }
    return { list: all, filtered: false };
  }, [selected?.id, buddy?.id, snap]);

  // 选中即进对话：切换对象时清掉旧 chatId 并立刻决定新对象的会话。
  // 必须合成一个 effect——分两个的话，旧的 chatId 在本轮渲染里还没清掉，会把自动进入跳掉
  // （表现为"点球进去是会话列表"）
  const prevSelRef = useRef<string | null | undefined>(undefined);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;
  // 项目视图里点某个会话直接进对话：setSelectedId + setChatId 同一帧触发，
  // effect 的 "服务节点清除 chatId" 分支会顶掉它，用 pending 引用保住
  const pendingOpenRef = useRef<string | null>(null);
  // 切换会话：把旧会话草稿存回草稿箱，载入新会话草稿（未发送内容不跨会话携带）
  const prevChatKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevChatKeyRef.current;
    if (prev !== null && prev !== chatKey) draftMapRef.current[prev] = draftRef.current;
    prevChatKeyRef.current = chatKey || null;
    setDraft(draftMapRef.current[chatKey] ?? "");
    setMent(null);
    setMentIdx(0);
    setAtMentions([]);
    setDraftRev((n) => n + 1);
  }, [chatKey]);
  useEffect(() => {
    const selChanged = prevSelRef.current !== selectedId;
    prevSelRef.current = selectedId;
    if (selChanged && selectedId) { setTeamPanelId(null); setChatFull(false); }
    const pend = pendingOpenRef.current;
    pendingOpenRef.current = null;
    if (!selected) return;
    if (!selChanged && chatIdRef.current) return; // 已在该对象内手动进入某个会话，不打扰
    if (pend) { setChatId(pend); return; } // 项目视图直接指定会话
    // "会话球"直接进它的对话
    if ((selected as any).hostId && (selected.sessions ?? []).length === 1) {
      setChatId(selected.sessions[0].id);
      return;
    }
    if (!isServer(selected) && buddy) {
      const ra = selected as RunAgentView;
      // 0) worker 命令行带 --session：直接进它正在跑的会话
      if ((ra as any).sessionId) { setChatId((ra as any).sessionId); return; }
      // 1) 进程自带会话快照（本地按目录/--session 匹配、远端由后端按 workDir 补齐）：进它最近的会话
      const own = (ra.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      if (own.length) { setChatId(own[0].id); return; }
      // 2) 按工作目录在宿主节点会话里精确匹配
      const ss = buddy.sessions ?? [];
      const dir = ra.activeDir ?? ra.workDir ?? "";
      const isRealDir = dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir);
      const inDir = isRealDir ? ss.filter((s) => s.directory === dir) : [];
      if (inDir.length) {
        setChatId(inDir.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0].id);
        return;
      }
    }
    // 服务节点 / 实在匹配不上：显示详情列表
    if (selChanged) setChatId(null);
  }, [selectedId, buddy?.id]);

  const showToast = (msg: string) => {
    const rimVariant = /失败|错误|离线|拒绝|无法/.test(msg) ? "destructive" as const : /已|成功|完成/.test(msg) ? "success" as const : "default" as const;
    showPolishedToast({ title: msg, duration: 2600, rimVariant, closeButton: false });
  };

  /** 聊天面板内左上角的行内提示（寄出/转发等面板动作），不落全局 toast */
  const [panelToast, setPanelToast] = useState<{ id: number; msg: string } | null>(null);
  const panelToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPanelToast = useCallback((msg: string) => {
    if (panelToastTimer.current) clearTimeout(panelToastTimer.current);
    setPanelToast({ id: Date.now(), msg });
    panelToastTimer.current = setTimeout(() => setPanelToast(null), 2400);
  }, []);

  /* ===== 团队管理 ===== */
  const teamMembers = useMemo(() => {
    const out: { node: string; dir: string; label: string; busy: number }[] = [];
    for (const nd of snap?.nodes ?? []) {
      const lab = machineNameOf(nd);
      for (const d of (nd.dirs ?? [])) out.push({ node: nd.id, dir: d, label: `${lab} · ${d}`, busy: nd.busyCount ?? 0 });
    }
    return out;
  }, [snap]);
  const saveTeam = (t: { id?: string; name: string; members: any[]; leader: any; policy?: string; includeLeader?: boolean; concurrency?: number }) => {
    const id = t.id || `t_${Date.now().toString(36)}`;
    writeTeamKV(`team:${id}`, { name: t.name.trim(), members: t.members, leader: t.leader, policy: t.policy ?? "idle", includeLeader: t.includeLeader !== false, concurrency: t.concurrency ?? 0 });
    showToast("团队已保存");
  };
  const removeTeam = (id: string) => { writeTeamKV(`team:${id}`, null); showToast("团队已删除"); };
  const dispatchTeamTask = async (teamId: string, members: any[], leader: any, task: string, opts?: any) => {
    const r: any = await post("/api/teams/dispatch", { teamId, members, leader, task, ...(opts ?? {}) });
    showToast(r?.ok ? "已派给组长，等它出计划…" : (r?.error ?? "分发失败"));
    return Boolean(r?.ok);
  };
  const retryTeamAssign = async (jobId: string, index: number) => {
    const r: any = await post("/api/teams/retry", { jobId, index });
    showToast(r?.ok ? "已重派" : "重派失败");
  };
  // 团队任务完成通知（首次基线不刷屏）
  const teamDoneSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const FINAL = ["done", "partial", "failed", "timeout", "no-members", "leader-send-failed"];
    // 快照未加载完成（teamJobs 还是 undefined）时不设基线，否则会把历史已完成任务当成新完成逐条弹通知
    const jobs = snap?.teamJobs;
    if (jobs === undefined) return;
    const finals = jobs.filter((j: any) => FINAL.includes(j.status));
    if (teamDoneSeen.current === null) { teamDoneSeen.current = new Set(finals.map((j: any) => j.id)); return; }
    for (const j of finals) {
      if (!teamDoneSeen.current.has(j.id)) { teamDoneSeen.current.add(j.id); showToast(`团队任务完成 · ${j.summary ?? j.status}`); }
    }
  }, [snap?.teamJobs]);

  const showLoadDock = () => {
    setLoadDockOn(true);
    try { localStorage.removeItem("atrium.loadDock"); } catch {}
    showToast("负载浮窗已显示");
  };
  const hideLoadDock = () => {
    setLoadDockOn(false);
    try { localStorage.setItem("atrium.loadDock", "off"); } catch {}
    showToast("负载浮窗已隐藏（左下角小按钮或「设置」里可再打开）");
  };

  // 通知中心：任务完成通知（待确认列表，可点击进会话 / × 关闭 / 批量清空）
  interface DoneNotice {
    key: string; nodeId?: string; sessionId?: string; title: string; at: number; seen: boolean;
    kind?: "done" | "awaiting" | "error" | "team" | "stuck";
    teamId?: string; jobId?: string;
    machine?: string; dir?: string; project?: string; model?: string; agent?: string;
  }
  const [notices, setNotices] = useState<DoneNotice[]>(() => {
    try { return JSON.parse(localStorage.getItem("atrium.notices") || "[]"); } catch { return []; }
  });
  const [noticeOpen, setNoticeOpen] = useState(false);
  // 任务完成卡片：同一时刻只弹一个（第一条），12 秒等待效果后自动消失
  const [doneCard, setDoneCard] = useState<DoneNotice | null>(null);
  const persistNotices = (n: DoneNotice[]) => {
    setNotices(n);
    try { localStorage.setItem("atrium.notices", JSON.stringify(n)); } catch {}
  };
  // 函数式更新，避免同一轮多条通知互相覆盖
  const pushNotice = (n: DoneNotice) => {
    setNotices((prev) => {
      const next = [n, ...prev.filter((x) => x.key !== n.key)].slice(0, 200);
      try { localStorage.setItem("atrium.notices", JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const dismissNotice = (key: string) => persistNotices(notices.filter((n) => n.key !== key));
  const clearNotices = () => persistNotices([]);
  const unreadNotices = notices.filter((n) => !n.seen).length;
  // 点通知 = 关面板 + 进对应会话聊天 + 消掉该条记录（三处入口共用）
  const openNotice = (n: DoneNotice) => {
    setNoticeOpen(false);
    setDoneCard(null);
    if (n.kind === "team" && n.teamId) {
      setNotices((prev) => {
        const next = prev.filter((x) => x.key !== n.key);
        try { localStorage.setItem("atrium.notices", JSON.stringify(next)); } catch {}
        return next;
      });
      if ((teamMetaView.teams as any)[n.teamId]) openTeamPanel(n.teamId);
      else { setView("teams"); }
      return;
    }
    if (!n.nodeId || !n.sessionId) return;
    setSelectedId(n.nodeId);
    pendingOpenRef.current = n.sessionId;
    setChatId(n.sessionId);
    setPanelOpen(true);
    setNotices((prev) => {
      const next = prev.filter((x) => x.key !== n.key);
      try { localStorage.setItem("atrium.notices", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // 团队任务完成通知：整队任务从「进行中」变为结束态时，推一条带「团队」标签的通知
  const teamJobPrevRef = useRef<Record<string, string>>({});
  const teamJobNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const RUN = new Set(["leader-working", "dispatching"]);
    const prev = teamJobPrevRef.current;
    const next: Record<string, string> = {};
    for (const job of snap?.teamJobs ?? []) {
      const j = job as any;
      next[j.id] = j.status;
      if (RUN.has(j.status)) { teamJobNotifiedRef.current.delete(j.id); continue; }
      if (RUN.has(prev[j.id] ?? "") && !teamJobNotifiedRef.current.has(j.id)) {
        teamJobNotifiedRef.current.add(j.id);
        const tname = (teamMetaView.teams[j.teamId] as any)?.name || j.teamId;
        const done = j.assigns ? j.assigns.filter((a: any) => a.status === "done").length : 0;
        const fail = j.assigns ? j.assigns.filter((a: any) => a.status === "fail").length : 0;
        pushNotice({
          key: `team:${j.id}`, kind: "team", teamId: j.teamId, jobId: j.id, title: tname,
          at: Date.now(), seen: false, project: "团队", machine: j.leader, dir: "",
          nodeId: "", sessionId: "",
        });
        void done; void fail;
      }
    }
    teamJobPrevRef.current = next;
  }, [snap?.teamJobs, teamMetaView.teams]);

  // 会话「疑似卡死」提醒：会话 busy 但很久（默认 10 分钟）没有任何进展（updatedAt 停止前进）→ 推一条带「卡死」标签的通知，
  // 点它进入会话，聊天窗里可一键「中断解锁」。这能避免像 Start-Process 常驻进程继承管道那样，卡住十几分钟才发现。
  const stuckNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const STUCK_MS = 10 * 60_000;
    const now = Date.now();
    for (const nd of snap?.nodes ?? []) {
      for (const s of nd.sessions ?? []) {
        const key = `${nd.id}::${s.id}`;
        if (!s.busy) { stuckNotifiedRef.current.delete(key); continue; }
        const since = s.updatedAt ?? 0;
        if (since && now - since > STUCK_MS && !stuckNotifiedRef.current.has(key)) {
          stuckNotifiedRef.current.add(key);
          pushNotice({
            key: `stuck:${key}`, kind: "stuck", nodeId: nd.id, sessionId: s.id,
            title: s.title || s.id, at: now, seen: false,
            machine: nd.machine ?? nd.label, dir: s.directory ?? "",
            project: (s.directory ? (dirAliases[s.directory] || s.directory.split(/[\\/]/).filter(Boolean).pop()) : "") || undefined,
            model: s.model, agent: s.agent,
          });
        }
      }
    }
  }, [snap, dirAliases]);

  // 会话执行完成提示：监测每个会话 busy → 空闲的转变（首次加载不算；同一宿主+会话只提示一次）
  // 用 nodeId::sessionId 作唯一键——同一会话可能重复出现在多个节点（peer 转发场景），
  // 只用 sessionId 会被另一节点的副本覆盖，导致误判「已完成」。
  const busyPrevRef = useRef<Record<string, boolean>>({});
  const doneNotifyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = busyPrevRef.current;
    const next: Record<string, boolean> = {};
    const done: { nodeId: string; sessionId: string; title: string; machine?: string; dir?: string; project?: string; model?: string; agent?: string }[] = [];
    for (const nd of snap?.nodes ?? []) {
      for (const s of nd.sessions ?? []) {
        const key = `${nd.id}::${s.id}`;
        next[key] = s.busy;
        // 重新忙碌 → 清掉「已提示」标记，让这次执行完还能再弹完成提示（否则同一会话只提示过一次）
        if (s.busy) doneNotifyRef.current.delete(key);
        if (doneNotifyRef.current.has(key)) continue;
        if (prev[key] === true && !s.busy) {
          doneNotifyRef.current.add(key);
          const dir = s.directory ?? "";
          const project = (dirAliases[dir] || (dir ? dir.split(/[\\/]/).filter(Boolean).pop() : "")) || undefined;
          done.push({ nodeId: nd.id, sessionId: s.id, title: s.title || s.id, machine: nd.machine ?? nd.label, dir, project, model: s.model, agent: s.agent });
        }
      }
    }
    busyPrevRef.current = next;
    if (done.length) {
      // 灵动球飞到「完成卡片弹窗」位置（卡片未挂载时回退到该会话行）
      window.setTimeout(() => {
        if (!document.querySelector("[data-done-card]")) flyBallTo(`[data-sess-id="${done[0].sessionId}"]`);
        else flyBallTo("[data-done-card]");
      }, 80);
      for (const d of done) {
        pushNotice({ key: `${d.nodeId}::${d.sessionId}`, nodeId: d.nodeId, sessionId: d.sessionId, title: d.title, at: Date.now(), seen: false, kind: "done", machine: d.machine, dir: d.dir, project: d.project, model: d.model, agent: d.agent });
      }
      // 只弹第一条的完成卡片（其余静默进通知中心）；已有卡片在展示时不打断
      setDoneCard((cur) => cur ?? { key: `${done[0].nodeId}::${done[0].sessionId}`, nodeId: done[0].nodeId, sessionId: done[0].sessionId, title: done[0].title, at: Date.now(), seen: true, kind: "done", machine: done[0].machine, dir: done[0].dir, project: done[0].project, model: done[0].model, agent: done[0].agent });
    }
  }, [snap?.generatedAt]);

  // 完成卡片：12 秒等待后自动收起
  useEffect(() => {
    if (!doneCard) return;
    const t = setTimeout(() => setDoneCard(null), 12000);
    return () => clearTimeout(t);
  }, [doneCard]);

  /** 点球：开启挂画且该球有卦 → 先弹卦辞浮层；否则直接选中展开详情 */
  const selectOrb = (id: string) => {
    if (hexOn && hexMap[id]) {
      setHexViewId(id);
      setSelectedId(null);
      setChatId(null);
      setPanelOpen(false);
      return;
    }
    setSelectedId(id);
    setPanelOpen(true);
  };

  /* ===== orbit lanes ===== */
  const lanes = useMemo<Lane[]>(() => {
    const nodes = snap?.nodes ?? [];
    const isLocal = (nd: NodeView) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(nd.url ?? "");
    const out: (Lane & { nodeLabel: string })[] = nodes.map((nd) => {
      const disp = machineNameOf(nd);
      const sub = nd.machine && nd.machine !== disp ? nd.machine : (nd.label !== disp ? nd.label : null);
      return {
        key: nd.id,
        label: disp,
        sub,
        machine: nd.machine ?? null,
        nodeLabel: nd.label,
        status: nd.status,
        latency: nd.latencyMs,
        items: [],
      };
    });
    // local node first
    out.sort((a, b) => {
      const an = nodes.find((n) => n.id === a.key);
      const bn = nodes.find((n) => n.id === b.key);
      return (an && isLocal(an) ? 0 : 1) - (bn && isLocal(bn) ? 0 : 1);
    });
    // 只显示具体会话球：节点会话按宿主归圈，进程会话按机器归圈
    for (const so of sessionOrbs) {
      if ((so as any).hostId) {
        out.find((l) => l.key === (so as any).hostId)?.items.push(so);
      } else {
        const ra = so as RunAgentView;
        let lane: Lane | undefined;
        if (ra.machine) lane = out.find((l) => l.machine === ra.machine || l.nodeLabel === ra.machine);
        if (!lane) lane = out.find((l) => { const n = nodes.find((x) => x.id === l.key); return n && isLocal(n); });
        if (!lane) lane = out[0];
        lane?.items.push(so);
      }
    }
    // 圈内排序：进行中在前，其余按最近更新
    for (const l of out) {
      l.items.sort((a: any, b: any) =>
        ((b.sessions?.[0]?.busy ? 1 : 0) - (a.sessions?.[0]?.busy ? 1 : 0)) ||
        ((b.sessions?.[0]?.updatedAt ?? 0) - (a.sessions?.[0]?.updatedAt ?? 0)));
    }
    // 进程本体球同样按机器归圈（空闲灰显、常驻）
    for (const ra of processOrbs) {
      let lane: Lane | undefined;
      if (ra.machine) lane = out.find((l) => l.machine === ra.machine || l.nodeLabel === ra.machine);
      if (!lane) lane = out.find((l) => { const n = nodes.find((x) => x.id === l.key); return n && isLocal(n); });
      if (!lane) lane = out[0];
      lane?.items.push(ra as any);
    }
    return out;
  }, [snap, sessionOrbs, processOrbs, aliases, nodeById]);

  // 轨道视图只展示"运行中 + 待决策"的球；
// 状态筛选（filter）只作用于项目视图
  // 刚完成的球：运行中→完成时先留在原位 N 秒（让"完成"可见），再消失
  const [recentDone, setRecentDone] = useState<Record<string, number>>({});
  const prevOrbState = useRef<Record<string, string>>({});
  useEffect(() => {
    const prev = prevOrbState.current;
    const next: Record<string, string> = {};
    const add: Record<string, number> = {};
    for (const n of [...sessionOrbs, ...processOrbs]) {
      const st = stateOf(n);
      next[n.id] = st;
      if (prev[n.id] === "writing" && st === "done") add[n.id] = Date.now();
    }
    prevOrbState.current = next;
    if (Object.keys(add).length) setRecentDone((m) => ({ ...m, ...add }));
  }, [sessionOrbs, processOrbs]);
  useEffect(() => {
    const iv = setInterval(() => setRecentDone((m) => {
      const now = Date.now(); const n: Record<string, number> = {}; let ch = false;
      for (const [k, t] of Object.entries(m)) { if (now - t < 12000) n[k] = t; else ch = true; }
      return ch ? n : m;
    }), 4000);
    return () => clearInterval(iv);
  }, []);
  const ballKeep = (nd: any) => {
    const st = stateOf(nd);
    if (st === "writing" || st === "awaiting") return true; // 只展示 运行中 / 待确认
    if (recentDone[nd.id]) return true;                     // 运行中→完成：先留在原位一会儿
    return false;
  };
  // 项目视图里置顶的会话 → 对应会话球 id 集合；球类视图也展示并标记为置顶
  const sessPinSet = useMemo(() => {
    const set = new Set<string>();
    for (const so of sessionOrbs) {
      const sid = (so as any).sessions?.[0]?.id;
      if (sid && sessPins.includes(sid)) set.add(so.id);
    }
    return set;
  }, [sessionOrbs, sessPins]);


  const counts = useMemo(() => {
    if (view === "projects") {
      const c: Record<string, number> = { all: 0, writing: 0, awaiting: 0, ready: 0, asleep: 0, done: 0 };
      for (const nd of snap?.nodes ?? []) {
        for (const s of nd.sessions ?? []) {
          c.all++;
          c[sessionStateOf(s.busy, nd)]++;
        }
      }
      return c;
    }
    const c: Record<string, number> = { all: sessionOrbs.length, writing: 0, awaiting: 0, ready: 0, asleep: 0, done: 0 };
    for (const n of sessionOrbs) c[stateOf(n)]++;
    return c;
  }, [snap, view, sessionOrbs]);

  /* ===== 值班提醒：待处理项（权限 / 提问）探测 ===== */
  interface AlertItem { key: string; nodeId: string; sessionId?: string; name: string; kind: "permission" | "question" | "error"; text: string; }
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  /** 只展示队首提醒：其余继续排队，前一条处理完后再依次露出 */
  const visibleAlert = alerts[0] ?? null;
  const lastAnimatedAlertKey = useRef<string | null>(null);
  const dismissAlert = (key: string) => setAlerts((a) => a.filter((x) => x.key !== key));
  // 打开某个会话后，自动关闭与它相关的通知：完成通知(通知中心) + 完成弹卡 + 待答/授权提醒。
  // 用户已经在看这个会话了，这些提醒就没必要再留着。
  useEffect(() => {
    if (!chatId) return;
    setNotices((prev) => {
      const next = prev.filter((n) => n.sessionId !== chatId);
      if (next.length === prev.length) return prev;
      try { localStorage.setItem("atrium.notices", JSON.stringify(next)); } catch {}
      return next;
    });
    setDoneCard((cur) => (cur && cur.sessionId === chatId ? null : cur));
    setAlerts((a) => (a.some((x) => x.sessionId === chatId) ? a.filter((x) => x.sessionId !== chatId) : a));
  }, [chatId]);
  // 被「忽略」的提问 id（本地持久化）：卡片和提醒都隐藏，不再打扰
  const [ignoredPending, setIgnoredPending] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem("atrium.ignoredPending") || "[]")); } catch { return new Set<string>(); }
  });
  const ignorePending = (qid: string) => {
    setIgnoredPending((s) => { const n = new Set(s); n.add(qid); try { localStorage.setItem("atrium.ignoredPending", JSON.stringify([...n])); } catch {} return n; });
    setAlerts((a) => a.filter((x) => !x.key.endsWith(`:q:${qid}`)));
  };
  const pendingItems = useMemo(() => {
    const out: AlertItem[] = [];
    for (const nd of snap?.nodes ?? []) {
      for (const p of nd.pendingPermissions ?? []) {
        out.push({ key: `${nd.id}:p:${p.id}`, nodeId: nd.id, sessionId: (p as any).sessionID, name: aliasOf(nd), kind: "permission", text: String(p.permission ?? "授权请求") });
      }
      for (const q of nd.pendingQuestions ?? []) {
        if (ignoredPending.has(q.id)) continue;
        out.push({ key: `${nd.id}:q:${q.id}`, nodeId: nd.id, sessionId: (q as any).sessionID, name: aliasOf(nd), kind: "question", text: String(q.questions?.[0]?.question ?? "等待回答") });
      }
    }
    return out;
  }, [snap, aliases, ignoredPending]);
  const seenPending = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = new Set(pendingItems.map((p) => p.key));
    // 首次进入只做基线，不为存量待处理刷屏
    if (seenPending.current === null) { seenPending.current = keys; return; }
    const fresh = pendingItems.filter((p) => !seenPending.current!.has(p.key));
    seenPending.current = keys;
    if (!fresh.length) return;
    setAlerts((a) => [...a, ...fresh].slice(-4));
    for (const f of fresh) window.setTimeout(() => dismissAlert(f.key), 20000);
    const cfg = notifyRef.current;
    if (cfg.sound) chime("awaiting");
    if (cfg.desktop) {
      const f = fresh[0];
      desktopNotify(`待处理 · ${f.name}`, `[${f.kind === "permission" ? "授权" : "提问"}] ${f.text}`.slice(0, 180), f.key);
    }
    if (cfg.focus) { setSelectedId(fresh[fresh.length - 1].nodeId); setPanelOpen(true); }
  }, [pendingItems]);

  const seenSessionErrors = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = new Set<string>();
    const fresh: AlertItem[] = [];
    for (const nd of snap?.nodes ?? []) {
      const sessById = new Map((nd.sessions ?? []).map((s) => [s.id, s]));
      for (const s of nd.sessions ?? []) {
        if (!s.lastError || !s.lastErrorAt) continue;
        const key = `${nd.id}:e:${s.id}:${s.lastErrorAt}`;
        keys.add(key);
        if (seenSessionErrors.current && !seenSessionErrors.current.has(key)) {
          fresh.push({ key, nodeId: nd.id, sessionId: s.id, name: aliasOf(nd), kind: "error", text: String(s.lastError) });
        }
      }
      for (const e of (nd.recentEvents ?? []) as any[]) {
        if (e.type !== "session.error" || !e.ts || Date.now() - e.ts > 300_000) continue;
        const sid = e.sessionID || "";
        const s = sid ? sessById.get(sid) : undefined;
        if (s?.lastError && Math.abs((s.lastErrorAt ?? 0) - e.ts) < 2000) continue;
        const key = `${nd.id}:e:${sid}:${e.ts}`;
        if (keys.has(key)) continue;
        keys.add(key);
        if (seenSessionErrors.current && !seenSessionErrors.current.has(key)) {
          fresh.push({ key, nodeId: nd.id, sessionId: sid || undefined, name: aliasOf(nd), kind: "error", text: String(e.summary || "执行出错").replace(/^error:\s*/, "") });
        }
      }
    }
    if (seenSessionErrors.current === null) {
      seenSessionErrors.current = keys;
      return;
    }
    seenSessionErrors.current = keys;
    if (!fresh.length) return;
    setAlerts((a) => [...a, ...fresh].slice(-4));
    const tgt = fresh[fresh.length - 1];
    for (const f of fresh) window.setTimeout(() => dismissAlert(f.key), 20000);
    const cfg = notifyRef.current;
    if (cfg.sound) chime("awaiting");
    if (cfg.desktop) {
      const f = fresh[0];
      desktopNotify(`执行出错 · ${f.name}`, f.text.slice(0, 180), f.key);
    }
    if (cfg.focus) {
      setSelectedId(tgt.nodeId);
      if (tgt.sessionId) {
        pendingOpenRef.current = tgt.sessionId;
        setChatId(tgt.sessionId);
      }
      setPanelOpen(true);
    }
  }, [snap?.generatedAt]);

  // 队首提醒变化时才做一次灵动球提示（后续提醒继续排队，不打断当前展示）
  useEffect(() => {
    if (!visibleAlert) { lastAnimatedAlertKey.current = null; return; }
    if (lastAnimatedAlertKey.current === visibleAlert.key) return;
    lastAnimatedAlertKey.current = visibleAlert.key;
    const t = window.setTimeout(() => flyBallToWhenReady(`[data-alert-key="${visibleAlert.key}"]`), 60);
    return () => clearTimeout(t);
  }, [visibleAlert?.key]);

  const pendingCount = pendingItems.length;
  const peerMismatch = (snap?.discovered ?? []).filter((d) => d.mismatch).length;

  /* ===== 版本检查：有新版本提示一次，并给「帮助」按钮加徽标 ===== */
  const [update, setUpdate] = useState<{ latest: string | null; hasUpdate: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch("/api/update").then((x) => x.json());
        if (alive && r?.ok) setUpdate({ latest: r.latest, hasUpdate: r.hasUpdate });
      } catch { /* 离线就不打扰 */ }
    };
    void check();
    const iv = setInterval(check, 30 * 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  useEffect(() => {
    if (!update?.hasUpdate || !update.latest) return;
    const t = setTimeout(() => showToast(`发现新版本 v${update.latest}：顶栏「帮助」里可一键升级`), 4000);
    return () => clearTimeout(t);
  }, [update?.hasUpdate, update?.latest]);

  /* ===== 首次组网引导：全新安装（没走过引导）就弹，重装会重新走一遍 ===== */
  const peers = snap?.discovered ?? [];
  const dismissedRef = useRef(false);
  useEffect(() => {
    if (!snap?.self) return;
    if (snap.self.onboarded) {
      if (!dismissedRef.current) setJoinOpen(false);
      return;
    }
    setJoinOpen(true);
  }, [snap?.self?.onboarded, snap?.self?.id]);
  const dismissJoin = () => setJoinOpen(false);
  useEffect(() => {
    document.title = notify.title && pendingCount > 0 ? `(${pendingCount}) 太和` : "太和";
  }, [notify.title, pendingCount]);

  /* ===== 展示风格：其它视图共用的数据切片（只含会话球） ===== */
  // 通知涉及的会话：项目卡片/轨道球显示角标；轨道据此保留非运行中的球
  const noticeSess = useMemo(() => new Set(notices.map((n) => n.sessionId).filter(Boolean) as string[]), [notices]);
  const noticeOrbSet = useMemo(() => {
    const set = new Set<string>();
    for (const o of sessionOrbs) {
      const sid = (o as any).sessions?.[0]?.id;
      if (sid && noticeSess.has(sid)) set.add(o.id);
    }
    return set;
  }, [sessionOrbs, noticeSess]);

  const viewItems = useMemo(
    () => [...processOrbs, ...sessionOrbs.filter((n) => ballKeep(n) || noticeOrbSet.has(n.id))],
    [processOrbs, sessionOrbs, view, filter, noticeOrbSet]
  );
  const orbitLanes = useMemo(
    () => lanes.map((l) => ({ ...l, items: l.items.filter((i) => ballKeep(i) || noticeOrbSet.has(i.id)) })),
    [lanes, view, filter, noticeOrbSet]
  );
  // 运行中的会话数（节点 busy 会话 + 活跃 run 进程）：驱动粒子特效密度/强度
  const runningCount = useMemo(() => {
    let n = 0;
    for (const nd of snap?.nodes ?? []) n += nd.busyCount ?? 0;
    for (const r of snap?.runAgents ?? []) if ((r as any).active) n++;
    return n;
  }, [snap]);
  // 置顶按实体存储；展示时映射到该实体的所有会话球，视图组件无需感知
  const pinsExpanded = useMemo(() => {
    const set = new Set(pins);
    for (const so of sessionOrbs) {
      const h = (so as any).hostId ?? (so as any).raHost;
      if (h && pins.includes(h)) set.add(so.id);
    }
    for (const id of sessPinSet) set.add(id);
    return [...set];
  }, [pins, sessionOrbs, sessPinSet]);
  const viewProps = {
    colorOf, aliasOf, machineOf: machineNameOf, stateOf, tagOf, pins: pinsExpanded, selectedId, hexOf, hexOn,
    activity: runningCount,
    noticeIds: noticeOrbSet,
    onSelect: (id: string) => selectOrb(id),
    onContext: (e: React.MouseEvent, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      setCtx({ x: e.clientX, y: e.clientY, id });
    },
    onUnpin: (id: string) => {
      const it = sessionOrbs.find((s) => s.id === id) ?? items.find((i) => i.id === id);
      togglePin(apiIdOf(it ?? { id }));
    },
    onRenameSession: (nodeId: string, sessionId: string, value: string) => { void renameSession(sessionId, nodeId, value); },
  };
  // 执行中球的任务提示：只提示关键节点（工具调用/文件编辑/错误/授权），噪音事件不上气泡
  const KEY_HINT = (e: any): string | null => {
    const s = String(e.summary ?? "");
    if (e.type === "message.part.updated" && s.startsWith("tool:")) {
      return s.replace(/\s+(running|pending)$/i, "").replace(/^tool:/, "⌘ ");
    }
    if (e.type === "file.edited") return "✎ " + s.replace(/^file\s*/, "");
    if (e.type === "session.error") return "✗ " + s.replace(/^error:\s*/, "");
    if (e.type === "permission.updated") return "⚡ " + s.replace(/^PERMISSION\s*/, "");
    return null;
  };
  const hintsOf = (nd: any): string[] => {
    if (stateOf(nd) !== "writing" || hintsOff[nd.id]) return [];
    const out: string[] = [];
    for (const e of (nd.recentEvents ?? []) as any[]) {
      if (Date.now() - (e.ts ?? 0) > 120_000) continue;
      const h = KEY_HINT(e);
      if (!h || out.includes(h)) continue;
      out.push(h);
      if (out.length >= 2) break;
    }
    return out;
  };

  /* ===== keyboard ===== */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
        setCmdQuery("");
        setCmdIdx(0);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        setWhisperOpen((o) => !o);
      } else if (e.key === "Escape") {
        if (chatIdRef.current) {
          e.preventDefault();
          setPanelOpen(false);
          return;
        }
        setHexViewId(null);
        setCmdOpen(false);
        setWhisperOpen(false);
        setSettingsFor(null);
        setCtx(null);
setConfirm(null);
        setThemeOpen(false);
        setSettingsMenuOpen(false);
        setPanelMenuOpen(false);
        setNotifyOpen(false);
        setNoticeOpen(false);
        setEventsOpen(false);
        setTopoOpen(false);
        setJoinOpen(false);
        setHelpOpen(false);
      } else if (
        e.key.toLowerCase() === "v" &&
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        setViewState((cur) => {
          const i = VIEWS.findIndex((x) => x.id === cur);
          const next = VIEWS[(i + 1) % VIEWS.length].id;
          localStorage.setItem("atrium.view", next);
          return next;
        });
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    const close = () => setCtx(null);
    if (ctx) {
      window.addEventListener("click", close);
      return () => window.removeEventListener("click", close);
    }
  }, [ctx]);

  useEffect(() => {
    const close = () => setThemeOpen(false);
    if (themeOpen) {
      window.addEventListener("click", close);
      return () => window.removeEventListener("click", close);
    }
  }, [themeOpen]);

  useEffect(() => {
    const close = () => setSettingsMenuOpen(false);
    if (settingsMenuOpen) {
      window.addEventListener("click", close);
      return () => window.removeEventListener("click", close);
    }
  }, [settingsMenuOpen]);

  useEffect(() => {
    const close = () => setPanelMenuOpen(false);
    if (panelMenuOpen) {
      window.addEventListener("click", close);
      return () => window.removeEventListener("click", close);
    }
  }, [panelMenuOpen]);

  type CmdEntry =
    | { kind: "agent"; id: string; label: string; color: string; st: AgentState; machine?: string; nd: any }
    | { kind: "sess"; id: string; label: string; color: string; nodeId: string; nodeLabel: string; busy: boolean };

  const cmdItems = useMemo<CmdEntry[]>(() => {
    const q = cmdQuery.toLowerCase();
    const out: CmdEntry[] = [];
    // 只遍历实体（节点/进程）；会话条目由实体展开，避免与会话球重复
    for (const nd of allNodes(snap)) {
      const label = aliasOf(nd);
      const hay = (label + " " + ((nd as any).workDir ?? "") + " " + ((nd as any).machine ?? "")).toLowerCase();
      if (!q || hay.includes(q)) {
        out.push({ kind: "agent", id: nd.id, label, color: colorOf(nd), st: stateOf(nd), machine: (nd as any).machine, nd });
      }
      // 该 agent 下的会话
      for (const s of nd.sessions ?? []) {
        const t = sessAliases[s.id] || s.title || s.id;
        if (q && !t.toLowerCase().includes(q) && !label.toLowerCase().includes(q)) continue;
        out.push({ kind: "sess", id: `${nd.id}::${s.id}`, label: t, color: s.busy ? STATE_COLORS.writing : STATE_COLORS.done, nodeId: nd.id, nodeLabel: label, busy: s.busy });
      }
    }
    return out;
  }, [snap, cmdQuery, aliases, sessAliases]);

  /* ===== actions ===== */
  const togglePin = (id: string) => {
    setPins((p) => {
      const n = p.includes(id) ? p.filter((x) => x !== id) : [...p, id];
      localStorage.setItem("atrium.pins", JSON.stringify(n));
      return n;
    });
    const nowPinned = !pins.includes(id);
    writeTeamKV(`pin:${id}`, nowPinned ? true : null);
  };

  const sendSteer = async (text: string) => {
    if (!chatNode) return;
    const sessId = chatSess?.id ?? chatId ?? latestSession(chatNode)?.id;
    if (!sessId) return;
    const t = text.trim();
    // @ 会话名 + 任务 → 当前 agent 以自己的名义去调目标会话，结果回到当前聊天窗
    const fwdMatch = t.match(/^@([^\s]+)\s+(.+)$/s);
    if (fwdMatch) {
      const targetName = fwdMatch[1];
      const taskText = fwdMatch[2].trim();
      // 在所有节点的会话里找匹配的（标题/别名/ID）
      let target: { nodeId: string; sessionId: string; label: string; dir?: string } | null = null;
      for (const nd of snap?.nodes ?? []) {
        for (const s of nd.sessions ?? []) {
          const label = sessAliases[s.id] || s.title || "";
          if (label === targetName || s.id === targetName || (label && label.toLowerCase().includes(targetName.toLowerCase()))) {
            target = { nodeId: nd.id, sessionId: s.id, label, dir: s.directory };
            break;
          }
        }
        if (target) break;
      }
      if (target) {
        // 不是直接转发，而是让当前 agent 自己去调目标会话、拿结果、回复
        const apiNode = encodeURIComponent(target.nodeId);
        const apiSess = encodeURIComponent(target.sessionId);
        const promptText = `用户要你以自己的名义去调用另一个会话的 agent 来完成任务，并把结果带回这个对话。

目标会话：「${target.label}」
所在机器节点：${target.nodeId}
会话 ID：${target.sessionId}
会话目录：${target.dir || "—"}

任务内容：
${taskText}

请按以下步骤操作（用 bash 工具执行）：

第 1 步 — 发送任务给目标会话：
\`\`\`bash
curl -s -X POST http://127.0.0.1:${snap?.self?.port ?? 6080}/api/nodes/${apiNode}/sessions/${apiSess}/prompt \\
  -H 'content-type: application/json' \\
  -d '{"text":${JSON.stringify(JSON.stringify(taskText))}}'
\`\`\`

第 2 步 — 轮询等待目标 agent 回复（每隔 5 秒检查一次，最多等 3 分钟）：
\`\`\`bash
# 循环检查：目标会话的消息列表里，最后一条 assistant 消息是否在发送任务之后产生
for i in $(seq 1 36); do
  sleep 5
  resp=$(curl -s http://127.0.0.1:${snap?.self?.port ?? 6080}/api/nodes/${apiNode}/sessions/${apiSess}/messages)
  # 提取最后一条 assistant 的文本
  answer=$(echo "$resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
msgs=d.get('messages',[])
for m in reversed(msgs):
    if m.get('info',{}).get('role')=='assistant':
        for p in m.get('parts',[]):
            if p.get('type')=='text' and p.get('text','').strip():
                print(p['text'][:3000])
                sys.exit(0)
print('')
")
  if [ -n \"\$answer\" ]; then
    echo \"=== 目标 agent 回复 ===\"
    echo \"\$answer\"
    break
  fi
  echo \"第 \$i 次检查：目标 agent 还没回复，继续等...\"
done
\`\`\`

第 3 步 — 如果拿到了回复，把目标 agent 的回复总结后告诉用户。
如果 3 分钟内没回复，告诉用户「目标会话还在处理中，稍后可以手动去查看」。

注意：你是在帮用户代理调用另一个 agent，拿到结果后要在当前对话里回复用户，不要自己执行用户没要求的事情。`;
        const sel = effModel && effModel.providerID && effModel.modelID ? effModel : undefined;
        const r: any = await post(`/api/nodes/${apiIdOf(chatNode)}/sessions/${sessId}/prompt`, { text: promptText, ...(sel ? { model: sel } : {}) });
        if (r?.ok) {
          setAttachFiles([]);
          setPendingUser(`→ @${target.label}：${taskText.slice(0, 50)}${taskText.length > 50 ? "…" : ""}`);
          showToast(`已让当前 agent 去调「${target.label}」，结果会回到这里`);
        } else {
          showToast(`发送失败：${r?.error ?? ""}`);
        }
        writeDraft("");
        return;
      }
      // 找不到匹配的会话 → 当普通消息发
    }
    const parts: any[] = [];
    for (const f of attachFiles) parts.push({ type: "file", mime: f.mime, filename: f.name, url: `data:${f.mime};base64,${f.data}` });
    if (t) parts.push({ type: "text", text: t });
    if (!parts.length) return;
    // 带上当前选中的模型（providerID + modelID 都有效时才提交，避免误清空）
    const sel = effModel && effModel.providerID && effModel.modelID ? effModel : undefined;
    const r: any = attachFiles.length
      ? await post(`/api/nodes/${apiIdOf(chatNode)}/sessions/${sessId}/prompt-parts`, { parts, ...(sel ? { model: sel } : {}) })
      : await post(`/api/nodes/${apiIdOf(chatNode)}/sessions/${sessId}/prompt`, { text: t, ...(sel ? { model: sel } : {}) });
    if (r?.ok) { setAttachFiles([]); if (t) setPendingUser(t); showPanelToast(attachFiles.length ? `已寄出（含 ${attachFiles.length} 个附件）` : "已寄出"); }
    else showToast(r?.error ?? "发送失败");
  };

  const sendAbort = async () => {
    if (!chatNode) return;
    const sessId = chatSess?.id ?? chatId ?? latestSession(chatNode)?.id;
    if (!sessId) return;
    await post(`/api/nodes/${apiIdOf(chatNode)}/sessions/${sessId}/abort`, {});
    showToast("已中止");
  };

  const pickFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    const list = Array.from(files);
    // 先乐观上屏：立刻能看到文件 chip，再异步读内容填充（大文件也不会有"只提示不显示"的空档）
    const items = list.map((f) => ({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: f.name || "文件", mime: f.type || "application/octet-stream", data: "" }));
    setAttachFiles((prev) => [...prev, ...items]);
    list.forEach((f, i) => {
      const it = items[i];
      // 用 file.arrayBuffer() 读，比 readAsDataURL 更稳（大文件/某些文件不会失败）
      f.arrayBuffer()
        .then((buf) => { const data = abToBase64(buf); setAttachFiles((prev) => prev.map((x) => (x.id === it.id ? { ...x, data } : x))); })
        .catch((err: any) => {
          setAttachFiles((prev) => prev.filter((x) => x.id !== it.id));
          showToast(`读取失败：${it.name} —— ${(err?.name || "") + (err?.message ? " · " + err.message : "") || "未知错误"}`);
        });
    });
  };

  // 拖拽文件到聊天窗上传：窗口级监听最稳，并阻止浏览器直接打开被拖入的文件
  const attachCtxRef = useRef<{ can: () => boolean; pick: (f: FileList | null) => void } | null>(null);
  attachCtxRef.current = {
    can: () => Boolean(panelOpen && chatNode && !chatDisabled && capOk(chatNode, "attach")),
    pick: pickFiles,
  };
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const isBallDrag = () => ballDragRef.current;
    const onOver = (e: DragEvent) => {
      if (isBallDrag()) return; // 灵动球拖动不触发附件蒙层
      if (!attachCtxRef.current?.can() || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    };
    const onLeave = (e: DragEvent) => { if (!e.relatedTarget) setDragOver(false); };
    const onDrop = (e: DragEvent) => {
      if (isBallDrag()) return;
      if (!attachCtxRef.current?.can()) return;
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files ?? null;
      if (files && files.length) { attachCtxRef.current.pick(files); showToast(`已添加 ${files.length} 个附件`); }
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => { window.removeEventListener("dragover", onOver); window.removeEventListener("dragleave", onLeave); window.removeEventListener("drop", onDrop); };
  }, []);

  /* ===== 输入框 / 命令 与 @ 上下文 ===== */
  const SLASH_CMDS = [
    { id: "new", feat: "new", icon: "＋", label: "新建会话", desc: "在当前节点开一个新会话" },
    { id: "compact", feat: "compact", icon: "🫧", label: "压缩上下文", desc: "opencode 总结会话，压缩上下文" },
    { id: "undo", feat: "undo", icon: "↩", label: "撤销", desc: "撤销最后一条助手消息" },
    { id: "redo", feat: "redo", icon: "↪", label: "重做", desc: "恢复被撤销的消息" },
    { id: "share", feat: "share", icon: "🔗", label: "分享会话", desc: "生成分享链接并复制" },
    { id: "unshare", feat: "unshare", icon: "🔒", label: "取消分享", desc: "停止该会话的分享" },
    { id: "fork", feat: "fork", icon: "🌿", label: "分叉会话", desc: "从最后一条助手消息开新会话" },
    { id: "abort", feat: "abort", icon: "■", label: "中止任务", desc: "打断当前会话正在跑的任务" },
    { id: "clear", icon: "✕", label: "清空输入", desc: "清空输入框与已选附件" },
    { id: "help", icon: "？", label: "帮助", desc: "打开帮助与快捷键说明" },
  ] as { id: string; feat?: string; icon: string; label: string; desc: string }[];
  const OC_CMDS = new Set(["compact", "undo", "redo", "share", "unshare", "fork"]);
  const OC_DONE: Record<string, string> = { compact: "已压缩上下文", undo: "已撤销", redo: "已重做", unshare: "已取消分享", fork: "已分叉新会话" };
  const runSlash = async (id: string) => {
    if (id === "new") { openNewSession((chatNode as any)?.dirs?.[0]); return; }
    if (id === "clear") { setAttachFiles([]); return; }
    if (id === "abort") { void sendAbort(); return; }
    if (id === "help") { setHelpOpen(true); return; }
    if (!OC_CMDS.has(id)) return;
    const sessId = chatSess?.id ?? chatId ?? latestSession(chatNode)?.id;
    if (!chatNode || !sessId) { showToast("没有可操作的会话"); return; }
    const r: any = await post(`/api/nodes/${apiIdOf(chatNode)}/sessions/${sessId}/command`, { command: id });
    if (id === "share") {
      if (r?.ok && r?.url) {
        try { await navigator.clipboard.writeText(r.url); showToast("已分享，链接已复制到剪贴板"); }
        catch { showToast(`分享链接：${r.url}`); }
      } else showToast(r?.error ?? "分享失败");
      return;
    }
    showToast(r?.ok ? (OC_DONE[id] ?? "已执行") : (r?.error ?? "命令失败"));
  };
  // 当前面板候选项（slash 命令 或 @ 引用的目录/会话）
  const mentionItems = (() => {
    if (!ment || !chatNode) return [] as { icon: string; label: string; sub?: string; kind: "slash" | "dir" | "sess"; id: string }[];
    const q = ment.q.toLowerCase();
    if (ment.kind === "slash") {
      return SLASH_CMDS
        .filter((c) => (!c.feat || capOk(chatNode, c.feat)) && (!q || c.id.includes(q) || c.label.toLowerCase().includes(q)))
        .map((c) => ({ kind: "slash" as const, id: c.id, icon: c.icon, label: `/${c.id}`, sub: c.desc }));
    }
    const out: { icon: string; label: string; sub?: string; kind: "dir" | "sess"; id: string }[] = [];
    for (const d of ((chatNode as any).dirs ?? [])) {
      const name = dirAliases[d] || d.split(/[\\/]/).filter(Boolean).pop() || d;
      if (q && !name.toLowerCase().includes(q)) continue;
      out.push({ kind: "dir", id: `dir:${d}`, icon: "📁", label: name, sub: d });
    }
    for (const s of chatNode.sessions ?? []) {
      const label = sessAliases[s.id] || s.title || s.id;
      if (q && !label.toLowerCase().includes(q)) continue;
      out.push({ kind: "sess", id: `sess:${s.id}`, icon: "💬", label, sub: s.id === chatId ? "当前会话" : (s.busy ? "进行中" : "会话") });
    }
    // 也搜索其它节点上的会话（跨节点 @ 转发）
    for (const nd of snap?.nodes ?? []) {
      if (nd.id === chatNode.id) continue;
      for (const s of nd.sessions ?? []) {
        const label = sessAliases[s.id] || s.title || "";
        if (!label) continue;
        if (q && !label.toLowerCase().includes(q)) continue;
        out.push({ kind: "sess", id: `sess:${s.id}`, icon: "💬", label, sub: `${aliasOf(nd)} · ${s.busy ? "进行中" : "会话"}` });
      }
    }
    return out;
  })();
  const applyMention = (it: { kind: string; id: string; label: string }) => {
    if (!ment) return;
    const before = draft.slice(0, ment.at);
    const after = draft.slice(ment.end);
    if (ment.kind === "slash") {
      void runSlash(it.id);
      writeDraft(it.id === "clear" ? "" : before + after);
      setMent(null);
      return;
    }
    const insert = `@${it.label} `;
    const next = before + insert + after;
    writeDraft(next);
    // 记录 @ 提到的位置区间（只读保护：不能修改内部字符，只能整体删除）
    const mentionStart = before.length;
    const mentionEnd = before.length + insert.length - 1; // 不含末尾空格
    setAtMentions((prev) => [...prev, { start: mentionStart, end: mentionEnd, label: it.label }]);
    setMent(null);
    requestAnimationFrame(() => {
      const el = steerRef.current;
      if (el) { el.focus(); const pos = before.length + insert.length; el.setSelectionRange(pos, pos); }
    });
  };
  const [atMentions, setAtMentions] = useState<{ start: number; end: number; label: string }[]>([]);
  const handleDraft = (value: string, cursor: number) => {
    // 保护 @ 提到内容：mention 区间内的文本不可修改（打字/粘贴/替换都拦），只能整体删除
    if (atMentions.length > 0) {
      for (const m of atMentions) {
        if (m.end <= value.length) {
          const orig = draft.slice(m.start, m.end);
          const now = value.slice(m.start, m.end);
          if (now !== orig) {
            // mention 被改了 → 不更新 draft，React 受控组件自动恢复
            return;
          }
        }
      }
      // 检查是否有 mention 被整体删掉了 → 清理记录
      const surviving = atMentions.filter((m) => {
        if (m.end > value.length) return false;
        return value.slice(m.start, m.end) === draft.slice(m.start, m.end);
      });
      if (surviving.length !== atMentions.length) setAtMentions(surviving);
    }
    writeDraft(value);
    const before = value.slice(0, cursor);
    const m = /(?:^|\s)([@/])([^\s@/]*)$/.exec(before);
    if (m) {
      const kind = m[1] === "/" ? "slash" : "at";
      const q = m[2];
      const at = before.length - 1 - q.length;
      setMent({ kind, q, at, end: cursor });
      setMentIdx(0);
    } else {
      setMent(null);
    }
  };
  const doSend = () => {
    const val = draft;
    if (val.trim() || attachFiles.length) {
      void sendSteer(val);
      writeDraft("");
      setAtMentions([]);
      const el = steerRef.current;
      if (el) el.style.height = "auto";
    }
  };

  const confirmFinished = async () => {
    if (!selected) return;
    const r: any = await post("/api/runagents/dismiss", { id: selected.id });
    if (r?.ok) {
      setSelectedId(null);
      setPanelOpen(false);
      // 任务已彻底结束，同步清掉置顶，避免幽灵残留
      setPins((p) => {
        const n = p.filter((x) => x !== selected.id);
        localStorage.setItem("atrium.pins", JSON.stringify(n));
        return n;
      });
      showToast("已确认完成");
    } else showToast("操作失败");
  };

  const sendWhisper = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    const target = chatNode ?? items.find((n) => isServer(n) && stateOf(n) !== "asleep");
    if (!target || !isServer(target)) { showToast("没有可对话的 agent"); return; }
    const sess = chatSess ?? latestSession(target);
    if (!sess) { showToast("无可用会话"); return; }
    const r: any = await post(`/api/nodes/${apiIdOf(target)}/sessions/${sess.id}/prompt`, { text: t });
    if (r?.ok) { setSelectedId(target.id); showPanelToast(`已寄出 → ${aliasOf(target)} · ${sess.title || sess.id}`); }
    else showToast(r?.error ?? "发送失败");
  };

  /* ===== derived panel data ===== */
  const selState = selected ? stateOf(selected) : null;
  const selTokens = selected ? (selected.sessions ?? []).reduce((a: number, s: SessionView) => a + (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0), 0) : 0;
  const ctxPct = Math.min(100, (selTokens / CTX_CAP) * 100);
  // 低语目标 = 灵动球所代表的对象（selected → chatNode），会话 = 灵动球当前打开的会话（chatSess）
  const whisperTarget = chatNode ?? (items.find((n) => isServer(n) && stateOf(n) !== "asleep") ?? null);
  const whisperSess = chatSess ?? (whisperTarget?.sessions?.length ? latestSession(whisperTarget) : null);

  /* ===== 灵动球：完整交互（环形菜单 / HUD / 滚轮切换 / 边缘吸附 / 拖放） ===== */
  const BALL_SIZE = 72;
  const dirNameOf = (d?: string) => (d || "").split(/[\\/]/).filter(Boolean).pop() || d || "";
  const hostAddrOf = (url?: string) => {
    try { const u = new URL(url || ""); return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`; } catch { return ""; }
  };
  const ballSess: SessionView | null = chatSess ?? ((selected?.sessions?.[0] as SessionView | undefined) ?? null) ?? (chatNode ? latestSession(chatNode) ?? null : null);
  const ballSessionId = ballSess?.id ?? null;
  const ballHostId = chatNode ? apiIdOf(chatNode) : (selected ? apiIdOf(selected) : "");
  const ballHostNode = ballHostId ? nodeById.get(ballHostId) ?? null : null;
  const ballDir = ballSess?.directory || "";
  const ballPending = selected ? ((selected as any).pendingPermissions?.length ?? 0) + ((selected as any).pendingQuestions?.length ?? 0) : 0;
  const ballPinned = ballSessionId ? sessPins.includes(ballSessionId) : (selected ? pins.includes(apiIdOf(selected)) : false);
  const ballMachine = machineNameOf(selected ?? chatNode ?? {});
  const ballHints = selected ? hintsOf(selected) : [];
  const ballInfo: BallHudInfo | null = selected ? {
    title: ballSess ? (sessAliases[ballSess.id] || ballSess.title || ballSess.id) : aliasOf(selected),
    state: selState ? STATE_CN[selState] : "",
    machine: ballMachine,
    host: hostAddrOf(ballHostNode?.url),
    dir: ballDir ? (dirAliases[ballDir] || dirNameOf(ballDir)) : "",
    model: ballSess?.model || ballSess?.agent || "",
    pending: ballPending,
    busy: !!ballSess?.busy,
    ago: ballSess?.updatedAt ? `${ago(ballSess.updatedAt)}前` : "",
    hints: ballHints,
  } : null;

  const ballCandidates = useMemo(() => sessionOrbs
    .map((o: any) => ({ orbId: String(o.id), sess: (o.sessions?.[0] ?? null) as SessionView | null }))
    .filter((x) => x.sess)
    .sort((a, b) => (b.sess!.updatedAt ?? 0) - (a.sess!.updatedAt ?? 0))
    .slice(0, ballWheelCount), [sessionOrbs, ballWheelCount]);

  const persistFloatPos = (p: { l: number | null; t: number | null }) => {
    floatPosRef.current = p;
    setFloatPos(p);
    try { localStorage.setItem("atrium.floatPos", JSON.stringify(p)); } catch {}
  };
  const persistBallSnap = (s: { edge: "left" | "right" | "top" | "bottom"; off: number } | null) => {
    setBallSnap(s);
    try {
      if (s) localStorage.setItem("atrium.floatSnap", JSON.stringify(s));
      else localStorage.removeItem("atrium.floatSnap");
    } catch {}
  };
  const clampSnapOff = (edge: "left" | "right" | "top" | "bottom", off: number) => {
    const max = (edge === "left" || edge === "right" ? window.innerHeight : window.innerWidth) - BALL_SIZE - 8;
    return Math.max(8, Math.min(off, max));
  };
  const clearBallHud = () => {
    if (hudTimer.current != null) { clearTimeout(hudTimer.current); hudTimer.current = null; }
    setBallHud(null);
  };
  const showBallHud = () => {
    const r = ballRef.current?.getBoundingClientRect();
    if (!r || ballDrag || ballMenu || chatLoading || whisperOpen) return;
    const w = 272;
    const h = 156;
    let x = r.right + 12;
    let y = r.top + r.height / 2 - h / 2;
    if (x + w > window.innerWidth - 12) x = r.left - w - 12;
    if (x < 12) x = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    y = Math.max(12, Math.min(y, window.innerHeight - h - 12));
    setBallHud({ x, y });
  };
  const scheduleBallHud = () => {
    clearBallHud();
    hudTimer.current = window.setTimeout(showBallHud, 500);
  };
  const openBallMenuAt = (r?: DOMRect) => {
    const rect = r || ballRef.current?.getBoundingClientRect();
    if (!rect) return;
    clearBallHud();
    setBallMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };
  const resetBallHome = () => {
    persistBallSnap(null);
    persistFloatPos({ l: null, t: null });
    setBallMenu(null);
    clearBallHud();
    showToast("灵动球已归位");
  };
  const setBallVisiblePersist = (v: boolean) => {
    setBallVisible(v);
    try {
      if (v) localStorage.removeItem("atrium.floatBall");
      else localStorage.setItem("atrium.floatBall", "off");
    } catch {}
  };
  const setBallWheelCountPersist = (n: number) => {
    const v = Math.max(2, Math.min(50, Math.round(n) || 2));
    setBallWheelCount(v);
    try { localStorage.setItem("atrium.ballWheelCount", String(v)); } catch {}
  };
  const openBallCountMenu = (x: number, y: number) => {
    setBallMenu(null);
    clearBallHud();
    setBallCountMenu({ x, y });
  };
  const summonBall = () => {
    setBallVisiblePersist(true);
    let target: any = selected;
    if (!target) {
      target = sessionOrbs.find((n) => stateOf(n) === "writing")
        ?? sessionOrbs.find((n) => stateOf(n) === "awaiting")
        ?? sessionOrbs[0]
        ?? items.find((n) => isServer(n) && stateOf(n) !== "asleep")
        ?? items[0]
        ?? null;
      if (target) setSelectedId(target.id);
    }
    if (!target) {
      showToast("暂无可唤出的灵动球");
      return;
    }
    persistBallSnap(null);
    persistFloatPos({ l: (window.innerWidth - BALL_SIZE) / 2, t: (window.innerHeight - BALL_SIZE) / 2 });
    setBallMenu(null);
    clearBallHud();
    showToast("灵动球已唤出");
  };
  const summonBallRef = useRef(summonBall);
  summonBallRef.current = summonBall;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (((e.metaKey || e.ctrlKey) && e.shiftKey && k === "b") || (e.altKey && k === "b")) {
        e.preventDefault();
        summonBallRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const openBallChat = () => {
    if (!selected) return;
    if (chatNode && ballSess) {
      pendingOpenRef.current = ballSess.id;
      setChatId(ballSess.id);
    }
    setPanelOpen(true);
    setBallMenu(null);
    clearBallHud();
    window.setTimeout(() => steerRef.current?.focus(), 120);
  };
  const toggleBallFullscreen = () => {
    openBallChat();
    setChatFull((v) => !v);
  };
  const handleBallPending = () => {
    openBallChat();
    window.setTimeout(() => document.querySelector(".chat-pending")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 220);
  };
  const abortBall = () => {
    if (!chatNode || !ballSess) return;
    const nodeId = apiIdOf(chatNode);
    const sess = ballSess;
    askConfirm({
      title: "中止当前任务？",
      desc: `「${sess.title || sess.id}」正在运行的任务将被打断，已产生的改动会保留。`,
      okText: "中止",
      danger: true,
      onOk: async () => {
        await post(`/api/nodes/${nodeId}/sessions/${sess.id}/abort`, {});
        showToast("已中止");
      },
    });
  };
  const toggleBallPin = () => {
    if (ballSessionId) toggleSessPin(ballSessionId);
    else if (selected) togglePin(apiIdOf(selected));
    setBallMenu(null);
  };
  const copyBallInfo = async () => {
    const lines = [
      `会话：${ballInfo?.title || ""}`,
      ballSessionId ? `会话ID：${ballSessionId}` : "",
      `机器：${ballMachine}`,
      ballHostNode?.url ? `地址：${hostAddrOf(ballHostNode.url)}` : "",
      ballDir ? `目录：${ballDir}` : "",
      ballSess?.model ? `模型：${ballSess.model}` : "",
      ballSess?.agent ? `Agent：${ballSess.agent}` : "",
      `状态：${ballInfo?.state || ""}`,
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      showToast("会话信息已复制");
    } catch {
      showToast("复制失败");
    }
    setBallMenu(null);
  };
  const cycleBallSession = (direction: number) => {
    if (ballCandidates.length < 2) return;
    const idx = ballCandidates.findIndex((x) => x.sess?.id === ballSessionId);
    const next = ballCandidates[(idx + direction + ballCandidates.length) % ballCandidates.length] ?? ballCandidates[0];
    if (!next?.sess || next.sess.id === ballSessionId) return;
    setSelectedId(next.orbId);
    pendingOpenRef.current = next.sess.id;
    setChatId(next.sess.id);
    clearBallHud();
    showToast(`已切换 · ${sessAliases[next.sess.id] || next.sess.title || next.sess.id}`);
  };
  const wheelCycleRef = useRef(cycleBallSession);
  wheelCycleRef.current = cycleBallSession;
  useEffect(() => {
    const el = ballEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelCycleRef.current(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ballEl]);
  useEffect(() => {
    const onResize = () => {
      setBallMenu(null);
      clearBallHud();
      setBallSnap((s) => {
        if (!s) return null;
        const next = { ...s, off: clampSnapOff(s.edge, s.off) };
        try { localStorage.setItem("atrium.floatSnap", JSON.stringify(next)); } catch {}
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    setBallMenu(null);
    setBallCountMenu(null);
    setBallDrop(null);
    setSnapPreview(null);
    clearBallHud();
  }, [selectedId, view, whisperOpen, chatLoading]);
  useEffect(() => {
    if (!ballMenu && !ballCountMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setBallMenu(null); setBallCountMenu(null); } };
    const onClick = () => { setBallMenu(null); setBallCountMenu(null); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("click", onClick); };
  }, [ballMenu, ballCountMenu]);
  useEffect(() => () => {
    if (longPressTimer.current != null) clearTimeout(longPressTimer.current);
    if (hudTimer.current != null) clearTimeout(hudTimer.current);
  }, []);

  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const updateBallDrop = (x: number, y: number) => {
    const els = document.elementsFromPoint(x, y);
    const el = els.find((e) => !ballRef.current?.contains(e));
    if (!el) { setBallDrop(null); return; }
    const row = el.closest("[data-sess-id]") as HTMLElement | null;
    if (row?.dataset.sessId) {
      setBallDrop({ kind: "session", sessionId: row.dataset.sessId, nodeId: row.dataset.nodeId, rect: rectOf(row), action: "松手定位到该会话" });
      return;
    }
    const pin = el.closest('[data-ball-drop="pin-tab"]');
    if (pin) {
      setBallDrop({ kind: "pin", rect: rectOf(pin), action: ballPinned ? "松手取消置顶" : "松手置顶当前会话" });
      return;
    }
    const panel = el.closest(".panel");
    if (panel) {
      setBallDrop({ kind: "panel", rect: rectOf(panel), action: "松手打开当前会话" });
      return;
    }
    setBallDrop(null);
  };
  const performBallDrop = (d: NonNullable<typeof ballDrop>) => {
    if (d.kind === "session" && d.sessionId) {
      const nid = d.nodeId || ballHostId;
      const orbId = `${nid}::sess::${d.sessionId}`;
      const orb = sessionOrbs.find((o) => o.id === orbId);
      setSelectedId(orb ? orb.id : nid);
      pendingOpenRef.current = d.sessionId;
      setChatId(d.sessionId);
      showToast("已定位到会话");
    } else if (d.kind === "pin") {
      if (ballSessionId) toggleSessPin(ballSessionId);
      else if (selected) togglePin(apiIdOf(selected));
      showToast(ballPinned ? "已取消置顶" : "已置顶当前会话");
    } else if (d.kind === "panel") {
      openBallChat();
    }
  };

  const ballMenuItems: BallMenuItem[] = selected ? [
    { key: "chat", label: "对话", title: "打开当前会话并聚焦输入框", onClick: openBallChat },
    { key: "whisper", label: "低语", title: "唤起低语面板", onClick: () => setWhisperOpen(true) },
    { key: "full", label: chatFull ? "退出" : "全屏", title: chatFull ? "退出全屏聊天" : "全屏聊天", onClick: toggleBallFullscreen },
    ballPending > 0
      ? { key: "pending", label: "处理", title: `处理 ${ballPending} 项待确认`, active: true, onClick: handleBallPending }
      : ballSess?.busy
        ? { key: "abort", label: "中止", title: "中止当前任务", danger: true, onClick: abortBall }
        : { key: "new", label: "新建", title: "在同目录新建会话", onClick: () => openNewSession(ballDir || undefined) },
    { key: "pin", label: ballPinned ? "取消" : "置顶", title: ballPinned ? "取消置顶" : "置顶当前会话", active: ballPinned, onClick: toggleBallPin },
    { key: "count", label: `${ballWheelCount}个`, title: `滚轮切换数量：最近 ${ballWheelCount} 个会话`, active: true, onClick: () => openBallCountMenu(ballMenu?.x ?? window.innerWidth / 2, ballMenu?.y ?? window.innerHeight / 2) },
    { key: "copy", label: "复制", title: "复制会话 / 机器 / 目录信息", onClick: () => { void copyBallInfo(); } },
    { key: "settings", label: "设置", title: "别名 / 颜色 / 标签", onClick: () => { if (selected) setSettingsFor(selected.id); } },
    { key: "home", label: "归位", title: "灵动球回到默认位置", onClick: resetBallHome },
  ] : [];

  const snapPosStyle = (s: { edge: "left" | "right" | "top" | "bottom"; off: number }): CSSProperties => {
    if (s.edge === "left") return { left: -BALL_SIZE / 2, top: s.off, bottom: "auto" };
    if (s.edge === "right") return { left: window.innerWidth - BALL_SIZE / 2, top: s.off, bottom: "auto" };
    if (s.edge === "top") return { left: s.off, top: -BALL_SIZE / 2, bottom: "auto" };
    return { left: s.off, top: window.innerHeight - BALL_SIZE / 2, bottom: "auto" };
  };

  return (
    <>
      <div className="vig" />

      {/* ===== top bar ===== */}
      <header className="top">
        <div className="brand">
          <span className={`brand-mark ${connected ? "live" : "off"}`} title={connected ? "服务在线" : "服务离线"} aria-hidden>
            <svg width="22" height="22" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="48" fill="currentColor" />
              <path d="M50 2 A48 48 0 0 1 50 98 A25 25 0 0 1 50 50 A25 25 0 0 0 50 2 Z" fill="var(--bg-2)" />
              <circle cx="50" cy="26" r="7" fill="var(--bg-2)" />
              <circle cx="50" cy="74" r="7" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-name">太和</span>
          <Clock />
          <HaloBadge variant={connected ? "secondary" : "destructive"} live={connected} className="ml-1 font-mono text-[11px] tracking-wide">{connected ? "live" : "offline"}</HaloBadge>
        </div>

        <nav className="view-filter" aria-label="视图与状态筛选">
          <ViewSwitcher view={view} onChange={setView} />
          {view === "projects" && (
            <HaloSegmented
              className="pj-mode-top min-w-0"
              value={projMode}
              onValueChange={(v) => setProjMode(v as typeof projMode)}
              items={[
                { value: "group", label: <span title="按机器 → 目录聚合">分组</span> },
                { value: "time", label: <span title="按最近活动分桶：最近（1 天内） / 2 天 / 3 天 / 一周 / 两周 / 更久">时间</span> },
                { value: "tag", label: <span title="按自定义标签分组">标签</span> },
                { value: "pin", label: <span data-ball-drop="pin-tab" title="只看置顶会话">置顶</span> },
              ]}
            />
          )}
        </nav>

        <div className="top-actions">
          <HaloButton
            className="halo-btn-sm"
            onClick={() => openNewSession()}
            title="新建会话：选机器 + 目录"
          >
            <span className="tbtn-ic" aria-hidden>＋</span>
            <span className="tbtn-label">会话</span>
          </HaloButton>
          <button className={`tbtn bell ${unreadNotices + pendingCount > 0 ? "hot" : ""}`} onClick={() => {
            setNoticeOpen((o) => {
              if (!o) persistNotices(notices.map((n) => ({ ...n, seen: true })));
              return !o;
            });
          }} title="通知中心">
            <span className="tbtn-ic" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
          </span>
            <span className="tbtn-label">通知</span>
            {unreadNotices + pendingCount > 0 && <b className="bell-badge"><RollingNumber value={unreadNotices + pendingCount} /></b>}
          </button>
          <div className="pop-wrap">
            <button
              className={`tbtn bell ${peerMismatch || update?.hasUpdate ? "hot" : ""}`}
              onClick={(e) => { e.stopPropagation(); setSettingsMenuOpen((o) => !o); }}
              title="设置"
            >
              <span className="tbtn-ic" aria-hidden>⚙</span>
              <span className="tbtn-label">设置</span>
              {(peerMismatch + (update?.hasUpdate ? 1 : 0)) > 0 && <b className="bell-badge"><RollingNumber value={peerMismatch + (update?.hasUpdate ? 1 : 0)} /></b>}
            </button>
            {settingsMenuOpen && (
              <div className="pop pop--right pop-scroll" onClick={(e) => e.stopPropagation()}>
                <div className="pop-sec">主题 · 明暗</div>
                {MODES.map((m) => (
                  <button key={m.id} className={`pop-i ${mode === m.id ? "on" : ""}`} onClick={() => applyMode(m.id)}>
                    <span className="pop-ico">{m.ico}</span>
                    {m.name}
                    {mode === m.id && <span className="pop-ck">✓</span>}
                  </button>
                ))}
                <div className="pop-sec">主题 · 配色</div>
                {THEMES.map((t) => (
                  <button key={t.id} className={`pop-i ${theme === t.id ? "on" : ""}`} onClick={() => applyTheme(t.id)}>
                    <span className="pop-dot" style={{ background: t.acc }} />
                    {t.name}
                    {theme === t.id && <span className="pop-ck">✓</span>}
                  </button>
                ))}
                <div className="pop-div" />
                <button className="pop-i" onClick={() => { setSettingsMenuOpen(false); setSettingsFor("all"); }}>
                  <span className="pop-ico">✎</span>别名 / 颜色…
                </button>
                <button className="pop-i" onClick={() => { setSettingsMenuOpen(false); setEventsOpen(true); }}>
                  <span className="pop-ico">▤</span>事件
                </button>
                <button className="pop-i" onClick={() => { setSettingsMenuOpen(false); setTopoOpen(true); }}>
                  <span className="pop-ico">⬡</span>组网
                  {peerMismatch > 0 && <span className="pop-cnt">{peerMismatch}</span>}
                </button>
                <button className="pop-i" onClick={() => { setSettingsMenuOpen(false); setCmdOpen(true); }}>
                  <span className="pop-ico">⌘</span>命令面板
                </button>
                <button className="pop-i" onClick={() => { toggleHex(); }}>
                  <span className="pop-ico">{hexOn ? "◉" : "○"}</span>挂画（易经卦象）
                  <span className="pop-cnt">{hexOn ? "开" : "关"}</span>
                </button>
                <button className="pop-i" onClick={() => { setSettingsMenuOpen(false); setWhisperOpen(true); }}>
                  <span className="pop-ico">✧</span>低语面板
                </button>
                <button className="pop-i" onClick={() => {
                  setSettingsMenuOpen(false);
                  if (ballVisible) { setBallVisiblePersist(false); showToast("灵动球已隐藏（⌘⇧B 可再唤出）"); }
                  else summonBall();
                }}>
                  <span className="pop-ico">◍</span>灵动球
                  <span className="pop-cnt">{ballVisible ? "开" : "关"}</span>
                </button>
                <div className="pop-div" />
                <button className="pop-i" onClick={() => { setSettingsMenuOpen(false); setHelpOpen(true); }}>
                  <span className="pop-ico">?</span>帮助 · 安装 / 升级 / 排障
                  {update?.hasUpdate && <span className="pop-cnt">↑ v{update.latest}</span>}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ===== main ===== */}
      <main className={`main view-${view}`} onClick={() => { setCtx(null); setPanelOpen(false); }}>
        {!snap && unreachable && (
          <div className="boot boot-offline">
            <div className="boot-offline-ic">◍</div>
            <div className="boot-offline-t">太和服务未启动</div>
            <div className="boot-offline-d">连不上本机的太和（atrium）服务。点下方按钮复制命令，粘贴到终端执行即可。</div>
            <button className="boot-offline-copy" onClick={() => { navigator.clipboard?.writeText("launchctl kickstart -k gui/$(id -u)/ai.atrium.agent"); showToast?.("已复制！粘贴到终端执行"); }}>
              <span className="boot-offline-copy-ic">📋</span>
              <span>复制重启命令</span>
              <code className="boot-offline-copy-cmd">launchctl kickstart -k gui/$(id -u)/ai.atrium.agent</code>
            </button>
            <button className="tbtn" onClick={() => { navigator.clipboard?.writeText("atrium"); showToast?.("已复制"); }}>或复制 <code>atrium</code> 直接启动</button>
            <button className="tbtn tbtn-primary" onClick={() => location.reload()}>立即重试</button>
            <div className="boot-offline-hint">页面每 2 秒自动重试，服务起来后自动进看板，无需手动刷新。</div>
          </div>
        )}
        {!snap && !unreachable && (
          <div className="boot">
            <div className="boot-ring" />
            <span>CONNECTING TO FLEET…</span>
          </div>
        )}

        {view === "orbit" && <OrbitView items={viewItems} lanes={orbitLanes} {...viewProps} />}
        {view === "teams" && (
          <TeamsView
            teams={teamMetaView.teams}
            memberOptions={teamMembers}
            nodes={snap?.nodes ?? []}
            jobs={snap?.teamJobs ?? []}
            onSave={saveTeam}
            onRemove={removeTeam}
            onOpenTeam={openTeamPanel}
            onToast={showToast}
          />
        )}
        {view === "projects" && (
          <ProjectsView
            nodes={snap?.nodes ?? []}
            runAgents={snap?.runAgents ?? []}
            aliasOf={aliasOf}
            machineOf={machineNameOf}
            onRenameMachine={setNodeAlias}
            filter={filter}
            dirAliases={dirAliases}
            onRenameDir={setDirAlias}
            onSaveProject={saveProject}
            onOpenSession={(nodeId, sessionId) => {
              setSelectedId(nodeId);
              setPanelOpen(true);
            }}
            onOpenChat={(nodeId, sessionId) => {
              pendingOpenRef.current = sessionId;
              setSelectedId(nodeId);
              setChatId(sessionId);
              setPanelOpen(true);
            }}
            onRenameSession={(s, v) => { void renameSession(s.id, s.nodeId, v); }}
            sessTags={sessTags}
            onSetSessionTags={setSessionTags}
            sessPins={sessPins}
            onToggleSessPin={toggleSessPin}
            onReorderSessPins={reorderSessPins}
            tagOrder={tagOrder}
            onReorderTagOrder={reorderTagOrder}
            onRecreateDir={(nodeId, dir) => { void recreateSessionDir(nodeId, dir); }}
            noticeSess={noticeSess}
            activeSessId={chatId}
            sessAliases={sessAliases}
            onNewSession={(dir) => openNewSession(dir)}
            onRefresh={() => showToast("已刷新服务状态")}
            mode={projMode}
            draftKeys={draftKeys}
            onModeChange={setProjMode}
            onFilterChange={setFilter}
            counts={counts}
          />
        )}
      </main>

      {/* ===== whisper 弹窗（快捷键 ⌘⏎ 唤起） ===== */}
      <AnimatePresence>
        {whisperOpen && (
          <motion.div
            className="wp-ov"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setWhisperOpen(false)}
          >
            <ParticleField link={whisperThinking} />
            <motion.div
              className="wp-stage"
              initial={{ y: -16, scale: 0.96, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              exit={{ y: -16, scale: 0.96, opacity: 0 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
            >
              <WhisperLab
                targetLabel={whisperTarget ? aliasOf(whisperTarget) : "无可用 agent"}
                sessLabel={whisperSess ? (sessAliases[whisperSess.id] || whisperSess.title || whisperSess.id) : ""}
                nodeId={whisperTarget ? apiIdOf(whisperTarget) : ""}
                sessionId={whisperSess?.id ?? null}
                disabled={!whisperTarget || !whisperSess}
                onSend={async (t) => { await sendWhisper(t); return true; }}
                onClose={() => setWhisperOpen(false)}
                onThinkingChange={setWhisperThinking}
                onWheelSwitch={cycleBallSession}
                wheelCount={ballWheelCount}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== right detail panel ===== */}
      <AnimatePresence>
        {teamPanelId && panelOpen && teamMetaView.teams[teamPanelId] && (
          <motion.aside
            key={`team-panel-${teamPanelId}`}
            className={`panel team-panel ${chatFull ? "fullscreen" : ""}`}
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            {!chatFull && (
              <div
                className={`panel-resize ${resizing ? "resizing" : ""}`}
                onPointerDown={startPanelResize}
                onPointerEnter={(e) => { if (!resizing) setPresetY(Math.max(60, Math.min(window.innerHeight - 60, e.clientY))); }}
                onPointerLeave={() => setPresetY(null)}
                title="拖拽调整宽度；档位在鼠标处"
              >
                <span className="panel-resize-grip" />
                {presetY != null && (
                <div className="panel-resize-presets show" style={{ top: presetY }} onPointerDown={(e) => e.stopPropagation()}>
                  <button className="prp" onClick={() => setPanelPreset("small")} title="更小" aria-label="更小">
                    <svg width="15" height="12" viewBox="0 0 15 12"><rect x="0.5" y="0.5" width="14" height="11" rx="2.5" fill="none" stroke="currentColor" strokeOpacity="0.55" /><rect x="10" y="1.5" width="4" height="9" rx="1.5" fill="currentColor" /></svg>
                  </button>
                  <button className="prp" onClick={() => setPanelPreset("default")} title="默认宽度" aria-label="默认">
                    <svg width="15" height="12" viewBox="0 0 15 12"><rect x="0.5" y="0.5" width="14" height="11" rx="2.5" fill="none" stroke="currentColor" strokeOpacity="0.55" /><rect x="7.5" y="1.5" width="6.5" height="9" rx="1.5" fill="currentColor" /></svg>
                  </button>
                  <button className="prp" onClick={() => setPanelPreset("half")} title="半屏" aria-label="半屏">
                    <svg width="15" height="12" viewBox="0 0 15 12"><rect x="0.5" y="0.5" width="14" height="11" rx="2.5" fill="none" stroke="currentColor" strokeOpacity="0.55" /><rect x="7" y="1.5" width="7" height="9" rx="1.5" fill="currentColor" /></svg>
                  </button>
                </div>
                )}
              </div>
            )}
            <div className="team-panel-head">
              <span className="team-panel-title">{teamMetaView.teams[teamPanelId]?.name || teamPanelId}</span>
              <span className="team-panel-sub">组长 · {baseNameOf(teamMetaView.teams[teamPanelId]?.leader?.dir || "")} · {(teamMetaView.teams[teamPanelId]?.members ?? []).length} 成员</span>
              {(snap?.teamJobs ?? []).some((j: any) => j.teamId === teamPanelId && ["leader-working", "dispatching"].includes(j.status)) && (
                <HaloBadge live variant="secondary" className="font-mono text-[10px] tracking-wide">进行中</HaloBadge>
              )}
              <span style={{ flex: 1 }} />
              <button className={`chat-full ${chatFull ? "on" : ""}`} title={chatFull ? "退出全屏" : "全屏聊天"} onClick={() => setChatFull((v) => !v)}>
                {chatFull ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                )}
              </button>
              <button className="p-x" onClick={closeTeamPanel}>×</button>
            </div>
            <TeamChat
              id={teamPanelId}
              team={teamMetaView.teams[teamPanelId]}
              nodes={snap?.nodes ?? []}
              jobs={snap?.teamJobs ?? []}
              onDispatch={dispatchTeamTask}
              onToast={showToast}
              ignoredPending={ignoredPending}
              onIgnorePending={ignorePending}
              ballDragRef={ballDragRef}
            />
          </motion.aside>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {!teamPanelId && selected && selState && panelOpen && (
          <motion.aside
            key="chat-panel"
            className={`panel ${chatId && chatFull ? "fullscreen" : ""} ${dragOver ? "drag-over" : ""}`}
            initial={{ x: 400, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 400, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            {dragOver && <div className="drop-overlay"><div className="drop-inner">松开以添加附件</div></div>}
            <AnimatePresence>
              {panelToast && (
                <motion.div
                  key={panelToast.id}
                  className="panel-toast"
                  initial={{ opacity: 0, x: -14 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  <span className="panel-toast-ic">✓</span>
                  {panelToast.msg}
                </motion.div>
              )}
            </AnimatePresence>
            {!chatFull && (
              <div
                className={`panel-resize ${resizing ? "resizing" : ""}`}
                onPointerDown={startPanelResize}
                onPointerEnter={(e) => { if (!resizing) setPresetY(Math.max(60, Math.min(window.innerHeight - 60, e.clientY))); }}
                onPointerLeave={() => setPresetY(null)}
                title="拖拽调整宽度；档位在鼠标处"
              >
                <span className="panel-resize-grip" />
                {presetY != null && (
                <div className="panel-resize-presets show" style={{ top: presetY }} onPointerDown={(e) => e.stopPropagation()}>
                  <button className="prp" onClick={() => setPanelPreset("small")} title="更小" aria-label="更小">
                    <svg width="15" height="12" viewBox="0 0 15 12"><rect x="0.5" y="0.5" width="14" height="11" rx="2.5" fill="none" stroke="currentColor" strokeOpacity="0.55" /><rect x="10" y="1.5" width="4" height="9" rx="1.5" fill="currentColor" /></svg>
                  </button>
                  <button className="prp" onClick={() => setPanelPreset("default")} title="默认宽度" aria-label="默认">
                    <svg width="15" height="12" viewBox="0 0 15 12"><rect x="0.5" y="0.5" width="14" height="11" rx="2.5" fill="none" stroke="currentColor" strokeOpacity="0.55" /><rect x="7.5" y="1.5" width="6.5" height="9" rx="1.5" fill="currentColor" /></svg>
                  </button>
                  <button className="prp" onClick={() => setPanelPreset("half")} title="半屏" aria-label="半屏">
                    <svg width="15" height="12" viewBox="0 0 15 12"><rect x="0.5" y="0.5" width="14" height="11" rx="2.5" fill="none" stroke="currentColor" strokeOpacity="0.55" /><rect x="7" y="1.5" width="7" height="9" rx="1.5" fill="currentColor" /></svg>
                  </button>
                </div>
                )}
              </div>
            )}
            <div className="p-head">
              <div className="p-headgrow">
                <h3 title={chatSess?.lastPrompt ? `问题：${chatSess.lastPrompt}` : undefined}>{aliasOf(selected)}</h3>
                {aliasOf(selected) !== selected.label && <div className="p-sub" title={chatSess?.lastPrompt || undefined}>{selected.label}</div>}
              </div>
              <span className={`chip ${selState}`}>{STATE_LABELS[selState]}</span>
              <button className="p-x" onClick={() => setPanelOpen(false)}>×</button>
            </div>

            {!chatId && (
              <div className="p-meta">
                {isServer(selected) ? (
                  <>
                    <span>{(selected.sessions ?? []).length} 会话</span>
                    <span>{(selected.busyCount ?? 0)} 进行中</span>
                    <span>{(selTokens / 1000).toFixed(0)}k tok</span>
                    {selected.latencyMs != null && <span>{selected.latencyMs}ms</span>}
                  </>
                ) : (
                  <>
                    <span>{(selected as RunAgentView).bridge}</span>
                    <span>PID {(selected as RunAgentView).pid}</span>
                    <span>{(selected as RunAgentView).machine || "local"}</span>
                  </>
                )}
              </div>
            )}

            {!chatId && isServer(selected) && (
              <div className="ctx-bar">
                <i style={{
                  width: `${Math.max(2, ctxPct)}%`,
                  background: ctxPct < 50 ? "var(--ready)" : ctxPct < 80 ? "var(--awaiting)" : "#f87171",
                }} />
              </div>
            )}

            {chatNode && chatId && (
              <div className="chat-head">
                <button className="set-back" onClick={() => setChatId(null)}>‹ {isServer(selected) && !(selected as any).hostId ? "会话" : "详情"}</button>
                <SessTitle
                  className="chat-title"
                  id={chatId}
                  fallback={chatSess?.title || chatId}
                  aliases={sessAliases}
                  editing={sessAliasId === chatId}
                  onStartEdit={() => setSessAliasId(chatId)}
                  onCommit={(v) => { void renameSession(chatId, chatNode ? apiIdOf(chatNode) : null, v); setSessAliasId(null); }}
                  onCancel={() => setSessAliasId(null)}
                />
                <button className="sess-rename" title="自定义名称" onClick={(e) => { e.stopPropagation(); setSessAliasId(sessAliasId === chatId ? null : chatId); }}>✎</button>
                {chatStatus?.stuck ? (
                  <span className="chat-hstatus hstatus-stuck" title={`工具 ${chatStatus.stuckTool} 已 ${chatStatus.stuckMin} 分钟无进展`}>
                    <span className="chat-stuck-ic">⚠</span>
                    <span>疑似卡死 · {chatStatus.stuckTool} {chatStatus.stuckMin} 分钟</span>
                    <button className="tbtn tbtn-sm" onClick={() => { void sendAbort(); }}>中断解锁</button>
                  </span>
                ) : chatStatus?.busy ? (
                  <span className="chat-hstatus hstatus-busy">● 进行中</span>
                ) : null}
                <span style={{ flex: 1 }} />
                {!isServer(selected) && !isPiRun(selected) && <span className="chat-via">经由 {aliasOf(chatNode)}</span>}
                {isServer(chatNode) && chatModels?.ok && (chatModels.providers?.length ?? 0) > 0 && (
                  <div className="chat-model">
                    <button
                      className={`chat-model-btn ${modelMenuOpen ? "open" : ""}`}
                      title="切换模型"
                      onClick={(e) => { e.stopPropagation(); setModelMenuOpen((o) => !o); }}
                    >
                      <span className="chat-model-name">{effModelLabel ?? "模型"}</span>
                      <span className="chat-model-caret">▾</span>
                    </button>
                    {modelMenuOpen && (
                      <>
                        <div className="chat-model-backdrop" onClick={() => setModelMenuOpen(false)} />
                        <div className="chat-model-list">
                          {(chatModels.providers ?? []).map((p) => (
                            <div key={p.id} className="chat-model-group">
                              <div className="chat-model-prov">{p.name || p.id}</div>
                              {p.models.map((m) => {
                                const on = effModel?.providerID === p.id && effModel?.modelID === m.id;
                                const isDef = chatModels.default?.[p.id] === m.id;
                                return (
                                  <button
                                    key={m.id}
                                    className={`chat-model-item ${on ? "on" : ""}`}
                                    onClick={() => pickModel(p.id, m.id)}
                                    title={`${p.id}/${m.id}${isDef ? " · 默认" : ""}`}
                                  >
                                    <span className="chat-model-item-name">{m.name || m.id}</span>
                                    {isDef && <span className="chat-model-def">默认</span>}
                                    {on && <span className="chat-model-check">✓</span>}
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <button className={`chat-full ${chatFull ? "on" : ""}`} title={chatFull ? "退出全屏" : "全屏聊天"} onClick={() => setChatFull((v) => !v)}>
                  {chatFull ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                  )}
                </button>
{capOk(chatNode, "attach") && (
                  <button className="chat-attach" title="传文件 / 图片" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                  </button>
                )}
                {/* 更多操作：中止 / 置顶 / 任务提示 / 别名颜色（收进顶部，底部不再堆放按钮） */}
                <div className="pop-wrap">
                  <button className="chat-attach chat-more" title="更多操作" onClick={(e) => { e.stopPropagation(); setPanelMenuOpen((o) => !o); }}>⋯</button>
                  {panelMenuOpen && (
                    <div className="pop pop--right" onClick={(e) => e.stopPropagation()}>
                      {chatNode && !(selected as any).finished && (
                        <button className="pop-i" onClick={() => { setPanelMenuOpen(false); askConfirm({ title: "中止该会话？", desc: "正在运行的任务将被打断，已产生的改动会保留。", okText: "中止", danger: true, onOk: sendAbort }); }}>
                          <span className="pop-ico">■</span>中止任务
                        </button>
                      )}
                      {(selected as any).finished && (
                        <button className="pop-i" onClick={() => { setPanelMenuOpen(false); askConfirm({ title: "确认完成该任务？", desc: "将从工作台移除这个已完成任务的入口（会话数据不受影响）。", okText: "确认完成", onOk: confirmFinished }); }}>
                          <span className="pop-ico">✓</span>确认完成
                        </button>
                      )}
                      <button className="pop-i" onClick={() => { setPanelMenuOpen(false); togglePin(apiIdOf(selected)); }}>
                        <span className="pop-ico">{pins.includes(apiIdOf(selected)) ? "◆" : "◇"}</span>{pins.includes(apiIdOf(selected)) ? "取消置顶" : "置顶"}
                      </button>
                      <button className="pop-i" onClick={() => { setPanelMenuOpen(false); toggleHintsOff(selected.id); }}>
                        <span className="pop-ico">{hintsOff[selected.id] ? "○" : "✕"}</span>{hintsOff[selected.id] ? "显示任务提示" : "关闭任务提示"}
                      </button>
                      <button className="pop-i" onClick={() => { setPanelMenuOpen(false); setSettingsFor(selected.id); }}>
                        <span className="pop-ico">✎</span>别名 / 颜色…
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {chatNode && chatId ? (
              <ChatView
                key={`chat:${apiIdOf(chatNode)}:${chatId}`}
                nodeId={apiIdOf(chatNode)}
                sessionId={chatId}
                busy={Boolean(chatSess?.busy) && !(
                  // 有 pending 提问/授权时 agent 已停下等人，opencode 仍报 busy，但不该继续轮询消息
                  ((chatNode as any).pendingQuestions ?? []).some((q: any) => !q.sessionID || q.sessionID === chatId) ||
                  ((chatNode as any).pendingPermissions ?? []).some((p: any) => !p.sessionID || p.sessionID === chatId)
                )}
                pendingUser={pendingUser}
                lastError={chatError?.msg}
                lastErrorAt={chatError?.at}
                onLoadingChange={onChatLoading}
                onResend={(t) => { void sendSteer(t); }}
                onStatusChange={setChatStatus}
              />
            ) : (
            <div className="p-stream">
              {isServer(selected) ? (
                <>
                  <div className="p-stream-title">会话流 · sessions
                    <button className="p-new-sess" onClick={() => setNewSessOpen(true)} title="新建会话">＋ 新建</button>
                  </div>
                  {(selected.sessions ?? []).length === 0 && <div className="p-empty">暂无会话</div>}
                  {(selected.sessions ?? [])
                    .slice()
                    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                     .map((s) => (
                      <div key={s.id} className={`sess clickable ${s.busy ? "busy" : ""}`} onClick={() => setChatId(s.id)} title="打开对话">
                        <span className="sess-dot" />
                        <div className="sess-main">
                          <SessTitle
                            id={s.id}
                            fallback={s.title || s.id}
                            aliases={sessAliases}
                            editing={sessAliasId === s.id}
                            onStartEdit={() => setSessAliasId(s.id)}
                            onCommit={(v) => { void renameSession(s.id, apiIdOf(selected), v); setSessAliasId(null); }}
                            onCancel={() => setSessAliasId(null)}
                          />
                          <div className="sess-sub">
                            {s.model ?? s.agent ?? ""}{(s.model && s.agent) ? " · " : ""}{s.agent && !s.model ? s.agent : ""}
                            {" · "}{ago(s.updatedAt)}前{s.busy ? " · 进行中" : ""}
                          </div>
                        </div>
                        <span className="sess-tok">{(((s.tokens?.input ?? 0) + (s.tokens?.output ?? 0)) / 1000).toFixed(0)}k</span>
                        <button className="sess-rename" title="自定义名称" onClick={(e) => { e.stopPropagation(); setSessAliasId(sessAliasId === s.id ? null : s.id); }}>✎</button>
                        <span className="set-row-go">›</span>
                      </div>
                    ))}
                </>
              ) : (
                <>
                  <div className="p-stream-title">进程 · process</div>
                  <dl className="proc-grid">
                    <dt>bridge</dt><dd>{(selected as RunAgentView).bridge}</dd>
                    <dt>pid</dt><dd>{(selected as RunAgentView).pid}</dd>
                    <dt>procs</dt><dd>{(selected as RunAgentView).procCount ?? 1}</dd>
                    <dt>workdir</dt><dd>{(selected as RunAgentView).workDir}</dd>
                    <dt>machine</dt><dd>{(selected as RunAgentView).machine || "local"}</dd>
                    <dt>active</dt><dd>{ago((selected as RunAgentView).lastActivityAt)}前</dd>
                  </dl>
                  {buddy ? (
                    <>
                      <div className="p-stream-title" style={{ marginTop: 16 }}>
                        {runSessInfo?.filtered ? "它的会话 · matched" : `会话 · sessions（经由 ${aliasOf(buddy)}）`}
                      </div>
                      {(runSessInfo?.list ?? []).length === 0 && <div className="p-empty">该节点暂无会话</div>}
                      {(runSessInfo?.list ?? [])
                        .slice(0, 10)
                        .map((s) => (
                          <div key={s.id} className={`sess clickable ${s.busy ? "busy" : ""}`} onClick={() => setChatId(s.id)} title="打开对话">
                            <span className="sess-dot" />
                            <div className="sess-main">
                              <SessTitle
                                id={s.id}
                                fallback={s.title || s.id}
                                aliases={sessAliases}
                                editing={sessAliasId === s.id}
                                onStartEdit={() => setSessAliasId(s.id)}
                                onCommit={(v) => { void renameSession(s.id, apiIdOf(selected), v); setSessAliasId(null); }}
                                onCancel={() => setSessAliasId(null)}
                              />
                              <div className="sess-sub">
                                {s.model ?? s.agent ?? ""}{" · "}{ago(s.updatedAt)}前{s.busy ? " · 进行中" : ""}
                              </div>
                            </div>
                            <button className="sess-rename" title="自定义名称" onClick={(e) => { e.stopPropagation(); setSessAliasId(sessAliasId === s.id ? null : s.id); }}>✎</button>
                            <span className="set-row-go">›</span>
                          </div>
                        ))}
                      {!runSessInfo?.filtered && (runSessInfo?.list ?? []).length > 0 && (
                        <div className="p-note">无法确定该进程对应的会话（workDir 不是真实路径），上面是整机会话，请手动选择。</div>
                      )}
                    </>
                  ) : (
                    ((selected as RunAgentView).sessions ?? []).length > 0 && (
                      <>
                        <div className="p-stream-title" style={{ marginTop: 16 }}>会话 · sessions（只读）</div>
                        {((selected as RunAgentView).sessions ?? [])
                          .slice()
                          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                          .slice(0, 8)
                          .map((s) => (
                            <div key={s.id} className={`sess ${s.busy ? "busy" : ""}`}>
                              <span className="sess-dot" />
                              <div className="sess-main">
                                <SessTitle
                                  id={s.id}
                                  fallback={s.title || s.id}
                                  aliases={sessAliases}
                                  editing={sessAliasId === s.id}
                                  onStartEdit={() => setSessAliasId(s.id)}
                                  onCommit={(v) => { void renameSession(s.id, apiIdOf(selected), v); setSessAliasId(null); }}
                                  onCancel={() => setSessAliasId(null)}
                                />
                                <div className="sess-sub">{ago(s.updatedAt)}前{s.busy ? " · 进行中" : ""}</div>
                              </div>
                              <button className="sess-rename" title="自定义名称" onClick={(e) => { e.stopPropagation(); setSessAliasId(sessAliasId === s.id ? null : s.id); }}>✎</button>
                            </div>
                          ))}
                        {((selected as any).proc === "pi" || (selected as RunAgentView).bridge === "pi") && (
                          <div className="oc-composer" style={{ margin: "4px 0 2px" }}>
                            <textarea
                              className="oc-input"
                              rows={1}
                              value={piPrompt}
                              placeholder="派任务给 pi（续最新会话，Enter 发送）…"
                              onChange={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 140) + "px"; setPiPrompt(el.value); }}
                              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendPiPrompt(); } }}
                            />
                            <button className="oc-send-btn" disabled={piSending || !piPrompt.trim()} onClick={() => void sendPiPrompt()} title="派任务给 pi">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
                            </button>
                          </div>
                        )}
                        <div className="p-note">
                          {((selected as any).proc === "pi" || (selected as RunAgentView).bridge === "pi")
                            ? "pi 使用独立会话系统：指令以本机 pi 后台续写会话，完成后在会话列表里回看结果。"
                            : ["openclaw", "hermes"].includes((selected as any).proc ?? (selected as RunAgentView).bridge)
                            ? "该进程使用独立会话系统（非 opencode 存储），只能读，不能在这里对话。"
                            : "同机没有可用的 opencode server 节点，只能读会话，不能发指令/授权。"}
                        </div>
                      </>
                    )
                  )}
                 </>
               )}
            </div>
            )}

            {chatNode && ballSess?.directory && (
              <SessionDirGuard
                key={`${apiIdOf(chatNode)}:${ballSess.directory}`}
                nodeId={apiIdOf(chatNode)}
                dir={ballSess.directory}
                onToast={showToast}
              />
            )}

            {chatNode && chatId && (() => {
              const perms = ((chatNode as any).pendingPermissions ?? []).filter((p: any) => !p.sessionID || p.sessionID === chatId);
              const questions = ((chatNode as any).pendingQuestions ?? []).filter((q: any) => (!q.sessionID || q.sessionID === chatId) && !ignoredPending.has(q.id));
              if (!perms.length && !questions.length) return null;
              return (
                <PendingCards
                  key={`pending:${apiIdOf(chatNode)}:${chatId}`}
                  nodeId={apiIdOf(chatNode)}
                  permissions={perms}
                  questions={questions}
                  onToast={showToast}
                  onIgnore={ignorePending}
                />
              );
            })()}

            {chatNode && (
              <div className="p-steer-wrap"
                onDragOver={(e) => {
                  if (ballDragRef.current) return;
                  const sessData = e.dataTransfer?.types?.includes("application/x-atrium-sess");
                  if (!sessData && !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  setDragOver(true);
                }}
                onDragLeave={(e) => { if (!e.relatedTarget) setDragOver(false); }}
                onDrop={(e) => {
                  if (ballDragRef.current) return;
                  e.preventDefault();
                  setDragOver(false);
                  // 会话拖入 → 在输入框插入 @会话名
                  const sessRaw = e.dataTransfer.getData("application/x-atrium-sess");
                  if (sessRaw) {
                    try {
                      const info = JSON.parse(sessRaw);
                      const insert = `@${info.label} `;
                      const el = steerRef.current;
                      if (el) {
                        const pos = el.selectionStart ?? draft.length;
                        const next = draft.slice(0, pos) + insert + draft.slice(el.selectionEnd ?? pos);
                        writeDraft(next);
                        setAtMentions((prev) => [...prev, { start: pos, end: pos + insert.length - 1, label: info.label }]);
                        requestAnimationFrame(() => { el.focus(); const p = pos + insert.length; el.setSelectionRange(p, p); });
                      } else {
                        writeDraft(draftRef.current + insert);
                        setAtMentions((prev) => [...prev, { start: draft.length, end: draft.length + insert.length - 1, label: info.label }]);
                      }
                      showToast(`已插入 @${info.label}（不可修改，可整体删除），继续写任务后发送`);
                    } catch { /* ignore */ }
                    return;
                  }
                  // 文件拖入 → 附件
                  if (!attachCtxRef.current?.can()) return;
                  const files = e.dataTransfer?.files ?? null;
                  if (files && files.length) { attachCtxRef.current.pick(files); showToast(`已添加 ${files.length} 个附件`); }
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }}
                />
                {attachFiles.length > 0 && (
                  <div className="attach-preview">
                    {attachFiles.map((f) => (
                      <span key={f.id} className="attach-chip" title={f.name}>
                        <span className="attach-icon">{f.mime.startsWith("image/") ? "🖼" : "📄"}</span>
                        <span className="attach-name">{f.name.length > 24 ? f.name.slice(0, 24) + "…" : f.name}</span>
                        <button className="attach-x" onClick={() => setAttachFiles((p) => p.filter((x) => x.id !== f.id))}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                {ment && (
                  <div className="mnt" onClick={(e) => e.stopPropagation()}>
                    {mentionItems.length === 0 ? (
                      <div className="mnt-empty">无匹配</div>
                    ) : (
                      mentionItems.map((it, i) => (
                        <div
                          key={it.id}
                          className={`mnt-i ${i === mentIdx ? "on" : ""}`}
                          onMouseEnter={() => setMentIdx(i)}
                          onClick={() => applyMention(it)}
                        >
                          <span className="mnt-icon">{it.icon}</span>
                          <span className="mnt-label">{it.label}</span>
                          {it.sub && <span className="mnt-sub">{it.sub}</span>}
                          {it.kind === "slash" && <span className="mnt-tag">命令</span>}
                        </div>
                      ))
                    )}
                  </div>
                )}
                <PromptComposer
                  ref={steerRef}
                  className="max-w-none"
                  compact
                  submitOnEnter
                  busy={Boolean(chatSess?.busy)}
                  onStop={sendAbort}
                  value={draft}
                  placeholder={chatDisabled ? "节点离线…" : "/ 命令 · @ 会话名 + 任务 → 当前 agent 去调目标会话 · 拖卡片来也行"}
                  disabled={chatDisabled || (!chatId && !(chatNode.sessions ?? []).length)}
                  canSendEmpty={attachFiles.length > 0}
                  showAttach={capOk(chatNode, "attach")}
                  onAttach={() => fileInputRef.current?.click()}
                  onSend={doSend}
                  onChange={(e) => {
                    const el = e.currentTarget;
                    handleDraft(el.value, el.selectionStart ?? el.value.length);
                  }}
                  onKeyDown={(e) => {
                    const el = steerRef.current;
                    if (el) {
                      const s = el.selectionStart ?? 0;
                      const ed = el.selectionEnd ?? 0;
                      const isInputKey = e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || (e.ctrlKey && e.key === "v") || (e.metaKey && e.key === "v");
                      if (isInputKey) {
                        const text = draft;
                        const re = /(?:^|\s)(@[^\s@]+)/g;
                        let match;
                        while ((match = re.exec(text)) !== null) {
                          const ms = match.index + (match[0][0] === " " ? 1 : 0);
                          const me = ms + match[1].length;
                          if (s > ms && s < me) { e.preventDefault(); return; }
                          if (s < me && ed > ms && !(s <= ms && ed >= me)) { e.preventDefault(); return; }
                        }
                      }
                    }
                    if (ment) {
                      const items = mentionItems;
                      if (e.key === "ArrowDown") { e.preventDefault(); setMentIdx((i) => Math.min(i + 1, items.length - 1)); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setMentIdx((i) => Math.max(i - 1, 0)); return; }
                      if (e.key === "Enter" || e.key === "Tab") {
                        const it = items[mentIdx];
                        if (it) { e.preventDefault(); applyMention(it); return; }
                      }
                      if (e.key === "Escape") { e.preventDefault(); setMent(null); return; }
                    }
                  }}
                />
              </div>
            )}

            </motion.aside>
        )}
      </AnimatePresence>

      {/* 聊天窗加载遮罩：切换会话拉消息期间盖住聊天窗（延迟 0.2s 淡入，快切不闪）；
          灵动球本尊会飞到窗口中间（chat-load-orb）放加载特效，遮罩只负责压暗内容 */}
      {panelOpen && chatNode && chatId && chatLoading && (
        <div className={`chat-load-mask ${chatFull ? "full" : ""}`}>
          <span className="chat-load-txt">正在接入会话…</span>
        </div>
      )}

      <LayoutGroup>
      {/* 会话灵动球：全局可见，可通过 ⌘/Ctrl+Shift+B 或 Alt+B 唤出；低语唤起时飞到弹窗上缘停靠 */}
      <AnimatePresence>
        {ballVisible && selected && selState && (!chatFull || true) && (() => {
          const BALL = BALL_SIZE;
          const panelReserve = panelOpen && !chatFull ? panelW : 0;
          const homeL = window.innerWidth - panelReserve - BALL - 30;
          const homeT = window.innerHeight - BALL - 30;
          const dockL = window.innerWidth / 2 - BALL / 2;
          const dockT = window.innerHeight / 2 - 178;
          const loading = chatLoading;
          const centerL = chatFull ? (window.innerWidth / 2 - BALL / 2) : (window.innerWidth - panelW / 2 - BALL / 2);
          const centerT = window.innerHeight / 2 - BALL / 2;
          const snapped = !whisperOpen && !loading && !ballFly && !ballDrag ? ballSnap : null;
          const posStyle: CSSProperties = snapped
            ? snapPosStyle(snapped)
            : {
                left: whisperOpen ? dockL : loading ? centerL : (ballFly ? ballFly.l : (floatPos.l ?? homeL)),
                top: whisperOpen ? dockT : loading ? centerT : (ballFly ? ballFly.t : (floatPos.t ?? homeT)),
                bottom: "auto",
              };
          return (
          <motion.button
            ref={(el) => { ballRef.current = el; setBallEl(el); }}
            layoutId="session-ball"
            className={`float-ball ${loading ? "ball-loading" : ""} ${whisperOpen ? "docked awake" : ""} ${ballDrag ? "dragging" : ""} ${snapped ? "snapped" : ""} ${ballMenu ? "menu-open" : ""}`}
            style={{ ["--c" as any]: colorOf(selected), ...posStyle }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28 }}
            onPointerDown={(e) => {
              if (e.button === 2) return;
              const el = e.currentTarget.getBoundingClientRect();
              dragStart.current = { px: e.clientX, py: e.clientY, l: el.left, t: el.top };
              ballMoved.current = false;
              suppressBallClick.current = false;
              setBallDrag(true);
              setBallMenu(null);
              setBallDrop(null);
              clearBallHud();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              longPressTimer.current = window.setTimeout(() => {
                longPressTimer.current = null;
                if (!ballMoved.current) {
                  suppressBallClick.current = true;
                  openBallMenuAt(el);
                }
              }, 450);
            }}
            onPointerMove={(e) => {
              if (!dragStart.current) return;
              const d = dragStart.current;
              const dx = e.clientX - d.px;
              const dy = e.clientY - d.py;
              if (!ballMoved.current && Math.hypot(dx, dy) > 6) {
                ballMoved.current = true;
                if (longPressTimer.current != null) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
                if (ballSnap) persistBallSnap(null);
                clearBallHud();
              }
              if (!ballMoved.current) return;
              const p = {
                l: Math.max(8, Math.min(d.l + dx, window.innerWidth - BALL - 8)),
                t: Math.max(8, Math.min(d.t + dy, window.innerHeight - BALL - 8)),
              };
              floatPosRef.current = p;
              setFloatPos(p);
              const edge = p.l <= 24 ? "left" : p.l + BALL >= window.innerWidth - 24 ? "right" : p.t <= 24 ? "top" : p.t + BALL >= window.innerHeight - 24 ? "bottom" : null;
              setSnapPreview(edge);
              updateBallDrop(e.clientX, e.clientY);
            }}
            onPointerUp={(e) => {
              if (longPressTimer.current != null) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
              if (!dragStart.current) return;
              dragStart.current = null;
              setBallDrag(false);
              const moved = ballMoved.current;
              ballMoved.current = false;
              const preview = snapPreview;
              const drop = ballDrop;
              setSnapPreview(null);
              setBallDrop(null);
              if (moved) {
                suppressBallClick.current = true;
                if (preview) {
                  const off = (preview === "left" || preview === "right" ? e.clientY : e.clientX) - BALL / 2;
                  persistBallSnap({ edge: preview, off: clampSnapOff(preview, off) });
                } else if (drop) {
                  performBallDrop(drop);
                } else {
                  persistFloatPos(floatPosRef.current);
                }
              }
            }}
            onPointerCancel={() => {
              if (longPressTimer.current != null) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
              dragStart.current = null;
              ballMoved.current = false;
              setBallDrag(false);
              setSnapPreview(null);
              setBallDrop(null);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (e.shiftKey) {
                persistBallSnap(null);
                persistFloatPos({ l: (window.innerWidth - BALL) / 2, t: (window.innerHeight - BALL) / 2 });
              } else {
                openBallChat();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (suppressBallClick.current) { suppressBallClick.current = false; return; }
              if (ballSnap) { persistBallSnap(null); return; }
              if (!whisperOpen) setPanelOpen(true);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openBallMenuAt(e.currentTarget.getBoundingClientRect());
            }}
            onPointerEnter={scheduleBallHud}
            onPointerLeave={clearBallHud}
            title={whisperOpen ? `${aliasOf(selected)} · 低语已唤起` : `${ballInfo?.title || aliasOf(selected)} · 左键面板 · 双击对话 · Shift双击居中 · 右键菜单 · 滚轮切最近 ${ballWheelCount} 个会话 · 拖边吸附 · ⌘⇧B 全局唤出`}
          >
            <span className="float-ball-halo" />
            <span className="float-ball-halo2" />
            <span className="float-ripple r1" />
            <span className="float-ripple r2" />
            <span className="float-orbit o1" />
            <span className="float-orbit o2" />
            <span className="float-orbit o3" />
            <span className="float-particle p1" />
            <span className="float-particle p2" />
            <span className="float-particle p3" />
            <span className="float-particle p4" />
            <span className="float-particle p5" />
            <span className="float-particle p6" />
            <span className="float-particle p7" />
            <span className="float-particle p8" />
            <span className="float-particle p9" />
            <span className="float-ball-ring" />
            <span className="float-ball-ring2" />
            <span className="float-ball-dot" />
            <span className="float-ball-spark">✦</span>
            {chatSess?.busy && <span className="float-ball-live">●</span>}
            {loading && <span className="chat-load-ring" />}
          </motion.button>
          );
        })()}
      </AnimatePresence>
      </LayoutGroup>

      {snapPreview && <div className={`ball-snap-zone ${snapPreview}`} />}
      {ballDrop && ballDrop.kind !== "panel" && (
        <div
          className={`ball-drop-rect ${ballDrop.kind}`}
          style={{ left: ballDrop.rect.x, top: ballDrop.rect.y, width: ballDrop.rect.width, height: ballDrop.rect.height }}
        >
          <span className="ball-drop-label">{ballDrop.action}</span>
        </div>
      )}
      <AnimatePresence>
        {ballMenu && selected && ballMenuItems.length > 0 && (
          <BallRadialMenu x={ballMenu.x} y={ballMenu.y} items={ballMenuItems} onClose={() => setBallMenu(null)} />
        )}
      </AnimatePresence>
      {ballCountMenu && (
        <BallCountMenu
          x={ballCountMenu.x}
          y={ballCountMenu.y}
          value={ballWheelCount}
          onChange={setBallWheelCountPersist}
          onClose={() => setBallCountMenu(null)}
        />
      )}
      {ballHud && ballInfo && !ballDrag && !ballMenu && !ballCountMenu && <BallHud x={ballHud.x} y={ballHud.y} info={ballInfo} wheelCount={ballWheelCount} />}

      {/* 新建会话弹窗 */}
      <AnimatePresence>
        {newSessOpen && (
          <NewSessionModal
            nodes={(snap?.nodes ?? []).filter((n) => !n.id.includes("::")) as NodeView[]}
            initialNodeId={selected ? apiIdOf(selected) : null}
            initialDir={newSessDir}
            onClose={() => { setNewSessOpen(false); setNewSessDir(undefined); }}
            onCreate={createSession}
            onToast={showToast}
          />
        )}
      </AnimatePresence>

      {/* ===== ⌘K palette ===== */}
      <AnimatePresence>
        {cmdOpen && (
          <motion.div
            className="cmd-ov"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setCmdOpen(false)}
          >
            <motion.div
              className="cmd"
              initial={{ y: -18, scale: 0.97, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              exit={{ y: -18, scale: 0.97, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                placeholder="跳转到 agent / 会话…"
                value={cmdQuery}
                onChange={(e) => { setCmdQuery(e.target.value); setCmdIdx(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setCmdIdx((i) => Math.min(i + 1, cmdItems.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setCmdIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === "Enter") {
                    const it = cmdItems[cmdIdx];
                    if (it) {
                      setCmdOpen(false); setPanelOpen(true);
                      if (it.kind === "agent") setSelectedId(it.id);
                      else { const sid = it.id.split("::").slice(1).join("::"); setSelectedId(it.nodeId); pendingOpenRef.current = sid; setChatId(sid); }
                    }
                  }
                }}
              />
              <div className="cmd-list">
                {cmdItems.slice(0, 24).map((it, i) => (
                  <div
                    key={it.id}
                    className={`cmd-i ${i === cmdIdx ? "on" : ""}`}
                    onMouseEnter={() => setCmdIdx(i)}
                    onClick={() => {
                      setCmdOpen(false); setPanelOpen(true);
                      if (it.kind === "agent") setSelectedId(it.id);
                      else { const sid = it.id.split("::").slice(1).join("::"); setSelectedId(it.nodeId); pendingOpenRef.current = sid; setChatId(sid); }
                    }}
                  >
                    <span className="cdot" style={{ background: it.color, boxShadow: `0 0 6px ${it.color}` }} />
                    {it.kind === "sess" && <span className="ckind">💬</span>}
                    <span className="cmd-name">{it.label}</span>
                    {it.kind === "agent" && it.machine && <span className="cmach">{it.machine}</span>}
                    {it.kind === "sess" && <span className="cmach">{it.nodeLabel}</span>}
                    {it.kind === "agent"
                      ? <span className="cst">{STATE_LABELS[it.st]}</span>
                      : <span className={`cst ${it.busy ? "busy" : ""}`}>{it.busy ? "进行中" : "会话"}</span>}
                  </div>
                ))}
                {cmdItems.length === 0 && <div className="p-empty" style={{ padding: "24px 0" }}>无匹配</div>}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== settings ===== */}
      <AnimatePresence>
        {settingsFor && (() => {
          const setColor = (id: string, v: string | null) => {
            setColors((c) => {
              const n = { ...c };
              if (v) n[id] = v; else delete n[id];
              localStorage.setItem("atrium.colors", JSON.stringify(n));
              return n;
            });
            writeTeamKV(`color:${id}`, v || null);
          };
          const setAlias = (id: string, v: string) => {
            setAliases((a) => {
              const n = { ...a };
              if (v) n[id] = v; else delete n[id];
              localStorage.setItem("atrium.aliases", JSON.stringify(n));
              return n;
            });
            writeTeamKV(`alias:${id}`, v || null);
          };
          const one = settingsFor !== "all" ? items.find((i) => i.id === settingsFor) : undefined;
          const oneSessId = (one as any)?.hostId ? (one?.sessions ?? [])[0]?.id as string | undefined : undefined;
          // 机器（服务节点）名以后端 nodeLabels 为准（团队共享）；运行进程 / 会话仍是本地别名
          const oneIsNode = !!one && !oneSessId && isServer(one);
          const oneAlias = oneSessId
            ? (sessAliases[oneSessId] ?? "")
            : oneIsNode
              ? (snap?.self?.nodeLabels?.[one!.id] ?? "")
              : (aliases[one?.id ?? ""] ?? "");
          const setOneAlias = (v: string) => {
            if (!one) return;
            if (oneSessId) setSessAlias(oneSessId, v);
            else if (oneIsNode) setNodeAlias(one.id, v);
            else setAlias(one.id, v);
          };
          return (
          <motion.div
            className="set-ov"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setSettingsFor(null)}
          >
            <motion.div
              className="set"
              initial={{ y: -18, scale: 0.97, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              exit={{ y: -18, scale: 0.97, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
            >
              {one ? (
                /* ===== 单个 agent 设置 ===== */
                <>
                  <div className="set-h">
                    <button className="set-back" onClick={() => setSettingsFor("all")}>‹ 列表</button>
                    <span className="grow" />
                    <button className="p-x" onClick={() => setSettingsFor(null)}>×</button>
                  </div>
                  <div className="set-body">
                    <div className="set-one-head">
                      <span className="orb-body set-one-orb" style={{ ["--c" as any]: colorOf(one) }}>
                        <span className="orb-core" />
                      </span>
                      <div className="set-one-meta">
                        <div className="set-one-name">{aliasOf(one)}</div>
                        <div className="set-one-sub">
                          <span className="s-dot" style={{ background: STATE_COLORS[stateOf(one)] }} />
                          {STATE_CN[stateOf(one)]}
                          {(one as any).machine ? ` · ${(one as any).machine}` : ""}
                          {isServer(one) ? " · 服务节点" : " · 运行进程"}
                        </div>
                        <div className="set-one-orig" title={one.label}>{one.label}</div>
                      </div>
                    </div>
                    <div className="set-field">
                      <label>别名</label>
                      <input
                        type="text"
                        defaultValue={oneAlias}
                        placeholder={(one as NodeView).baseLabel || one.label}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== oneAlias) setOneAlias(v); }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                      />
                    </div>
                    <div className="set-field">
                      <label>颜色</label>
                      <div className="set-colorrow">
                        <input
                          type="color"
                          value={cssColor(colors[one.id] || STATE_COLORS[stateOf(one)])}
                          onChange={(e) => setColor(one.id, e.target.value)}
                        />
                        <div className="set-swatches">
                          {STATES.map((s) => (
                            <button
                              key={s}
                              className="set-sw"
                              style={{ background: STATE_COLORS[s] }}
                              title={`跟随「${STATE_CN[s]}」色`}
                              onClick={() => setColor(one.id, STATE_COLORS[s])}
                            />
                          ))}
                        </div>
                        {colors[one.id] && (
                          <button className="tbtn" onClick={() => setColor(one.id, null)}>恢复默认</button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="set-f">
                    {oneAlias && (
                      <button className="tbtn" onClick={() => { setOneAlias(""); showToast("别名已清除"); }}>清除别名</button>
                    )}
                  </div>
                </>
              ) : (
                /* ===== 批量列表 ===== */
                <>
                  <div className="set-h">
                    外观与别名
                    <span className="grow" />
                    <button className="p-x" onClick={() => setSettingsFor(null)}>×</button>
                  </div>
                  <div className="set-body">
                    {items.map((nd) => (
                      <div key={nd.id} className="set-row" onClick={() => setSettingsFor(nd.id)}>
                        <span className="s-dot" style={{ background: colorOf(nd), boxShadow: `0 0 6px ${colorOf(nd)}` }} />
                        <div className="set-row-text">
                          <div className="set-row-name">{aliasOf(nd)}</div>
                          <div className="set-row-sub">
                            {STATE_CN[stateOf(nd)]}
                            {(nd as any).machine ? ` · ${(nd as any).machine}` : ""}
                            {isServer(nd) ? " · 节点" : " · 进程"}
                          </div>
                        </div>
                        <input
                          type="color"
                          value={cssColor(colors[nd.id] || STATE_COLORS[stateOf(nd)])}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setColor(nd.id, e.target.value)}
                          title="自定义颜色"
                        />
                        <span className="set-row-go">›</span>
                      </div>
                    ))}
                  </div>
                  <div className="set-f">
                    <button
                      className="tbtn"
                      onClick={() => askConfirm({
                        title: "重置全部颜色？",
                        desc: "所有 agent 的自定义颜色将恢复为状态默认色。",
                        okText: "重置",
                        danger: true,
                        onOk: () => { setColors({}); localStorage.setItem("atrium.colors", JSON.stringify({})); for (const k of Object.keys(colors)) writeTeamKV(`color:${k}`, null); showToast("颜色已重置"); },
                      })}
                    >重置全部颜色</button>
                    <button
                      className="tbtn"
                      onClick={() => askConfirm({
                        title: "清空全部别名？",
                        desc: "所有 agent 的自定义名称将被清除，恢复显示原始名称。",
                        okText: "清空",
                        danger: true,
                        onOk: () => { setAliases({}); localStorage.removeItem("atrium.aliases"); for (const k of Object.keys(aliases)) writeTeamKV(`alias:${k}`, null); showToast("别名已清空"); },
                      })}
                    >清空全部别名</button>
                    <button
                      className="tbtn"
                      title="左下角的 CPU/内存波浪浮窗"
                      onClick={() => { loadDockOn ? hideLoadDock() : showLoadDock(); }}
                    >{loadDockOn ? "隐藏负载浮窗" : "显示负载浮窗"}</button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* ===== 确认弹窗 ===== */}
      <AnimatePresence>
        {confirm && (
          <motion.div
            className="set-ov"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setConfirm(null)}
          >
            <motion.div
              className="confirm"
              initial={{ y: -14, scale: 0.97, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              exit={{ y: -14, scale: 0.97, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="confirm-title">{confirm.title}</div>
              {confirm.desc && <div className="confirm-desc">{confirm.desc}</div>}
              <div className="confirm-btns">
                <button className="confirm-btn" onClick={() => setConfirm(null)}>取消</button>
                <button
                  className={`confirm-btn ok ${confirm.danger ? "danger" : ""}`}
                  onClick={() => { const fn = confirm.onOk; setConfirm(null); fn(); }}
                >{confirm.okText ?? "确定"}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== context menu ===== */}
      <AnimatePresence>
        {ctx && (
          <motion.div
            className="ctxm"
            style={{ left: Math.min(ctx.x, window.innerWidth - 190), top: Math.min(ctx.y, window.innerHeight - 180) }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.14 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => { setSelectedId(ctx.id); setCtx(null); setPanelOpen(true); }}>查看详情</button>
            <button onClick={() => { const it = items.find((i) => i.id === ctx.id); togglePin(apiIdOf(it ?? { id: ctx.id })); setCtx(null); }}>
              {pins.includes(apiIdOf(items.find((i) => i.id === ctx.id) ?? { id: ctx.id })) ? "取消置顶" : "置顶"}
            </button>
            <button onClick={() => { toggleHintsOff(ctx.id); setCtx(null); }}>
              {hintsOff[ctx.id] ? "○ 显示任务提示" : "✕ 关闭任务提示"}
            </button>
            <button onClick={() => { setSettingsFor(ctx.id); setCtx(null); }}>别名 / 颜色…</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== 待处理提醒 ===== */}
      <AnimatePresence>
        {visibleAlert && (
          <div className="alert-wrap">
            <motion.div
              key={visibleAlert.key}
              data-alert-key={visibleAlert.key}
              className={`alert ${visibleAlert.kind === "error" ? "error" : ""}`}
              initial={{ opacity: 0, y: -14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -14, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
            >
              <span className="alert-pulse" />
              <span className="alert-kind">{visibleAlert.kind === "permission" ? "授权请求" : visibleAlert.kind === "question" ? "等待回答" : "执行出错"}</span>
              <span className="alert-node">{visibleAlert.name}</span>
              <span className="alert-text" title={visibleAlert.text}>{visibleAlert.text}</span>
              <button className="alert-go" onClick={() => {
                setSelectedId(visibleAlert.nodeId);
                if (visibleAlert.sessionId) {
                  pendingOpenRef.current = visibleAlert.sessionId;
                  setChatId(visibleAlert.sessionId);
                }
                dismissAlert(visibleAlert.key);
                setPanelOpen(true);
              }}>{visibleAlert.kind === "error" ? "去查看" : "去处理"}</button>
              <button className="alert-x" onClick={() => dismissAlert(visibleAlert.key)}>×</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ===== 通知中心 ===== */}
      <AnimatePresence>
        {noticeOpen && (
          <motion.div
            className="notice-ov"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setNoticeOpen(false)}
          >
            <motion.div
              className="notice-panel"
              initial={{ y: -12, scale: 0.97, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              exit={{ y: -12, scale: 0.97, opacity: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="notice-head">
                <span className="notice-title">通知中心</span>
                <span className="notice-count">{notices.length} 条</span>
                <span className="grow" />
                {notices.length > 0 && (
                  <button className="notice-clear" onClick={clearNotices}>全部清空</button>
                )}
                <button className="p-x" onClick={() => setNoticeOpen(false)}>×</button>
              </div>
              <div className="notice-body">
                {notices.length === 0 && (
                  <div className="p-empty" style={{ padding: "30px 0" }}>暂无通知</div>
                )}
                {notices.map((n) => {
                  const host = (snap?.nodes ?? []).find((x) => x.id === n.nodeId);
                  const proj = (host?.projects ?? []).find((p: any) => p.worktree === n.dir);
                  const dir = n.dir ?? "";
                  const project = n.project || (dir ? (dirAliases[dir] || dir.split(/[\\/]/).filter(Boolean).pop() || "") : "");
                  const kindTxt = n.kind === "team" ? "团队任务结束" : n.kind === "stuck" ? "疑似卡死" : n.kind === "error" ? "执行出错" : n.kind === "awaiting" ? "等待决策" : "已完成";
                  const kindGlyph = n.kind === "team" ? "👥" : n.kind === "stuck" ? "⏳" : n.kind === "error" ? "!" : n.kind === "awaiting" ? "…" : "✓";
                  return (
                    <div key={n.key} className={`notice-item ${n.seen ? "" : "unread"} kind-${n.kind ?? "done"}`} onClick={() => openNotice(n)} title={n.kind === "team" ? "点击打开团队群聊" : "点击进入会话"}>
                      {dir
                        ? <DirAvatar nodeId={n.nodeId ?? ""} dir={dir} proj={proj} name={project || n.title} size={30} />
                        : <span className={`notice-ic ic-${n.kind ?? "done"}`}>{kindGlyph}</span>}
                      <div className="notice-main">
                        <div className="notice-text" title={n.title}>
                          {n.kind === "team" && <span className="n-chip team-tag" title="团队任务">团队</span>}
                          {n.kind === "stuck" && <span className="n-chip stuck-tag" title="疑似卡死（busy 长期无进展）">卡死</span>}
                          {project && <span className="notice-proj">{project}</span>}
                          <span className="notice-name">「{n.title}」{kindTxt}</span>
                        </div>
                        <div className="notice-sub">
                          {n.kind === "team" && n.machine && <span className="n-chip" title="组长">👑 {n.machine}</span>}
                          {n.kind !== "team" && n.machine && <span className="n-chip" title="机器">🖥 {n.machine}</span>}
                          {(n.model || n.agent) && <span className="n-chip" title="模型 / agent">◆ {n.model || n.agent}</span>}
                          {n.sessionId && <span className="n-chip mono" title={`会话 ${n.sessionId}`}># {n.sessionId.slice(0, 8)}</span>}
                          <span className="n-ago">{ago(n.at)}前</span>
                        </div>
                      </div>
                      <button
                        className="notice-go"
                        title="进入会话"
                        onClick={(e) => { e.stopPropagation(); openNotice(n); }}
                      >进入</button>
                      <button className="notice-x" title="忽略" onClick={(e) => { e.stopPropagation(); dismissNotice(n.key); }}>×</button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== 使用帮助 ===== */}
      <AnimatePresence>
        {helpOpen && <Help onClose={() => setHelpOpen(false)} onToast={showToast} />}
      </AnimatePresence>

      {/* ===== 组网引导 ===== */}
      <AnimatePresence>
        {joinOpen && snap?.self && (
          <Onboard
            self={snap.self}
            peers={peers}
            nodes={snap.nodes ?? []}
            runAgents={snap.runAgents ?? []}
            onClose={dismissJoin}
            onToast={showToast}
          />
        )}
      </AnimatePresence>

      {/* ===== 组网 ===== */}
      <AnimatePresence>
        {topoOpen && (
          <Topology
            self={snap?.self}
            discovered={snap?.discovered ?? []}
            nodes={(snap?.nodes ?? []).filter((n) => !n.id.includes("::")).map((n) => ({ id: n.id, label: n.label, url: n.url, status: n.status }))}
            onClose={() => setTopoOpen(false)}
            onToast={showToast}
            onRefresh={() => showToast("已刷新")}
          />
        )}
      </AnimatePresence>

      {/* ===== 团队密钥闸门 ===== */}
      {gate && (
        <div className="gate">
          <div className="gate-box">
            <div className="gate-mark" />
            <div className="gate-title">{gate === "need" ? "需要团队密钥" : "密钥不正确"}</div>
            <div className="gate-desc">
              这台实例启用了团队密钥：填入团队约定的密钥后即可查看机队（只需一次，浏览器会记住）。
              密钥在本机 <code>~/.atrium/config.json</code> 里，或从任意已配好的机器「组网」面板复制。
            </div>
            <form
              className="gate-form"
              onSubmit={(e) => {
                e.preventDefault();
                const v = new FormData(e.currentTarget).get("key");
                setKey(String(v ?? "").trim());
                window.location.reload();
              }}
            >
              <input name="key" autoFocus placeholder="团队密钥" defaultValue="" />
              <button className="gate-go" type="submit">进入</button>
            </form>
            <button className="gate-clear" onClick={() => { setKey(""); window.location.reload(); }}>清除已保存的密钥</button>
          </div>
        </div>
      )}

      {/* ===== 值班提醒设置 ===== */}
      <AnimatePresence>
        {notifyOpen && (
          <NotifyPanel
            cfg={notify}
            onChange={patchNotify}
            pending={pendingCount}
            onTest={() => {
              primeAudio();
              chime("awaiting");
              const t = items.find((n) => isServer(n) && stateOf(n) !== "asleep");
              const k = "atrium-test";
              const demo: AlertItem = {
                key: k,
                nodeId: t?.id ?? "",
                name: t ? aliasOf(t) : "测试 agent",
                kind: "permission",
                text: "这是一条测试提醒（三条通道应同时触发）",
              };
              setAlerts((a) => [...a.filter((x) => x.key !== k), demo].slice(-4));
              window.setTimeout(() => dismissAlert(k), 20000);
              desktopNotify("待处理 · 测试提醒", `这是一条测试提醒${t ? `（示例：${aliasOf(t)}）` : ""}`, k);
              showToast("已发送测试提醒");
            }}
            onClose={() => setNotifyOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* ===== 事件流 ===== */}
      <AnimatePresence>
        {eventsOpen && (
          <EventStream
            onClose={() => setEventsOpen(false)}
            onJump={(nodeId) => { setSelectedId(nodeId); setPanelOpen(true); }}
          />
        )}
      </AnimatePresence>

      {/* ===== 挂画卦辞浮层 ===== */}
      <AnimatePresence>
        {hexViewId && hexMap[hexViewId] && (() => {
          const t = items.find((n) => n.id === hexViewId) ?? null;
          const c = hexMap[hexViewId]!;
          const h = c.hex;
          const moving = c.moving.length;
          return (
            <motion.div
              className="hex-ov"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setHexViewId(null)}
            >
              <motion.div
                className="hex-panel"
                initial={{ opacity: 0, y: -16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -14, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="hex-pane-head">
                  <div className="hex-pane-title">卦象 · {t ? aliasOf(t) : "任务占卜"}</div>
                  <button className="set-back" onClick={() => setHexViewId(null)}>关闭</button>
                </div>
                <HexGlyph cast={c} className="orb-hex big" color={t ? colorOf(t) : "#a78bfa"} />
                <h3 className="hex-name">{h.name} · {h.alias}</h3>
                <div className="hex-sub">第 {h.n} 卦 · {h.upper}上 · {h.lower}下</div>
                {moving > 0 && c.changed && (
                  <div className="hex-move">
                    <b>{moving} 个动爻</b>
                    {c.moving.join("、")} 爻变 → <u>{c.changed.name}</u>（{c.changed.alias}）
                  </div>
                )}
                <section className="hex-sec">
                  <h4>卦辞</h4>
                  <p>{h.judgment}</p>
                </section>
                <section className="hex-sec">
                  <h4>象曰</h4>
                  <p>{h.image}</p>
                </section>
                <section className="hex-sec">
                  <h4>爻辞</h4>
                  {h.lines.slice().reverse().map((ln, i) => {
                    const num = h.lines.length - i;
                    const isMove = c.moving.includes(num);
                    return (
                      <div key={num} className={`hex-line${isMove ? " move" : ""}`}>
                        <b>{ln.pos}</b>
                        {isMove && <em>动</em>}
                        <span>{ln.text}</span>
                        <p className="hex-line-img">{ln.image}</p>
                      </div>
                    );
                  })}
                </section>
                <button
                  className="hex-open detail"
                  onClick={() => {
                    const id = hexViewId;
                    setHexViewId(null);
                    setSelectedId(id);
                    setPanelOpen(true);
                  }}
                >打开详情 ›</button>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* ===== 任务完成卡片：停留 12s，显示会话名/机器/项目图标/待确认数，点击进会话 ===== */}
      <AnimatePresence>
        {doneCard && (() => {
          const host = (snap?.nodes ?? []).find((n) => n.id === doneCard.nodeId);
          const sess = host?.sessions?.find((s) => s.id === doneCard.sessionId);
          const dir = sess?.directory ?? doneCard.dir ?? "";
          const proj = (host?.projects ?? []).find((p) => p.worktree === dir);
          const pend =
            (host?.pendingPermissions ?? []).filter((p: any) => !p.sessionID || p.sessionID === doneCard.sessionId).length +
            (host?.pendingQuestions ?? []).filter((q: any) => !q.sessionID || q.sessionID === doneCard.sessionId).length;
          const machine = host?.machine ?? doneCard.machine ?? "";
          return (
            <div className="done-card-wrap">
            <motion.div
              className="done-card"
              data-done-card
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              onClick={() => openNotice(doneCard)}
              title="点击进入会话"
            >
              <span className="done-ic">✓</span>
              {dir && (
                <DirAvatar nodeId={doneCard.nodeId || ""} dir={dir} proj={proj} name={doneCard.title} size={30} />
              )}
              <div className="done-main">
                <div className="done-title">「{doneCard.title}」已完成</div>
                <div className="done-sub">
                  {machine && <span className="done-machine">{machine}</span>}
                  {pend > 0 && <span className="done-pend">{pend} 项待确认</span>}
                  {pend === 0 && <span className="done-hint">点击查看会话</span>}
                </div>
              </div>
              <button className="done-x" title="忽略" onClick={(e) => { e.stopPropagation(); setDoneCard(null); }}>×</button>
              <span className="done-timer" />
            </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>

      {/* ===== 机器负载浮窗：左下角波浪药丸，不占顶栏 ===== */}
      <HostLoad
        hosts={snap?.hosts ?? []}
        gen={snap?.generatedAt}
        visible={loadDockOn}
        onHide={hideLoadDock}
      />
      {!loadDockOn && (snap?.hosts?.length ?? 0) > 0 && (
        <button className="hl-restore" title="显示 CPU / 内存负载浮窗" onClick={showLoadDock}>≋</button>
      )}

      <PolishedToaster position="bottom-left" closeButton={false} />
    </>
  );
}
