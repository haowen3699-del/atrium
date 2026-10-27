import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
export const isPosixPath = (p: string) => p.startsWith("/");

export function isAbsolutePathFor(p: string, platform?: string): boolean {
  const s = String(p ?? "").trim();
  if (!s) return false;
  if (platform === "win32") return isWindowsPath(s);
  if (platform === "darwin" || platform === "linux") return isPosixPath(s);
  return isWindowsPath(s) || isPosixPath(s);
}

const normalize = (p: string) => String(p ?? "").trim();

function isRoot(p: string): boolean {
  const s = normalize(p);
  if (!s) return true;
  if (/^[A-Za-z]:[\\/]?$/.test(s)) return true;
  return s === "/" || s === "\\\\";
}

function parentPath(p: string): string | null {
  const s = normalize(p);
  if (!s || isRoot(s)) return s && /^[A-Za-z]:[\\/]?$/.test(s) ? "" : null;
  const parent = dirname(s);
  if (!parent || parent === s) return null;
  return parent;
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { sensitivity: "base" }));
}

function readDirs(p: string): FsEntry[] {
  const out: FsEntry[] = [];
  for (const d of readdirSync(p, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    out.push({ name: d.name, path: join(p, d.name), isDirectory: true });
  }
  return sortEntries(out);
}

function windowsDrives(): FsEntry[] {
  const out: FsEntry[] = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) out.push({ name: `${letter}:`, path: root, isDirectory: true });
    } catch {}
  }
  return out;
}

export function fsStatLocal(rawPath: string): { ok: boolean; exists: boolean; isDirectory: boolean; path: string; error?: string } {
  const p = normalize(rawPath);
  if (!p) return { ok: false, exists: false, isDirectory: false, path: p, error: "缺少 path" };
  try {
    const exists = existsSync(p);
    const isDirectory = exists ? statSync(p).isDirectory() : false;
    return { ok: true, exists, isDirectory, path: p };
  } catch (e) {
    return { ok: false, exists: false, isDirectory: false, path: p, error: (e as Error).message };
  }
}

export function fsListLocal(rawPath: string): { ok: boolean; path: string; parent: string | null; platform: string; entries: FsEntry[]; error?: string; exists?: boolean } {
  const platform = process.platform;
  const p = normalize(rawPath);
  try {
    if (!p) {
      if (platform === "win32") return { ok: true, path: "", parent: null, platform, entries: windowsDrives() };
      return { ok: true, path: "/", parent: null, platform, entries: readDirs("/") };
    }
    if (!existsSync(p)) return { ok: false, exists: false, path: p, parent: parentPath(p), platform, entries: [], error: "目录不存在" };
    const st = statSync(p);
    if (!st.isDirectory()) return { ok: false, exists: true, path: p, parent: parentPath(p), platform, entries: [], error: "不是目录" };
    return { ok: true, exists: true, path: p, parent: parentPath(p), platform, entries: readDirs(p) };
  } catch (e) {
    return { ok: false, path: p, parent: parentPath(p), platform, entries: [], error: (e as Error).message };
  }
}

export function fsMkdirLocal(rawPath: string): { ok: boolean; path: string; error?: string } {
  const p = normalize(rawPath);
  if (!p) return { ok: false, path: p, error: "缺少 path" };
  if (!isAbsolutePathFor(p, process.platform)) return { ok: false, path: p, error: "需要绝对路径" };
  try {
    mkdirSync(p, { recursive: true });
    // 建目录时顺手初始化成 git 工程：opencode 只把 git 工作区当项目；非工程目录下建的会话 agent 不会真正运行（空回复/0 token）
    if (!existsSync(join(p, ".git"))) {
      try { execFileSync("git", ["init"], { cwd: p, stdio: "ignore" }); } catch { /* 目标机器没装 git 就跳过 */ }
    }
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, path: p, error: (e as Error).message };
  }
}

export function fsRenameLocal(rawPath: string, rawNewName: string): { ok: boolean; path?: string; error?: string } {
  const p = normalize(rawPath);
  const name = normalize(rawNewName);
  if (!p) return { ok: false, error: "缺少 path" };
  if (!name) return { ok: false, error: "缺少新名称" };
  if (name.includes("/") || name.includes("\\")) return { ok: false, error: "新名称不能包含路径分隔符" };
  if (isRoot(p)) return { ok: false, error: "不能重命名根目录" };
  try {
    if (!existsSync(p)) return { ok: false, error: "目录不存在" };
    if (!statSync(p).isDirectory()) return { ok: false, error: "不是目录" };
    const target = join(dirname(p), name);
    if (existsSync(target)) return { ok: false, error: "目标已存在" };
    renameSync(p, target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
