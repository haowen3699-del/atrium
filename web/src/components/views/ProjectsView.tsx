import { Fragment, ReactNode, useEffect, useMemo, useRef, useState, CSSProperties } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import { ago, AgentState, NodeView, ProjectMeta, RunAgentView, SessionView, sessionStateOf, STATE_COLORS, STATE_LABELS } from "../../hooks/useSnapshot.js";
import { apiUrl, apiJson } from "../../lib/api.js";
import RunRing from "../RunRing.js";
import { HaloSearchInput } from "@/components/ui/halo-search";
import { HaloCard } from "@/components/ui/halo-card";
import { RollingNumber } from "@/components/ui/rolling-number";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

interface HostSession extends SessionView {
  nodeId: string;
  nodeLabel: string;
  machine: string;
  machineName: string;
  hostIp: string;
  hostPort: string;
  hostAddr: string;
  isLocal: boolean;
  /** 会话来源类型：pi 进程 / opencode 节点（内容「pi / oc」的小徽章） */
  origin?: "pi" | "opencode";
}

interface MachineGroup {
  nodeId: string;
  label: string;
  /** 原始节点 label（改名输入框的占位与「等于原值则清除别名」判定用） */
  nodeLabel: string;
  machine: string;
  /** 节点地址（用于展示机器 IP / 端口） */
  url?: string;
  isLocal: boolean;
  dirs: { dir: string; sess: HostSession[] }[];
  sessCount: number;
}

const dirName = (d: string) => {
  const parts = d.split(/[\\/]/).filter(Boolean);
  return parts.length ? (parts[parts.length - 1] || d) : d;
};

const hostParts = (url?: string) => {
  try {
    const u = new URL(url || "");
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { ip: u.hostname, port, addr: `${u.hostname}:${port}` };
  } catch {
    return { ip: "", port: "", addr: "" };
  }
};

const isLocalNode = (nd: { id: string; url?: string }) => {
  if (nd.id.includes("::")) return false;
  const host = hostParts(nd.url).ip;
  return nd.id.startsWith("local-") || !host || host === "127.0.0.1" || host === "localhost" || host === "::1";
};

const TAG_COLOR_COUNT = 12;
const tagColorIdx = (tag: string) => {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return h % TAG_COLOR_COUNT;
};
const tagColorClass = (tag: string) => `pj-tag-c${tagColorIdx(tag)}`;

/* 时间视图分桶：按「距今多久」归档（每桶上界互斥） */
const DAY_MS = 86_400_000;
const TIME_BUCKETS: { key: string; label: string; max: number }[] = [
  { key: "d1", label: "最近（1 天内）", max: 1 * DAY_MS },
  { key: "d2", label: "2 天", max: 2 * DAY_MS },
  { key: "d3", label: "3 天", max: 3 * DAY_MS },
  { key: "week", label: "一周", max: 7 * DAY_MS },
  { key: "week2", label: "两周", max: 14 * DAY_MS },
  { key: "older", label: "更久", max: Infinity },
];
const bucketOf = (ageMs: number): string => {
  for (const b of TIME_BUCKETS) if (ageMs <= b.max) return b.key;
  return "older";
};

/** 与 opencode 桌面版一致的项目头像色板（AVATAR_COLOR_KEYS） */
const AVATAR_COLORS: Record<string, { bg: string; fg: string }> = {
  pink: { bg: "#feeef8", fg: "#cd1d8d" },
  mint: { bg: "#e1fbf4", fg: "#147d6f" },
  orange: { bg: "#fff1e7", fg: "#ed5f00" },
  purple: { bg: "#f9f1fe", fg: "#8445bc" },
  cyan: { bg: "#e7f9fb", fg: "#0894b3" },
  lime: { bg: "#eefadc", fg: "#5d770d" },
};

/** 项目图标图片地址（hub 代理 opencode 的 data URL；rev 用于保存后破除缓存） */
const iconSrc = (nodeId: string, dir: string, rev?: number) =>
  apiUrl(`/api/nodes/${nodeId}/projects/icon?dir=${encodeURIComponent(dir)}${rev ? `&r=${rev}` : ""}`);

/**
 * 项目头像：与桌面版同一套优先级 —— 手动上传图 > 颜色字母块 > 自动发现图 > 默认字母块。
 * 图片本体不进快照，浏览器按 URL 单独拉（hub 带 5 分钟缓存头）。
 */
export function DirAvatar({
  nodeId, dir, proj, name, rev, size = 22,
}: {
  nodeId: string;
  dir: string;
  proj?: ProjectMeta;
  name: string;
  rev?: number;
  size?: number;
}) {
  const icon = proj?.icon;
  const showImg = icon?.hasOverride || (icon?.hasImage && !icon?.color);
  const color = (icon?.color && AVATAR_COLORS[icon.color]) || null;
  const letter = (name.trim()[0] || "?").toUpperCase();
  if (dir && showImg) {
    return (
      <span className="pj-avatar img" style={{ width: size, height: size }}>
        <img src={iconSrc(nodeId, dir, rev)} alt="" loading="lazy" />
      </span>
    );
  }
  return (
    <span
      className="pj-avatar"
      style={{
        width: size, height: size, fontSize: size * 0.52,
        background: color ? color.bg : "rgba(255,255,255,0.08)",
        color: color ? color.fg : "var(--text-3)",
      }}
    >
      {letter}
    </span>
  );
}

const SESS_STATE_CN: Record<AgentState, string> = {
  writing: "执行中",
  awaiting: "待处理",
  ready: "就绪",
  asleep: "休眠",
  done: "已完成",
};

/** 高亮命中片段 */
function Hi({ text, q }: { text: string | undefined; q?: string }) {
  if (!text) return null;
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

/** 会话卡片：分组 / 时间 / 标签 / 置顶 四种场景统一的 DOM 结构 */
/** 图钉图标：实心=已置顶，描边=未置顶（比 ◇/◆ 字符更形象） */
function PinIcon({ on, size = 12 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </svg>
  );
}

interface SessionCardProps {
  s: HostSession;
  tags: string[];
  hl?: string;
  editing: boolean;
  tagEditing: boolean;
  pinned?: boolean;
  hideTags?: boolean;
  /** 目录显示名（opencode 项目名优先），缺省用目录尾段 */
  dirLabel?: string;
  onOpen: () => void;
  onOpenChat: () => void;
  onContext: (e: React.MouseEvent) => void;
  onRename: (v: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onToggleTagEdit: () => void;
  onSetTags: (tags: string[]) => void;
  onTogglePin?: () => void;
  onUnpin?: () => void;
  pinDragHandle?: React.ReactNode;
  /** 有通知的会话 id 集合：显示角标提醒 */
  noticeSess?: Set<string>;
  /** 当前打开（右侧面板）的会话 id：卡片高亮 */
  activeSessId?: string | null;
  sessAliases?: Record<string, string>;
  /** 有未发送草稿的会话键集合（nodeId::sessionId）：显示「草稿」标识 */
  draftKeys?: Set<string>;
  /** 置顶视图整卡拖排序：关闭原生转发拖拽（dataTransfer），避免与 Reorder 冲突 */
  disableNativeDrag?: boolean;
}

function SessionCard({
  s, tags, hl, editing, tagEditing, pinned, hideTags, dirLabel, noticeSess, activeSessId, sessAliases, draftKeys, disableNativeDrag,
  onOpen, onOpenChat, onContext, onRename, onStartRename, onCancelRename, onToggleTagEdit, onSetTags, onTogglePin, onUnpin, pinDragHandle,
}: SessionCardProps) {
  const disp = sessAliases?.[s.id] || s.title || s.id;
  return (
    <div
      className={cn(
        "pj-time-row relative rounded-[28px] border-border backdrop-blur-sm transition-[transform,border-color,background-color,box-shadow] duration-150",
        s.busy && "busy",
        editing && "editing",
        pinned && "pinned",
        activeSessId && s.id === activeSessId && "active"
      )}
      data-sess-id={s.id}
      data-node-id={s.nodeId}
      draggable={!editing && !disableNativeDrag}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", `@${disp}\n`);
        e.dataTransfer.setData("application/x-atrium-sess", JSON.stringify({ sessionId: s.id, nodeId: s.nodeId, label: disp }));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={(e) => { e.stopPropagation(); if (!editing) onOpenChat(); }}
      onDoubleClick={(e) => { e.stopPropagation(); if (!editing) onOpenChat(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e); }}
      title={s.lastPrompt ? `问题：${s.lastPrompt}` : "单击打开 · 拖到聊天窗转发任务"}
    >
      {s.busy && <RunRing />}
      {s.busy && (
        <span className="pj-run-blobs" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      )}
      {pinDragHandle}
      <span className="sess-dot" />
      <div className="pj-time-main">
        {editing ? (
          <input
            className="pj-edit sess-edit"
            autoFocus
            defaultValue={disp}
            placeholder={s.id}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename(e.currentTarget.value.trim()); onCancelRename(); }
              else if (e.key === "Escape") onCancelRename();
            }}
            onBlur={(e) => { onRename(e.currentTarget.value.trim()); onCancelRename(); }}
          />
        ) : (
          <>
            <div className="pj-sess-title">
              {noticeSess?.has(s.id) && <span className="pj-notice-dot" title="该会话有通知">!</span>}
              <Hi text={disp} q={hl} />
              {draftKeys?.has(`${s.nodeId}::${s.id}`) && <span className="pj-draft-chip" title="有未发送的输入内容（草稿留在本会话）">草稿</span>}
            </div>
            {s.lastPrompt && !editing && (
              <div className="pj-last-prompt-bar" title={s.lastPrompt}>{s.lastPrompt.length > 50 ? s.lastPrompt.slice(0, 50) + "…" : s.lastPrompt}</div>
            )}
            {!hideTags && tags.length > 0 && (
              <div className="pj-sess-tags">
                {tags.map((t) => <span key={t} className={`pj-tag-chip ${tagColorClass(t)}`}>#{t}</span>)}
              </div>
            )}
          </>
        )}
        <div className="pj-time-sub">
          <span className={`pj-loc ${s.isLocal ? "on" : "remote"}`} title={s.isLocal ? "本机" : `远程机器 ${s.hostIp}`}>{s.isLocal ? "本机" : "远程"}</span>
          <span className={`pj-kin ${s.origin === "pi" ? "pi" : "oc"}`} title={s.origin === "pi" ? "pi 进程会话" : "opencode 会话"}>{s.origin === "pi" ? "pi" : "oc"}</span>
          <span className="pj-time-machine" title={`机器名称：${s.machineName || s.machine || s.nodeLabel}`}>
            <Hi text={s.machineName || s.machine || s.nodeLabel} q={hl} />
          </span>
          {s.hostAddr && (
            <span className="pj-time-host" title={`IP：${s.hostIp} · 端口：${s.hostPort}`}>
              · <Hi text={s.hostAddr} q={hl} />
            </span>
          )}
          {s.directory && <span className="pj-time-dir"> · <Hi text={dirLabel || dirName(s.directory)} q={hl} /></span>}
          {s.model || s.agent ? <span> · {s.model ?? s.agent}</span> : null}
        </div>
      </div>
      <span className={`pj-time-at ${s.busy ? "hot" : ""}`}>{s.busy ? "● 进行中" : ago(s.updatedAt) + "前"}</span>
      <span className="pj-sess-tok">{(((s.tokens?.input ?? 0) + (s.tokens?.output ?? 0)) / 1000).toFixed(0)}k</span>
      {tagEditing && (
        <TagEditor
          initial={tags}
          onCommit={(ts) => onSetTags(ts)}
          onCancel={onToggleTagEdit}
        />
      )}
      <div className="pj-sess-actions" onClick={(e) => e.stopPropagation()}>
        {pinned && (
          <span
            className="pj-act pj-sess-pin on"
            title="取消置顶"
            onClick={() => { (onTogglePin ?? onUnpin)?.(); }}
          ><PinIcon on /></span>
        )}
        {!pinned && (onTogglePin || onUnpin) && (
          <span
            className="pj-act pj-sess-pin-add"
            title="置顶（也可右键菜单）"
            onClick={() => (onTogglePin ?? onUnpin)?.()}
          ><PinIcon on={false} /></span>
        )}
        <span
          className="pj-act pj-sess-tag"
          title="设置标签（本地分类）"
          onClick={() => onToggleTagEdit()}
        >#</span>
        {s.origin !== "pi" && (
          <span
            className="pj-act pj-sess-rename"
            title="改会话名（同步到 opencode）"
            onClick={() => onStartRename()}
          >✎</span>
        )}
      </div>
      <span className="pj-time-go">›</span>
    </div>
  );
}

/** 行内标签编辑器：逗号/空格分隔多个标签，回车提交 */
function TagEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string[];
  onCommit: (tags: string[]) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial.join(", "));
  const commit = () => {
    const tags = v.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
    onCommit(tags);
    onCancel();
  };
  return (
    <input
      className="pj-edit sess-edit pj-tag-edit"
      autoFocus
      defaultValue={v}
      placeholder="标签1, 标签2…"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.stopPropagation(); commit(); }
        else if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      }}
      onBlur={(e) => { onCommit(e.target.value.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)); onCancel(); }}
    />
  );
}

/** 会话编辑弹窗：名称 + 标签 */
function SessEditModal({
  s,
  sessTags,
  initialFocus,
  onClose,
  onRename,
  onSetTags,
}: {
  s: HostSession;
  sessTags: Record<string, string[]>;
  initialFocus: "name" | "tags";
  onClose: () => void;
  onRename: (v: string) => void;
  onSetTags: (tags: string[]) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initialFocus === "name") nameRef.current?.focus();
    else tagsRef.current?.focus();
  }, [initialFocus]);
  const commit = () => {
    const nv = nameRef.current?.value.trim();
    if (nv && nv !== (s.title || s.id)) onRename(nv);
    onSetTags((tagsRef.current?.value ?? "").split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean));
    onClose();
  };
  return (
    <div className="pj-modal-ov" onClick={onClose}>
      <div className="pj-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pj-modal-h">
          <span className="pj-modal-title">会话设置</span>
          <button className="set-back" onClick={onClose}>关闭</button>
        </div>
        <label className="pj-field">
          <span>会话名称</span>
          <input ref={nameRef} defaultValue={s.title || s.id} placeholder={s.id}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") onClose(); }} />
        </label>
        <label className="pj-field">
          <span>标签（逗号/空格分隔，可多个）</span>
          <input ref={tagsRef} defaultValue={(sessTags[s.id] ?? []).join(", ")} placeholder="标签1, 标签2…"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") onClose(); }} />
        </label>
        <div className="pj-modal-actions">
          <button className="pj-modal-cancel" onClick={onClose}>取消</button>
          <button className="pj-modal-ok" onClick={commit}>保存</button>
        </div>
      </div>
    </div>
  );
}

function SessionInfoModal({
  s,
  node,
  runAgent,
  proj,
  tags,
  pinned,
  alias,
  dirLabel,
  onClose,
  onOpenChat,
  onOpenProjectSettings,
  onRecreateDir,
}: {
  s: HostSession;
  node?: NodeView;
  runAgent?: RunAgentView;
  proj?: ProjectMeta;
  tags: string[];
  pinned: boolean;
  alias: string;
  dirLabel: string;
  onClose: () => void;
  onOpenChat: () => void;
  onOpenProjectSettings?: () => void;
  onRecreateDir?: () => void;
}) {
  const [copied, setCopied] = useState("");
  const st = sessionStateOf(s.busy, node);
  const totalTokens = (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0);
  const perms = (node?.pendingPermissions ?? []).filter((p: any) => !p.sessionID || p.sessionID === s.id);
  const questions = (node?.pendingQuestions ?? []).filter((q: any) => !q.sessionID || q.sessionID === s.id);
  const fmtTime = (ts?: number | null) => (ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "—");
  const copy = async (label: string, text?: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied((c) => (c === label ? "" : c)), 1200);
    } catch { /* ignore */ }
  };
  const Row = ({ k, v, copyText }: { k: string; v?: ReactNode; copyText?: string }) => (
    <>
      <dt>{k}</dt>
      <dd>
        <span className="sess-info-val">
          <span>{v ?? "—"}</span>
          {copyText && <CopyButton value={copyText} title={`复制${k}`} className="info-copy size-6 rounded-md border-border/60" />}
        </span>
      </dd>
    </>
  );
  const infoText = [
    `名称: ${alias}`,
    `状态: ${STATE_LABELS[st]}`,
    `来源: ${s.origin === "pi" ? "pi" : "opencode"}`,
    `会话 ID: ${s.id}`,
    `原始标题: ${s.title || "—"}`,
    `机器: ${s.machineName || s.machine || s.nodeLabel}`,
    `节点: ${node?.label ?? runAgent?.label ?? s.nodeLabel}`,
    `节点 ID: ${s.nodeId}`,
    `类型: ${s.isLocal ? "本机" : "远程"}`,
    `地址: ${node?.url || s.hostAddr || "—"}`,
    `目录: ${s.directory || "—"}`,
    `项目: ${dirLabel || "—"}`,
    `模型: ${s.model || "—"}`,
    `Provider: ${s.providerID || "—"}`,
    `Agent: ${s.agent || "—"}`,
    `Token: 输入 ${s.tokens?.input ?? 0} / 输出 ${s.tokens?.output ?? 0} / 合计 ${totalTokens}`,
    `费用: ${s.cost ?? 0}`,
    `更新: ${fmtTime(s.updatedAt)}（${ago(s.updatedAt)}前）`,
    `最近输入: ${s.lastPrompt || "—"}`,
    `最近错误: ${s.lastError || "—"}`,
    `标签: ${tags.join(", ") || "—"}`,
    `置顶: ${pinned ? "是" : "否"}`,
  ].join("\n");

  return (
    <div className="pj-modal-ov" onClick={onClose}>
      <div className="pj-modal sess-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pj-modal-h">
          <span className="pj-modal-title">会话详情</span>
          <button className="set-back" onClick={onClose}>关闭</button>
        </div>
        <div className="sess-info-name">{alias}</div>
        <div className="sess-info-sub">
          {STATE_LABELS[st]} · {s.origin === "pi" ? "pi" : "opencode"} · {ago(s.updatedAt)}前更新
          {s.busy ? " · 进行中" : ""}
        </div>

        <div className="sess-info-sec">机器 / 节点</div>
        <dl className="proc-grid">
          <Row k="机器名" v={s.machineName || s.machine || s.nodeLabel} copyText={s.machineName || s.machine || s.nodeLabel} />
          <Row k="原始机器" v={s.machine} copyText={s.machine} />
          <Row k="节点" v={node?.label ?? runAgent?.label ?? s.nodeLabel} copyText={node?.label ?? runAgent?.label ?? s.nodeLabel} />
          <Row k="节点 ID" v={s.nodeId} copyText={s.nodeId} />
          <Row k="位置" v={s.isLocal ? "本机" : "远程"} />
          <Row k="IP" v={s.hostIp} copyText={s.hostIp} />
          <Row k="端口" v={s.hostPort} copyText={s.hostPort} />
          <Row k="地址" v={node?.url || s.hostAddr} copyText={node?.url || s.hostAddr} />
          {node && <Row k="节点状态" v={`${node.status}${node.latencyMs != null ? ` · ${node.latencyMs}ms` : ""}`} />}
          {node && <Row k="最近连通" v={`${fmtTime(node.lastOkAt)}${node.lastOkAt ? `（${ago(node.lastOkAt)}前）` : ""}`} />}
          {node && <Row k="SSE" v={node.sseConnected ? "已连接" : "未连接"} />}
          {node?.error && <Row k="节点错误" v={<span className="sess-info-error">{node.error}</span>} copyText={node.error} />}
          {runAgent && <Row k="进程" v={`${runAgent.bridge}${runAgent.pid ? ` · PID ${runAgent.pid}` : ""}`} />}
          {runAgent && <Row k="进程目录" v={runAgent.activeDir || runAgent.workDir} copyText={runAgent.activeDir || runAgent.workDir} />}
          {runAgent && <Row k="最近活动" v={`${fmtTime(runAgent.lastActivityAt)}（${ago(runAgent.lastActivityAt)}前）`} />}
        </dl>

        <div className="sess-info-sec">目录 / 项目</div>
        <dl className="proc-grid">
          <Row k="工作目录" v={s.directory} copyText={s.directory} />
          <Row k="项目名" v={dirLabel} copyText={dirLabel} />
          {proj?.id && <Row k="项目 ID" v={proj.id} copyText={proj.id} />}
          {proj?.worktree && <Row k="worktree" v={proj.worktree} copyText={proj.worktree} />}
          {proj?.sandboxes?.length ? <Row k="sandboxes" v={proj.sandboxes.join("\n")} copyText={proj.sandboxes.join("\n")} /> : null}
          {s.directory && <Row k="目录操作" v={
            <span className="sess-info-actions inline">
              {onOpenProjectSettings && <button className="pj-modal-cancel" onClick={onOpenProjectSettings}>项目设置</button>}
              {onRecreateDir && <button className="pj-modal-cancel" onClick={onRecreateDir}>重建工作目录</button>}
            </span>
          } />}
        </dl>

        <div className="sess-info-sec">会话</div>
        <dl className="proc-grid">
          <Row k="显示名" v={alias} copyText={alias} />
          <Row k="原始标题" v={s.title} copyText={s.title} />
          <Row k="会话 ID" v={s.id} copyText={s.id} />
          <Row k="来源" v={s.origin === "pi" ? "pi 进程会话" : "opencode 会话"} />
          <Row k="状态" v={STATE_LABELS[st]} />
          <Row k="更新时间" v={`${fmtTime(s.updatedAt)}（${ago(s.updatedAt)}前）`} />
          <Row k="模型" v={s.model} copyText={s.model} />
          <Row k="Provider" v={s.providerID} copyText={s.providerID} />
          <Row k="Agent" v={s.agent} copyText={s.agent} />
          <Row k="Token" v={`输入 ${s.tokens?.input ?? 0} · 输出 ${s.tokens?.output ?? 0} · 合计 ${totalTokens}`} />
          <Row k="费用" v={s.cost ?? 0} />
          <Row k="标签" v={tags.length ? <span className="sess-info-tags">{tags.map((t) => <span key={t} className={`pj-tag-chip ${tagColorClass(t)}`}>#{t}</span>)}</span> : "—"} copyText={tags.join(", ")} />
          <Row k="置顶" v={pinned ? "是" : "否"} />
          <Row k="待处理" v={`${perms.length} 个授权 · ${questions.length} 个提问`} />
          <Row k="最近输入" v={s.lastPrompt} copyText={s.lastPrompt} />
          {s.lastError && <Row k="最近错误" v={<span className="sess-info-error">{s.lastError}{s.lastErrorAt ? `（${ago(s.lastErrorAt)}前）` : ""}</span>} copyText={s.lastError} />}
        </dl>

        <div className="pj-modal-actions sess-info-actions">
          <button className="pj-modal-cancel" onClick={() => void copy("all", infoText)}>{copied === "all" ? "已复制全部" : "复制全部信息"}</button>
          <button className="pj-modal-cancel" onClick={onClose}>关闭</button>
          <button className="pj-modal-ok" onClick={onOpenChat}>打开对话</button>
        </div>
      </div>
    </div>
  );
}

/** 项目设置弹窗：名称 / 图标 / 颜色 —— 保存写回 opencode（与桌面版 PATCH /project 同一份数据） */
function ProjEditModal({
  nodeId,
  dir,
  proj,
  onClose,
  onSave,
  onLocalAlias,
}: {
  nodeId: string;
  dir: string;
  proj?: ProjectMeta;
  onClose: () => void;
  onSave: (patch: { name?: string; icon?: { color?: string; override?: string; clearImage?: boolean } }) => Promise<{ ok: boolean; reason?: string }>;
  onLocalAlias: (name: string) => void;
}) {
  const folder = dirName(dir) || "（无目录）";
  const [name, setName] = useState(proj?.name ?? "");
  const [color, setColor] = useState(proj?.icon?.color ?? "");
  const [upload, setUpload] = useState<string | null>(null);
  const [clearImg, setClearImg] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) { setErr("只支持图片文件"); return; }
    if (f.size > 6 * 1024 * 1024) { setErr("图片太大（>6MB），换张小图"); return; }
    const rd = new FileReader();
    rd.onload = () => { setUpload(String(rd.result)); setClearImg(false); setErr(""); };
    rd.readAsDataURL(f);
  };

  // 预览与桌面版同一套优先级：新上传 > 手动图标 > 颜色字母块 > 自动发现图标
  const existingImg = !clearImg && !upload
    ? proj?.icon?.hasOverride
      ? iconSrc(nodeId, dir)
      : !color && proj?.icon?.hasImage
        ? iconSrc(nodeId, dir)
        : null
    : null;
  const previewSrc = upload ?? existingImg;
  const pal = AVATAR_COLORS[color];

  const save = async () => {
    setSaving(true);
    setErr("");
    const patch: { name?: string; icon?: { color?: string; override?: string; clearImage?: boolean } } = {};
    const n = name.trim();
    patch.name = !n || n === folder ? "" : n; // 与文件夹同名 = 不设自定义名（同桌面版）
    if (upload) patch.icon = { color, override: upload };
    else if (clearImg) patch.icon = { color, clearImage: true };
    else if (color !== (proj?.icon?.color ?? "")) patch.icon = { color };
    const r = await onSave(patch);
    setSaving(false);
    if (r.ok) onClose();
    else setErr(r.reason || "保存失败（节点离线或 opencode 版本过旧）");
  };

  // 只能点「✕/取消」退出：点遮罩不关，避免误触丢编辑内容
  return (
    <div className="pj-modal-ov">
      <div className="pj-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pj-modal-h">
          <span className="pj-modal-title">项目设置</span>
          <button className="set-back" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="pj-proj-path" title={dir}>{dir || "（无目录）"}</div>
        {!proj && <div className="pj-proj-warn">该目录还不是 opencode 项目（先在 opencode 里打开过一次才能同步图标/名称），可只存本地别名</div>}
        <label className="pj-field">
          <span>项目名称（留空 = 用文件夹名，同步到 opencode）</span>
          <input
            value={name}
            placeholder={folder}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
          />
        </label>
        <div className="pj-field">
          <span>图标（点击预览图上传，或拖拽图片进来）</span>
          <div className="pj-proj-icon-row">
            <div
              className={`pj-proj-icon ${dragOver ? "drag" : ""}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
              title="上传图标图片"
            >
              {previewSrc ? (
                <img src={previewSrc} alt="" />
              ) : (
                <span
                  className="pj-proj-letter"
                  style={{
                    background: pal ? pal.bg : "rgba(255,255,255,0.08)",
                    color: pal ? pal.fg : "var(--text-3)",
                  }}
                >
                  {((name.trim() || folder)[0] || "?").toUpperCase()}
                </span>
              )}
              {(upload || proj?.icon?.hasOverride) && !clearImg && (
                <button
                  className="pj-proj-icon-clear"
                  title="清除图标图片（回到颜色/字母块）"
                  onClick={(e) => { e.stopPropagation(); setUpload(null); setClearImg(true); }}
                >✕</button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }}
            />
            <div className="pj-proj-icon-hint">
              {clearImg && !upload ? "将清除图标图片" : upload ? "已选新图片，保存后生效" : "建议正方形小图，保存后与 opencode 桌面版同步"}
            </div>
          </div>
        </div>
        {!upload && !clearImg && !proj?.icon?.hasOverride && (
          <div className="pj-field">
            <span>颜色（无图标图片时作为字母块底色）</span>
            <div className="pj-color-row">
              {Object.entries(AVATAR_COLORS).map(([k, c]) => (
                <button
                  key={k}
                  className={`pj-color-chip ${color === k ? "on" : ""}`}
                  style={{ background: c.bg, color: c.fg }}
                  title={k}
                  onClick={() => setColor(color === k ? "" : k)}
                >
                  {((name.trim() || folder)[0] || "?").toUpperCase()}
                </button>
              ))}
              <button className={`pj-color-none ${!color ? "on" : ""}`} onClick={() => setColor("")}>无</button>
            </div>
          </div>
        )}
        {err && <div className="pj-proj-err">{err}</div>}
        <div className="pj-modal-actions">
          {!proj && (
            <button className="pj-modal-cancel" disabled={saving} onClick={() => { onLocalAlias(name.trim()); onClose(); }}>
              只存本地别名
            </button>
          )}
          <button className="pj-modal-cancel" onClick={onClose}>取消</button>
          <button className="pj-modal-ok" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 标签分组卡片：与机器分组一样支持「手柄拖拽排序」（搜索时禁用拖拽） */
function TagGroupItem({
  tag,
  list,
  canDrag,
  collapsed,
  openAll,
  onToggle,
  renderSession,
}: {
  tag: string;
  list: HostSession[];
  canDrag: boolean;
  collapsed: boolean;
  openAll?: boolean;
  onToggle: () => void;
  renderSession: (s: HostSession) => React.ReactNode;
}) {
  const dc = useDragControls();
  const closed = openAll ? false : collapsed;
  return (
    <Reorder.Item
      as="section"
      className="pj-tag-group"
      value={tag}
      dragListener={false}
      dragControls={dc}
    >
      <header className={`pj-tag-group-h collapsible ${tagColorClass(tag)}`} onClick={onToggle}>
        <span
          className="pj-grip"
          {...(canDrag ? { onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); dc.start(e); } } : {})}
          onClick={(e) => e.stopPropagation()}
          title={canDrag ? "拖拽排序标签" : ""}
        >⠿</span>
        <span className={`pj-arrow ${closed ? "c" : ""}`}>▾</span>
        <span className={`pj-tag-badge ${tagColorClass(tag)}`}>#{tag}</span>
        <span className="pj-tag-count">{list.length} 个会话</span>
      </header>
      <div className={`pj-collapse ${closed ? "closed" : ""}`}>
        <div className="pj-collapse-inner">
          <div className="pj-tag-list">
            {list.map(renderSession)}
          </div>
        </div>
      </div>
    </Reorder.Item>
  );
}

function PinnedSessionItem({
  id,
  canDrag,
  children,
}: {
  id: string;
  canDrag: boolean;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  return (
    <Reorder.Item
      as="div"
      className={`pj-pin-item ${canDrag ? "can-drag" : ""}`}
      value={id}
      dragListener={canDrag}
      dragMomentum={false}
    >
      {children(
        <span className="pj-grip pj-pin-grip" title={canDrag ? "按住卡片任意位置拖动排序" : ""}>⠿</span>,
      )}
    </Reorder.Item>
  );
}

function MachineItem({
  m,
  collapsed,
  collapsedMach,
  editingDir,
  dirAliases,
  onToggleDir,
  onToggleMach,
  onStartEditDir,
  onCommitDir,
  editingMach,
  onStartEditMach,
  onCommitMach,
  onOpenSession,
  onOpenChat,
  onRenameSession,
  sessTags,
  onSetSessionTags,
  sessPins,
  onToggleSessPin,
  noticeSess,
  activeSessId,
  sessAliases,
  kindOfNode,
  onSessContext,
  sessEditId,
  onSessEditId,
  tagEditId,
  onTagEditId,
  openAll,
  hl,
  onNewSession,
  projOf,
  iconRev,
  onOpenProjSettings,
  onDirContext,
  draftKeys,
}: {
  m: MachineGroup;
  collapsed: Set<string>;
  collapsedMach: Set<string>;
  editingDir: string | null;
  dirAliases: Record<string, string>;
  onToggleDir: (key: string) => void;
  onToggleMach: (id: string) => void;
  onStartEditDir: (key: string) => void;
  onCommitDir: (nodeId: string, dir: string, value: string) => void;
  editingMach: string | null;
  onStartEditMach: (id: string) => void;
  onCommitMach: (nodeId: string, nodeLabel: string, value: string) => void;
  onOpenSession: (nodeId: string, sessionId: string) => void;
  onOpenChat: (nodeId: string, sessionId: string) => void;
  onRenameSession: (s: HostSession, value: string) => void;
  sessTags: Record<string, string[]>;
  onSetSessionTags: (sessionId: string, tags: string[]) => void;
  sessPins: string[];
  onToggleSessPin: (sessionId: string) => void;
  noticeSess?: Set<string>;
  activeSessId?: string | null;
  sessAliases?: Record<string, string>;
  /** 有未发送草稿的会话键集合（nodeId::sessionId） */
  draftKeys?: Set<string>;
  kindOfNode?: (nodeId: string) => string | undefined;
  onSessContext: (e: React.MouseEvent, s: HostSession) => void;
  sessEditId: string | null;
  onSessEditId: (id: string | null) => void;
  tagEditId: string | null;
  onTagEditId: (id: string | null) => void;
  openAll?: boolean;
  hl?: string;
  onNewSession: (dir: string) => void;
  projOf: (nodeId: string, dir: string) => ProjectMeta | undefined;
  iconRev: Record<string, number>;
  onOpenProjSettings: (nodeId: string, dir: string) => void;
  onDirContext: (e: React.MouseEvent, nodeId: string, dir: string) => void;
}) {
  const dc = useDragControls();
  const mc = openAll ? false : collapsedMach.has(m.nodeId);
  const mbusy = m.dirs.reduce((a, d) => a + d.sess.filter((s) => s.busy).length, 0);
  return (
    <Reorder.Item
      className="pj-machine"
      value={m}
      dragListener={false}
      dragControls={dc}
    >
      <div className="pj-mhead" onClick={() => onToggleMach(m.nodeId)}>
        <span className="pj-grip" {...(openAll ? {} : { onPointerDown: (e) => { e.stopPropagation(); dc.start(e); } })} title={openAll ? "" : "拖拽排序机器"}>⠿</span>
        <span className={`pj-arrow ${mc ? "c" : ""}`}>▾</span>
        <span className="pj-mdot" />
        {(() => { const k = kindOfNode?.(m.nodeId); return k ? <span className={`pj-kind ${k}`} title={`服务类型：${k}（同机 桌面版/CLI/web 共享同一份会话）`}>{k === "serve" ? "CLI" : k === "web" ? "WEB" : k === "desktop" ? "桌面版" : k}</span> : null; })()}
        {editingMach === m.nodeId ? (
          <input
            className="pj-edit pj-mach-edit"
            autoFocus
            defaultValue={m.label}
            placeholder={m.nodeLabel}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onCommitMach(m.nodeId, m.nodeLabel, e.currentTarget.value); onStartEditMach(""); }
              else if (e.key === "Escape") onStartEditMach("");
            }}
            onBlur={(e) => { onCommitMach(m.nodeId, m.nodeLabel, e.currentTarget.value); onStartEditMach(""); }}
          />
        ) : (
          <button
            className="pj-mname pj-mname-btn"
            title={`机器名：${m.label} · 点击改名（存本地别名，留空恢复原名）`}
            onClick={(e) => { e.stopPropagation(); onStartEditMach(m.nodeId); }}
          >
            <Hi text={m.label} q={hl} />
          </button>
        )}
        {m.machine && m.machine !== "local" && <span className="pj-mmach" title="机器名"><Hi text={m.machine} q={hl} /></span>}
        {(() => {
          const host = hostParts(m.url);
          return (
            <>
              <span className={`pj-loc ${m.isLocal ? "on" : "remote"}`} title={m.isLocal ? "本机" : `远程机器 ${host.ip}`}>{m.isLocal ? "本机" : "远程"}</span>
              {host.ip ? <span className="pj-mip" title={`IP：${host.ip} · 端口：${host.port}`}>IP {host.ip}{host.port ? `:${host.port}` : ""}</span> : null}
            </>
          );
        })()}
        <span className="pj-count"><RollingNumber value={m.dirs.length} /> 个目录 · <RollingNumber value={m.sessCount} /> 会话</span>
        {mbusy > 0 && <span className="pj-busy">● <RollingNumber value={mbusy} /> 进行中</span>}
      </div>
      <div className={`pj-collapse ${mc ? "closed" : ""}`}>
        <div className="pj-collapse-inner">
          <div className="pj-list">
          {m.dirs.map(({ dir, sess }) => {
            const key = `${m.nodeId}::${dir}`;
            const closed = openAll ? false : collapsed.has(key);
            const busy = sess.filter((s) => s.busy).length;
            const proj = projOf(m.nodeId, dir);
            const disp = proj?.name || dirAliases[dir] || dirName(dir) || "（无目录）";
            return (
              <div key={dir} className="pj-group">
                <div
                  className="pj-head rounded-lg px-2.5 py-2"
                  onClick={() => onToggleDir(key)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onDirContext(e, m.nodeId, dir); }}
                >
                  <span className={`pj-arrow ${closed ? "c" : ""}`}>▾</span>
                  <DirAvatar nodeId={m.nodeId} dir={dir} proj={proj} name={disp} rev={iconRev[key]} />
                  {editingDir === key ? (
                    <input
                      className="pj-edit"
                      autoFocus
                      defaultValue={proj?.name ?? dirAliases[dir] ?? ""}
                      placeholder={dirName(dir) || "（无目录）"}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { onCommitDir(m.nodeId, dir, e.currentTarget.value); onStartEditDir(""); }
                        else if (e.key === "Escape") onStartEditDir("");
                      }}
                      onBlur={(e) => { onCommitDir(m.nodeId, dir, e.currentTarget.value); onStartEditDir(""); }}
                    />
                  ) : (
                    <button
                      className="pj-dir"
                      title={`当前 ${dir}\n点击改名（同步到 opencode）`}
                      onClick={(e) => { e.stopPropagation(); onStartEditDir(key); }}
                    >
                      <Hi text={disp} q={hl} />
                    </button>
                  )}
                  {dir && <span className="pj-path"><Hi text={dir} q={hl} /></span>}
                  <span className="pj-count">{sess.length} 会话</span>
                  {busy > 0 && <span className="pj-busy">● {busy} 进行中</span>}
                  {!(m.nodeId.startsWith("run-pi")) && (
                    <button
                      className="pj-proj-set"
                      title="项目设置：名称 / 图标 / 颜色（同步到 opencode）"
                      onClick={(e) => { e.stopPropagation(); onOpenProjSettings(m.nodeId, dir); }}
                    >⚙</button>
                  )}
                  {!(m.nodeId.startsWith("run-pi")) && (
                    <button
                      className="pj-new-sess-in-dir"
                      title={`在此项目新建会话（默认目录：${dir || dirName(dir) || "无"}）`}
                      onClick={(e) => { e.stopPropagation(); onNewSession(dir); }}
                  >＋</button>
                  )}
                </div>
                <div className={`pj-collapse ${closed ? "closed" : ""}`}>
                    <div className="pj-collapse-inner">
                    <div className="pj-sesslist">
                    {sess.map((s) => (
                      <SessionCard
                        key={s.id}
                        s={s}
                        tags={sessTags[s.id] ?? []}
                        hl={hl}
                        editing={sessEditId === s.id}
                        tagEditing={tagEditId === s.id}
                        pinned={sessPins.includes(s.id)}
                        dirLabel={disp}
                        noticeSess={noticeSess}
                        draftKeys={draftKeys}
                        activeSessId={activeSessId}
                        sessAliases={sessAliases}
                        onOpen={() => onOpenSession(m.nodeId, s.id)}
                        onOpenChat={() => onOpenChat(m.nodeId, s.id)}
                        onContext={(e) => { e.preventDefault(); e.stopPropagation(); onSessContext(e, s); }}
                        onRename={(v) => { void onRenameSession(s, v); }}
                        onStartRename={() => onSessEditId(s.id)}
                        onCancelRename={() => onSessEditId(null)}
                        onToggleTagEdit={() => onTagEditId(tagEditId === s.id ? null : s.id)}
                        onSetTags={(tags) => onSetSessionTags(s.id, tags)}
                        onTogglePin={() => onToggleSessPin(s.id)}
                      />
                    ))}
                    </div>
                    </div>
                  </div>
              </div>
            );
          })}
          </div>
          </div>
        </div>
    </Reorder.Item>
  );
}

/** 标签管理：列出全部标签，支持批量选择、重命名（同名合并）、删除 */
function TagManager({
  sessTags, onSetSessionTags, tagOrder, onReorderTagOrder, onClose,
}: {
  sessTags: Record<string, string[]>;
  onSetSessionTags: (sessionId: string, tags: string[]) => void;
  tagOrder: string[];
  onReorderTagOrder: (tags: string[]) => void;
  onClose: () => void;
}) {
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const list of Object.values(sessTags)) for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessTags]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const renameTag = (oldTag: string, newTag: string) => {
    const nv = newTag.trim();
    setRenaming(null);
    if (!nv || nv === oldTag) return;
    for (const [sid, list] of Object.entries(sessTags)) {
      if (!list.includes(oldTag)) continue;
      onSetSessionTags(sid, Array.from(new Set(list.map((t) => (t === oldTag ? nv : t)))));
    }
    const hadNew = tagOrder.includes(nv);
    const next = tagOrder.flatMap((t) => (t === oldTag ? (hadNew ? [] : [nv]) : t)).filter((t, i, a) => a.indexOf(t) === i);
    if (JSON.stringify(next) !== JSON.stringify(tagOrder)) onReorderTagOrder(next);
  };
  const deleteTags = (items: string[]) => {
    if (!items.length) return;
    const del = new Set(items);
    for (const [sid, list] of Object.entries(sessTags)) {
      if (!list.some((t) => del.has(t))) continue;
      onSetSessionTags(sid, list.filter((t) => !del.has(t)));
    }
    const next = tagOrder.filter((t) => !del.has(t));
    if (JSON.stringify(next) !== JSON.stringify(tagOrder)) onReorderTagOrder(next);
    setSel(new Set());
  };
  const shown = tags.filter(([t]) => !q || t.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="pj-modal-ov" onClick={onClose}>
      <div className="pj-modal tm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pj-modal-h">
          <span className="pj-modal-title">标签管理</span>
          <span className="tm-hint">{tags.length} 个标签</span>
          <span style={{ flex: 1 }} />
          <button className="p-x" onClick={onClose}>×</button>
        </div>
        <div className="tm-body">
          <input className="tm-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标签…" />
          <div className="tm-list">
            {shown.length === 0 && <div className="p-empty">暂无标签</div>}
            {shown.map(([t, n]) => (
              <div key={t} className="tm-row">
                <input
                  type="checkbox"
                  checked={sel.has(t)}
                  onChange={() => setSel((s) => { const x = new Set(s); if (x.has(t)) x.delete(t); else x.add(t); return x; })}
                />
                {renaming === t ? (
                  <input
                    className="tm-rename"
                    autoFocus
                    defaultValue={t}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === "Enter") renameTag(t, e.currentTarget.value); else if (e.key === "Escape") setRenaming(null); }}
                    onBlur={(e) => renameTag(t, e.currentTarget.value)}
                  />
                ) : (
                  <span className="pj-tag-chip">#{t}</span>
                )}
                <span className="tm-count">{n} 个会话</span>
                <button className="tm-act" title="重命名（改名到已存在标签即合并）" onClick={() => setRenaming(t)}>✎</button>
                <button className="tm-act danger" title="删除该标签" onClick={() => deleteTags([t])}>✕</button>
              </div>
            ))}
          </div>
        </div>
        <div className="pj-modal-actions">
          <span className="tm-hint">{sel.size > 0 ? `已选 ${sel.size} 个` : "重命名到同名标签即合并"}</span>
          <span style={{ flex: 1 }} />
          <button className="pj-modal-cancel" onClick={() => setSel(new Set(shown.map(([t]) => t)))}>全选</button>
          <button className="pj-modal-cancel" onClick={() => setSel(new Set())}>取消选择</button>
          <button className="pj-modal-ok tm-del" disabled={sel.size === 0} onClick={() => deleteTags([...sel])}>删除选中</button>
        </div>
      </div>
    </div>
  );
}

/** 项目视图：按机器（节点）分组，机器内再按项目目录聚合会话；跟随顶部状态过滤 */
export default function ProjectsView({
  nodes,
  runAgents,
  aliasOf,
  machineOf,
  onRenameMachine,
  filter,
  dirAliases,
  onRenameDir,
  onSaveProject,
  onOpenSession,
  onOpenChat,
  onRenameSession,
  sessTags,
  onSetSessionTags,
  sessPins,
  onToggleSessPin,
  noticeSess,
  activeSessId,
  sessAliases,
  onReorderSessPins,
  tagOrder,
  onReorderTagOrder,
  onRecreateDir,
  onNewSession,
  onRefresh,
  mode,
  onModeChange,
  onFilterChange,
  counts,
  draftKeys,
}: {
  nodes: NodeView[];
  runAgents?: RunAgentView[];
  aliasOf: (n: any) => string;
  machineOf?: (n: any) => string;
  /** 设置机器（节点）显示名：本地别名，空值=清除回原始 label */
  onRenameMachine: (nodeId: string, name: string) => void;
  filter: "all" | AgentState;
  dirAliases: Record<string, string>;
  onRenameDir: (dir: string, name: string) => void;
  /** 名称/图标/颜色写回 opencode（PATCH /project）；失败时返回原因 */
  onSaveProject: (nodeId: string, dir: string, patch: { name?: string; icon?: { color?: string; override?: string; clearImage?: boolean } }) => Promise<{ ok: boolean; reason?: string }>;
  onOpenSession: (nodeId: string, sessionId: string) => void;
  onOpenChat: (nodeId: string, sessionId: string) => void;
  onRenameSession: (s: { id: string; nodeId: string }, value: string) => void;
  sessTags: Record<string, string[]>;
  onSetSessionTags: (sessionId: string, tags: string[]) => void;
  sessPins: string[];
  onToggleSessPin: (sessionId: string) => void;
  noticeSess?: Set<string>;
  activeSessId?: string | null;
  sessAliases?: Record<string, string>;
  onReorderSessPins?: (sessionIds: string[]) => void;
  tagOrder: string[];
  onReorderTagOrder: (tags: string[]) => void;
  onRecreateDir?: (nodeId: string, dir: string) => void;
  onNewSession: (dir: string) => void;
  /** 刷新最新状态（重新拉快照/服务列表） */
  onRefresh?: () => void;
  /** 显示模式：group=按机器→目录聚合；time=按最近活动；tag=按标签；pin=只看置顶（状态提升到顶栏子筛选） */
  mode: "group" | "time" | "tag" | "pin";
  onModeChange: (m: "group" | "time" | "tag" | "pin") => void;
  /** 状态筛选变化（筛选值 filter 由 App 持有） */
  onFilterChange: (f: "all" | AgentState) => void;
  /** 各状态会话计数（顶栏快照统计） */
  counts: Record<string, number>;
  /** 有未发送草稿的会话键集合（nodeId::sessionId）：卡片显示「草稿」标识 */
  draftKeys?: Set<string>;
}) {
  /** nodeId → (worktree/sandbox 目录 → 项目元数据)：目录头展示 opencode 的名称/图标 */
  const projMaps = useMemo(() => {
    const byNode = new Map<string, Map<string, ProjectMeta>>();
    for (const nd of nodes) {
      const m = new Map<string, ProjectMeta>();
      for (const p of nd.projects ?? []) {
        if (p.worktree) m.set(p.worktree, p);
        for (const s of p.sandboxes ?? []) if (!m.has(s)) m.set(s, p);
      }
      byNode.set(nd.id, m);
    }
    return byNode;
  }, [nodes]);
  const projOf = (nodeId: string, dir: string) => (dir ? projMaps.get(nodeId)?.get(dir) : undefined);

  // 本机各 opencode server 的类型（CLI serve / web / 桌面版）：用于一级（机器）标注类型
  const [ocKinds, setOcKinds] = useState<Record<number, string>>({});
  const loadKinds = async () => {
    try {
      const r = await apiJson<{ servers?: { port: number; kind: string }[] }>("/api/oc/serve");
      const map: Record<number, string> = {};
      for (const s of r?.servers ?? []) map[s.port] = s.kind;
      setOcKinds(map);
    } catch { /* ignore */ }
  };
  useEffect(() => { void loadKinds(); }, []);
  const kindOfNode = (nodeId: string): string | undefined => { const m = /^local-(\d+)$/.exec(nodeId); return m ? ocKinds[Number(m[1])] : undefined; };

  /** 保存过图标后递增，破除 <img> 的浏览器缓存 */
  const [iconRev, setIconRev] = useState<Record<string, number>>({});
  const [projSettings, setProjSettings] = useState<{ nodeId: string; dir: string } | null>(null);

  /** 目录改名：本地别名立即生效并保留为覆盖（避免服务端未及时反映时弹回）；同时尽力写回 opencode */
  const commitDirName = async (nodeId: string, dir: string, value: string) => {
    const v = value.trim();
    const folder = dirName(dir);
    onRenameDir(dir, (!v || v === folder) ? "" : v);
    const r = await onSaveProject(nodeId, dir, { name: !v || v === folder ? "" : v });
    if (!r.ok) { /* 已由本地别名兜底，无需回滚 */ }
  };

  /** 机器改名：存本地别名；留空或改回原始 label = 清除别名（跟随节点真实名称） */
  const commitMachName = (nodeId: string, nodeLabel: string, value: string) => {
    const v = value.trim();
    onRenameMachine(nodeId, !v || v === nodeLabel ? "" : v);
  };

  const dirLabelOf = (s: HostSession) => projOf(s.nodeId, s.directory)?.name || dirName(s.directory);
  // 统一的会话排序：置顶（按置顶顺序）→ 进行中 → 最近活动。所有视图共用同一规则
  const pinIdx = useMemo(() => new Map(sessPins.map((id, i) => [id, i])), [sessPins]);
  const sessRank = (a: HostSession, b: HostSession) => {
    const pa = pinIdx.has(a.id) ? (pinIdx.get(a.id) as number) : Infinity;
    const pb = pinIdx.has(b.id) ? (pinIdx.get(b.id) as number) : Infinity;
    if (pa !== pb) return pa - pb;
    if (Boolean(a.busy) !== Boolean(b.busy)) return a.busy ? -1 : 1;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  };
  const sortedSess = useMemo(() => {
    const out: HostSession[] = [];
    for (const nd of nodes) {
      const host = hostParts(nd.url);
      const machine = nd.machine ?? "local";
      const machineName = machineOf?.(nd) || aliasOf(nd) || machine;
      const isLocal = isLocalNode(nd);
      for (const s of nd.sessions ?? []) {
        out.push({ ...s, nodeId: nd.id, nodeLabel: aliasOf(nd), machine, machineName, hostIp: host.ip, hostPort: host.port, hostAddr: host.addr, isLocal, origin: "opencode" });
      }
    }
    // pi 会话：按进程归组，机器名用「pi」，按会话目录（cwd）聚合，点开走 ChatView
    for (const ra of runAgents ?? []) {
      const isPi = ra.bridge === "pi" || (ra as any).proc === "pi";
      if (!isPi) continue;
      const machine = ra.machine ?? "local";
      for (const s of ra.sessions ?? []) {
        out.push({
          ...s,
          nodeId: ra.id,
          nodeLabel: "pi",
          machine,
          machineName: "pi",
          hostIp: "",
          hostPort: "",
          hostAddr: "",
          isLocal: true,
          origin: "pi",
        });
      }
    }
    return out.sort(sessRank);
  }, [nodes, runAgents, aliasOf, machineOf, sessPins]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // 置顶会话：按置顶顺序列出仍存在的会话（跨模式可见）
  const pinnedSess = useMemo(() => {
    const byId = new Map(sortedSess.map((s) => [s.id, s]));
    return sessPins.map((id) => byId.get(id)).filter((s): s is HostSession => !!s);
  }, [sortedSess, sessPins]);

  // 搜索：/ 聚焦，Esc 清空；命中标题/ID/模型/agent/目录/机器/机器名/标签
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const searching = needle.length > 0;
  const hitSession = (s: HostSession) =>
    [s.title, s.id, s.model, s.agent, s.directory, s.machine, s.machineName, s.nodeLabel, s.hostIp, s.hostPort, s.hostAddr, s.isLocal ? "本机" : "远程", projOf(s.nodeId, s.directory)?.name, ...(sessTags[s.id] ?? [])]
      .some((f) => f != null && f.toLowerCase().includes(needle));
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "Escape") { setQ(""); searchRef.current?.blur(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pinnedList = useMemo(() => pinnedSess.filter((s) => {
    if (filter !== "all" && sessionStateOf(s.busy, nodeById.get(s.nodeId)) !== filter) return false;
    if (searching && !hitSession(s)) return false;
    return true;
  }), [pinnedSess, nodeById, filter, searching, needle, hitSession, sessTags]);

  // 机器（节点） → 目录 → 会话；过滤后无会话的目录/机器直接丢弃
  const machines = useMemo(() => {
    const machMap = new Map<string, Map<string, HostSession[]>>();
    for (const s of sortedSess) {
      if (filter !== "all" && sessionStateOf(s.busy, nodeById.get(s.nodeId)) !== filter) continue;
      if (searching && !hitSession(s)) continue;
      const dir = s.directory || "";
      let dirMap = machMap.get(s.nodeId);
      if (!dirMap) machMap.set(s.nodeId, (dirMap = new Map()));
      let arr = dirMap.get(dir);
      if (!arr) dirMap.set(dir, (arr = []));
      arr.push(s);
    }
    return [...machMap.entries()]
      .map(([nodeId, dirMap]) => {
        const node = nodes.find((n) => n.id === nodeId);
        const isPi = nodeId === "run-pi" || nodeId.startsWith("run-pi-");
        const dirs = [...dirMap.entries()]
          .map(([dir, sess]) => ({ dir, sess }))
          .sort((a, b) => Math.max(...b.sess.map((s) => s.updatedAt ?? 0)) - Math.max(...a.sess.map((s) => s.updatedAt ?? 0)));
        return {
          nodeId,
          label: isPi ? "pi" : (node ? aliasOf(node) : nodeId),
          nodeLabel: isPi ? "pi" : (node?.baseLabel ?? node?.label ?? nodeId),
          machine: node?.machine ?? "local",
          url: node?.url,
          isLocal: isPi ? true : (node ? isLocalNode(node) : nodeId.startsWith("local-")),
          dirs,
          sessCount: [...dirMap.values()].reduce((a, ss) => a + ss.length, 0),
        };
      })
      .sort((a, b) => Math.max(...b.dirs.flatMap((d) => d.sess.map((s) => s.updatedAt ?? 0))) - Math.max(...a.dirs.flatMap((d) => d.sess.map((s) => s.updatedAt ?? 0))));
  }, [sortedSess, nodeById, nodes, aliasOf, filter, searching, needle, hitSession, sessTags]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (dir: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(dir)) n.delete(dir);
      else n.add(dir);
      return n;
    });
  const [collapsedMach, setCollapsedMach] = useState<Set<string>>(new Set());
  const toggleMach = (id: string) =>
    setCollapsedMach((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const [collapsedTime, setCollapsedTime] = useState<Set<string>>(new Set());
  const toggleTime = (key: string) =>
    setCollapsedTime((c) => {
      const n = new Set(c);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const [collapsedTag, setCollapsedTag] = useState<Set<string>>(new Set());
  const toggleTag = (tag: string) =>
    setCollapsedTag((c) => {
      const n = new Set(c);
      if (n.has(tag)) n.delete(tag);
      else n.add(tag);
      return n;
    });
  const [editingDir, setEditingDir] = useState<string | null>(null);
  const [editingMach, setEditingMach] = useState<string | null>(null);
  const [sessEditId, setSessEditId] = useState<string | null>(null);
  const [tagEditId, setTagEditId] = useState<string | null>(null);
  const [sessCtx, setSessCtx] = useState<{ x: number; y: number; s: HostSession } | null>(null);
  const [editModal, setEditModal] = useState<{ s: HostSession; focus: "name" | "tags" } | null>(null);
  const [infoKey, setInfoKey] = useState<{ id: string; nodeId: string } | null>(null);
  const infoSess = infoKey ? (sortedSess.find((s) => s.id === infoKey.id && s.nodeId === infoKey.nodeId) ?? null) : null;
  /** 目录头右键菜单：项目设置 / 改名 / 新建会话 / 复制路径 */
  const [dirCtx, setDirCtx] = useState<{ x: number; y: number; nodeId: string; dir: string } | null>(null);
  useEffect(() => {
    const close = () => { setSessCtx(null); setDirCtx(null); };
    if (sessCtx || dirCtx) {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      return () => {
        window.removeEventListener("click", close);
        window.removeEventListener("contextmenu", close);
      };
    }
  }, [sessCtx, dirCtx]);

  // 标签分类：把已打标的会话按标签分组（只显示有标签的会话）
  const tagGroups = useMemo(() => {
    const filtered = sortedSess.filter((s) => {
      if (filter !== "all" && sessionStateOf(s.busy, nodeById.get(s.nodeId)) !== filter) return false;
      if (searching && !hitSession(s)) return false;
      return true;
    });
    const byTag = new Map<string, HostSession[]>();
    for (const s of filtered) {
      const tags = sessTags[s.id] ?? [];
      if (!tags.length) continue; // 未打标不显示
      for (const t of tags) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t)!.push(s);
      }
    }
    return [...byTag.entries()]
      .map(([tag, list]) => ({ tag, list: list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }))
      .sort((a, b) => b.list.length - a.list.length);
  }, [sortedSess, nodeById, filter, searching, needle, hitSession, sessTags]);
  // 显示模式由顶栏子筛选 tab 控制（mode / onModeChange 由 App 传入并持久化）
  const [tagMgrOpen, setTagMgrOpen] = useState(false);
  /** 状态筛选下拉（工具栏内，点击外部关闭） */
  const [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => {
    const close = () => setFilterOpen(false);
    if (filterOpen) {
      window.addEventListener("click", close);
      return () => window.removeEventListener("click", close);
    }
  }, [filterOpen]);
  const STATE_CN: Record<AgentState, string> = { writing: "书写", awaiting: "待答", ready: "就绪", asleep: "休眠", done: "完成" };
  const FILTER_STATES: AgentState[] = ["writing", "awaiting", "ready", "asleep", "done"];
  const timeList = useMemo(() => {
    const out = sortedSess.filter((s) => {
      if (filter !== "all" && sessionStateOf(s.busy, nodeById.get(s.nodeId)) !== filter) return false;
      if (searching && !hitSession(s)) return false;
      return true;
    });
    // 时间视图严格按最近活动倒序，不被置顶/busy 打乱
    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [sortedSess, nodeById, filter, searching, needle, hitSession, sessTags]);

  const timeGroups = useMemo(() => {
    const now = Date.now();
    const byBucket = new Map<string, HostSession[]>();
    for (const s of timeList) {
      const k = bucketOf(now - (s.updatedAt ?? 0));
      const arr = byBucket.get(k);
      if (arr) arr.push(s); else byBucket.set(k, [s]);
    }
    const groups: { key: string; label: string; list: HostSession[] }[] = [];
    for (const b of TIME_BUCKETS) {
      const list = byBucket.get(b.key);
      if (!list?.length) continue;
      list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      groups.push({ key: b.key, label: b.label, list });
    }
    return groups;
  }, [timeList]);

  // 搜索结果计数（按当前模式会话数）
  const resultCount = useMemo(() => {
    if (mode === "group") return machines.reduce((a, m) => a + m.sessCount, 0);
    if (mode === "time") return timeList.length;
    if (mode === "pin") return pinnedList.length;
    return tagGroups.reduce((a, g) => a + g.list.length, 0);
  }, [mode, machines, timeList, pinnedList, tagGroups]);

  // 机器拖动排序：持久化 nodeId 顺序，参与顺序的排前，其余（新节点）按保序追加
  const [machOrder, setMachOrder] = useState<string[]>(() => {
    try {
      const o = JSON.parse(localStorage.getItem("atrium.pjMachOrder") || "null");
      return Array.isArray(o) ? (o as string[]) : [];
    } catch { return []; }
  });
  const persistOrder = (next: string[]) => {
    setMachOrder(next);
    try { localStorage.setItem("atrium.pjMachOrder", JSON.stringify(next)); } catch {}
  };
  useEffect(() => {
    if (machOrder.length || !machines.length) return;
    persistOrder(machines.map((m) => m.nodeId));
  }, [machines, machOrder]);
  const ordered = useMemo(() => {
    const known = machines.filter((m) => machOrder.includes(m.nodeId));
    const knownSorted = known.slice().sort((a, b) => machOrder.indexOf(a.nodeId) - machOrder.indexOf(b.nodeId));
    const rest = machines.filter((m) => !machOrder.includes(m.nodeId));
    return [...knownSorted, ...rest];
  }, [machines, machOrder]);

  const orderedTags = useMemo(() => {
    const known = tagGroups.filter((g) => tagOrder.includes(g.tag));
    const knownSorted = known.slice().sort((a, b) => tagOrder.indexOf(a.tag) - tagOrder.indexOf(b.tag));
    const rest = tagGroups.filter((g) => !tagOrder.includes(g.tag));
    return [...knownSorted, ...rest];
  }, [tagGroups, tagOrder]);

  const expandAll = () => {
    if (mode === "pin") return;
    if (mode === "time") setCollapsedTime(new Set());
    else if (mode === "tag") setCollapsedTag(new Set());
    else { setCollapsed(new Set()); setCollapsedMach(new Set()); }
  };
  const collapseAll = () => {
    if (mode === "pin") return;
    if (mode === "time") {
      setCollapsedTime(new Set(timeGroups.map((g) => g.key)));
      return;
    }
    if (mode === "tag") {
      setCollapsedTag(new Set(orderedTags.map((g) => g.tag)));
      return;
    }
    const mc = new Set<string>();
    const dc = new Set<string>();
    for (const m of machines) {
      mc.add(m.nodeId);
      for (const d of m.dirs) dc.add(`${m.nodeId}::${d.dir}`);
    }
    setCollapsedMach(mc);
    setCollapsed(dc);
  };

  // 一键回到顶部浮窗
  const stageRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onScroll = () => setShowTop(el.scrollTop > 420);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const scrollTop = () => {
    stageRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="pj-stage" ref={stageRef}>
      <HaloCard interactive={false} padding="none" className="pj-toolbar-card sticky top-0 z-10 mb-4">
        <div className="pj-toolbar static border-0 bg-none bg-transparent px-3 py-2 shadow-none backdrop-blur-none">
        <div className="pj-search flex items-center gap-2">
          <HaloSearchInput
            inputRef={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => { setQ(""); searchRef.current?.focus(); }}
            placeholder="搜索标题 / 目录 / 机器 / ID"
            className="max-w-none flex-1"
            compact
            blobTranslucent
          />
          {searching && (
            <span className="shrink-0 font-mono text-[11px] text-text-3">
              <RollingNumber value={resultCount} /> 个
            </span>
          )}
        </div>
        <div className="pop-wrap pj-filter-wrap">
          <button
            className={`tbtn bell ${filter !== "all" ? "filter-on" : ""}`}
            style={filter !== "all" ? ({ "--filter-c": STATE_COLORS[filter] } as CSSProperties) : undefined}
            onClick={(e) => { e.stopPropagation(); setFilterOpen((o) => !o); }}
            title="按状态筛选会话"
          >
            <span className="fdot" style={{ background: filter === "all" ? "var(--text-3)" : STATE_COLORS[filter] }} />
            状态 · {filter === "all" ? "全部" : STATE_CN[filter]} ▾
          </button>
          {filterOpen && (
            <div className="pop" onClick={(e) => e.stopPropagation()}>
              <button className={`pop-i ${filter === "all" ? "on" : ""}`} onClick={() => { onFilterChange("all"); setFilterOpen(false); }}>
                <span className="pop-dot" style={{ background: "var(--text-3)" }} />
                全部
                <span className="pop-cnt"><RollingNumber value={counts.all} /></span>
                {filter === "all" && <span className="pop-ck">✓</span>}
              </button>
              {FILTER_STATES.map((s) => (
                <button key={s} className={`pop-i ${filter === s ? "on" : ""}`} onClick={() => { onFilterChange(s); setFilterOpen(false); }}>
                  <span className="pop-dot" style={{ background: STATE_COLORS[s] }} />
                  {STATE_CN[s]}
                  <span className="pop-cnt"><RollingNumber value={counts[s]} /></span>
                  {filter === s && <span className="pop-ck">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="pj-toolbar-btns">
          <button className="pj-expand pj-refresh" onClick={() => { void loadKinds(); onRefresh?.(); }} title="刷新最新服务状态">↻ 刷新</button>
          {mode === "tag" && (
            <button className="pj-expand" onClick={() => setTagMgrOpen(true)} title="标签管理：批量重命名 / 删除标签">⚙ 标签管理</button>
          )}
          {mode !== "pin" && (
            <>
              <button className="pj-expand" onClick={expandAll} title={mode === "time" ? "展开全部时间分类" : mode === "tag" ? "展开全部标签" : "展开全部机器和目录"}>⇓ 展开</button>
              <button className="pj-collapse" onClick={collapseAll} title={mode === "time" ? "折叠全部时间分类" : mode === "tag" ? "折叠全部标签" : "折叠全部机器和目录"}>⇑ 合并</button>
            </>
          )}
        </div>
        </div>
      </HaloCard>

      {mode === "pin" ? (
        <>
          {pinnedList.length === 0 && (
            <div className="pj-empty-center">
              {searching ? "没有匹配的置顶会话" : filter !== "all" ? "此状态下没有置顶会话" : "还没有置顶会话 —— 在会话行右键选择「置顶」"}
            </div>
          )}
          <div className="pj-timelist pj-pinlist">
            <div className="pj-time-h">
              <span className="pj-th-title">置顶会话</span>
              <span className="pj-th-count">{pinnedList.length} 个</span>
            </div>
            <Reorder.Group
              as="div"
              axis="y"
              values={pinnedList.map((s) => s.id)}
              onReorder={(next) => {
                const ids = next as string[];
                const setNext = new Set(ids);
                const positions = sessPins.map((id, i) => ({ id, i })).filter((x) => setNext.has(x.id)).map((x) => x.i);
                const out = [...sessPins];
                positions.forEach((pos, idx) => { if (ids[idx] !== undefined) out[pos] = ids[idx]; });
                onReorderSessPins?.(out);
              }}
              className="pj-pin-grid"
            >
              {pinnedList.map((s) => (
                <PinnedSessionItem key={s.id} id={s.id} canDrag={!searching}>
                  {(handle) => (
                    <SessionCard
                      s={s}
                      tags={sessTags[s.id] ?? []}
                      hl={searching ? needle : undefined}
                      editing={sessEditId === s.id}
                      tagEditing={tagEditId === s.id}
                      dirLabel={dirLabelOf(s)}
                            noticeSess={noticeSess}
                        draftKeys={draftKeys}
                            activeSessId={activeSessId}
                            sessAliases={sessAliases}
                      pinned
                      disableNativeDrag
                      pinDragHandle={handle}
                      onOpen={() => onOpenSession(s.nodeId, s.id)}
                      onOpenChat={() => onOpenChat(s.nodeId, s.id)}
                      onContext={(e) => { e.preventDefault(); e.stopPropagation(); setSessCtx({ x: e.clientX, y: e.clientY, s }); }}
                      onRename={(v) => { void onRenameSession(s, v); }}
                      onStartRename={() => setSessEditId(s.id)}
                      onCancelRename={() => setSessEditId(null)}
                      onToggleTagEdit={() => setTagEditId(tagEditId === s.id ? null : s.id)}
                      onSetTags={(tags) => onSetSessionTags(s.id, tags)}
                      onTogglePin={() => onToggleSessPin(s.id)}
                    />
                  )}
                </PinnedSessionItem>
              ))}
            </Reorder.Group>
          </div>
        </>
      ) : mode === "tag" ? (
        <>
          {tagGroups.length === 0 && (
            <div className="pj-empty-center">
              {searching ? "没有匹配的会话" : "还没有打标签的会话 —— 在分组/时间视图把鼠标移到会话行点 # 打标签"}
            </div>
          )}
          <Reorder.Group
            as="div"
            axis="y"
            values={orderedTags.map((g) => g.tag)}
            onReorder={onReorderTagOrder}
            className="pj-tagview"
          >
            {orderedTags.map(({ tag, list }) => (
              <TagGroupItem
                key={tag}
                tag={tag}
                list={list}
                canDrag={!searching}
                collapsed={collapsedTag.has(tag)}
                openAll={searching}
                onToggle={() => toggleTag(tag)}
                renderSession={(s) => (
                  <SessionCard
                    key={s.id}
                    s={s}
                    tags={sessTags[s.id] ?? []}
                    hl={searching ? needle : undefined}
                    editing={sessEditId === s.id}
                    tagEditing={tagEditId === s.id}
                    hideTags
                    pinned={sessPins.includes(s.id)}
                    dirLabel={dirLabelOf(s)}
                            noticeSess={noticeSess}
                        draftKeys={draftKeys}
                            activeSessId={activeSessId}
                            sessAliases={sessAliases}
                    onOpen={() => onOpenSession(s.nodeId, s.id)}
                    onOpenChat={() => onOpenChat(s.nodeId, s.id)}
                    onContext={(e) => { e.preventDefault(); e.stopPropagation(); setSessCtx({ x: e.clientX, y: e.clientY, s }); }}
                    onRename={(v) => { void onRenameSession(s, v); }}
                    onStartRename={() => setSessEditId(s.id)}
                    onCancelRename={() => setSessEditId(null)}
                    onToggleTagEdit={() => setTagEditId(tagEditId === s.id ? null : s.id)}
                    onSetTags={(tags) => onSetSessionTags(s.id, tags)}
                    onTogglePin={() => onToggleSessPin(s.id)}
                  />
                )}
              />
            ))}
          </Reorder.Group>
        </>
      ) : mode === "time" ? (
        <>
          {timeList.length === 0 && <div className="v-empty">{searching ? "没有匹配的会话" : "此状态下没有会话"}</div>}
          <div className="pj-timelist">
            {timeGroups.map((g) => {
              const closed = searching ? false : collapsedTime.has(g.key);
              return (
                <Fragment key={g.key}>
                  <div className="pj-time-h collapsible" onClick={() => toggleTime(g.key)}>
                    <span className={`pj-arrow ${closed ? "c" : ""}`}>▾</span>
                    <span className="pj-th-title">{g.label}</span>
                    <span className="pj-th-count">{g.list.length} 个会话</span>
                  </div>
                  <div className={`pj-collapse ${closed ? "closed" : ""}`}>
                    <div className="pj-collapse-inner">
                      <div className="pj-time-list">
                        {g.list.map((s) => (
                          <SessionCard
                            key={s.id}
                            s={s}
                            tags={sessTags[s.id] ?? []}
                            hl={searching ? needle : undefined}
                            editing={sessEditId === s.id}
                            tagEditing={tagEditId === s.id}
                            pinned={sessPins.includes(s.id)}
                            dirLabel={dirLabelOf(s)}
                            noticeSess={noticeSess}
                        draftKeys={draftKeys}
                            activeSessId={activeSessId}
                            sessAliases={sessAliases}
                            onOpen={() => onOpenSession(s.nodeId, s.id)}
                            onOpenChat={() => onOpenChat(s.nodeId, s.id)}
                            onContext={(e) => { e.preventDefault(); e.stopPropagation(); setSessCtx({ x: e.clientX, y: e.clientY, s }); }}
                            onRename={(v) => { void onRenameSession(s, v); }}
                            onStartRename={() => setSessEditId(s.id)}
                            onCancelRename={() => setSessEditId(null)}
                            onToggleTagEdit={() => setTagEditId(tagEditId === s.id ? null : s.id)}
                            onSetTags={(tags) => onSetSessionTags(s.id, tags)}
                            onTogglePin={() => onToggleSessPin(s.id)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </>
      ) : (
      <>
      {ordered.length === 0 && <div className="v-empty">{searching ? "没有匹配的会话" : "此状态下没有会话"}</div>}

      <Reorder.Group
        axis="y"
        values={ordered}
        onReorder={(next) => persistOrder(next.map((m) => m.nodeId))}
        className="pj-machlist"
      >
        {ordered.map((m) => (
          <MachineItem
            noticeSess={noticeSess}
            draftKeys={draftKeys}
            activeSessId={activeSessId}
            sessAliases={sessAliases}
            kindOfNode={kindOfNode}
            key={m.nodeId}
            m={m}
            collapsed={collapsed}
            collapsedMach={collapsedMach}
            editingDir={editingDir}
            dirAliases={dirAliases}
            onToggleDir={toggle}
            onToggleMach={toggleMach}
            onStartEditDir={setEditingDir}
            onCommitDir={(nodeId, dir, v) => { void commitDirName(nodeId, dir, v); }}
            editingMach={editingMach}
            onStartEditMach={setEditingMach}
            onCommitMach={commitMachName}
            projOf={projOf}
            iconRev={iconRev}
            onOpenProjSettings={(nodeId, dir) => setProjSettings({ nodeId, dir })}
            onDirContext={(e, nodeId, dir) => { setSessCtx(null); setDirCtx({ x: e.clientX, y: e.clientY, nodeId, dir }); }}
            onOpenSession={onOpenSession}
            onOpenChat={onOpenChat}
            onRenameSession={onRenameSession}
            sessTags={sessTags}
            onSetSessionTags={onSetSessionTags}
            sessPins={sessPins}
            onToggleSessPin={onToggleSessPin}
            onSessContext={(e, s) => { e.preventDefault(); e.stopPropagation(); setSessCtx({ x: e.clientX, y: e.clientY, s }); }}
            sessEditId={sessEditId}
            onSessEditId={setSessEditId}
            tagEditId={tagEditId}
            onTagEditId={setTagEditId}
            openAll={searching}
            hl={searching ? needle : undefined}
            onNewSession={onNewSession}
          />
        ))}
      </Reorder.Group>
      </>
      )}

      {/* 标签管理：批量重命名 / 删除 */}
      {tagMgrOpen && (
        <TagManager
          sessTags={sessTags}
          onSetSessionTags={onSetSessionTags}
          tagOrder={tagOrder}
          onReorderTagOrder={onReorderTagOrder}
          onClose={() => setTagMgrOpen(false)}
        />
      )}

      {/* 会话右键菜单：加标签 / 改名 / 打开 */}
      {sessCtx && (
        <div
          className="ctxm pj-sess-ctxm"
          style={{ left: Math.min(sessCtx.x, window.innerWidth - 190), top: Math.min(sessCtx.y, window.innerHeight - 190) }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => { setInfoKey({ id: sessCtx.s.id, nodeId: sessCtx.s.nodeId }); setSessCtx(null); }}>查看详情</button>
          <button onClick={() => { onOpenSession(sessCtx.s.nodeId, sessCtx.s.id); setSessCtx(null); }}>打开对话</button>
          <button onClick={() => { onToggleSessPin(sessCtx.s.id); setSessCtx(null); }}>
            {sessPins.includes(sessCtx.s.id) ? "取消置顶" : "置顶"}
          </button>
          <button onClick={() => { setEditModal({ s: sessCtx.s, focus: "tags" }); setSessCtx(null); }}>添加 / 修改标签</button>
          <button onClick={() => { setEditModal({ s: sessCtx.s, focus: "name" }); setSessCtx(null); }}>设置会话名称</button>
          {sessCtx.s.directory && onRecreateDir && (
            <button onClick={() => { onRecreateDir(sessCtx.s.nodeId, sessCtx.s.directory); setSessCtx(null); }}>
              重建工作目录
            </button>
          )}
          {sessCtx.s.directory && (
            <button onClick={() => { setProjSettings({ nodeId: sessCtx.s.nodeId, dir: sessCtx.s.directory }); setSessCtx(null); }}>
              项目设置（名称 / 图标）
            </button>
          )}
        </div>
      )}

      {/* 目录头右键菜单：项目设置 / 改名 / 新建会话 / 复制路径 */}
      {dirCtx && (
        <div
          className="ctxm pj-sess-ctxm"
          style={{ left: Math.min(dirCtx.x, window.innerWidth - 210), top: Math.min(dirCtx.y, window.innerHeight - 170) }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button onClick={() => { setProjSettings({ nodeId: dirCtx.nodeId, dir: dirCtx.dir }); setDirCtx(null); }}>项目设置（名称 / 图标 / 颜色）</button>
          <button onClick={() => { setEditingDir(`${dirCtx.nodeId}::${dirCtx.dir}`); setDirCtx(null); }}>改名</button>
          <button onClick={() => { onNewSession(dirCtx.dir); setDirCtx(null); }}>在此新建会话</button>
          {dirCtx.dir && (
            <button onClick={() => {
              try { void navigator.clipboard.writeText(dirCtx.dir); } catch { /* 剪贴板不可用就算了 */ }
              setDirCtx(null);
            }}>复制目录路径</button>
          )}
        </div>
      )}

      {/* 会话编辑弹窗：名称 + 标签 */}
      {editModal && (
        <SessEditModal
          s={editModal.s}
          sessTags={sessTags}
          initialFocus={editModal.focus}
          onClose={() => setEditModal(null)}
          onRename={(v) => { void onRenameSession(editModal.s, v); }}
          onSetTags={(tags) => onSetSessionTags(editModal.s.id, tags)}
        />
      )}

      {infoSess && (
        <SessionInfoModal
          s={infoSess}
          node={nodeById.get(infoSess.nodeId)}
          runAgent={(runAgents ?? []).find((r) => r.id === infoSess.nodeId)}
          proj={projOf(infoSess.nodeId, infoSess.directory)}
          tags={sessTags[infoSess.id] ?? []}
          pinned={sessPins.includes(infoSess.id)}
          alias={sessAliases?.[infoSess.id] || infoSess.title || infoSess.id}
          dirLabel={dirLabelOf(infoSess)}
          onClose={() => setInfoKey(null)}
          onOpenChat={() => { onOpenChat(infoSess.nodeId, infoSess.id); setInfoKey(null); }}
          onOpenProjectSettings={infoSess.directory ? () => { setProjSettings({ nodeId: infoSess.nodeId, dir: infoSess.directory }); setInfoKey(null); } : undefined}
          onRecreateDir={infoSess.directory && onRecreateDir ? () => { onRecreateDir(infoSess.nodeId, infoSess.directory); setInfoKey(null); } : undefined}
        />
      )}

      {/* 项目设置弹窗：名称/图标/颜色，保存写回 opencode */}
      {projSettings && (
        <ProjEditModal
          nodeId={projSettings.nodeId}
          dir={projSettings.dir}
          proj={projOf(projSettings.nodeId, projSettings.dir)}
          onClose={() => setProjSettings(null)}
          onSave={async (patch) => {
            const r = await onSaveProject(projSettings.nodeId, projSettings.dir, patch);
            if (r.ok) {
              if (patch.name !== undefined) onRenameDir(projSettings.dir, ""); // opencode 成为权威，清本地别名
              if (patch.icon && (patch.icon.override || patch.icon.clearImage)) {
                const key = `${projSettings.nodeId}::${projSettings.dir}`;
                setIconRev((m) => ({ ...m, [key]: (m[key] ?? 0) + 1 }));
              }
            }
            return r;
          }}
          onLocalAlias={(n) => onRenameDir(projSettings.dir, n)}
        />
      )}

      {showTop && (
        <button className="pj-top" onClick={scrollTop} title="回到顶部">↑</button>
      )}
    </div>
  );
}