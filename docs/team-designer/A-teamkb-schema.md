# A · 团队知识库 teamkb 数据模型设计

> team-designer 系列 A 篇：只定义「数据与接口」契约，UI 交互与视觉另行成篇。
> 对齐现有实现：`src/types.ts`（类型）、`src/registry.ts`（teamMeta LWW 合并 / forwardPeer）、
> `src/config.ts`（`~/.atrium/` 落盘）、`openspec/specs/security-credentials/spec.md`（凭据边界）。

## 1. 目的

atrium 已经解决了「机器和 agent 在哪、在干什么」，但团队的**知识**仍然散落在个人脑子、
聊天记录和过期 wiki 里。teamkb 要在同一个包、同一套组网（团队密钥互信 + 快照同步）里补上
「团队知道什么」：

- **四类知识**统一建模，一个入口查全：
  | kind | 名称 | 回答的问题 | 典型条目 |
  |---|---|---|---|
  | `capability` | 项目能力 | 这事谁能做？哪个项目提供什么能力？ | 「ebao_jk_kb_v1：知识库检索服务，接口/负责人/状态」 |
  | `resource` | 开发资源 | 东西在哪？怎么访问？ | 内网 PyPI、测试库、跳板机、CI、域名、中间件 |
  | `account` | 账号 | 用哪个账号？密码在谁手里？何时到期？ | 服务器账号、系统机器人账号、共享邮箱（密码本体单独保管） |
  | `sop` | 技能 SOP | 这活的标准干法是什么？ | 发版流程、故障处理、开机自检 checklist |
- **section/entry 两层**：section 是 kind 下的目录（用户自建，如「内网服务」「XX 项目」），
  entry 是一条知识。不搞无限层级树，两层足够且好合并。
- **属主（owner）**：每条 section/entry 都有属主，回答「过期了找谁」。属主默认是创建者
  所在实例的显示名，可改成任何人（含不装 atrium 的同事）。
- **密级（level）**：决定同步范围与展示方式，账号密码默认**只存属主机器、永不进快照**，
  与 security-credentials spec「凭据不出本机」的既有约束一致。
- **零新增基础设施**：复用团队密钥鉴权、快照/SSE 通道、teamMeta 式 last-write-wins 合并、
  forwardPeer 转发，落盘 `~/.atrium/teamkb.json`。

非目标：不做富文本协同编辑、不做全文检索引擎（首版前端内存过滤即可）、不做用户体系
（atrium 无登录，属主是标注不是 ACL 主体）。

## 2. 数据与接口

### 2.1 核心类型（进 `src/types.ts`）

```ts
/** 知识类别：四类知识 */
export type KbKind = "capability" | "resource" | "account" | "sop";

/** 密级：
 *  open     团队公开 —— 全量同步，直接展示
 *  internal 团队内部 —— 全量同步，正文/字段默认打码，点开才显示，动作记事件流
 *  secret   仅属主机 —— 不进快照、不同步，只有写入它的那台实例可见
 * 默认：account → secret，其余 kind → open；entry 密级不得低于所在 section 的密级。 */
export type KbLevel = "open" | "internal" | "secret";

/** 属主：标注「这条知识归谁维护」，不是权限主体 */
export interface KbOwner {
  name: string;              // 显示名（默认创建实例 label，可改）
  contact?: string;          // 联系方式（IM / 邮箱）
  instanceId?: string;       // 创建它的 atrium 实例 id（secret 密文寻址、找回用）
}

/** section：kind 下的目录。id 形如 sec-<instanceId>-<6hex>，全局唯一免协调 */
export interface KbSection {
  id: string;
  kind: KbKind;
  name: string;              // ≤ 60 字
  desc?: string;             // ≤ 200 字
  order?: number;            // 同 kind 内手工排序
  owner: KbOwner;
  level: KbLevel;            // 本目录的密级下限
  at: number;                // 最后写入时间戳（LWW 合并依据）
  updatedBy?: string;        // 最后写入实例 label
  deletedAt?: number;        // 墓碑：合并后保留 30 天再物理清除
}

/** entry：一条知识。id 形如 ent-<instanceId>-<6hex> */
export interface KbEntry {
  id: string;
  sectionId: string;
  kind: KbKind;              // 冗余自 section，方便筛选与 section 删除后的孤儿检测
  title: string;             // ≤ 120 字
  body?: string;             // Markdown 正文，≤ 32KB（前端只做安全渲染，不执行）
  fields?: KbFields;         // 按 kind 的结构化字段（见 2.2）
  tags?: string[];           // ≤ 10 个，每个 ≤ 24 字
  owner: KbOwner;
  level: KbLevel;
  at: number;
  updatedBy?: string;
  deletedAt?: number;
}
```

### 2.2 四类知识的结构化字段

结构化字段是为了「可筛选、可提醒」，全部可选，正文才是主体：

```ts
export type KbFields = CapabilityFields | ResourceFields | AccountFields | SopFields;

/** 项目能力 */
export interface CapabilityFields {
  kind: "capability";
  project?: string;          // 项目/系统名
  repo?: string;             // 仓库地址
  endpoints?: string[];      // 对外接口/入口 URL
  status?: "active" | "maintained" | "deprecated";
  stack?: string[];          // 技术栈标签
}

/** 开发资源 */
export interface ResourceFields {
  kind: "resource";
  resType?: "server" | "database" | "domain" | "middleware" | "registry" | "ci" | "other";
  endpoint?: string;         // 地址/连接串（不含密码；密码走 account）
  env?: "prod" | "staging" | "dev";
}

/** 账号：只存「账号的档案」，密码本体永远在 secrets 密文区（见 2.3） */
export interface AccountFields {
  kind: "account";
  system?: string;           // 所属系统（如 跳板机 / 内网 PyPI / 测试库）
  username?: string;
  mfa?: "none" | "totp" | "sms" | "hardware";
  expiresAt?: number;        // 密码/证书到期时间戳 → 前端到期提醒（复用值班提醒样式）
  rotateDays?: number;       // 轮换周期，用于「该换密码了」提示
}

/** 技能 SOP */
export interface SopFields {
  kind: "sop";
  trigger?: string;          // 什么时候用（如「发版前」「磁盘告警时」）
  steps?: string[];          // 步骤摘要（详细版写 body）
  relatedEntryIds?: string[]; // 关联条目（如 SOP 引用的资源/账号）
}
```

### 2.3 密级与密码的存储边界

落盘 `~/.atrium/teamkb.json`（与 config.json 同目录，gitignore 无关——本来就不在仓库里）：

```jsonc
{
  "sections": { "sec-win-a1b2-3f9c01": { /* KbSection */ } },
  "entries":  { "ent-win-a1b2-8d4e22": { /* KbEntry */ } },
  // 密文区：entryId → AES-256-GCM 密文（base64）。仅本机，任何 API/快照都不整包输出。
  // 加密密钥 = HKDF(团队密钥, salt="atrium-teamkb-v1")，不新增用户要记的东西。
  "secrets": { "ent-win-a1b2-8d4e22": "..." }
}
```

三档密级的同步矩阵（**这是整个模型的安全底座**）：

| | 快照同步（`self.teamkbIndex`） | 正文/fields 拉取 | secrets 密文 |
|---|---|---|---|
| `open` | ✅ 索引+正文 | ✅ 全队直接看 | —（不建议存） |
| `internal` | ✅ 索引+正文 | ✅ 但 UI 默认打码，点开记事件 | —（不建议存） |
| `secret` | ❌ 完全不出现 | ❌ 仅属主实例本机可见 | ❌ 永不离机 |

- **account 的密码 ≠ account 条目**。条目档案（哪个系统、用户名、属主、到期日）通常是
  `internal`，全队可查「有没有这个账号、找谁」；密码本体写进 `secrets` 密文区，
  默认条目 `level=secret` 只留在写入机；若想让队友取用，把条目调成 `internal` 后，
  队友机器上显示「密文在 @属主机 上」，点「取回」→ 走 forwardPeer 到属主实例的
  `GET /api/teamkb/entry/:id/secret`（需团队密钥，两侧各记一条事件流）。属主机离线则明确
  提示，不做密文副本扩散。
- 快照里 teamkb 只带**索引**（id/title/kind/level/owner/at/checksum），正文靠
  `GET /api/teamkb` 按需拉，避免每 5 秒的快照被知识库撑大（对齐 teamMeta 只放轻量值的教训）。
- checksum = sha256(body+fields) 前 16 位，前端对比本地缓存决定是否重拉正文。

### 2.4 合并语义（复用 teamMeta 的 LWW，加两条修正）

- 每条 section/entry 独立 LWW：`at` 大者赢；`at` 相同（时钟回拨/同毫秒）比 `updatedBy`
  字典序，保证全队收敛到同一结果。
- 删除是墓碑（`deletedAt`），不是移除——否则「A 删了、B 的旧副本又同步回来」。墓碑参与
  LWW，合并后保留 30 天，由启动时的例行清理物理删除。
- 写入即广播：POST 成功后本机落盘 + `registry.publish()` 推 SSE，peer 下一轮快照轮询自然拿到，
  无需新通道。

### 2.5 HTTP 接口（Hono，全部走既有 `/api/*` 团队密钥中间件）

```
GET  /api/teamkb
  → { sections: KbSection[], entries: KbEntry[] }
  合并后的全量视图：本机 secret + 全队 open/internal。不返回 secrets 密文。
  query: ?kind=&q=&tag= 为可选服务端过滤（首版可全量返回、前端过滤）。

POST /api/teamkb/section        body: { section: KbSection }          // 新建/整条覆盖（带 at）
POST /api/teamkb/section/remove body: { id }                          // 打墓碑；级联给其下 entry 打墓碑
POST /api/teamkb/entry          body: { entry: KbEntry, secret?: string }
  secret 为明文密码，仅当本机是属主实例时写入密文区；改密级 secret→internal 不搬运密文。
POST /api/teamkb/entry/remove   body: { id }
GET  /api/teamkb/entry/:id/secret
  → { ok, secret } 或 404。只有持有密文的实例能应答；每次调用在本机事件流记
  { type: "kb.secret.reveal", summary: "<实例label> 取回了 <title> 的密码" }。

快照扩展（GET /api/snapshot 与 SSE snapshot 事件，registry.ts snapshot() 内）：
  self.teamkbIndex: Record<string, { kind, level, at, deletedAt?, checksum }>   // 仅本机 open/internal
  teamkb: { sections, entries }   // 合并后视图，peer 只吃 self.teamkbIndex（一跳原则，不转口）
```

事件流新增类型：`kb.update`（增改删摘要）、`kb.secret.reveal`。前端「知识库」入口挂顶栏，
与组网/设置同级（布局细节归 B 篇）。

## 3. 落地步骤

1. **类型与存储**（半天）：`types.ts` 增加 2.1/2.2 类型；新增 `src/teamkb.ts` ——
   load/normalize/save `~/.atrium/teamkb.json`、AES-GCM 加解密（node:crypto，密钥 HKDF 自团队密钥）、
   墓碑清理。单测：normalize 坏文件容错、加解密回环。
2. **Registry 合并与快照**（1 天）：`KbStore` 挂进 Registry；LWW 合并（本机 + peerSnaps 的
   `self.teamkbIndex` 对应正文）；snapshot() 输出 2.5 的两块；写入路径统一走
   `setKbSection/setKbEntry`（内部 scheduleFlush + publish），照抄 setTeamMeta 的落盘分工
   （registry 改内存、index.ts 负责 saveConfig 式写文件）。
3. **API**（1 天）：index.ts 按 2.5 加 6 个路由；secret 取回复用 forwardPeerGet；
   事件流记 `kb.update` / `kb.secret.reveal`。
4. **前端**（1–2 天）：知识库面板（四 kind 页签 → section 目录 → entry 卡片列表）、
   编辑弹窗（kind 联动 fields 表单 + Markdown 预览）、internal 打码/点开、secret「取回」按钮、
   属主与到期角标（expiresAt 进现有提醒中心）。
5. **openspec**（半天）：新增 `openspec/specs/team-kb/spec.md`（Purpose + SHALL/Scenario：
   同步矩阵、墓碑、secret 不出属主机、事件流审计）；`openspec/changes/` 加变更记录，
   分级 **Critical**（触碰凭据处理边界，按 config.yaml 规则）。
6. **收尾**：README「界面/仓库结构」补一句；`npm run typecheck && npm run build`；
   双机实测（同步、打码、secret 取回、属主机离线）后 bump 版本发布。

依赖顺序 1→2→3→4 严格串行，5/6 可并行穿插。总量约 4–5 人日。

## 4. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **团队密钥即最高权限**：拿到密钥就能读全部 internal 正文、并向属主机请求 secret | 密码泄露 | 这是现有信任模型的既定事实（密钥=入队凭证），文档明示；secret 默认不共享、取回双侧留痕形成威慑；后续版本可加独立口令/OS keychain 派生密钥（`ATRIUM_KB_PASSPHRASE`），密文区与团队密钥解耦 |
| 用户把密码写进 `open` 条目正文/body | 绕过密级设计 | account kind 的编辑弹窗对 secret 输入框与普通正文分离并提示；不做正文扫描误报率高，首版靠交互引导 |
| LWW 并发编辑丢改动（两人同时改一条 entry） | 静默丢数据 | `updatedBy/at` 在 UI 展示「谁在何时改的」；编辑弹窗提交时若发现远端 at 更新则提示覆盖确认；版本历史列入后续 |
| 快照/存储膨胀（条目多、正文大） | 轮询变慢、config 目录变大 | 快照只带索引；body ≤32KB、条目总数软上限 2000（超出拒写并提示清理）；checksum 增量拉正文 |
| 墓碑与孤儿（section 删了 entry 还在、peer 长期离线回来带旧数据） | 界面脏数据 | 级联墓碑 + 30 天物理清理；加载时按 sectionId 校验孤儿并归入「未归档」 |
| 属主实例下线/重装，secret 密文丢失 | 密码找不回 | 档案里 `owner.contact` + `instanceId` 明确「密文在哪台机」；UI 提示重新录入；不做密文多机副本（副本=扩散，违背边界） |
| 时钟偏移导致 LWW 误判 | 新旧版本错乱 | 同 at 比 updatedBy 兜底；团队内机器通常同 NTP，风险低 |
| 合规：集中存密码本身是攻击面 | 安全审计 | 鼓励 account 条目存「获取路径」（vault 链接/找谁）而非真实密码；secrets 密文区可选关闭（设置项「不允许本机保管密码」） |
