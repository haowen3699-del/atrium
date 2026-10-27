import { motion } from "framer-motion";
import { NotifyCfg, desktopNotifyState, askDesktopPermission, primeAudio, chime } from "../lib/notify.js";

function Row({
  label, desc, on, onToggle, right,
}: {
  label: string;
  desc: string;
  on: boolean;
  onToggle: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="nt-row" onClick={onToggle}>
      <div className="nt-text">
        <div className="nt-label">{label}</div>
        <div className="nt-desc">{desc}</div>
      </div>
      {right}
      <span className={`nt-sw ${on ? "on" : ""}`}><i /></span>
    </div>
  );
}

export default function NotifyPanel({
  cfg, onChange, pending, onTest, onClose,
}: {
  cfg: NotifyCfg;
  onChange: (patch: Partial<NotifyCfg>) => void;
  pending: number;
  onTest: () => void;
  onClose: () => void;
}) {
  const st = desktopNotifyState();
  const permText =
    st.support === "unsupported" ? "浏览器不支持"
      : st.support === "insecure" ? "当前是 http 非安全上下文，浏览器会拒绝"
        : st.permission === "granted" ? "已授权"
          : st.permission === "denied" ? "已被拒绝，需在浏览器站点设置里放开"
            : "未授权（打开开关时会请求）";

  return (
    <motion.div
      className="set-ov"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="set"
        initial={{ y: -18, scale: 0.97, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: -18, scale: 0.97, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="set-h">
          值班提醒 · alerts
          <span className="grow" />
          <button className="p-x" onClick={onClose}>×</button>
        </div>
        <div className="set-body">
          <div className="sc-note">
            有 agent 进入 <b>等待授权 / 等待回答</b> 时提醒你，不用一直盯着看板。
            当前待处理 <b>{pending}</b> 项。
          </div>

          <Row
            label="桌面通知"
            desc={`系统级弹窗，切到别的窗口也能看到 · ${permText}`}
            on={cfg.desktop}
            onToggle={async () => {
              primeAudio();
              const next = !cfg.desktop;
              if (next) await askDesktopPermission();
              onChange({ desktop: next });
            }}
          />
          <Row
            label="提示音"
            desc="双音提示，浏览器要求先有一次点击才允许出声（点“测试提醒”即可解锁）"
            on={cfg.sound}
            onToggle={() => { primeAudio(); chime("awaiting"); onChange({ sound: !cfg.sound }); }}
          />
          <Row
            label="标题栏徽标"
            desc="标签页标题前显示待处理数量，如 (3) Atrium · fleet"
            on={cfg.title}
            onToggle={() => onChange({ title: !cfg.title })}
          />
          <Row
            label="自动聚焦"
            desc="新待处理出现时自动打开右侧面板定位到该 agent（会打断当前操作，默认关）"
            on={cfg.focus}
            onToggle={() => onChange({ focus: !cfg.focus })}
          />
        </div>
        <div className="set-f">
          <button className="tbtn" onClick={onTest}>测试提醒</button>
          <span className="grow" />
          <span className="ev-count">
            {st.support !== "ok" ? "提示音与标题徽标仍可用" : "设置随浏览器本地保存"}
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}