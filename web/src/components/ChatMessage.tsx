import { ReactNode, useState } from "react";
import Markdown from "./Markdown.js";
import { ago } from "../hooks/useSnapshot.js";

export interface MsgPart {
  type: string;
  text?: string;
  tool?: string;
  state?: { status?: string; title?: string; input?: any; output?: string; metadata?: any; time?: { start?: number; end?: number; created?: number } };
  url?: string;
  filename?: string;
  mime?: string;
}

export interface Msg {
  info: { id: string; role: string; time?: { created?: number; completed?: number } };
  parts: MsgPart[];
}

function fmtTime(ts?: number): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}
function fmtDur(ms?: number | null): string | null {
  if (!ms || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); const r = s % 60;
  return `${m}m${r}s`;
}

export function ChatErrorCard({ msg, at, sender }: { msg: string; at?: number; sender?: string }) {
  return (
    <div className="msg assistant">
      {sender && <div className="msg-who">{sender}</div>}
      <div className="msg-assistant">
        <div className="chat-error-card">
          <div className="chat-error-h">执行出错</div>
          <div className="chat-error-msg">{msg}</div>
          {at ? <div className="chat-error-at">{ago(at)}前</div> : null}
        </div>
      </div>
    </div>
  );
}

export function ChatTyping({ sender }: { sender?: string }) {
  return (
    <div className="msg assistant">
      {sender && <div className="msg-who">{sender}</div>}
      <div className="msg-assistant">
        <div className="typing"><i /><i /><i /></div>
      </div>
    </div>
  );
}

export default function ChatMessage({ msg, sender, senderKind, renderText }: {
  msg: Msg;
  sender?: string;
  senderKind?: string;
  renderText?: (text: string, role: string) => ReactNode;
}) {
  const [openThink, setOpenThink] = useState(false);
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());

  const role = msg?.info?.role;
  if (!role) return null;
  const parts = (msg.parts ?? []).filter((p) => p.type !== "step-start" && p.type !== "step-finish");
  if (!parts.length) return null;

  const reasons = parts.filter((p) => p.type === "reasoning" && p.text?.trim());
  const tools = parts.filter((p) => p.type === "tool");
  const texts = parts.filter((p) => p.type === "text" && p.text?.trim());
  const files = parts.filter((p) => p.type === "file" || p.type === "image");
  const toggleTool = (key: string) => setOpenTools((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  const filesNode = files.length > 0 && (
    <div className="msg-files">
      {files.map((p, i) => p.type === "image" && p.url
        ? <a key={i} className="msg-img" href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.filename || "图片"} loading="lazy" /></a>
        : <a key={i} className={`msg-file${p.url ? "" : " nocontent"}`} href={p.url || undefined} download={p.filename} target="_blank" rel="noreferrer" title={p.url ? "点击打开 / 下载" : "（无内容）"}>
            <span className="msg-file-ic">📄</span>
            <span className="msg-file-main">
              <span className="msg-file-name">{p.filename || "文件"}</span>
              {p.mime ? <span className="msg-file-mime">{p.mime}</span> : null}
            </span>
          </a>
      )}
    </div>
  );
  const textNode = (p: MsgPart, i: number) => {
    const content = renderText ? renderText(p.text!, role) : <Markdown text={p.text!} />;
    return role === "user" ? <div key={i}>{content}</div> : <div key={i} className="assistant-text">{content}</div>;
  };

  return (
    <div className={`msg ${role}${senderKind ? ` ${senderKind}` : ""}`}>
      {sender && <div className={`msg-who ${senderKind ?? ""}`}>{sender}</div>}
      {role === "user" ? (
        <div className="msg-user-bubble">
          {filesNode}
          {texts.map(textNode)}
          {msg.info.time?.created && <div className="msg-ts">{fmtTime(msg.info.time.created)}</div>}
        </div>
      ) : (
        <div className="msg-assistant">
          {reasons.length > 0 && (
            <div className="think">
              <button className="think-head" onClick={() => setOpenThink((v) => !v)}>
                <span className={`think-caret ${openThink ? "open" : ""}`}>▸</span>
                思考过程
                <span className="think-len">{reasons.reduce((a, p) => a + (p.text?.length ?? 0), 0)} 字</span>
              </button>
              {openThink && (
                <div className="think-body">
                  {reasons.map((p, i) => <div key={i} className="think-text">{p.text}</div>)}
                </div>
              )}
            </div>
          )}
          {tools.map((p, i) => {
            const st = p.state?.status ?? "";
            const label = p.state?.title || p.tool || "tool";
            const key = `${msg.info.id}:t:${i}`;
            const open = openTools.has(key);
            const inp = p.state?.input;
            const cmd = inp && typeof inp === "object"
              ? (inp.command ?? inp.cmd ?? inp.filePath ?? inp.path ?? null)
              : (typeof inp === "string" ? inp : null);
            const cmdText = cmd ? String(cmd) : (inp && typeof inp === "object" ? JSON.stringify(inp, null, 2) : "");
            const out = p.state?.output ?? p.text ?? "";
            const meta = p.state?.metadata;
            const metaText = meta && typeof meta === "object" && Object.keys(meta).length ? JSON.stringify(meta, null, 2) : "";
            const tStart = p.state?.time?.start;
            const tEnd = p.state?.time?.end;
            const dur = tStart && tEnd ? tEnd - tStart : (st === "completed" && msg.info.time ? (msg.info.time.completed ?? 0) - (msg.info.time.created ?? 0) : null);
            return (
              <div key={i} className={`toolblock ${st} ${open ? "open" : ""}`}>
                <button className="toolblock-head" onClick={() => toggleTool(key)} title="点击展开查看命令与输出">
                  <span className={`toolblock-caret ${open ? "open" : ""}`}>▸</span>
                  <span className="toolblock-ic">⌘</span>
                  {p.tool && <span className="toolblock-tool">{p.tool}</span>}
                  <span className="toolblock-name">{label}</span>
                  {fmtDur(dur) && <span className="toolblock-dur" title="执行耗时">{fmtDur(dur)}</span>}
                  {st && st !== "completed" && <span className="toolblock-state">{st}</span>}
                </button>
                {open && (
                  <div className="toolblock-body">
                    {cmdText && <div className="toolblock-sec"><div className="toolblock-sec-h">命令</div><pre className="toolblock-cmd">{cmdText}</pre></div>}
                    {out ? <div className="toolblock-sec"><div className="toolblock-sec-h">输出</div><pre className="toolblock-out">{out}</pre></div>
                        : (cmdText ? null : <div className="toolblock-empty">（无输出）</div>)}
                    {metaText && <div className="toolblock-sec"><div className="toolblock-sec-h">metadata</div><pre className="toolblock-meta">{metaText}</pre></div>}
                  </div>
                )}
              </div>
            );
          })}
          {filesNode}
          {texts.map(textNode)}
          {(msg.info.time?.created || msg.info.time?.completed) && (
            <div className="msg-ts">
              {fmtTime(msg.info.time.created) ?? ""}
              {msg.info.time?.completed && msg.info.time?.created ? ` → ${fmtTime(msg.info.time.completed)}` : ""}
              {msg.info.time?.completed && msg.info.time?.created ? ` · ${fmtDur(msg.info.time.completed - msg.info.time.created)}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
