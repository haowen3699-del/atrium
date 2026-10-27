import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** 内置默认 PyPI 简单索引（包与版本都以它为准） */
export const DEFAULT_PYPI_INDEX = "https://pypi.org/simple";
/** 兼容旧引用 */
export const PYPI_INDEX = DEFAULT_PYPI_INDEX;
export const PKG = "opencode-fleet-atrium";

/**
 * 解析实际使用的升级源，优先级：环境变量 ATRIUM_PYPI_INDEX > 配置 pypiIndex > 内置默认。
 * 配置可指向自建/镜像源，实现自定义升级。
 */
export function resolvePypiIndex(configured?: string | null): string {
  const env = process.env.ATRIUM_PYPI_INDEX?.trim();
  if (env) return env.replace(/\/+$/, "");
  const c = (configured ?? "").trim();
  if (c) return c.replace(/\/+$/, "");
  return DEFAULT_PYPI_INDEX;
}

export interface UpgradeState {
  from: string;
  to: string;
  startedAt: number;
  phase: "installing" | "ok" | "failed";
  finishedAt?: number;
  note?: string;
}

export function upgradeStatePath(home: string): string {
  return join(home, "upgrade-state.json");
}

export function writeUpgradeState(home: string, st: UpgradeState) {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(upgradeStatePath(home), JSON.stringify(st, null, 2), "utf8");
  } catch {
    /* 写不进去就算了 */
  }
}

export function readUpgradeState(home: string): UpgradeState | null {
  try {
    return JSON.parse(readFileSync(upgradeStatePath(home), "utf8")) as UpgradeState;
  } catch {
    return null;
  }
}

/**
 * 对账：上次升级到底成没成。
 * 依据是"当前跑的版本 == 目标版本"，所以即使重启到了别的端口，只要版本对就是成功；
 * 超过 5 分钟还没对上就判定失败（并带上日志尾部，界面能直接给原因）。
 */
export function reconcileUpgrade(home: string, currentVersion: string): UpgradeState | null {
  const st = readUpgradeState(home);
  if (!st || st.phase !== "installing") return st;
  if (cmpVersion(currentVersion, st.to) >= 0) {
    const ok: UpgradeState = { ...st, phase: "ok", finishedAt: Date.now() };
    writeUpgradeState(home, ok);
    return ok;
  }
  if (Date.now() - st.startedAt > 5 * 60_000) {
    let tail = "";
    try {
      const log = readFileSync(join(home, "logs", "upgrade.log"), "utf8");
      tail = log.trim().split("\n").slice(-4).join(" / ").slice(0, 400);
    } catch {
      /* 没日志 */
    }
    const bad: UpgradeState = { ...st, phase: "failed", finishedAt: Date.now(), note: tail || "升级脚本未完成（看 logs/upgrade.log）" };
    writeUpgradeState(home, bad);
    return bad;
  }
  return st; // 仍在进行
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

let cache: { at: number; latest: string | null; error?: string; index?: string } | null = null;

/** 升级源改动后清掉版本缓存，让下次检查立即用新源 */
export function clearUpdateCache() {
  cache = null;
}

/** 查索引上的最新版本（缓存 10 分钟，按源隔离）；失败时返回 error，界面照常可用 */
export async function latestVersion(force = false, index = DEFAULT_PYPI_INDEX): Promise<{ latest: string | null; error?: string }> {
  if (!force && cache && cache.index === index && Date.now() - cache.at < 10 * 60_000) return cache;
  try {
    const res = await fetch(`${index}/${PKG}/`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`索引返回 ${res.status}`);
    const html = await res.text();
    const vers = [...html.matchAll(/opencode_fleet_atrium-(\d+\.\d+\.\d+)[-.]/g)].map((m) => m[1]);
    const latest = vers.sort(cmpVersion).pop() ?? null;
    cache = latest ? { at: Date.now(), latest, index } : { at: Date.now(), latest: null, error: "索引里没解析到版本", index };
  } catch (e) {
    cache = { at: Date.now(), latest: null, error: (e as Error).message, index };
  }
  return cache;
}

/**
 * 查真的自启作业（不依赖我们自己的状态文件：用户可能是用旧版本开的自启）。
 * launchd 的 job、systemd 的 unit、Windows 的 Run 值都算。
 */
export function detectAutostart(): { enabled: boolean; kind: "launchd" | "systemd" | "registry" | ""; where?: string } {
  if (platform() === "darwin") {
    const p = join(homedir(), "Library", "LaunchAgents", "ai.atrium.agent.plist");
    return existsSync(p) ? { enabled: true, kind: "launchd", where: p } : { enabled: false, kind: "" };
  }
  if (platform() === "win32") {
    try {
      const out = execFileSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Atrium"],
        { encoding: "utf8", windowsHide: true },
      );
      return out.includes("Atrium") ? { enabled: true, kind: "registry" } : { enabled: false, kind: "" };
    } catch {
      return { enabled: false, kind: "" };
    }
  }
  const u = join(homedir(), ".config", "systemd", "user", "atrium.service");
  return existsSync(u) ? { enabled: true, kind: "systemd", where: u } : { enabled: false, kind: "" };
}

export interface UpgradeOpts {
  /** 当前安装用的 python（pip 与 -m atrium 都用它） */
  python: string;
  /** 当前版本 */
  version: string;
  /** 目标版本 */
  to: string;
  port: number;
  home: string;
  /** 是否由开机自启托管（托管时让 launchd/systemd 重新拉起，而不是自己 nohup 一个） */
  autostart: { enabled: boolean; kind?: string };
  /** 升级源（pip --index-url），默认内置源 */
  index?: string;
}

const sh = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 生成并后台执行升级脚本。
 *
 * 为什么不在进程内直接 pip install：升级要替换正在使用的包（Windows 上 node.exe 还会被占用），
 * 所以让当前进程先退出、由独立脚本装完再拉起新版本。脚本日志写 ~/.atrium/logs/upgrade.log。
 */
export function runUpgrade(o: UpgradeOpts): { script: string; log: string } {
  const logDir = join(o.home, "logs");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, "upgrade.log");
  const index = o.index ?? DEFAULT_PYPI_INDEX;
  const pipArgs = `-m pip install -U ${PKG} --index-url ${sh(index)}`;
  const restartArgs = `--no-open --port ${o.port} --home ${sh(o.home)}`;

  if (process.platform === "win32") {
    // Windows：用 PowerShell 写升级脚本（比 cmd 好写太多，也避开 timeout 需要控制台的问题）
    // 流程：等旧进程退出 → pip（退避重试，旧进程可能还占着 node.exe）→ 拉起新版本 → 确认端口起来
    const script = join(o.home, "upgrade.ps1");
    const stateFile = upgradeStatePath(o.home);
    const py = o.python;
    const pyw = /pythonw?\.exe$/i.test(py) ? py.replace(/python\.exe$/i, "pythonw.exe") : py;
    const ps = [
      "$ErrorActionPreference = 'Continue'",
      `$log = "${log}"`,
      `$state = "${stateFile}"`,
      `$port = ${o.port}`,
      `$py = "${py}"`,
      `$pyw = "${pyw}"`,
      `$atriumHome = "${o.home}"`,
      "function Log($m) { ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m) | Add-Content -Encoding UTF8 $log }",
      "function State($phase, $note) {",
      "  $ms = [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds)",
      `  $o = [ordered]@{ from = "${o.version}"; to = "${o.to}"; startedAt = [int64]${Date.now()}; phase = $phase; finishedAt = $ms; note = $note }`,
      "  [System.IO.File]::WriteAllText($state, ($o | ConvertTo-Json -Compress))",
      "}",
      "function PortUp {",
      "  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ('http://127.0.0.1:' + $port + '/api/node-info'); return ($r.StatusCode -eq 200) } catch { return $false }",
      "}",
      `Log ("upgrading ${PKG} from ${o.version} to ${o.to}")`,
      'State "installing" "等待旧进程退出"',
      "for ($i = 0; $i -lt 30 -and (PortUp); $i++) { Start-Sleep -Seconds 1 }",
      '$ok = $false',
      "for ($try = 1; $try -le 3 -and -not $ok; $try++) {",
      `  Log ("pip attempt " + $try)`,
      `  & $py -m pip install -U ${PKG} --index-url "${index}" *>&1 | Add-Content -Encoding UTF8 $log`,
      "  if ($LASTEXITCODE -eq 0) { $ok = $true } else { Log ('pip failed rc=' + $LASTEXITCODE + '，5 秒后重试'); Start-Sleep -Seconds 5 }",
      "}",
      `if (-not $ok) { State "failed" ("pip 失败（详见 " + $log + "）"); exit 1 }`,
      'Log "pip ok"',
      'State "installing" "重启中"',
      `Start-Process -FilePath $pyw -ArgumentList ('-m atrium --no-open --port ' + $port + ' --home "' + $atriumHome + '"') -WindowStyle Hidden`,
      "for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 2; if (PortUp) { State 'ok' '重启后恢复'; exit 0 } }",
      `State 'failed' ('升级完成但服务未恢复（详见 ' + $log + '）')`,
      "",
    ].join("\r\n");
    writeFileSync(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ps, "utf8")]));
    const child = spawn("cmd", ["/c", "start", "/b", "", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { script, log };
  }

  const script = join(o.home, "upgrade.sh");
  const stateFile = upgradeStatePath(o.home);
  const mark = (phase: string, note: string) =>
    `printf '{"from":"${o.version}","to":"${o.to}","startedAt":${Date.now()},"phase":"${phase}","finishedAt":%s,"note":"%s"}' "$(date +%s)000" "${note}" > "${stateFile}.tmp" && mv "${stateFile}.tmp" "${stateFile}"`;
  const portUpFn = [
    `port_up() {`,
    `  if command -v curl >/dev/null 2>&1; then curl -s -m 2 -o /dev/null "http://127.0.0.1:${o.port}/api/node-info"; return $?; fi`,
    `  if command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 ${o.port} >/dev/null 2>&1; return $?; fi`,
    `  return 1`,
    `}`,
  ].join("\n");
  const supervisorRestart =
    o.autostart.enabled && o.autostart.kind === "systemd"
      ? `systemctl --user restart atrium.service`
      : o.autostart.enabled && o.autostart.kind === "launchd"
        ? `launchctl kickstart -k gui/$(id -u)/ai.atrium.agent`
        : `:`; // 无 supervisor：下面直接兜底拉起
  const waitLoop = (n: number, label: string) =>
    [
      `i=0`,
      `while [ $i -lt ${n} ]; do`,
      `  if port_up; then`,
      `    echo "[$(date)] ${label}（端口已响应）" >> "${log}"`,
      `    ${mark("ok", label)}`,
      `    exit 0`,
      `  fi`,
      `  sleep 2; i=$((i+1))`,
      `done`,
    ].join("\n");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "sleep 2",
      `echo "[$(date)] upgrading ${PKG} from ${o.version} to ${o.to}" >> "${log}"`,
      `${mark("installing", "pip 安装中")} >/dev/null 2>&1 || true`,
      `${sh(o.python)} ${pipArgs} >> "${log}" 2>&1`,
      "rc=$?",
      `echo "[$(date)] pip exit=$rc" >> "${log}"`,
      `if [ "$rc" -ne 0 ]; then ${mark("failed", "pip 退出码 $rc")}; exit 1; fi`,
      portUpFn,
      "# 1) 有的 supervisor/自启配置会自己把服务拉起来，先等一小会儿",
      waitLoop(3, "服务已自动恢复"),
      "# 1.5) 等首选端口空出来，否则新实例会被迫漂到下一个端口",
      "j=0",
      "while [ $j -lt 20 ]; do",
      "  if ! port_up; then break; fi",
      "  j=$((j+1)); sleep 1",
      "done",
      "# 2) 让 supervisor 重启（launchd 用 -k 保证单实例重启）",
      `echo "[$(date)] 触发 supervisor 重启（${o.autostart.kind || "none"}）" >> "${log}"`,
      `${supervisorRestart} >> "${log}" 2>&1 || true`,
      waitLoop(25, "supervisor 重启后恢复"),
      "# 3) 还没起来 → 自己拉起（保证服务一定回来）",
      `echo "[$(date)] 兜底：直接拉起新版本" >> "${log}"`,
      `nohup ${sh(o.python)} -m atrium ${restartArgs} >> "${log}" 2>&1 &`,
      waitLoop(15, "兜底拉起后恢复"),
      `echo "[$(date)] 升级后服务仍未恢复，请查看 ${log}" >> "${log}"`,
      `${mark("failed", "升级完成但服务未恢复，见 upgrade.log")}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
  child.unref();
  return { script, log };
}