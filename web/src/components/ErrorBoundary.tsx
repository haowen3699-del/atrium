import { Component, ReactNode } from "react";

interface State {
  error: Error | null;
}

/** 兜底：渲染期崩溃不再白屏，把错误显示出来便于定位 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    try { localStorage.setItem("atrium.lastError", `${error.message} @ ${error.stack?.slice(0, 400) ?? ""}`); } catch {}
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "40px", fontFamily: "monospace", color: "#f87171", fontSize: 13 }}>
          <h2 style={{ color: "#ef4444", marginBottom: 12 }}>渲染出错（atrium）</h2>
          <pre style={{ whiteSpace: "pre-wrap", background: "rgba(167,139,250,0.08)", padding: 14, borderRadius: 8, lineHeight: 1.7 }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => { try { localStorage.clear(); } catch {} window.location.reload(); }}
            style={{ marginTop: 14, padding: "8px 18px", borderRadius: 8, border: "1px solid #ef4444", background: "transparent", color: "#ef4444", cursor: "pointer" }}
          >
            清除本地数据并刷新
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}