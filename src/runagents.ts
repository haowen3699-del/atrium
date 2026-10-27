import { execFile, spawn } from "node:child_process";
import { openSync, readSync, fstatSync, closeSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const IS_WIN = process.platform === "win32";

interface ProcRow {
  pid: number;
  ppid: number;
  time: string;
  args: string;
}

export interface WinPort { port: number; pid: number }

/** Windows 进程 + 端口快照：一次 PowerShell 同时取 Win32_Process 和 Get-NetTCPConnection，
 *  供 listProcs / findWindowsOpencodePorts / findOpencodeDesktopApp 共用，避免各自 spawn PowerShell。
 *  缓存 8 秒——一次 discoveryLoop（10s）里多个调用方复用同一份，PowerShell spawn 从 5 次/轮降到 1 次。 */
let snapCache: { at: number; procs: ProcRow[]; ports: WinPort[] } | null = null;
const SNAP_TTL = 8000;

export async function windowsSnapshot(): Promise<{ procs: ProcRow[]; ports: WinPort[] }> {
  if (snapCache && Date.now() - snapCache.at < SNAP_TTL) return snapCache;
  const snap = await windowsSnapshotUncached();
  snapCache = { at: Date.now(), ...snap };
  return snap;
}

async function windowsSnapshotUncached(): Promise<{ procs: ProcRow[]; ports: WinPort[] }> {
  if (!IS_WIN) return { procs: await listProcsUncached(), ports: [] };
  try {
    const { stdout } = await exec("powershell", ["-NoProfile", "-Command", [
      "$j = @{}",
      "$j.procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,UserModeTime,KernelModeTime,CommandLine)",
      "$j.ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0') } | ForEach-Object { [pscustomobject]@{port=$_.LocalPort; pid=$_.OwningProcess} })",
      "$j | ConvertTo-Json -Compress -Depth 3",
    ].join("\n")], { maxBuffer: 32 << 20, timeout: 20000, windowsHide: true });
    const obj = JSON.parse(String(stdout ?? "{}"));
    const procs = (Array.isArray(obj.procs) ? obj.procs : (obj.procs ? [obj.procs] : []))
      .filter((p: any) => p && p.ProcessId != null)
      .map((p: any) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId ?? 0), time: String(Math.round(((p.UserModeTime ?? 0) + (p.KernelModeTime ?? 0)) / 1e7)), args: String(p.CommandLine ?? "") }));
    const ports = (Array.isArray(obj.ports) ? obj.ports : (obj.ports ? [obj.ports] : []))
      .filter((p: any) => p && p.port != null)
      .map((p: any) => ({ port: Number(p.port), pid: Number(p.pid ?? 0) }));
    return { procs, ports };
  } catch {
    return { procs: [], ports: [] };
  }
}

async function listProcs(): Promise<ProcRow[]> {
  if (IS_WIN) return (await windowsSnapshot()).procs;
  return listProcsUncached();
}

/** Snapshot of all processes (macOS/Linux via ps). */
async function listProcsUncached(): Promise<ProcRow[]> {
  try {
    const out = (await exec("ps", ["-axo", "pid=,ppid=,time=,args="], { maxBuffer: 8 << 20 })).stdout;
    const rows: ProcRow[] = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+(?::\d+)*(?:\.\d+)?)\s+(.+)$/);
      if (m) {
        // ps TIME on macOS is [dd-]hh:mm:ss[.cs]; day component breaks numeric parse — approximate as 0 when present
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), time: m[3], args: m[4] });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export function argv0Base(args: string): string {
  const argv0 = args.trim().split(/\s+/)[0] ?? "";
  const unquoted = argv0.replace(/^["']|["']$/g, "");
  return (unquoted.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "");
}

/** Bridge daemons that spawn agent workers (run mode). */
const BRIDGE_NAMES = new Set(["cc-connect", "ccconnect"]);

interface BridgeDef {
  name: string;
  /** match on full ps args line */
  detect: (args: string) => boolean;
}

/** Additional bridge daemons discovered by command-line signature. */
const BRIDGE_DEFS: BridgeDef[] = [
  { name: "openclaw", detect: (a) => /openclaw[/\\]dist[/\\]index\.js\s+\S*gateway/.test(a) || /(^|\s)openclaw(\.mjs)?\s+gateway\b/.test(a) },
  { name: "hermes", detect: (a) => /hermes_cli/.test(a) && /\bgateway\b/.test(a) },
];

export interface RunAgentProc {
  pid: number;
  ppid: number;
  bridge: string;
  proc: string;
  cpuSeconds: number;
  workDir: string | null;
  /** opencode run --session <id> extracted from worker cmdline */
  sessionId?: string;
}

function cpuTimeToSeconds(t: string): number {
  const parts = t.split(/[:\-]/).map(Number);
  if (parts.length === 4) return ((parts[0] * 24 + parts[1]) * 3600 + parts[2] * 60 + parts[3]);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number.isFinite(parts[0]) ? parts[0] : 0;
}

/** Find opencode worker processes that are direct children of a bridge daemon. */
export async function findRunAgentProcs(): Promise<RunAgentProc[]> {
  const rows = await listProcs();
  const bridges = new Map<number, string>();
  for (const rec of rows) {
    const base = argv0Base(rec.args);
    if (BRIDGE_NAMES.has(base)) bridges.set(rec.pid, base);
  }
const SHELL_PROCS = new Set(["zsh", "bash", "sh", "cmd", "powershell", "pwsh"]);

const res: RunAgentProc[] = [];
  for (const p of rows) {
    const bridge = bridges.get(p.ppid) ?? bridges.get(rows.find((x) => x.pid === p.ppid)?.ppid ?? -1);
    if (!bridge) continue;
    const proc = argv0Base(p.args);
    if (SHELL_PROCS.has(proc)) continue; // 壳进程包装层不算 worker
    res.push({
      pid: p.pid,
      ppid: p.ppid,
      bridge,
      proc,
      cpuSeconds: Math.round(cpuTimeToSeconds(p.time)),
      workDir: await pidCwd(p.pid),
      sessionId: p.args.match(/--session\s+(\S+)/)?.[1],
    });
  }
  return res;
}

/**
 * OpenCode 桌面应用主进程。
 * 只认主进程：Electron 的 helper / renderer / gpu / crashpad 子进程、以及 opencode
 * server（serve --port，已作为节点监控）都不算。与 Python sidecar 的 desktop 规则对齐，
 * 让"hub 所在机器"也能看到本机的 Desktop，而不是只有远端机器才看得到。
 */
export async function findDesktopApp(): Promise<RunAgentProc | null> {
  const rows = await listProcs();
  for (const r of rows) {
    const args = r.args;
    const cl = args.toLowerCase();
    if (!cl.includes("opencode")) continue;
    if (args.includes("--type=") || cl.includes("crashpad")) continue; // Electron 内部子进程
    if (cl.includes("cc-connect") || cl.includes("openclaw") || cl.includes("hermes")) continue;
    if (/\bserve\b/.test(cl) && /--port\b/.test(cl)) continue; // 本机 opencode server
    const isDesktop =
      /\.app[\\/]contents[\\/]macos[\\/]opencode(\s|$)/i.test(args) || // macOS 主进程
      /[\\/]opencode(-desktop)?\.exe"?$/i.test(args.trim()) ||          // Windows 主进程
      /[\\/]opencode-desktop(\s|$)/i.test(args);                        // Linux
    if (!isDesktop) continue;
    return {
      pid: r.pid,
      ppid: r.ppid,
      bridge: "desktop",
      proc: "opencode",
      cpuSeconds: Math.round(cpuTimeToSeconds(r.time)),
      workDir: "OpenCode Desktop",
    };
  }
  return null;
}

/** A standalone `pi` process that is not a bridge-daemon child. */
export async function findStandalonePi(): Promise<number | null> {
  const rows = await listProcs();
  for (const r of rows) {
    if (argv0Base(r.args) !== "pi") continue;
    if (BRIDGE_NAMES.has(argv0Base(rows.find((x) => x.pid === r.ppid)?.args ?? ""))) continue;
    return r.pid;
  }
  return null;
}

/** Resolve a process's current working directory via lsof (macOS/Linux only). */
export async function pidCwd(pid: number): Promise<string | null> {
  if (IS_WIN) return null;
  try {
    const { stdout } = await exec("lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 3000 });
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n") && line.length > 1) return line.slice(1);
    }
  } catch {
    /* process gone or lsof denied */
  }
  return null;
}
const BRIDGE_LOGS = [
  process.env.FLEET_BRIDGE_LOG,
  `${homedir()}/.cc-connect/logs/cc-connect.log`,
].filter(Boolean) as string[];

/** Read the tail of a file without shelling out (cross-platform). */
function tailFile(path: string, maxBytes = 320_000): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Recent opencode session IDs the bridge worked on, newest first. */
export async function recentBridgeSessions(limit = 5): Promise<string[]> {
  const ids: string[] = [];
  for (const log of BRIDGE_LOGS) {
    for (const m of tailFile(log).matchAll(/agent_session=(\S+)/g)) {
      if (!ids.includes(m[1])) ids.unshift(m[1]);
    }
  }
  return ids.slice(0, limit);
}

export interface BridgeDaemon {
  name: string;
  pid: number;
  childCount: number;
  cpuSeconds: number;
  workDir: string | null;
}

/** Locate openclaw / hermes gateway daemon processes via process command-line signature. */
export async function findBridgeDaemons(): Promise<BridgeDaemon[]> {
  const rows = await listProcs();
  const daemonName = new Map<number, string>();
  for (const r of rows) {
    for (const d of BRIDGE_DEFS) {
      if (d.detect(r.args)) {
        daemonName.set(r.pid, d.name);
        break;
      }
    }
  }
  const isWrapper = (r: { pid: number }, name: string) =>
    rows.some((c) => c.ppid === r.pid && daemonName.get(c.pid) === name);
  const res: BridgeDaemon[] = [];
  for (const r of rows) {
    const name = daemonName.get(r.pid);
    if (!name || isWrapper(r, name)) continue;
    res.push({
      name,
      pid: r.pid,
      childCount: rows.filter((c) => c.ppid === r.pid && !daemonName.has(c.pid)).length,
      cpuSeconds: Math.round(cpuTimeToSeconds(r.time)),
      workDir: await pidCwd(r.pid),
    });
  }
  return res;
}

export interface LiteSession {
  id: string;
  title: string;
  model?: string;
  source?: string;
  updatedAt: number;
  busy: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

const liteCache = new Map<string, { at: number; data: LiteSession[] }>();

async function cachedLite(key: string, ttlMs: number, fn: () => Promise<LiteSession[]>): Promise<LiteSession[]> {
  const hit = liteCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = await fn();
  liteCache.set(key, { at: Date.now(), data });
  return data;
}

/** Read a byte slice of a file; start<0 counts from EOF. */
function readFileSlice(path: string, start: number, len: number): string {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const off = start < 0 ? Math.max(0, size + start) : start;
    const buf = Buffer.alloc(Math.max(0, Math.min(len, size - off)));
    readSync(fd, buf, 0, buf.length, off);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function parsePiSession(path: string, mtimeMs: number): LiteSession | null {
  const head = readFileSlice(path, 0, 6000);
  const tail = readFileSlice(path, -30000, 30000);
  const headLines = head.split("\n");
  if (headLines[0] && !headLines[0].startsWith("{")) return null;
  let id = "", cwd = "", model: string | undefined, title = "";
  try {
    const meta = JSON.parse(headLines[0]);
    if (meta.type !== "session") return null;
    id = String(meta.id ?? path);
    cwd = String(meta.cwd ?? "");
  } catch {
    return null;
  }
  for (const line of headLines.slice(1)) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "message" && e.message?.role === "user" && !title) {
      const t = (e.message.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
      title = String(t).replace(/\s+/g, " ").slice(0, 60);
    }
  }
  for (const line of tail.split("\n")) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "model_change") model = `${e.provider ?? ""}/${e.modelId ?? ""}`.replace(/^\//, "");
    if (e.type === "message" && e.message?.role === "user") {
      const t = (e.message.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
      if (t) title = String(t).replace(/\s+/g, " ").slice(0, 60);
    }
  }
  return {
    id,
    title: title || id,
    model,
    source: cwd,
    updatedAt: mtimeMs,
    busy: Date.now() - mtimeMs < 120_000,
  };
}

/** pi agent JSONL sessions under ~/.pi/agent/sessions/<enc-cwd>/*.jsonl (newest first). */
export function piSessions(): Promise<LiteSession[]> {
  return cachedLite("pi", 8_000, async () => {
    const root = process.env.PI_SESSIONS_DIR ?? `${homedir()}/.pi/agent/sessions`;
    const out: LiteSession[] = [];
    try {
      for (const sub of readdirSync(root)) {
        let files: { f: string; m: number }[];
        try {
          const dir = `${root}/${sub}`;
          files = readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ f, m: statSync(`${dir}/${f}`).mtimeMs }))
            .sort((a, b) => b.m - a.m)
            .slice(0, 4);
        } catch {
          continue;
        }
        for (const { f, m } of files) {
          const s = parsePiSession(`${root}/${sub}/${f}`, m);
          if (s) out.push(s);
        }
      }
    } catch {
      return [];
    }
    return out.sort((a, b) => Number(b.busy) - Number(a.busy) || b.updatedAt - a.updatedAt).slice(0, 12);
  });
}

/** 按会话 id（ULID）定位 pi 会话 JSONL 文件（文件名里含 id）。找不到返回 null。 */
export function piSessionFile(sessionId: string): string | null {
  const root = process.env.PI_SESSIONS_DIR ?? `${homedir()}/.pi/agent/sessions`;
  try {
    for (const sub of readdirSync(root)) {
      let files: string[];
      try { files = readdirSync(`${root}/${sub}`).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        if (f.includes(sessionId)) return `${root}/${sub}/${f}`;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 把 pi 会话 JSONL 转成 opencode 兼容的消息数组（复用 ChatView 渲染）。
 * pi entry: {type:"message", id, timestamp, message:{role, content:[{type:"text"|"thinking"|"toolCall"}]}}
 * 映射：thinking → reasoning part；text → text part；toolCall → tool part（折叠展示命令参数）；toolResult 消息忽略。
 */
export function piMessages(sessionId: string): any[] {
  const file = piSessionFile(sessionId);
  if (!file) return [];
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const out: any[] = [];
  let seq = 0;
  for (const line of text.split("\n")) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "message") continue;
    const m = e.message ?? {};
    const role = m.role === "toolResult" ? null : m.role;
    if (!role) continue;
    const parts: any[] = [];
    for (const c of m.content ?? []) {
      if (c.type === "thinking") {
        if (c.thinking) parts.push({ type: "reasoning", text: String(c.thinking) });
      } else if (c.type === "text") {
        if (c.text) parts.push({ type: "text", text: String(c.text) });
      } else if (c.type === "toolCall") {
        parts.push({
          type: "tool",
          tool: c.name,
          state: { status: "completed", title: c.name, input: c.arguments ?? {} },
          text: JSON.stringify(c.arguments ?? {}, null, 2),
        });
      }
    }
    if (!parts.length) continue;
    out.push({ info: { id: e.id ?? `pi-${seq++}`, role, time: e.timestamp ?? 0 }, parts });
  }
  return out;
}
/** Recent sessions stored by the openclaw gateway (newest first, busy = touched < 2 min ago). */
export function openclawSessions(): Promise<LiteSession[]> {
  return cachedLite("openclaw", 15_000, async () => {
    const bin = process.env.OPENCLAW_BIN ?? `${homedir()}/.openclaw/bin/openclaw`;
    try {
      const { stdout } = await exec(bin, ["sessions", "--json"], { timeout: 8000, maxBuffer: 8 << 20 });
      const d = JSON.parse(stdout);
      return (d.sessions ?? [])
        .slice(0, 12)
        .map((s: any) => ({
          id: String(s.key ?? s.sessionId ?? ""),
          title: String(s.key ?? s.sessionId ?? ""),
          model: s.model,
          source: s.participants?.find((p: any) => p?.identity?.pluginId)?.identity?.pluginId ?? "cli",
          updatedAt: s.updatedAt ?? 0,
          busy: Math.min(s.ageMs ?? Infinity, Date.now() - (s.lastInteractionAt ?? 0)) < 180_000,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
        }))
        .filter((s: LiteSession) => s.id)
        .sort((a: LiteSession, b: LiteSession) => Number(b.busy) - Number(a.busy) || b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  });
}

/**
 * 给 standalone pi agent 派一条任务：后台 spawn `pi --print`（非交互，处理完退出），
 * 带 PI_CODING_AGENT_DIR=~/.pi/agent，续写指定会话 JSONL。面板靠 piSessions() 轮询看到 busy/结果。
 */
export async function spawnPiPrompt(sessionId: string | null, text: string): Promise<{ ok: boolean; error?: string; pid?: number }> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? `${homedir()}/.pi/agent`;
  const bin = IS_WIN ? "pi.cmd" : "pi";
  // pi 的 --session 只接受「会话文件路径」，不接受 id/文件名；这里按 id 定位成绝对路径
  let sessionFile: string | null = null;
  if (sessionId) {
    sessionFile = piSessionFile(sessionId);
    if (!sessionFile) return { ok: false, error: `找不到 pi 会话 ${sessionId}` };
  }
  const args: string[] = ["--print"];
  if (sessionFile) args.push("--session", sessionFile);
  args.push("--", text);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; error?: string; pid?: number }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(bin, args, {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, error: `无法启动 pi：${(e as Error).message}` });
    }
    child.once("error", (e) => finish({ ok: false, error: `无法启动 pi：${e.message}` }));
    child.once("spawn", () => {
      try { child.unref(); } catch { /* ignore */ }
      finish({ ok: true, pid: child.pid ?? undefined });
    });
  });
}
export function hermesSessions(): Promise<LiteSession[]> {
  return cachedLite("hermes", 10_000, async () => {
    const db = process.env.HERMES_DB ?? `${homedir()}/.hermes/state.db`;
    const sql =
      "select s.id, s.title, s.model, s.source, " +
      "coalesce(s.ended_at, s.started_at) * 1000 as upd, " +
      "exists(select 1 from session_turn_leases l where l.conversation_id = s.id and l.expires_at > strftime('%s','now')) as busy " +
      "from sessions s order by coalesce(s.ended_at, s.started_at) desc limit 12";
    try {
      const { stdout } = await exec("sqlite3", ["-json", db, sql], { timeout: 6000, maxBuffer: 4 << 20 });
      const rows = JSON.parse(stdout || "[]");
      return rows
        .map((r: any) => ({
          id: String(r.id),
          title: String(r.title || r.id),
          model: r.model ?? undefined,
          source: r.source ?? undefined,
          updatedAt: Number(r.upd ?? 0),
          busy: Number(r.busy ?? 0) === 1,
        }))
        .sort((a: LiteSession, b: LiteSession) => Number(b.busy) - Number(a.busy) || b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  });
}
