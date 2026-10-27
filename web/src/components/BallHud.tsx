export interface BallHudInfo {
  title: string;
  state: string;
  machine?: string;
  host?: string;
  dir?: string;
  model?: string;
  pending?: number;
  busy?: boolean;
  ago?: string;
  hints?: string[];
}

export default function BallHud({ x, y, info, wheelCount = 5 }: { x: number; y: number; info: BallHudInfo; wheelCount?: number }) {
  return (
    <div className="ball-hud" style={{ left: x, top: y }}>
      <div className="ball-hud-h">
        <span className="ball-hud-title" title={info.title}>{info.title}</span>
        <span className={`ball-hud-state ${info.busy ? "busy" : ""}`}>{info.state}</span>
      </div>
      <div className="ball-hud-rows">
        {info.machine && <div><span>机器</span><b title={info.machine}>{info.machine}</b></div>}
        {info.host && <div><span>地址</span><b title={info.host}>{info.host}</b></div>}
        {info.dir && <div><span>目录</span><b title={info.dir}>{info.dir}</b></div>}
        {info.model && <div><span>模型</span><b title={info.model}>{info.model}</b></div>}
        {info.ago && <div><span>更新</span><b>{info.ago}</b></div>}
        {(info.pending ?? 0) > 0 && <div><span>待确认</span><b className="warn">{info.pending} 项</b></div>}
      </div>
      {(info.hints?.length ?? 0) > 0 && (
        <div className="ball-hud-hints">
          {info.hints!.slice(0, 2).map((h, i) => <div key={i} title={h}>{h}</div>)}
        </div>
      )}
      <div className="ball-hud-f">左键面板 · 双击对话 · 右键菜单 · 滚轮切最近 {wheelCount} 个 · 拖边吸附 · ⌘⇧B 唤出</div>
    </div>
  );
}
