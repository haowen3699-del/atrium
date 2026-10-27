import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = process.cwd();
const WIN_FILE = join(ROOT, "remote-sidecar.mjs");
const PY_DIST = join(ROOT, "opencode_fleet_sidecar", "dist");
const PYPI_INDEX = (process.env.ATRIUM_PYPI_INDEX?.trim().replace(/\/+$/, "")) || "https://pypi.org/simple";

export interface SidecarTargetView {
  id: string;
  /** pypi = pip 安装的跨平台 Python 包；node = 免 Python 的 Node 单文件备选 */
  kind: "pypi" | "node";
  name: string;
  desc: string;
  version: string;
  size: number;
  downloadUrl: string;
  indexUrl?: string;
  entry?: string;
}

function pyWheel(): string | null {
  try {
    const wheels = readdirSync(PY_DIST).filter((f) => f.endsWith(".whl")).sort();
    return wheels.length ? join(PY_DIST, wheels[wheels.length - 1]) : null;
  } catch {
    return null;
  }
}

function tsVersion(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`;
}

export function sidecarTargets(): SidecarTargetView[] {
  const out: SidecarTargetView[] = [];
  // Python 包是 OS Independent 的：Windows / macOS / Linux 都用同一个包（内网 pypi），
  // 服务端已内置 Windows 进程枚举（PowerShell，wmic 兜底），不需要再单独发 Node 版本。
  const whl = pyWheel();
  if (whl) {
    const st = statSync(whl);
    const ver = basename(whl).match(/-(\d+\.\d+\.\d+)-/)?.[1] ?? "?";
    out.push({
      id: "py",
      kind: "pypi",
      name: "Windows / macOS / Linux · Python 包",
      desc: "opencode-fleet-sidecar — 内网 pypi 安装；Windows 下自动用 PowerShell 枚举 cc-connect / opencode 进程，装完用 oc-sidecar 启动",
      version: ver,
      size: st.size,
      downloadUrl: "/api/sidecar/download?target=py",
      indexUrl: PYPI_INDEX,
      entry: "oc-sidecar",
    });
  }
  // 目标机没有 Python 时的备选：Node 单文件（仅 Windows，依赖 wmic/PowerShell）
  if (existsSync(WIN_FILE)) {
    const st = statSync(WIN_FILE);
    out.push({
      id: "node",
      kind: "node",
      name: "Windows · Node 单文件（备选）",
      desc: "remote-sidecar.mjs — 目标机没有 Python 环境时用；只需有 Node，无需安装依赖，node 直跑",
      version: tsVersion(st.mtime),
      size: st.size,
      downloadUrl: "/api/sidecar/download?target=node",
    });
  }
  return out;
}

export function sidecarFilePath(target: string): string | null {
  // "win" 兼容旧页面留下的链接：Windows 现在走 pypi 包
  if (target === "py" || target === "pip" || target === "win") return pyWheel();
  if (target === "node" || target === "mjs") return existsSync(WIN_FILE) ? WIN_FILE : null;
  return null;
}
