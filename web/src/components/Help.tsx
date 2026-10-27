import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { apiJson, apiPost } from "../lib/api.js";

/** 分端安装包：公开 PyPI 项目页（wheel 由 pip 按平台自动选择） */
const PYPI_INDEX = "https://pypi.org/simple/opencode-fleet-atrium/";
const PYPI_PROJECT = "https://pypi.org/project/opencode-fleet-atrium";
const ATRIUM_WHEELS: { key: string; label: string; tag: string }[] = [
  { key: "mac-arm64", label: "macOS · Apple 芯片", tag: "macosx_11_0_arm64" },
  { key: "mac-x64", label: "macOS · Intel", tag: "macosx_10_15_x86_64" },
  { key: "win-x64", label: "Windows · x64", tag: "win_amd64" },
];
const atriumWheelUrl = (ver: string, tag: string) => `${PYPI_PROJECT}/${ver}/#files`;

interface LastUpgrade {
  from: string;
  to: string;
  phase: "installing" | "ok" | "failed";
  startedAt?: number;
  finishedAt?: number;
  note?: string;
}

interface UpdateData {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  error: string | null;
  index: string;
  defaultIndex?: string;
  indexFromEnv?: boolean;
  package: string;
  autoUpgrade: boolean;
  command: string;
  lastUpgrade?: LastUpgrade | null;
}

interface HelpData {
  platform: string;
  version: string;
  id: string;
  label: string;
  port: number;
  urls: { local: string; lan: string[] };
  dataDir: string;
  configPath: string;
  python: string | null;
  cli: string;
  autostart: { enabled: boolean; kind?: string; port?: number };
  discover: boolean;
  secure: boolean;
  keySource: string;
  counts: { nodes: number; runAgents: number; peers: number };
  commands: Record<string, string>;
  notes: string[];
}

function Row({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="hp-row">
      <span className="hp-k">{k}</span>
      <span className={mono ? "hp-v mono" : "hp-v"}>{v}</span>
    </div>
  );
}

/** 使用帮助：这个实例是什么、怎么装、怎么起、怎么排障 */
export default function Help({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [d, setD] = useState<HelpData | null>(null);
  const [err, setErr] = useState(false);
  const [up, setUp] = useState<UpdateData | null>(null);
  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [phase, setPhase] = useState<"idle" | "waiting" | "stuck">("idle");
  const [indexDraft, setIndexDraft] = useState("");
  const [indexSaving, setIndexSaving] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const loadUpdate = async (force = false) => {
    setChecking(true);
    try {
      const u = await apiJson<UpdateData>(`/api/update${force ? "?force=1" : ""}`);
      setUp(u);
      setIndexDraft((cur) => (cur ? cur : (u.index ?? "")));
    } catch {
      /* 查不到就保持原样 */
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    apiJson<HelpData & { ok: boolean }>("/api/help")
      .then((j) => setD(j?.ok ? j : null))
      .catch(() => setErr(true));
    void loadUpdate();
  }, []);

  // 升级：发请求 → 轮询确认（版本对上=成功；脚本报失败=失败；超时=服务没回来）
  const doUpgrade = async () => {
    setUpgrading(true);
    setPhase("waiting");
    setResult(null);
    try {
      const r = await apiPost("/api/update", {});
      if (!r?.ok) {
        setPhase("idle");
        setUpgrading(false);
        onToast(r?.error ?? "升级失败");
        return;
      }
      const to = String(r.to ?? "");
      setTarget(to);
      onToast(`正在升级到 v${to}（pip 安装 + 重启，约 10~40 秒）`);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 2500));
        try {
          const st = await apiJson<UpdateData>("/api/update?force=1");
          if (cmpStr(st.current, to) >= 0) {
            setResult(`已升级到 v${st.current}`);
            onToast(`升级成功：v${st.current}，正在刷新`);
            setTimeout(() => window.location.reload(), 1500);
            return;
          }
          if (st.lastUpgrade?.phase === "failed") {
            setPhase("stuck");
            setResult(`升级失败：${st.lastUpgrade.note ?? "见 logs/upgrade.log"}`);
            onToast("升级失败，详见帮助面板");
            setUpgrading(false);
            return;
          }
        } catch {
          /* 重启期间接口会短暂不可用，继续等 */
        }
      }
      setPhase("stuck");
      setResult("等待超时：服务可能没起来，请看数据目录下 logs/upgrade.log，或手动执行 atrium");
      setUpgrading(false);
    } catch {
      setPhase("stuck");
      setResult("升级请求失败");
      setUpgrading(false);
    }
  };

  const cmpStr = (a: string, b: string) => {
    const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
    const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${label} 已复制`);
    } catch {
      onToast("复制失败");
    }
  };

  const Cmd = ({ text, label }: { text: string; label?: string }) => (
    <div className="hp-cmd">
      <code>{text}</code>
      <button className="tbtn" onClick={() => copy(text, label ?? "命令")}>复制</button>
    </div>
  );

  return (
    <motion.div
      className="set-ov"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="set help"
        initial={{ y: -18, scale: 0.97, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: -18, scale: 0.97, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="set-h">
          使用帮助 · help
          <span className="grow" />
          <button className="p-x" onClick={onClose}>×</button>
        </div>

        <div className="set-body">
          {err && <div className="p-empty">加载失败，稍后重试</div>}
          {!d && !err && <div className="p-empty">加载中…</div>}
          {d && (
            <>
              <div className="topo-sec">
                <div className="topo-title">本实例</div>
                <Row k="名称" v={d.label} mono={false} />
                <Row k="版本" v={`v${d.version} · ${d.platform}`} />
                <Row k="端口" v={String(d.port)} />
                <Row k="实例 ID" v={d.id} />
                <Row k="本机地址" v={<a className="hp-link" href={d.urls.local} target="_blank" rel="noreferrer">{d.urls.local}</a>} />
                {d.urls.lan.length > 0 && <Row k="局域网" v={d.urls.lan.join("  ")} />}
                <Row k="运行方式" v={d.autostart.enabled ? `开机自启（${d.autostart.kind}，端口 ${d.autostart.port}）` : "手动启动"} mono={false} />
                <Row k="团队密钥" v={d.secure ? `已启用（来源：${d.keySource === "user" ? "手动设置" : d.keySource === "env" ? "环境变量" : "自动生成，尚未加入机队"}）` : "未启用"} mono={false} />
                <Row k="自动发现" v={d.discover ? "已开启（UDP 同网段）" : "已关闭"} mono={false} />
                <Row k="当前看到" v={`${d.counts.nodes} 个节点 · ${d.counts.runAgents} 个运行进程 · ${d.counts.peers} 台同网段实例`} mono={false} />
                <Row k="数据目录" v={d.dataDir} />
                <Row k="配置文件" v={d.configPath} />
                {d.python && <Row k="Python" v={d.python} />}
                {d.autostart.enabled && (
                  <Row k="自启日志" v={`${d.dataDir}/logs/atrium.log`} />
                )}
              </div>

              <div className="topo-sec">
                <div className="topo-title">
                  版本与升级
                  <span className="grow" />
                  <button className="tbtn" disabled={checking} onClick={() => loadUpdate(true)}>
                    {checking ? "检查中…" : "检查更新"}
                  </button>
                </div>
                <Row k="当前版本" v={`v${up?.current ?? d.version}`} />
                <Row
                  k="最新版本"
                  v={
                    up?.error
                      ? <span className="hp-warn">查询失败：{up.error}</span>
                      : up?.latest
                        ? (up.hasUpdate ? <span className="hp-warn">v{up.latest}（有新版本）</span> : `v${up.latest}（已是最新）`)
                        : "—"
                  }
                  mono={false}
                />
                <Row
                  k="上次升级"
                  v={
                    !up?.lastUpgrade
                      ? "暂无记录"
                      : up.lastUpgrade.phase === "installing"
                        ? <span className="hp-warn">v{up.lastUpgrade.from} → v{up.lastUpgrade.to} · 进行中</span>
                        : up.lastUpgrade.phase === "ok"
                          ? `v${up.lastUpgrade.from} → v${up.lastUpgrade.to} · 成功${up.lastUpgrade.finishedAt ? "（" + new Date(up.lastUpgrade.finishedAt).toLocaleString("zh-CN", { hour12: false }) + "）" : ""}`
                          : <span className="hp-err">v{up.lastUpgrade.from} → v{up.lastUpgrade.to} · 失败：{up.lastUpgrade.note ?? "见 logs/upgrade.log"}</span>
                  }
                  mono={false}
                />
                {phase !== "idle" && (
                  <div className={`hp-upgrade ${phase === "stuck" ? "bad" : ""}`}>
                    <div className="hp-upgrade-text">
                      {phase === "waiting"
                        ? `正在升级到 v${target}：pip 安装 → 自动重启，完成后本页会自行刷新（期间服务会短暂中断）…`
                        : result}
                    </div>
                  </div>
                )}
                {up?.hasUpdate && (
                  <div className="hp-upgrade">
                    <div className="hp-upgrade-text">
                      升级会自动执行 <code>pip install -U {up.package}</code>（内网源），装完自动重启本实例；
                      日志写在数据目录的 <code>logs/upgrade.log</code>。
                    </div>
                    <button className="gate-go" disabled={upgrading} onClick={doUpgrade}>
                      {upgrading ? "升级中…" : `立即升级到 v${up.latest}`}
                    </button>
                  </div>
                )}
                <div className="hp-index">
                  <div className="hp-index-h">升级源（PyPI 索引）</div>
                  <div className="hp-index-row">
                    <input
                      className="hp-index-input"
                      value={indexDraft}
                      spellCheck={false}
                      placeholder="https://your-pypi.example.com/simple"
                      onChange={(e) => setIndexDraft(e.target.value)}
                      disabled={indexSaving || up?.indexFromEnv}
                      title={up?.indexFromEnv ? "已由环境变量 ATRIUM_PYPI_INDEX 固定，配置不生效" : "可填自建 PyPI 简单索引地址"}
                    />
                    <button
                      className="tbtn"
                      disabled={indexSaving || indexDraft.trim() === (up?.index ?? "") || up?.indexFromEnv}
                      onClick={async () => {
                        setIndexSaving(true);
                        const r = await apiPost("/api/settings", { pypiIndex: indexDraft.trim() });
                        setIndexSaving(false);
                        if (r?.ok) {
                          onToast("升级源已保存");
                          await loadUpdate(true);
                        } else onToast(r?.error ?? "保存失败");
                      }}
                    >{indexSaving ? "保存中…" : "保存"}</button>
                    <button
                      className="tbtn"
                      disabled={indexSaving || up?.indexFromEnv}
                      onClick={async () => {
                        setIndexSaving(true);
                        const r = await apiPost("/api/settings", { pypiIndex: "" });
                        setIndexSaving(false);
                        if (r?.ok) {
                          setIndexDraft(up?.defaultIndex ?? "");
                          onToast("已恢复内置升级源");
                          await loadUpdate(true);
                        } else onToast(r?.error ?? "保存失败");
                      }}
                    >恢复默认</button>
                  </div>
                  <div className="hp-index-hint">
                    {up?.indexFromEnv
                      ? <>当前由环境变量固定：<code>ATRIUM_PYPI_INDEX={up?.index}</code></>
                      : <>当前：<code>{up?.index ?? "—"}</code>（也可用环境变量 ATRIUM_PYPI_INDEX 覆盖，配置文件 <code>pypiIndex</code> 字段同样生效）</>}
                  </div>
                </div>
                <div className="hp-toggle">
                  <button
                    className={`nt-sw ${up?.autoUpgrade ? "on" : ""}`}
                    onClick={async () => {
                      const next = !up?.autoUpgrade;
                      const r = await apiPost("/api/settings", { autoUpgrade: next });
                      if (r?.ok) {
                        onToast(next ? "已开启自动升级（每 6 小时检查一次）" : "已关闭自动升级");
                        void loadUpdate();
                      } else onToast("设置失败");
                    }}
                  ><i /></button>
                  <span>自动升级：发现新版本自动安装并重启（每 6 小时检查一次，默认关）</span>
                </div>
              </div>

              <div className="topo-sec">
                <div className="topo-title">安装 / 升级（每台机器一次）</div>
                <div className="topo-hint" style={{ marginBottom: 8 }}>
                  {d.platform === "Windows" ? "Windows PowerShell 5.1 不支持 && 连接符，下面两行分开执行。" : "装的是同一个包，pip 会按平台自动选对应版本（包内自带 Node 运行时，无需另装 Node）。"}
                </div>
                <Cmd text={d.commands.install} label="安装命令" />
                <div className="topo-hint">升级：先装新版，再让服务用上（自启模式下必须重启一次）</div>
                <Cmd text={d.platform === "Windows" ? `${d.commands.install}\natrium autostart off\natrium autostart on` : d.commands.upgrade} label="升级命令" />
                <div className="topo-hint" style={{ marginTop: 10 }}>分端安装包 wheel 直链（当前 v{d.version}）：</div>
                <div className="oc-dl">
                  {ATRIUM_WHEELS.map((w) => (
                    <a key={w.key} className="oc-dl-a" href={atriumWheelUrl(d.version, w.tag)} target="_blank" rel="noreferrer" title={atriumWheelUrl(d.version, w.tag)}>{w.label}</a>
                  ))}
                  <a className="oc-dl-a" href={PYPI_INDEX} target="_blank" rel="noreferrer">版本索引</a>
                  <button className="tbtn" onClick={async () => { try { await navigator.clipboard.writeText(ATRIUM_WHEELS.map((w) => `${w.label}\t${atriumWheelUrl(d.version, w.tag)}`).join("\n")); onToast("已复制分端下载链接"); } catch { onToast("复制失败"); } }}>复制全部链接</button>
                </div>
              </div>

              <div className="topo-sec">
                <div className="topo-title">常用命令</div>
                <Row k="前台启动" v={<Cmd text={d.commands.run} />} />
                <Row k="开机自启" v={<Cmd text={d.commands.autostartOn} />} />
                <Row k="关闭自启" v={<Cmd text={d.commands.autostartOff} />} />
                <Row k="查看地址" v={<Cmd text={d.commands.info} />} />
                <Row k="打印密钥" v={<Cmd text={d.commands.printKey} />} />
                <div className="topo-hint">
                  自启模式下开机不会有终端输出，用 <code>{d.cli} info</code> 就能看到访问地址、局域网地址和团队密钥。
                </div>
              </div>

              <div className="topo-sec">
                <div className="topo-title">不同 agent 的功能支持</div>
                <div className="topo-hint" style={{ marginBottom: 8 }}>opencode 节点功能最全；pi / openclaw / hermes 为接进来的独立会话系统，只支持基础功能。</div>
                <table className="hp-matrix">
                  <thead>
                    <tr>
                      <th>功能</th>
                      <th>opencode</th>
                      <th>pi</th>
                      <th>openclaw</th>
                      <th>hermes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["看历史消息", 1, 1, 1, 1],
                      ["发消息", 1, 1, 1, 1],
                      ["中止任务", 1, 1, 1, 1],
                      ["发附件", 1, 0, 0, 0],
                      ["新建会话", 1, 0, 0, 0],
                      ["改会话名", 1, 0, 0, 1],
                      ["压缩上下文", 1, 0, 1, 0],
                      ["撤销 / 重做", 1, 0, 0, 0],
                      ["分享 / 取消分享", 1, 0, 0, 0],
                      ["分叉会话", 1, 0, 0, 0],
                      ["切换模型", 1, 0, 0, 0],
                      ["项目设置", 1, 0, 0, 0],
                      ["权限 / 问答审批", 1, 0, 0, 0],
                    ].map((row) => (
                      <tr key={row[0] as string}>
                        <td>{(row as any)[0]}</td>
                        {(row as number[]).slice(1).map((v, i) => (
                          <td key={i} className={v ? "yes" : "no"}>{v ? "✓" : "—"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="topo-sec">
                <div className="topo-title">要点 / 排障</div>
                <ul className="hp-list">
                  {d.notes.map((n, i) => <li key={i}>{n}</li>)}
                  <li>本机 opconcode server 需要账号密码时：<b>组网</b> 面板里就地填一次（会落盘），或设 <code>OPENCODE_SERVER_USERNAME</code> / <code>OPENCODE_SERVER_PASSWORD</code> 后重启。</li>
                  <li>「组网」面板显示"密钥不匹配"：把两边密钥填成同一个即可；显示"版本不一致"：都升级到最新版。</li>
                  <li>局域网打不开：确认防火墙放行该端口、两台机器在同一网段（跨网段需在配置里手工加 peers）。</li>
                </ul>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}