import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { apiPost, setKey } from "../lib/api.js";
import { SelfInfo, DiscoveredView, NodeView, RunAgentView } from "../hooks/useSnapshot.js";
import LocalAuthFix from "./LocalAuthFix.js";

const STEP_TITLES = ["本机自检", "是否组网", "配置组网", "开机自启"];

type Mode = "join" | "create" | "solo";

/**
 * 组网引导（4 步 + 完成）：每次全新安装都会重新走一遍。
 * 目标是让人不用看文档就知道：本机现在什么状态 → 要不要组网 → 怎么组 → 怎么常驻。
 */
export default function Onboard({
  self, peers, nodes, runAgents, onClose, onToast,
}: {
  self?: SelfInfo;
  peers: DiscoveredView[];
  nodes: NodeView[];
  runAgents: RunAgentView[];
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>(peers.length ? "join" : "create");
  const [keyInput, setKeyInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [done, setDone] = useState(false);
  const [ocStat, setOcStat] = useState<{ installed: boolean; version?: string } | null>(null);
  const [ocBusy, setOcBusy] = useState(false);
  useEffect(() => {
    fetch("/api/oc/status").then((r) => r.json()).then((j) => setOcStat(j)).catch(() => setOcStat({ installed: false }));
  }, []);
  const installOc = async () => {
    setOcBusy(true);
    try {
      const r: any = await apiPost("/api/oc/install", {});
      onToast(r?.ok ? "opencode 安装完成" : `安装失败：${r?.error ?? ""}`);
      const s = await fetch("/api/oc/status").then((x) => x.json());
      setOcStat(s);
    } catch { onToast("安装失败：服务连不上"); }
    finally { setOcBusy(false); }
  };

  const localNodes = nodes.filter((n) => n.id.startsWith("local-"));
  const localServerOk = localNodes.some((n) => n.status === "online");
  const paired = peers.filter((p) => p.state === "ok");
  const key = self?.key ?? "";

  // 加入后自动等待互通（后端 peer 轮询约 8s 一轮）
  useEffect(() => {
    if (done && paired.length > 0) return;
    if (done && step === 2) {
      const t = setTimeout(() => { /* 让轮询继续，界面自己会变 */ }, 100);
      return () => clearTimeout(t);
    }
  }, [done, paired.length, step]);

  const finish = async (skipped = false) => {
    try {
      await apiPost("/api/settings", { onboarded: true });
    } catch {
      /* 标记失败不影响使用 */
    }
    onToast(skipped ? "已跳过引导（随时可在「组网」里重新走一遍）" : "引导完成");
    onClose();
  };

  const join = async () => {
    const k = keyInput.trim();
    if (!k) { onToast("先粘贴团队密钥"); return; }
    setJoining(true);
    try {
      const r = await apiPost("/api/settings", { key: k });
      if (r?.ok) {
        setKey(k);
        setDone(true);
        onToast("密钥已保存，正在同步其它实例…");
      } else onToast(r?.error ?? "加入失败");
    } catch {
      onToast("加入失败：服务连不上，稍后重试");
    } finally {
      setJoining(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); onToast(`${label} 已复制`); }
    catch { onToast("复制失败"); }
  };

  const canNext = step === 2 ? (mode === "join" ? done || paired.length > 0 : true) : true;

  return (
    <motion.div
      className="set-ov"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={() => finish(true)}
    >
      <motion.div
        className="set ob"
        initial={{ y: -18, scale: 0.97, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: -18, scale: 0.97, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ob-head">
          <span className="ob-pulse" />
          <div className="ob-head-text">
            <div className="ob-title">组网引导 · {STEP_TITLES[step]}</div>
            <div className="ob-sub">
              第 {step + 1} / {STEP_TITLES.length} 步 · 大概 1 分钟，配完就能用
            </div>
          </div>
          <button className="p-x" onClick={() => finish(true)}>×</button>
        </div>

        <div className="ob-steps">
          {STEP_TITLES.map((t, i) => (
            <div key={t} className={`ob-step-dot ${i < step ? "done" : i === step ? "on" : ""}`}>
              <span>{i < step ? "✓" : i + 1}</span>{t}
            </div>
          ))}
        </div>

        <div className="set-body">
          {/* ---------- 第 1 步：本机自检 ---------- */}
          {step === 0 && (
            <>
              <div className="ob-lead">先确认这台机器自己能不能被看到 —— 这台只要装了 atrium，就自动扫本机，不用额外装东西。</div>
              <div className="ob-card">
                <div className="ob-row"><span className="ob-k">实例名</span><span className="ob-v">{self?.label ?? "—"}</span></div>
                <div className="ob-row"><span className="ob-k">版本</span><span className="ob-v mono">v{self?.version ?? "—"} · 端口 {self?.port ?? "—"}</span></div>
                <div className="ob-row"><span className="ob-k">访问地址</span><span className="ob-v mono">http://127.0.0.1:{self?.port ?? 6080}/</span></div>
              </div>
              <div className="ob-checks">
                <div className={`ob-check ${localServerOk ? "ok" : "warn"}`}>
                  <b>{localServerOk ? "✓" : "!"}</b>
                  本机 opencode server：{localServerOk ? `已纳入（${localNodes.length} 个：${localNodes.map((n) => n.label).join("、")}）` : "没有发现（本机没跑 opencode server 时可以忽略）"}
                </div>
                <div className={`ob-check ${runAgents.length ? "ok" : "warn"}`}>
                  <b>{runAgents.length ? "✓" : "!"}</b>
                  本机 agent 进程：{runAgents.length ? `识别到 ${runAgents.length} 个（${runAgents.map((r) => r.label).slice(0, 3).join("、")}${runAgents.length > 3 ? "…" : ""}）` : "没识别到（没有 cc-connect / openclaw / hermes / 桌面版在跑时正常）"}
                </div>
                <div className="ob-check ok">
                  <b>✓</b>
                  局域网自动发现：已开启（同网段装了同一个包的机器会自己冒出来）
                </div>
                <div className={`ob-check ${ocStat?.installed ? "ok" : "warn"}`}>
                  <b>{ocStat?.installed ? "✓" : "!"}</b>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    本机 opencode：{ocStat ? (ocStat.installed ? `已安装（${ocStat.version ?? "已安装"}）` : "未检测到") : "检查中…"}
                    {ocStat && !ocStat.installed && (
                      <button className="tbtn" disabled={ocBusy} onClick={installOc}>{ocBusy ? "安装中…" : "一键安装 opencode"}</button>
                    )}
                  </span>
                </div>
              </div>
              {!!self?.localSkipped?.length && (
                <>
                  <div className="ob-lead">下面这些本机 server 需要账号密码，填一次就能纳入（会落盘，之后不用再填）：</div>
                  {self.localSkipped.map((p) => <LocalAuthFix key={p} port={p} onDone={onToast} />)}
                </>
              )}
            </>
          )}

          {/* ---------- 第 2 步：是否组网 ---------- */}
          {step === 1 && (
            <>
              <div className="ob-lead">
                这台机器要不要和别人一起看？同网段现在发现 <b>{peers.length}</b> 台 atrium 实例。
              </div>
              <div className="ob-modes">
                <button
                  className={`ob-mode ${mode === "join" ? "on" : ""} ${peers.length ? "" : "dim"}`}
                  onClick={() => setMode("join")}
                >
                  <b>1) 加入已有的机队</b>
                  <span>别人已经在用了：把团队密钥粘进来，立刻互通（最省事，推荐）</span>
                </button>
                <button className={`ob-mode ${mode === "create" ? "on" : ""}`} onClick={() => setMode("create")}>
                  <b>2) 新建机队，我来分发密钥</b>
                  <span>这台是第一个：用它生成的密钥，去每台机器的引导里粘贴一次</span>
                </button>
                <button className={`ob-mode ${mode === "solo" ? "on" : ""}`} onClick={() => setMode("solo")}>
                  <b>3) 先单机用，不组网</b>
                  <span>只看本机（和已配置的节点）；以后随时可在「组网」面板里加入</span>
                </button>
              </div>
            </>
          )}

          {/* ---------- 第 3 步：按选择配置 ---------- */}
          {step === 2 && (
            <>
              {mode === "join" && (
                <>
                  <div className="ob-lead">
                    {peers.length > 0
                      ? "把任意一台已加入机器的团队密钥粘进来（在那台的「组网」面板点复制）："
                      : "同网段还没发现别的实例。可以先去别的机器启动 atrium，再回来点「重新检测」；也可以直接粘贴你手上的团队密钥："}
                  </div>
                  {peers.length > 0 && (
                    <div className="ob-peers">
                      {peers.slice(0, 6).map((p) => (
                        <div key={p.id} className="ob-peer">
                          <span className={`topo-dot ${p.state}`} />
                          <span className="ob-peer-name">{p.label}</span>
                          <span className="ob-peer-sub">{p.host}:{p.port}{p.version ? ` · v${p.version}` : ""}</span>
                          <span className={`topo-state ${p.state}`}>{p.state === "ok" ? "已互通" : p.state === "key" ? "密钥不匹配" : "连接中"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="ob-row-input">
                    <input
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="团队密钥"
                      onKeyDown={(e) => { if (e.key === "Enter") join(); }}
                    />
                    <button className="gate-go ob-go-btn" disabled={joining} onClick={join}>
                      {joining ? (<><span className="ob-spin" />加入中…</>) : "加入"}
                    </button>
                  </div>
                  {!joining && done && peers.length > 0 && paired.length === 0 && (
                    <div className="ob-check warn"><span className="ob-spin" />正在同步其它实例（约 8 秒）…</div>
                  )}
                  {!joining && done && peers.length === 0 && (
                    <div className="ob-check warn"><b>✓</b>密钥已保存；同网段暂未发现其它实例，别的机器装好转起来会自动出现</div>
                  )}
                  {paired.length > 0 && (
                    <div className="ob-check ok"><b>✓</b>已与 {paired.length} 台实例互通：{paired.map((p) => p.label).join("、")}</div>
                  )}
                </>
              )}

              {mode === "create" && (
                <>
                  <div className="ob-lead">
                    这台机器负责生成团队密钥。把下面这串密钥，在<b>其它每台</b>机器的引导第 3 步里粘贴一次，就都进同一个机队了。
                  </div>
                  <div className="ob-keyrow">
                    <code>{key || "（尚未生成）"}</code>
                    <button className="tbtn" onClick={() => copy(key, "团队密钥")}>复制</button>
                  </div>
                  <div className="ob-hint">
                    提示：也可以不用密钥（留空 = 谁在同网段都能看到这台）。密钥只用于实例之间互信，不会写在广播里，也不会发给别的机器保存。
                  </div>
                  {peers.length > 0 && (
                    <div className="ob-hint">
                      当前同网段发现 {peers.length} 台实例；如果它们已经有密钥，你也可以反过来选第 2 步的「加入已有」。
                    </div>
                  )}
                </>
              )}

              {mode === "solo" && (
                <>
                  <div className="ob-lead">这台不参与组网。你现在就能看到：本机 server、已配置的节点、本机 agent 进程。</div>
                  <div className="ob-hint">
                    想加入时：顶栏「组网」→ 粘贴团队密钥，或者在这里重新走一遍引导。
                    本机浏览器免密钥；从局域网打开需要填一次团队密钥。
                  </div>
                </>
              )}
            </>
          )}

          {/* ---------- 第 4 步：开机自启 ---------- */}
          {step === 3 && (
            <>
              <div className="ob-lead">想让这台机器开机就自动在后台提供看板（不占终端、关机重启也在）？在终端执行一次：</div>
              <div className="ob-cmd">
                <code>atrium autostart on</code>
                <button className="tbtn" onClick={() => copy("atrium autostart on", "命令")}>复制</button>
              </div>
              <div className="ob-hint">
                自启后不会自动开浏览器，用 <code>atrium info</code> 随时查地址和密钥；
                关闭用 <code>atrium autostart off</code>。不想常驻就跳过这一步，需要时手动跑 <code>atrium</code> 也行。
              </div>
            </>
          )}
        </div>

        <div className="set-f ob-foot">
          <button className="tbtn" onClick={() => finish(true)}>跳过引导</button>
          <span className="grow" />
          {step > 0 && <button className="tbtn" onClick={() => setStep((s) => s - 1)}>上一步</button>}
          {step < 3 ? (
            <button className="gate-go" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>下一步</button>
          ) : (
            <button className="gate-go" onClick={() => finish(false)}>完成</button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}