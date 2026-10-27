/** 团队密钥：浏览器本地保存，所有 /api 请求自动带上（EventSource 只能用 query） */
const KEY = "atrium.key";

export function getKey(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setKey(k: string) {
  try {
    if (k) localStorage.setItem(KEY, k);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function maskKey(k: string | null | undefined): string {
  if (!k) return "";
  return k.length <= 8 ? "****" : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** EventSource 用：把密钥拼进 query */
export function apiUrl(path: string): string {
  const k = getKey();
  if (!k) return path;
  return path + (path.includes("?") ? "&" : "?") + `key=${encodeURIComponent(k)}`;
}

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const k = getKey();
  return k ? { "x-atrium-key": k, ...extra } : { ...extra };
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, headers: apiHeaders(init.headers as Record<string, string>) });
}

export async function apiJson<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, init);
  return (await r.json()) as T;
}

export async function apiPost(path: string, body?: unknown): Promise<any> {
  const r = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({ ok: false }));
}