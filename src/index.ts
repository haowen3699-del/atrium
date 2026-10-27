import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { fsListLocal, fsMkdirLocal, fsRenameLocal, fsStatLocal } from "./fsx.ts";
import { ocStatusLocal, ocConfigReadLocal, ocConfigWriteLocal, ocInstallLocal, ocHookLocal, ocHookStatusLocal, ocPluginLocal, ocPluginStatusLocal, ocFixedPwStatusLocal, ocSetFixedPwLocal, ocClearFixedPwLocal, ocServeLocal, ocServeListLocal, ocServeStopLocal } from "./opencodecfg.ts";
import { networkInterfaces, homedir } from "node:os";
import { loadConfig, saveConfig } from "./config.ts";
import { FleetRegistry } from "./registry.ts";
import { sidecarTargets, sidecarFilePath } from "./sidecar.ts";
import { probeOpencode } from "./discover.ts";
import { latestVersion, cmpVersion, runUpgrade, detectAutostart, reconcileUpgrade, writeUpgradeState, PKG, PYPI_INDEX, resolvePypiIndex, clearUpdateCache } from "./update.ts";
import type { ModelRef } from "./types.ts";

/** 校验前端传来的模型引用：必须是 { providerID, modelID } 两个非空字符串，否则视为不切换 */
function parseModelRef(v: unknown): ModelRef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const providerID = String((v as any).providerID ?? "").trim();
  const modelID = String((v as any).modelID ?? "").trim();
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

const { cfg, path: cfgPath, created } = loadConfig();
const cfgHome = dirname(cfgPath);
const registry = new FleetRegistry(cfg, cfgHome);
registry.start();

const app = new Hono();

/** 团队密钥鉴权：/api/* 需要密钥（同机 UI 首次输入一次后存在浏览器里）
 *  - /api/node-info 豁免：自动发现握手/展示用，不含任何数据
 *  - 老 FLEET_TOKEN（Bearer）继续兼容
 */
const OPEN_PATHS = new Set(["/api/node-info"]);
/** 是否来自本机（loopback）——本机浏览器免密钥，局域网才需要 */
function isLocal(c: any): boolean {
  const ip = c.env?.incoming?.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

app.use("/api/*", async (c, next) => {
  if (OPEN_PATHS.has(c.req.path)) return next();
  if (isLocal(c)) return next();
  const reqKey = c.req.header("x-atrium-key") ?? c.req.query("key") ?? "";
  const bearer = c.req.header("authorization") ?? "";
  const legacy = process.env.FLEET_TOKEN;
  const teamKey = cfg.key; // 运行时可改，不能缓存在闭包外
  if (teamKey) {
    if (reqKey && reqKey === teamKey) return next();
    if (legacy && bearer === `Bearer ${legacy}`) return next();
    return c.json({ ok: false, error: "unauthorized", needKey: true }, 401);
  }
  if (legacy && bearer !== `Bearer ${legacy}`) return c.json({ ok: false, error: "unauthorized" }, 401);
  return next();
});

/** 使用帮助：把"我是什么、怎么装、怎么起、有问题怎么排查"一次给全（界面上直接展示） */
app.get("/api/help", (c) => {
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  const readJson = (f: string) => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return {};
    }
  };
  const rt = readJson(`${cfgHome}/runtime.json`);
  const autoReal = detectAutostart();
  const auto = { enabled: autoReal.enabled, kind: autoReal.kind, port: Number(rt.port ?? cfg.port) };
  const ips: string[] = [];
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
    }
  } catch {
    /* ignore */
  }
  const port = Number(rt.port ?? cfg.port);
  const pipCmd = `pip install -U opencode-fleet-atrium --index-url ${resolvePypiIndex(cfg.pypiIndex)}`;
  return c.json({
    ok: true,
    app: "atrium",
    platform,
    version: registry.version,
    id: cfg.id,
    label: cfg.label,
    port,
    urls: { local: `http://127.0.0.1:${port}/`, lan: ips.map((ip) => `http://${ip}:${port}/`) },
    dataDir: cfgHome,
    configPath: cfgPath,
    python: process.env.ATRIUM_PYTHON ?? null,
    cli: process.env.ATRIUM_CLI ?? "atrium",
    autostart: auto?.enabled ? { enabled: true, kind: auto.kind, port: auto.port } : { enabled: false },
    discover: cfg.discover !== false,
    secure: Boolean(cfg.key),
    keySource: cfg.keySource ?? "auto",
    counts: {
      nodes: registry.snapshot().nodes.length,
      runAgents: registry.snapshot().runAgents.length,
      peers: registry.snapshot().discovered?.length ?? 0,
    },
    commands: {
      install: pipCmd,
      run: "atrium",
      autostartOn: "atrium autostart on",
      autostartOff: "atrium autostart off",
      info: "atrium info",
      printKey: "atrium --print-key",
      upgrade: `${pipCmd} && atrium autostart off && atrium autostart on`,
    },
    notes: [
      "每台机器装同一个包、跑同一个 atrium，同网段会自动互相发现",
      "各机器的团队密钥填成同一个（「组网」面板粘贴一次）即可互相看到并下发指令",
      "本机浏览器免密钥；从局域网打开需填一次团队密钥",
      "自启模式下终端没有输出，用 `atrium info` 查看地址与密钥",
      platform === "Windows"
        ? "Windows 首次运行如弹出防火墙提示，请允许「专用网络」，否则别的机器连不上"
        : "如其它机器连不上，检查本机防火墙是否放行该端口",
    ],
  });
});

/** 实例自描述：自动发现与"组网"面板用，不暴露密钥与任何节点数据 */
app.get("/api/node-info", (c) =>
  c.json({
    ok: true,
    app: "atrium",
    id: cfg.id,
    label: cfg.label,
    port: cfg.port,
    version: registry.version,
    discovery: cfg.discover !== false,
    nodes: (cfg.nodes ?? []).length,
    secure: Boolean(cfg.key),
    needKey: Boolean(cfg.key) && !isLocal(c),
  }),
);

app.get("/api/snapshot", (c) => c.json(registry.snapshot()));

app.get("/api/stream", (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsub = registry.subscribe((snap) => {
      if (!closed) void stream.writeSSE({ event: "snapshot", data: JSON.stringify(snap) });
    });
    void stream.writeSSE({ event: "snapshot", data: JSON.stringify(registry.snapshot()) });
    stream.onAbort(() => {
      closed = true;
      unsub();
    });
    while (!closed) {
      await new Promise((r) => setTimeout(r, 5000));
      if (closed) break;
      await stream.writeSSE({ event: "ping", data: "1" }).catch(() => {
        closed = true;
      });
    }
  });
});

app.get("/api/nodes/:id/sessions/:sid/messages", async (c) => {
  const r = await registry.messages(c.req.param("id"), c.req.param("sid"));
  // 一律 200 + ok 标志：界面能拿到具体原因（宿主纠正过/对端不可达/会话不存在）
  return c.json(r);
});

app.post("/api/nodes/:id/sessions/:sid/title", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const title = String(body?.title ?? "").trim().slice(0, 120);
  if (!title) return c.json({ ok: false, error: "标题不能为空" }, 400);
  const ok = await registry.setSessionTitle(c.req.param("id"), c.req.param("sid"), title);
  return c.json({ ok }, ok ? 200 : 400);
});

app.post("/api/nodes/:id/sessions/create", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const directory = String(body?.directory ?? "").trim();
  const title = String(body?.title ?? "").trim().slice(0, 120);
  const r = await registry.createSession(c.req.param("id"), directory, title);
  return c.json(r, r.ok ? 200 : 502);
});

app.get("/api/nodes/:id/fs/list", async (c) => {
  const r = await registry.fsList(c.req.param("id"), c.req.query("path") ?? "");
  return c.json(r, r.ok ? 200 : 502);
});

app.get("/api/nodes/:id/fs/stat", async (c) => {
  const r = await registry.fsStat(c.req.param("id"), c.req.query("path") ?? "");
  return c.json(r, r.ok ? 200 : 502);
});

app.post("/api/nodes/:id/fs/mkdir", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = await registry.fsMkdir(c.req.param("id"), String(body?.path ?? ""));
  return c.json(r, r.ok ? 200 : 502);
});

app.post("/api/nodes/:id/fs/rename", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = await registry.fsRename(c.req.param("id"), String(body?.path ?? ""), String(body?.newName ?? ""));
  return c.json(r, r.ok ? 200 : 502);
});

/** 改项目（名称/图标/颜色）：写回对应节点的 opencode（PATCH /project），peer 节点自动转发 */
app.post("/api/nodes/:id/projects/update", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const directory = String(body?.directory ?? "").trim();
  if (!directory) return c.json({ ok: false, error: "缺少 directory" }, 400);
  const patch: { name?: string; icon?: { color?: string; override?: string; clearImage?: boolean } } = {};
  if (typeof body?.name === "string") patch.name = body.name.trim().slice(0, 120);
  if (body?.icon && typeof body.icon === "object") {
    const ic: { color?: string; override?: string; clearImage?: boolean } = {};
    if (typeof body.icon.color === "string") ic.color = body.icon.color.trim().slice(0, 20);
    if (typeof body.icon.override === "string" && body.icon.override) {
      if (!/^data:image\//.test(body.icon.override)) return c.json({ ok: false, error: "图标必须是图片 data URL" }, 400);
      if (body.icon.override.length > 8_000_000) return c.json({ ok: false, error: "图标图片太大（>6MB）" }, 400);
      ic.override = body.icon.override;
    }
    if (body.icon.clearImage === true) ic.clearImage = true;
    patch.icon = ic;
  }
  if (patch.name === undefined && !patch.icon) return c.json({ ok: false, error: "没有要更新的内容" }, 400);
  const r = await registry.updateProject(c.req.param("id"), directory, patch);
  return c.json(r, r.ok ? 200 : 400);
});

/** 项目图标图片本体（快照里只带元信息，图片走这里按需取；浏览器可缓存） */
app.get("/api/nodes/:id/projects/icon", async (c) => {
  const dir = String(c.req.query("dir") ?? "");
  const r = await registry.projectIcon(c.req.param("id"), dir);
  const cache = { "cache-control": "private, max-age=300" };
  if (!r.ok) return c.json({ ok: false, error: r.reason ?? "no icon" }, 404);
  if (r.body) {
    return c.body(r.body as any, (r.status ?? 200) as any, {
      "content-type": r.contentType ?? "application/octet-stream",
      ...cache,
    });
  }
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(r.dataUrl ?? "");
  if (!m) return c.json({ ok: false, error: "bad data url" }, 404);
  const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  return c.body(bytes as any, 200, { "content-type": m[1] || "image/png", ...cache });
});

app.post("/api/nodes/:id/sessions/:sid/abort", async (c) => {
  const ok = await registry.abort(c.req.param("id"), c.req.param("sid"));
  return c.json({ ok }, ok ? 200 : 502);
});

/** opencode 会话命令：compact / undo / redo / share / unshare / fork / command（自定义命令） */
app.post("/api/nodes/:id/sessions/:sid/command", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const command = String(body?.command ?? "");
  const opts: any = {};
  if (body?.messageID) opts.messageID = String(body.messageID);
  if (body?.name) opts.name = String(body.name);
  if (body?.args && typeof body.args === "object") opts.args = body.args;
  const r = await registry.sessionCommand(c.req.param("id"), c.req.param("sid"), command, opts);
  const status = r.ok ? 200 : 502;
  return c.json({ ok: r.ok, error: r.error, url: r.url, session: r.session }, status);
});

app.post("/api/nodes/:id/sessions/:sid/prompt", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const text = body?.text;
  if (!text || !String(text).trim()) return c.json({ ok: false, error: "empty" }, 400);
  const model = parseModelRef(body?.model);
  const r = await registry.prompt(c.req.param("id"), c.req.param("sid"), String(text), model);
  return c.json({ ok: r.ok, error: r.error }, r.ok ? 200 : 502);
});

/** 带附件的 prompt：parts 数组（text + file base64） */
app.post("/api/nodes/:id/sessions/:sid/prompt-parts", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  // 至少一个有效 part（文本或文件）
  const valid = parts.some((p: any) =>
    (p?.type === "text" && String(p.text ?? "").trim()) ||
    (p?.type === "file" && p?.data)
  );
  if (!valid) return c.json({ ok: false, error: "empty" }, 400);
  const model = parseModelRef(body?.model);
  const r = await registry.promptParts(c.req.param("id"), c.req.param("sid"), parts, model);
  return c.json({ ok: r.ok, error: r.error }, r.ok ? 200 : 502);
});

/** 可用模型清单（切换模型用）：本机直调 opencode /config/providers，peer 节点自动转发 */
app.get("/api/nodes/:id/models", async (c) => {
  const r = await registry.models(c.req.param("id"));
  return c.json(r, r.ok ? 200 : 502);
});

/** 设置机器（节点）显示名：写回后端配置（团队共享，刷新/换浏览器都在）；peer 节点自动转发给所属 peer */
app.post("/api/nodes/:id/label", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const label = typeof body?.label === "string" ? body.label : "";
  const r = await registry.setNodeLabel(c.req.param("id"), label);
  if (r.ok) {
    try {
      saveConfig(cfgPath, { nodeLabels: cfg.nodeLabels ?? {} });
    } catch (e) {
      return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
    }
  }
  return c.json(r, r.ok ? 200 : 502);
});

/** 设置团队共享元数据（标签/别名/颜色/置顶等）：写本 hub 配置并广播给全队机器 */
app.post("/api/team-meta", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key.trim()) return c.json({ ok: false, error: "缺少 key" }, 400);
  registry.setTeamMeta(key, body?.value);
  try {
    saveConfig(cfgPath, { teamMeta: (cfg as any).teamMeta ?? {} });
  } catch (e) {
    return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok: true });
});


app.post("/api/teams/dispatch", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const members = Array.isArray(body?.members) ? body.members : [];
  const leader = body?.leader && typeof body.leader === "object" ? body.leader : undefined;
  const opts = { policy: body?.policy, includeLeader: body?.includeLeader, concurrency: Number(body?.concurrency) || undefined, parts: Array.isArray(body?.parts) ? body.parts : undefined };
  const r = await registry.dispatchTeam(String(body?.teamId ?? ""), members, leader, String(body?.task ?? ""), opts as any);
  return c.json(r, r.ok ? 200 : 502);
});

app.post("/api/teams/retry", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const ok = await registry.retryTeamAssign(String(body?.jobId ?? ""), Number(body?.index) || 0);
  return c.json({ ok }, ok ? 200 : 502);
});

/** 团队时间线：合并组长+各子任务会话的消息，按时间排序（团队聊天窗） */
app.get("/api/teams/:id/timeline", async (c) => {
  const r = await registry.teamTimeline(c.req.param("id"), Math.min(400, Math.max(20, Number(c.req.query("limit")) || 200)));
  return c.json(r);
});

/** 节点侧文件系统通道：让别的机器（经 peer 转发）能在本机浏览/建/改项目目录 */
app.post("/api/fs/mkdir", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = fsMkdirLocal(String(body?.path ?? ""));
  return c.json(r, r.ok ? 200 : 400);
});

app.get("/api/fs/stat", (c) => {
  const r = fsStatLocal(c.req.query("path") ?? "");
  return c.json(r, r.ok ? 200 : 400);
});

app.get("/api/fs/list", (c) => {
  const r = fsListLocal(c.req.query("path") ?? "");
  return c.json(r, r.ok ? 200 : 400);
});

app.post("/api/fs/rename", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = fsRenameLocal(String(body?.path ?? ""), String(body?.newName ?? ""));
  return c.json(r, r.ok ? 200 : 400);
});

/* ===== opencode 初始化/配置通道：节点侧（供 peer 转发调用，执行在"那台机器"上） ===== */
app.get("/api/oc/status", (c) => c.json(ocStatusLocal()));
app.get("/api/oc/config", (c) => c.json(ocConfigReadLocal()));
app.post("/api/oc/config", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = ocConfigWriteLocal(String(body?.content ?? ""));
  return c.json(r, r.ok ? 200 : 400);
});
app.post("/api/oc/install", (c) => {
  const r = ocInstallLocal();
  return c.json(r, r.ok ? 200 : 500);
});
app.get("/api/oc/hook", (c) => c.json({ ok: true, enabled: ocHookStatusLocal() }));
app.post("/api/oc/hook", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = ocHookLocal(body?.enabled !== false, cfg.port);
  return c.json(r, r.ok ? 200 : 500);
});
app.get("/api/oc/plugin", (c) => c.json({ ok: true, installed: ocPluginStatusLocal() }));
app.post("/api/oc/plugin", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = ocPluginLocal(body?.enabled !== false, cfg.port);
  return c.json(r, r.ok ? 200 : 500);
});

/* 固定 opencode server 密码（节点侧，供 peer 转发）：写 shell profile + launchctl setenv */
app.get("/api/oc/fixedpw", (c) => c.json(ocFixedPwStatusLocal()));
app.post("/api/oc/fixedpw", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const pw = String(body?.password ?? "");
  if (!pw.trim()) return c.json({ ok: false, error: "密码不能为空" }, 400);
  const r = ocSetFixedPwLocal(pw.trim());
  return c.json(r, r.ok ? 200 : 500);
});
app.post("/api/oc/fixedpw/clear", (c) => {
  const r = ocClearFixedPwLocal();
  return c.json(r, r.ok ? 200 : 500);
});

/* 启动 opencode server（节点侧，供 peer 转发）：detached + stdio:ignore，不继承管道 */
app.get("/api/oc/serve", async (c) => c.json(await ocServeListLocal()));
app.post("/api/oc/serve", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const port = body?.port ? Number(body.port) || null : null;
  const web = body?.web === true;
  const r = ocServeLocal(port, web);
  return c.json(r, r.ok ? 200 : 500);
});
app.post("/api/oc/serve/stop", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const port = Number(body?.port) || 0;
  if (!port) return c.json({ ok: false, error: "缺少端口" }, 400);
  const r = await ocServeStopLocal(port);
  return c.json(r, r.ok ? 200 : 500);
});

/* 本机自我初始化：本机装 opencode + 从一台主机同步配置 + 钩子/插件（仅本机触发） */
app.get("/api/oc/hosts", async (c) => c.json({ ok: true, hosts: await registry.ocPeerHosts() }));
/* 配置同步：本机选择一台主机，把它的 opencode 配置拉回本机 */
app.post("/api/oc/sync-config", async (c) => {
  if (!isLocal(c)) return c.json({ ok: false, error: "仅本机可同步配置" }, 403);
  const body = await c.req.json().catch(() => ({} as any));
  const host = String(body?.host ?? "").trim();
  if (!host) return c.json({ ok: false, error: "请选择主机" }, 400);
  const r = await registry.pullOpencodeConfigFromHost(host);
  return c.json(r, r.ok ? 200 : 502);
});
app.get("/api/oc/self-init", (c) => c.json({ ok: true, job: registry.ocSelfInitGet() }));
app.post("/api/oc/self-init", async (c) => {
  if (!isLocal(c)) return c.json({ ok: false, error: "仅本机可自我初始化" }, 403);
  const body = await c.req.json().catch(() => ({} as any));
  const host = body?.host ? String(body.host) : undefined;
  const job = registry.ocSelfInitStart(host);
  return c.json({ ok: true, ...job });
});

/* ===== hub 侧：对某机器查状态/装/读写配置；把本机配置下发到组网机器 ===== */
app.get("/api/nodes/:id/opencode/status", async (c) => c.json(await registry.ocStatus(c.req.param("id"))));
app.get("/api/nodes/:id/opencode/config", async (c) => c.json(await registry.ocConfigRead(c.req.param("id"))));
app.post("/api/nodes/:id/opencode/config", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const r = await registry.ocConfigWrite(c.req.param("id"), String(body?.content ?? ""));
  return c.json(r, r.ok ? 200 : 400);
});
app.post("/api/nodes/:id/opencode/install", async (c) => {
  const r = await registry.ocInstall(c.req.param("id"));
  return c.json(r, r.ok ? 200 : 502);
});
app.post("/api/opencode/push-config", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const targets = Array.isArray(body?.targets) ? body.targets.map(String) : [];
  if (!targets.length) return c.json({ ok: false, error: "没有目标机器" }, 400);
  const r = await registry.pushOpencodeConfig(targets);
  return c.json(r, r.ok ? 200 : 502);
});

/* 固定密码：对某机器查/设/清；把固定密码同步到全部组网机器 */
app.get("/api/nodes/:id/opencode/fixedpw", async (c) => c.json(await registry.ocFixedPwStatus(c.req.param("id"))));
app.post("/api/nodes/:id/opencode/fixedpw", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const pw = String(body?.password ?? "").trim();
  if (!pw) return c.json({ ok: false, error: "密码不能为空" }, 400);
  const r = await registry.ocSetFixedPw(c.req.param("id"), pw);
  return c.json(r, r.ok ? 200 : 502);
});
app.post("/api/nodes/:id/opencode/fixedpw/clear", async (c) => {
  const r = await registry.ocClearFixedPw(c.req.param("id"));
  return c.json(r, r.ok ? 200 : 502);
});
app.post("/api/opencode/push-fixedpw", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const targets = Array.isArray(body?.targets) ? body.targets.map(String) : [];
  const pw = String(body?.password ?? "").trim();
  if (!targets.length) return c.json({ ok: false, error: "没有目标机器" }, 400);
  if (!pw) return c.json({ ok: false, error: "密码不能为空" }, 400);
  const r = await registry.pushFixedPw(targets, pw);
  return c.json(r, r.ok ? 200 : 502);
});

/* 在某机器上启动 opencode server（CLI serve / web） */
app.post("/api/nodes/:id/opencode/serve", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const port = body?.port ? Number(body.port) || null : null;
  const web = body?.web === true;
  const r = await registry.ocServe(c.req.param("id"), port, web);
  return c.json(r, r.ok ? 200 : 502);
});
app.get("/api/nodes/:id/opencode/serve", async (c) => c.json(await registry.ocServeList(c.req.param("id"))));
app.post("/api/nodes/:id/opencode/serve/stop", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const port = Number(body?.port) || 0;
  if (!port) return c.json({ ok: false, error: "缺少端口" }, 400);
  const r = await registry.ocServeStop(c.req.param("id"), port);
  return c.json(r, r.ok ? 200 : 502);
});

/* 一键初始化 opencode：异步跑（装→下发配置→钩子→插件），返回 job 供轮询进度 */
app.post("/api/nodes/:id/opencode/init", (c) => {
  const job = registry.ocInitStart(c.req.param("id"));
  return c.json({ ok: true, ...job });
});
app.get("/api/nodes/:id/opencode/init", (c) => {
  const job = registry.ocInitGet(c.req.param("id"));
  return c.json({ ok: true, job });
});

app.post("/api/nodes/:id/permissions/:pid/reply", async (c) => {
  const { response } = await c.req.json();
  if (!["once", "always", "reject"].includes(response)) return c.json({ ok: false }, 400);
  const ok = await registry.replyPermission(c.req.param("id"), c.req.param("pid"), response);
  return c.json({ ok }, ok ? 200 : 502);
});

app.post("/api/nodes/:id/questions/:qid/reply", async (c) => {
  const { answers } = await c.req.json();
  const ok = await registry.replyQuestion(c.req.param("id"), c.req.param("qid"), answers);
  return c.json({ ok }, ok ? 200 : 502);
});

app.post("/api/nodes/:id/questions/:qid/reject", async (c) => {
  const ok = await registry.rejectQuestion(c.req.param("id"), c.req.param("qid"));
  return c.json({ ok }, ok ? 200 : 502);
});

app.post("/api/runagents/dismiss", async (c) => {
  const { id } = await c.req.json();
  if (!id || !String(id).trim()) return c.json({ ok: false, error: "empty" }, 400);
  const ok = registry.dismissRunAgent(String(id));
  return c.json({ ok });
});

/** 给 standalone pi agent 派任务：续写指定会话（不带 sessionId 则续最新活跃会话）。 */
app.post("/api/runagents/pi/prompt", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const text = body?.text;
  if (!text || !String(text).trim()) return c.json({ ok: false, error: "empty" }, 400);
  const sessionId = body?.sessionId ? String(body.sessionId) : undefined;
  const r = await registry.promptPi(String(text), sessionId);
  return c.json({ ok: r.ok, error: r.error, pid: r.pid }, r.ok ? 200 : 502);
});

/** 组网设置：团队密钥 / 显示名（立即生效并写盘） */
app.post("/api/settings", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const patch: Record<string, string | number> = {};
  if (typeof body?.key === "string") {
    const k = body.key.trim();
    if (k && k.length < 8) return c.json({ ok: false, error: "密钥至少 8 位" }, 400);
    cfg.key = k || undefined;
    cfg.keySource = "user";
    patch.key = k;
    patch.keySource = "user";
  }
  if (typeof body?.autoUpgrade === "boolean") {
    cfg.autoUpgrade = body.autoUpgrade;
    patch.autoUpgrade = body.autoUpgrade;
  }
  if (typeof body?.pypiIndex === "string") {
    // 自定义升级源：空值=恢复内置默认；只接受 http(s) 地址
    const raw = body.pypiIndex.trim().replace(/\/+$/, "");
    if (raw && !/^https?:\/\/[^\s]+$/i.test(raw)) {
      return c.json({ ok: false, error: "升级源必须是 http(s) 开头的索引地址" }, 400);
    }
    cfg.pypiIndex = raw || undefined;
    patch.pypiIndex = cfg.pypiIndex ?? "";
    clearUpdateCache(); // 立刻用新源检查
  }
  if (body?.onboarded === true) {
    cfg.onboardedAt = Date.now();
    patch.onboardedAt = cfg.onboardedAt;
  }
  if (body?.onboarded === false) {
    cfg.onboardedAt = undefined;
    patch.onboardedAt = 0; // normalize 会把 0 当成"未引导"
  }
  if (typeof body?.label === "string") {
    const l = body.label.trim().slice(0, 40);
    if (l) {
      registry.setLabel(l);
      patch.label = l;
    }
  }
  try {
    saveConfig(cfgPath, patch);
  } catch (e) {
    return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok: true, key: cfg.key ? `${cfg.key.slice(0, 4)}…${cfg.key.slice(-4)}` : null, label: cfg.label });
});

/** 组网：手工增删 peer（跨网段/VLAN 用，自动发现的 UDP 广播过不了路由器） */
app.post("/api/peers", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const res = registry.addPeer({ id: body?.id, label: body?.label, url: String(body?.url ?? ""), token: body?.token });
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  try {
    saveConfig(cfgPath, { peers: cfg.peers ?? [] });
  } catch (e) {
    return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok: true, peer: res.peer });
});

app.post("/api/peers/remove", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const id = String(body?.id ?? "").trim();
  if (!id) return c.json({ ok: false, error: "缺少 id" }, 400);
  const ok = registry.removePeer(id);
  try {
    saveConfig(cfgPath, { peers: cfg.peers ?? [] });
  } catch (e) {
    return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok });
});

/** 跨网段扫描：手动触发一轮（可带上要扫的网段，会落盘供自动扫描复用） */
app.post("/api/scan", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const subnets = Array.isArray(body?.subnets)
    ? body.subnets.map((s: any) => String(s).trim()).filter(Boolean)
    : [];
  if (subnets.length) {
    cfg.scanSubnets = [...new Set([...(cfg.scanSubnets ?? []), ...subnets])];
    cfg.scanEnabled = true;
    try {
      saveConfig(cfgPath, { scanSubnets: cfg.scanSubnets, scanEnabled: true });
    } catch {
      /* 落盘失败不挡扫描 */
    }
  }
  const res = await registry.scanNow();
  return c.json(res, res.ok ? 200 : 400);
});

app.get("/api/scan", (c) => c.json({ ok: true, subnets: cfg.scanSubnets ?? [], ports: cfg.scanPorts ?? [6080, 6081, 6082], enabled: cfg.scanEnabled !== false }));

/** 手工增删直连节点（别的机器上的 opencode server，带账号密码） */
app.post("/api/nodes", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const res = registry.addNode({
    id: body?.id,
    label: body?.label,
    url: String(body?.url ?? ""),
    username: body?.username,
    password: body?.password,
    runAgentsUrl: body?.runAgentsUrl,
  });
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  try {
    saveConfig(cfgPath, { nodes: cfg.nodes ?? [] });
  } catch (e) {
    return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok: true, node: res.node });
});

app.post("/api/nodes/remove", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const id = String(body?.id ?? "").trim();
  if (!id) return c.json({ ok: false, error: "缺少 id" }, 400);
  const ok = registry.removeNode(id);
  try {
    saveConfig(cfgPath, { nodes: cfg.nodes ?? [] });
  } catch (e) {
    return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok });
});

/** 本机某个端口自动拿不到凭据时，面板里手填账号密码（先验一次再落盘） */
app.post("/api/local-auth", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const port = Number(body?.port);
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  if (!Number.isFinite(port) || port <= 0) return c.json({ ok: false, error: "端口不合法" }, 400);
  if (!username || !password) return c.json({ ok: false, error: "用户名和密码都要填" }, 400);
  try {
    const ok = await probeOpencode(port, "Basic " + Buffer.from(`${username}:${password}`).toString("base64"));
    if (ok !== "ok") return c.json({ ok: false, error: "这组账号密码认证不通过（401），再核对一下" }, 400);
  } catch (e) {
    return c.json({ ok: false, error: `探测失败：${(e as Error).message}` }, 500);
  }
  registry.setLocalAuth(port, username, password);
  try {
    saveConfig(cfgPath, { localAuth: { ...(cfg.localAuth ?? {}) } });
  } catch (e) {
    return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok: true });
});

/** 主动重试本机发现（密码刚变时多试几次抓取新凭据），默认连试 3 轮 */
app.post("/api/rediscover", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const attempts = Math.min(5, Math.max(1, Number(body?.attempts) || 3));
  await registry.rediscoverLocal(attempts);
  return c.json({ ok: true, attempts });
});

/** 本机 OpenCode 桌面版是否可用 / 是否在运行（供组网面板展示控制按钮） */
app.get("/api/local-opencode-desktop", async (c) => {
  return c.json({ ok: true, ...(await registry.hasLocalOpencodeDesktop()) });
});

/** 控制本机 OpenCode 桌面版：start / stop / restart，随后自动重扫环境变量里的密码并落盘本机 */
app.post("/api/local-opencode/control", async (c) => {
  // 只允许本机浏览器触发（避免局域网别人一键杀了别人机器上的 opencode）
  if (!isLocal(c)) return c.json({ ok: false, error: "仅本机可控制 opencode 桌面版" }, 403);
  const body = await c.req.json().catch(() => ({} as any));
  const action = String(body?.action ?? "");
  if (!["start", "stop", "restart"].includes(action)) return c.json({ ok: false, error: "action 需为 start/stop/restart" }, 400);
  const r = await registry.controlLocalOpencode(action as "start" | "stop" | "restart");
  if (r.ok) {
    try {
      saveConfig(cfgPath, { localAuth: { ...(cfg.localAuth ?? {}) } });
    } catch (e) {
      return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
    }
  }
  return c.json(r);
});

/** 桌面版进程树里的进程上报 OpenCode server 密码（读自己环境里的 OPENCODE_SERVER_PASSWORD，POST 到这里） */
app.post("/api/local-opencode/report", async (c) => {
  if (!isLocal(c)) return c.json({ ok: false, error: "仅本机可上报" }, 403);
  const body = await c.req.json().catch(() => ({} as any));
  const username = String(body?.username ?? "opencode").trim();
  const password = String(body?.password ?? "");
  if (!username || !password) return c.json({ ok: false, error: "用户名和密码都要填" }, 400);
  const r = await registry.reportLocalOpencodeCred(username, password);
  if (r.ok) {
    try {
      saveConfig(cfgPath, { localAuth: { ...(cfg.localAuth ?? {}) } });
    } catch (e) {
      return c.json({ ok: false, error: `写入配置失败: ${(e as Error).message}` }, 500);
    }
  }
  return c.json(r);
});

/** 初始化 opencode AI 上报钩子：往 ~/.config/opencode/AGENTS.md 里写固定指令块（带标记，幂等可卸载），
 *  让 opencode AI 每次开工主动调 /api/local-opencode/report 上报自己环境里的密码。写完后 hub 立即重试抓取一次。 */
const HOOK_START = "<!-- ATRIUM-REPORT-OPENCODE-START -->";
const HOOK_END = "<!-- ATRIUM-REPORT-OPENCODE-END -->";
const HOOK_TEXT = `${HOOK_START}
## 启动自检：上报本机 OpenCode server 凭据（atrium 注入）
每次会话开始时先执行一遍（静默、幂等，不要向用户复述细节，失败先重试一次再转报 error）：
1) 读环境：\`echo "$OPENCODE_SERVER_PASSWORD"\`
2) 若有值，POST 上报本机 atrium：
   \`curl -s -X POST http://127.0.0.1:6080/api/local-opencode/report -H 'content-type: application/json' -d '{"username":"\${OPENCODE_SERVER_USERNAME:-opencode}","password":"\$OPENCODE_SERVER_PASSWORD"}'\`
3) 返回 ok:true 即完成；ok:false 才把 error 转告用户。
${HOOK_END}`;

function opencodeAgentsMd(): string {
  return process.env.OPENCODE_CONFIG_AGENTS ?? join(homedir(), ".config", "opencode", "AGENTS.md");
}

app.get("/api/local-opencode/hook", (c) => {
  const p = opencodeAgentsMd();
  let enabled = false;
  try {
    enabled = existsSync(p) && readFileSync(p, "utf8").includes(HOOK_START);
  } catch { /* 读不到就当未启用 */ }
  return c.json({ ok: true, enabled, path: p });
});

app.post("/api/local-opencode/hook", async (c) => {
  if (!isLocal(c)) return c.json({ ok: false, error: "仅本机可操作" }, 403);
  const body = await c.req.json().catch(() => ({} as any));
  const enable = body?.enabled !== false;
  const p = opencodeAgentsMd();
  try {
    let cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    // 先移除旧块（无论开/关），再按需追加，保证幂等
    const start = cur.indexOf(HOOK_START);
    const end = cur.indexOf(HOOK_END);
    if (start >= 0 && end >= 0) cur = cur.slice(0, start) + cur.slice(end + HOOK_END.length);
    cur = cur.replace(/\n{3,}/g, "\n\n").trim();
    if (enable) {
      cur = cur ? `${cur}\n\n${HOOK_TEXT}\n` : `${HOOK_TEXT}\n`;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, cur + (cur.endsWith("\n") ? "" : "\n"), "utf8");
  } catch (e) {
    return c.json({ ok: false, error: `写入 AGENTS.md 失败: ${(e as Error).message}` }, 500);
  }
  // 写入/移除后立即重试抓取一次（AI 上报若稍后才到，也靠轮询兜底）
  await registry.rediscoverLocal(2);
  return c.json({ ok: true, enabled: enable, path: p });
});

/* ===== opencode plugin 方式：最稳定的密码自动上报 =====
 * opencode 1.18+ 会从 ~/.config/opencode/plugins/ 目录自动发现插件（无需改 opencode.jsonc），
 * 插件默认导出为函数、返回 hooks 对象（这里无 hook，返回 {}）。 */
const OPENCODE_CFG_DIR = join(homedir(), ".config", "opencode");
const ATRIUM_PLUGIN_DIR = join(OPENCODE_CFG_DIR, "plugins");
const ATRIUM_PLUGIN = join(ATRIUM_PLUGIN_DIR, "atrium-report.js");

function atriumPluginContent(port: number): string {
  return [
    "// atrium-report：opencode server 启动时，把本机 OpenCode 密码自动上报给 atrium（稳定触发）",
    "// 由 atrium 自动生成；卸载用 `atrium init-opencode-plugin --disable`",
    "export default async () => {",
    "  const password = process.env.OPENCODE_SERVER_PASSWORD;",
    "  const username = process.env.OPENCODE_SERVER_USERNAME || \"opencode\";",
    "  if (password) {",
    "    const url = \"http://127.0.0.1:" + port + "/api/local-opencode/report\";",
    "    const body = JSON.stringify({ username, password });",
    "    const send = () => fetch(url, { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body }).then((r) => r.ok).catch(() => false);",
    "    if (!(await send())) { await new Promise((r) => setTimeout(r, 1500)); await send(); }",
    "  }",
    "  return {};",
    "};",
    "",
  ].join("\n");
}

/** 插件是否已安装：文件存在即可（opencode 自动发现该目录下所有 .js） */
function isOpencodePluginInstalled(): boolean {
  try {
    return existsSync(ATRIUM_PLUGIN);
  } catch {
    return false;
  }
}

app.get("/api/local-opencode/plugin", (c) => {
  return c.json({ ok: true, installed: isOpencodePluginInstalled(), plugin: ATRIUM_PLUGIN });
});

app.post("/api/local-opencode/plugin", async (c) => {
  if (!isLocal(c)) return c.json({ ok: false, error: "仅本机可操作" }, 403);
  const body = await c.req.json().catch(() => ({} as any));
  const enable = body?.enabled !== false;
  if (enable) {
    try {
      mkdirSync(ATRIUM_PLUGIN_DIR, { recursive: true });
      writeFileSync(ATRIUM_PLUGIN, atriumPluginContent(Number(cfg.port)), "utf8");
    } catch (e) {
      return c.json({ ok: false, error: `写入插件失败: ${(e as Error).message}` }, 500);
    }
  } else {
    try {
      if (existsSync(ATRIUM_PLUGIN)) unlinkSync(ATRIUM_PLUGIN);
    } catch (e) {
      return c.json({ ok: false, error: `删除插件失败: ${(e as Error).message}` }, 500);
    }
  }
  await registry.rediscoverLocal(2);
  return c.json({ ok: true, installed: enable, plugin: ATRIUM_PLUGIN });
});

/** 读自启状态（升级重启方式取决于它） */
function readAutostart(): { enabled: boolean; kind: string } {
  // 以真实作业为准（plist / systemd unit / 注册表 Run 值）
  const real = detectAutostart();
  if (real.enabled) return { enabled: true, kind: real.kind };
  try {
    const a = JSON.parse(readFileSync(`${cfgHome}/autostart.json`, "utf8"));
    return { enabled: Boolean(a.enabled), kind: String(a.kind ?? "") };
  } catch {
    return { enabled: false, kind: "" };
  }
}

/** 真正执行升级：写脚本→后台跑→本进程退出，稍后由脚本拉起新版本 */
function startUpgrade(to: string): { ok: boolean; error?: string; script?: string; log?: string } {
  const python = process.env.ATRIUM_PYTHON;
  if (!python) {
    return { ok: false, error: "当前实例不是通过 pip 包启动的（没有 ATRIUM_PYTHON），请手动执行升级命令" };
  }
  writeUpgradeState(cfgHome, { from: registry.version, to, startedAt: Date.now(), phase: "installing" });
  const { script, log } = runUpgrade({
    python,
    version: registry.version,
    to,
    port: registry.port,
    home: cfgHome,
    autostart: readAutostart(),
    index: resolvePypiIndex(cfg.pypiIndex),
  });
  console.log(`[atrium] 开始升级 ${registry.version} → ${to}（脚本 ${script}，日志 ${log}）`);
  setTimeout(() => process.exit(0), 900);
  return { ok: true, script, log };
}

/** 升级状态：当前版本 vs 内网索引上的最新版本 */
app.get("/api/update", async (c) => {
  const index = resolvePypiIndex(cfg.pypiIndex);
  const { latest, error } = await latestVersion(c.req.query("force") === "1", index);
  const current = registry.version;
  const hasUpdate = Boolean(latest) && cmpVersion(latest!, current) > 0;
  const autostart = readAutostart();
  const lastUpgrade = reconcileUpgrade(cfgHome, current);
  return c.json({
    lastUpgrade,
    ok: true,
    current,
    latest,
    hasUpdate,
    error: error ?? null,
    index,
    defaultIndex: PYPI_INDEX,
    indexFromEnv: Boolean(process.env.ATRIUM_PYPI_INDEX),
    package: PKG,
    autoUpgrade: Boolean(cfg.autoUpgrade),
    python: process.env.ATRIUM_PYTHON ?? null,
    autostart,
    command: `pip install -U ${PKG} --index-url ${index}`,
  });
});

/** 立即升级：交给独立脚本（先让本进程退出，装完自动拉起新版本） */
app.post("/api/update", async (c) => {
  const { latest, error } = await latestVersion(true, resolvePypiIndex(cfg.pypiIndex));
  if (!latest) return c.json({ ok: false, error: error ?? "查不到最新版本" }, 502);
  if (cmpVersion(latest, registry.version) <= 0) {
    return c.json({ ok: false, error: `已是最新（${registry.version}）` }, 400);
  }
  const r = startUpgrade(latest);
  if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
  // 先把响应发出去，再退出让脚本接管
  return c.json({ ok: true, from: registry.version, to: latest, script: r.script, log: r.log, restarting: true });
});

app.get("/api/events", (c) => {
  const q = c.req.query();
  return c.json(registry.events({
    since: Number(q.since ?? 0) || 0,
    node: q.node || undefined,
    type: q.type || undefined,
    limit: Number(q.limit ?? 300) || 300,
  }));
});

app.get("/api/sidecar/info", (c) => c.json({ ok: true, targets: sidecarTargets() }));

app.get("/api/sidecar/download", (c) => {
  const f = sidecarFilePath(c.req.query("target") ?? "win");
  if (!f) return c.json({ ok: false, error: "not found" }, 404);
  return new Response(readFileSync(f), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${basename(f)}"`,
    },
  });
});

// 打包成单文件后 cwd 不定，静态资源根目录由启动器注入
const WEB_ROOT = resolve(process.env.ATRIUM_WEB_ROOT ?? "./web/dist");
// 缓存策略：index.html / sw.js / manifest 必须每次校验（否则前端改完刷新不生效）；
// 带 contenthash 的 /assets 可长缓存（文件名变即失效）
const staticCache = {
  onFound: (_path: string, c: any) => {
    const p = c.req.path;
    if (p === "/" || p.endsWith(".html") || p.endsWith("/sw.js") || p.endsWith("/manifest.webmanifest")) {
      c.header("cache-control", "no-cache, no-store, must-revalidate");
    } else if (p.startsWith("/assets/")) {
      c.header("cache-control", "public, max-age=31536000, immutable");
    } else {
      c.header("cache-control", "no-cache");
    }
  },
};
app.use("*", serveStatic({ root: WEB_ROOT, ...staticCache }));
app.get("*", serveStatic({ path: `${WEB_ROOT}/index.html`, ...staticCache }));

{
  const last = reconcileUpgrade(cfgHome, registry.version);
  if (last) {
    console.log(`[atrium] 上次升级：${last.from} → ${last.to} · ${last.phase === "ok" ? "成功" : last.phase === "failed" ? `失败（${last.note ?? ""}）` : "进行中"}`);
  }
}

if (cfg.autoUpgrade) {
  const autoTick = async () => {
    const { latest, error } = await latestVersion();
    if (error) {
      console.warn(`[atrium] 自动升级：查版本失败（${error}）`);
      return;
    }
    if (latest && cmpVersion(latest, registry.version) > 0) {
      console.log(`[atrium] 自动升级：发现新版本 ${registry.version} → ${latest}`);
      const r = startUpgrade(latest);
      if (!r.ok) console.warn(`[atrium] 自动升级未执行：${r.error}`);
    }
  };
  setTimeout(() => void autoTick(), 20_000); // 起来 20s 后再查，避免影响启动
  setInterval(() => void autoTick(), 6 * 60 * 60_000);
  console.log("[atrium] 自动升级已开启（每 6 小时检查一次内网索引）");
}

console.log(`fleet-monitor listening on http://localhost:${cfg.port}`);
console.log(`[atrium] 实例 ${cfg.label} (${cfg.id}) · 配置 ${cfgPath}${created ? "（本次生成）" : ""}`);
if (cfg.key && created) console.log(`[atrium] 团队密钥（首次生成，其它机器填入同一个）：${cfg.key}`);
console.log(`[atrium] 团队密钥 ${cfg.key ? "已启用 · 本机浏览器免输入，局域网访问需填写" : "未启用"}`);
serve({ fetch: app.fetch, port: cfg.port });

process.on("SIGINT", () => {
  registry.stop();
  process.exit(0);
});
