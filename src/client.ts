import type { NodeConfig, ModelRef } from "./types.ts";

const TIMEOUT_MS = 6000;

export class OpenCodeClient {
  private base: string;
  private auth?: string;

  constructor(private cfg: NodeConfig) {
    this.base = cfg.url.replace(/\/+$/, "");
    if (cfg.username && cfg.password) {
      this.auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.auth) h.authorization = this.auth;
    return h;
  }

  async fetchJson<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { ...this.headers(init.headers as Record<string, string>), ...(init.headers as object) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(await this.errorMessage(res, path));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** 从非 2xx 响应体里提取可读错误信息（opencode 返回 {error}/{message} 或纯文本），没内容才回退到状态码 */
  private async errorMessage(res: Response, path: string): Promise<string> {
    let detail = "";
    try {
      const text = await res.text();
      if (text) {
        try {
          const j = JSON.parse(text);
          const e = j?.error ?? j;
          detail = typeof e === "string"
            ? e
            : (e?.message ?? e?.detail ?? (typeof e === "object" && e !== null ? JSON.stringify(e) : text));
        } catch {
          detail = text;
        }
      }
    } catch {
      /* ignore */
    }
    return detail ? `${res.status} ${res.statusText}: ${detail}` : `${res.status} ${res.statusText} on ${path}`;
  }

  /** GET /session — global list across all directories this server tracks */
  async listSessions(): Promise<any[]> {
    return this.fetchJson<any[]>("/session");
  }

  /** GET /project — opencode 已知的项目（worktree 就是目录），用来补全会话列表 */
  async listProjects(): Promise<any[]> {
    try {
      const list = await this.fetchJson<any[]>("/project");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** GET /config/providers — 可用 provider/模型清单 + 各 provider 默认模型（切换模型用） */
  async listProviders(): Promise<{ providers: any[]; default?: Record<string, string> }> {
    return this.fetchJson<{ providers: any[]; default?: Record<string, string> }>("/config/providers");
  }

  /** PATCH /project/:id — 改项目名称/图标/颜色（与桌面版同一接口，字段需全量提交） */
  async updateProject(projectID: string, directory: string, body: Record<string, unknown>): Promise<any | null> {
    const q = encodeURIComponent(directory);
    try {
      return await this.fetchJson<any>(`/project/${encodeURIComponent(projectID)}?directory=${q}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return null;
    }
  }

  /** GET /session?directory=... — sessions belonging to one project dir */
  async listSessionsFor(directory: string): Promise<any[]> {
    return this.fetchJson<any[]>(`/session?directory=${encodeURIComponent(directory)}`);
  }

  /** GET /session/status?directory=... — busy/idle per session */
  async statusFor(directory: string): Promise<Record<string, { type: string }>> {
    const q = encodeURIComponent(directory);
    return this.fetchJson<Record<string, { type: string }>>(`/session/status?directory=${q}`);
  }

  async abort(sessionID: string, directory: string): Promise<boolean> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/abort?directory=${q}`, { method: "POST" });
      return true;
    } catch {
      return false;
    }
  }

  /** 压缩会话上下文（opencode /compact 内部实现 = session.summarize，需要 providerID+modelID） */
  async compact(sessionID: string, directory: string, providerID: string, modelID: string): Promise<{ ok: boolean; error?: string }> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/summarize?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerID, modelID }),
      }, 60_000);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 撤销最后一条助手消息（revert）。messageID 由 listMessage 取最后一条 assistant 消息 */
  async revert(sessionID: string, directory: string, messageID: string): Promise<{ ok: boolean; error?: string }> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/revert?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageID }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 恢复被撤销的消息（redo） */
  async unrevert(sessionID: string, directory: string): Promise<{ ok: boolean; error?: string }> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/unrevert?directory=${q}`, { method: "POST" });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 分享会话（拿到可分享链接） */
  async share(sessionID: string, directory: string): Promise<{ ok: boolean; error?: string; url?: string }> {
    const q = encodeURIComponent(directory);
    try {
      const r = await this.fetchJson<any>(`/session/${sessionID}/share?directory=${q}`, { method: "POST" });
      return { ok: true, url: typeof r === "string" ? r : (r?.url ?? r?.share?.url ?? undefined) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 取消分享会话 */
  async unshare(sessionID: string, directory: string): Promise<{ ok: boolean; error?: string }> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/share?directory=${q}`, { method: "DELETE" });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 从某条消息 fork 出全新会话 */
  async fork(sessionID: string, directory: string, messageID: string): Promise<{ ok: boolean; error?: string; session?: any }> {
    const q = encodeURIComponent(directory);
    try {
      const r = await this.fetchJson<any>(`/session/${sessionID}/fork?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageID }),
      });
      return { ok: true, session: r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 执行自定义命令（/command 列表里的 init / review 等） */
  async sendCommand(sessionID: string, directory: string, command: string, args?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/command?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, arguments: args ? JSON.stringify(args) : undefined }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Pending permission requests for a directory (empty array if none). */
  async permissionsFor(directory: string): Promise<any[]> {
    const q = encodeURIComponent(directory);
    try {
      return await this.fetchJson<any[]>(`/permission?directory=${q}`);
    } catch {
      return [];
    }
  }

  async questionsFor(directory: string): Promise<any[]> {
    const q = encodeURIComponent(directory);
    try {
      return await this.fetchJson<any[]>(`/question?directory=${q}`);
    } catch {
      return [];
    }
  }

  async replyPermission(id: string, directory: string, response: "once" | "always" | "reject"): Promise<boolean> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/permission/${id}/reply?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reply: response }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async replyQuestion(id: string, directory: string, answers: string[][]): Promise<boolean> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/question/${id}/reply?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 拒绝/忽略提问：opencode 端 agent 不再等待，继续执行 */
  async rejectQuestion(id: string, directory: string): Promise<boolean> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/question/${id}/reject?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Send a follow-up prompt (steer) into a running session. */
  async prompt(sessionID: string, directory: string, text: string, model?: ModelRef): Promise<{ ok: boolean; error?: string }> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/prompt_async?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text }], ...(model ? { model } : {}) }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 带附件的 prompt：parts 可含 {type:"text"} / {type:"file",mime,filename,url(data URL)} */
  async promptWithParts(sessionID: string, directory: string, parts: unknown[], model?: ModelRef): Promise<{ ok: boolean; error?: string }> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}/prompt_async?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts, ...(model ? { model } : {}) }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 新建会话：POST /session?directory=... + title */
  async createSession(directory: string, title?: string): Promise<any | null> {
    const q = encodeURIComponent(directory);
    try {
      return await this.fetchJson<any>(`/session?directory=${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title?.trim() || undefined }),
      });
    } catch {
      return null;
    }
  }

  /** GET /session/:id — direct fetch; works even when the session is not in the /session list. */
  /** 改会话标题（PATCH /session/:id，opencode 桌面版/TUI 用它改名） */
  async updateSessionTitle(sessionID: string, directory: string, title: string): Promise<boolean> {
    const q = encodeURIComponent(directory);
    try {
      await this.fetchJson<unknown>(`/session/${sessionID}?directory=${q}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getSession(sessionID: string): Promise<any> {
    return this.fetchJson<any>(`/session/${sessionID}`);
  }

  /** GET /session/:id/message — 只取最近 limit 条（opencode 支持 limit，否则超大会话全量返回几十 MB 直接超时） */
  async listMessages(sessionID: string, directory: string, limit = 200): Promise<any[]> {
    const q = encodeURIComponent(directory);
    return this.fetchJson<any[]>(`/session/${sessionID}/message?directory=${q}&limit=${limit}`);
  }

  /** Open SSE stream at /global/event. Returns a ReadableStream reader + abort controller. */
  async openEventStream(signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const res = await fetch(this.base + "/global/event", {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    return res.body.getReader();
  }
}
