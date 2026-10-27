import { useState, useEffect, type ReactNode } from "react";
import { motion } from "framer-motion";
import { apiPost, apiFetch, setKey } from "../lib/api.js";
import LocalAuthFix from "./LocalAuthFix.js";
import { SelfInfo, DiscoveredView } from "../hooks/useSnapshot.js";

const STATE_TEXT: Record<string, string> = {
  ok: "已互通",
  key: "密钥不匹配",
  wait: "连接中",
};

const KIND_TEXT: Record<string, string> = { serve: "CLI", web: "Web", desktop: "桌面版", server: "server" };

/** opencode 安装包下载（分端）：直连 GitHub Release 最新版资产 */
const OC_RELEASES = "https://github.com/anomalyco/opencode/releases/latest/download";
const OC_DOWNLOADS: { key: string; label: string; asset: string }[] = [
  { key: "win-x64", label: "Windows · x64", asset: "opencode-windows-x64.zip" },
  { key: "win-arm64", label: "Windows · ARM64", asset: "opencode-windows-arm64.zip" },
  { key: "mac-arm64", label: "macOS · Apple 芯片", asset: "opencode-darwin-arm64.zip" },
  { key: "mac-x64", label: "macOS · Intel", asset: "opencode-darwin-x64.zip" },
  { key: "linux-x64", label: "Linux · x64", asset: "opencode-linux-x64.tar.gz" },
  { key: "linux-arm64", label: "Linux · ARM64", asset: "opencode-linux-arm64.tar.gz" },
];
const ocDownloadUrl = (asset: string) => `${OC_RELEASES}/${asset}`;

const OC_STEP_ICON: Record<string, string> = { pending: "○", running: "◐", ok: "✓", fail: "✕", skip: "–" };

/** 可折叠分区：默认只展开常用项，低频/高级项收起，减少按钮视觉噪音 */
function Sec({ title, defaultOpen = false, badge, children }: { title: string; defaultOpen?: boolean; badge?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={"topo-sec" + (open ? " open" : "")}>
      <button type="button" className="topo-sechd" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="topo-chev">{open ? "▾" : "▸"}</span>
        <span className="topo-sechd-t">{title}</span>
        <span className="grow" />
        {badge != null && <span className="topo-sechd-b">{badge}</span>}
      </button>
      {open && <div className="topo-secbody">{children}</div>}
    </div>
  );
}

/** 危险操作的两步确认：点一次进入确认态，再点才真正执行 */
function DangerBtn({ label, confirmText = "确认删除", onConfirm }: { label: string; confirmText?: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed
    ? <span className="topo-danger-arm">
        <button className="tbtn tbtn-danger" onClick={() => { setArmed(false); onConfirm(); }}>{confirmText}</button>
        <button className="tbtn" onClick={() => setArmed(false)}>取消</button>
      </span>
    : <button className="tbtn topo-peer-del" onClick={() => setArmed(true)} title="需要再点一次确认，避免误触">{label}</button>;
}

const isLocalUrl = (url: string) => { try { const h = new URL(url).hostname; return h === "127.0.0.1" || h === "localhost" || h === "::1"; } catch { return false; } };

/**
 * 组网面板：连接到的服务 + 本机实例（按类型配置）+ 团队密钥；高级里放自动发现/跨网段。
 */
export default function Topology({
  self, discovered, nodes, onClose, onToast, onRefresh,
}: {
  self?: SelfInfo;
  discovered: DiscoveredView[];
  nodes: { id: string; label: string; url: string; status: string }[];
  onClose: () => void;
  onToast: (m: string) => void;
  onRefresh: () => void;
}) {
  const [label, setLabel] = useState(self?.label ?? "");
  const [keyInput, setKeyInput] = useState("");
  const [pend, setPend] = useState<Record<string, boolean>>({});
  const withPend = async (key: string, fn: () => Promise<void> | void) => {
    setPend((s) => ({ ...s, [key]: true }));
    try { await fn(); } finally { setPend((s) => { const n = { ...s }; delete n[key]; return n; }); }
  };

  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [peerUrl, setPeerUrl] = useState("");
  const [peerLabel, setPeerLabel] = useState("");
  const [nodeUrl, setNodeUrl] = useState("");
  const [nodeLabel, setNodeLabel] = useState("");
  const [nodeUser, setNodeUser] = useState("opencode");
  const [nodePass, setNodePass] = useState("");
  const [scanSubnet, setScanSubnet] = useState("");
  const [desktop, setDesktop] = useState<{ available: boolean; running: boolean; path?: string } | null>(null);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [pluginOn, setPluginOn] = useState(false);
  const [fixedPw, setFixedPw] = useState<{ fixed: boolean; password?: string } | null>(null);
  const [servers, setServers] = useState<{ port: number; pid: number; kind: string; cmd: string }[] | null>(null);
  const [hosts, setHosts] = useState<any[] | null>(null);
  const [host, setHost] = useState("");

  const loadServers = async () => {
    try { const r = await apiFetch(`/api/oc/serve`); const j: any = await r.json(); setServers(j?.servers ?? []); } catch { setServers([]); }
  };
  const loadFixedPw = async () => {
    try { const r = await apiFetch(`/api/oc/fixedpw`); const j: any = await r.json(); setFixedPw(j); } catch { setFixedPw({ fixed: false }); }
  };
  const setFixedPwNow = async () => {
    const pw = crypto.randomUUID();
    const r: any = await apiPost(`/api/oc/fixedpw`, { password: pw });
    if (r?.ok) { onToast("已设固定密码（写到 .zshrc + launchctl）"); void loadFixedPw(); }
    else onToast(r?.error ?? "设置失败");
  };
  const clearFixedPw = async () => {
    const r: any = await apiPost(`/api/oc/fixedpw/clear`, {});
    if (r?.ok) { onToast("已取消固定密码"); void loadFixedPw(); }
    else onToast(r?.error ?? "取消失败");
  };
  const pushFixedPwAll = async () => {
    const pw = fixedPw?.password;
    if (!pw) { onToast("先在本机设好固定密码"); return; }
    const r: any = await apiPost(`/api/opencode/push-fixedpw`, { targets: nodes.map((n) => n.id), password: pw });
    if (!r?.ok) { onToast(`同步失败：${r?.error ?? (r?.results ?? []).find((x: any) => !x.ok)?.error ?? ""}`); return; }
    onToast(`已同步到 ${(r.results ?? []).filter((x: any) => x.ok).length} 台机器`);
  };
  const loadHosts = () => withPend("hosts", async () => {
    const r = await apiFetch(`/api/oc/hosts`); const j: any = await r.json();
    const hs = j?.hosts ?? []; setHosts(hs);
    const pick = hs.find((h: any) => h.hasConfig) ?? hs[0]; if (pick) setHost(pick.id);
    onToast(hs.length ? `发现 ${hs.length} 台主机` : "没发现可同步的主机");
  });
  const syncConfig = () => withPend("sync", async () => {
    if (!host) { onToast("请选择主机"); return; }
    const r: any = await apiPost(`/api/oc/sync-config`, { host });
    onToast(r?.ok ? `已从「${r.from}」同步配置到本机` : `同步失败：${r?.error ?? ""}`);
  });

  useEffect(() => {
    let stop = false;
    const load = async () => {
      let d: { available: boolean; running: boolean; path?: string } | null = null;
      try {
        const r = await fetch("/api/local-opencode-desktop", { cache: "no-store" }).then((x) => x.json());
        d = r?.ok ? { available: r.available, running: r.running, path: r.path } : null;
        if (!stop) setDesktop(d);
      } catch { /* 查询失败保留旧状态，避免桌面版面板闪没 */ }
      try {
        const pl = await fetch("/api/local-opencode/plugin").then((x) => x.json());
        const installed = Boolean(pl?.installed);
        if (!stop) setPluginOn(installed);
        if (!stop && !installed && d?.available) {
          try { await apiPost("/api/local-opencode/plugin", { enabled: true }); if (!stop) setPluginOn(true); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };
    void load();
    void loadFixedPw();
    void loadServers();
    return () => { stop = true; };
  }, []);

  const reinstallPlugin = async () => {
    try { const r = await apiPost("/api/local-opencode/plugin", { enabled: true }); if (r?.ok) setPluginOn(true); return r; }
    catch { return { ok: false, error: "服务连不上" }; }
  };

  const controlDesktop = async (action: "start" | "stop" | "restart") => {
    try {
      const r = await apiPost("/api/local-opencode/control", { action });
      if (r?.ok) {
        const d = await fetch("/api/local-opencode-desktop").then((x) => x.json());
        setDesktop(d?.ok ? { available: d.available, running: d.running, path: d.path } : null);
        return r;
      }
      onToast(r?.error ?? "操作失败");
      return null;
    } catch { onToast("操作失败：服务连不上"); return null; }
  };

  const doScan = () => withPend("scan", async () => {
    const subnets = scanSubnet.trim() ? scanSubnet.split(/[\s,;]+/).filter(Boolean) : undefined;
    try {
      const r = await apiPost("/api/scan", { subnets });
      if (r?.ok) {
        onToast(r.found?.length ? `扫描 ${r.scanned} 个地址，发现 ${r.found.length} 台实例` : `扫描 ${r.scanned} 个地址，未发现新实例`);
        setScanSubnet(""); onRefresh();
      } else onToast(r?.error ?? "扫描失败");
    } catch { onToast("扫描失败：服务连不上"); }
  });

  const doRediscover = () => withPend("rediscover", async () => {
    try { await apiPost("/api/rediscover", { attempts: 3 }); onToast("已重试本机发现（连试 3 轮），稍等刷新…"); setTimeout(onRefresh, 800); }
    catch { onToast("重试失败：服务连不上"); }
  });

  const addPeer = () => withPend("addPeer", async () => {
    const url = peerUrl.trim(); if (!url) return;
    try {
      const r = await apiPost("/api/peers", { url, label: peerLabel.trim() || undefined });
      if (r?.ok) { onToast("已添加，正在连接…"); setPeerUrl(""); setPeerLabel(""); onRefresh(); }
      else onToast(r?.error ?? "添加失败");
    } catch { onToast("添加失败：服务连不上"); }
  });
  const removePeer = (id: string) => withPend("remove", async () => {
    try { const r = await apiPost("/api/peers/remove", { id }); onToast(r?.ok ? "已删除" : "删除失败"); onRefresh(); }
    catch { onToast("删除失败：服务连不上"); }
  });
  const addNode = () => withPend("addNode", async () => {
    const url = nodeUrl.trim(); if (!url) return;
    try {
      const r = await apiPost("/api/nodes", { url, label: nodeLabel.trim() || undefined, username: nodeUser.trim() || undefined, password: nodePass || undefined });
      if (r?.ok) { onToast("已添加节点，正在连接…"); setNodeUrl(""); setNodeLabel(""); setNodePass(""); onRefresh(); }
      else onToast(r?.error ?? "添加失败");
    } catch { onToast("添加失败：服务连不上"); }
  });
  const removeNode = (id: string) => withPend("remove", async () => {
    try { const r = await apiPost("/api/nodes/remove", { id }); onToast(r?.ok ? "已删除" : "删除失败"); onRefresh(); }
    catch { onToast("删除失败：服务连不上"); }
  });

  const save = async (patch: { label?: string; key?: string }) => {
    setBusy(true);
    try {
      const r = await apiPost("/api/settings", patch);
      if (r?.ok) {
        onToast(patch.key !== undefined ? "密钥已更新（其它机器需填同一个）" : "已保存");
        setKeyInput("");
        if (patch.key !== undefined) { setKey(patch.key); setTimeout(() => window.location.reload(), 700); }
      } else onToast(r?.error ?? "保存失败");
    } finally { setBusy(false); }
  };

  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); onToast("已复制"); } catch { onToast("复制失败"); } };

  const keyVal = self?.key ?? "";
  const unmatched = discovered.filter((d) => d.state === "key").length;
  const mismatched = discovered.filter((d) => d.mismatch);
  const older = mismatched.filter((d) => d.mismatch === "older");
  const newer = mismatched.filter((d) => d.mismatch === "newer");

  // 连接到的服务：本机（/api/oc/serve 带类型）+ 组网对端实例 + 远程 opencode 节点
  const localSvcs = (servers ?? []).map((s) => ({ key: "L" + s.port, ip: "127.0.0.1", machine: self?.label ?? "本机", scope: "本地", port: s.port, type: KIND_TEXT[s.kind] ?? s.kind, online: true }));
  const peerSvcs = discovered.map((d) => ({ key: "P" + d.id, ip: d.host, machine: d.label, scope: "远程", port: d.port, type: "太和", online: d.state === "ok" }));
  const remoteSvcs = nodes.filter((n) => !isLocalUrl(n.url)).map((n) => {
    let ip = "", port: string | number = ""; try { const u = new URL(n.url); ip = u.hostname; port = u.port; } catch { /* ignore */ }
    return { key: "R" + n.id, ip, machine: n.label, scope: "远程", port, type: "opencode", online: n.status === "online" };
  });
  const allSvcs = [...localSvcs, ...peerSvcs, ...remoteSvcs];

  const stopServe = (port: number) => withPend("stop:" + port, async () => {
    const r: any = await apiPost(`/api/oc/serve/stop`, { port });
    onToast(r?.ok ? `已停止 :${port}` : `停止失败：${r?.error ?? ""}`);
    await loadServers(); setTimeout(onRefresh, 1200);
  });

  return (
    <motion.div className="set-ov" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="set topo"
        initial={{ y: -18, scale: 0.97, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: -18, scale: 0.97, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="set-h">
          组网 · fleet
          <span className="grow" />
          <button className="p-x" onClick={onClose}>×</button>
        </div>

        <div className="set-body">
          {/* ===== 连接到的服务 ===== */}
          <div className="topo-sec">
            <div className="topo-title">
              连接到的服务
              <span className="grow" />
              <button className="tbtn" disabled={pend.refreshServ} onClick={() => withPend("refreshServ", async () => { await loadServers(); onRefresh(); onToast("已刷新"); })}>
                {pend.refreshServ ? "刷新中…" : "刷新"}
              </button>
            </div>
            {allSvcs.length === 0 && <div className="topo-empty">暂无连接到的服务。</div>}
            {allSvcs.length > 0 && (
              <div className="topo-hint" style={{ marginTop: 2 }}>同一台机器上的 桌面版 / CLI / web <b>共享同一份会话</b>，只是不同入口，故会分别列出。</div>
            )}
            {allSvcs.length > 0 && (
              <div className="svc-list">
                <div className="svc-head">
                  <span className="svc-c-ip">IP</span>
                  <span className="svc-c-mach">机器名</span>
                  <span className="svc-c-scope">范围</span>
                  <span className="svc-c-port">端口</span>
                  <span className="svc-c-type">类型</span>
                  <span className="svc-c-st">状态</span>
                </div>
                {allSvcs.map((s) => (
                  <div key={s.key} className="svc-row">
                    <span className="svc-c-ip mono">{s.ip || "—"}</span>
                    <span className="svc-c-mach" title={s.machine}>{s.machine}</span>
                    <span className={`svc-c-scope ${s.scope === "本地" ? "local" : "remote"}`}>{s.scope}</span>
                    <span className="svc-c-port mono">:{s.port || "—"}</span>
                    <span className="svc-c-type">{s.type}</span>
                    <span className={`svc-c-st ${s.online ? "on" : "off"}`}>{s.online ? "● 在线" : "○ 离线"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ===== 本机实例 ===== */}
          <div className="topo-sec">
            <div className="topo-title">本机实例</div>
            <div className="topo-self">
              <div className="topo-self-main">
                <input
                  className="topo-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onBlur={() => label.trim() && label !== self?.label && save({ label: label.trim() })}
                  placeholder="实例名（默认主机名）"
                />
                <div className="topo-meta">
                  <span>id {self?.id ?? "—"}</span>
                  <span>:{self?.port ?? "—"}</span>
                  <span>v{self?.version ?? "—"}</span>
                </div>
              </div>
            </div>

            {/* 桌面版（放最上面：高频控制，别被密码提示挤到页面底部） */}
            {desktop && desktop.available && (
              <div className="topo-field">
                <label>桌面版（OpenCode.app）</label>
                <div className="topo-deskbar">
                  <span className={`topo-desk-state ${desktop.running ? "on" : ""}`}>{desktop.running ? "● 运行中" : "○ 未运行"}</span>
                  <span className={`topo-desk-auto ${pluginOn ? "on" : "off"}`}>{pluginOn ? "✓ 密码自动上报已就绪" : "✕ 自动上报未安装"}</span>
                </div>
                <div className="topo-warn-actions">
                  {!desktop.running
                    ? <button className="tbtn tbtn-primary" disabled={desktopBusy} onClick={() => withPend("desk", async () => { setDesktopBusy(true); const r = await controlDesktop("start"); setDesktopBusy(false); onToast(r ? "已启动桌面版" : "启动失败"); })}>启动</button>
                    : <>
                        <button className="tbtn" disabled={desktopBusy} onClick={() => withPend("desk", async () => { setDesktopBusy(true); onToast("正在重启 OpenCode 桌面版…"); const r = await controlDesktop("restart"); setDesktopBusy(false); onToast(r ? `已重启${r.recovered ? `并捡回密码（:${r.recovered.port}）` : ""}` : "重启失败"); })}>↻ 重启并抓取密码</button>
                        <button className="tbtn tbtn-danger" disabled={desktopBusy} onClick={() => withPend("desk", async () => { setDesktopBusy(true); const r = await controlDesktop("stop"); setDesktopBusy(false); onToast(r ? "已停止桌面版" : "停止失败"); })}>停止</button>
                      </>}
                  <button className="tbtn" disabled={desktopBusy} onClick={() => withPend("plugin", async () => { setDesktopBusy(true); const r = await reinstallPlugin(); setDesktopBusy(false); onToast(r?.ok ? "自动上报插件已重新安装" : (r?.error ?? "重新安装失败")); })}>重新安装插件</button>
                </div>
              </div>
            )}

            {!!self?.localSkipped?.length && (
              <>
                <div className="topo-hint topo-warn">本机还有 opencode server 需要账号密码，未能自动纳入。可点「自动重试」连试 3 轮，或手动填一次落盘后自动生效。</div>
                <div className="topo-warn-actions">
                  <button className="tbtn" disabled={pend.rediscover} onClick={doRediscover}>{pend.rediscover ? "重试中…" : "↻ 自动重试（3 轮）"}</button>
                </div>
                {self.localSkipped.map((p) => <LocalAuthFix key={p} port={p} onDone={onToast} />)}
              </>
            )}

            {/* opencode server（CLI serve / Web 是同一个服务的不同界面） */}
            <div className="topo-field">
              <label>opencode server（CLI serve / Web）</label>
              <div className="topo-hint">桌面版 / CLI serve / web 用的是<b>同一份会话数据（共享会话）</b>——只是同机的不同入口（web 多了网页界面）。启动 CLI/web 只是多一个入口，会话互通，<b>启动其中一个就够</b>。</div>
              <div className="topo-warn-actions">
                <button className="tbtn tbtn-primary" disabled={pend.serve} onClick={() => withPend("serve", async () => {
                  const r: any = await apiPost(`/api/oc/serve`, { web: false });
                  onToast(r?.ok ? `已启动 opencode serve（PID ${r.pid}）` : `启动失败：${r?.error ?? ""}`);
                  await loadServers(); setTimeout(onRefresh, 2000);
                })}>启动 CLI serve</button>
                <button className="tbtn" disabled={pend.serve} onClick={() => withPend("serve", async () => {
                  const r: any = await apiPost(`/api/oc/serve`, { web: true });
                  onToast(r?.ok ? `已启动 opencode web（PID ${r.pid}）` : `启动失败：${r?.error ?? ""}`);
                  await loadServers(); setTimeout(onRefresh, 2000);
                })}>启动 web</button>
              </div>
              {(servers ?? []).filter((s) => s.kind === "serve" || s.kind === "web").map((s) => (
                <div key={s.port} className="svc-mini">
                  <span className="trow-dot on" />
                  <span className="svc-mini-t">{KIND_TEXT[s.kind] ?? s.kind} · :{s.port} · PID {s.pid}</span>
                  <button className="tbtn" disabled={pend["stop:" + s.port]} onClick={() => stopServe(s.port)}>{pend["stop:" + s.port] ? "停止中…" : "停止"}</button>
                </div>
              ))}
              {(servers ?? []).filter((s) => s.kind === "serve" || s.kind === "web").length === 0 && <div className="topo-hint">没有在跑的 CLI serve / web。</div>}
            </div>

            {/* 固定密码 */}
            <div className="topo-field">
              <label>固定 opencode 密码（CLI / Web）</label>
              <div className="topo-deskbar">
                <span className={`topo-desk-auto ${fixedPw?.fixed ? "on" : "off"}`}>{fixedPw?.fixed ? `✓ 已固定（${fixedPw.password?.slice(0, 8)}…）` : "✕ 未固定（每次随机）"}</span>
              </div>
              <div className="topo-hint">设好后从终端或上面按钮启动的 CLI/Web 都用同一密码（已跑的要重启）。桌面版不固定（靠插件自动上报）。可同步到组网其它机器（需 ≥0.1.74）。</div>
              <div className="topo-warn-actions">
                <button className="tbtn tbtn-primary" disabled={pend.fixedpw} onClick={() => withPend("fixedpw", setFixedPwNow)}>{pend.fixedpw ? "设置中…" : fixedPw?.fixed ? "重新生成" : "设固定密码"}</button>
                {fixedPw?.fixed && <button className="tbtn" disabled={pend.fixedpw} onClick={() => withPend("fixedpw", clearFixedPw)}>取消固定</button>}
                {fixedPw?.fixed && <button className="tbtn" disabled={pend.fixedpw || !nodes.length} onClick={() => withPend("fixedpw", pushFixedPwAll)} title="把本机固定密码同步到组网所有机器">同步到全部</button>}
              </div>
            </div>

            {/* 本地服务状态（统一） */}
            <div className="topo-field">
              <label>本地服务状态</label>
              <div className="topo-warn-actions">
                <button className="tbtn" disabled={pend.servers2} onClick={() => withPend("servers2", async () => { await loadServers(); onToast("已刷新本地服务状态"); })}>↻ 刷新</button>
              </div>
              {(servers ?? []).length === 0 && <div className="topo-hint">本机没有在跑的 opencode server。</div>}
              {(servers ?? []).map((s) => (
                <div key={s.port} className="svc-mini">
                  <span className={`trow-dot ${s.kind === "desktop" ? "" : "on"}`} />
                  <span className="svc-mini-t">{KIND_TEXT[s.kind] ?? s.kind} · :{s.port} · PID {s.pid}</span>
                  <span className="svc-mini-st on">运行中</span>
                </div>
              ))}
            </div>

            </div>

          {/* ===== 团队密钥 ===== */}
          <div className="topo-sec">
            <div className="topo-title">团队密钥</div>
            <div className="topo-keyrow">
              <code className="topo-key">{keyVal ? (showKey ? keyVal : keyVal.replace(/^(....).+(....)$/, "$1…$2")) : "未启用"}</code>
              {keyVal && <button className="tbtn" onClick={() => setShowKey((v) => !v)}>{showKey ? "隐藏" : "显示"}</button>}
              {keyVal && <button className="tbtn" onClick={() => copy(keyVal)}>复制</button>}
            </div>
            <div className="topo-hint">其它机器装同一个应用后，把这里的密钥填进去即可互相看到（密钥只在 <code>x-atrium-key</code> 请求头里传递，不参与广播）。</div>
            <div className="topo-keyrow topo-keyrow-set">
              <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="粘贴对端密钥以互通（留空则取消密钥）" />
              <button className="tbtn tbtn-primary" disabled={busy || !keyInput.trim()} onClick={() => save({ key: keyInput.trim() })}>应用密钥</button>
            </div>
          </div>

          {/* ===== 配置同步 ===== */}
          <Sec title="配置同步（本机 ← 组网主机）" badge={hosts ? `${hosts.length} 台` : undefined}>
            <div className="topo-hint">选择一台主机，把它的 opencode 配置（模型/providers）拉取到本机。</div>
            <div className="oc-actions">
              <button className="tbtn" disabled={pend.hosts} onClick={loadHosts}>{pend.hosts ? "检测中…" : "检测主机"}</button>
              {hosts && hosts.length > 0 && (
                <select className="oc-hosts" value={host} onChange={(e) => setHost(e.target.value)}>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>{h.label}{h.hasConfig ? "（有配置）" : h.ok ? (h.installed ? "（无配置）" : "（未装 opencode）") : "（不可达）"}</option>
                  ))}
                </select>
              )}
              <button className="tbtn tbtn-primary" disabled={pend.sync || !host} onClick={syncConfig}>{pend.sync ? "同步中…" : "同步配置到本机"}</button>
            </div>
            {hosts && hosts.length === 0 && <div className="topo-hint topo-warn">没检测到主机：先让主机与本机密钥一致并同网段。</div>}
          </Sec>

          {/* ===== 高级：自动发现 / 跨网段 / 手工添加 ===== */}
          <Sec title="高级：自动发现 / 跨网段 / 手工添加" badge={`${discovered.length} 台`}>
            {/* 自动发现 */}
            <div className="topo-title" style={{ marginTop: 4 }}>
              自动发现（同一网段）
              <span className="grow" />
              <button className="tbtn" disabled={pend.refresh} onClick={() => withPend("refresh", () => { onRefresh(); onToast("已刷新列表"); })}>{pend.refresh ? "刷新中…" : "刷新"}</button>
            </div>
            {discovered.length === 0 && <div className="topo-empty">暂未发现其它实例 —— 每台机器装同一个应用并启动，同一网段会自动出现。</div>}
            {discovered.map((d) => (
              <div key={d.id} className={`topo-peer ${d.state} ${d.mismatch ? "mismatch" : ""}`}>
                <span className={`topo-dot ${d.state}`} />
                <div className="topo-peer-main">
                  <div className="topo-peer-name">
                    {d.label}
                    {d.manual && <span className="topo-tag">手工</span>}
                    {!d.manual && d.via === "scan" && <span className="topo-tag">扫描</span>}
                    {d.mismatch && <span className="topo-tag warn">版本不一致</span>}
                  </div>
                  <div className="topo-peer-sub">{d.host}:{d.port}{d.version ? ` · v${d.version}` : ""}</div>
                </div>
                <span className={`topo-state ${d.state}`}>{STATE_TEXT[d.state] ?? d.state}</span>
                {d.manual && <DangerBtn label="删除" onConfirm={() => removePeer(d.id)} />}
                {d.state === "key" && <span className="topo-peer-fix">把本机密钥改成与对端一致，或让对方填你的密钥</span>}
                {d.mismatch && <span className="topo-peer-fix">{d.mismatch === "older" ? `对端较旧（v${d.version}）：升级对端后重启 atrium` : `对端较新（v${d.version}）：建议本机升级`}</span>}
              </div>
            ))}
            {unmatched > 0 && <div className="topo-hint topo-warn">有 {unmatched} 个实例密钥不匹配：双方密钥一致才会互通。</div>}

            {/* 网段扫描 */}
            <div className="topo-title" style={{ marginTop: 12 }}>跨网段扫描</div>
            <div className="topo-hint">UDP 广播过不了路由器。按 CIDR 主动探测（走单播）：留空只扫本机 /24，也可填 <code>10.253.3.0/24 10.253.109.0/24</code>。</div>
            {!!self?.scan?.subnets?.length && <div className="topo-hint">已配置扫描网段：<code>{self.scan.subnets.join("  ")}</code></div>}
            <div className="topo-addrow">
              <input value={scanSubnet} onChange={(e) => setScanSubnet(e.target.value)} placeholder="10.253.3.0/24（可空格分隔多个；留空=本机 /24）" onKeyDown={(e) => { if (e.key === "Enter") doScan(); }} />
              <button className="tbtn" disabled={pend.scan} onClick={doScan}>{pend.scan ? "扫描中…" : "扫描并保存"}</button>
            </div>

            {/* 手工添加实例 */}
            <div className="topo-title" style={{ marginTop: 12 }}>手工添加实例（跨网段）</div>
            <div className="topo-addrow">
              <input value={peerUrl} onChange={(e) => setPeerUrl(e.target.value)} placeholder="http://10.253.3.181:6080" onKeyDown={(e) => { if (e.key === "Enter") addPeer(); }} />
              <input className="topo-addrow-name" value={peerLabel} onChange={(e) => setPeerLabel(e.target.value)} placeholder="名称（可选）" onKeyDown={(e) => { if (e.key === "Enter") addPeer(); }} />
              <button className="tbtn" disabled={pend.addPeer || !peerUrl.trim()} onClick={addPeer}>{pend.addPeer ? "添加中…" : "添加"}</button>
            </div>

            {/* 手工直连 opencode server */}
            <div className="topo-title" style={{ marginTop: 12 }}>手工直连 opencode server</div>
            <div className="topo-hint">直连<b>别的机器上的</b> opencode server（带账号密码），填一次即落盘。</div>
            {nodes.filter((n) => !n.id.includes("::") && !isLocalUrl(n.url)).map((n) => (
              <div key={n.id} className="topo-node">
                <span className={`topo-dot ${n.status === "online" ? "ok" : "wait"}`} />
                <div className="topo-peer-main"><div className="topo-peer-name">{n.label}</div><div className="topo-peer-sub">{n.url}</div></div>
                <span className={`topo-state ${n.status === "online" ? "ok" : "wait"}`}>{n.status}</span>
                <DangerBtn label="删除" onConfirm={() => removeNode(n.id)} />
              </div>
            ))}
            <div className="topo-addrow topo-addrow-node">
              <input value={nodeUrl} onChange={(e) => setNodeUrl(e.target.value)} placeholder="http://10.253.109.134:4096" />
              <input className="topo-addrow-name" value={nodeLabel} onChange={(e) => setNodeLabel(e.target.value)} placeholder="名称（可选）" />
              <input className="topo-addrow-user" value={nodeUser} onChange={(e) => setNodeUser(e.target.value)} placeholder="用户名" />
              <input className="topo-addrow-pass" type="password" value={nodePass} onChange={(e) => setNodePass(e.target.value)} placeholder="密码" />
              <button className="tbtn" disabled={pend.addNode || !nodeUrl.trim()} onClick={addNode}>{pend.addNode ? "添加中…" : "添加"}</button>
            </div>
          </Sec>

          {/* ===== 下载 opencode 安装包（分端） ===== */}
          <Sec title="下载 opencode 安装包（分端）">
            <div className="oc-dl">
              {OC_DOWNLOADS.map((x) => (
                <a key={x.key} className="oc-dl-a" href={ocDownloadUrl(x.asset)} target="_blank" rel="noreferrer" title={ocDownloadUrl(x.asset)}>{x.label}</a>
              ))}
              <button className="tbtn" onClick={() => copy(OC_DOWNLOADS.map((x) => `${x.label}\t${ocDownloadUrl(x.asset)}`).join("\n"))}>复制全部</button>
            </div>
            <div className="topo-hint">官方 GitHub 资产；内网受限时可「复制全部」转内网镜像。安装/初始化见「帮助 · 安装 / 升级 / 排障」。</div>
          </Sec>
        </div>

        <div className="set-f">
          <button className="tbtn" disabled={pend.reset} onClick={() => withPend("reset", async () => {
            const r = await apiPost("/api/settings", { onboarded: false });
            onToast(r?.ok ? "已重置，正在重新走一遍组网引导" : "重置失败");
            if (r?.ok) onClose();
          })}>重新走一遍组网引导</button>
          <span className="grow" />
          <span className="ev-count">装同一个应用 → 自动发现 → 同一密钥互通</span>
        </div>
      </motion.div>
    </motion.div>
  );
}