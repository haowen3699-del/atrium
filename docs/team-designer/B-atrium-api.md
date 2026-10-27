# B · 后端 API 设计 — atrium × teamkb（团队知识库）

> 角色：B（后端 API）。范围：atrium hub（`src/index.ts` Hono 服务 + `src/registry.ts` FleetRegistry）为 teamkb 提供的
> 读写 / 检索 / 权限 / 跨实例同步端点。前端交互见 C 文档，产品需求见 A 文档；本文只约束后端契约。
>
> 变更分级（openspec 规则）：**Critical** —— 引入新的密级鉴权模型与新的持久化数据域，
> 需要新增 `openspec/changes/teamkb/` 提案与 `openspec/specs/teamkb/spec.md`。

---

## 1. 目的

atrium 目前是"机队状态看板"：快照、会话、事件都是易逝的运行时数据，机器重启即散。
teamkb（team knowledge base）给机队补上**沉淀层**：

1. **团队共享知识库**：同一个团队密钥组网的所有 atrium 实例，共享一库 Markdown 知识条目
   （排障手册、环境说明、约定规范、agent 使用心得……），任何一台可读写，条目在机队内自动收敛。
2. **可检索**：全文检索（含中文）+ 标签/时间过滤，供 UI 与 agent 快速召回；
   agent 可以直接 `curl` 本机 `127.0.0.1:6080/api/teamkb/search` 查团队知识，与现有
   `AGENTS.md` 钩子（`src/index.ts` 的 `HOOK_TEXT`）同一使用姿势。
3. **密级分层**：条目带密级（0~3），请求方凭"密级密钥"取得对应 clearance；
   低密级视角**看不见**高密级条目的存在（列表/检索静默过滤），高敏内容可配置为**不出本机**（不参与机队复制）。
4. **零新依赖**：复用现有技术栈——Hono 路由、团队密钥中间件、`node:sqlite`（registry.ts 已在用
   `DatabaseSync` 读 opencode DB）、peer 轮询合并（teamMeta 的 LWW 先例）、`saveConfig` 落盘。

非目标（本期不做，见 §8 演进）：成员账号体系、条目级 ACL、评论/协作编辑、附件二进制存储、加密落盘。

---

## 2. 与现有代码的对齐点（风格约定）

新代码必须长成现有代码的样子，逐条对照：

| 现有约定 | 出处 | teamkb 沿用方式 |
| --- | --- | --- |
| 所有写操作用 `POST` + 动词后缀（`/remove`、`/update`），不用 PUT/DELETE/PATCH | `app.post("/api/nodes/remove")`、`/api/team-meta` | `POST /api/teamkb/docs/:id/update`、`/:id/remove` |
| 响应一律 JSON：`{ ok: true, ... }` / `{ ok: false, error: "中文原因" }` | 全部路由 | 同 |
| 状态码：400 参数/超限、401 无团队密钥、403 本机限定、404 不存在、502 对端失败；诊断类信息可 200 + 原因 | `index.ts:173,248,483,711,183` | 增加 409（版本冲突），其余沿用 |
| body 解析容错：`await c.req.json().catch(() => ({} as any))` | 全部 POST 路由 | 同 |
| 入参收敛：`String(body?.x ?? "").trim().slice(0, N)`、数值 `Math.min/Math.max` 夹取 | `setSessionTitle`、`/api/scan` | 同 |
| 鉴权：`/api/*` 中间件团队密钥（`x-atrium-key` 头 / `key` query），loopback 免密钥 | `index.ts:43-57` | teamkb 路由挂在同一中间件之后，天然继承 |
| 本机限定操作用 `isLocal(c)` 拦截并 403 | `/api/local-opencode/control` | ACL 管理端点同 |
| 配置热改：registry 改内存 → `saveConfig(cfgPath, {...})` 落盘 → 失败 500 | `/api/team-meta`、`/api/settings` | `teamkb` 配置节同 |
| 团队数据 LWW 合并：值 + `at` 时间戳，新者赢 | `TeamMetaEntry`、`registry.teamMeta()` | 条目用 `(updatedAt, version, origin)` 三元组 LWW |
| peer 拉取带 `peerHeaders()`（x-atrium-key），8s 轮询，快照一跳合并（`::` 前缀防套娃） | `registry.ts:1015-1051,1558-1593` | KB 同步走独立 digest→delta 通道（§6），不塞进 snapshot |
| 类型集中在 `src/types.ts`，中文 JSDoc | 全文件 | `KbDoc` 等同款注释风格 |
| 数据目录 `~/.atrium/`（Windows `%APPDATA%\atrium`） | `config.ts:12-16` | 库文件 `~/.atrium/teamkb.db` |

---

## 3. 数据模型与存储

### 3.1 存储选型

SQLite（`node:sqlite` 的 `DatabaseSync`，wheel 已内置 Node 运行时，实测 SQLite 3.50.4，**FTS5 可用**），
文件 `join(userConfigDir(), "teamkb.db")`，WAL 模式。理由：

- registry.ts 已经依赖 `node:sqlite`，零新增依赖；
- 单文件、可备份、可随 `~/.atrium` 迁移；
- FTS5 提供 ranked 全文检索 + `trigram` 分词器对 CJK 友好（unicode61 不分中文词）；
- 知识条目是"文档 + 元数据"，天然关系型；config.json 塞大文本会拖垮现有 `saveConfig` 全量重写。

> 注意：`node:sqlite` 仍是 experimental（启动会打 ExperimentalWarning）。运行时由 wheel 固定 Node 版本，
> API 漂移风险可控；teamkb 模块内所有 SQL 访问收口在 `src/teamkb.ts` 一个文件，将来换驱动只动这里。

### 3.2 表结构

```sql
-- 知识条目（软删除：deleted=1 为墓碑，peer 合并必需）
CREATE TABLE IF NOT EXISTS kb_doc (
  id         TEXT PRIMARY KEY,        -- kb-<16hex>，创建时生成，全机队唯一
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',-- Markdown 正文
  level      INTEGER NOT NULL DEFAULT 0,  -- 密级 0..3
  tags       TEXT NOT NULL DEFAULT '[]',  -- JSON 数组字符串
  author     TEXT NOT NULL DEFAULT '',    -- 自报的提交人显示名（可为空）
  origin     TEXT NOT NULL DEFAULT '',    -- 创建该条目的 hub 实例 id（cfg.id），合并溯源用
  version    INTEGER NOT NULL DEFAULT 1,  -- 每次写 +1，乐观锁 & LWW 依据
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,            -- ms 时间戳，LWW 主排序键
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kb_updated ON kb_doc(updated_at);
CREATE INDEX IF NOT EXISTS idx_kb_level   ON kb_doc(level, deleted);

-- 全文索引：contentless 外联表，写入路径手动同步（触发器亦可，实现时二选一）
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  title, body, tags,
  content='kb_doc', content_rowid='rowid',
  tokenize='trigram'                     -- CJK 子串可检；<3 字的查询走 LIKE 兜底
);
```

FTS5 建表失败（极端环境）→ 降级标记 `fts=false`，检索走 `LIKE '%q%'` 扫描（库配额 §3.5 保证规模可控），
行为差异仅"无 ranked 分数、无 snippet 高亮"，接口形状不变（`score=null`、`excerpt` 取正文前 200 字）。

### 3.3 TypeScript 类型（追加到 `src/types.ts`）

```ts
/** 密级：0 团队公开 / 1 内部 / 2 机密 / 3 绝密（数值即比较序，clearance ≥ level 才可读） */
export type KbLevel = 0 | 1 | 2 | 3;

/** teamkb 知识条目（完整体，含正文；列表/检索用 KbDocMeta 瘦身版） */
export interface KbDoc {
  id: string;
  title: string;
  body: string;
  level: KbLevel;
  tags: string[];
  /** 自报的提交人显示名（无账号体系，不做真实性承诺） */
  author: string;
  /** 创建该条目的 hub 实例 id，peer 合并溯源/去重用 */
  origin: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

/** 列表/检索命中：不带 body，带摘要（检索时是 FTS snippet） */
export interface KbDocMeta {
  id: string;
  title: string;
  level: KbLevel;
  tags: string[];
  author: string;
  origin: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** 正文摘要或检索片段（已按调用方 clearance 过滤后才生成） */
  excerpt?: string;
  /** FTS 相关度（LIKE 兜底时为 null） */
  score?: number | null;
}
```

### 3.4 配置（`FleetConfig` 追加 `teamkb` 节，`config.ts normalize()` 补默认）

```ts
export interface FleetConfig {
  // ...现有字段不动...
  /** 团队知识库设置（缺省即启用；密钥哈希与同步上限只存本机，绝不进快照/不同步） */
  teamkb?: {
    enabled?: boolean;                  // 默认 true
    /** 参与机队复制的最高密级：level > 此值的条目只存本机（默认 3 = 全同步） */
    syncMaxLevel?: KbLevel;
    /** 密级密钥：level -> sha256(key)。只存哈希，明文密钥发完即弃 */
    levelKeys?: Partial<Record<1 | 2 | 3, string>>;
    /** 单条正文上限字节（默认 2MB，对齐项目图标 6MB 拒绝的先例） */
    maxBodyBytes?: number;
  };
}
```

### 3.5 配额（防同步风暴 / 库膨胀，全部返回 400 + 中文原因）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 单条 title | ≤ 200 字符 | `slice(0, 200)` 静默截断（对齐现有 title 处理） |
| 单条 body | ≤ 2 MB | 超限 400 `"正文太大（>2MB）"` |
| tags | ≤ 16 个，每个 ≤ 40 字符 | 超限截断 |
| 全库条目 | ≤ 5000 | 超限拒写 400 `"知识库已满"`（软删除不计数） |
| 全库体积 | ≤ 512 MB | 同上 |

---

## 4. 密级与鉴权设计

### 4.1 身份模型：密钥即身份（对齐 atrium 无账号哲学）

atrium 没有用户体系，信任边界是团队密钥。teamkb 在其上加一层**分级密钥**：

- **团队密钥**（现有 `cfg.key`）：进门钥匙，clearance = 0（团队公开级）。
- **密级密钥**（新，每级一把独立随机密钥，管理员本机生成、线下分发，"其它机器/成员填同一个"——
  与团队密钥的分发哲学一致）：持有 L 级密钥 → clearance = L。密钥不落盘明文，config 只存 sha256。
- **loopback**：本机即管理员，clearance = 3（对齐现有 `isLocal` 免密钥哲学：能登上这台机器的人本来就拥有这台机器的一切）。

请求携带方式：

```
x-atrium-key: <团队密钥>        # 现有中间件，必须先过
x-teamkb-key: <密级密钥>        # 新增，可选；GET 也支持 ?kbkey=（对齐 EventSource 的 key= 先例）
```

**clearance 判定**（每请求计算，`clearanceOf(c): KbLevel`）：

```
isLocal(c)                          → 3
x-teamkb-key 命中 levelKeys[L]      → L（sha256 比对，恒定时间）
仅有团队密钥                        → 0
```

> 为什么不复用团队密钥字段传密级密钥：团队密钥是 peer 互信与 snapshot 拉取的凭证，
> 混用会让"填了 L2 密钥的浏览器"在现有中间件处 401。两把钥匙各走各的头，中间件零改动。

### 4.2 操作 × 权限矩阵

| 操作 | 规则 | 不满足时 |
| --- | --- | --- |
| 列表 / 检索 | 结果**静默过滤** `level > clearance` 的条目（不出标题、不出计数、不出 snippet——低密级视角不能感知高密级条目的存在） | —（无需报错） |
| 按 id 读单条 | `clearance ≥ doc.level` | 403 `{ ok:false, error:"密级不足", need:doc.level, have:clearance }`（团队密钥持有者是内部人，允许知道"存在但看不了"，与列表静默过滤的差异是有意为之，见 §8 风险 6） |
| 新建 | `level ≤ clearance`（缺省 level=0） | 400 `"不能创建高于自己密级的条目"` |
| 改 title/body/tags | `clearance ≥ doc.level` | 403 同上 |
| 改 level（升/降级） | `clearance ≥ max(旧level, 新level)` | 403 同上 |
| 删除（软） | `clearance ≥ doc.level` | 403 同上 |
| ACL 管理（§5.4） | `isLocal(c)` | 403 `"仅本机可管理密级"`（对齐 `/api/local-opencode/control` 文案风格） |
| 同步端点（§5.5） | 团队密钥（现有中间件）+ 双方 `syncMaxLevel` 过滤 | 401 由中间件给出 |

写操作审计字段：`author`（自报显示名）+ `origin`（hub id）+ 请求源 IP 记入日志行
（`console.log("[atrium] teamkb: ...")` 风格），本期不做独立审计表。

### 4.3 密级与复制域（syncMaxLevel）

高密级 ≠ 必须全机队可见。每台 hub 独立配置 `syncMaxLevel`（默认 3）：

- **发送侧**：`/api/teamkb/sync` 只吐 `level ≤ 本机 syncMaxLevel` 的条目；
- **接收侧**：merge 时丢弃 `level > 本机 syncMaxLevel` 的条目（双保险，防对端配置漂移）；
- `level > syncMaxLevel` 的条目**只存本机**：本机 UI/agent 照常读写，peer 永远拉不到。
  典型用法：涉密机器把 `syncMaxLevel` 设为 1，机密/绝密条目天然隔离在单机。

密级标签文案（UI 展示用，后端 `/api/teamkb/meta` 下发，前端不硬编码）：

| level | label | 默认色（建议给 C） |
| --- | --- | --- |
| 0 | 团队公开 | 灰 |
| 1 | 内部 | 蓝 |
| 2 | 机密 | 橙 |
| 3 | 绝密 | 红 |

---

## 5. REST 接口设计

全部挂在 `/api/teamkb/*`，自动继承 `/api/*` 团队密钥中间件（401 `{ ok:false, error:"unauthorized", needKey:true }`
由现有中间件给出，下文不再重复）。所有时间戳为 ms epoch。示例中的 `error` 均为中文（现有文案风格）。

### 5.0 总览

| # | 方法 & 路径 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| 1 | `GET /api/teamkb/meta` | 能力/密级/统计自描述（UI 引导） | 团队密钥 |
| 2 | `GET /api/teamkb/docs` | 列表浏览（过滤 + 分页） | 团队密钥 + clearance 过滤 |
| 3 | `GET /api/teamkb/docs/:id` | 单条全文 | clearance ≥ level |
| 4 | `GET /api/teamkb/search` | 全文检索（FTS5，带 snippet） | 团队密钥 + clearance 过滤 |
| 5 | `POST /api/teamkb/docs` | 新建 | level ≤ clearance |
| 6 | `POST /api/teamkb/docs/:id/update` | 更新（乐观锁） | clearance ≥ level |
| 7 | `POST /api/teamkb/docs/:id/remove` | 软删除 | clearance ≥ level |
| 8 | `GET /api/teamkb/acl` | 密级设置现状 | 仅 loopback |
| 9 | `POST /api/teamkb/acl/level-key` | 设/清某级密级密钥 | 仅 loopback |
| 10 | `POST /api/teamkb/acl/sync-max-level` | 设机队复制上限 | 仅 loopback |
| 11 | `GET /api/teamkb/digest` | 库摘要（peer 变更探测） | 团队密钥 |
| 12 | `GET /api/teamkb/sync` | 增量拉取（peer 合并） | 团队密钥 + syncMaxLevel |
| 13 | `POST /api/teamkb/sync/push` | 写后即时推送（phase 2，可选） | 团队密钥 + syncMaxLevel |

### 5.1 `GET /api/teamkb/meta` — 自描述

UI 首屏渲染密级选择器、统计角标、"本机是否管理员"判断都靠它，一次给全（对齐 `/api/help` 的风格）。

```jsonc
// 200
{
  "ok": true,
  "enabled": true,
  "clearance": 2,                 // 本请求方的有效密级（loopback 恒为 3）
  "admin": true,                  // isLocal：UI 据此显示密级管理入口
  "levels": [                     // 文案后端下发，前端零硬编码
    { "level": 0, "label": "团队公开" },
    { "level": 1, "label": "内部", "keySet": true },
    { "level": 2, "label": "机密", "keySet": true },
    { "level": 3, "label": "绝密", "keySet": false }   // keySet=false：该级密钥未设，无人能到该级（loopback 除外）
  ],
  "syncMaxLevel": 3,
  "count": 128,                   // clearance 可见范围内的条目数
  "maxUpdatedAt": 1760000000000,  // 全库（不过滤）最后写入时间，snapshot 摘要同源
  "fts": true,                    // false = LIKE 兜底模式（UI 可提示"检索为简易匹配"）
  "limits": { "maxBodyBytes": 2097152, "maxDocs": 5000, "maxTags": 16 }
}
```

### 5.2 `GET /api/teamkb/docs` — 列表浏览

Query（全部可选）：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `tag` | string | 精确匹配单个标签（重复传 = OR） |
| `level` | 0..3 | 精确密级（仍受 clearance 上限约束） |
| `author` | string | 子串匹配 |
| `q` | string | 标题/正文子串过滤（LIKE；要 ranked 检索用 `/search`） |
| `since` | ms | 只列 `updatedAt > since` 的（UI 增量刷新） |
| `includeDeleted` | `1` | 管理员（clearance=3 且 loopback）可见墓碑，默认不列 |
| `limit` | 1..200 | 默认 50 |
| `cursor` | string | 上一页返回的 `nextCursor`（`updatedAt_id` 复合游标，稳定分页） |

排序固定 `updatedAt DESC`。响应：

```jsonc
// 200
{
  "ok": true,
  "docs": [
    {
      "id": "kb-3f2a9c01d4e5b6a7",
      "title": "内网 PyPI 发布流程",
      "level": 1,
      "tags": ["发布", "pypi"],
      "author": "老王",
      "origin": "macbook-a1b2c3d4",
      "version": 3,
      "createdAt": 1759900000000,
      "updatedAt": 1759990000000,
      "excerpt": "twine upload 前先用 build_wheels.py 出三平台 wheel…"  // 正文前 200 字（去 Markdown 标记）
    }
  ],
  "total": 128,            // clearance 内匹配总数（非本页条数）
  "nextCursor": "1759990000000_kb-3f2a9c01d4e5b6a7",   // 无更多则 null
  "now": 1760000000000
}
```

### 5.3 `GET /api/teamkb/docs/:id` — 单条全文

```jsonc
// 200
{ "ok": true, "doc": { /* KbDoc 完整体，含 body */ } }

// 404（不存在，或已软删除）
{ "ok": false, "error": "条目不存在" }

// 403（密级不足——存在但看不了）
{ "ok": false, "error": "密级不足", "need": 2, "have": 0 }
```

### 5.4 检索 `GET /api/teamkb/search`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `q` | 是 | 检索词；空/全空白 → 400 `"缺少 q"` |
| `tag` / `level` / `limit` | 否 | 同列表；limit 默认 20，上限 100 |

实现：`q ≥ 3` 字符 → FTS5 `MATCH`（trigram，天然支持中文子串）按 `bm25()` ranked；
`q < 3` 字符或 FTS 降级模式 → LIKE 扫描，`score=null`。
**snippet 只对已通过 clearance 过滤的命中生成**（先滤后摘，杜绝高密级内容借片段泄露）。

```jsonc
// 200
{
  "ok": true,
  "hits": [
    {
      "id": "kb-9e8d7c6b5a4f3e2d",
      "title": "atrium 组网排障手册",
      "level": 0,
      "tags": ["组网", "排障"],
      "author": "", "origin": "win-dev-01",
      "version": 7,
      "createdAt": 1759000000000, "updatedAt": 1759995000000,
      "excerpt": "…检查 Windows 防火墙是否放行<mark>专用网络</mark>…",  // FTS snippet，<mark> 标命中词
      "score": -1.83
    }
  ],
  "total": 3,          // 命中总数（≤ limit 时等于 hits.length）
  "tookMs": 4,
  "fts": true
}
```

FTS 查询串转义：用户输入按 FTS5 规则包裹为 `"<escaped>"`（双引号内 `"` 翻倍），
杜绝 `NEAR/OR/列前缀` 注入语法错误——检索永远当子串处理，语义与 LIKE 兜底一致。

### 5.5 写接口

#### `POST /api/teamkb/docs` — 新建

```jsonc
// 请求
{
  "title": "cc-connect worker 卡死的处理",   // 必填，trim 后非空，≤200 字
  "body": "## 现象\n…",                      // 可选，≤ maxBodyBytes
  "level": 1,                                // 可选，默认 0；> clearance → 400
  "tags": ["cc-connect", "排障"],             // 可选，≤16 个
  "author": "老王",                           // 可选，自报显示名 ≤40 字
  "id": "kb-…"                               // 可选：agent 离线批量导入时自带 id（冲突 → 409）
}

// 200
{ "ok": true, "doc": { /* KbDoc 完整体，服务端补 id/origin/version/时间戳 */ } }

// 400 各分支
{ "ok": false, "error": "标题不能为空" }
{ "ok": false, "error": "正文太大（>2MB）" }
{ "ok": false, "error": "不能创建高于自己密级的条目", "need": 2, "have": 1 }
{ "ok": false, "error": "知识库已满（5000 条）" }
// 409
{ "ok": false, "error": "id 已存在" }
```

`origin` 服务端强制填 `cfg.id`，`author` 缺省填 `cfg.label`（可追溯"哪台机器进的库"）。

#### `POST /api/teamkb/docs/:id/update` — 更新（乐观锁）

只带要改的字段；`baseVersion` 强烈建议带（UI 打开编辑器时记下的 version），
不带则 last-write-wins 直接覆盖（agent 脚本友好）。

```jsonc
// 请求
{ "title": "…", "body": "…", "tags": ["…"], "level": 2, "baseVersion": 3 }

// 200
{ "ok": true, "doc": { /* 更新后完整体，version=4 */ } }

// 409（并发冲突：响应带当前值，UI 可直接提示 diff/刷新）
{ "ok": false, "error": "条目已被他人修改", "current": { /* KbDocMeta */ } }

// 403（密级不足，含改 level 时 max(旧,新) 判定）
{ "ok": false, "error": "密级不足", "need": 2, "have": 1 }
// 404
{ "ok": false, "error": "条目不存在" }
// 400
{ "ok": false, "error": "没有要更新的内容" }
```

服务端行为：`version+1`、`updated_at=Date.now()`、重写 FTS 行、`scheduleFlush()` 让快照摘要变化推给 UI。

#### `POST /api/teamkb/docs/:id/remove` — 软删除

```jsonc
// 请求（body 可省）
{ "baseVersion": 4 }          // 可选，同 update 的乐观锁语义

// 200
{ "ok": true }
// 403 / 404 / 409 同 update
```

置 `deleted=1`、`version+1`、`updated_at=now`、清 FTS 行——墓碑必须参与同步（§6），
否则删掉的条目会被 peer 下一轮拉回来"复活"。墓碑保留 30 天后由本地维护任务物理清除
（`kb_doc` 与 `kb_fts` 一起删）；30 天足够覆盖"离线一个月的机器重新上线"场景（见 §8 风险 4）。

### 5.6 权限（ACL）管理 — 仅 loopback

三个端点都以 `if (!isLocal(c)) return c.json({ ok:false, error:"仅本机可管理密级" }, 403);` 开头。

#### `GET /api/teamkb/acl`

```jsonc
// 200（永不下发密钥物料，只有"设没设"）
{
  "ok": true,
  "admin": true,                       // 恒 true（能进这个路由就是 loopback）
  "levels": [
    { "level": 1, "label": "内部", "keySet": true, "keyHint": "9f3a…c21d" },  // sha256 首尾 4 位，帮管理员认钥匙
    { "level": 2, "label": "机密", "keySet": false },
    { "level": 3, "label": "绝密", "keySet": false }
  ],
  "syncMaxLevel": 3,
  "counts": { "byLevel": { "0": 100, "1": 25, "2": 3, "3": 0 }, "deleted": 12 }
}
```

#### `POST /api/teamkb/acl/level-key`

```jsonc
// 设置：key ≥ 8 位（对齐团队密钥下限），服务端存 sha256，明文只在生成那一刻回显一次
{ "level": 2, "key": "…", "generate": false }
// 200
{ "ok": true, "level": 2, "keySet": true, "key": "6d1f…e9a2" }   // 仅 generate:true 或本次刚提交时回显，用于抄给别的机器/成员

// 自动生成（管理员点"生成密钥"）：
{ "level": 2, "generate": true }      // 服务端 randomBytes(16).hex，同 genKey() 风格

// 清除：
{ "level": 2, "key": "" }             // → 200 { ok:true, level:2, keySet:false }；此后该级仅 loopback 可达

// 400
{ "ok": false, "error": "密钥至少 8 位" }
{ "ok": false, "error": "level 需为 1/2/3" }   // 0 级就是团队密钥本身，不设独立钥匙
```

落盘：`saveConfig(cfgPath, { teamkb: cfg.teamkb })`，失败 500 `"写入配置失败: …"`（现有文案）。
**清除某级密钥不销毁该级条目**：条目还在、只是除 loopback 外没人读得到；UI 需在清除时提示。

#### `POST /api/teamkb/acl/sync-max-level`

```jsonc
{ "level": 1 }        // 0..3
// 200
{ "ok": true, "syncMaxLevel": 1 }
// 400
{ "ok": false, "error": "level 需为 0-3" }
```

调低后：高于新上限的本地条目立刻停止对外提供（下一轮 peer 拉取即不可见）；
**已经同步出去的副本不会被召回**（atrium 无删除广播通道，如实告知，见 §8 风险 5）。

### 5.7 同步端点（peer 间，团队密钥）

#### `GET /api/teamkb/digest`

```jsonc
// 200 —— 轻量，peerLoop 每轮都问得起
{ "ok": true, "count": 128, "maxUpdatedAt": 1759995000000, "syncMaxLevel": 3 }
```

#### `GET /api/teamkb/sync?since=<ms>&limit=<n>`

返回 `updated_at > since` 且 `level ≤ 本机 syncMaxLevel` 的**完整条目**（含 body 与墓碑），
`updatedAt ASC` 排序，limit 默认 200、上限 500：

```jsonc
// 200
{
  "ok": true,
  "docs": [ /* KbDoc[]，deleted 条目带 "deleted": true */ ],
  "serverTime": 1760000000000,   // 拉取方下一轮用它当 since，避免双方时钟偏差漏条目
  "hasMore": false
}
```

#### `POST /api/teamkb/sync/push`（phase 2，可选实现）

写后即时扇出（body `{ docs: KbDoc[] }`，接收方按 §6.2 同一套 merge 校验），把收敛时延从"下一轮轮询"降到秒级。
phase 1 先只做拉取——正确性不依赖 push，push 只是加速器，坏了不影响收敛。

---

## 6. 跨实例同步与快照集成

### 6.1 为什么不塞进 snapshot

teamMeta 走 snapshot 是因为它天然是"小 KV"；KB 条目带正文，全量进快照会把 8s 一轮的
snapshot 轮询拖成 MB 级传输，且违背"快照 = 运行时状态"的现有语义（fleet-hub spec：snapshot 是
render whole fleet from one document）。KB 走**独立通道**：digest 门控 + delta 拉取。

### 6.2 合并语义（`mergeRemote(docs)`，与 `registry.teamMeta()` 的 LWW 先例同构）

对每条远端条目，按 `id` upsert：

```
收下条件：level ≤ 本机 syncMaxLevel（接收侧过滤，双保险）
覆盖条件（LWW 三元组，依次比较）：
  远端.updated_at > 本地.updated_at
  || (相等 && 远端.version > 本地.version)
  || (再相等 && 远端.origin 字典序 > 本地.origin)   // 终局 tie-break，保证全机队收敛到同一份
```

- 墓碑（deleted=1）同样按 LWW 合并 → 删除会传播；
- 合并写入**不重置** `updated_at`（保留原作者时间线），但 bump 本机 `kbLocalRev`（内存计数器）驱动快照摘要变化；
- 单向拉取即可收敛：A、B 互拉对方 delta，等价于双向合并（peerLoop 是对称的）。

### 6.3 调度

`registry.ts peerLoop()`（8s 一轮）内加 KB 节拍：**每 8 轮（约 64s）对每个 peer 做一次
digest 比对**，`count/maxUpdatedAt` 与上次记录不同才发 `sync?since=上次 serverTime` 拉增量并 merge。
digest 相同 → 零额外流量。首次配对 `since=0` 全量拉（受 limit 分页，`hasMore` 则续拉）。
失败静默保留上次状态（对齐 peerLoop 现有 catch 风格），下一轮重试。

### 6.4 快照与 SSE 集成（UI 变更感知）

`snapshot()` 返回值追加顶层字段（不放 `self`，因为它是全队合并视角）：

```jsonc
{
  // ...generatedAt / nodes / runAgents / hosts / self / teamMeta / discovered 不动...
  "teamkb": {
    "count": 128,               // 本机库条目数（含未同步出去的，不含墓碑）
    "maxUpdatedAt": 1759995000000,
    "localRev": 42,             // 本机合并/写入计数，变了 = UI 该重拉列表了
    "syncMaxLevel": 3,
    "fts": true
  }
}
```

UI 通过现有 `GET /api/stream` SSE 的 snapshot 事件即可感知 KB 变化（`localRev`/`maxUpdatedAt` 变了再调
`/api/teamkb/docs?since=…` 增量刷新），**不新增 SSE 通道、不加轮询**。

---

## 7. 落地步骤

按依赖序分五步，每步可独立提交、独立验证（对齐仓库"一个 feat 一个版本号"的提交习惯）：

### Step 1 — 类型与配置（`src/types.ts`、`src/config.ts`）

- types.ts：追加 `KbLevel`、`KbDoc`、`KbDocMeta`、`FleetConfig.teamkb`（§3.3/§3.4）；
- config.ts `normalize()`：补 teamkb 默认值（enabled=true、syncMaxLevel=3、levelKeys={}、maxBodyBytes=2MB），
  levelKeys 只认 sha256 hex 串（64 位 [0-9a-f]），坏值丢弃；
- 验证：`node --experimental-strip-types` 起服务，`~/.atrium/config.json` 出现 teamkb 节。

### Step 2 — 存储层（新文件 `src/teamkb.ts`）

`TeamKb` 类，构造入参 `(cfg: FleetConfig, cfgHome: string)`，公开方法：

```ts
class TeamKb {
  constructor(cfg: FleetConfig, cfgHome: string)   // open DB + migrate + FTS 探测（失败降级 fts=false）
  get fts(): boolean
  stats(): { count: number; maxUpdatedAt: number; byLevel: Record<number, number>; deleted: number }
  list(opts: KbListOpts & { clearance: KbLevel }): { docs: KbDocMeta[]; total: number; nextCursor: string | null }
  get(id: string, clearance: KbLevel): { ok: true; doc: KbDoc } | { ok: false; error: string; status: 403 | 404; need?: number }
  search(q: string, opts, clearance: KbLevel): { hits: KbDocMeta[]; total: number; tookMs: number }
  create(input, clearance: KbLevel, selfId: string): { ok: true; doc: KbDoc } | { ok: false; error: string; status: 400 | 409; need?: number }
  update(id, patch, clearance, baseVersion?): …    // 409 时带 current
  remove(id, clearance, baseVersion?): …
  digest(): { count: number; maxUpdatedAt: number }
  since(ts: number, limit: number): { docs: KbDoc[]; hasMore: boolean }   // 已按 cfg.teamkb.syncMaxLevel 过滤
  mergeRemote(docs: KbDoc[]): { merged: number; skippedLevel: number }    // §6.2 LWW + 墓碑
  pruneTombstones(olderThanMs = 30 * 86400_000): number                   // 每日维护任务调用
  localRev: number                                                        // 写入/合并后自增，快照摘要用
}
```

所有 SQL 收口在本文件；FTS 写路径与 kb_doc 同事务（`db.exec("BEGIN")/COMMIT/ROLLBACK`）。
验证：临时脚本注入 TeamKb 跑 CRUD/LWW/墓碑/降级路径（仓库暂无测试框架，用
`node --experimental-strip-types scripts/` 风格脚本自测，跑完即删或留 `python/` 式工具目录由 A 定）。

### Step 3 — 路由与鉴权（`src/index.ts`）

- 顶部实例化：`const teamkb = new TeamKb(cfg, cfgHome);`，传给 `new FleetRegistry(cfg, teamkb)`（或 registry.setTeamKb）；
- 加 `clearanceOf(c)` 辅助（§4.1，sha256 用 `crypto.createHash` + `timingSafeEqual`）；
- 按 §5 挂 13 条路由，body 解析/校验/错误文案全部照现有路由的写法；
- ACL 三条以 `isLocal(c)` 开头；level-key/sync-max-level 变更后 `saveConfig(cfgPath, { teamkb: cfg.teamkb })`；
- `snapshot()`（registry.ts）顶层补 `teamkb` 摘要（§6.4）；
- 验证：curl 全端点手测清单（无 key 401 / team key 读 L0 / 带 kbkey 读 L2 / loopback 管理）。

### Step 4 — peer 同步（`src/registry.ts`）

- `peerLoop()` 加 KB 节拍（§6.3）：digest 比对 → `sync?since` 分页拉取 → `teamkb.mergeRemote()`；
- 每 peer 记录 `{ lastServerTime, lastDigest }`（内存即可，重启后 since=0 全量重拉，LWW 幂等无害）；
- 日维护：`setInterval` 每 24h `pruneTombstones()`；
- 验证：同机双实例（ATRIUM_HOME 分开、端口 6080/6081、同团队密钥）互写互见；
  一台写 L2 + syncMaxLevel=1，另一台确认拉不到；删除传播 + 墓碑不复活。

### Step 5 — 契约交付与规格

- 给 C（前端）：本文 §5 即接口契约，另附 `web/src/lib/api.ts` 使用样例：

```ts
// 检索（apiJson/apiPost 已自动带 x-atrium-key；密级密钥多带一个头）
const r = await apiJson("/api/teamkb/search?q=" + encodeURIComponent(q), {
  headers: kbKey ? { "x-teamkb-key": kbKey } : undefined,
});
```

- 给 agent 场景（可进 A 的 AGENTS.md 钩子文案）：

```bash
curl -s "http://127.0.0.1:6080/api/teamkb/search?q=组网排障" | jq '.hits[0]'
curl -s -X POST http://127.0.0.1:6080/api/teamkb/docs \
  -H 'content-type: application/json' \
  -d '{"title":"…","body":"…","tags":["排障"],"author":"agent"}'
```

- openspec：新增 `openspec/changes/teamkb/{proposal.md,tasks.md}`（声明 Critical）与
  `openspec/specs/teamkb/spec.md`（Purpose + SHALL Requirement + WHEN/THEN Scenario，
  覆盖：密级过滤、密钥不下发、LWW 收敛、墓碑传播、syncMaxLevel 隔离、loopback 管理边界）。

工作量估计：Step 1-2 约 0.5 天，Step 3 约 0.5 天，Step 4 约 0.5 天，Step 5 约 0.5 天；合计 2 人日后端。

---

## 8. 风险与缓解

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | **密级是访问控制，不是加密落盘**：`teamkb.db` 明文躺在 `~/.atrium/`，拿到文件 = 拿到全部密级 | 高敏内容在存储层裸奔 | 文档与 UI 明示"密级防的是 API 视角，不防本机文件读取"；演进项：level-key 派生 AES-GCM 信封加密 body（§9），本期不做——加密后 FTS 需另存密文索引，复杂度翻倍 |
| 2 | **密级密钥无吊销、无成员粒度**：钥匙泄露 = 该级全机队泄露；一把钥匙多人共用，无法定位谁泄露 | 中 | 与团队密钥同一威胁模型（现状也是如此），轮换流程一致：各机重设 `level-key` + 线下发新钥；`keyHint` 帮管理员核对；审计日志记 IP+author 供事后追 |
| 3 | **LWW 吞并发编辑**：两人同改一条，晚写赢，早写内容丢失 | 中 | `baseVersion` 乐观锁（UI 必带）→ 409 + `current` 让冲突显式化；仅"不带 baseVersion 的脚本写"才静默 LWW |
| 4 | **墓碑修剪窗口**：离线 > 30 天的机器重上线，会把已删条目当新增同步回来（它没有墓碑） | 低 | 修剪窗口 30 天覆盖绝大多数场景；重上线机器若长期离线，其本地库本就过期——merge 时"远端条目在本机不存在且 updated_at 更旧"不会覆盖任何新数据，最坏是死条复活一次，再删即全网收敛 |
| 5 | **调低 syncMaxLevel 不召回已同步副本**：peer 库里已有的高密级副本还在 | 中 | 端点响应与 UI 明示；提供 `POST /api/teamkb/acl/level-key` 轮换 + 手动清理指引；真正的"撤回"需要全网删除广播，列为演进项 |
| 6 | **403 泄露存在性**：按 id 读会暴露"存在一条 L2"（列表/检索是静默过滤的） | 低 | 有意取舍：团队密钥持有者是内部人，`need` 字段反而帮助其申请密级；若 A 文档判定不可接受，改为 404 同文案（一行改动） |
| 7 | **node:sqlite experimental**：API 可能在 Node 大版本间变动；启动打 Warning | 低 | wheel 固定 Node 运行时版本（现有发行机制天然锁定）；SQL 全收口 `src/teamkb.ts`，换驱动只动一个文件 |
| 8 | **中文检索质量**：trigram 是子串匹配不是分词，"知识库"检不到"知识"与"库"分写的文本；<3 字查询退 LIKE | 低 | 团队场景以"找原话"为主，子串匹配符合直觉；LIKE 兜底保证短词可用；演进项：外部分词器（需 native 依赖，违背零依赖原则，暂不做） |
| 9 | **同步风暴/大库**：5000 条 × 2MB 上限的极端库全量首拉可能几百 MB | 低 | 配额（§3.5）压上限；sync 分页 limit≤500；digest 门控避免无变更流量；正文默认不进的列表接口保证 UI 路径永远轻量 |
| 10 | **kbkey 走 query 的日志泄露**（EventSource 先例） | 低 | 检索/列表都是普通 GET，前端一律走 `x-teamkb-key` 头；`kbkey=` query 仅为 curl/EventSource 兼容保留，文档标注不推荐 |

---

## 9. 演进方向（本期不做，接口已留缝）

1. **成员体系**：`teamkb.members: { id, name, tokenHash, clearance }` + `x-teamkb-token` 头，
   替换共享密级钥匙为个人令牌（接口形状不变，`clearanceOf()` 单点扩展）；
2. **加密落盘**：body 用 level-key 派生密钥 AES-256-GCM 加密，FTS 存脱敏摘要列；
3. **删除广播**：peerLoop 附带 tombstone 通告通道，实现"撤回"语义；
4. **附件**：`POST /api/teamkb/docs/:id/attach`（复用项目图标 data URL/`forwardPeerRaw` 二进制转发的先例）；
5. **agent 自动沉淀**：opencode 插件（`atrium-report.js` 同款机制）在会话结束时抽取结论 POST 进 teamkb。

---

## 附：端点速查（实现时的 checklist）

```
GET  /api/teamkb/meta                      自描述 + clearance
GET  /api/teamkb/docs                      列表（tag/level/q/since/cursor/limit）
GET  /api/teamkb/docs/:id                  单条全文（403 need/have）
GET  /api/teamkb/search                    FTS5 检索（q 必填，snippet，score）
POST /api/teamkb/docs                      新建（可选自带 id）
POST /api/teamkb/docs/:id/update           更新（baseVersion → 409 current）
POST /api/teamkb/docs/:id/remove           软删除（墓碑）
GET  /api/teamkb/acl                       [loopback] 密级现状（无密钥物料）
POST /api/teamkb/acl/level-key             [loopback] 设/生成/清密级密钥（存 sha256）
POST /api/teamkb/acl/sync-max-level        [loopback] 机队复制上限
GET  /api/teamkb/digest                    [peer] count/maxUpdatedAt
GET  /api/teamkb/sync?since=&limit=        [peer] 增量（syncMaxLevel 过滤，含墓碑）
POST /api/teamkb/sync/push                 [peer, phase2] 写后即时扇出
```
