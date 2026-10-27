import { cpus, totalmem, freemem, loadavg, hostname, platform } from "node:os";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import type { HostMetrics } from "./types.ts";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 本机负载采集器：
 * - CPU 使用率：os.cpus() 累计 tick 做差值（两次采样间的平均），跨平台、无子进程。
 * - 内存「已用」：os.freemem() 在 macOS 上会把可回收的缓存/压缩内存算成已用（常年 99%，失真），
 *   所以按平台取「真实可用」：
 *     · macOS  → memory_pressure 的官方空闲百分比（一次性命令，~8ms）
 *     · Linux  → /proc/meminfo 的 MemAvailable
 *     · Windows/其它 → os.freemem()（其 free 本身即物理可用，准确）
 *   子进程/文件读失败时回退到 os.freemem()，绝不抛错。
 *
 * 每个 atrium 实例只采「自己所在机器」；跨机负载由 peer 合并快照得到，目标机无需额外装 agent。
 */
export class HostMonitor {
  private prev: { idle: number; total: number } | null = null;
  private last: HostMetrics | null = null;

  constructor(private machine: string, private label?: string) {
    // 立即给一个同步基线（内存先用 freemem 兜底），随后异步精修，避免首帧 host 为空
    this.prev = this.cpuTimes();
    const memTotal = totalmem();
    const memUsed = Math.max(0, memTotal - freemem());
    const la = loadavg();
    this.last = {
      machine: this.machine,
      label: this.label,
      hostname: hostname(),
      platform: platform(),
      cpuCount: cpus().length,
      cpuPct: 0,
      loadavg: [round2(la[0] ?? 0), round2(la[1] ?? 0), round2(la[2] ?? 0)],
      memTotal,
      memUsed,
      memPct: memTotal > 0 ? round1((memUsed / memTotal) * 100) : 0,
      at: Date.now(),
    };
    void this.sample();
  }

  setLabel(label: string) {
    this.label = label;
    if (this.last) this.last = { ...this.last, label };
  }

  private cpuTimes(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  }

  private cpuPctSincePrev(): number {
    const cur = this.cpuTimes();
    let pct = 0;
    if (this.prev) {
      const idleD = cur.idle - this.prev.idle;
      const totalD = cur.total - this.prev.total;
      if (totalD > 0) pct = (1 - idleD / totalD) * 100;
    }
    this.prev = cur;
    return Math.max(0, Math.min(100, pct));
  }

  /** macOS：memory_pressure 的系统空闲百分比（0-100）；失败返回 null */
  private macFreePct(): Promise<number | null> {
    return new Promise((resolve) => {
      execFile("memory_pressure", [], { timeout: 3000 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const m = /free percentage:\s*(\d+)\s*%/i.exec(stdout ?? "");
        resolve(m ? Math.max(0, Math.min(100, Number(m[1]))) : null);
      });
    });
  }

  /** Linux：/proc/meminfo 的 MemAvailable（字节）；失败返回 null */
  private linuxMemAvailable(): number | null {
    try {
      const txt = readFileSync("/proc/meminfo", "utf8");
      const m = /MemAvailable:\s+(\d+)\s*kB/i.exec(txt);
      return m ? Number(m[1]) * 1024 : null;
    } catch {
      return null;
    }
  }

  /** 平台相关的「真实已用内存」（字节）；拿不到则回退 os.freemem 口径 */
  private async usedMem(memTotal: number): Promise<number> {
    const fallback = Math.max(0, memTotal - freemem());
    try {
      if (process.platform === "linux") {
        const avail = this.linuxMemAvailable();
        if (avail != null) return Math.max(0, Math.min(memTotal, memTotal - avail));
      } else if (process.platform === "darwin") {
        const freePct = await this.macFreePct();
        if (freePct != null) return Math.round(memTotal * (1 - freePct / 100));
      }
    } catch {
      /* 回退 */
    }
    return fallback;
  }

  /** 采一次样（CPU/负载同步，内存按平台异步精修）。并发调用时内存精修只跑一份。 */
  async sample(): Promise<HostMetrics> {
    const cpuPct = this.cpuPctSincePrev();
    const la = loadavg();
    const memTotal = totalmem();
    const memUsed = await this.usedMem(memTotal);
    const next: HostMetrics = {
      machine: this.machine,
      label: this.label,
      hostname: hostname(),
      platform: platform(),
      cpuCount: cpus().length,
      cpuPct: round1(cpuPct),
      loadavg: [round2(la[0] ?? 0), round2(la[1] ?? 0), round2(la[2] ?? 0)],
      memTotal,
      memUsed,
      memPct: memTotal > 0 ? round1((memUsed / memTotal) * 100) : 0,
      at: Date.now(),
    };
    this.last = next;
    return next;
  }

  get current(): HostMetrics | null {
    return this.last;
  }
}
