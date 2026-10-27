import { useState } from "react";
import { apiPost } from "../lib/api.js";

/** 本机某个端口自动拿不到凭据时，就地补录账号密码 */
export default function LocalAuthFix({ port, onDone }: { port: number; onDone: (m: string) => void }) {
  const [user, setUser] = useState("opencode");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost("/api/local-auth", { port, username: user.trim(), password: pass });
      if (r?.ok) {
        onDone(`已纳入本机 :${port}，正在拉取会话…`);
        setPass("");
      } else setErr(r?.error ?? "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lafix">
      <div className="lafix-head">
        <span className="lafix-port">127.0.0.1:{port}</span>
        <span className="lafix-tip">填它的账号密码（opencode server 的 OPENCODE_SERVER_USERNAME / PASSWORD）</span>
      </div>
      <div className="lafix-row">
        <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="用户名" />
        <input
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="密码"
          type="password"
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
        />
        <button className="tbtn" disabled={busy || !user.trim() || !pass} onClick={save}>纳入</button>
      </div>
      {err && <div className="lafix-err">{err}</div>}
    </div>
  );
}
