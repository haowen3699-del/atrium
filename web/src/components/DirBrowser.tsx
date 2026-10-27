import { useEffect, useMemo, useRef, useState } from "react";
import { apiJson, apiPost } from "../lib/api.js";

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export default function DirBrowser({ nodeId, initialPath, onClose, onPick, onToast }: {
  nodeId: string;
  initialPath?: string;
  onClose: () => void;
  onPick: (path: string) => void;
  onToast?: (msg: string) => void;
}) {
  const [path, setPath] = useState(initialPath?.trim() || "");
  const [pathDraft, setPathDraft] = useState(initialPath?.trim() || "");
  const [parent, setParent] = useState<string | null>(null);
  const [platform, setPlatform] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "create" | "rename">(null);
  const [name, setName] = useState("");
  const reqSeq = useRef(0);

  const isWin = platform === "win32";
  const displayPath = path || (isWin ? "此电脑" : "/");
  const selectedEntry = useMemo(() => entries.find((e) => e.path === selected) ?? null, [entries, selected]);

  const joinPath = (base: string, name: string) => {
    if (!base) return name;
    if (isWin) return base.endsWith("\\") || base.endsWith("/") ? base + name : `${base}\\${name}`;
    return base.endsWith("/") ? base + name : `${base}/${name}`;
  };

  const load = async (p: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setSelected(null);
    setMode(null);
    const r = await apiJson(`/api/nodes/${encodeURIComponent(nodeId)}/fs/list?path=${encodeURIComponent(p)}`);
    if (seq !== reqSeq.current) return r;
    setLoading(false);
    setPlatform(r.platform || platform);
    setParent(r.parent ?? null);
    if (!r.ok) {
      setEntries([]);
      setError(r.error || "无法读取目录");
      setPath(p);
      setPathDraft(p);
      return r;
    }
    setError(null);
    setPath(r.path || "");
    setPathDraft(r.path || "");
    setEntries(r.entries || []);
    return r;
  };

  useEffect(() => {
    const init = async () => {
      const p = initialPath?.trim() || "";
      const r = await load(p);
      if (p && r && !r.ok && r.parent != null && r.parent !== p) void load(r.parent);
    };
    void init();
  }, [nodeId]);

  const createDir = async () => {
    const n = name.trim();
    if (!n || !path) return;
    const target = joinPath(path, n);
    const r = await apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/fs/mkdir`, { path: target });
    if (r?.ok) {
      onToast?.(`已创建目录：${target}`);
      setName("");
      onPick(target);
    } else {
      setError(r?.error || "创建目录失败");
    }
  };

  const renameDir = async () => {
    const n = name.trim();
    if (!n || !selected) return;
    const r = await apiPost(`/api/nodes/${encodeURIComponent(nodeId)}/fs/rename`, { path: selected, newName: n });
    if (r?.ok) {
      onToast?.(`已重命名为：${r.path || n}`);
      setName("");
      await load(path);
      setSelected(r.path || null);
    } else {
      setError(r?.error || "重命名失败");
    }
  };

  return (
    <div className="pj-modal-ov dirb-ov" onClick={onClose}>
      <div className="pj-modal dirb" onClick={(e) => e.stopPropagation()}>
        <div className="pj-modal-h">
          <span className="pj-modal-title">选择工作目录</span>
          <button className="set-back" onClick={onClose}>关闭</button>
        </div>

        <div className="dirb-path">
          <input
            value={pathDraft}
            placeholder={isWin ? "留空查看磁盘，或输入完整路径" : "输入完整路径"}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void load(pathDraft.trim()); }
              else if (e.key === "Escape") onClose();
            }}
          />
          <button onClick={() => void load(pathDraft.trim())}>跳转</button>
          <button disabled={!parent && path !== ""} onClick={() => void load(parent ?? "")}>上级</button>
          <button onClick={() => void load(path)}>刷新</button>
        </div>

        <div className="dirb-tools">
          <span className="dirb-current" title={displayPath}>{displayPath}</span>
          <span className="dirb-grow" />
          <button onClick={() => { setMode("create"); setName(""); setError(null); }} disabled={!path}>新建目录</button>
          <button onClick={() => { setMode("rename"); setName(selectedEntry?.name || ""); setError(null); }} disabled={!selectedEntry}>重命名</button>
        </div>

        {mode && (
          <div className="dirb-edit">
            <span>{mode === "create" ? "新建目录" : `重命名 ${selectedEntry?.name || ""}`}</span>
            <input
              autoFocus
              value={name}
              placeholder={mode === "create" ? "目录名" : "新目录名"}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void (mode === "create" ? createDir() : renameDir()); }
                else if (e.key === "Escape") { setMode(null); setName(""); }
              }}
            />
            <button className="ok" onClick={() => void (mode === "create" ? createDir() : renameDir())}>确定</button>
            <button onClick={() => { setMode(null); setName(""); }}>取消</button>
          </div>
        )}

        {error && <div className="dirb-err">{error}</div>}

        <div className="dirb-list">
          {loading && <div className="dirb-empty">读取中…</div>}
          {!loading && entries.length === 0 && !error && <div className="dirb-empty">{path ? "该目录下没有子目录" : "没有可用磁盘"}</div>}
          {!loading && entries.map((e) => (
            <div
              key={e.path}
              className={`dirb-item ${selected === e.path ? "on" : ""}`}
              onClick={() => setSelected(e.path)}
              onDoubleClick={() => void load(e.path)}
              title={e.path}
            >
              <span className="dirb-ic">▤</span>
              <span className="dirb-name">{e.name}</span>
              <span className="dirb-path-sub">{e.path}</span>
              <span className="dirb-actions">
                <button onClick={(ev) => { ev.stopPropagation(); void load(e.path); }}>进入</button>
                <button className="ok" onClick={(ev) => { ev.stopPropagation(); onPick(e.path); }}>选择</button>
                <button onClick={(ev) => { ev.stopPropagation(); setSelected(e.path); setMode("rename"); setName(e.name); }}>改名</button>
              </span>
            </div>
          ))}
        </div>

        <div className="pj-modal-actions dirb-actions">
          <button className="pj-modal-cancel" onClick={onClose}>取消</button>
          <button className="pj-modal-ok" disabled={!path} onClick={() => onPick(path)}>选择当前目录</button>
        </div>
      </div>
    </div>
  );
}
