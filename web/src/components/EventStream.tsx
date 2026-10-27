import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { apiFetch } from "../lib/api.js";

interface Ev {
  ts: number;
  type: string;
  summary: string;
  sessionID?: string;
  node: string;
  nodeLabel: string;
}

const catOf = (type: string) => {
  const t = type.toLowerCase();
  if (t.includes("error")) return "err";
  if (t.startsWith("permission") || t.startsWith("question")) return "wait";
  if (t.startsWith("file")) return "file";
  if (t.includes("tool")) return "tool";
  if (t.startsWith("session")) return "sess";
  return "misc";
};

const hhmmss = (ts: number) =>
  new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(new Date(ts).getMilliseconds()).padStart(3, "0").slice(0, 1);

export default function EventStream({ onClose, onJump }: { onClose: () => void; onJump: (nodeId: string) => void }) {
  const [items, setItems] = useState<Ev[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [nodes, setNodes] = useState<{ id: string; label: string }[]>([]);
  const [node, setNode] = useState("");
  const [type, setType] = useState("");
  const [paused, setPaused] = useState(false);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const maxTs = useRef(0);
  const seeded = useRef(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (pausedRef.current) return;
      try {
        const qs = new URLSearchParams({ limit: "400" });
        if (node) qs.set("node", node);
        if (type.trim()) qs.set("type", type.trim());
        const r = await apiFetch(`/api/events?${qs}`);
        const j = await r.json();
        if (stop || !j?.ok) return;
        const list: Ev[] = j.events ?? [];
        // 首次加载建立基线：存量事件不高亮，只有打开之后新来的才高亮
        const newly = seeded.current ? list.filter((e) => e.ts > maxTs.current).slice(0, 12).map((e) => e.ts) : [];
        seeded.current = true;
        setFresh(new Set(newly));
        if (list.length) maxTs.current = Math.max(maxTs.current, list[0].ts);
        setItems(list);
        setTypes(j.types ?? []);
        setNodes(j.nodes ?? []);
      } catch {
        /* 静默：下一轮重试 */
      }
    };
    load();
    const iv = setInterval(load, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [node, type]);

  return (
    <motion.div
      className="set-ov"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="set ev-modal"
        initial={{ y: -18, scale: 0.97, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: -18, scale: 0.97, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="set-h">
          事件流 · events
          <span className="grow" />
          <button className="p-x" onClick={onClose}>×</button>
        </div>

        <div className="ev-bar">
          <select value={node} onChange={(e) => setNode(e.target.value)}>
            <option value="">全部节点</option>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
          <input
            list="ev-types"
            placeholder="按类型过滤：tool / file / permission / error…"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <datalist id="ev-types">
            {types.map((t) => <option key={t} value={t} />)}
          </datalist>
          <button className={`tbtn ${paused ? "" : "on"}`} onClick={() => setPaused((p) => !p)}>
            {paused ? "▶ 继续" : "⏸ 暂停"}
          </button>
        </div>

        <div className="ev-list">
          {items.map((e, i) => (
            <div
              key={`${e.ts}-${i}`}
              className={`ev-row ${fresh.has(e.ts) ? "fresh" : ""}`}
              title={`${e.type}${e.sessionID ? " · " + e.sessionID : ""}\n点击跳到 ${e.nodeLabel}`}
              onClick={() => { onJump(e.node); onClose(); }}
            >
              <span className="ev-time">{hhmmss(e.ts)}</span>
              <span className={`ev-type t-${catOf(e.type)}`}>{e.type}</span>
              <span className="ev-node">{e.nodeLabel}</span>
              <span className="ev-sum">{e.summary || "—"}</span>
            </div>
          ))}
          {items.length === 0 && <div className="p-empty">暂无事件</div>}
        </div>

        <div className="set-f ev-foot">
          <span className="ev-count">{items.length} 条{node || type ? "（已过滤）" : ""} · {paused ? "已暂停" : "每 2s 刷新"}</span>
          <span className="grow" />
          <span className="ev-count">保留每节点最近 200 条，新事件高亮 · 点击行跳到该节点</span>
        </div>
      </motion.div>
    </motion.div>
  );
}