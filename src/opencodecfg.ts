import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";

const execAsync = promisify(execFile);

/** opencode 配置目录 / 配置文件（尊重 opencode 自己的环境变量） */
export function ocConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
}
export function ocConfigPath(): string {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG;
  const jsonc = join(ocConfigDir(), "opencode.jsonc");
  if (existsSync(jsonc)) return jsonc;
  const json = join(ocConfigDir(), "opencode.json");
  if (existsSync(json)) return json;
  return jsonc; // 二者都没有时，默认用 .jsonc（opencode 常用）
}

/** 宽松去注释/尾逗号，仅用于统计 provider/model 数量（opencode 配置是 jsonc） */
function stripJsonc(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

/** 在目标机器上运行一个可执行文件（Windows 上 .cmd/.bat 需经 cmd /c 才能启动） */
function runBin(bin: string, args: string[], timeout: number): string {
  const opts = { stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"], timeout, windowsHide: true };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return execFileSync("cmd", ["/c", bin, ...args], opts).toString();
  }
  return execFileSync(bin, args, opts).toString();
}

/** 候选 opencode 可执行文件（which/where + 官方安装脚本的兜底位置） */
function candidateOpencodeBins(): string[] {
  const out: string[] = [];
  if (process.env.OPENCODE_BIN) out.push(process.env.OPENCODE_BIN);
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const raw = execFileSync(tool, ["opencode"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).toString();
    for (const line of raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) out.push(line);
  } catch { /* 没在 PATH 里 */ }
  // 官方安装脚本会把 opencode 放到 ~/.opencode/bin（Windows 为 opencode.exe / opencode.cmd）
  const binDir = join(homedir(), ".opencode", "bin");
  if (process.platform === "win32") out.push(join(binDir, "opencode.exe"), join(binDir, "opencode.cmd"));
  else out.push(join(binDir, "opencode"));
  return [...new Set(out)];
}

/** 该路径能否在本机直接执行（Windows 上无扩展名的 sh 脚本不可直接执行） */
function isRunnableBin(p: string): boolean {
  try { if (!existsSync(p)) return false; } catch { return false; }
  if (process.platform === "win32") {
    const ext = extname(p).toLowerCase();
    return ext === ".exe" || ext === ".cmd" || ext === ".bat";
  }
  return true;
}

function whichOpencode(): string | null {
  for (const p of candidateOpencodeBins()) if (isRunnableBin(p)) return p;
  return null;
}

export interface OcStatus {
  ok: boolean;
  installed: boolean;
  binPath: string | null;
  version: string | null;
  configDir: string;
  configPath: string;
  hasConfig: boolean;
  platform: string;
  arch: string;
  modelCount?: number;
  providerCount?: number;
  error?: string;
}

/** 该机器上 opencode 的安装/配置状态（供组网面板展示 + 判断是否需要安装/下发） */
export function ocStatusLocal(): OcStatus {
  const bin = whichOpencode();
  let version: string | null = null;
  if (bin) { try { version = runBin(bin, ["--version"], 8000).trim(); } catch { /* 有些版本不支持 --version */ } }
  const cp = ocConfigPath();
  let modelCount: number | undefined;
  let providerCount: number | undefined;
  if (existsSync(cp)) {
    try {
      const j = JSON.parse(stripJsonc(readFileSync(cp, "utf8")));
      const provs = j.provider ?? j.providers ?? {};
      providerCount = Object.keys(provs).length;
      modelCount = Object.values<any>(provs).reduce((a: number, p: any) => a + Object.keys(p?.models ?? {}).length, 0);
    } catch { /* 配置坏了不算致命 */ }
  }
  return { ok: true, installed: !!bin, binPath: bin, version, configDir: ocConfigDir(), configPath: cp, hasConfig: existsSync(cp), platform: process.platform, arch: process.arch, modelCount, providerCount };
}

export function ocConfigReadLocal(): { ok: boolean; path: string; content: string | null; error?: string } {
  const cp = ocConfigPath();
  try { return { ok: true, path: cp, content: existsSync(cp) ? readFileSync(cp, "utf8") : null }; }
  catch (e) { return { ok: false, path: cp, content: null, error: (e as Error).message }; }
}

/** 写 opencode 配置（jsonc/json 原样写入；宽松校验 + 备份原文件） */
export function ocConfigWriteLocal(content: string): { ok: boolean; path: string; error?: string } {
  const cp = ocConfigPath();
  const text = String(content ?? "");
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith("{")) return { ok: false, path: cp, error: "内容不像 opencode 配置（应为 JSON/JSONC 对象）" };
  try {
    mkdirSync(dirname(cp), { recursive: true });
    if (existsSync(cp)) { try { writeFileSync(cp + ".atrium.bak", readFileSync(cp, "utf8"), "utf8"); } catch { /* 备份失败不阻断 */ } }
    writeFileSync(cp, text.endsWith("\n") ? text : text + "\n", "utf8");
    return { ok: true, path: cp };
  } catch (e) { return { ok: false, path: cp, error: (e as Error).message }; }
}

/** 安装 opencode：优先 npm 全局安装（需该机器有 Node/npm），失败给出可读原因 */
export function ocInstallLocal(): { ok: boolean; method?: string; output?: string; error?: string } {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const out = runBin(npm, ["i", "-g", "opencode-ai"], 600_000);
    return { ok: true, method: "npm i -g opencode-ai", output: out.slice(-800) };
  } catch (e) {
    const msg = (e as Error).message || "";
    const hint = /ENOENT|not found/i.test(msg) ? "该机器没有 Node/npm，先装 Node 再试" : msg;
    return { ok: false, error: `npm 安装失败：${hint}` };
  }
}
/* ===== 上报钩子（AGENTS.md）/ 插件：让 opencode 自动把本机 server 密码上报给 atrium ===== */
const HOOK_START = "<!-- ATRIUM-REPORT-OPENCODE-START -->";
const HOOK_END = "<!-- ATRIUM-REPORT-OPENCODE-END -->";
function agentsMdPath(): string { return process.env.OPENCODE_CONFIG_AGENTS ?? join(ocConfigDir(), "AGENTS.md"); }
function hookText(port: number, win: boolean): string {
  const cmd = win
    ? [
        `$pw=$env:OPENCODE_SERVER_PASSWORD`,
        `if($pw){$u=if($env:OPENCODE_SERVER_USERNAME){$env:OPENCODE_SERVER_USERNAME}else{'opencode'};$body=@{username=$u;password=$pw}|ConvertTo-Json -Compress;try{Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:${port}/api/local-opencode/report' -ContentType 'application/json' -Body $body}catch{}}`,
      ].join("; ")
    : `curl -s -X POST http://127.0.0.1:${port}/api/local-opencode/report -H 'content-type: application/json' -d '{"username":"\${OPENCODE_SERVER_USERNAME:-opencode}","password":"\$OPENCODE_SERVER_PASSWORD"}'`;
  const readEnv = win ? `$env:OPENCODE_SERVER_PASSWORD` : `$OPENCODE_SERVER_PASSWORD`;
  return `${HOOK_START}
## 启动自检：上报本机 OpenCode server 凭据（atrium 注入）
每次会话开始时先执行一遍（静默、幂等，不要向用户复述细节，失败先重试一次再转报 error）：
1) 读环境变量：\`${readEnv}\`
2) 若有值，POST 上报本机 atrium（本机 shell 直接执行）：
   \`${cmd}\`
3) 返回 ok:true 即完成；否则先重试一次，仍失败才把 error 转告用户。
${HOOK_END}`;
}
export function ocHookStatusLocal(): boolean {
  const p = agentsMdPath();
  try { return existsSync(p) && readFileSync(p, "utf8").includes(HOOK_START); } catch { return false; }
}
/* 后台/常驻进程启动规范：从源头避免"子进程继承 bash 工具管道 → 工具等 EOF 永久卡住" */
const BG_START = "<!-- ATRIUM-BGPROC-START -->";
const BG_END = "<!-- ATRIUM-BGPROC-END -->";
function bgProcText(win: boolean): string {
  const examples = win
    ? `- Windows(PowerShell)：用后台 Job，或 WMI 创建，并**显式把输出重定向到文件**（不要让子进程继承当前管道）：
  \`Start-Job { Set-Location 'D:\\proj'; cmd /c 'npm run dev' *> 'D:\\proj\\.dev.log' }\`
  或
  \`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine='cmd /c npm run dev > C:\\temp\\dev.log 2>&1'; CurrentDirectory='D:\\proj' }\`
  **不要**用 \`Start-Process … -RedirectStandardOutput/Error -PassThru\` 起常驻服务：子孙进程会持有管道，导致工具卡死。`
    : `- macOS/Linux：重定向全部 fd 再后台并脱离父进程：
  \`nohup env PORT=5000 npm run dev </dev/null >dev.log 2>&1 & disown\``;
  return `${BG_START}
## 后台/常驻进程启动规范（atrium 注入，务必遵守）
启动常驻服务（dev server / watch / 端口监听等）时，**绝不能让子进程继承当前 shell 的 stdout/stderr 管道**——否则 opencode 的 bash 工具会一直等管道 EOF 而永久卡住（命令其实早已执行完毕，却把整个会话队列堵死）。
安全写法：
${examples}
- 启动后确认真起来了用「等一下再看日志」（如 \`sleep 2; tail -n 20 dev.log\` / \`Get-Content .dev.log -Tail 20\`），**不要**让命令一直挂在前台等输出。
- 工具输出里不要残留常驻进程的句柄；日志写文件，需要时再读文件。
${BG_END}`;
}
export function ocHookLocal(enabled: boolean, port: number): { ok: boolean; enabled: boolean; error?: string } {
  const p = agentsMdPath();
  const win = process.platform === "win32";
  try {
    let cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    // 先移除两个受管块（报告钩子 + 后台进程规范），保证幂等
    for (const [s0, e0] of [[HOOK_START, HOOK_END], [BG_START, BG_END]] as const) {
      const s = cur.indexOf(s0), e = cur.indexOf(e0);
      if (s >= 0 && e >= 0) cur = cur.slice(0, s) + cur.slice(e + e0.length);
    }
    cur = cur.replace(/\n{3,}/g, "\n\n").trim();
    if (enabled) {
      const add = `${hookText(port, win)}\n\n${bgProcText(win)}`;
      cur = cur ? `${cur}\n\n${add}\n` : `${add}\n`;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, cur + (cur.endsWith("\n") ? "" : "\n"), "utf8");
    return { ok: true, enabled };
  } catch (e) { return { ok: false, enabled: false, error: (e as Error).message }; }
}

function pluginDir(): string { return join(ocConfigDir(), "plugins"); }
function pluginPath(): string { return join(pluginDir(), "atrium-report.js"); }
function pluginContent(port: number): string {
  return [
    "// atrium-report：opencode server 启动时把本机 OpenCode 密码上报给 atrium（稳定触发）",
    "// 由 atrium 自动生成；卸载用 `atrium init-opencode-plugin --disable`",
    "export default async () => {",
    "  const password = process.env.OPENCODE_SERVER_PASSWORD;",
    "  const username = process.env.OPENCODE_SERVER_USERNAME || \"opencode\";",
    "  if (password) {",
    "    const url = \"http://127.0.0.1:" + port + "/api/local-opencode/report\";",
    "    const body = JSON.stringify({ username, password });",
    "    const send = () => fetch(url, { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body }).then((r) => r.ok).catch(() => false);",
    "    if (!(await send())) { await new Promise((r) => setTimeout(r, 1500)); await send(); }",
    "  }",
    "  return {};",
    "};",
    "",
  ].join("\n");
}
export function ocPluginStatusLocal(): boolean { try { return existsSync(pluginPath()); } catch { return false; } }
export function ocPluginLocal(enabled: boolean, port: number): { ok: boolean; enabled: boolean; path: string; error?: string } {
  try {
    if (enabled) { mkdirSync(pluginDir(), { recursive: true }); writeFileSync(pluginPath(), pluginContent(port), "utf8"); }
    else if (existsSync(pluginPath())) unlinkSync(pluginPath());
    return { ok: true, enabled, path: pluginPath() };
  } catch (e) { return { ok: false, enabled: false, path: pluginPath(), error: (e as Error).message }; }
}

/* ===== 固定 opencode server 密码：写到 shell profile + launchctl setenv，让所有 server 实例复用 ===== */
const PW_MARKER_START = "# >>> atrium fixed opencode password >>>";
const PW_MARKER_END = "# <<< atrium fixed opencode password <<<";

function shellProfilePath(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("zsh")) return join(homedir(), ".zshrc");
  if (shell.endsWith("bash")) return join(homedir(), ".bashrc");
  return join(homedir(), ".zshrc"); // 默认 zsh（macOS）
}

export function ocFixedPwStatusLocal(): { fixed: boolean; password?: string; profilePath: string } {
  if (process.platform === "win32") {
    // Windows：固定密码存在用户级环境变量（HKCU\Environment）
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "OPENCODE_SERVER_PASSWORD"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000, windowsHide: true }).toString();
      const m = out.match(/OPENCODE_SERVER_PASSWORD\s+REG_SZ\s+(\S+)/);
      if (m?.[1]) return { fixed: true, password: m[1], profilePath: "HKCU\\Environment（用户级环境变量）" };
    } catch { /* 没设过 */ }
    return { fixed: false, profilePath: "HKCU\\Environment（用户级环境变量）" };
  }
  const p = shellProfilePath();
  try {
    if (!existsSync(p)) return { fixed: false, profilePath: p };
    const content = readFileSync(p, "utf8");
    const s = content.indexOf(PW_MARKER_START);
    const e = content.indexOf(PW_MARKER_END);
    if (s < 0 || e < 0) return { fixed: false, profilePath: p };
    const block = content.slice(s, e);
    const m = block.match(/OPENCODE_SERVER_PASSWORD=(\S+)/);
    return { fixed: true, password: m?.[1] ?? "", profilePath: p };
  } catch { return { fixed: false, profilePath: p }; }
}

export function ocSetFixedPwLocal(password: string): { ok: boolean; password: string; profilePath: string; error?: string } {
  const pw = password.trim();
  if (process.platform === "win32") {
    // Windows：setx 写用户级环境变量（HKCU\Environment），GUI 启动的桌面版重启后继承，
    // 之后所有 opencode server 实例（desktop/CLI/web）都用同一个密码，atrium 自动纳入
    try {
      execFileSync("setx", ["OPENCODE_SERVER_PASSWORD", pw], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000, windowsHide: true });
      execFileSync("setx", ["OPENCODE_SERVER_USERNAME", "opencode"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000, windowsHide: true });
      return { ok: true, password: pw, profilePath: "HKCU\\Environment（用户级环境变量，重启桌面版后生效）" };
    } catch (e) { return { ok: false, password: pw, profilePath: "HKCU\\Environment", error: (e as Error).message }; }
  }
  const p = shellProfilePath();
  try {
    let cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    // 先移除旧块
    const s = cur.indexOf(PW_MARKER_START), e = cur.indexOf(PW_MARKER_END);
    if (s >= 0 && e >= 0) cur = cur.slice(0, s) + cur.slice(e + PW_MARKER_END.length);
    cur = cur.replace(/\n{3,}/g, "\n\n").trim();
    // 追加新块
    const block = `${PW_MARKER_START}\nexport OPENCODE_SERVER_PASSWORD=${pw}\nexport OPENCODE_SERVER_USERNAME=opencode\n${PW_MARKER_END}`;
    cur = cur ? `${cur}\n\n${block}\n` : `${block}\n`;
    writeFileSync(p, cur, "utf8");
    // macOS：launchctl setenv 让 GUI 启动的桌面版也能读到（Linux 忽略）
    if (process.platform === "darwin") {
      try { execFileSync("launchctl", ["setenv", "OPENCODE_SERVER_PASSWORD", pw], { timeout: 5000 }); } catch { /* 不阻断 */ }
      try { execFileSync("launchctl", ["setenv", "OPENCODE_SERVER_USERNAME", "opencode"], { timeout: 5000 }); } catch { /* 不阻断 */ }
    }
    return { ok: true, password: pw, profilePath: p };
  } catch (e) { return { ok: false, password: pw, profilePath: p, error: (e as Error).message }; }
}

export function ocClearFixedPwLocal(): { ok: boolean; profilePath: string; error?: string } {
  if (process.platform === "win32") {
    try {
      try { execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "OPENCODE_SERVER_PASSWORD", "/f"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000, windowsHide: true }); } catch { /* 本来就没有 */ }
      try { execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "OPENCODE_SERVER_USERNAME", "/f"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000, windowsHide: true }); } catch { /* 本来就没有 */ }
      return { ok: true, profilePath: "HKCU\\Environment（用户级环境变量，重启桌面版后生效）" };
    } catch (e) { return { ok: false, profilePath: "HKCU\\Environment", error: (e as Error).message }; }
  }
  const p = shellProfilePath();
  try {
    if (!existsSync(p)) return { ok: true, profilePath: p };
    let cur = readFileSync(p, "utf8");
    const s = cur.indexOf(PW_MARKER_START), e = cur.indexOf(PW_MARKER_END);
    if (s >= 0 && e >= 0) cur = cur.slice(0, s) + cur.slice(e + PW_MARKER_END.length);
    cur = cur.replace(/\n{3,}/g, "\n\n").trim();
    writeFileSync(p, cur + "\n", "utf8");
    if (process.platform === "darwin") {
      try { execFileSync("launchctl", ["unsetenv", "OPENCODE_SERVER_PASSWORD"], { timeout: 5000 }); } catch { /* ignore */ }
    }
    return { ok: true, profilePath: p };
  } catch (e) { return { ok: false, profilePath: p, error: (e as Error).message }; }
}

/* ===== 启动 opencode server（CLI serve / web）：完全脱离父进程，不继承管道（避免卡死） ===== */
export function ocServeLocal(port: number | null, web: boolean): { ok: boolean; pid?: number; port?: number; error?: string } {
  const bin = whichOpencode();
  if (!bin) return { ok: false, error: "opencode 未安装（先「一键初始化」或 npm i -g opencode-ai）" };
  const args = web ? ["web"] : ["serve"];
  if (port && port > 0) args.push("--port", String(port));
  // 关键：把固定密码显式带进子进程 env（atrium 自己的 env 可能没有）——否则新 server 会用随机密码
  const env: NodeJS.ProcessEnv = { ...process.env };
  const fp = ocFixedPwStatusLocal();
  const pw = (fp.fixed && fp.password) || process.env.OPENCODE_SERVER_PASSWORD;
  if (pw) { env.OPENCODE_SERVER_PASSWORD = pw; env.OPENCODE_SERVER_USERNAME = env.OPENCODE_SERVER_USERNAME || "opencode"; }
  try {
    // detached + stdio:ignore → 子进程完全脱离父进程，不继承 stdout/stderr 管道 → 不会卡死
    // Windows 上 .cmd/.bat（npm shim）不能被 node 直接 spawn（EINVAL），须经 cmd /c 启动
    const isWinScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const child = isWinScript
      ? spawn("cmd", ["/c", bin, ...args], { detached: true, stdio: "ignore", cwd: homedir(), env, windowsHide: true })
      : spawn(bin, args, { detached: true, stdio: "ignore", cwd: homedir(), env });
    child.unref();
    return { ok: true, pid: child.pid, port: port ?? undefined };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface OcServer { port: number; pid: number; kind: "serve" | "web" | "desktop" | "server"; cmd: string; running: true; }

function kindOf(cmd: string): OcServer["kind"] {
  if (/@opencode-aidesktop|OpenCode\.app|opencode-desktop|OpenCode Helper/i.test(cmd)) return "desktop";
  // Windows tasklist 只有进程名：桌面版是 OpenCode.exe（大写驼峰），CLI 是 opencode.exe（全小写）。
  // 此正则故意不加 i 标志，靠大小写区分 desktop 与 CLI。
  if (/OpenCode\.exe/.test(cmd)) return "desktop";
  if (/\bweb\b/.test(cmd)) return "web";
  if (/\bserve\b/.test(cmd)) return "serve";
  return "server";
}

/** 列出本机在跑的 opencode server（监听端口 + pid + 类型） */

/** 30s 缓存：Windows 上枚举端口+命令行要数秒，组网页面每次打开都调，不能每次现查 */
let serveListCache: { at: number; data: { ok: boolean; servers: OcServer[] } } | null = null;
const SERVE_LIST_TTL = 30_000;

export async function ocServeListLocal(): Promise<{ ok: boolean; servers: OcServer[] }> {
  if (serveListCache && Date.now() - serveListCache.at < SERVE_LIST_TTL) return serveListCache.data;
  const servers: OcServer[] = [];
  const seen = new Set<number>();
  try {
    if (process.platform === "win32") {
      // 轻量两步：先 Get-Process 筛 opencode 进程（快），再逐个查命令行 + 监听端口。
      // 之前 netstat + 逐端口 tasklist 拖到 20s+；WMI 多 OR filter 拼接又易丢空格失效。
      try {
        const ps = [
          "$listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique",
          "$ops = Get-Process | Where-Object { $_.Path -and $_.Path -match 'opencode' -and $listen -contains $_.Id }",
          "foreach ($p in $ops) {",
          "  $c = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.Id)\" -ErrorAction SilentlyContinue",
          "  $cmd = $c.CommandLine",
          "  if (-not $cmd) { $cmd = $p.Path }",
          "  $ls = Get-NetTCPConnection -State Listen -OwningProcess $p.Id -ErrorAction SilentlyContinue",
          "  foreach ($l in $ls) {",
          "    ('{0}|{1}|{2}' -f $l.LocalPort, $p.Id, $cmd)",
          "  }",
          "}",
        ].join("; ");
        // await 异步执行：execFileSync 会同步阻塞 hub 事件循环 6-20s，期间所有节点轮询超时、集体 stale（看起来像服务集体消失）
        const out = (await execAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000, windowsHide: true, maxBuffer: 8 << 20 })).toString();
        for (const line of out.split(/\r?\n/)) {
          const parts = line.trim().split("|");
          if (parts.length < 3) continue;
          const port = Number(parts[0]); const pid = Number(parts[1]);
          const cmd = parts.slice(2).join("|");
          if (!port || !pid || !cmd || seen.has(port)) continue;
          seen.add(port);
          servers.push({ port, pid, kind: kindOf(cmd), cmd: cmd.slice(0, 120), running: true });
        }
      } catch (e) { throw e; /* 超时等失败向上抛，外层用旧缓存兜底，别把列表清空 */ }
    } else {
      let out = "";
      try { out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).toString(); }
      catch { return { ok: true, servers }; }
      for (const line of out.split("\n")) {
        if (!/opencode/i.test(line)) continue;
        const m = line.match(/127\.0\.0\.1:(\d+)\s*\(LISTEN\)/);
        if (!m) continue;
        const port = Number(m[1]);
        if (!port || seen.has(port)) continue;
        const cols = line.trim().split(/\s+/);
        let cmd = "";
        try { cmd = execFileSync("ps", ["-o", "command=", "-p", cols[1]], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim(); } catch { /* ignore */ }
        seen.add(port); servers.push({ port, pid: Number(cols[1]) || 0, kind: kindOf(cmd || cols[0] || ""), cmd: (cmd || cols[0] || "").slice(0, 120), running: true });
      }
    }
  } catch {
    // 查询失败（PowerShell 超时等）：用旧缓存兜底，别把服务列表清空
    if (serveListCache) return serveListCache.data;
  }
  servers.sort((a, b) => a.port - b.port);
  const data = { ok: true, servers };
  serveListCache = { at: Date.now(), data };
  return data;
}

/** 停止监听某端口上的 opencode server（只允许停非桌面版：CLI serve / web） */
export async function ocServeStopLocal(port: number): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const list = (await ocServeListLocal()).servers;
  const s = list.find((x) => x.port === port);
  if (!s) return { ok: false, error: `端口 ${port} 上没有找到在跑的 opencode server` };
  if (s.kind === "desktop") return { ok: false, error: "桌面版的 server 请用上方「重启并抓取密码」控制，不在此处停止" };
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(s.pid), "/T", "/F"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    } else {
      execFileSync("kill", [String(s.pid)], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
    }
    serveListCache = null; // 停止后清缓存，下次列表拿新状态
    return { ok: true, pid: s.pid };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
