import { OpenCodeClient } from "./client.ts";
import { hostname, homedir, platform } from "node:os";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findLocalOpencodePorts, findLocalOpencodeAuth, probeOpencode, LocalServerAuth, DiscoveredServer, clearDiscoverAuthCache, controlOpencodeDesktop, findOpencodeDesktopApp } from "./discover.ts";
import { PeerDiscovery, DiscoveredPeer } from "./discovery.ts";
import { scanForAtrium, localSubnets, ScannedPeer } from "./scan.ts";
import { findRunAgentProcs, recentBridgeSessions, findBridgeDaemons, findDesktopApp, openclawSessions, hermesSessions, piSessions, findStandalonePi, spawnPiPrompt, piMessages, piSessionFile, windowsSnapshot } from "./runagents.ts";
import { ocStatusLocal, ocConfigReadLocal, ocConfigWriteLocal, ocInstallLocal, ocHookLocal, ocPluginLocal, ocFixedPwStatusLocal, ocSetFixedPwLocal, ocClearFixedPwLocal, ocServeLocal, ocServeListLocal, ocServeStopLocal } from "./opencodecfg.ts";
import type { EventView, FleetConfig, HostMetrics, ModelRef, ModelsResponse, NodeConfig, NodeStatus, NodeView, OcInitJob, OcInitStep, PeerConfig, PendingPermission, PendingQuestion, ProviderModels, RunAgentView, SessionView, TeamJobView, TeamMember, TeamOpts } from "./types.ts";
import { HostMonitor } from "./hostmetrics.ts";
import { fsListLocal, fsMkdirLocal, fsRenameLocal, fsStatLocal, isAbsolutePathFor } from "./fsx.ts";

const EVENT_BUFFER = 200;
/** 跨网段扫描结果的保鲜期（超过就当没扫到） */
const SCAN_TTL = 10 * 60_000;

/** 粗略语义化版本比较：只比数字段 */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function prettyHostName(): string {
  const fallback = hostname().replace(/\.(local|lan)$/, "");
  try {
    const p = platform();
    if (p === "darwin") {
      const out = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out;
    } else if (p === "linux") {
      const txt = readFileSync("/etc/machine-info", "utf8");
      const m = /^PRETTY_HOSTNAME="?([^"\n]+)"?/m.exec(txt);
      if (m?.[1]?.trim()) return m[1].trim();
    }
  } catch {}
  return fallback;
}

const LOCAL_HOST = prettyHostName();

/**
 * 聊天窗展示用：裁剪消息里的超大 part（超长正文/思考、tool 输入输出、base64 附件），
 * 避免会话每 3 秒轮询拉回几 MB 的 JSON 把浏览器拖死。
 */
function shrinkMessages(list: any[]): any[] {
  const MAX_TEXT = 6000;
  const MAX_TOOL = 3000;
  return (list ?? []).map((m: any) => {
    if (!m || !Array.isArray(m.parts)) return m;
    const parts = m.parts.map((p: any) => {
      if (!p) return p;
      const t = p.type;
      if (t === "text" || t === "reasoning") {
        const txt = p.text ?? "";
        return txt.length > MAX_TEXT ? { ...p, text: txt.slice(0, MAX_TEXT) + "\n…(已截断)" } : p;
      }
      if (t === "tool") {
        const txt = p.text ?? "";
        const clip = (s: string) => (s.length > MAX_TOOL ? s.slice(0, MAX_TOOL) + "\n…(已截断)" : s);
        // 保留命令/输出/元数据，聊天窗才能点开查看 shell 内容；过大则截断
        let input = p.state?.input;
        try { const s = JSON.stringify(input); if (s && s.length > MAX_TOOL) input = { _truncated: s.slice(0, MAX_TOOL) + "…" }; } catch { input = undefined; }
        const outRaw = p.state?.output;
        const output = typeof outRaw === "string" ? clip(outRaw) : (outRaw != null ? clip(String(outRaw)) : undefined);
        let metadata = p.state?.metadata;
        try { const s = JSON.stringify(metadata); if (s && s.length > MAX_TOOL) metadata = { _truncated: s.slice(0, MAX_TOOL) + "…" }; } catch { metadata = undefined; }
        return {
          type: "tool",
          tool: p.tool,
          state: { status: p.state?.status ?? "completed", title: p.state?.title ?? p.tool, input, output, metadata },
          text: clip(txt),
        };
      }
      if (t === "file" || t === "image") {
        // 保留 url(data URL) 才能在聊天里预览/下载；过大则只留文件名，避免单条把 payload 撑爆
        const url = typeof p.url === "string" ? p.url : "";
        return { type: t, filename: p.filename, mime: p.mime, ...(url && url.length <= 1_500_000 ? { url } : {}) };
      }
      return p;
    });
    // info 里可能带 opencode 的大 diff 摘要（summary.diffs.patch），聊天窗用不到，丢弃
    const info = m.info
      ? { id: m.info.id, role: m.info.role, time: m.info.time }
      : m.info;
    return { ...m, info, parts };
  });
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)/.test(url);
}

/** 从消息里提取组长输出的 team-plan 计划块（只看 sinceAt 之后的助手消息，取最近一条） */
function extractTeamPlan(msgs: any[], sinceAt: number): string[] | null {
  for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.info?.role !== "assistant") continue;
    if ((m.info?.time?.created ?? 0) < sinceAt) continue;
    for (const p of m.parts ?? []) {
      if (p?.type !== "text" || !p.text) continue;
      const mm = /```team-plan\s*([\s\S]*?)```/.exec(p.text);
      if (mm) {
        try {
          const arr = JSON.parse(mm[1].trim());
          if (Array.isArray(arr)) {
            const out = arr.map((x) => (typeof x === "string" ? x : String(x?.task ?? ""))).map((s) => s.trim()).filter(Boolean);
            if (out.length) return out;
          }
        } catch { /* 解析失败继续找 */ }
      }
    }
  }
  return null;
}

/**
 * 从本机 opencode 的 SQLite 里枚举「出现过会话」的所有目录。
 *
 * 为什么需要它：全局 /session 与 /project 只覆盖"登记过的项目/工作区"，
 * cc-connect / CLI / 老版本桌面建的会话目录未必在其中，导致那些会话在看板
 * 上完全拉不到（连 busy 都判断不了）。这里直接读同库兜底——本机节点的
 * client 与看板跑在同一台机器上，读得到这份 DB。
 */
function dbSessionDirs(): string[] {
  const now = Date.now();
  if (now - dbDirsAt < 30_000) return dbDirsCache;
  dbDirsAt = now;
  try {
    const dbPath = process.env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
    if (!existsSync(dbPath)) return (dbDirsCache = []);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory != ''").all() as { directory: string }[];
    db.close();
    return (dbDirsCache = rows
      .map((r) => r.directory)
      .filter((d) => d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d)));
  } catch {
    return (dbDirsCache = []);
  }
}
let dbDirsCache: string[] = [];
let dbDirsAt = 0;

/** 属于 opencode 生态的运行任务（cc-connect 启动的 worker / desktop），完成后需要保留待确认 */
function isOpencodeRun(r: RunAgentView): boolean {
  if (r.kind !== "run") return false;
  if (r.id.startsWith("run-ccw-")) return true;
  return ["cc-connect", "ccconnect", "desktop"].includes(r.bridge ?? "");
}

/** 按目录找 opencode 项目：先 worktree 精确匹配，再 sandbox 子目录 */
function matchProject(projects: any[], dir: string): any | null {
  const norm = (s: string) => String(s ?? "").replace(/[\\/]+$/, "");
  const d = norm(dir);
  if (!d) return null;
  return (
    projects.find((p) => norm(p?.worktree) === d) ??
    projects.find((p) => (Array.isArray(p?.sandboxes) ? p.sandboxes : []).some((s: string) => norm(s) === d)) ??
    null
  );
}

const FINISHED_CAP = 24;

function normalizeEvent(payload: any): EventView | null {
  const type = payload?.type ?? "unknown";
  const p = payload?.properties ?? {};
  const sessionID: string | undefined = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
  let summary = "";
  switch (type) {
    case "message.part.updated": {
      const part = p.part ?? {};
      if (part.type === "tool") {
        summary = `tool:${part.tool ?? "?"} ${part.state?.title ?? part.state?.status ?? ""}`.trim();
      } else if (part.type === "text") {
        summary = "text";
      } else {
        summary = `part:${part.type ?? "?"}`;
      }
      break;
    }
    case "message.updated":
      summary = `msg:${p.info?.role ?? "?"}`;
      break;
    case "session.status":
      summary = p.status?.type ?? "";
      break;
    case "session.idle":
      summary = "idle";
      break;
    case "session.error": {
      const err = p.error ?? p.info?.error ?? p;
      const msg = err?.data?.message ?? err?.message ?? err?.data?.error ?? err?.name ?? (typeof err === "string" ? err : "");
      summary = `error: ${msg || JSON.stringify(err) || "?"}`.slice(0, 500);
      break;
    }
    case "permission.updated":
      summary = `PERMISSION ${p.permission?.type ?? p.id ?? ""}`;
      break;
    case "file.edited":
      summary = `file ${p.file ?? ""}`;
      break;
    case "todo.updated":
      summary = "todo updated";
      break;
    case "session.updated":
      summary = p.info?.title ? `title: ${p.info.title}` : "updated";
      break;
    case "server.heartbeat":
    case "server.connected":
    case "sync":
      return null;
    default:
      summary = "";
  }
  return { ts: Date.now(), type, sessionID, summary };
}

class NodeState {
  status: NodeStatus = "offline";
  lastOkAt: number | null = null;
  latencyMs: number | null = null;
  error: string | null = null;
  sessions = new Map<string, SessionView>();
  /** 会话「连续多少轮从服务端结果里缺失」：用于平滑偶发掉线（补拉超时/服务端忙），避免看板与置顶闪烁 */
  private sessionMisses = new Map<string, number>();
  /** 每个会话「用户最后一次提问/消息」原文：从 message.part.updated 事件实时捕获，用于卡片/详情标题 tip */
  lastPrompt = new Map<string, string>();
  /** messageID -> role，用于把 part.updated 归属到具体消息角色 */
  private lastPromptRoles = new Map<string, string>();
  pendingPermissions: any[] = [];
  pendingQuestions: any[] = [];
  events: EventView[] = [];
  /** 额外要轮询的目录：全局 /session 不包含某些目录（CC/CLI 建的），必须按目录单独拉 */
  extraDirs = new Set<string>();
  /** /project 列出的项目目录（30s 刷新一次） */
  private projectDirs: string[] = [];
  /** /project 原始返回（含图标 data URL），只留在服务端，快照里给瘦身版 */
  private projectsRaw: any[] = [];
  private projectAt = 0;
  sseConnected = false;
  remoteRunAgents: RunAgentView[] = [];
  remoteMachine: string | null = null;
  private running = false;
  private client: OpenCodeClient;
  private pollTimer: NodeJS.Timeout | null = null;
  private sseAbort: AbortController | null = null;
  private dirty = true;

  constructor(public cfg: NodeConfig, private pollIntervalMs: number, private onDirty: () => void) {
    this.client = new OpenCodeClient(cfg);
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
    void this.sseLoop();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.sseAbort?.abort();
  }

  private schedule(ms: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollLoop(), ms);
  }

  /** trigger a poll soon (used by control-plane actions & permission events) */
  kickPoll() {
    if (!this.running) return;
    this.schedule(300);
  }

  /** 登记一个需要按目录轮询的路径（绝对路径才收） */
  addDir(dir: string | null | undefined) {
    const d = String(dir ?? "").trim();
    if (!d) return;
    if (!d.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(d)) return;
    this.extraDirs.add(d);
  }

  private markDirty() {
    this.dirty = true;
    this.onDirty();
  }

  /** 拉取 /project 全量元数据（名称/图标/颜色），30s 保鲜；force=true 立即刷新 */
  async refreshProjects(force = false): Promise<any[]> {
    if (!force && Date.now() - this.projectAt < 30_000) return this.projectsRaw;
    try {
      const pj = await this.client.listProjects();
      this.projectsRaw = pj.filter((p: any) => typeof p?.worktree === "string" && p.worktree);
      this.projectDirs = pj
        .map((p: any) => String(p?.worktree ?? p?.directory ?? ""))
        .filter((d: string) => d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d));
      this.projectAt = Date.now();
    } catch {
      /* 老版本没有 /project，忽略 */
    }
    return this.projectsRaw;
  }

  /** PATCH 成功后就地更新缓存，界面不用等下一轮轮询 */
  applyProject(p: any) {
    if (!p?.id) return;
    const i = this.projectsRaw.findIndex((x) => x.id === p.id);
    if (i >= 0) this.projectsRaw[i] = p;
    else this.projectsRaw.push(p);
    this.markDirty();
  }

  get projects() {
    return this.projectsRaw;
  }

  private async pollLoop() {
    if (!this.running) return;
    const t0 = Date.now();
    try {
      const list = await this.client.listSessions();
      this.latencyMs = Date.now() - t0;
      this.lastOkAt = Date.now();
      this.error = null;
      const dirs = new Set<string>();
      const next = new Map<string, SessionView>();
      for (const s of list) {
        const dir = s.directory ?? "";
        dirs.add(dir);
        next.set(s.id, {
          id: s.id,
          title: s.title ?? "",
          directory: dir,
          busy: false, // 默认不忙，由下方 statusFor 明确置 busy，避免已停止会话沿用旧 busy=true 卡"进行中"
          updatedAt: s.time?.updated ?? 0,
          cost: s.cost ?? 0,
          tokens: { input: s.tokens?.input ?? 0, output: s.tokens?.output ?? 0 },
          model: s.model?.id ?? s.model?.modelID ?? (typeof s.model === "string" ? s.model : undefined),
          providerID: s.model?.providerID,
          agent: s.agent,
        });
      }
      // 全局 /session 可能不含某些目录（cc-connect / CLI 建的），这里按「项目目录 + 登记目录」补拉，
      // 否则这些会话在看板上完全看不到（连 busy 都判断不了 = 没有"会话球"）
      await this.refreshProjects();
      for (const d of new Set([...this.projectDirs, ...this.extraDirs, ...(isLocalUrl(this.cfg.url) ? dbSessionDirs() : [])])) {
        if (dirs.has(d)) continue;
        dirs.add(d);
        try {
          const extra = await this.client.listSessionsFor(d);
          for (const s of extra) {
            if (next.has(s.id)) continue;
            next.set(s.id, {
              id: s.id,
              title: s.title ?? "",
              directory: s.directory ?? d,
              busy: false, // 默认不忙，由下方 statusFor 明确置 busy
              updatedAt: s.time?.updated ?? 0,
              cost: s.cost ?? 0,
              tokens: { input: s.tokens?.input ?? 0, output: s.tokens?.output ?? 0 },
              model: s.model?.id ?? s.model?.modelID ?? (typeof s.model === "string" ? s.model : undefined),
              providerID: s.model?.providerID,
              agent: s.agent,
            });
          }
        } catch {
          /* 目录可能已不存在，忽略 */
        }
      }

      const permById = new Map<string, PendingPermission>();
      const quesById = new Map<string, PendingQuestion>();
      for (const dir of dirs) {
        if (!dir) continue;
        try {
          const st = await this.client.statusFor(dir);
          for (const [sid, v] of Object.entries(st)) {
            const sess = next.get(sid);
            if (sess) sess.busy = v?.type === "busy";
          }
        } catch {
          /* directory may not exist on disk anymore */
        }
        try {
          const per = await this.client.permissionsFor(dir);
          for (const p of per) {
            // /permission 未必严格按目录过滤：同一条会被多个目录重复返回 → 按 id 去重，避免重复弹卡
            if (permById.has(p.id)) continue;
            permById.set(p.id, {
              id: p.id,
              sessionID: p.sessionID,
              permission: p.permission ?? "?",
              patterns: p.patterns ?? [],
              always: p.always ?? [],
            });
          }
        } catch {
          /* ignore */
        }
        try {
          const qs = await this.client.questionsFor(dir);
          for (const q of qs) {
            // 同上：同一提问按 id 去重，避免「待办选择」弹出两个一样的
            if (quesById.has(q.id)) continue;
            quesById.set(q.id, {
              id: q.id,
              sessionID: q.sessionID,
              questions: (q.questions ?? []).map((qq: any) => {
                // 选项再按 label 去重兜底（服务端偶发返回重复选项）
                const seen = new Set<string>();
                const options: { label: string; description?: string }[] = [];
                for (const o of (qq.options ?? [])) {
                  const label = String(o?.label ?? "");
                  if (!label || seen.has(label)) continue;
                  seen.add(label);
                  options.push({ label, description: o.description });
                }
                return { question: qq.question ?? "", header: qq.header, options, multiple: qq.multiple };
              }),
            });
          }
        } catch {
          /* ignore */
        }
      }
      for (const [id, prev] of this.sessions) {
        const nx = next.get(id);
        if (!nx) continue;
        nx.lastError = prev.lastError;
        nx.lastErrorAt = prev.lastErrorAt;
        if (nx.busy) { nx.lastError = undefined; nx.lastErrorAt = undefined; }
      }
      // 平滑瞬时掉线：本轮结果里缺失的会话，若只是偶发（补拉超时 / 服务端忙 / 全局列表抖动），
      // 先沿用上一轮的数据若干轮再真正移除，避免看板与「置顶会话」一闪一闪。连续缺失超限才判定为已删除。
      const MISS_LIMIT = 3;
      for (const [id, prev] of this.sessions) {
        if (next.has(id)) { this.sessionMisses.delete(id); continue; }
        const misses = (this.sessionMisses.get(id) ?? 0) + 1;
        if (misses <= MISS_LIMIT) { this.sessionMisses.set(id, misses); next.set(id, prev); }
        else this.sessionMisses.delete(id);
      }
      this.sessions = next;
      this.pendingPermissions = [...permById.values()];
      this.pendingQuestions = [...quesById.values()];
      this.markDirty();
    } catch (e) {
      this.error = (e as Error).message;
      this.latencyMs = null;
      this.markDirty();
    }
    this.computeStatus();
    void this.fetchRemoteRunAgents();
    this.schedule(this.pollIntervalMs);
  }

  private async fetchRemoteRunAgents() {
    if (!this.cfg.runAgentsUrl) return;
    try {
      const res = await fetch(this.cfg.runAgentsUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json() as { runAgents?: RunAgentView[]; machine?: string };
        // 只盯 opencode：过滤 cc-connect 守护进程本体（其子 opencode worker 保留）
        const seen = new Set<string>();
        const cleaned: RunAgentView[] = [];
        for (const r of data.runAgents ?? []) {
          if (r.bridge === "cc-connect" && r.id === "run-cc-connect") continue;
          // 同一进程被父子关系重复上报（id+label 全同）→ 去重；同 id 不同 label → 加 pid 后缀
          const dupKey = `${r.id}|${r.label}`;
          if (seen.has(dupKey)) continue;
          seen.add(dupKey);
          const id = cleaned.some((o) => o.id === r.id) ? `${r.id}-${r.pid}` : r.id;
          // sidecar 通常不报会话：按工作目录向该节点的 opencode server 补齐，球才能"点进去是对话"
          if (!(r.sessions ?? []).length) {
            r.sessions = await this.sessionsForDir(r.workDir ?? "");
          }
          // 没有会话数据的进程球只代表"存活"，不代表"工作中"——避免虚假的 writing 状态
          const aliveOnly = (r.sessions ?? []).length === 0;
          cleaned.push({
            ...r,
            id,
            active: aliveOnly ? false : r.active,
            lastActivityAt: r.lastActivityAt || r.sessions?.[0]?.updatedAt || (aliveOnly ? 0 : r.lastActivityAt),
          });
        }
        this.remoteRunAgents = cleaned;
        if (data.machine) this.remoteMachine = data.machine.replace(/\.(local|lan)$/, "");
      } else {
        this.remoteRunAgents = [];
      }
    } catch {
      this.remoteRunAgents = [];
    }
    this.markDirty();
  }

  /** 按目录向本节点的 opencode server 拉会话（远端 run agent 球的会话快照） */
  private async sessionsForDir(dir: string): Promise<SessionView[]> {
    const isRealDir = dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir);
    if (!isRealDir) return [];
    try {
      const list = await this.client.listSessionsFor(dir);
      return (list ?? [])
        .slice(0, 12)
        .map((s: any): SessionView => ({
          id: s.id,
          title: s.title ?? "",
          directory: dir,
          busy: false,
          updatedAt: s.time?.updated ?? 0,
          cost: s.cost ?? 0,
          tokens: { input: s.tokens?.input ?? 0, output: s.tokens?.output ?? 0 },
          model: s.model?.id ?? s.model?.modelID,
          providerID: s.model?.providerID,
          agent: s.agent,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  private computeStatus() {
    const elapsed = this.lastOkAt ? Date.now() - this.lastOkAt : Infinity;
    const prev = this.status;
    if (elapsed < this.pollIntervalMs * 2) this.status = "online";
    else if (elapsed < 30_000) this.status = "stale";
    else this.status = "offline";
    if (prev !== this.status) this.markDirty();
  }

  private async sseLoop() {
    let backoff = 1000;
    while (this.running) {
      this.sseAbort = new AbortController();
      try {
        const reader = await this.client.openEventStream(this.sseAbort.signal);
        this.sseConnected = true;
        backoff = 1000;
        this.markDirty();
        await this.consume(reader);
      } catch {
        /* reconnect below */
      }
      this.sseConnected = false;
      if (!this.running) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  private async consume(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = "";
    while (this.running) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            this.handleEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
    reader.cancel().catch(() => {});
  }

  private handleEvent(payload: any) {
    const wrapped = payload?.payload ?? payload;
    const ev = normalizeEvent(wrapped);
    if (!ev) return;
    this.events.push(ev);
    if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
    const p = wrapped?.properties ?? {};
    // 捕获用户最后一次提问/消息原文：message.updated 记录 messageID->role，part.updated 的 text 归属到 user 消息即存为 lastPrompt
    if (ev.type === "message.updated") {
      const info = p?.info ?? {};
      const mid = info?.id;
      if (mid && info?.role) this.lastPromptRoles.set(mid, info.role);
      const sess = typeof p?.info?.sessionID === "string" ? p.info.sessionID : ev.sessionID;
      if (info?.role === "user" && sess) {
        for (const part of (info?.parts ?? [])) {
          if (part?.type === "text" && typeof part?.text === "string" && part.text.trim()) {
            this.lastPrompt.set(sess, part.text.trim());
          }
        }
      }
    } else if (ev.type === "message.part.updated") {
      const part = p?.part ?? {};
      if (part?.type === "text" && typeof part?.text === "string" && part.text.trim()) {
        const mid = part?.messageID ?? part?.info?.messageID;
        const role = this.lastPromptRoles.get(mid) ?? part?.role ?? part?.info?.role;
        const sess = typeof part?.sessionID === "string" ? part.sessionID : ev.sessionID;
        if (role === "user" && sess) this.lastPrompt.set(sess, part.text.trim());
      }
    }
    if (ev.type === "session.status" || ev.type === "session.idle") {
      const busy = ev.type === "session.status" ? p.status?.type === "busy" : false;
      if (ev.sessionID) {
        const s = this.sessions.get(ev.sessionID);
        if (s) {
          s.busy = busy;
          if (busy) { s.lastError = undefined; s.lastErrorAt = undefined; }
        }
      }
    }
    if (ev.type === "session.error" && ev.sessionID) {
      const s = this.sessions.get(ev.sessionID);
      if (s) {
        s.busy = false;
        s.lastError = ev.summary.replace(/^error:\s*/, "");
        s.lastErrorAt = ev.ts;
      }
    }
    if (ev.type.startsWith("permission.") || ev.type.startsWith("question.")) {
      this.kickPoll();
    }
    if (ev.type.startsWith("project.")) {
      this.projectAt = 0; // 项目名/图标变了，下一轮立即重拉 /project
      this.kickPoll();
    }
    this.markDirty();
  }

  view(): NodeView {
    this.computeStatus();
    const dirs = [...new Set([
      ...this.projectDirs,
      ...this.extraDirs,
      ...([...this.sessions.values()].map((s) => s.directory).filter(Boolean)),
    ])];
    return {
      id: this.cfg.id,
      label: this.cfg.label,
      machine: this.remoteMachine ?? undefined,
      url: this.cfg.url,
      status: this.status,
      lastOkAt: this.lastOkAt,
      latencyMs: this.latencyMs,
      error: this.error,
      sessions: [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => ({ ...s, lastPrompt: this.lastPrompt.get(s.id) })),
      busyCount: [...this.sessions.values()].filter((s) => s.busy).length,
      recentEvents: this.events.slice(-60).reverse(),
      sseConnected: this.sseConnected,
      pendingPermissions: this.pendingPermissions.map((p) => ({ ...p })),
      pendingQuestions: this.pendingQuestions.map((q) => ({ ...q })),
      dirs,
      projects: this.projectsRaw.map((p: any) => ({
        id: String(p.id ?? ""),
        worktree: String(p.worktree ?? ""),
        name: p.name || undefined,
        icon: p.icon?.override || p.icon?.url || p.icon?.color
          ? {
              color: p.icon?.color || undefined,
              hasOverride: Boolean(p.icon?.override),
              hasImage: Boolean(p.icon?.url),
            }
          : undefined,
        sandboxes: Array.isArray(p.sandboxes) && p.sandboxes.length ? p.sandboxes.map(String) : undefined,
      })),
    };
  }
}

export class FleetRegistry {
  private nodes = new Map<string, NodeState>();
  private listeners = new Set<(snapshot: any) => void>();
  private flushTimer: NodeJS.Timeout | null = null;
  private discoverTimer: NodeJS.Timeout | null = null;
  private dynamicPorts = new Set<number>();
  private staticPorts = new Set<number>();
  /** sessionId → 最近一次派给 pi 的 --print 子进程 pid（abort 用） */
  private piJobs = new Map<string, number>();
  /** 探测到但需要凭据的本机端口（UI 提示用） */
  private localSkipped = new Set<number>();
  private unauthLogged = new Set<number>();
  /** 端口 → 有效的凭据（试出来之后缓存，避免每轮都逐个试） */
  private portAuth = new Map<number, LocalServerAuth>();
  /** 端口 → 连续探测失败轮数（容忍偶发超时） */
  private portMisses = new Map<number, number>();
  private pollIntervalMs: number;
  private discoverLocal: boolean;
  private localAuth: string | undefined;
  private cfg: FleetConfig;
  private runAgents: RunAgentView[] = [];
  private finishedRunAgents: RunAgentView[] = [];
  private prevCpu = new Map<number, number>();
  private peers: PeerConfig[] = [];
  private peerSnaps = new Map<string, { at: number; snap: any }>();
  private peerTimer: NodeJS.Timeout | null = null;
  private peerPolling = false;
  private discovery: PeerDiscovery | null = null;
  private discovered: DiscoveredPeer[] = [];
  private scanned = new Map<string, DiscoveredPeer>();
  private scanExtra: string[] = [];
  private scanTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private peerErrors = new Map<string, "key" | "down">();
  /** 本机负载采集器（CPU/内存），每个实例只采自己所在机器；跨机由 peer 合并 */
  private host: HostMonitor;
  private hostTimer: NodeJS.Timeout | null = null;
  /** 团队密钥：本实例的 id/label/版本信息，供自动发现广播 */
  readonly selfId: string;
  /** 实际监听端口（升级脚本重启时复用） */
  get port() {
    return this.cfg.port;
  }
  selfLabel: string;
  readonly version: string;

  constructor(cfg: FleetConfig, dataDir?: string) {
    this.cfg = cfg;
    this.dataDir = dataDir;
    this.loadJobs();
    this.pollIntervalMs = cfg.pollIntervalMs;
    this.discoverLocal = cfg.discoverLocal ?? true;
    this.peers = cfg.peers ?? [];
    this.selfId = cfg.id ?? "local";
    this.selfLabel = cfg.label ?? "local";
    this.version = process.env.ATRIUM_VERSION ?? "0.1.0";
    this.host = new HostMonitor(LOCAL_HOST, this.selfLabel);
    const u = process.env.OPENCODE_SERVER_USERNAME;
    const p = process.env.OPENCODE_SERVER_PASSWORD;
    if (u && p) this.localAuth = "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
    for (const n of cfg.nodes) {
      try {
        // 只有「本机地址」的节点才占用本机端口空间；远程节点同端口不应抑制本机 opencode 的自动发现
        if (isLocalUrl(n.url)) this.staticPorts.add(Number(new URL(n.url).port || 80));
      } catch {
        /* bad url surfaced by poll error */
      }
      this.nodes.set(n.id, new NodeState(n, cfg.pollIntervalMs, () => this.scheduleFlush()));
    }
  }

  start() {
    for (const n of this.nodes.values()) n.start();
    if (this.discoverLocal) void this.discoveryLoop();
    if (this.cfg.discover !== false) {
      this.discovery = new PeerDiscovery(
        () => ({ id: this.selfId, port: this.cfg.port, label: this.selfLabel, version: this.version }),
        {
          onPeers: (peers) => {
            this.discovered = peers;
            this.scheduleFlush();
          },
          log: (m) => console.log(`[atrium] ${m}`),
        },
      );
      this.discovery.start();
    }
    if (this.cfg.scanEnabled !== false) {
      // 起服几秒后再扫，别和初始化抢资源
      this.scanTimer = setTimeout(() => void this.runScan(), 5000);
    }
    void this.peerLoop();
    this.resumeTeamJobs();
    // 全机队自动 abort 已移除（updatedAt 停滞不等于卡死，误杀在用会话）；保留通知 + 聊天窗手动解锁 + 团队子任务自动 abort
    // 本机负载：每 4s 采一次样，采完（内存精修是异步的）再推一帧；与 5s 轮询错开，界面更跟手
    this.hostTimer = setInterval(() => {
      void this.host.sample().then(() => this.scheduleFlush());
    }, 4000);
    // 预热 Windows 进程/端口快照：避免首个 /api/local-opencode-desktop 冷启动时
    // PowerShell 全进程枚举超时，组网页面拿不到桌面版按钮
    if (process.platform === "win32") {
      setTimeout(() => { void windowsSnapshot().catch(() => {}); }, 2000);
    }
  }

  stop() {
    for (const n of this.nodes.values()) n.stop();
    this.discovery?.stop();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.discoverTimer) clearTimeout(this.discoverTimer);
    if (this.peerTimer) clearTimeout(this.peerTimer);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.hostTimer) clearInterval(this.hostTimer);
    if (this.teamTimer) clearInterval(this.teamTimer);
  }

  /** 记下某个端口的账号密码（写盘由调用方负责），并立刻重跑一轮发现 */
  setLocalAuth(port: number, username: string, password: string) {
    this.cfg.localAuth = { ...(this.cfg.localAuth ?? {}), [String(port)]: { username, password } };
    this.portAuth.set(port, { username, password, header: "Basic " + Buffer.from(`${username}:${password}`).toString("base64") });
    this.unauthLogged.delete(port);
    this.localSkipped.delete(port);
    this.kickDiscovery();
  }

  /** 立刻跑一轮本机发现（不等 10s 定时器） */
  kickDiscovery() {
    if (this.discoverTimer) clearTimeout(this.discoverTimer);
    this.discoverTimer = setTimeout(() => void this.discoveryLoop(), 50);
  }

  /** 主动重试本机发现：连跑 attempts 轮，每轮之间清掉鉴权缓存与失败标记，方便"密码刚变"时多试几次抓住 */
  async rediscoverLocal(attempts = 3) {
    this.localSkipped.clear();
    this.unauthLogged.clear();
    this.portAuth.clear();
    for (let i = 0; i < attempts; i++) {
      clearDiscoverAuthCache();
      await this.discoveryLoop();
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600));
    }
    this.scheduleFlush();
  }

  /** 控制本机 OpenCode 桌面版程序（start/stop/restart），随后自动重扫凭据并落盘本机 localAuth。密码只属于本机，不跨机队共享。 */
  async controlLocalOpencode(action: "start" | "stop" | "restart"): Promise<{ ok: boolean; error?: string; recovered?: { port: number; username: string } }> {
    const r = await controlOpencodeDesktop(action);
    if (!r.ok) return { ok: false, error: r.error };
    if (action === "stop") {
      this.kickDiscovery();
      this.scheduleFlush();
      return { ok: true };
    }
    // start / restart：等桌面版 server 起来，拿新密码，扫到就落盘本机
    await new Promise((res) => setTimeout(res, 1200));
    await this.rediscoverLocal(3);
    const recovered = await this.persistRecoveredDesktopCredential();
    return { ok: true, recovered };
  }

  /**
   * 从运行中的本机 opencode server 里，把刚扫到的凭据落盘到本机 localAuth。
   * 仅处理本机桌面版（portAuth 命中且属于本机 loopback）；凭据不外发、不写入团队元数据。
   */
  private async persistRecoveredDesktopCredential(): Promise<{ port: number; username: string } | undefined> {
    const auths = await findLocalOpencodeAuth();
    const servers = await findLocalOpencodePorts();
    for (const srv of servers) {
      let used: LocalServerAuth | undefined;
      let probe = await probeOpencode(srv.port);
      if (probe === "unauth") {
        for (const c of auths) {
          const rr = await probeOpencode(srv.port, c.header);
          if (rr === "ok") { used = c; break; }
        }
      } else if (probe === "ok") {
        used = this.portAuth.get(srv.port);
      }
      if (!used || !used.username || !used.password) continue;
      this.setLocalAuth(srv.port, used.username, used.password);
      return { port: srv.port, username: used.username };
    }
    return undefined;
  }

  /** 本机是否装了 OpenCode 桌面版（供组网面板提供重启/停止按钮） */
  async hasLocalOpencodeDesktop(): Promise<{ available: boolean; running: boolean; path?: string }> {
    const app = await findOpencodeDesktopApp();
    if (!app) return { available: false, running: false };
    return { available: true, running: app.pid != null, path: app.path };
  }

  /**
   * 接收「桌面版进程树里的进程」上报的 OpenCode server 密码（不带端口，hub 自己找端口逐个试）。
   * 验证通过即落盘本机 localAuth + 立即重扫纳入节点。密码只本机使用，不写团队元数据。
   */
  async reportLocalOpencodeCred(username: string, password: string): Promise<{ ok: boolean; error?: string; recovered?: { port: number; username: string } }> {
    const u = username.trim();
    if (!u || !password) return { ok: false, error: "用户名和密码都要填" };
    const header = "Basic " + Buffer.from(`${u}:${password}`).toString("base64");
    let servers = await findLocalOpencodePorts();
    if (!servers.length) servers = await findLocalOpencodePorts();
    for (const srv of servers) {
      const r = await probeOpencode(srv.port, header);
      if (r !== "ok") continue;
      this.setLocalAuth(srv.port, u, password);
      this.kickDiscovery();
      return { ok: true, recovered: { port: srv.port, username: u } };
    }
    return { ok: false, error: "这组密码在本机所有 opencode 端口上都验证不通过（可能端口还没起，稍后重试）" };
  }

  /** UDP 自动发现 + 跨网段扫描结果合并（按 id 去重，扫描结果有 TTL） */
  private mergeDiscovered(): DiscoveredPeer[] {
    const now = Date.now();
    const byId = new Map<string, DiscoveredPeer>();
    for (const d of this.discovered) byId.set(d.id, { ...d, via: d.via ?? "udp" });
    for (const [id, d] of this.scanned) if (now - d.at < SCAN_TTL) byId.set(id, d);
    return [...byId.values()];
  }

  private scanConfig(): { subnets: string[]; ports: number[] } {
    const configured = this.cfg.scanSubnets ?? [];
    const subnets = [...new Set([...(configured.length ? configured : localSubnets()), ...this.scanExtra])];
    const ports = this.cfg.scanPorts?.length ? this.cfg.scanPorts : [6080, 6081, 6082];
    return { subnets, ports };
  }

  /** 立刻扫一轮网段（手动/定时共用） */
  async scanNow(extraSubnets?: string[]): Promise<{ ok: boolean; error?: string; scanned: number; found: ScannedPeer[]; subnets: string[]; ms: number }> {
    if (extraSubnets?.length) this.scanExtra = [...new Set([...this.scanExtra, ...extraSubnets.map((s) => s.trim()).filter(Boolean)])];
    const { subnets, ports } = this.scanConfig();
    if (!subnets.length) return { ok: false, error: "没有可扫描的网段", scanned: 0, found: [], subnets, ms: 0 };
    if (this.scanning) return { ok: false, error: "正在扫描中", scanned: 0, found: [], subnets, ms: 0 };
    this.scanning = true;
    try {
      const res = await scanForAtrium(subnets, ports, { selfId: this.selfId });
      const now = Date.now();
      for (const p of res.found) this.scanned.set(p.id, { id: p.id, host: p.host, port: p.port, label: p.label, version: p.version, at: now, via: "scan" });
      console.log(`[atrium] 网段扫描完成：${res.scanned} 个探测点，发现 ${res.found.length} 台（${subnets.join("、")}）`);
      this.scheduleFlush();
      return { ok: true, scanned: res.scanned, found: res.found, subnets, ms: res.ms };
    } finally {
      this.scanning = false;
    }
  }

  private async runScan() {
    try {
      await this.scanNow();
    } catch (e) {
      console.warn(`[atrium] 网段扫描失败：${(e as Error).message}`);
    } finally {
      if (this.cfg.scanEnabled !== false) {
        if (this.scanTimer) clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => void this.runScan(), this.cfg.scanIntervalMs ?? 120_000);
      }
    }
  }

  /** 团队密钥 / 显示名热更新（写盘由调用方负责） */
  setLabel(label: string) {
    this.selfLabel = label;
    this.cfg.label = label;
    this.host.setLabel(label);
    this.scheduleFlush();
  }

  /** 设置机器（节点）显示名：存进本 hub 配置的 nodeLabels（团队共享，snapshot 里覆盖 label）。
   *  label 留空 = 清除自定义、恢复原始名。peer 节点（id 带 ::）额外转发给所属 peer，
   *  让源头也存一份 → 其它 hub 合并该 peer 时也看得到。写盘由调用方（index.ts）负责。 */
  async setNodeLabel(nodeId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    const v = label.trim().slice(0, 60);
    if (!this.cfg.nodeLabels) this.cfg.nodeLabels = {};
    if (v) this.cfg.nodeLabels[nodeId] = v;
    else delete this.cfg.nodeLabels[nodeId];
    // peer 节点：尽力转发给所属 peer，让源头也存一份；失败不影响本机已存的覆盖
    if (nodeId.includes("::")) await this.forwardPeer(nodeId, "label", { label: v });
    this.scheduleFlush();
    return { ok: true };
  }

  /** 设置一条团队共享元数据（标签/别名/颜色/置顶等）。
   *  value=null 表示删除该 key。写进本 hub 配置，随快照在全队机群间 last-write-wins 合并。写盘由调用方负责。 */
  setTeamMeta(key: string, value: unknown): void {
    const k = key.trim().slice(0, 120);
    if (!k) return;
    if (!this.cfg.teamMeta) this.cfg.teamMeta = {};
    if (value === null || value === undefined) {
      delete this.cfg.teamMeta[k];
    } else {
      this.cfg.teamMeta[k] = { v: value, at: Date.now() };
    }
    this.scheduleFlush();
  }

  /** 合并团队共享元数据：本机 + 各 peer（last-write-wins）。返回 { key: { v, at } } */
  teamMeta(): Record<string, { v: unknown; at: number }> {
    const merged = new Map<string, { v: unknown; at: number }>();
    for (const [k, e] of Object.entries(this.cfg.teamMeta ?? {})) {
      if (e && typeof e.at === "number") merged.set(k, e);
    }
    for (const p of this.effectivePeers()) {
      const ps = this.peerSnaps.get(p.id);
      const tm = ps?.snap?.self?.teamMeta;
      if (!tm || typeof tm !== "object") continue;
      for (const [k, e] of Object.entries(tm as Record<string, { v: unknown; at: number }>)) {
        if (!e || typeof e.at !== "number") continue;
        const cur = merged.get(k);
        if (!cur || e.at > cur.at) merged.set(k, e);
      }
    }
    const out: Record<string, { v: unknown; at: number }> = {};
    for (const [k, e] of merged) out[k] = e;
    return out;
  }

  /** 手工加/改一个 peer（跨网段/VLAN 组网用），落盘由调用方负责 */
  addPeer(input: { id?: string; label?: string; url: string; token?: string }): { ok: boolean; error?: string; peer?: PeerConfig } {
    const raw = String(input.url ?? "").trim();
    if (!raw) return { ok: false, error: "请填地址，例如 http://10.253.3.181:6080" };
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, error: "地址不合法，需要 http://主机:端口" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "只支持 http/https" };
    if (!u.hostname) return { ok: false, error: "缺少主机名" };
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const url = `${u.protocol}//${u.host}`;
    const id = input.id?.trim() || `${u.hostname.replace(/[^a-zA-Z0-9.-]+/g, "-")}-${port}`;
    const peer: PeerConfig = { id, label: input.label?.trim() || `${u.hostname}:${port}`, url, token: input.token?.trim() || undefined };
    const i = this.peers.findIndex((p) => p.id === peer.id || p.url === peer.url);
    if (i >= 0) this.peers[i] = peer;
    else this.peers.push(peer);
    this.cfg.peers = this.peers;
    this.kickPeerPoll();
    return { ok: true, peer };
  }

  /** 删除一个手工 peer */
  removePeer(id: string): boolean {
    const before = this.peers.length;
    this.peers = this.peers.filter((p) => p.id !== id);
    this.cfg.peers = this.peers;
    this.peerSnaps.delete(id);
    this.peerErrors.delete(id);
    if (this.peers.length === before) return false;
    this.kickPeerPoll();
    return true;
  }

  /** 手工加/改一个直连节点（别的机器上的 opencode server），落盘由调用方负责 */
  addNode(input: { id?: string; label?: string; url: string; username?: string; password?: string; runAgentsUrl?: string }): { ok: boolean; error?: string; node?: NodeConfig } {
    const raw = String(input.url ?? "").trim();
    if (!raw) return { ok: false, error: "请填地址，例如 http://10.253.109.134:4096" };
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, error: "地址不合法，需要 http://主机:端口" };
    }
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const url = `${u.protocol}//${u.host}`;
    const id = input.id?.trim() || `${u.hostname.replace(/[^a-zA-Z0-9.-]+/g, "-")}-${port}`;
    const node: NodeConfig = {
      id,
      label: input.label?.trim() || `${u.hostname}:${port}`,
      url,
      username: input.username?.trim() || undefined,
      password: input.password || undefined,
      runAgentsUrl: input.runAgentsUrl?.trim() || undefined,
    };
    this.nodes.get(id)?.stop();
    if (isLocalUrl(url)) this.staticPorts.add(Number(port));
    // 同 id 或同地址 → 原地更新（保留原 id），避免重复条目
    const existing = this.cfg.nodes.find((n) => n.id === id || n.url === url);
    const finalId = existing?.id ?? id;
    const finalNode: NodeConfig = { ...node, id: finalId };
    this.nodes.get(finalId)?.stop();
    const ns = new NodeState(finalNode, this.pollIntervalMs, () => this.scheduleFlush());
    this.nodes.set(finalId, ns);
    ns.start();
    this.cfg.nodes = existing ? this.cfg.nodes.map((n) => (n === existing ? finalNode : n)) : [...this.cfg.nodes, finalNode];
    this.scheduleFlush();
    return { ok: true, node: finalNode };
  }

  /** 删除一个手工节点 */
  removeNode(id: string): boolean {
    const ns = this.nodes.get(id);
    if (!ns) return false;
    ns.stop();
    this.nodes.delete(id);
    this.cfg.nodes = this.cfg.nodes.filter((n) => n.id !== id);
    const port = Number((() => { try { return new URL(ns.cfg.url).port || 80; } catch { return 0; } })()) || 0;
    const wasLocal = (() => { try { return isLocalUrl(ns.cfg.url); } catch { return false; } })();
    const stillUsed = [...this.nodes.values()].some((n) => { try { return isLocalUrl(n.cfg.url) && Number(new URL(n.cfg.url).port || 80) === port; } catch { return false; } });
    if (port && wasLocal && !stillUsed) this.staticPorts.delete(port);
    this.scheduleFlush();
    return true;
  }

  /** 自动发现的实例 → 当成 peers（与手工 peers 合并，手工的优先/同名去重） */
  private effectivePeers(): PeerConfig[] {
    const out: PeerConfig[] = [...this.peers];
    if (this.cfg.autoPeers === false) return out;
    const seen = new Set(this.peers.map((p) => p.id));
    const seenUrls = new Set(this.peers.map((p) => p.url));
    for (const d of this.mergeDiscovered()) {
      if (seen.has(d.id)) continue;
      if (d.id === this.selfId) continue;
      const url = `http://${d.host}:${d.port}`;
      if (seenUrls.has(url)) continue; // 手工配过同地址就别重复
      seenUrls.add(url);
      out.push({ id: d.id, label: d.label, url, token: this.cfg.key });
    }
    return out;
  }

  /**
   * 对端视图（自动发现 + 手工 peers 统一成一列）：UI 的"组网"面板用它，
   * 顺便把版本一致性算好，方便提示"对端较旧/较新"。
   */
  discoveredView() {
    const live = new Map(this.mergeDiscovered().map((d) => [d.id, d]));
    const manual = new Set(this.peers.map((p) => p.id));
    return this.effectivePeers()
      .map((p) => {
        const d = live.get(p.id);
        const snap = this.peerSnaps.get(p.id);
        const remoteSelf = snap?.snap?.self;
        const version = String(remoteSelf?.version ?? d?.version ?? "");
        const mine = this.version;
        let mismatch: "older" | "newer" | null = null;
        if (version && mine && version !== mine) mismatch = cmpVersion(version, mine) < 0 ? "older" : "newer";
        return {
          id: p.id,
          label: p.label,
          host: d?.host ?? (() => {
            try { return new URL(p.url).hostname; } catch { return p.url; }
          })(),
          port: d?.port ?? (() => {
            try { return Number(new URL(p.url).port || 80); } catch { return 0; }
          })(),
          version,
          manual: manual.has(p.id),
          paired: Boolean(snap),
          state: snap ? "ok" : this.peerErrors.get(p.id) === "key" ? "key" : "wait",
          dataAge: snap ? Date.now() - snap.at : null,
          fresh: Boolean(d) || manual.has(p.id),
          mismatch,
          via: d?.via ?? null,
          remote: remoteSelf
            ? {
                label: String(remoteSelf.label ?? p.label),
                key: remoteSelf.key ? String(remoteSelf.key) : null,
                keySource: remoteSelf.keySource ?? "auto",
                scan: remoteSelf.scan
                  ? {
                      enabled: remoteSelf.scan.enabled !== false,
                      subnets: Array.isArray(remoteSelf.scan.subnets) ? remoteSelf.scan.subnets.map(String) : [],
                      ports: Array.isArray(remoteSelf.scan.ports) ? remoteSelf.scan.ports.map(Number) : [6080, 6081, 6082],
                      intervalMs: remoteSelf.scan.intervalMs,
                    }
                  : undefined,
              }
            : undefined,
        };
      })
      .filter((p) => p.fresh);
  }

  private peerHeaders(p: PeerConfig): Record<string, string> {
    const h: Record<string, string> = {};
    // 团队密钥（新）：两端 key 相同才给数据
    const key = p.token ?? this.cfg.key;
    if (key) h["x-atrium-key"] = key;
    if (p.token) h.authorization = `Bearer ${p.token}`; // 兼容旧 peer token
    return h;
  }

  private async peerLoop() {
    if (this.peerPolling) return;
    this.peerPolling = true;
    try {
      const peers = this.effectivePeers();
      for (const p of peers) {
        try {
          const res = await fetch(`${p.url}/api/snapshot`, { headers: this.peerHeaders(p), signal: AbortSignal.timeout(8000) });
          if (res.ok) {
            this.peerSnaps.set(p.id, { at: Date.now(), snap: await res.json() });
            this.peerErrors.delete(p.id);
          } else if (res.status === 401 || res.status === 403) {
            this.peerSnaps.delete(p.id); // 密钥不匹配：不展示数据
            this.peerErrors.set(p.id, "key");
          }
        } catch {
          /* keep last snapshot; staleness surfaces via `at` */
        }
      }
      // 掉线的实例快照清掉，避免幽灵节点
      const ids = new Set(peers.map((p) => p.id));
      for (const id of [...this.peerSnaps.keys()]) if (!ids.has(id)) this.peerSnaps.delete(id);
      this.scheduleFlush();
    } finally {
      this.peerPolling = false;
      this.peerTimer = setTimeout(() => void this.peerLoop(), 8000);
    }
  }

  /** 立刻重跑一轮 peer 轮询（新增/删除 peer 后调用，不必等 8s） */
  private kickPeerPoll() {
    if (this.peerTimer) {
      clearTimeout(this.peerTimer);
      this.peerTimer = null;
    }
    void this.peerLoop();
  }

  /**
   * 远程修改某台已发现实例的设置（组网面板里直接改对端，改完立即生效并落到对端配置）。
   * 支持 label / 团队密钥 key / 扫描网段 scanSubnets。转发到对端的 /api/settings 与 /api/scan。
   */
  async setPeerSettings(peerId: string, patch: { label?: string; key?: string; scanSubnets?: string[] }): Promise<{ ok: boolean; error?: string }> {
    const peer = this.effectivePeers().find((p) => p.id === peerId);
    if (!peer) return { ok: false, error: "找不到该实例" };
    if (!this.cfg.key) return { ok: false, error: "本机未设置团队密钥，无法远程写入" };
    try {
      const settingsPatch: Record<string, string> = {};
      if (typeof patch.label === "string" && patch.label.trim()) settingsPatch.label = patch.label.trim().slice(0, 40);
      if (typeof patch.key === "string" && patch.key.trim()) {
        const k = patch.key.trim();
        if (k.length < 8) return { ok: false, error: "密钥至少 8 位" };
        settingsPatch.key = k;
      }
      if (Object.keys(settingsPatch).length) {
        const r1 = await fetch(`${peer.url}/api/settings`, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.peerHeaders(peer) },
          body: JSON.stringify(settingsPatch),
          signal: AbortSignal.timeout(10_000),
        });
        const j1: any = await r1.json().catch(() => ({}));
        if (!r1.ok || j1.ok === false) return { ok: false, error: j1?.error ?? "对端写入失败" };
      }
      if (Array.isArray(patch.scanSubnets)) {
        const subs = patch.scanSubnets.map((s) => String(s).trim()).filter(Boolean);
        const r2 = await fetch(`${peer.url}/api/scan`, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.peerHeaders(peer) },
          body: JSON.stringify({ subnets: subs }),
          signal: AbortSignal.timeout(10_000),
        });
        const j2: any = await r2.json().catch(() => ({}));
        if (!r2.ok || j2.ok === false) return { ok: false, error: j2?.error ?? "对端扫描配置写入失败" };
      }
      if (!Object.keys(settingsPatch).length && !Array.isArray(patch.scanSubnets)) return { ok: false, error: "没有要修改的字段" };
      this.kickPeerPoll();
      return { ok: true };
    } catch {
      return { ok: false, error: "对端连接失败" };
    }
  }

  /** Control request for a `peerId::rest` node — forward to that peer's API. */
  private async forwardPeer(nodeId: string, rest: string, body?: unknown): Promise<boolean> {
    const sep = nodeId.indexOf("::");
    if (sep < 0) return false;
    const peer = this.effectivePeers().find((p) => p.id === nodeId.slice(0, sep));
    if (!peer) return false;
    try {
      const res = await fetch(`${peer.url}/api/nodes/${nodeId.slice(sep + 2)}/${rest}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.peerHeaders(peer) },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(10_000),
      });
      const j: any = await res.json().catch(() => ({}));
      return res.ok && j.ok !== false;
    } catch {
      return false;
    }
  }

  /** 同 forwardPeer，但透传对端返回的 error（用于 prompt 等需要把失败原因带回 UI 的场景） */
  private async forwardPeerResult(nodeId: string, rest: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
    const sep = nodeId.indexOf("::");
    if (sep < 0) return { ok: false, error: "非对端节点" };
    const peer = this.effectivePeers().find((p) => p.id === nodeId.slice(0, sep));
    if (!peer) return { ok: false, error: "找不到对端实例" };
    try {
      const res = await fetch(`${peer.url}/api/nodes/${nodeId.slice(sep + 2)}/${rest}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.peerHeaders(peer) },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(10_000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (res.ok && j.ok !== false) return { ok: true };
      return { ok: false, error: j?.error ?? `对端返回 ${res.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async discoveryLoop() {
    try {
      const servers = await findLocalOpencodePorts();
      const alive = new Map<number, DiscoveredServer>();
      // 本机桌面版 server 带鉴权（/session 401）：从进程环境里把候选凭据都捡回来，
      // 逐个试出这个端口对应哪一组 —— 同一台机器可能同时存在多个 opencode 实例
      const candidates = await findLocalOpencodeAuth();
      if (process.env.ATRIUM_DEBUG) console.log(`[dbg] discovery servers=${JSON.stringify(servers)} auths=${candidates.length}`);
      const auths: LocalServerAuth[] = [];
      // 手填的优先：面板里填过就直接用，不再靠猜
      for (const srv of servers) {
        const manual = this.cfg.localAuth?.[String(srv.port)];
        if (manual?.username && manual?.password) {
          auths.push({
            username: manual.username,
            password: manual.password,
            header: "Basic " + Buffer.from(`${manual.username}:${manual.password}`).toString("base64"),
          });
        }
      }
      if (this.localAuth) auths.push({ username: "", password: "", header: this.localAuth });
      auths.push(...candidates);
      for (const srv of servers) {
        if (this.staticPorts.has(srv.port)) continue;
        const cached = this.portAuth.get(srv.port);
        let used: LocalServerAuth | undefined = cached;
        let r = await probeOpencode(srv.port, cached?.header);
        if (process.env.ATRIUM_DEBUG) console.log(`[dbg] probe :${srv.port} → ${r}`);
        if (r === "unauth") {
          for (const c of auths) {
            if (cached && c.header === cached.header) continue;
            const rr = await probeOpencode(srv.port, c.header);
            if (process.env.ATRIUM_DEBUG) console.log(`[dbg]   try ${c.username}/${c.password.slice(0, 8)} → ${rr}`);
            if (rr === "ok") {
              used = c;
              r = "ok";
              break;
            }
          }
        }
        if (r === "ok") {
          if (used) this.portAuth.set(srv.port, used);
          alive.set(srv.port, { ...srv, auth: used });
        } else if (r === "unauth") {
          if (!this.unauthLogged.has(srv.port)) {
            this.unauthLogged.add(srv.port);
            console.warn(
              `[atrium] 本机 opencode server :${srv.port} 需要账号密码且无法自动获取，未纳入。` +
                `可设 OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD，或在配置 nodes 里写明`,
            );
          }
          this.localSkipped.add(srv.port);
        }
      }
      for (const [port, srv] of alive) {
        if (this.dynamicPorts.has(port)) continue;
        const id = `local-${port}`;
        const cfgNode: NodeConfig = {
          id,
          label: `${srv.proc || "opencode"} · :${port}`,
          url: `http://127.0.0.1:${port}`,
          username: srv.auth?.username || process.env.OPENCODE_SERVER_USERNAME,
          password: srv.auth?.password || process.env.OPENCODE_SERVER_PASSWORD,
        };
        this.dynamicPorts.add(port);
        this.localSkipped.delete(port);
        const node = new NodeState(cfgNode, this.pollIntervalMs, () => this.scheduleFlush());
        this.nodes.set(id, node);
        node.start();
        console.log(`discovered local opencode server on :${port}`);
      }
      for (const port of [...this.dynamicPorts]) {
        if (alive.has(port)) {
          this.portMisses.delete(port);
          continue;
        }
        // 桌面版 server 应答偶尔慢：连续 3 轮都探测不到才摘掉（约 30s），
        // 否则"本机自己"会一闪一闪甚至消失
        const misses = (this.portMisses.get(port) ?? 0) + 1;
        this.portMisses.set(port, misses);
        if (misses < 3) continue;
        this.portMisses.delete(port);
        this.dynamicPorts.delete(port);
        this.portAuth.delete(port);
        const id = `local-${port}`;
        this.nodes.get(id)?.stop();
        this.nodes.delete(id);
        console.log(`local server on :${port} gone`);
      }
      await this.refreshRunAgents();
      this.scheduleFlush();
    } catch (e) {
      // 别静默：发现挂了要能看见原因（之前吞掉异常导致"看不到自己"完全无迹可循）
      console.warn(`[atrium] 本机发现失败：${(e as Error).message}`);
    }
    this.discoverTimer = setTimeout(() => void this.discoveryLoop(), 30_000);
  }

  /** Detect CLI run-mode agents (opencode children of bridge daemons like cc-connect). */
  private async refreshRunAgents() {
    try {
      const procs = await findRunAgentProcs();
      const byDir = new Map<string, { pids: number[]; bridge: string; proc: string; cpu: number; workDir: string | null; sessionId?: string }>();
      for (const p of procs) {
        const key = p.sessionId ? `sess:${p.sessionId}` : p.workDir ?? `pid:${p.pid}`;
        const g = byDir.get(key) ?? { pids: [], bridge: p.bridge, proc: p.proc, cpu: 0, workDir: null };
        g.pids.push(p.pid);
        g.cpu += p.cpuSeconds;
        g.workDir ??= p.workDir;
        g.sessionId ??= p.sessionId;
        byDir.set(key, g);
      }
      let cpuDelta = false;
      for (const p of procs) {
        const prev = this.prevCpu.get(p.pid);
        if (prev != null && p.cpuSeconds > prev) cpuDelta = true;
        this.prevCpu.set(p.pid, p.cpuSeconds);
      }
      const anyOnline = [...this.nodes.values()].find((n) => n.status !== "offline");
      const out: RunAgentView[] = [];
      let bridgeIds: string[] | null = null;
      let piLite: Awaited<ReturnType<typeof piSessions>> | null = null;
      for (const [dir, g] of byDir) {
        if (g.proc === "pi") {
          piLite ??= await piSessions();
          const mine = dir.startsWith("pid:") ? piLite : piLite.filter((s) => s.source === dir);
          const sessions: SessionView[] = mine.map((s) => ({
            id: s.id,
            title: s.title,
            directory: s.source || dir,
            busy: s.busy,
            updatedAt: s.updatedAt,
            cost: 0,
            tokens: { input: 0, output: 0 },
            model: s.model,
            agent: "pi",
          }));
          const lastActivityAt = sessions[0]?.updatedAt ?? 0;
          const active = sessions.some((s) => s.busy) || cpuDelta;
          const wd = sessions[0]?.directory || (dir.startsWith("pid:") ? "~/.pi" : dir);
          out.push({
            id: `run-pi-${wd}`,
            kind: "run",
            label: `pi · ${(wd.split(/[\\/]/).filter(Boolean).pop() ?? wd)}`,
            pid: g.pids[0],
            procCount: g.pids.length,
            bridge: g.bridge,
            proc: "pi",
            workDir: wd,
            cpuSeconds: Math.round(g.cpu),
            active,
            busyCount: sessions.filter((s) => s.busy).length,
            lastActivityAt,
            activeDir: active ? wd : undefined,
            sessions,
          });
          continue;
        }
        if (!anyOnline) continue;
        try {
          let useDir = g.workDir ?? "";
          let list = useDir.startsWith("/") ? await anyOnline["client"].listSessionsFor(useDir) : [];
          // worker 命令行带了 --session：直接按 id 取（/session 列表不一定收录该会话）
          let hit: any = g.sessionId ? list.find((s: any) => s.id === g.sessionId) : undefined;
          if (g.sessionId && !hit) {
            try {
              hit = await anyOnline["client"].getSession(g.sessionId);
              if (hit?.directory && hit.directory !== useDir) {
                useDir = hit.directory;
                list = await anyOnline["client"].listSessionsFor(useDir);
              }
            } catch {
              /* session not visible to this server */
            }
          }
          if (hit && !list.some((s: any) => s.id === hit.id)) list = [hit, ...list];
          if (!list.length) {
            // worker cwd may differ from the opencode project it actually runs —
            // fall back to session IDs recorded in the bridge daemon log
            bridgeIds ??= await recentBridgeSessions();
            if (bridgeIds.length) {
              try {
                const all = await anyOnline["client"].listSessions();
                const bhit = all.find((s: any) => bridgeIds!.includes(s.id));
                if (bhit?.directory && bhit.directory !== useDir) {
                  useDir = bhit.directory;
                  list = await anyOnline["client"].listSessionsFor(useDir);
                }
              } catch {
                /* global list unsupported */
              }
            }
          }
          if (!useDir) continue;
          if (out.some((o) => o.workDir === useDir && !(o as any).sessionId && !g.sessionId)) continue;
          list = [...list].sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
          const lastActivityAt = list[0]?.time?.updated ?? 0;
          const fresh = Date.now() - lastActivityAt < 90_000;
          const active = Boolean(g.sessionId) || fresh || cpuDelta;
          const sessions = list.slice(0, 12).map(
            (s: any): SessionView => ({
              id: s.id,
              title: s.title ?? "",
              directory: useDir,
              busy: g.sessionId ? s.id === g.sessionId : active && s.id === list[0]?.id,
              updatedAt: s.time?.updated ?? 0,
              cost: s.cost ?? 0,
               tokens: { input: s.tokens?.input ?? 0, output: s.tokens?.output ?? 0 },
               model: s.model?.id ?? s.model?.modelID,
               providerID: s.model?.providerID,
               agent: s.agent,
             }),
           );
           const dirName = useDir.split("/").filter(Boolean).pop() ?? useDir;
          out.push({
            id: `run-${g.sessionId ?? useDir}`,
            kind: "run",
            label: `${g.bridge} · ${dirName}${g.sessionId && sessions.length > 1 ? ` · ${sessions.find((s) => s.id === g.sessionId)?.title?.slice(0, 18) || ""}` : ""}`,
            pid: g.pids[0],
            procCount: g.pids.length,
            bridge: g.bridge,
            proc: g.proc,
            workDir: useDir,
            cpuSeconds: Math.round(g.cpu),
            active,
            busyCount: sessions.filter((s) => s.busy).length,
            lastActivityAt,
            activeDir: active ? useDir : undefined,
            sessions,
            sessionId: g.sessionId,
          });
        } catch {
          /* server may have died mid-refresh */
        }
      }
      const seenDaemons = new Set<string>();
      for (const d of await findBridgeDaemons()) {
        const lite = d.name === "openclaw" ? await openclawSessions() : await hermesSessions();
        const dir = d.workDir ?? `~/.${d.name}`;
        const sessions: SessionView[] = lite.map((s) => ({
          id: s.id,
          title: s.title,
          directory: dir,
          busy: s.busy,
          updatedAt: s.updatedAt,
          cost: 0,
          tokens: { input: s.inputTokens ?? 0, output: s.outputTokens ?? 0 },
          model: s.model,
          agent: s.source,
        }));
        const active = sessions.some((s) => s.busy) || Date.now() - (sessions[0]?.updatedAt ?? 0) < 90_000;
        const who =
          d.name === "openclaw" ? (sessions[0]?.id ?? "").split(":")[1] || "main" : "agent";
        const daemonId = seenDaemons.has(d.name) ? `run-${d.name}-${d.pid}` : `run-${d.name}`;
        const daemonLabel = seenDaemons.has(d.name) ? `${d.name} · ${who} ·#${d.pid}` : `${d.name} · ${who}`;
        seenDaemons.add(d.name);
        out.push({
          id: daemonId,
          kind: "run",
          label: daemonLabel,
          pid: d.pid,
          procCount: 1 + d.childCount,
          bridge: d.name,
          workDir: dir,
          cpuSeconds: d.cpuSeconds,
          active,
          busyCount: sessions.filter((s) => s.busy).length,
          lastActivityAt: sessions[0]?.updatedAt ?? 0,
          activeDir: active ? dir : undefined,
          sessions,
        });
      }
      if (!out.some((o) => o.label.startsWith("pi · "))) {
        const pid = await findStandalonePi();
        const lite = await piSessions();
        if (lite.length) {
          const sessions: SessionView[] = lite.map((s) => ({
            id: s.id,
            title: s.title,
            directory: s.source || "~/.pi",
            busy: Boolean(pid) && s.busy,
            updatedAt: s.updatedAt,
            cost: 0,
            tokens: { input: 0, output: 0 },
            model: s.model,
            agent: "pi",
          }));
          const wd = sessions[0]?.directory ?? "~/.pi";
          const lastActivityAt = sessions[0]?.updatedAt ?? 0;
          const active = Boolean(pid) && (sessions.some((s) => s.busy) || Date.now() - lastActivityAt < 90_000);
          out.push({
            id: "run-pi",
            kind: "run",
            label: "pi · agent",
            pid: pid ?? 0,
            procCount: pid ? 1 : 0,
            bridge: "pi",
            workDir: wd,
            cpuSeconds: 0,
            active,
            busyCount: sessions.filter((s) => s.busy).length,
            lastActivityAt,
            activeDir: active ? wd : undefined,
            sessions,
          });
        }
      }
      // 本机的 OpenCode 桌面应用：没有会话归属（workDir 不是真实路径），只代表进程存活，
      // active 看 CPU 时间是否在涨；点进去会走"整机会话"的兜底列表
      if (!out.some((o) => o.bridge === "desktop")) {
        const d = await findDesktopApp();
        if (d) {
          const prev = this.prevCpu.get(d.pid);
          const active = prev != null && d.cpuSeconds > prev;
          this.prevCpu.set(d.pid, d.cpuSeconds);
          out.push({
            id: "run-oc-desktop",
            kind: "run",
            label: "OpenCode · Desktop",
            pid: d.pid,
            procCount: 1,
            bridge: "desktop",
            proc: "opencode",
            workDir: d.workDir ?? "OpenCode Desktop",
            cpuSeconds: d.cpuSeconds,
            active,
            busyCount: 0,
            lastActivityAt: active ? Date.now() : 0,
            activeDir: active ? d.workDir ?? "OpenCode Desktop" : undefined,
            sessions: [],
          });
        }
      }
      // 把本机 run agent 的工作目录登记给本机节点，保证这些目录下的会话能被轮询到
      const localNodes = [...this.nodes.values()].filter((n) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(n["cfg"].url ?? ""));
      for (const ra of out) {
        for (const n of localNodes) {
          n.addDir(ra.workDir);
          n.addDir((ra as any).activeDir);
        }
      }

      const nowIds = new Set(out.map((o) => o.id));
      // 从已完成缓存里剔除重新上线的进程（同一任务又被拉起）
      const finishedKept = this.finishedRunAgents.filter((f) => !nowIds.has(f.id));
      // 消失的 opencode 活跃任务 → 标记完成，保留显示，等用户手动确认
      for (const prev of this.runAgents) {
        if (nowIds.has(prev.id)) continue;
        if (!isOpencodeRun(prev)) continue;
        if (!prev.active && (prev.busyCount ?? 0) === 0) continue;
        if (finishedKept.some((f) => f.id === prev.id)) continue;
        finishedKept.push({
          ...prev,
          active: false,
          busyCount: 0,
          finished: true,
          finishedAt: prev.finishedAt ?? Date.now(),
          sessions: [...(prev.sessions ?? [])].map((s) => ({ ...s, busy: false })),
        });
      }
      this.finishedRunAgents = finishedKept.slice(-FINISHED_CAP);
      const merged = [...out, ...this.finishedRunAgents];
      const keyOf = (o: RunAgentView) => [o.id, o.active, o.finished, o.lastActivityAt];
      const changed = JSON.stringify(merged.map(keyOf)) !== JSON.stringify(this.runAgents.map(keyOf));
      this.runAgents = merged;
      if (changed) this.scheduleFlush();
    } catch {
      /* best-effort */
    }
  }

  snapshot() {
    const nodes = [...this.nodes.values()].map((n) => {
      const v = n.view();
      if (!v.machine && isLocalUrl(v.url)) v.machine = LOCAL_HOST;
      // sidecar 不报 machine 时，节点与它的 run 球都以节点 label 为机器标识，buddy 才能匹配上
      if (!v.machine) v.machine = n.cfg.label;
      // 后端保存的机器名覆盖（团队共享）：baseLabel 留原始名，label 用自定义名
      v.baseLabel = v.label;
      const ov = this.cfg.nodeLabels?.[v.id];
      if (ov) v.label = ov;
      return v;
    });
    const runAgents = this.runAgents.map((r) => ({ ...r, machine: r.machine ?? LOCAL_HOST }));
    for (const [nid, n] of this.nodes) {
      for (const r of n.remoteRunAgents) {
        const machine = n.remoteMachine ?? n.cfg.label;
        runAgents.push({ ...r, id: `${nid}::${r.id}`, label: `${r.label} @${machine}`, machine });
      }
    }
    // 机器负载：本机自己采的 + 各 peer 上报的「它本机」负载（同样一跳，避免套娃）
    const hosts: HostMetrics[] = [];
    const selfHost = this.host.current;
    if (selfHost) hosts.push({ ...selfHost, machine: selfHost.machine || LOCAL_HOST, label: this.selfLabel, self: true });
    // 同一个 opencode server 常被收录两次：直连 nodes 配了一次，peer 合并又带来它本机的
    // local-XXXX（对端视角是 127.0.0.1，映射回对端主机后就是同一个地址）。不去重的话
    // 标签/时间视图里同一会话成对出现，各视图计数也翻倍。
    const addrOf = (url: string, fallbackHost: string) => {
      try {
        const u = new URL(url);
        const host = isLocalUrl(url) ? fallbackHost : u.hostname;
        if (!host) return "";
        return `${host.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
      } catch {
        return "";
      }
    };
    const directAddrs = new Set(nodes.map((n) => addrOf(n.url, "")).filter(Boolean));
    const directSess = new Set<string>();
    for (const n of nodes) for (const s of n.sessions ?? []) directSess.add(s.id);
    for (const p of this.effectivePeers()) {
      const ps = this.peerSnaps.get(p.id);
      if (!ps) continue;
      const stale = Date.now() - ps.at > 30_000;
      let peerHost = "";
      try { peerHost = new URL(p.url).hostname; } catch { /* 地址不合法就走会话重合度兜底 */ }
      const ph = ps.snap?.self?.host as HostMetrics | undefined;
      const peerMachine = (typeof ph?.machine === "string" && ph.machine.trim()) ? ph.machine.trim() : p.label;
      // 只接受对方"自己本机"的条目：带 :: 的是它从第三方合并来的，
      // 自动发现是全互联的，一跳就够；否则会 A 合并 B、B 再合并 A 无限套娃
      for (const n of ps.snap.nodes ?? []) {
        if (String(n.id).includes("::")) continue;
        const addr = addrOf(String(n.url ?? ""), peerHost);
        if (addr && directAddrs.has(addr)) continue; // 与某个直连节点是同一台 server
        const sids: string[] = (n.sessions ?? []).map((s: any) => String(s?.id ?? "")).filter(Boolean);
        if (sids.length && sids.every((id) => directSess.has(id))) continue; // 会话被直连节点全覆盖
        const mid = `${p.id}::${n.id}`;
        const ov = this.cfg.nodeLabels?.[mid]; // 本 hub 对这台 peer 机器存的自定义名（团队共享）
        const base = `${n.label} @${p.label}`;
        nodes.push({
          ...n,
          id: mid,
          label: ov || base,
          baseLabel: base,
          status: stale ? "stale" : n.status,
          machine: peerMachine,
        });
      }
      for (const r of ps.snap.runAgents ?? []) {
        if (String(r.id).includes("::")) continue;
        runAgents.push({ ...r, id: `${p.id}::${r.id}`, label: `${r.label} @${p.label}`, machine: peerMachine });
      }
      if (ph && typeof ph === "object" && typeof ph.cpuPct === "number") {
        hosts.push({ ...ph, machine: peerMachine, label: p.label, self: false });
      }
    }
    return {
      generatedAt: Date.now(),
      nodes,
      runAgents,
      hosts,
      self: {
        id: this.selfId,
        label: this.selfLabel,
        version: this.version,
        port: this.cfg.port,
        key: this.cfg.key ?? null,
        keySource: this.cfg.keySource ?? "auto",
        onboarded: Boolean(this.cfg.onboardedAt),
        localSkipped: [...this.localSkipped],
        localAuthPorts: Object.keys(this.cfg.localAuth ?? {}).map(Number),
        scan: { enabled: this.cfg.scanEnabled !== false, subnets: this.cfg.scanSubnets ?? [], ports: this.cfg.scanPorts ?? [6080, 6081, 6082], intervalMs: this.cfg.scanIntervalMs ?? 120_000 },
        host: this.host.current ?? undefined,
        nodeLabels: this.cfg.nodeLabels ?? {},
        teamMeta: this.cfg.teamMeta ?? {},
      },
      teamMeta: this.teamMeta(),
      teamJobs: this.teamJobs.slice(-200),
      discovered: this.discoveredView(),
    };
  }

  subscribe(fn: (snapshot: any) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** GET variant of forwardPeer — returns parsed JSON data instead of boolean. */
  private async forwardPeerGet(nodeId: string, rest: string, timeoutMs = 10_000): Promise<any | null> {
    const sep = nodeId.indexOf("::");
    if (sep < 0) return null;
    const peer = this.effectivePeers().find((p) => p.id === nodeId.slice(0, sep));
    if (!peer) return null;
    try {
      const res = await fetch(`${peer.url}/api/nodes/${nodeId.slice(sep + 2)}/${rest}`, {
        headers: { ...this.peerHeaders(peer) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return body ?? null; // 把对端的原因带回来
      return body;
    } catch {
      return null;
    }
  }

  /** 二进制变体：把 peer 的响应字节原样带回（项目图标图片转发用） */
  private async forwardPeerRaw(
    nodeId: string,
    rest: string,
    timeoutMs = 10_000,
  ): Promise<{ ok: boolean; status?: number; contentType?: string; body?: Uint8Array } | null> {
    const sep = nodeId.indexOf("::");
    if (sep < 0) return null;
    const peer = this.effectivePeers().find((p) => p.id === nodeId.slice(0, sep));
    if (!peer) return null;
    try {
      const res = await fetch(`${peer.url}/api/nodes/${nodeId.slice(sep + 2)}/${rest}`, {
        headers: { ...this.peerHeaders(peer) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, contentType: res.headers.get("content-type") ?? undefined, body: buf };
    } catch {
      return null;
    }
  }

  /** session 不在节点列表里时（worker 直写 DB），按 id 直接查目录 */
  private async sessionDirOf(node: NodeState, sessionID: string): Promise<string | null> {
    const listed = node.sessions.get(sessionID)?.directory;
    if (listed) return listed;
    try {
      const info = await node["client"].getSession(sessionID);
      return info?.directory ?? null;
    } catch {
      return null;
    }
  }

  dismissRunAgent(id: string): boolean {
    const had = this.finishedRunAgents.some((r) => r.id === id);
    this.finishedRunAgents = this.finishedRunAgents.filter((r) => r.id !== id);
    const before = this.runAgents.length;
    this.runAgents = this.runAgents.filter((r) => r.id !== id);
    if (had || this.runAgents.length !== before) {
      this.scheduleFlush();
      return true;
    }
    return false;
  }

  /** 给 standalone pi agent 派一条任务：续写指定会话（未指定则续最新活跃会话）。fire-and-forget。 */
  async promptPi(text: string, sessionId?: string): Promise<{ ok: boolean; error?: string; pid?: number }> {
    let sid = (sessionId ?? "").trim() || null;
    if (!sid) {
      const lite = await piSessions();
      const s = lite.find((x) => x.busy) ?? lite[0];
      if (s) sid = s.id;
    }
    const r = await spawnPiPrompt(sid, text);
    if (r.ok) {
      if (r.pid && sid) this.piJobs.set(sid, r.pid);
      this.kickDiscovery();
    }
    return r;
  }

  /** nodeId 是否指代 pi 运行进程（run-pi 系列 id），用于把 pi 会话接进 ChatView 的 messages/prompt/abort。 */
  private isPiNode(nodeId: string): boolean {
    return nodeId === "run-pi" || nodeId.startsWith("run-pi-");
  }

  /** 中止本机该 pi 会话正在跑的任务：kill 记录的 --print 子进程。 */
  async abortPi(sessionId: string): Promise<boolean> {
    const pid = this.piJobs.get(sessionId);
    this.piJobs.delete(sessionId);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        /* 进程已退出 */
      }
    }
    return false;
  }

  /**
   * 全机队事件流（值班台用）：把各节点的环形缓冲汇总成一条按时间倒序的日志。
   * 只覆盖本 hub 直连的节点；peer 的事件由 peer 自己那台 hub 提供。
   */
  events(opts: { since?: number; node?: string; type?: string; limit?: number } = {}) {
    const out: { ts: number; type: string; summary: string; sessionID?: string; node: string; nodeLabel: string }[] = [];
    const types = new Set<string>();
    for (const [id, n] of this.nodes) {
      for (const ev of n.events) {
        types.add(ev.type);
        if (opts.node && opts.node !== id) continue;
        if (opts.since && ev.ts <= opts.since) continue;
        if (opts.type && !ev.type.toLowerCase().includes(opts.type.toLowerCase())) continue;
        out.push({ ts: ev.ts, type: ev.type, summary: ev.summary ?? "", sessionID: ev.sessionID, node: id, nodeLabel: n.cfg.label });
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return {
      ok: true,
      now: Date.now(),
      total: out.length,
      types: [...types].sort(),
      nodes: [...this.nodes.values()].map((n) => ({ id: n.cfg.id, label: n.cfg.label })),
      events: out.slice(0, Math.max(1, Math.min(1000, opts.limit ?? 300))),
    };
  }

  /**
   * 找出真正拥有这个会话的节点：本机各节点的会话表 + 各对端快照里的会话表。
   * 跨机器看板最容易踩的坑就是"宿主猜错"（一台机器常有多个 opencode 节点），
   * 报错表现为"对话加载失败"，所以这里先把宿主认准。
   */
  private ownerOfSession(sessionID: string): string | null {
    for (const [id, n] of this.nodes) {
      if (n.sessions.has(sessionID)) return id;
    }
    for (const p of this.effectivePeers()) {
      const snap = this.peerSnaps.get(p.id)?.snap;
      for (const n of snap?.nodes ?? []) {
        if (String(n.id).includes("::")) continue;
        if ((n.sessions ?? []).some((x: any) => x.id === sessionID)) return `${p.id}::${n.id}`;
      }
    }
    return null;
  }

  /** 取会话消息：会自动纠正宿主；返回原因供界面显示，而不是只说"失败" */
  async messages(
    nodeId: string,
    sessionID: string,
  ): Promise<{ ok: boolean; messages?: any[]; owner?: string; reason?: string }> {
    if (this.isPiNode(nodeId)) {
      return { ok: true, messages: shrinkMessages(piMessages(sessionID)) };
    }
    const owner = this.ownerOfSession(sessionID);
    let target = nodeId;
    if (owner && owner !== nodeId) {
      console.warn(`[atrium] 会话 ${sessionID} 实际属于 ${owner}，请求的是 ${nodeId}，已自动纠正`);
      target = owner;
    }
    if (target.includes("::")) {
      const j = await this.forwardPeerGet(target, `sessions/${encodeURIComponent(sessionID)}/messages`, 30_000);
      if (j?.ok && Array.isArray(j.messages)) return { ok: true, messages: j.messages, owner: target };
      return { ok: false, owner: target, reason: j?.reason ?? `对端 ${target.split("::")[0]} 没返回消息（可能对端版本较旧或该会话不在它那里）` };
    }
    const node = this.nodes.get(target);
    if (!node) return { ok: false, reason: `节点 ${target} 不存在` };
    if (node.status === "offline") return { ok: false, owner: target, reason: "节点离线，无法读取对话" };
    const dir = await this.sessionDirOf(node, sessionID);
    if (!dir) {
      return {
        ok: false,
        owner: target,
        reason: owner ? `未能解析会话目录（${target}）` : "该会话不属于当前任何已知节点（可能已被删除）",
      };
    }
    try {
      const list = await node["client"].listMessages(sessionID, dir, 200);
      // 只取最近 200 条 + 裁剪超大 part，避免超大会话全量拉几十 MB 直接超时
      return { ok: true, messages: shrinkMessages(list), owner: target };
    } catch (e) {
      return { ok: false, owner: target, reason: `读取消息失败：${(e as Error).message}` };
    }
  }

  /** 改会话标题：远端节点转发给对应实例，本机直接调 opencode 的 PATCH /session */
  async setSessionTitle(nodeId: string, sessionID: string, title: string): Promise<boolean> {
    if (nodeId.includes("::")) return this.forwardPeer(nodeId, `sessions/${encodeURIComponent(sessionID)}/title`, { title });
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    const dir = await this.sessionDirOf(node, sessionID);
    if (!dir) return false;
    const ok = await node["client"].updateSessionTitle(sessionID, dir, title);
    if (ok) {
      const sess = node.sessions.get(sessionID);
      if (sess) sess.title = title; // 本地先更新，界面立刻见效；下一轮轮询再对齐
      node.kickPoll();
      this.scheduleFlush();
    }
    return ok;
  }

  /** 改项目（名称/图标/颜色）：本机直调 opencode PATCH /project；远端转发给 peer */
  async updateProject(
    nodeId: string,
    directory: string,
    patch: { name?: string; icon?: { color?: string; override?: string; clearImage?: boolean } },
  ): Promise<{ ok: boolean; reason?: string }> {
    if (nodeId.includes("::")) {
      const ok = await this.forwardPeer(nodeId, "projects/update", { directory, ...patch });
      return ok ? { ok } : { ok: false, reason: "对端实例不可达或版本过旧" };
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, reason: "节点不存在" };
    const projects = await node.refreshProjects(true);
    const proj = matchProject(projects, directory);
    if (!proj) return { ok: false, reason: "该目录还不是 opencode 项目（先在 opencode 里打开过一次）" };
    const old = proj.icon ?? {};
    let icon: { url?: string; override?: string; color?: string };
    if (patch.icon?.override) {
      icon = { color: patch.icon.color ?? old.color ?? "", override: patch.icon.override, url: old.url };
    } else if (patch.icon?.clearImage) {
      icon = { color: patch.icon.color ?? old.color ?? "", override: "", url: "" };
    } else {
      icon = { color: patch.icon?.color ?? old.color ?? "", override: old.override ?? "", url: old.url ?? "" };
    }
    const body: Record<string, unknown> = { icon };
    body.name = patch.name !== undefined ? patch.name : proj.name ?? "";
    if (proj.commands) body.commands = proj.commands; // 不带上会被清空
    const updated = await node["client"].updateProject(String(proj.id), String(proj.worktree), body);
    if (!updated) return { ok: false, reason: "opencode 拒绝了更新（版本过旧或项目不存在）" };
    node.applyProject(updated);
    node.kickPoll();
    this.scheduleFlush();
    return { ok: true };
  }

  /** 项目图标图片本体：本机节点从 /project 缓存里取 data URL；peer 节点原样转发字节 */
  async projectIcon(
    nodeId: string,
    directory: string,
  ): Promise<{ ok: boolean; dataUrl?: string; status?: number; contentType?: string; body?: Uint8Array; reason?: string }> {
    if (nodeId.includes("::")) {
      const r = await this.forwardPeerRaw(nodeId, `projects/icon?dir=${encodeURIComponent(directory)}`);
      if (!r) return { ok: false, reason: "对端实例不可达" };
      return r;
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, reason: "节点不存在" };
    let proj = matchProject(await node.refreshProjects(), directory);
    if (!proj) proj = matchProject(await node.refreshProjects(true), directory);
    const dataUrl = proj?.icon?.override || proj?.icon?.url;
    if (!dataUrl) return { ok: false, reason: "该项目没有图标图片" };
    return { ok: true, dataUrl: String(dataUrl) };
  }

  /** 新建会话：先确保目录存在；本机直调 opencode /session，远端转发给 peer。返回 { ok, session? } */
  async createSession(nodeId: string, directory: string, title?: string): Promise<{ ok: boolean; session?: any; error?: string }> {
    const reqDir = String(directory ?? "").trim();
    if (nodeId.includes("::")) {
      if (reqDir) await this.fsMkdir(nodeId, reqDir);
      const ok = await this.forwardPeer(nodeId, "sessions/create", { directory: reqDir, title });
      return { ok };
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, error: "节点不存在" };
    const knownDirs = [...new Set([...node.sessions.values()].map((s) => s.directory).filter(Boolean))];
    const dir = reqDir || knownDirs[0] || process.env.HOME || "";
    if (dir) {
      const made = await this.fsMkdir(nodeId, dir);
      if (!made.ok && isLocalUrl(node.cfg.url)) return { ok: false, error: made.error || `目录创建失败：${dir}` };
    }
    const sess = await node["client"].createSession(dir, title);
    if (sess) {
      node.kickPoll();
      this.scheduleFlush();
      return { ok: true, session: sess };
    }
    return { ok: false, error: "opencode 未接受新建会话请求" };
  }

  async abort(nodeId: string, sessionID: string): Promise<boolean> {
    if (this.isPiNode(nodeId)) return this.abortPi(sessionID);
    if (nodeId.includes("::")) return this.forwardPeer(nodeId, `sessions/${encodeURIComponent(sessionID)}/abort`);
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    const dir = await this.sessionDirOf(node, sessionID);
    if (!dir) return false;
    const ok = await node["client"].abort(sessionID, dir);
    const sess = node.sessions.get(sessionID);
    if (ok) {
      if (sess) sess.busy = false;
      node.kickPoll();
      this.scheduleFlush();
    }
    return ok;
  }

  /** 取某会话最后一条助手消息 id（供 revert/fork 用） */
  private async lastAssistantMessageID(node: NodeState, sessionID: string): Promise<string | null> {
    const dir = await this.sessionDirOf(node, sessionID);
    if (!dir) return null;
    try {
      const list = await node["client"].listMessages(sessionID, dir, 100);
      for (let i = list.length - 1; i >= 0; i--) {
        const role = list[i]?.info?.role;
        const id = list[i]?.info?.id;
        if (role === "assistant" && id) return String(id);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 统一执行 opencode 会话命令（/compact /undo /redo /share /unshare /fork /command） */
  async sessionCommand(
    nodeId: string,
    sessionID: string,
    command: string,
    opts: { messageID?: string; args?: Record<string, unknown> } = {},
  ): Promise<{ ok: boolean; error?: string; url?: string; session?: any }> {
    const supported = new Set(["compact", "undo", "redo", "share", "unshare", "fork", "command"]);
    if (!supported.has(command)) return { ok: false, error: `不支持的会话命令：${command}` };
    if (nodeId.includes("::")) {
      const r = await this.forwardPeerResult(nodeId, `sessions/${encodeURIComponent(sessionID)}/command`, { command, ...opts });
      return r;
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, error: "节点不存在" };
    const dir = this.nodes.get(nodeId) ? await this.sessionDirOf(node, sessionID) : null;
    const c = node["client"];
    const kick = (ok: boolean) => { if (ok) { node.kickPoll(); this.scheduleFlush(); } };
    switch (command) {
      case "compact": {
        if (!dir) return { ok: false, error: "找不到会话目录" };
        // compact = summarize，需要 providerID+modelID：优先会话自身模型，其次取该节点默认模型
        const sess = node.sessions.get(sessionID);
        let providerID = sess?.providerID, modelID = sess?.model;
        if (!providerID || !modelID) {
          try {
            const provs = await c.listProviders();
            const def = provs?.default ?? {};
            const pid = Object.keys(def)[0];
            if (pid && def[pid]) { providerID = pid; modelID = def[pid]; }
          } catch { /* 拉清单失败就交给下方报错 */ }
        }
        if (!providerID || !modelID) return { ok: false, error: "无法确定压缩用的模型（会话没模型且取不到默认模型）" };
        const r = await c.compact(sessionID, dir, providerID, modelID);
        kick(r.ok);
        return r;
      }
      case "undo": {
        if (!dir) return { ok: false, error: "找不到会话目录" };
        const mid = opts.messageID ?? await this.lastAssistantMessageID(node, sessionID);
        if (!mid) return { ok: false, error: "没有可撤销的助手消息" };
        const r = await c.revert(sessionID, dir, mid);
        kick(r.ok);
        return r;
      }
      case "redo": {
        if (!dir) return { ok: false, error: "找不到会话目录" };
        const r = await c.unrevert(sessionID, dir);
        kick(r.ok);
        return r;
      }
      case "share": {
        if (!dir) return { ok: false, error: "找不到会话目录" };
        const r = await c.share(sessionID, dir);
        return r;
      }
      case "unshare": {
        if (!dir) return { ok: false, error: "找不到会话目录" };
        const r = await c.unshare(sessionID, dir);
        return r;
      }
      case "fork": {
        if (!dir) return { ok: false, error: "找不到会话目录" };
        const mid = opts.messageID ?? await this.lastAssistantMessageID(node, sessionID);
        if (!mid) return { ok: false, error: "没有可 fork 的助手消息" };
        const r = await c.fork(sessionID, dir, mid);
        kick(r.ok);
        return r;
      }
      case "command": {
        if (!dir) return { ok: false, error: "找不到会话目录" };
        const { name, args } = opts as any;
        if (!name) return { ok: false, error: "缺少命令名" };
        const r = await c.sendCommand(sessionID, dir, name, args);
        kick(r.ok);
        return r;
      }
      default:
        return { ok: false, error: "不支持的会话命令" };
    }
  }

  async replyPermission(nodeId: string, id: string, response: "once" | "always" | "reject"): Promise<boolean> {
    if (nodeId.includes("::")) return this.forwardPeer(nodeId, `permissions/${encodeURIComponent(id)}/reply`, { response });
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    const item = node.pendingPermissions.find((p: any) => p.id === id);
    const dir = item ? node.sessions.get(item.sessionID)?.directory : undefined;
    if (!dir) return false;
    const ok = await node["client"].replyPermission(id, dir, response);
    node.pendingPermissions = node.pendingPermissions.filter((p: any) => p.id !== id);
    node.kickPoll();
    this.scheduleFlush();
    return ok;
  }

  async replyQuestion(nodeId: string, id: string, answers: string[][]): Promise<boolean> {
    if (nodeId.includes("::")) return this.forwardPeer(nodeId, `questions/${encodeURIComponent(id)}/reply`, { answers });
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    const item = node.pendingQuestions.find((q: any) => q.id === id);
    const dir = item ? node.sessions.get(item.sessionID)?.directory : undefined;
    if (!dir) return false;
    const ok = await node["client"].replyQuestion(id, dir, answers);
    node.pendingQuestions = node.pendingQuestions.filter((q: any) => q.id !== id);
    node.kickPoll();
    this.scheduleFlush();
    return ok;
  }

  /** 忽略（拒绝）提问：让 opencode 端的 agent 不再等待，继续往下走 */
  async rejectQuestion(nodeId: string, id: string): Promise<boolean> {
    if (nodeId.includes("::")) return this.forwardPeer(nodeId, `questions/${encodeURIComponent(id)}/reject`, {});
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    const item = node.pendingQuestions.find((q: any) => q.id === id);
    const dir = item ? node.sessions.get(item.sessionID)?.directory : undefined;
    if (!dir) return false;
    const ok = await node["client"].rejectQuestion(id, dir);
    node.pendingQuestions = node.pendingQuestions.filter((q: any) => q.id !== id);
    node.kickPoll();
    this.scheduleFlush();
    return ok;
  }

  private busyOf(n: NodeState): number { return [...n.sessions.values()].filter((s) => s.busy).length; }

  private teamJobs: TeamJobView[] = [];
  private startedAt = Date.now();
  private dataDir?: string;

  private isLocalFsTarget(nodeId?: string): boolean {
    if (!nodeId) return true;
    const node = this.nodes.get(nodeId);
    return Boolean(node && isLocalUrl(node.cfg.url));
  }

  private peerForNode(nodeId: string): PeerConfig | null {
    if (!nodeId) return null;
    const sep = nodeId.indexOf("::");
    if (sep >= 0) return this.effectivePeers().find((p) => p.id === nodeId.slice(0, sep)) ?? null;
    const node = this.nodes.get(nodeId);
    if (!node || isLocalUrl(node.cfg.url)) return null;
    let host = "";
    try { host = new URL(node.cfg.url).hostname; } catch { return null; }
    return this.effectivePeers().find((p) => {
      try { return new URL(p.url).hostname === host; } catch { return false; }
    }) ?? null;
  }

  private targetPlatform(nodeId?: string): string | undefined {
    if (!nodeId) return platform();
    const sep = nodeId.indexOf("::");
    if (sep >= 0) {
      const ph = this.peerSnaps.get(nodeId.slice(0, sep))?.snap?.self?.host as HostMetrics | undefined;
      return ph?.platform;
    }
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;
    if (isLocalUrl(node.cfg.url)) return platform();
    let host = "";
    try { host = new URL(node.cfg.url).hostname; } catch { /* ignore */ }
    if (host) {
      for (const p of this.effectivePeers()) {
        try {
          if (new URL(p.url).hostname === host) {
            const ph = this.peerSnaps.get(p.id)?.snap?.self?.host as HostMetrics | undefined;
            if (ph?.platform) return ph.platform;
          }
        } catch { /* ignore */ }
      }
    }
    const hint = `${node.cfg.label ?? ""} ${node.remoteMachine ?? ""}`.toLowerCase();
    if (hint.includes("win")) return "win32";
    return undefined;
  }

  private async fsPeerRequest(peer: PeerConfig, method: "GET" | "POST", endpoint: string, opts?: { query?: Record<string, string>; body?: any }): Promise<any> {
    const url = new URL(`${peer.url}/api/fs/${endpoint}`);
    for (const [k, v] of Object.entries(opts?.query ?? {})) url.searchParams.set(k, v);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { "content-type": "application/json", ...this.peerHeaders(peer) },
        body: method === "POST" ? JSON.stringify(opts?.body ?? {}) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await res.json().catch(() => ({ ok: false, error: `对端 Atrium 不支持该目录接口（返回非 JSON），请升级目标机器` }));
      if (!res.ok && j.ok !== false) return { ok: false, error: `对端返回 HTTP ${res.status}` };
      return j;
    } catch (e) {
      return { ok: false, error: `无法访问目标机器：${(e as Error).message}` };
    }
  }

  async fsList(nodeId: string, path: string): Promise<any> {
    const p = String(path ?? "").trim();
    if (this.isLocalFsTarget(nodeId)) return fsListLocal(p);
    const peer = this.peerForNode(nodeId);
    if (!peer) {
      return { ok: false, path: p, parent: null, platform: this.targetPlatform(nodeId), entries: [], error: "目标机器没有可用的 Atrium 节点，无法浏览目录" };
    }
    return this.fsPeerRequest(peer, "GET", "list", { query: { path: p } });
  }

  async fsStat(nodeId: string, path: string): Promise<any> {
    const p = String(path ?? "").trim();
    if (!p) return { ok: false, exists: false, isDirectory: false, path: p, error: "缺少 path" };
    if (this.isLocalFsTarget(nodeId)) return fsStatLocal(p);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, exists: false, isDirectory: false, path: p, error: "目标机器没有可用的 Atrium 节点，无法检查目录" };
    return this.fsPeerRequest(peer, "GET", "stat", { query: { path: p } });
  }

  async fsMkdir(nodeId: string, path: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    const p = String(path ?? "").trim();
    if (!p) return { ok: false, path: p, error: "缺少 path" };
    const targetPlatform = this.targetPlatform(nodeId);
    if (!isAbsolutePathFor(p, targetPlatform)) return { ok: false, path: p, error: "需要目标机器的绝对路径" };
    if (this.isLocalFsTarget(nodeId)) return fsMkdirLocal(p);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, path: p, error: "目标机器没有可用的 Atrium 节点，无法创建目录" };
    return this.fsPeerRequest(peer, "POST", "mkdir", { body: { path: p } });
  }

  async fsRename(nodeId: string, path: string, newName: string): Promise<any> {
    const p = String(path ?? "").trim();
    const name = String(newName ?? "").trim();
    if (!p || !name) return { ok: false, error: "缺少 path 或 newName" };
    if (this.isLocalFsTarget(nodeId)) return fsRenameLocal(p, name);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点，无法重命名目录" };
    return this.fsPeerRequest(peer, "POST", "rename", { body: { path: p, newName: name } });
  }

  /* ===== opencode 初始化 / 配置下发（本机直跑，远端经 peer 转发到同机 Atrium） ===== */
  private async ocPeerRequest(peer: PeerConfig, method: "GET" | "POST", endpoint: string, opts?: { body?: any }): Promise<any> {
    try {
      const res = await fetch(`${peer.url}/api/oc/${endpoint}`, {
        method,
        headers: { "content-type": "application/json", ...this.peerHeaders(peer) },
        body: method === "POST" ? JSON.stringify(opts?.body ?? {}) : undefined,
        signal: AbortSignal.timeout(600_000),
      });
      const j: any = await res.json().catch(() => ({ ok: false, error: "对端 Atrium 不支持 opencode 接口（升级目标机器）" }));
      if (!res.ok && j.ok !== false) return { ok: false, error: `对端返回 HTTP ${res.status}` };
      return j;
    } catch (e) {
      return { ok: false, error: `无法访问目标机器：${(e as Error).message}` };
    }
  }

  async ocStatus(nodeId: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocStatusLocal();
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "GET", "status");
  }

  async ocConfigRead(nodeId: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocConfigReadLocal();
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "GET", "config");
  }

  async ocConfigWrite(nodeId: string, content: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocConfigWriteLocal(content);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "config", { body: { content } });
  }

  async ocInstall(nodeId: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocInstallLocal();
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "install");
  }

  /** 把本机 opencode 配置下发到指定机器（读本机配置 → 逐台写；返回每台"原来是否已有配置"以便提示） */
  async pushOpencodeConfig(targets: string[]): Promise<{ ok: boolean; results: { node: string; ok: boolean; hadConfig?: boolean; error?: string }[]; error?: string }> {
    const r = ocConfigReadLocal();
    if (!r.ok || !r.content) return { ok: false, error: "本机没有 opencode 配置（~/.config/opencode/opencode.jsonc）可下发", results: [] };
    const results: { node: string; ok: boolean; hadConfig?: boolean; error?: string }[] = [];
    for (const t of targets) {
      let hadConfig = false;
      try { const st = await this.ocStatus(t); hadConfig = !!st?.hasConfig; } catch { /* ignore */ }
      const w = await this.ocConfigWrite(t, r.content);
      results.push({ node: t, ok: !!w.ok, hadConfig, error: w.error });
    }
    return { ok: results.every((x) => x.ok), results };
  }

  async ocHook(nodeId: string, enabled: boolean): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocHookLocal(enabled, this.cfg.port);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "hook", { body: { enabled } });
  }

  async ocPlugin(nodeId: string, enabled: boolean): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocPluginLocal(enabled, this.cfg.port);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "plugin", { body: { enabled } });
  }

  async ocFixedPwStatus(nodeId: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocFixedPwStatusLocal();
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "GET", "fixedpw");
  }

  async ocSetFixedPw(nodeId: string, password: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocSetFixedPwLocal(password);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "fixedpw", { body: { password } });
  }

  async ocClearFixedPw(nodeId: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocClearFixedPwLocal();
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "fixedpw/clear");
  }

  /** 把固定密码同步到组网里的所有机器（逐台设） */
  async pushFixedPw(targets: string[], password: string): Promise<{ ok: boolean; results: { node: string; ok: boolean; error?: string }[] }> {
    const results: { node: string; ok: boolean; error?: string }[] = [];
    for (const t of targets) {
      const r = await this.ocSetFixedPw(t, password);
      results.push({ node: t, ok: !!r?.ok, error: r?.error });
    }
    return { ok: results.every((x) => x.ok), results };
  }

  /** 从某台主机拉取 opencode 配置写回本机（配置同步：本机选择主机） */
  async pullOpencodeConfigFromHost(hostId: string): Promise<{ ok: boolean; from?: string; path?: string; error?: string }> {
    const peer = this.effectivePeers().find((p) => p.id === hostId);
    if (!peer) return { ok: false, error: `找不到主机 ${hostId}` };
    const r = await this.ocPeerRequest(peer, "GET", "config");
    if (!r?.ok || !r.content) return { ok: false, error: r?.error ?? "主机没有可同步的配置" };
    const w = ocConfigWriteLocal(String(r.content));
    if (!w.ok) return { ok: false, error: w.error ?? "写入本机配置失败" };
    return { ok: true, from: (peer as any).label ?? peer.id, path: w.path };
  }

  /** 在某机器上启动 opencode server（CLI serve / web），完全脱离父进程 */
  async ocServe(nodeId: string, port: number | null, web: boolean): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocServeLocal(port, web);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "serve", { body: { port, web } });
  }

  /** 列出某机器上在跑的 opencode server */
  async ocServeList(nodeId: string): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocServeListLocal();
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "GET", "serve");
  }

  /** 停止某机器上某端口的 opencode server（CLI serve / web） */
  async ocServeStop(nodeId: string, port: number): Promise<any> {
    if (this.isLocalFsTarget(nodeId)) return ocServeStopLocal(port);
    const peer = this.peerForNode(nodeId);
    if (!peer) return { ok: false, error: "目标机器没有可用的 Atrium 节点" };
    return this.ocPeerRequest(peer, "POST", "serve/stop", { body: { port } });
  }

  private ocInitJobs = new Map<string, OcInitJob>();

  ocInitGet(nodeId: string): OcInitJob | null {
    return this.ocInitJobs.get(nodeId) ?? null;
  }

  /** 列出可同步 opencode 配置的其它实例（本机自我初始化时选"主机"用） */
  async ocPeerHosts(): Promise<{ id: string; label: string; url: string; ok: boolean; installed?: boolean; hasConfig?: boolean; version?: string | null; error?: string }[]> {
    const out: { id: string; label: string; url: string; ok: boolean; installed?: boolean; hasConfig?: boolean; version?: string | null; error?: string }[] = [];
    for (const p of this.effectivePeers()) {
      let s: any = null;
      try { s = await this.ocPeerRequest(p, "GET", "status"); } catch { s = { ok: false }; }
      out.push({ id: p.id, label: (p as any).label ?? p.id, url: p.url, ok: !!s?.ok && !s?.error, installed: s?.installed, hasConfig: s?.hasConfig, version: s?.version, error: s?.error });
    }
    return out;
  }

  private ocSelfJobs = new Map<string, OcInitJob>();
  private static readonly OC_SELF_KEY = "__self__";
  ocSelfInitGet(): OcInitJob | null {
    return this.ocSelfJobs.get(FleetRegistry.OC_SELF_KEY) ?? null;
  }

  /** 本机自我初始化：沿用 host 的本机能力，装 opencode → 从某台主机拉取配置 → 注入钩子/插件 */
  ocSelfInitStart(sourcePeerId?: string): OcInitJob {
    const job: OcInitJob = {
      id: `ocself-${Date.now()}`,
      node: this.selfId,
      status: "running",
      startedAt: Date.now(),
      steps: [
        { key: "status", label: "检查本机 opencode", status: "pending" },
        { key: "install", label: "安装 opencode", status: "pending" },
        { key: "config", label: "从主机同步配置", status: "pending" },
        { key: "hook", label: "注入自动上报钩子", status: "pending" },
        { key: "plugin", label: "安装自动上报插件", status: "pending" },
      ],
    };
    this.ocSelfJobs.set(FleetRegistry.OC_SELF_KEY, job);
    void this.runOcSelfInit(job, sourcePeerId);
    return job;
  }

  private async runOcSelfInit(job: OcInitJob, sourcePeerId?: string): Promise<void> {
    try {
      this.ocStep(job, "status", "running");
      const st = ocStatusLocal();
      const installed = !!st.installed;
      this.ocStep(job, "status", "ok", installed ? `已安装 ${st.version ?? ""}${st.binPath ? `（${st.binPath}）` : ""}` : "未检测到 opencode");

      if (installed) this.ocStep(job, "install", "skip", "已安装，跳过");
      else {
        this.ocStep(job, "install", "running");
        const r = ocInstallLocal();
        if (!r.ok) throw new Error(`安装失败：${r.error ?? "未知错误"}`);
        const tail = String(r.output ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-1)[0];
        this.ocStep(job, "install", "ok", tail || "已安装");
      }

      // 选源主机：未指定则自动挑第一台"有配置且可达"的对端
      this.ocStep(job, "config", "running");
      let srcId = sourcePeerId;
      if (!srcId) {
        for (const p of this.effectivePeers()) {
          const s = await this.ocPeerRequest(p, "GET", "status").catch(() => null);
          if (s?.ok && s.hasConfig) { srcId = p.id; break; }
        }
      }
      if (!srcId) this.ocStep(job, "config", "skip", "没有可同步的主机（对端无配置或不可达）");
      else {
        const peer = this.effectivePeers().find((p) => p.id === srcId);
        if (!peer) throw new Error(`找不到主机 ${srcId}`);
        const r = await this.ocPeerRequest(peer, "GET", "config");
        if (!r?.ok || !r.content) throw new Error(`读取主机配置失败：${r?.error ?? "主机没有可同步的配置"}`);
        const w = ocConfigWriteLocal(String(r.content));
        if (!w.ok) throw new Error(`写入本机配置失败：${w.error ?? "未知错误"}`);
        this.ocStep(job, "config", "ok", `已从 ${(peer as any).label ?? peer.id} 同步`);
      }

      this.ocStep(job, "hook", "running");
      const h = ocHookLocal(true, this.cfg.port);
      if (!h.ok) throw new Error(`钩子注入失败：${h.error ?? "未知错误"}`);
      this.ocStep(job, "hook", "ok", "已注入");

      this.ocStep(job, "plugin", "running");
      const pl = ocPluginLocal(true, this.cfg.port);
      if (!pl.ok) throw new Error(`插件安装失败：${pl.error ?? "未知错误"}`);
      this.ocStep(job, "plugin", "ok", pl.path ?? "已安装");

      job.status = "done";
    } catch (e) {
      job.status = "fail";
      job.error = (e as Error).message;
      for (const s of job.steps) {
        if (s.status === "running") { s.status = "fail"; s.detail = job.error; }
        else if (s.status === "pending") s.status = "skip";
      }
    }
    job.finishedAt = Date.now();
  }

  /** 一键初始化：检查 → 安装 → 下发配置 → 注入上报钩子 → 安装上报插件（异步跑，返回可轮询的进度 job） */
  ocInitStart(nodeId: string): OcInitJob {
    const job: OcInitJob = {
      id: `ocinit-${nodeId}-${Date.now()}`,
      node: nodeId,
      status: "running",
      startedAt: Date.now(),
      steps: [
        { key: "status", label: "检查 opencode 状态", status: "pending" },
        { key: "install", label: "安装 / 更新 opencode", status: "pending" },
        { key: "config", label: "下发 opencode 配置", status: "pending" },
        { key: "hook", label: "注入自动上报钩子", status: "pending" },
        { key: "plugin", label: "安装自动上报插件", status: "pending" },
      ],
    };
    this.ocInitJobs.set(nodeId, job);
    void this.runOcInit(job);
    return job;
  }

  private ocStep(job: OcInitJob, key: string, status: OcInitStep["status"], detail?: string) {
    const s = job.steps.find((x) => x.key === key);
    if (s) { s.status = status; if (detail !== undefined) s.detail = detail; }
  }

  private async runOcInit(job: OcInitJob): Promise<void> {
    const nodeId = job.node;
    try {
      this.ocStep(job, "status", "running");
      const st = await this.ocStatus(nodeId);
      if (st?.ok === false && st?.error) throw new Error(String(st.error));
      const installed = !!st?.installed;
      this.ocStep(job, "status", "ok", installed ? `已安装 ${st?.version ?? ""}${st?.binPath ? `（${st.binPath}）` : ""}` : "未检测到 opencode");

      if (installed) this.ocStep(job, "install", "skip", "已安装，跳过");
      else {
        this.ocStep(job, "install", "running");
        const r = await this.ocInstall(nodeId);
        if (!r?.ok) throw new Error(`安装失败：${r?.error ?? "未知错误"}`);
        const tail = String(r.output ?? "").split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean).slice(-1)[0];
        this.ocStep(job, "install", "ok", tail || "已安装");
      }

      this.ocStep(job, "config", "running");
      const local = ocConfigReadLocal();
      if (!local.ok || !local.content) this.ocStep(job, "config", "skip", "本机无 opencode 配置可下发");
      else {
        const w = await this.ocConfigWrite(nodeId, local.content);
        if (!w?.ok) throw new Error(`配置下发失败：${w?.error ?? "未知错误"}`);
        this.ocStep(job, "config", "ok", st?.hasConfig ? "已覆盖（原文件已备份为 .atrium.bak）" : "已写入");
      }

      this.ocStep(job, "hook", "running");
      const h = await this.ocHook(nodeId, true);
      if (!h?.ok) throw new Error(`钩子注入失败：${h?.error ?? "未知错误"}`);
      this.ocStep(job, "hook", "ok", h.path ?? "已注入");

      this.ocStep(job, "plugin", "running");
      const p = await this.ocPlugin(nodeId, true);
      if (!p?.ok) throw new Error(`插件安装失败：${p?.error ?? "未知错误"}`);
      this.ocStep(job, "plugin", "ok", p.path ?? "已安装");

      job.status = "done";
    } catch (e) {
      job.status = "fail";
      job.error = (e as Error).message;
      for (const s of job.steps) {
        if (s.status === "running") { s.status = "fail"; s.detail = job.error; }
        else if (s.status === "pending") s.status = "skip";
      }
    }
    job.finishedAt = Date.now();
  }

  private async mkdirOnNode(nodeId: string, path: string): Promise<boolean> {
    const r = await this.fsMkdir(nodeId, path);
    return r.ok;
  }

  /** 在「节点+目录」建一个专属会话（先确保目录存在），避免污染现有会话 */
  private async sessionInDir(nodeId: string, dir: string): Promise<string | undefined> {
    const node = this.nodes.get(nodeId);
    if (!node || !dir) return undefined;
    await this.mkdirOnNode(nodeId, dir).catch(() => {});
    const created = await node["client"].createSession(dir, "团队任务");
    return created?.id;
  }

  /** 团队派活：派给组长（组长输出 team-plan 计划）→ 按成员忙闲自动分发子任务到各自「机器+目录」 */
  async dispatchTeam(teamId: string, members: TeamMember[], leader: TeamMember | undefined, task: string, opts?: TeamOpts): Promise<{ ok: boolean; to?: string; error?: string }> {
    const text = String(task ?? "").trim();
    if (!text) return { ok: false, error: "任务为空" };
    const mem = (members ?? []).filter((m) => m && m.node && m.dir);
    if (!mem.length) return { ok: false, error: "团队没有有效成员（机器+目录）" };
    const lead = leader && leader.node ? mem.find((m) => m.node === leader.node && m.dir === leader.dir) : undefined;
    if (!lead) return { ok: false, error: "请先给团队指定一个有效的组长（机器+目录）" };
    const leaderNode = this.nodes.get(lead.node);
    if (!leaderNode) return { ok: false, error: "组长节点不存在" };
    if (leaderNode.status === "offline") return { ok: false, error: "组长不在线" };
    const sessionID = await this.sessionInDir(lead.node, lead.dir);
    if (!sessionID) return { ok: false, error: `组长目录不可用：${lead.node} · ${lead.dir}` };
    const pool = opts?.includeLeader === false ? mem.filter((m) => !(m.node === lead.node && m.dir === lead.dir)) : mem;
    const job: TeamJobView = {
      id: `job_${Date.now().toString(36)}`, teamId, leader: `${lead.node} · ${lead.dir}`, task: text, at: Date.now(),
      status: "leader-working", subtasks: [], assigns: [], pool, policy: opts?.policy ?? "idle", concurrency: opts?.concurrency ?? 0, rr: 0,
      leaderNode: lead.node, leaderDir: lead.dir, leaderSession: sessionID,
    };
    this.teamJobs.push(job);
    if (this.teamJobs.length > 100) this.teamJobs = this.teamJobs.slice(-100);
    this.persistJobs();
    const planPrompt = `${text}\n\n[组长指令] 你是本组组长。请把上面的任务拆成若干**可独立执行**的子任务，然后**只**输出下面这个代码块（不要自己动手做任务，我会自动派发）：\n\`\`\`team-plan\n["子任务一", "子任务二"]\n\`\`\``;
    const parts = Array.isArray(opts?.parts) ? opts.parts.filter((p) => p && typeof p === "object") : [];
    const r = parts.length
      ? await this.promptParts(lead.node, sessionID, [...parts, { type: "text", text: planPrompt }])
      : await this.prompt(lead.node, sessionID, planPrompt);
    if (!r.ok) { job.status = "leader-send-failed"; job.summary = `派给组长失败：${r.error ?? ""}`; this.flushJobs(); return { ok: false, error: r.error ?? "派给组长失败" }; }
    this.startTeamWatcher();
    this.flushJobs();
    return { ok: true, to: `${lead.node} · ${lead.dir}` };
  }


  private pickMember(job: TeamJobView, pool: TeamMember[]): TeamMember {
    const policy = job.policy ?? "idle";
    if (policy === "roundrobin") { const m = pool[(job.rr ?? 0) % pool.length]; job.rr = (job.rr ?? 0) + 1; return m; }
    if (policy === "least") {
      const cnt = (mem: TeamMember) => job.assigns.filter((a) => a.node === mem.node && a.dir === mem.dir && (a.status === "running" || a.status === "queued")).length;
      return pool.slice().sort((a, b) => cnt(a) - cnt(b))[0];
    }
    return pool.slice().sort((a, b) => { const na = this.nodes.get(a.node), nb = this.nodes.get(b.node); return this.busyOf(na!) - this.busyOf(nb!); })[0];
  }

  /** 把队列里的子任务按并发上限派出去 */
  private async pumpJob(job: TeamJobView) {
    const pool = (job.pool ?? []).filter((m) => { const n = this.nodes.get(m.node); return n && n.status !== "offline"; });
    if (!pool.length) { for (const a of job.assigns) if (a.status === "queued") { a.status = "fail"; a.output = "没有在线成员"; } return; }
    const limit = job.concurrency && job.concurrency > 0 ? job.concurrency : Math.max(1, pool.length);
    let slots = Math.max(0, limit - job.assigns.filter((a) => a.status === "running").length);
    for (const a of job.assigns) {
      if (slots <= 0) break;
      if (a.status !== "queued") continue;
      const m = this.pickMember(job, pool);
      slots--;
      a.member = `${m.node} · ${m.dir}`; a.node = m.node; a.dir = m.dir;
      try {
        const sessionID = await this.sessionInDir(m.node, m.dir);
        if (!sessionID) { a.status = "fail"; a.output = "无法建会话"; this.flushJobs(); continue; }
        a.sessionId = sessionID; a.status = "running"; a.at = Date.now();
        const r = await this.prompt(m.node, sessionID, a.task);
        if (!r.ok) { a.status = "fail"; a.output = r.error ?? "发送失败"; }
      } catch (e) { a.status = "fail"; a.output = (e as Error).message; }
      this.flushJobs();
    }
  }

  private teamTimer: NodeJS.Timeout | null = null;
  private startTeamWatcher() {
    if (this.teamTimer) return;
    this.teamTimer = setInterval(() => { void this.checkTeamJobs(); }, 4000);
  }

  private resumeTeamJobs() {
    const active = this.teamJobs.some((j) => j.status === "leader-working" || j.status === "dispatching");
    if (active) this.startTeamWatcher();
  }

  /* ===== 自愈：会话「busy 但长时间无进展」自动中断（默认 15 分钟，可用 ATRIUM_STUCK_ABORT_MS 覆盖） ===== */
  private stuckTimer: NodeJS.Timeout | null = null;
  private stuckAbortAt = new Map<string, number>();
  private startStuckWatcher() {
    if (this.stuckTimer) return;
    this.stuckTimer = setInterval(() => { void this.checkStuckSessions(); }, 60_000);
  }
  private async checkStuckSessions() {
    const now = Date.now();
    const limit = Number(process.env.ATRIUM_STUCK_ABORT_MS) || 5 * 60_000;
    const cooldown = limit; // 同一阈值，避免反复 abort
    for (const [nodeId, node] of this.nodes) {
      if (node.status === "offline") continue;
      for (const [sid, sess] of node.sessions) {
        const key = `${nodeId}::${sid}`;
        if (!sess.busy) { this.stuckAbortAt.delete(key); continue; }
        const since = sess.updatedAt ?? 0;
        if (!since || now - since < limit) continue;
        if (now - (this.stuckAbortAt.get(key) ?? 0) < cooldown) continue; // 冷却，避免反复 abort
        this.stuckAbortAt.set(key, now);
        try {
          await this.abort(nodeId, sid);
          console.log(`[atrium] 自动中断疑似卡死会话 ${key}（busy ${Math.round((now - since) / 60000)} 分钟无进展）`);
        } catch { /* ignore */ }
      }
    }
  }

  /** 组长会话：把一段文字发给组长（组员提问/授权/验收都走这里） */
  private async leaderSay(job: TeamJobView, text: string): Promise<void> {
    if (!job.leaderNode || !job.leaderSession) return;
    try { await this.prompt(job.leaderNode, job.leaderSession, text); } catch { /* ignore */ }
  }

  /** 取组长在 sinceAt 之后最新的助手文本（作为对某次询问的回复） */
  private async leaderReplySince(job: TeamJobView, sinceAt: number): Promise<string | null> {
    if (!job.leaderNode || !job.leaderSession) return null;
    const node = this.nodes.get(job.leaderNode);
    if (!node) return null;
    try {
      const dir = job.leaderDir || node.sessions.get(job.leaderSession)?.directory || "";
      const msgs = await node["client"].listMessages(job.leaderSession, dir, 10);
      const last = [...msgs].reverse().find((m: any) => m?.info?.role === "assistant" && (m.info?.time?.created ?? 0) >= sinceAt);
      if (!last) return null;
      const txt = (last.parts ?? []).filter((p: any) => p.type === "text" && p.text).map((p: any) => p.text).join("\n").trim();
      return txt || null;
    } catch { return null; }
  }

  private static looksDone(s: string): boolean {
    const head = s.trim().slice(0, 24);
    return /(已完成|完成|通过了|通过|done|finish|结束|可以了|没问题|ok\b)/i.test(head);
  }

  /** 定时：更新每个子任务状态/产出；组员提问/授权转给组长回填；产出交组长验收；有空位继续派；全部结束给汇总 */
  private teamChecking = false;
  private async checkTeamJobs() {
    if (this.teamChecking) return;
    this.teamChecking = true;
    try {
      await this.runTeamJobCheck();
    } finally {
      this.teamChecking = false;
    }
  }

  private async runTeamJobCheck() {
    let changed = false;
    for (const job of this.teamJobs) {
      if (job.status === "leader-working") {
        if (Date.now() > job.at + 10 * 60_000) {
          job.status = "timeout";
          job.summary = "组长 10 分钟内没给出计划";
          changed = true;
          continue;
        }
        if (!job.leaderNode || !job.leaderSession) continue;
        const node = this.nodes.get(job.leaderNode);
        if (!node) continue;
        try {
          const dir = job.leaderDir || node.sessions.get(job.leaderSession)?.directory || "";
          if (!dir) continue;
          const msgs = await node["client"].listMessages(job.leaderSession, dir, 12);
          const plan = extractTeamPlan(msgs, job.at);
          if (plan && plan.length) {
            job.subtasks = plan;
            job.assigns = plan.map((task) => ({ member: "", node: "", dir: "", task, status: "queued" as const, at: Date.now() }));
            job.status = "dispatching";
            await this.pumpJob(job);
            changed = true;
          }
        } catch { /* keep waiting */ }
        continue;
      }
      if (job.status !== "dispatching") continue;
      // 组长会话一次只处理一条中转（提问/授权/验收），串行化避免多个子任务串味
      const leaderInFlight = job.assigns.some((x) => x.relayAt || x.verifying);
      for (const a of job.assigns) {
        if (a.status !== "running" || !a.node || !a.sessionId) continue;
        const node = this.nodes.get(a.node);
        if (!node || node.status === "offline") {
          if (Date.now() - this.startedAt < 30_000) continue;
          a.status = "fail"; a.output = "节点离线，无法确认产出"; changed = true; continue;
        }
        const sess = node.sessions.get(a.sessionId);
        const dir = a.dir || sess?.directory || "";

        // A) 有在途转发（组员提问/授权）→ 等组长回复后回填给组员
        if (a.relayAt && a.relayKind && a.relayId) {
          if (Date.now() - a.relayAt > 90_000) { a.relayAt = undefined; a.relayKind = undefined; a.relayId = undefined; changed = true; }
          else {
            const reply = await this.leaderReplySince(job, a.relayAt);
            if (reply) {
              try {
                if (a.relayKind === "question") await node["client"].replyQuestion(a.relayId, dir, [[reply]]);
                else await node["client"].replyPermission(a.relayId, dir, /拒绝|不允许|reject|deny|no\b/i.test(reply) ? "reject" : "once");
              } catch { /* reply 失败也先记录，避免死循环 */ }
              a.answered = [...(a.answered ?? []), (a.relayKind === "question" ? "q:" : "p:") + a.relayId];
              a.relayAt = undefined; a.relayKind = undefined; a.relayId = undefined;
              changed = true;
            }
            continue; // 等组长确认期间不判完成
          }
        }

        // B) 组员有新问题/待授权 → 转给组长（一次一条，防串）
        const pQs = (node.pendingQuestions ?? []).filter((q: any) => q.sessionID === a.sessionId && !(a.answered ?? []).includes("q:" + q.id));
        const pPs = (node.pendingPermissions ?? []).filter((p: any) => p.sessionID === a.sessionId && !(a.answered ?? []).includes("p:" + p.id));
        if (pQs.length) {
          const q: any = pQs[0];
          const ask = (q.questions ?? []).map((qq: any) => {
            const opts = (qq.options ?? []).map((o: any) => o.label).filter(Boolean);
            return `${qq.header ? qq.header + "：" : ""}${qq.question ?? ""}${opts.length ? "（选项：" + opts.join("、") + "）" : ""}`;
          }).join(" / ");
          if (leaderInFlight) continue;
          a.relayKind = "question"; a.relayId = q.id; a.relayAt = Date.now();
          void this.leaderSay(job, `[组员提问] 子任务「${a.task}」的组员（${a.member || a.dir}）需要你确认：\n${ask}\n\n请作为组长直接给出答复；若是选项题，只回复所选选项的文字。`);
          changed = true; continue;
        }
        if (pPs.length) {
          const p: any = pPs[0];
          if (leaderInFlight) continue;
          a.relayKind = "permission"; a.relayId = p.id; a.relayAt = Date.now();
          void this.leaderSay(job, `[组员请求授权] 子任务「${a.task}」的组员（${a.member || a.dir}）请求权限：${p.permission ?? p.title ?? "?"}。\n同意回复“同意”，拒绝回复“拒绝”。`);
          changed = true; continue;
        }

        if (sess?.busy) {
          // 卡死检测：busy 且很久没有任何进展（会话 updatedAt 停止前进）→ 中断该会话并判失败，避免整队被一条卡住的命令拖死
          const since = sess.updatedAt ?? a.at;
          if (Date.now() - since > 5 * 60_000) {
            try { await this.abort(a.node, a.sessionId); } catch { /* ignore */ }
            a.status = "fail"; a.output = "会话疑似卡死（busy 超时 5 分钟无进展），已中断"; changed = true;
          }
          continue; // 还在跑
        }

        // C) 空闲：产出交组长验收，组长认为完成才置 done
        try {
          const msgs = await node["client"].listMessages(a.sessionId, dir, 6);
          const last = [...msgs].reverse().find((m: any) => m?.info?.role === "assistant" && (m.info?.time?.created ?? 0) >= a.at);
          if (!last) { if (Date.now() - a.at > 120_000) { a.status = "fail"; a.output = "超时无产出"; changed = true; } continue; }
          const out = (last.parts ?? []).filter((p: any) => p.type === "text" && p.text).map((p: any) => p.text).join("\n").trim() || "(无文本产出)";
          if (!a.verifying) {
            if (leaderInFlight) continue;
            a.verifying = true; a.verifyAt = Date.now();
            void this.leaderSay(job, `[验收] 子任务「${a.task}」的组员（${a.member || a.dir}）产出：\n${out.slice(0, 800)}\n\n若你认为该子任务已完成，回复“完成”；若还需继续，直接回复要发给组员的补充指令。`);
            changed = true; continue;
          }
          const verdict = await this.leaderReplySince(job, a.verifyAt!);
          if (verdict) {
            a.output = out.slice(0, 1000);
            if (FleetRegistry.looksDone(verdict)) {
              a.status = "done"; a.verifying = false;
            } else {
              // 组长的补充指令 → 继续派给组员
              a.at = Date.now(); a.verifying = false; a.verifyAt = undefined;
              try { await this.prompt(a.node, a.sessionId, verdict); } catch { /* ignore */ }
            }
            changed = true;
          } else if (Date.now() - (a.verifyAt ?? 0) > 60_000) {
            // 组长超时未验收 → 兜底判完成，避免卡死
            a.output = out.slice(0, 1000); a.status = "done"; a.verifying = false; changed = true;
          }
        } catch { /* keep */ }
      }
      const pend = job.assigns.some((a) => a.status === "running" || a.status === "queued");
      if (!pend) {
        const done = job.assigns.filter((a) => a.status === "done").length;
        const fail = job.assigns.filter((a) => a.status === "fail").length;
        job.status = fail === 0 ? "done" : (done > 0 ? "partial" : "failed");
        job.summary = `共 ${job.assigns.length} 个子任务：成功 ${done} · 失败 ${fail}`;
        changed = true;
      } else {
        await this.pumpJob(job);
      }
    }
    if (changed) this.flushJobs();
  }

  /** 重派某条子任务（失败/超时后用） */
  async retryTeamAssign(jobId: string, index: number): Promise<boolean> {
    const job = this.teamJobs.find((j) => j.id === jobId);
    const a = job?.assigns[index];
    if (!job || !a) return false;
    a.status = "queued"; a.member = ""; a.node = ""; a.dir = ""; a.sessionId = undefined; a.output = undefined; a.at = Date.now();
    a.answered = undefined; a.relayKind = undefined; a.relayId = undefined; a.relayAt = undefined; a.verifyAt = undefined; a.verifying = undefined;
    job.status = "dispatching";
    this.startTeamWatcher();
    await this.pumpJob(job);
    this.flushJobs();
    return true;
  }

  /** 团队时间线：把该团队「组长会话 + 各子任务会话」的消息合并成一条按时间排序的聊天流（看得到 agent 之间说了什么） */
  async teamTimeline(teamId: string, limit = 200): Promise<{ ok: boolean; events: any[] }> {
    const jobs = this.teamJobs.filter((j) => j.teamId === teamId);
    const sessions = new Map<string, { node: string; sessionId: string; who: string; kind: string; dir?: string }>();
    for (const j of jobs) {
      if (j.leaderNode && j.leaderSession) {
        sessions.set(`${j.leaderNode}::${j.leaderSession}`, { node: j.leaderNode, sessionId: j.leaderSession, who: "组长", kind: "leader" });
      }
      for (const a of j.assigns) {
        if (a.node && a.sessionId) {
          const bn = (a.dir || "").split(/[\\/]/).filter(Boolean).pop() || "?";
          sessions.set(`${a.node}::${a.sessionId}`, { node: a.node, sessionId: a.sessionId, who: `组员·${bn}`, kind: "member", dir: a.dir });
        }
      }
    }
    const events: any[] = [];
    for (const s of sessions.values()) {
      const node = this.nodes.get(s.node);
      if (!node) continue;
      try {
        const dir = s.dir || node.sessions.get(s.sessionId)?.directory || "";
        const msgs = await node["client"].listMessages(s.sessionId, dir, limit);
        for (const m of msgs) {
          const role = m?.info?.role;
          if (!role) continue;
          events.push({
            id: `${s.sessionId}:${m.info.id}`,
            sessionId: s.sessionId, node: s.node, who: s.who, kind: s.kind, role,
            at: m.info?.time?.created ?? 0,
            parts: (m.parts ?? []).filter((p: any) => p.type !== "step-start" && p.type !== "step-finish"),
          });
        }
      } catch { /* 单个会话读失败不影响整体 */ }
    }
    events.sort((a, b) => a.at - b.at);
    return { ok: true, events: events.slice(-400) };
  }

  /** 团队任务历史：内存 + 落盘（dataDir/team-jobs.json），重启不丢 */
  private jobsFile(): string | undefined { return this.dataDir ? join(this.dataDir, "team-jobs.json") : undefined; }
  private loadJobs() {
    const f = this.jobsFile();
    if (!f || !existsSync(f)) return;
    try { const a = JSON.parse(readFileSync(f, "utf8")); if (Array.isArray(a)) this.teamJobs = a.slice(-200); } catch { /* ignore */ }
  }
  private persistJobs() {
    const f = this.jobsFile();
    if (!f) return;
    try { writeFileSync(f, JSON.stringify(this.teamJobs.slice(-200))); } catch { /* ignore */ }
  }
  private flushJobs() { this.persistJobs(); this.scheduleFlush(); }

  async prompt(nodeId: string, sessionID: string, text: string, model?: ModelRef): Promise<{ ok: boolean; error?: string }> {
    if (this.isPiNode(nodeId)) {
      return this.promptPi(text, sessionID);
    }
    if (nodeId.includes("::")) return this.forwardPeerResult(nodeId, `sessions/${encodeURIComponent(sessionID)}/prompt`, { text, ...(model ? { model } : {}) });
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, error: "节点不存在" };
    const dir = await this.sessionDirOf(node, sessionID);
    if (!dir) return { ok: false, error: "找不到会话目录" };
    const r = await node["client"].prompt(sessionID, dir, text, model);
    const sess = node.sessions.get(sessionID);
    if (r.ok) {
      if (sess) {
        sess.busy = true;
        sess.lastError = undefined;
        sess.lastErrorAt = undefined;
        if (model) { sess.model = model.modelID; sess.providerID = model.providerID; }
      }
      node.kickPoll();
      this.scheduleFlush();
    }
    return r;
  }

  /** 带附件的 prompt（parts: text + file base64） */
  async promptParts(nodeId: string, sessionID: string, parts: unknown[], model?: ModelRef): Promise<{ ok: boolean; error?: string }> {
    if (nodeId.includes("::")) return this.forwardPeerResult(nodeId, `sessions/${encodeURIComponent(sessionID)}/prompt-parts`, { parts, ...(model ? { model } : {}) });
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, error: "节点不存在" };
    const dir = await this.sessionDirOf(node, sessionID);
    if (!dir) return { ok: false, error: "找不到会话目录" };
    const r = await node["client"].promptWithParts(sessionID, dir, parts, model);
    const sess = node.sessions.get(sessionID);
    if (r.ok) {
      if (sess) {
        sess.busy = true;
        sess.lastError = undefined;
        sess.lastErrorAt = undefined;
        if (model) { sess.model = model.modelID; sess.providerID = model.providerID; }
      }
      node.kickPoll();
      this.scheduleFlush();
    }
    return r;
  }

  /** 可用模型清单：本机直调 opencode /config/providers；远端转发给 peer。
   *  返回裁剪后的 { providers:[{id,name,models:[{id,name}]}], default }，避免把 capabilities/cost 等大字段塞进快照。 */
  async models(nodeId: string): Promise<ModelsResponse> {
    if (nodeId.includes("::")) {
      const j = await this.forwardPeerGet(nodeId, "models", 15_000);
      if (j && typeof j === "object") return j as ModelsResponse;
      return { ok: false, reason: "对端不可达" };
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, reason: "节点不存在" };
    try {
      const raw = await node["client"].listProviders();
      const providers: ProviderModels[] = (raw?.providers ?? [])
        .map((p: any) => ({
          id: String(p?.id ?? ""),
          name: String(p?.name ?? p?.id ?? ""),
          models: Object.values(p?.models ?? {})
            .map((m: any) => ({ id: String(m?.id ?? ""), name: String(m?.name ?? m?.id ?? "") }))
            .filter((m) => m.id),
        }))
        .filter((p) => p.id && p.models.length);
      return { ok: true, providers, default: raw?.default ?? {} };
    } catch (e) {
      return { ok: false, reason: (e as Error)?.message ?? "获取模型失败" };
    }
  }


  /** debounced flush to browser listeners, max 1/sec */
  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const snap = this.snapshot();
      for (const fn of this.listeners) {
        try {
          fn(snap);
        } catch {
          this.listeners.delete(fn);
        }
      }
    }, 1000);
  }
}
