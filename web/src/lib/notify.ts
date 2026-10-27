/** 值班提醒：桌面通知 + 提示音 + 标题徽标 的底层能力 */

export interface NotifyCfg {
  desktop: boolean;
  sound: boolean;
  title: boolean;
  focus: boolean;
}

export const DEFAULT_NOTIFY: NotifyCfg = { desktop: true, sound: true, title: true, focus: false };
const KEY = "atrium.notify";

export function loadNotify(): NotifyCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULT_NOTIFY, ...raw };
  } catch {
    return { ...DEFAULT_NOTIFY };
  }
}

export function saveNotify(c: NotifyCfg) {
  localStorage.setItem(KEY, JSON.stringify(c));
}

/* ===== 桌面通知：http 非安全上下文会被浏览器拒绝 ===== */
export function desktopNotifyState(): { support: "ok" | "insecure" | "unsupported"; permission: NotificationPermission | "n/a" } {
  if (typeof window === "undefined" || !("Notification" in window)) return { support: "unsupported", permission: "n/a" };
  if (!window.isSecureContext) return { support: "insecure", permission: Notification.permission };
  return { support: "ok", permission: Notification.permission };
}

export async function askDesktopPermission(): Promise<NotificationPermission | "n/a"> {
  const st = desktopNotifyState();
  if (st.support !== "ok") return "n/a";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function desktopNotify(title: string, body: string, tag?: string) {
  const st = desktopNotifyState();
  if (st.support !== "ok" || st.permission !== "granted") return;
  try {
    new Notification(title, { body, tag, silent: true });
  } catch {
    /* 某些浏览器在后台线程会抛错，忽略 */
  }
}

/* ===== 提示音：WebAudio 双音，无需音频文件 ===== */
let audio: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!AC) return null;
  try {
    audio = audio ?? new AC();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

/** 在用户手势里调用一次：解锁音频（浏览器自动播放策略要求） */
export function primeAudio() {
  ctx();
}

export function chime(kind: "awaiting" | "done" = "awaiting") {
  const a = ctx();
  if (!a) return;
  const t0 = a.currentTime + 0.01;
  const notes = kind === "awaiting" ? [880, 1174.7] : [987.8];
  notes.forEach((f, i) => {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = "sine";
    o.frequency.value = f;
    const s = t0 + i * 0.17;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.2, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.26);
    o.connect(g).connect(a.destination);
    o.start(s);
    o.stop(s + 0.3);
  });
}