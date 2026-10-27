import { useEffect, useState } from "react";
import { apiJson, apiPost } from "../lib/api.js";

type Stat = { state: "checking" | "exists" | "missing" | "unknown"; msg?: string };

export default function SessionDirGuard({ nodeId, dir, onToast }: {
  nodeId: string;
  dir: string;
  onToast?: (msg: string) => void;
}) {
  const [stat, setStat] = useState<Stat | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const d = dir.trim();
    if (!nodeId || !d) { setStat(null); return; }
    setStat({ state: "checking" });
    const t = window.setTimeout(async () => {
      const r = await apiJson(`/api/nodes/${encodeURIComponent(nodeId)}/fs/stat?path=${encodeURIComponent(d)}`);
      if (!alive) return;
      if (!r?.ok) setStat({ state: "unknown", msg: r?.error || "无法检查目录" });
      else if (r.exists && r.isDirectory) setStat({ state: "exists" });
      else if (r.exists) setStat({ state: "unknown", msg: "路径存在但不是目录" });
      else setStat({ state: "missing" });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [nodeId, dir]);

  const create = async () => {
    setBusy(true);
    const r = await apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/fs/mkdir`, { path: dir });
    setBusy(false);
    if (r?.ok) {
      onToast?.("工作目录已创建");
      setStat({ state: "exists" });
    } else {
      onToast?.(r?.error || "目录创建失败");
      setStat({ state: "unknown", msg: r?.error || "目录创建失败" });
    }
  };

  if (!dir || stat?.state !== "missing") return null;
  return (
    <div className="dir-missing">
      <div className="dir-missing-main">
        <span className="dir-missing-k">工作目录不存在</span>
        <code className="dir-missing-path" title={dir}>{dir}</code>
      </div>
      <button className="dir-missing-btn" disabled={busy} onClick={() => void create()}>
        {busy ? "创建中…" : "创建目录"}
      </button>
    </div>
  );
}
