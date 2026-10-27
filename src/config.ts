import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { hostname, homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FleetConfig } from "./types.ts";

function expand(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
}

/** 用户级配置目录：macOS/Linux ~/.atrium，Windows %APPDATA%\atrium */
export function userConfigDir(): string {
  if (process.env.ATRIUM_HOME) return process.env.ATRIUM_HOME;
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "atrium");
  return join(homedir(), ".atrium");
}

export function userConfigPath(): string {
  return process.env.ATRIUM_CONFIG ?? join(userConfigDir(), "config.json");
}

/** 把可热改的字段写回配置文件（只写安全字段，不动 nodes/peers） */
export function saveConfig(path: string, patch: Record<string, unknown>) {
  let cur: any = {};
  try {
    if (existsSync(path)) cur = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* 坏文件就以 patch 重建 */
  }
  const next = { ...cur, ...patch };
  mkdirSync(userConfigDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

const DEFAULT_CONFIG = (): FleetConfig => ({
  port: 6080,
  pollIntervalMs: 5000,
  discoverLocal: true,
  discover: true,
  autoPeers: true,
  scanEnabled: true,
  scanPorts: [6080, 6081, 6082],
  scanIntervalMs: 120_000,
  nodes: [],
  peers: [],
});

function genId(): string {
  const h = hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 18) || "node";
  return `${h}-${randomBytes(2).toString("hex")}`;
}

function genKey(): string {
  return randomBytes(16).toString("hex");
}

function normalize(raw: any): FleetConfig {
  const d = DEFAULT_CONFIG();
  return {
    port: Number(raw.port ?? d.port),
    pollIntervalMs: raw.pollIntervalMs ?? d.pollIntervalMs,
    discoverLocal: raw.discoverLocal ?? d.discoverLocal,
    discover: raw.discover ?? d.discover,
    autoPeers: raw.autoPeers ?? d.autoPeers,
    scanEnabled: raw.scanEnabled ?? d.scanEnabled,
    scanIntervalMs: Number(raw.scanIntervalMs) > 0 ? Number(raw.scanIntervalMs) : d.scanIntervalMs,
    scanSubnets: Array.isArray(raw.scanSubnets) ? raw.scanSubnets.map((s: any) => String(s).trim()).filter(Boolean) : [],
    scanPorts: Array.isArray(raw.scanPorts) && raw.scanPorts.length ? raw.scanPorts.map((p: any) => Number(p)).filter((p: number) => p > 0 && p < 65536) : d.scanPorts,
    id: raw.id ? String(raw.id) : undefined,
    label: raw.label ? String(raw.label) : undefined,
    key: raw.key ? String(raw.key) : undefined,
    keySource: raw.keySource === "user" || raw.keySource === "env" ? raw.keySource : "auto",
    nodes: (raw.nodes ?? []).map((n: any) => ({
      id: String(n.id),
      label: n.label ?? n.id,
      url: expand(String(n.url)),
      username: n.username ? expand(String(n.username)) : undefined,
      password: n.password ? expand(String(n.password)) : undefined,
      runAgentsUrl: n.runAgentsUrl ? expand(String(n.runAgentsUrl)) : undefined,
    })),
    autoUpgrade: Boolean(raw.autoUpgrade),
    pypiIndex: raw.pypiIndex ? String(raw.pypiIndex).trim().replace(/\/+$/, "") : undefined,
    onboardedAt: Number(raw.onboardedAt) || undefined,
    localAuth: Object.fromEntries(
      Object.entries(raw.localAuth ?? {}).map(([port, v]: [string, any]) => [
        String(port),
        { username: String(v?.username ?? ""), password: String(v?.password ?? "") },
      ]),
    ),
    peers: (raw.peers ?? []).map((p: any) => ({
      id: String(p.id),
      label: p.label ?? String(p.id),
      url: expand(String(p.url)).replace(/\/+$/, ""),
      token: p.token ? expand(String(p.token)) : undefined,
    })),
    nodeLabels: Object.fromEntries(
      Object.entries(raw.nodeLabels ?? {})
        .map(([k, v]: [string, any]) => [String(k), String(v ?? "").trim()] as [string, string])
        .filter(([, v]) => v),
    ),
    teamMeta: Object.fromEntries(
      Object.entries(raw.teamMeta ?? {})
        .map(([k, v]: [string, any]) => {
          const at = typeof v?.at === "number" ? v.at : 0;
          return [String(k), { v: v?.v, at }] as [string, { v: unknown; at: number }];
        })
        .filter(([, e]) => e.at > 0),
    ),
  };
}

/**
 * 配置来源优先级：ATRIUM_CONFIG 指定的文件 > 用户目录 config.json > 仓库里的 fleet.config.json（老配置，自动迁移）
 * 首次运行会在用户目录生成一份，并补上 id / label / 团队密钥，之后就不用再碰配置文件了。
 */
export function loadConfig(path?: string): { cfg: FleetConfig; path: string; created: boolean } {
  const target = path ?? userConfigPath();
  let cfg: FleetConfig | undefined;
  let created = false;

  if (existsSync(target)) {
    cfg = normalize(JSON.parse(readFileSync(target, "utf8")));
  } else if (existsSync("fleet.config.json")) {
    // 老仓库配置：读进来，落一份到用户目录
    cfg = normalize(JSON.parse(readFileSync("fleet.config.json", "utf8")));
    created = true;
  } else {
    cfg = normalize({});
    created = true;
  }

  if (!cfg.id) cfg.id = genId();
  if (!cfg.label) cfg.label = hostname();
  if (!cfg.key) cfg.key = genKey();

  if (process.env.ATRIUM_KEY) {
    cfg.key = process.env.ATRIUM_KEY;
    cfg.keySource = "env";
  }
  if (process.env.ATRIUM_PORT) cfg.port = Number(process.env.ATRIUM_PORT);

  if (created) {
    try {
      mkdirSync(userConfigDir(), { recursive: true });
      if (existsSync("fleet.config.json") && !existsSync(target)) {
        copyFileSync("fleet.config.json", `${target}.from-repo.bak`);
      }
      writeFileSync(target, JSON.stringify({ ...cfg, key: cfg.key }, null, 2) + "\n", "utf8");
      console.log(`[atrium] 已生成配置：${target}`);
    } catch (e) {
      console.warn(`[atrium] 配置写入失败（用内存默认值继续）：${(e as Error).message}`);
    }
  }
  return { cfg, path: target, created };
}