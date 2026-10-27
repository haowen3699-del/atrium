import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * 局域网自动发现（零配置）：每个实例周期性 UDP 广播自己的存在，
 * 同时监听别人的广播。同网段即通；跨网段/VLAN 需要在配置里手工加 peers。
 * 不广播密钥——密钥只在 HTTP 请求头里出现，发现本身只暴露 id/端口/名字/版本。
 */

export interface DiscoverySelf {
  id: string;
  port: number;
  label: string;
  version: string;
}

export interface DiscoveredPeer {
  id: string;
  host: string;
  port: number;
  label: string;
  version: string;
  at: number;
  /** 来源：udp=同网段广播自动发现，scan=跨网段主动扫描 */
  via?: "udp" | "scan";
}

const MAGIC = "atrium";
const PROTO = 1;
const PEER_TTL = 15_000;

export interface DiscoveryOpts {
  port?: number;
  intervalMs?: number;
  onPeers?: (peers: DiscoveredPeer[]) => void;
  log?: (msg: string) => void;
}

function ipToNum(ip: string): number {
  return ip.split(".").reduce((a, o) => ((a << 8) >>> 0) + (Number(o) & 255), 0) >>> 0;
}

function numToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** 该网段的广播地址，例如 10.253.3.181/255.255.255.0 -> 10.253.3.255 */
function broadcastOf(ip: string, mask: string): string | null {
  try {
    return numToIp((ipToNum(ip) | (~ipToNum(mask) >>> 0)) >>> 0);
  } catch {
    return null;
  }
}

function targets(): string[] {
  const out = new Set<string>(["127.0.0.1"]); // 同机多实例也能互相发现
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const b = broadcastOf(ni.address, ni.netmask);
      if (b) out.add(b);
    }
  }
  return [...out];
}

export class PeerDiscovery {
  private sock: dgram.Socket | null = null;
  private peers = new Map<string, DiscoveredPeer>();
  private announceTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(private self: () => DiscoverySelf, private opts: DiscoveryOpts = {}) {}

  private get port() {
    return this.opts.port ?? Number(process.env.ATRIUM_DISCOVERY_PORT ?? 41800);
  }

  private get intervalMs() {
    return this.opts.intervalMs ?? 3000;
  }

  private emit() {
    this.opts.onPeers?.(this.list());
  }

  list(): DiscoveredPeer[] {
    const now = Date.now();
    return [...this.peers.values()]
      .filter((p) => now - p.at < PEER_TTL)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  start() {
    try {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.sock = sock;
      sock.on("error", (e) => {
        if (!this.warned) {
          this.warned = true;
          this.opts.log?.(`自动发现不可用（${(e as NodeJS.ErrnoException).code ?? e.message}）：仍可用手工 peers`);
        }
        try { sock.close(); } catch { /* ignore */ }
        this.sock = null;
      });
      sock.on("message", (buf, rinfo) => this.handle(buf, rinfo.address));
      sock.bind(this.port, () => {
        try { sock.setBroadcast(true); } catch { /* ignore */ }
        this.announce();
        this.opts.log?.(`自动发现已就绪：UDP ${this.port}（${targets().length} 个广播地址）`);
      });
      this.announceTimer = setInterval(() => this.announce(), this.intervalMs);
      this.sweepTimer = setInterval(() => this.sweep(), 5000);
    } catch (e) {
      this.opts.log?.(`自动发现启动失败：${(e as Error).message}`);
    }
  }

  stop() {
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.announceTimer = this.sweepTimer = null;
    try { this.sock?.close(); } catch { /* ignore */ }
    this.sock = null;
    this.peers.clear();
  }

  private handle(buf: Buffer, host: string) {
    let m: any;
    try {
      m = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    if (m?.m !== MAGIC || m?.proto !== PROTO) return;
    const me = this.self();
    const id = String(m.id ?? "");
    if (!id || id === me.id) return;
    const port = Number(m.port);
    if (!Number.isFinite(port) || port <= 0) return;
    const prev = this.peers.get(id);
    const next: DiscoveredPeer = {
      id,
      host,
      port,
      label: String(m.label ?? host),
      version: String(m.version ?? m.v ?? ""),
      at: Date.now(),
    };
    this.peers.set(id, next);
    // 新出现或地址/端口/版本变了才通知，避免每 3 秒重刷
    if (!prev || prev.host !== host || prev.port !== port || prev.version !== next.version || Date.now() - prev.at > PEER_TTL) {
      this.emit();
    }
  }

  private sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of [...this.peers]) {
      if (now - p.at >= PEER_TTL) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private announce() {
    const sock = this.sock;
    if (!sock) return;
    const me = this.self();
    const payload = Buffer.from(JSON.stringify({ m: MAGIC, proto: PROTO, ...me }));
    for (const addr of targets()) {
      sock.send(payload, 0, payload.length, this.port, addr, () => { /* 广播失败无所谓 */ });
    }
  }
}
