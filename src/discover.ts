import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { windowsSnapshot, argv0Base } from "./runagents.ts";

const exec = promisify(execFile);

/** 定位本机 OpenCode 桌面版应用的路径（优先从运行中的进程取，否则按平台默认路径猜） */

/** desktop 定位缓存：PowerShell 冷启动这台机器要 6-8s（Defender 慢扫），30s 缓存让组网页面秒回 */
let desktopAppCache: { at: number; app: { path: string; pid: number | null } | null } | null = null;

export function clearDesktopAppCache() {
  desktopAppCache = null;
}

export async function findOpencodeDesktopApp(): Promise<{ path: string; pid: number | null } | null> {
  if (desktopAppCache && Date.now() - desktopAppCache.at < 30_000) return desktopAppCache.app;
  try {
    const app = await findOpencodeDesktopAppUncached();
    desktopAppCache = { at: Date.now(), app };
    return app;
  } catch {
    // 查询失败（PowerShell 冷启动超时等）：用旧缓存兜底，别把桌面版面板打没
    if (desktopAppCache) return desktopAppCache.app;
    return null;
  }
}

async function findOpencodeDesktopAppUncached(): Promise<{ path: string; pid: number | null } | null> {
  if (process.platform === "darwin") {
    // 从进程表找主进程
    try {
      const out = (await exec("ps", ["-axo", "pid=,command="], { maxBuffer: 8 << 20 })).stdout;
      for (const line of out.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const cmd = m[2] ?? "";
        const appM = cmd.match(/^(.+\.app)\/Contents\/MacOS\/opencode\b/i);
        if (appM) return { path: appM[1], pid: Number(m[1]) };
      }
    } catch { /* fallthrough */ }
    const candidates = ["/Applications/OpenCode.app", `${homedir()}/Applications/OpenCode.app`];
    for (const p of candidates) if (existsSync(p)) return { path: p, pid: null };
  } else if (process.platform === "win32") {
    // 轻量查询：只取有窗口的 opencode 主进程（desktop GUI），避开全进程 CIM 枚举。
    // 不吞错：超时/失败向上抛，由 wrapper 用旧缓存兜底，避免面板闪没。
    const { stdout } = await exec("powershell", [
      "-NoProfile", "-Command",
      "$p = Get-Process | Where-Object { $_.Path -match 'opencode' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { [pscustomobject]@{pid=$p.Id; path=$p.Path} | ConvertTo-Json -Compress }",
    ], { maxBuffer: 4 << 20, timeout: 20000, windowsHide: true });
    const info = JSON.parse(String(stdout ?? "").trim() || "{}");
    if (info?.pid) return { path: String(info.path ?? ""), pid: Number(info.pid) };
  }
  return null;
}

/** 启动 / 停止 / 重启本机 OpenCode 桌面版应用（best-effort，跨平台） */
export async function controlOpencodeDesktop(action: "start" | "stop" | "restart"): Promise<{ ok: boolean; error?: string; path?: string }> {
  const app = await findOpencodeDesktopApp();
  if (!app) return { ok: false, error: "未找到本机 OpenCode 桌面版程序（可手动打开后再试）" };
  clearDesktopAppCache(); // 启停会改变 desktop 状态，清缓存让下次查询拿新状态
  try {
    if (process.platform === "darwin") {
      const stop = async () => {
        try {
          await exec("osascript", ["-e", 'tell application "OpenCode" to quit'], { timeout: 8000 });
        } catch {
          // 优雅退出失败则强杀主进程
          if (app.pid) await exec("kill", [String(app.pid)], { timeout: 5000 }).catch(() => {});
        }
      };
      if (action === "stop") { await stop(); return { ok: true, path: app.path }; }
      if (action === "restart") await stop();
      await new Promise((r) => setTimeout(r, 800));
      await exec("open", [app.path], { timeout: 10000 });
      return { ok: true, path: app.path };
    } else if (process.platform === "win32") {
      const stop = async () => {
        await exec("taskkill", ["/IM", "OpenCode.exe", "/F"], { timeout: 6000, windowsHide: true })
          .catch(() => exec("taskkill", ["/IM", "opencode-desktop.exe", "/F"], { timeout: 6000, windowsHide: true }))
          .catch(() => {});
      };
      if (action === "stop") { await stop(); return { ok: true, path: app.path }; }
      if (action === "restart") await stop();
      await new Promise((r) => setTimeout(r, 800));
      const child = spawn("cmd", ["/c", "start", "", app.path], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      return { ok: true, path: app.path };
    } else {
      // Linux：opencode 桌面版（Electron）不支持无头启停，仅打印路径
      return { ok: false, error: "当前平台暂不支持控制 OpenCode 桌面版" };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 把可能的整条命令行收敛成可读的进程名：opencode.exe" serve --hostname ... → opencode */
function cleanProcName(raw: string): string {
  let t = raw.trim().replace(/^"/, "").split(/["']?\s+--?/)[0]; // 去掉引号与后续参数
  t = t.replace(/["']/g, "");
  const base = t.split(/[\\/]/).pop() ?? t;
  return base.replace(/\.(exe|cmd|bat)$/i, "").slice(0, 22) || "opencode";
}

export interface DiscoveredServer {
  port: number;
  pid: number;
  proc: string;
  /** 探测/轮询该端口所需凭据（带鉴权的桌面版 server） */
  auth?: LocalServerAuth;
}

export interface LocalServerAuth {
  username: string;
  password: string;
  header: string;
}

/**
 * 从本机进程表里捡回 opencode server 的账号密码。
 *
 * 为什么需要它：OpenCode 桌面版自带的 server 是带鉴权的（/session 直接 401），
 * 而它的密码只存在于某些子进程的环境里 —— 如果 hub 不是从那个环境启动的
 * （比如 pip 装在普通终端里跑），就探测不到 "自己"，看板上就少了本机这个节点。
 * 同一用户的进程环境是可以读的，这里扫一遍捡回来（只在本进程内使用，不落盘、不外发）。
 */
let authCache: { at: number; auths: LocalServerAuth[] } | null = null;

/** 清空凭据扫描缓存（重试发现时用，避免 60s 内沿用旧密码） */
export function clearDiscoverAuthCache() {
  authCache = null;
}

export async function findLocalOpencodeAuth(): Promise<LocalServerAuth[]> {
  if (process.env.ATRIUM_DISABLE_ENV_SCAN) return []; // Windows 读不到别的进程环境，可用手填凭据替代
  if (authCache && Date.now() - authCache.at < 60_000) return authCache.auths;
  const hit = new Map<string, number>();
  // 必须逐行（= 逐进程）配对：全局 match 会把 A 进程的用户名和 B 进程的密码凑一对
  const scan = (text: string) => {
    for (const line of text.split("\n")) {
      const u = line.match(/(?:^|[\0\s])OPENCODE_SERVER_USERNAME=([^\0\s]+)/)?.[1];
      const p = line.match(/(?:^|[\0\s])OPENCODE_SERVER_PASSWORD=([^\0\s]+)/)?.[1];
      if (!u || !p) continue;
      const k = `${u}\u0000${p}`;
      hit.set(k, (hit.get(k) ?? 0) + 1);
    }
  };
  try {
    if (process.platform === "darwin") {
      let out = "";
      try {
        out = (await exec("ps", ["eww", "-A"], { maxBuffer: 32 << 20 })).stdout;
      } catch { /* ps 失败则走 asuser 兜底 */ }
      scan(out);
      // 兜底：launchd 服务进程执行 `ps eww -A` 时，可能读不到桌面 app 子进程的环境
      // （macOS 对非同源进程 env 的可见性限制）。改用 `launchctl asuser <uid> ps eww -A`
      // 以用户会话上下文再扫一次，通常能拿到桌面版注入到 worker 进程的 OPENCODE_SERVER_* 凭据。
      try {
        const uid = process.getuid?.() ?? 0;
        const alt = (await exec("launchctl", ["asuser", String(uid), "ps", "eww", "-A"], { maxBuffer: 32 << 20 })).stdout;
        if (alt && alt !== out) scan(alt);
      } catch { /* asuser 不可用则忽略 */ }
    } else if (process.platform === "linux") {
      for (const pid of readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          scan(readFileSync(`/proc/${pid}/environ`, "utf8"));
        } catch {
          /* 别人的进程读不到就算了 */
        }
      }
    }
  } catch {
    /* 扫不到就退回环境变量 */
  }
  // 兜底：直接读取本进程环境变量里的固定凭据（配合 `launchctl setenv OPENCODE_SERVER_*`）。
  // launchd 服务与 GUI 桌面进程可能分属不同 bootstrap 上下文，`ps eww` 读不到对端 env，
  // 但全局 launchctl env 会同时注入两者，这里直接读自身 env 即可稳定拿到固定密码。
  const ownU = process.env.OPENCODE_SERVER_USERNAME;
  const ownP = process.env.OPENCODE_SERVER_PASSWORD;
  if (ownU && ownP) {
    const k = `${ownU}\u0000${ownP}`;
    hit.set(k, Math.max(hit.get(k) ?? 0, 1000)); // 最高优先级
  }
  const auths = [...hit.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => {
      const [username, password] = k.split("\u0000");
      return {
        username,
        password,
        header: "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
      };
    });
  authCache = { at: Date.now(), auths };
  return auths;
}

/** Find 127.0.0.1 LISTEN ports owned by opencode-related processes (macOS/Linux). */
export async function findLocalOpencodePorts(): Promise<DiscoveredServer[]> {
  if (process.platform === "win32") return findWindowsOpencodePorts();
  let out = "";
  try {
    out = (await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { maxBuffer: 4 << 20 })).stdout;
  } catch {
    try {
      out = (await exec("ss", ["-ltnp"], { maxBuffer: 4 << 20 })).stdout;
    } catch {
      return [];
    }
  }
  const found = new Map<number, DiscoveredServer>();
  for (const line of out.split("\n")) {
    if (!/opencode/i.test(line)) continue;
    const proc = cleanProcName(line.trim().split(/\s+/)[0] ?? "");
    if (!/opencode/i.test(proc)) continue;
    const m = line.match(/127\.0\.0\.1:(\d+)\s*\(LISTEN\)/) ?? line.match(/127\.0\.0\.1:(\d+)/);
    if (!m) continue;
    const port = Number(m[1]);
    const pidM = line.match(/(\d+)\s+\S*(?:u|k|n)\s+IPv4/) ?? line.match(/pid=(\d+)/);
    if (!found.has(port)) found.set(port, { port, pid: Number(pidM?.[1] ?? 0), proc });
  }
  return [...found.values()];
}

/**
 * Windows：lsof/ss 都不存在，用 PowerShell 列 127.0.0.1 的监听端口 + 归属进程名。
 * 优先 Get-NetTCPConnection，取不到再用 netstat -ano 兜底。
 */
async function findWindowsOpencodePorts(): Promise<DiscoveredServer[]> {
  try {
    const { procs, ports } = await windowsSnapshot();
    const found = new Map<number, DiscoveredServer>();
    for (const wp of ports) {
      const row = procs.find((p) => p.pid === wp.pid);
      const proc = row ? argv0Base(row.args) : "";
      if (!/opencode/i.test(proc)) continue;
      if (!found.has(wp.port)) found.set(wp.port, { port: wp.port, pid: wp.pid, proc });
    }
    return [...found.values()];
  } catch {
    return [];
  }
}

/**
 * Cheap probe: GET /session must return a JSON array.
 * 区分 "ok" / "unauth"（是 opencode 但要账号密码）/ "no"，好给出准确提示。
 */
export async function probeOpencode(port: number, auth?: string): Promise<"ok" | "unauth" | "no"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      headers: auth ? { authorization: auth } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) return "unauth";
    if (!res.ok) return "no";
    const data = await res.json();
    return Array.isArray(data) ? "ok" : "no";
  } catch {
    // 桌面版 server 偶尔忙到超时：交给调用方按"连续失败若干轮"再摘除，避免"自己"一闪就没
    return "no";
  }
}
