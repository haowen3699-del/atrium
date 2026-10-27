# C · opencode 插件接入：team_kb 工具与 AGENTS.md 摘要注入

> team-designer 系列 C 篇：只定义「opencode 插件 ↔ atrium hub」的接入契约。
> 数据模型/密级/合并语义见 A 篇（`A-teamkb-schema.md`），知识库面板与插件状态卡布局见 B 篇。
> 对齐既有实现：`src/index.ts:516-565`（AGENTS.md 标记块钩子）、`src/index.ts:567-626`（`atrium-report.js` 插件生成/安装）、
> `python/src/atrium/cli.py:304-354`（`init-opencode-hook` / `init-opencode-plugin`）、`web/src/components/Topology.tsx:44-77`（插件状态化面板）、
> `openspec/specs/security-credentials/spec.md`（凭据不出本机）。
> opencode 侧结论均以本机实测版本 **1.18.31** 的源码为准（`github.com/anomalyco/opencode` tag `v1.18.31`），引用处标注文件。

## 1. 目的

A 篇让团队知识「存得下、同步得动、面板里看得见」，但真正干活的是 agent：它不会去点面板。
C 篇把 teamkb 接到 agent 的手边，让知识**在对话里被查到、被用上、被回写**：

- **读**：opencode 里新增 `team_kb_search` / `team_kb_get` 工具，模型动手前能查「这事谁能做、东西在哪、账号找谁、标准干法是什么」，
  不用再靠人把 wiki 链接贴进对话。
- **写**：`team_kb_write` 让模型把本轮得到的结论（新接口、新资源、踩坑后的 SOP）直接归档进 teamkb，
  经 hub 强制密级下限、红线扫描、幂等 upsert、配额与审计——**AI 能写，但写不脏**。
- **摘要注入**：把「全库索引级摘要 + 工具用法 + 硬规则」写进 `~/.config/opencode/AGENTS.md` 的托管块，
  每次请求随系统提示自动生效（`session/instruction.ts` 每轮重读磁盘，改文件即生效、无需重启 opencode），
  解决「模型不知道自己有新工具、也不知道库里有什么」的冷启动问题。
- **密码不进对话**：账号密码默认对 AI 关闭；开启后走 `shell.env` 注入（临时环境变量），
  明文不落对话历史、不上送模型供应商，且每次取用都过 opencode 权限确认 + hub 双侧审计。
- **零新增基础设施、零新增依赖**：插件是单文件纯 JS（只用 `node:` 内建 + 全局 `fetch`），
  由 hub 逐字节写到 `~/.config/opencode/plugins/`，opencode 自动发现（无需改 `opencode.jsonc`、无需 `bun install`）；
  传输复用 A 篇的 HTTP 接口与团队密钥中间件。

非目标：不做向量/全文检索引擎（hub 侧内存过滤即可）、不做 MCP server（后续可把同样 4 个工具以 MCP 暴露给非 opencode 客户端，
但 MCP 要改用户 `opencode.jsonc` + 常驻进程，且拿不到 `shell.env`/`ask`，故首版选插件）、
不做「无人确认的自动归档」（`team_kb_write` 始终由模型显式调用，且默认可要求权限确认）、不接管项目级 `AGENTS.md`（只写全局那一份的托管块）。

## 2. 数据与接口

### 2.1 opencode 1.18.31 的硬约束（读源码得到，设计必须绕着它走）

| # | 事实 | 出处 | 对本设计的影响 |
|---|---|---|---|
| 1 | 本地插件扫描 `{plugin,plugins}/*.{ts,js}`，目录来自全局 `~/.config/opencode` 与项目 `.opencode` | `config/plugin.ts` `Glob.scan` | 写进 `plugins/` 即自动加载，**不改用户 jsonc** |
| 2 | 插件模块的**每个导出**都必须是函数或 `{server: fn}`，否则 `TypeError: Plugin export is not a function`，整个模块作废 | `plugin/index.ts` `getLegacyPlugins` | 插件文件里禁止 `export const VERSION = ...`；版本戳写进首行注释，hub 用正则读回 |
| 3 | 同一函数被 `default` 与具名同时导出时按引用去重；**两个不同函数导出 = 两个插件**，工具会重复注册 | 同上（`seen` Set） | 只保留单一 `export default` |
| 4 | 自定义工具两条来源：插件返回的 `hooks.tool` 映射；`{tool,tools}/*.{js,ts}` 文件（文件名即工具名，多导出为 `文件_导出名`） | `tool/registry.ts` | 选 `hooks.tool`（可与 hub 开关联动、可拿 `PluginInput`） |
| 5 | `args` 若**全是 zod**（`"_zod" in value`）→ `z.object()` → `z.toJSONSchema()`；否则整体走 `legacyJsonSchema()`：把每个值当 JSON Schema，且 **`required` = 全部属性** | `tool/registry.ts` `fromPlugin` | 零依赖写法必须「全参数必填 + 哨兵值（`""`/`0`）」；**zod 与非 zod 混写会把 zod 对象当 JSON Schema 塞进 properties**，必须整工具统一 |
| 6 | 工具返回 `string` 或 `{title, output, metadata, attachments}`；输出经 `truncate.output` 按 agent 上限截断 | `tool/registry.ts` | 插件自己控体积（搜索 ≤2KB、单条 ≤8KB），别指望截断兜底 |
| 7 | `ToolContext` = `{sessionID, messageID, agent, directory, worktree, abort, metadata(), ask()}`；`ask()` 进宿主权限系统 | `@opencode-ai/plugin@1.18.31` `dist/tool.d.ts` | 写/取密码前 `ask()`；待批准项会被 atrium 轮询到，可在看板远程批准（`/api/nodes/:id/permissions/:pid/reply`） |
| 8 | 系统提示装配顺序：`env` → `instructions`(AGENTS.md 等) → `mcp` → `skills`；可触发的 hook 只有 `chat.message`(:999)、`experimental.chat.messages.transform`(:1255)、`shell.env`(:554)、`tool.execute.*`、`experimental.text.complete` 等 | `session/prompt.ts:1255-1269` | **`experimental.chat.system.transform` 类型里有、1.18.31 未接线**，不能当注入主路径；摘要注入走 AGENTS.md 文件 |
| 9 | 全局指令文件只取 `~/.config/opencode/AGENTS.md` 与 `~/.claude/CLAUDE.md` 中**第一个存在的**（`break`）；项目级 findUp `AGENTS.md`→`CLAUDE.md`→`CONTEXT.md`；`config.instructions` 另支持本地 glob 与 http(s) URL（5s 超时，失败当空串） | `session/instruction.ts` | 创建全局 AGENTS.md 会**顶掉** `~/.claude/CLAUDE.md`，安装前必须检测并提示；URL 形式可做「不落盘模式」 |
| 10 | 插件加载失败只记日志/发 session error，不影响 opencode 启动；但 `plugins` 或 `{tool,tools}` 非空时会 `config.waitForDependencies()` | `plugin/index.ts`、`tool/registry.ts`、`config/config.ts:632` | 插件必须「失败即静默降级」；**默认不写 `~/.config/opencode/package.json`**，否则启动会触发 `bun install`（内网无 npm 会拖慢/失败） |
| 11 | `opencode.jsonc` 的 `tools: {"<name>": false}` 会转成 permission `deny` | `config/config.ts:567-578` | 用户可单方面关掉我们的工具；但**首选在插件侧按 hub 配置决定注册哪些工具**（不注册=模型看不见，省 token） |

### 2.2 插件结构与文件布局

```
仓库侧（唯一真源，随 pip 包发布）
  src/opencode/atrium-teamkb.plugin.txt   插件源码（纯文本）；esbuild 默认把 .txt 当 text loader，
                                          --bundle 时内联进 dist/atrium.mjs（见 python/build_wheels.py:76-92），
                                          不必进 pyproject 的 package-data（python/pyproject.toml:35）
  src/opencode/agents-block.ts            replaceMarkedBlock() + 摘要块渲染（与既有 report 钩子共用同一套幂等替换）
  src/teamkb-agent.ts                     hub 侧 /api/teamkb/agent/* 路由：digest/search/write/hint + 红线扫描 + 配额 + 审计

机器侧（atrium 自动写入，用户不手改；卸载只动自己的文件与块）
  ~/.config/opencode/plugins/atrium-teamkb.js   逐字节复制自 .txt（文件内不含端口等机器差异 → 全队字节一致）
  ~/.config/opencode/plugins/atrium-report.js   既有：密码上报插件，保持独立文件，互不影响
  ~/.config/opencode/AGENTS.md                  追加/替换 <!-- ATRIUM-TEAMKB-START/END --> 托管块
```

插件骨架（关键形状，完整实现见落地步骤 2）：

```js
// atrium-teamkb v1 — 由 atrium 自动生成/复制，请勿手改；卸载：atrium init-teamkb-plugin --disable
// 单一 default 导出（约束 2/3）；零 npm 依赖（约束 10）；顶层不抛异常
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export default async ({ directory }) => {
  const hub = await discoverHub();            // env → runtime.json → 探测 6080/6081/6082
  if (!hub) return {};                        // 没有 hub：不注册任何工具，opencode 照常跑
  const cfg = await bootstrap(hub);           // GET /api/teamkb/agent/bootstrap（拿开关/配额/身份）
  if (!cfg?.ok) return {};
  const tool = {};
  tool.team_kb_search = searchTool(hub, cfg);
  tool.team_kb_get    = getTool(hub, cfg);
  if (cfg.allowWrite)  tool.team_kb_write  = writeTool(hub, cfg, directory);
  if (cfg.allowSecret) tool.team_kb_secret = secretTool(hub, cfg);
  return {
    tool,
    // 密码 env 模式：hub 发 60s 一次性 grant，这里把它注入后续 shell（约束 8 的 shell.env）
    ...(cfg.secretMode === "env" ? { "shell.env": shellEnvHook(hub, cfg) } : {}),
    // 可选会话级相关摘要（默认关）
    ...(cfg.hint ? { "chat.message": hintHook(hub, cfg, directory) } : {}),
  };
};
```

### 2.3 运行时：hub 发现、身份与鉴权

发现顺序（全部失败才降级为「不注册工具」）：

```
1) env ATRIUM_URL（+ ATRIUM_KEY）        跨机/非标端口的显式指定，优先级最高
2) runtime.json                          ATRIUM_HOME ?? (win32 ? %APPDATA%\atrium : ~/.atrium)/runtime.json → port
                                         （与 cli.py:144-167 write_runtime/read_runtime 同一份文件）
3) 探测 127.0.0.1:6080/6081/6082 的 /api/node-info，认 app==="atrium"（该路径免密钥，index.ts:36）
```

- **鉴权**：插件与 hub 同机 → loopback → `/api/*` 免密钥（`src/index.ts:43-57` 的 `isLocal` 豁免），密钥不出现在插件里。
  跨机模式（在没装 atrium 的机器上跑 opencode、指向同事的 hub）必须显式给 `ATRIUM_URL` + `ATRIUM_KEY`，走 `x-atrium-key` 头。
- **身份/溯源**：每个请求带 `x-atrium-actor` 头（JSON 字符串）：
  `{via:"opencode-plugin", plugin:"1", opencode:"<version>", session, message, agent, dir}`。
  hub 把它落进 A 篇的 `updatedBy` 与事件流摘要，UI 据此显示「AI 写入 · 会话 xxx」（B 篇）。
- **失败策略**：hub 不可达/超时（1.5s）→ 工具返回**一行人类可读原因**（不抛异常，避免模型无限重试），
  插件内 30s 退避缓存该状态；`abort` 信号透传给 `fetch`。

### 2.4 工具签名（4 个常驻 + 1 个默认不注册）

`args` 采用**零依赖 JSON Schema 写法**（约束 5）：所有参数必填，用 `""` / `0` 作「不过滤/用默认」哨兵，
`description` 里写清；hub 侧再做一次默认值兜底。若用户显式开启 `zodArgs`（需 `@opencode-ai/plugin` 可解析），
插件在 `await import()` 成功后整体切换为 zod 形状（可选参数真正 optional）——**同一工具内绝不混用**。

```js
team_kb_search = {
  description: "搜索团队知识库（capability 项目能力 / resource 开发资源 / account 账号档案 / sop 标准干法）。"
             + "动手前先查：这事谁能做、东西在哪、账号找谁、有没有现成 SOP。只返回索引与摘要，不含密码。",
  args: {
    q:     { type: "string", description: "关键词；空字符串=不过滤（列最近条目）" },
    kind:  { type: "string", enum: ["", "capability", "resource", "account", "sop"], description: "限定类别；空=全部" },
    limit: { type: "number", description: "最多返回条数，0=默认 10，上限 50" },
  },
  // → GET /api/teamkb/agent/search?q=&kind=&limit=&dir=<ctx.directory>
  // 返回纯文本 ≤2KB：每行 `[ent-xxx] capability · 标题 · @属主 · level · 3天前 · 摘要一句`
  // 末行提示：`完整正文用 team_kb_get {id}；还有 N 条未显示`
}

team_kb_get = {
  description: "读取一条团队知识全文（正文 Markdown + 结构化字段 + 属主/密级/更新时间）。"
             + "账号条目只返回档案（系统/用户名/到期/属主），密码用 team_kb_secret。",
  args: { id: { type: "string", description: "条目 id，形如 ent-<instanceId>-<6hex>" } },
  // → GET /api/teamkb/agent/entry/:id
  // 返回 ≤8KB：标题/类别/所属 section/属主(name+contact)/level/at/fields/body；
  // level=internal 时正文原样返回（团队内部可见，A 篇矩阵），但附一行「本条为内部信息，勿外传/勿贴进公开仓库」；
  // level=secret 且非属主机 → 返回「密文在 @属主机 上，本条不可见」
}

team_kb_write = {
  description: "把本轮得到的团队级结论归档进知识库（新接口/新资源/账号档案/SOP 修订）。"
             + "同 kind+section+title 已存在则更新该条，不会重复建条。"
             + "禁止写入任何密码/密钥/token 明文（会被拒）；密码请让人在 atrium 面板录入。",
  args: {
    id:      { type: "string", description: "更新已有条目时填其 id；新建填空字符串" },
    kind:    { type: "string", enum: ["capability", "resource", "account", "sop"], description: "类别" },
    section: { type: "string", description: "所属目录名（≤60 字）；不存在则自动创建，属主=当前实例" },
    title:   { type: "string", description: "标题，≤120 字，一句话说清这是什么" },
    body:    { type: "string", description: "Markdown 正文，≤32KB；空字符串=不改正文" },
    tags:    { type: "string", description: "逗号分隔标签，≤10 个；空字符串=无" },
    level:   { type: "string", enum: ["", "open", "internal"], description: "密级；空=用团队默认（internal）。不接受 secret" },
    source:  { type: "string", description: "这条知识的来源，如「本次排查结论」「用户口述」，写进正文尾部溯源行" },
  },
  // → POST /api/teamkb/agent/entry（body 里带 origin={session,agent,dir,source}）
  // 返回：`已创建 ent-xxx（capability/内网服务，密级 internal）` 或 `已更新 ent-xxx（原值已留存，可在面板撤销）`
  //       被拒时返回 hub 的原因（红线命中/超配额/体积超限/密级不允许），一行，便于模型转述
}

team_kb_secret = {   // 默认不注册（allowSecret=false）
  description: "取回账号条目的密码明文。每次调用都会请求用户批准并在团队事件流留痕；"
             + "仅在必须把密码交给命令时使用，禁止回显、禁止写进文件与提交。",
  args: {
    id:     { type: "string", description: "account 条目 id" },
    reason: { type: "string", description: "为什么需要（会记入审计），如「登录跳板机执行发版脚本」" },
  },
  // 执行前 await ctx.ask({ permission: "teamkb.secret", patterns: [`team_kb_secret:${id}`], always: [...], metadata: {reason} })
  //   → opencode TUI/桌面弹确认，同时出现在 atrium 看板「待批准权限」，可远程批
  // secretMode="text"：→ GET /api/teamkb/entry/:id/secret，返回明文（会进对话历史，故默认不用）
  // secretMode="env" （推荐）：不返回明文，改为向 hub 申请 60s 一次性 grant，
  //   返回 `已授权：本次会话后续 shell 命令可用环境变量 ATRIUM_KB_<SYSTEM>_PASSWORD（60 秒内有效）`
  //   真正注入发生在 shell.env hook（约束 8），密码不进对话历史
}

team_kb_remove = { /* 默认不注册；AI 删知识风险高，改为「面板里人删」（A 篇墓碑语义） */ }
```

`ctx.metadata({title, metadata})` 用法：搜索时 `title = "teamkb: 12 条命中"`，写入时 `title = "已归档：内网 PyPI 上传流程"`，
让 TUI/桌面里的工具卡片可读（B 篇面板同样吃这个 title）。

### 2.5 hub 侧接口（A 篇接口不变，C 篇只**新增** agent 面一层）

新增理由：给模型的形状要 token 友好（纯文本/精简字段）、要强制策略（密级下限、红线、配额）、要溯源审计；
这些不该塞进 A 篇面向 UI 的 `/api/teamkb`。

```
GET  /api/teamkb/agent/bootstrap
  → { ok, hub:{url, instanceId, label, version}, opencode:{compatible:true},
      cfg:{allowWrite, allowSecret, secretMode:"off"|"env"|"text", hint, zodArgs,
           writeLevelFloor:"internal", perSessionWriteLimit, digestAt, digestSha},
      tools:["team_kb_search","team_kb_get","team_kb_write"] }
  插件启动时调一次；loopback 免密钥。跨机时 401 → 插件降级为不注册工具并记一行原因。

GET  /api/teamkb/agent/search?q=&kind=&tag=&limit=&dir=
  → { ok, total, hits:[{id, kind, sectionId, title, level, owner:{name}, at, snippet, checksum}] }
  dir 用于加权：命中 fields.repo/project/tags 与当前工作目录同名的条目排前（A 篇 checksum 复用）

GET  /api/teamkb/agent/entry/:id      → { ok, entry, secretHeld:bool, secretOwner?:string }
POST /api/teamkb/agent/entry          body {id?, kind, section, title, body?, tags?, level?, fields?, origin}
                                      → { ok, id, action:"created"|"updated", at, warnings:[] } | 400/429 + { error }
POST /api/teamkb/agent/section        body {id?, kind, name, desc?, level?, origin} → { ok, id, action }
POST /api/teamkb/agent/hint           body {directory, prompt, limit} → { ok, md }   # 会话级相关摘要，≤1KB
GET  /api/teamkb/agent/digest?mode=index|rich&maxBytes=4096
                                      → { ok, md, at, sha, counts:{capability,resource,account,sop}, truncated }
GET  /api/teamkb/agents.md            → text/markdown（= digest.md；供「不落盘模式」的 config.instructions URL 与人工 curl）
GET  /api/teamkb/agent/grant          → 60s 一次性 secret grant（secretMode=env 时由插件申请，shell.env 消费）

GET  /api/local-opencode/kb-plugin     → { ok, installed, path, version, outdated, agentsMd:{enabled, path, at, bytes},
                                           tools:[...], lastError, hubUrl }
POST /api/local-opencode/kb-plugin     body {enabled, agentsMd?:bool, allowWrite?:bool, allowSecret?:bool}
                                          → 写/删插件文件 + 写/删 AGENTS.md 托管块 + saveConfig（与既有 /plugin 同风格，index.ts:602-626）
GET  /api/snapshot 扩展：self.teamkbAgent = { installed, version, outdated, agentsMdAt, tools, allowWrite, allowSecret, lastError }
POST /api/settings 扩展：teamkbAgent 字段（见 2.7），走 config.ts normalize() 落盘

复用 A 篇：GET /api/teamkb/entry/:id/secret（插件调用时带 x-atrium-actor → 审计 actor=AI/会话）、
          事件流新增 kb.agent.write / kb.agent.denied（A 篇已有 kb.update / kb.secret.reveal）
```

写入侧强制策略（**hub 说了算，不信任插件**）：

| 策略 | 规则 | 命中后 |
|---|---|---|
| 密级下限 | `level` 低于 `writeLevelFloor`（默认 internal）→ 提升；`secret` 一律拒 | 400「AI 写入不接受 secret 密级，请让人在面板录入」 |
| 红线扫描 | title/body 命中 `(?i)(password\|passwd\|pwd\|token\|secret\|api[_-]?key)\s*[:=]\s*\S+`、`sk-[A-Za-z0-9]{16,}`、`AKIA[0-9A-Z]{16}`、`-----BEGIN .*PRIVATE KEY-----` | 400 + 命中位置，提示改走 secret 流程 |
| 幂等 upsert | 同 `(kind, sectionId, title 规范化)` 命中既存条目 → 更新而非新建（保留 id） | `action:"updated"` |
| 配额 | 每会话 ≤ `perSessionWriteLimit`（默认 5）、每实例每小时 ≤ 30 | 429「本会话写入已达上限，请在面板里继续」 |
| 体积 | title ≤120、body ≤32KB、tags ≤10（A 篇） | 400 |
| 可撤销 | 写入前保留 1 版 `prev`，事件流记 `kb.agent.write{entryId, actor}` | 面板「撤销」= prev 覆盖（B 篇） |
| 并发 | 同 entryId 写入串行化，避免 LWW 互相打架（A 篇 2.4） | — |

### 2.6 AGENTS.md 摘要注入

**块格式**（幂等标记沿用既有 report 钩子的做法，`src/index.ts:518-527`；两套标记互不覆盖）：

```markdown
<!-- ATRIUM-TEAMKB-START -->
## 团队知识库 teamkb（atrium 自动注入 · 137 条 · 更新于 10-10 12:03 · 勿手改本块）

你有 3 个工具可用：`team_kb_search`（先查再动手）、`team_kb_get`（读全文）、`team_kb_write`（把新结论归档）。
硬规则：
1) 涉及「谁能做 / 东西在哪 / 用哪个账号 / 标准干法」时，先 `team_kb_search`，别凭记忆编地址和账号。
2) 任何密码/密钥/token 都**不要**写进正文（会被拒）；需要密码用 `team_kb_secret`，且只用于当前命令。
3) 本轮产出的可复用结论（新接口、新资源、SOP 修订）用 `team_kb_write` 归档，密级默认 internal。
4) 摘要是索引不是全文：正文一律用 `team_kb_get` 取，别把摘要当权威。

### 项目能力 capability（42）
- ebao_jk_kb_v1 · 知识库检索服务 · active · @张三
- atrium · AI 机队看板 · active · @李四
### 开发资源 resource（31）
- 内网 PyPI · registry · https://pypi.org/... · @王五
- 测试库 pg-test-01 · database · prod 禁写 · @赵六
### 账号档案 account（18）— 密码不在这里
- 跳板机 jump-01 · robot_deploy · totp · 12 天后到期 · @张三
### 技能 SOP（12）
- 发版流程（触发：发版前）· 磁盘告警处理（触发：df >85%）
…还有 96 条：用 `team_kb_search` 查；面板 http://127.0.0.1:6080/ → 知识库
<!-- ATRIUM-TEAMKB-END -->
```

- **预算**：默认 `mode:"index"`、`maxBytes:4096`、`topPerKind:8`；超出按 kind 均分截断并输出「…还有 N 条」。
  只列 `标题 · 一句摘要 · 状态/类型 · @属主`，**不含正文**（4KB 中文 ≈ 1.5k token，可接受；`rich` 模式含 SOP steps，默认关）。
  `account` 段永不含密码与密文明文，只含档案字段（A 篇矩阵）。
- **排序**：置顶（teamMeta）→ 与本机常用工作目录相关（`fields.repo`/`project` 命中）→ `at` 新→旧；
  到期 ≤14 天的 account 强制入摘要（复用值班提醒口径）。
- **刷新时机**：teamkb 变更（本机写 / peer 快照合并 / 墓碑清理）→ debounce 3s → 渲染 → 与磁盘现块比 sha256 →
  **不同才写**（避免每 5s 轮询把系统提示反复改动、打破 provider 的 prompt 缓存）；插件启动 bootstrap 时校验
  `digestSha`/插件版本不一致就重写；面板开关立即生效。写入频率上限 1 次/5 分钟（可配）。
- **实现**：`replaceMarkedBlock(file, START, END, text)` 抽成公共函数，report 钩子与 teamkb 块共用
  （现实现是整文件 indexOf 切除 + 追加 + `\n{3,}` 归并，`src/index.ts:548-558`，重构后两块互不影响）。
  卸载 = 只切除本块并归一空行，**不删用户文件**；文件原本不存在且块为空 → 删掉空文件，恢复 `~/.claude/CLAUDE.md` 生效。
- **安装前检测**（约束 9）：若 `~/.claude/CLAUDE.md` 存在而 `~/.config/opencode/AGENTS.md` 不存在，
  面板必须提示「创建 AGENTS.md 后 opencode 将不再读取 CLAUDE.md」，并提供「把 CLAUDE.md 内容并入 AGENTS.md 顶部」的一键动作。
- **可选：不落盘模式** `agentsMd:"url"` → 不写文件，改为在 `opencode.jsonc` 的 `instructions` 里加
  `http://127.0.0.1:6080/api/teamkb/agents.md`（`instruction.ts` 每轮 fetch，5s 超时、失败当空串）。
  优点是永远实时、不碰用户 md；缺点是要改用户 jsonc、hub 没起时静默为空。默认仍用文件块。
- **不用 hook 注入系统提示的原因**：`experimental.chat.system.transform` 在 1.18.31 未接线（约束 8）；
  `chat.message` 注入的 part 会落库进会话历史（用户可见、参与压缩、结构校验严格），只适合做**可选的会话级 hint**
  （`hint:true` 时用 `directory` + 用户提问调 `/agent/hint`，注入 ≤1KB 的 `<team_kb>` 相关条目，默认关）。

### 2.7 配置示例

atrium 侧 `~/.atrium/config.json`（新增 `teamkbAgent`，经 `config.ts normalize()` + `POST /api/settings`）：

```jsonc
{
  "teamkbAgent": {
    "enabled": true,               // 总开关：插件 + 摘要注入（关掉即卸载两者）
    "plugin": true,                // 是否安装 opencode 插件（提供工具）
    "agentsMd": "index",           // off | index | rich | url（不落盘模式）
    "agentsMdMaxBytes": 4096,
    "topPerKind": 8,
    "allowWrite": true,            // 注册 team_kb_write
    "askOnWrite": false,           // 写入前是否也走 opencode 权限确认
    "writeLevelFloor": "internal", // AI 写入的密级下限
    "perSessionWriteLimit": 5,
    "allowSecret": false,          // 注册 team_kb_secret（默认不给 AI 取密码）
    "secretMode": "env",           // off | env（推荐，不进对话历史）| text
    "hint": false,                 // 会话级相关摘要注入（chat.message）
    "zodArgs": false               // 仅当 @opencode-ai/plugin 可解析时开启（会写 package.json，触发 bun install）
  }
}
```

opencode 侧（**通常什么都不用写**——插件自动发现；以下为可选加固/覆盖）：

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "tools": { "team_kb_secret": false },        // 用户单方面禁用某工具（config.ts:567-578 → permission deny）
  "instructions": ["http://127.0.0.1:6080/api/teamkb/agents.md"]  // agentsMd:"url" 模式由 atrium 自动写入
}
```

```bash
# 跨机：opencode 跑在没装 atrium 的机器上，指向同事的 hub（密钥只进环境变量，不落文件）
setx ATRIUM_URL http://10.253.3.21:6080 && setx ATRIUM_KEY <团队密钥>

atrium init-teamkb-plugin             # 安装插件 + 写摘要块（幂等；hub 不在则报错并给启动提示）
atrium init-teamkb-plugin --status    # 版本/是否落后/摘要更新时间/已注册工具/lastError
atrium init-teamkb-plugin --disable   # 卸载：删插件文件 + 切除 AGENTS.md 托管块（不动用户其它内容）
```

CLI 复用 `cli.py:331-354` 的骨架（读 runtime.json/config 拿端口 → POST 本机 hub → 打印结果）。

### 2.8 时序（三条主路径）

```
读：  模型 → team_kb_search → hub /agent/search（loopback 免密钥，带 actor 头）→ 精简列表
      → team_kb_get → /agent/entry/:id → 全文（internal 直出；secret 只回「密文在 @属主机」）
写：  模型 → team_kb_write →（askOnWrite 时先 ctx.ask）→ hub 红线扫描/密级下限/幂等/配额
      → A 篇 setKbEntry（落盘 + LWW + publish SSE）→ 事件流 kb.agent.write → debounce 重写 AGENTS.md 块
      → peer 下一轮快照自然拿到（A 篇 2.4，无需新通道）
密码：模型 → team_kb_secret → ctx.ask（opencode 弹窗 + atrium 看板可远程批）→ hub /agent/grant（60s 一次性）
      → 模型执行 bash → shell.env hook 消费 grant → 环境变量注入子进程（明文不进对话历史）
      → hub 记 kb.secret.reveal（A 篇）；grant 未消费 60s 后失效
```

## 3. 落地步骤

依赖：步骤 1 依赖 A 篇落地步骤 1–3（类型/存储/Registry/API）；步骤 2–5 可在 A 篇步骤 4（前端）之前并行。

1. **hub agent 接口层**（1 天）：新增 `src/teamkb-agent.ts` —— bootstrap / search / entry / section / hint / digest /
   agents.md / grant；红线扫描、密级下限、幂等 upsert、配额、`x-atrium-actor` 解析与审计（`kb.agent.write` / `kb.agent.denied`）；
   `index.ts` 挂路由（沿用团队密钥中间件 + `isLocal` 豁免）。单测：红线命中矩阵、幂等 upsert、配额、level 提升。
2. **插件源码**（1 天）：`src/opencode/atrium-teamkb.plugin.txt` + `src/types/text.d.ts`（`declare module "*.txt"`，
   否则 `npm run typecheck` 不过）+ `src/opencode/plugin.ts`（读文本、版本戳正则、写/删文件、状态探测）。
   4 个工具 + hub 发现 + 退避 + `ask()`；本机手测：`opencode` 里 `/tools` 能列出、调用返回正常、
   hub 停掉时工具优雅报错且 opencode 不崩、`plugins/` 下没有多余导出（约束 2）。
3. **摘要块与刷新**（0.5 天）：抽 `replaceMarkedBlock()`，report 钩子改用它（回归既有密码上报）；
   digest 渲染（预算/排序/截断）+ sha 比对 + debounce + 频率上限；`GET/POST /api/local-opencode/kb-plugin`；
   `snapshot().self.teamkbAgent`。CLAUDE.md 冲突检测。
4. **CLI + 面板**（0.5 天，面板视觉归 B 篇）：`atrium init-teamkb-plugin [--status|--disable]`；
   面板「知识库插件」状态卡（未装/已装/版本落后一键重装/摘要更新时间与字节数/工具开关/lastError），
   复用 `Topology.tsx:44-77,284-300` 的状态化写法。
5. **secret env 模式**（0.5 天）：hub 一次性 grant（60s、绑定 entryId+sessionID、消费即失效）+ 插件 `shell.env` 注入
   + `kb.secret.reveal` 双侧审计；`text` 模式加显式警告文案。
6. **openspec**（0.5 天）：新增 `openspec/specs/agent-integration/spec.md`（Purpose + Requirement/Scenario：
   插件零依赖与静默降级、AI 不得写 secret、写入策略与可撤销、注入块幂等可卸载且不破坏用户内容、
   摘要预算与刷新、secret env 模式不落对话历史、跨机需显式密钥）；`openspec/changes/team-kb-agent/` 加 proposal + tasks；
   分级 **Critical**（触碰凭据边界 + 修改用户全局 AGENTS.md，按 `openspec/config.yaml` 规则）。
7. **收尾**：README「界面/仓库结构」补一句插件与摘要块；`npm run typecheck && npm run build`；
   双机实测矩阵（下表）通过后 bump 版本发布。

实测矩阵（步骤 7 前逐条过）：hub 未启动 / hub 换端口（6081）/ 跨机带密钥 / 用户 AGENTS.md 已有大量自有内容 /
只有 `~/.claude/CLAUDE.md` / opencode CLI + TUI + 桌面版三形态 / 插件与 report 插件共存 / 卸载后文件与块干净 /
写入命中红线 / 超配额 / secret ask 被拒 / 摘要 >4KB 截断 / 两机同时 AI 写同一条（LWW 收敛）。总量约 4–4.5 人日。

## 4. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **opencode 版本漂移**：hook 名/工具注册方式变化（`experimental.chat.system.transform` 类型里有却未接线就是先例） | 插件静默失效 | 只依赖稳定面（`hooks.tool` + AGENTS.md 文件 + `shell.env`）；bootstrap 上报 opencode 版本，hub 侧维护兼容矩阵并在面板标「未验证版本」；插件版本戳 + `outdated` 提示一键重装 |
| **改了用户全局 AGENTS.md**（用户文件被程序写） | 用户反感/内容被破坏 | 标记块幂等、只增删自己的块、卸载不删文件、面板给预览与字节数、提供 `agentsMd:"url"` 不落盘模式；写入前读原文 sha，异常（无写权限/被外部并发改）只记 lastError 不重试轰炸 |
| 创建 AGENTS.md 导致 `~/.claude/CLAUDE.md` 被忽略（`instruction.ts` 的 `break`） | 用户既有规则静默失效 | 安装前检测并显式提示 + 一键把 CLAUDE.md 内容并入 AGENTS.md 顶部；卸载时若文件仅剩我们的块则删文件恢复原状 |
| **摘要撑爆上下文 / 打破 prompt 缓存** | 每轮 token 成本上升、变慢 | 预算 4KB + topN + 只索引不含正文；sha 相同不写；写入频率上限 1 次/5 分钟；`agentsMd:"off"` 一键关 |
| **AI 灌垃圾/重复条目**，知识库被污染 | 团队不再信任 kb | 幂等 upsert（同标题更新而非新建）、配额、密级下限、`prev` 一版可撤销、UI 标「AI 写入」并可按来源筛选/批量回滚 |
| AI 把密码写进正文 | 密码进快照、全队可见 | hub 红线扫描拒写（不依赖模型自觉）；`team_kb_write` 的 `level` 不接受 secret；面板提示人工录入到密文区（A 篇 2.3） |
| **明文密码进对话历史 / 上送模型供应商** | 凭据外泄到第三方 | 默认 `allowSecret:false`；开启后默认 `secretMode:"env"`（走 `shell.env`，明文不落历史）；`text` 模式需显式选择且带警告；每次取用 `ctx.ask` + `kb.secret.reveal` 双侧留痕 |
| 插件加载失败影响 opencode 启动 | agent 全线不可用 | 零依赖、顶层不抛、所有 await 包 try、失败 `return {}`；opencode 本身隔离插件错误（`plugin/index.ts` 只记日志） |
| 一旦写 `~/.config/opencode/package.json` 就触发 `bun install` | 内网无 npm 时启动变慢/失败 | 默认零依赖不写 package.json；`zodArgs` 为显式可选项，开启前 hub 先探测 `@opencode-ai/plugin` 是否已可解析，不可解析则拒绝开启并说明 |
| loopback 免密钥 = 本机任意进程可读 internal 知识 | 本机横向泄露 | 与既有信任模型一致（本机进程本就能读 `~/.atrium/`）；secret 仍需 ask + 审计；可选加固 `ATRIUM_AGENT_TOKEN`（hub 生成，写进 600 权限的 `~/.atrium/agent-token`，插件读取后带头） |
| 同机多 hub（6080 被占顺延到 6081/6082） | 插件连错实例 | runtime.json 优先、探测兜底并校验 `app==="atrium"`；工具输出与面板状态里显示实际 hubUrl 便于排查 |
| 工具名与其它插件/自定义工具冲突 | 行为被覆盖（同名插件工具优先） | 统一 `team_kb_` 前缀；文档约定；面板提示「若你另有同名工具请改名」 |
| 模型滥用搜索导致 hub 压力 | 面板卡顿 | 插件侧 300ms 内重复同参去重 + hub 侧每会话 QPS 上限；搜索 `limit` 上限 50 |
