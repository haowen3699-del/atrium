import { networkInterfaces } from "node:os";

/**
 * 跨网段自动扫描：UDP 广播过不了路由器（不同 /24 的机器互相发现不了），
 * 所以按网段做「单播」探测——挨个 IP/端口问一句 /api/node-info，是 atrium 就收下。
 * 单播能过路由器，因此能覆盖自动发现够不到的网段。
 */

export interface ScannedPeer {
  id: string;
  host: string;
  port: number;
  label: string;
  version: string;
}

function ipToNum(ip: string): number {
  return ip.split(".").reduce((a, o) => ((a << 8) >>> 0) + (Number(o) & 255), 0) >>> 0;
}

function numToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** CIDR → 主机 IP 列表（跳过网络/广播地址；limit 兜底避免误扫大网段） */
export function expandCidr(cidr: string, limit = 1024): string[] {
  const m = String(cidr).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return [];
  const octs = [m[1], m[2], m[3], m[4]].map(Number);
  if (octs.some((o) => o > 255)) return [];
  const bits = m[5] ? Number(m[5]) : 32;
  if (bits < 0 || bits > 32) return [];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const base = (ipToNum(octs.join(".")) & mask) >>> 0;
  const size = 2 ** (32 - bits);
  const out: string[] = [];
  for (let k = 0; k < size && out.length < limit; k++) {
    if (size > 2 && (k === 0 || k === size - 1)) continue; // 网络地址 / 广播地址
    out.push(numToIp((base + k) >>> 0));
  }
  return out;
}

/** 本机非环回 IPv4 所在的 /24（不填网段时默认扫这个） */
export function localSubnets(): string[] {
  const out = new Set<string>();
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== "IPv4" || ni.internal) continue;
        const [a, b, c] = ni.address.split(".");
        out.add(`${a}.${b}.${c}.0/24`);
      }
    }
  } catch {
    /* ignore */
  }
  return [...out];
}

/** 探一个地址：是 atrium 就返回它的自描述（node-info 免鉴权） */
export async function probeAtrium(host: string, port: number, timeoutMs = 800): Promise<ScannedPeer | null> {
  try {
    const res = await fetch(`http://${host}:${port}/api/node-info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (!j?.ok || j?.app !== "atrium") return null;
    return {
      id: String(j.id ?? `${host}:${port}`),
      host,
      port,
      label: String(j.label ?? host),
      version: String(j.version ?? ""),
    };
  } catch {
    return null;
  }
}

export interface ScanResult {
  scanned: number;
  found: ScannedPeer[];
  subnets: string[];
  ms: number;
}

/** 并发扫描若干网段 × 端口，找 atrium 实例 */
export async function scanForAtrium(
  subnets: string[],
  ports: number[],
  opts: { selfId?: string; timeoutMs?: number; concurrency?: number; limitPerSubnet?: number; onFound?: (p: ScannedPeer) => void } = {},
): Promise<ScanResult> {
  const t0 = Date.now();
  const targets: { host: string; port: number }[] = [];
  for (const cidr of subnets) {
    for (const host of expandCidr(cidr, opts.limitPerSubnet ?? 1024)) {
      for (const port of ports) targets.push({ host, port });
    }
  }
  const found: ScannedPeer[] = [];
  const seen = new Set<string>();
  if (!targets.length) return { scanned: 0, found, subnets, ms: 0 };
  const timeoutMs = opts.timeoutMs ?? 800;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 128, targets.length));
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const t = targets[i++];
      const p = await probeAtrium(t.host, t.port, timeoutMs);
      if (p && p.id !== opts.selfId && !seen.has(p.id)) {
        seen.add(p.id);
        found.push(p);
        opts.onFound?.(p);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { scanned: targets.length, found, subnets, ms: Date.now() - t0 };
}