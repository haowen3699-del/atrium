import { useState } from "react";

const PRESETS = [3, 5, 10, 20];
const W = 252;
const H = 176;
const clamp = (n: number) => Math.max(2, Math.min(50, Math.round(n) || 2));

export default function BallCountMenu({ x, y, value, onChange, onClose }: {
  x: number;
  y: number;
  value: number;
  onChange: (n: number) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const left = Math.max(12, Math.min(x - W / 2, window.innerWidth - W - 12));
  const top = Math.max(12, Math.min(y - H / 2, window.innerHeight - H - 12));
  const commit = (raw: string | number) => {
    const n = clamp(Number(raw));
    setDraft(String(n));
    onChange(n);
  };

  return (
    <div
      className="ball-count-layer"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
    >
      <div className="ball-count" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
        <div className="ball-count-h">
          <span>滚轮切换数量</span>
          <button className="ball-count-x" title="关闭" onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
        </div>
        <div className="ball-count-presets">
          {PRESETS.map((n) => (
            <button key={n} className={n === value ? "on" : ""} onClick={() => commit(n)}>{n} 个</button>
          ))}
        </div>
        <div className="ball-count-custom">
          <input
            type="number"
            min={2}
            max={50}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(draft); (e.target as HTMLInputElement).blur(); } }}
          />
          <span>个会话（2 - 50）</span>
        </div>
        <div className="ball-count-f">灵动球与低语对话框滚轮共用</div>
      </div>
    </div>
  );
}
