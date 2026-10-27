import { useEffect, useRef, useState } from "react";
import { apiUrl, getKey, apiHeaders } from "../lib/api.js";

export interface SessionView {
  id: string;
  title: string;
  directory: string;
  busy: boolean;
  updatedAt: number;
  cost: number;
  tokens: { input: number; output: number };
  model?: string;
  providerID?: string;
  agent?: string;
  lastPrompt?: string;
  lastError?: string;
  lastErrorAt?: number;
}

/** opencode 项目元数据（图片本体走 /api/nodes/:id/projects/icon 按需取） */
export interface ProjectMeta {
  id: string;
  worktree: string;
  name?: string;
  icon?: { color?: string; hasOverride?: boolean; hasImage?: boolean };
  sandboxes?: string[];
}

export interface NodeView {
  id: string;
  label: string;
  baseLabel?: string;
  url: string;
  status: "online" | "stale" | "offline";
  lastOkAt: number | null;
  latencyMs: number | null;
  error: string | null;
  sessions: SessionView[];
  busyCount: number;
  recentEvents: any[];
  sseConnected: boolean;
  pendingPermissions: any[];
  pendingQuestions: any[];
  machine?: string;
  dirs?: string[];
  projects?: ProjectMeta[];
}

export interface RunAgentView {
  id: string;
  kind: "run";
  label: string;
  pid: number;
  procCount: number;
  bridge: string;
  workDir: string;
  cpuSeconds: number;
  active: boolean;
  busyCount: number;
  lastActivityAt: number;
activeDir?: string;
  sessions: SessionView[];
  machine?: string;
  sessionId?: string;
  finished?: boolean;
  finishedAt?: number;
}

export interface SelfInfo {
  id: string;
  label: string;
  version: string;
  port: number;
  key: string | null;
  /** auto=还是首次自动生成的密钥（没加入过机队）/ user=用户设过 / env=环境变量 */
  keySource?: "auto" | "user" | "env";
  /** 是否走过首次组网引导（全新安装=false，会弹向导） */
  onboarded?: boolean;
  /** 探测到但拿不到凭据的本机 opencode 端口（桌面版自带 server 常见） */
  localSkipped?: number[];
  /** 已在面板里手填过凭据的端口 */
  localAuthPorts?: number[];
  /** 跨网段扫描配置 */
  scan?: { enabled: boolean; subnets: string[]; ports: number[]; intervalMs?: number };
  /** 本机负载（CPU/内存），每个实例只采自己所在机器 */
  host?: HostMetrics;
  /** 机器（节点）自定义显示名覆盖表：nodeId -> 名（后端持久化，团队共享） */
  nodeLabels?: Record<string, string>;
  /** 团队共享元数据（本机那份，含时间戳；上层合并视图见 Snapshot.teamMeta） */
  teamMeta?: Record<string, { v: unknown; at: number }>;
}

/** 一台机器的实时负载（本机自采 + peer 合并） */
export interface HostMetrics {
  machine: string;
  label?: string;
  hostname: string;
  platform: string;
  cpuCount: number;
  cpuPct: number;
  loadavg: [number, number, number];
  memTotal: number;
  memUsed: number;
  memPct: number;
  self?: boolean;
  at: number;
}

export interface DiscoveredView {
  id: string;
  label: string;
  host: string;
  port: number;
  version: string;
  manual?: boolean;
  paired: boolean;
  state: "ok" | "key" | "wait";
  dataAge: number | null;
  fresh: boolean;
  /** 版本一致性：对端比我旧（older）/ 比我新（newer）/ 无法判断（null） */
  mismatch?: "older" | "newer" | null;
  /** 来源：udp=同网段广播，scan=跨网段扫描 */
  via?: "udp" | "scan" | null;
}

export interface Snapshot {
  generatedAt: number;
  nodes: NodeView[];
  runAgents: RunAgentView[];
  /** 机队里各机器的实时负载（本机 + peer 上报的本机） */
  hosts?: HostMetrics[];
  self?: SelfInfo;
  discovered?: DiscoveredView[];
  /** 全机群合并后的团队共享元数据（标签/别名/颜色/置顶等，last-write-wins，带 at 时间戳） */
  teamMeta?: Record<string, { v: unknown; at: number }>;
  /** 团队派活任务记录（组长出计划 → 自动分发子任务） */
  teamJobs?: TeamJobView[];
}

export interface TeamJobView {
  id: string; teamId: string; leader: string; task: string; at: number; status: string;
  subtasks: string[];
  assigns: { member: string; node: string; dir: string; task: string; sessionId?: string; status: string; at: number; output?: string }[];
  summary?: string;
}

export type AgentState = "writing" | "awaiting" | "ready" | "asleep" | "done";

export function stateOf(nd: NodeView | RunAgentView): AgentState {
  if ((nd as RunAgentView).kind === "run") {
    const ra = nd as RunAgentView;
    if (ra.finished) return "done";
    return ra.active ? "writing" : "asleep";
  }
  const n = nd as NodeView;
  const pending = (n.pendingPermissions?.length ?? 0) + (n.pendingQuestions?.length ?? 0);
  if (pending) return "awaiting";
  if (n.sessions?.some((s) => s.busy)) return "writing";
  if (n.status === "offline" || Date.now() - (n.lastOkAt ?? 0) > 180000) return "asleep";
  return "ready";
}

/** 会话级状态：busy=写作中；宿主持有待审批/待答疑=等待；宿主离线=休眠；否则视为已完成 */
export function sessionStateOf(busy: boolean, host: NodeView | null | undefined): AgentState {
  if (busy) return "writing";
  if (!host) return "done";
  const pending = (host.pendingPermissions?.length ?? 0) + (host.pendingQuestions?.length ?? 0);
  if (pending) return "awaiting";
  if (host.status === "offline" || Date.now() - (host.lastOkAt ?? 0) > 180000) return "asleep";
  return "done";
}

/**
 * 团队密钥闸门：服务端启用了密钥（/api/node-info 的 secure）时，
 * 浏览器先拿到密钥才连 SSE / 取数据；gate 用于界面提示。
 */
export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [gate, setGate] = useState<"need" | "bad" | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const ref = useRef<EventSource | null>(null);
  const offlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stop = false;
    let es: EventSource | null = null;
    const clearOfflineTimer = () => {
      if (offlineTimer.current) { clearTimeout(offlineTimer.current); offlineTimer.current = null; }
    };
    const clearRetryTimer = () => {
      if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    };
    const boot = async () => {
      const info = await fetch("/api/node-info").then((r) => r.json()).catch(() => null);
      if (stop) return;
      // 服务没启动 / 连不上：置为不可达，并周期性重试（服务起来后自动恢复，不用手动刷新）
      if (!info) {
        setUnreachable(true);
        clearRetryTimer();
        retryTimer.current = setTimeout(() => { retryTimer.current = null; if (!stop) void boot(); }, 2000);
        return;
      }
      setUnreachable(false);
      if (info?.needKey) {
        const k = getKey();
        if (!k) {
          setGate("need");
          return;
        }
        const probe = await fetch("/api/snapshot", { headers: apiHeaders() }).catch(() => null);
        if (stop) return;
        if (probe && probe.status === 401) {
          setGate("bad");
          return;
        }
      }
      setGate(null);
      es = new EventSource(apiUrl("/api/stream"));
      ref.current = es;
      es.addEventListener("snapshot", (m) => {
        try {
          setSnap(JSON.parse((m as MessageEvent).data));
          setConnected(true);
          clearOfflineTimer(); // 收到快照即在线，取消待定的离线判定
        } catch {}
      });
      // EventSource 断开后浏览器会自动重连；给 6s 宽限期再判离线，避免瞬时重连造成 live/offline 来回抖
      es.onerror = () => {
        if (stop || offlineTimer.current) return;
        offlineTimer.current = setTimeout(() => { offlineTimer.current = null; if (!stop) setConnected(false); }, 6000);
      };
    };
    void boot();
    return () => {
      stop = true;
      clearOfflineTimer();
      clearRetryTimer();
      es?.close();
    };
  }, []);

  return { snap, connected, gate, unreachable };
}


export async function post(url: string, body?: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({ ok: false }));
}

export function allNodes(snap: Snapshot | null) {
  return [...(snap?.nodes ?? []), ...(snap?.runAgents ?? [])];
}

export function ago(ts: number | null | undefined) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

// 跟随主题：用 CSS 变量而非固定色，切主题时球/指示点自动变
export const STATE_COLORS: Record<AgentState, string> = {
  writing: "var(--writing)",
  awaiting: "var(--awaiting)",
  ready: "var(--ready)",
  asleep: "var(--asleep)",
  done: "var(--done)",
};

export const STATE_LABELS: Record<AgentState, string> = {
  writing: "WRITING",
  awaiting: "AWAITING",
  ready: "READY",
  asleep: "ASLEEP",
  done: "DONE",
};
