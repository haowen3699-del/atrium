# D · 会话级最大开发权限（工具调用自动放行）设计

> team-designer 系列 D 篇：无人值守开发的「自动放行」契约。UI 交互归 C 篇，团队知识归 A/B 篇。
> 对齐现有实现：`src/client.ts`（`replyPermission` / `permissionsFor`）、`src/registry.ts`
> （NodeState 轮询 + SSE `permission.updated` → `kickPoll`、`replyPermission` 转发、`forwardPeer`）、
> `src/index.ts`（`/api/nodes/:id/permissions/:pid/reply`、`isLocal` 边界）、
> `openspec/specs/board-ui/spec.md`（pending permission 提醒）。
>
> 变更分级（openspec 规则）：**Critical** —— 把「人点一次授权」变成「机器批量授权」，
> 直接放大工具执行面，需新增 `openspec/specs/max-permission/spec.md` 与 changes 提案。

---

## 1. 目的

atrium 现在的闭环是：面板发 prompt → agent 干活 → 碰到 `ask` 级工具调用 → opencode 挂起等授权 →
面板弹「授权请求」卡片（`PendingCards`）→ 人点 once/always/reject。这条链路在有人盯屏时很好，
但机队场景的核心诉求是**无人值守**：夜间批量任务、远程机器上的长任务、一人管十台机——
每个 bash/edit 都要人点一次，agent 一晚上卡在第一个 `npm install` 上。

本篇定义「最大开发权限」（max-permission）：**以会话为粒度、带 TTL、可审计地自动放行工具调用**。

- **会话级，不是全局**：放行标志挂在 `nodeId + sessionID` 上，同一台机器上其它会话照常人工授权。
  不开「整个 opencode server 裸奔」的全局口子。
- **自动放行 = 自动替人点按钮**：机制上复用现有 `POST /permission/:id/reply` 通道
  （`client.replyPermission`），hub 检测到挂起授权且该会话持有有效 grant 时代为应答。
  对 opencode 而言与人点无异——**不改 opencode、不给远端机器装任何东西**，peer 节点天然可用。
- **授予有时限、回收有兜底**：grant 带 `until` 时间戳，默认 60 分钟；TTL 到期、手动关闭、
  节点离线、hub 重启后过期条目清理，任何一条路都回到「人工授权」这个安全默认态。
- **有护栏**：危险模式黑名单（命中则不自动放行、转人工并提醒）、doom_loop 永不自动放行、
  每分钟放行速率熔断、全程事件流审计。
- **信任模型不扩权**：现有体系里持有团队密钥者本来就能远程点授权
  （`/api/nodes/:id/permissions/:pid/reply` 无额外限制）。max-permission 只是把「人肉逐条点」
  自动化，不引入新的权限主体；但每台机器保留**本机主开关**（loopback 管理，对齐 B 篇 ACL 风格），
  机器主人可以一票否决「我这台机不允许任何人开自动放行」。

非目标：不做 per-tool 细粒度策略编排（首版只有 once/always 两档 + 黑名单）、不做 opencode 侧
配置文件改写（见 §2.1 选型）、不做跨 hub 的 grant 同步（grant 只在拥有该节点的 hub 上生效）。

### 1.1 与 opencode 原生权限体系的关系

opencode 自身提供三层放行手段，都不是「会话级」，故只作为背景而非本方案载体：

| opencode 原生机制 | 粒度 | 为什么不直接用 |
|---|---|---|
| `opencode.json` 的 `permission: "allow"` / 分工具规则 | 全局或 per-project | 改了影响该机器**所有**会话（含用户自己在 TUI 里的交互），且回收要改回配置文件，agent 正在跑时改配置不生效 |
| `opencode --auto` / TUI 命令面板 auto mode | 整个 server 进程 | 同上，进程级；atrium 管理的桌面版/常驻 server 无法按会话切换 |
| reply `always` | 单个 opencode 会话内、按 pattern | 方向正确但**残留不可回收**：`always` 批准的 pattern 在 opencode 侧存活到该 server 会话结束，atrium 撤掉 grant 也收不回来。故本方案默认只用 `once`，`always` 作为可选加速档并明示风险（§4 风险 1） |

atrium 的 max-permission 站在这些机制**上面**：opencode 照常按它自己的 permission 配置产生
`ask` 请求（显式 `deny` 的规则依然拦截，hub 不会替用户解禁被 deny 的东西），hub 只在
「本来会弹给人」的请求上做自动应答。用户机器上已有的 deny 规则（如 `.env` 保护）全部保留生效。

---

## 2. 数据与接口

### 2.1 机制选型：hub 侧自动应答（三选一）

| 方案 | 延迟 | 覆盖 | 回收语义 | 结论 |
|---|---|---|---|---|
| A. hub 轮询/SSE 驱动自动 reply | SSE 触发 `kickPoll`（registry.ts:505）后 ~300ms；纯轮询兜底 ≤5s | 所有节点（本机 + peer 转发），零安装 | 停发 reply 即回收，干净 | ✅ **选用** |
| B. opencode plugin（`permission.asked` 事件里问 hub 再 reply） | ~0 | 每台机器都要装插件（现有 `atrium-report.js` 机制仅本机安装） | 同 A，但决策逻辑散落各机 | 备选演进（§5.4），首版不做 |
| C. 改写 opencode 配置 `permission:"allow"` | 0 | 仅本机可写 | **不可按会话回收**，污染用户自己的交互 | ❌ 否决 |

选 A 的决定性理由：**执行点收敛在拥有节点的 hub 一处**（NodeState 的 pollLoop 本来就每 5s 拉一遍
`permissionsFor(dir)`，registry.ts:301），策略、黑名单、审计、TTL 全在一个进程里闭环；
SSE 事件已经把延迟压到亚秒级，轮询只是兜底。

### 2.2 核心类型（进 `src/types.ts`）

```ts
/** 自动放行应答模式：
 *  once   每条挂起授权单独放行（默认）——撤销 grant 立即停止放行，无残留
 *  always 用 opencode 建议的 pattern 批量放行——减少往返，但 pattern 在 opencode
 *         侧存活至该 server 会话结束，grant 撤销后无法收回（UI 必须明示） */
export type MaxPermMode = "once" | "always";

/** 一条会话级放行授权。key = `${nodeId}::${sessionID}`（nodeId 为 owner hub 视角的本地 id，不含 peer 前缀） */
export interface MaxPermGrant {
  nodeId: string;
  sessionID: string;
  /** 到期时间戳（owner hub 本地时钟）；过期即失效，sweeper 清理 */
  until: number;
  grantedAt: number;
  /** 授予来源：操作者标识（本机 = cfg.label；peer 转发来的 = `${peerLabel}`），审计用 */
  by: string;
  mode: MaxPermMode;
  /** 累计自动放行次数（快照展示 + 熔断计数） */
  autoCount: number;
  /** 速率熔断：触发后暂停自动放行至该时间戳，需人工恢复 */
  pausedUntil?: number;
}

/** FleetConfig 追加（config.ts normalize() 补默认） */
export interface FleetConfig {
  // ...现有字段不动...
  /** 最大开发权限设置。只存本机、只约束本机拥有的节点，不进快照不同步 */
  maxPerm?: {
    /** 本机主开关：false 时拒绝一切 grant 创建（含本机 UI），默认 true */
    enabled?: boolean;
    /** 默认 TTL 分钟（默认 60） */
    defaultTtlMin?: number;
    /** TTL 上限分钟（默认 480 = 8h，硬上限 1440） */
    maxTtlMin?: number;
    /** 危险模式黑名单：对 permission 类型 + patterns + always 建议串做通配匹配，
     *  命中 → 不放行、不拒绝，保持挂起转人工 + 事件流告警。默认内置一份（§2.5） */
    denyPatterns?: string[];
    /** 每分钟自动放行上限，超出触发熔断（默认 60） */
    ratePerMin?: number;
    /** doom_loop / external_directory 类型是否也自动放行（默认 false = 永远转人工） */
    approveGuards?: boolean;
  };
  /** 活跃 grant 持久化（重启后未过期的继续生效；过期条目加载即弃） */
  maxPermGrants?: MaxPermGrant[];
}

/** SessionView 追加（快照携带，全队 UI 都能看到角标） */
export interface SessionView {
  // ...现有字段不动...
  /** 该会话当前生效的自动放行状态（无 grant 或已过期则缺省） */
  maxPerm?: {
    until: number;
    mode: MaxPermMode;
    autoCount: number;
    /** 熔断暂停中 */
    paused?: boolean;
  };
}
```

### 2.3 存储与归属

- grant 的**唯一权威副本在 owner hub**（`cfg.nodes` / 本机发现里拥有该节点的实例）。
  peer hub 的 UI 操作走既有 `forwardPeer` 通道（`peerId::nodeId` 形式，对齐
  `replyPermission` registry.ts:1976 的先例）到 owner 执行，peer 侧只从快照读展示态。
- 落盘：`saveConfig(cfgPath, { maxPermGrants: [...] })`，写路径与 `nodeLabels` 同款
  （registry 改内存、index.ts 负责 saveConfig）。持久化的意义是 hub 重启不打断夜间长任务；
  **安全兜底靠 `until`**：加载时 `until < now` 的条目直接丢弃，主开关 `enabled=false` 时全部丢弃。
- 内存结构：`FleetRegistry.maxPerm = Map<string, MaxPermGrant>`，key `${nodeId}::${sessionID}`。

### 2.4 HTTP 接口（Hono，全部挂既有 `/api/*` 团队密钥中间件）

```
POST /api/nodes/:id/sessions/:sid/max-perm
  body: { enabled: boolean, ttlMin?: number, mode?: "once"|"always" }
  → 200 { ok:true, grant?: { until, mode } }
  创建/续期（enabled:true，ttlMin 夹取到 [1, maxTtlMin]，缺省 defaultTtlMin）或撤销（enabled:false）。
  peer 节点（id 含 "::"）→ forwardPeerResult 到 owner hub，由 owner 校验并落盘。
  owner 侧校验：cfg.maxPerm.enabled=false → 403 "该机器已禁用自动放行"；
  会话不存在 → 404；每次授予/撤销记事件流（§2.6）。

GET /api/nodes/:id/sessions/:sid/max-perm
  → 200 { ok:true, grant: MaxPermGrant | null, settings: 生效中的 maxPerm 配置（不含他机） }
  面板打开会话详情时拉一次即可，常态展示走快照里的 SessionView.maxPerm。

POST /api/nodes/:id/max-perm-settings        【仅 owner hub 本机 loopback 可改，isLocal 拦截】
  body: { enabled?, defaultTtlMin?, maxTtlMin?, denyPatterns?, ratePerMin?, approveGuards? }
  → 200 { ok:true, maxPerm } / 403 "仅本机可管理自动放行设置"
  改完 saveConfig(cfgPath, { maxPerm })。关闭主开关时级联撤销该机所有 grant。

快照扩展（registry.ts snapshot()/NodeState.view()）：
  SessionView.maxPerm —— §2.2 定义的瘦身态，peer 一跳合并自然携带，全队 UI 可见角标。
  不进 self、不新增顶层字段、不加新 SSE 通道（对齐 A/B 篇「快照只放轻量值」的教训）。
```

响应/错误风格照现有路由：`{ ok:false, error:"中文原因" }`、body 解析
`catch(() => ({} as any))`、入参 trim/slice/夹取。

### 2.5 放行判定与护栏（owner hub 内，`sweepAutoApprove(node)`）

对 NodeState 每轮 poll 收集的 `pendingPermissions` 逐条判定，**全部通过才应答**：

```
1 grant 存在且 until > now 且 pausedUntil 已过期        否则跳过（保持挂起，走现有提醒）
2 类型护栏：permission 类型 ∈ {doom_loop, external_directory}
  且 approveGuards=false                                → 跳过 + 事件告警「护栏请求转人工」
3 黑名单：denyPatterns 通配匹配（同 opencode 的 * ? 语义）
  permission 字符串 / patterns[] / always[] 任一命中     → 跳过 + 事件告警「命中危险模式」
4 速率熔断：该 grant 近 60s 放行数 ≥ ratePerMin          → pausedUntil = now+5min + 事件告警，跳过
5 应答：mode=once → replyPermission(id, "once")
        mode=always → replyPermission(id, "always")
  成功 → autoCount++、事件流记一条、scheduleFlush()
  失败（用户已手点/请求已消失）→ 静默，下轮自然一致
```

内置默认黑名单（`denyPatterns` 缺省值，机器可加不可减到空——设为 `[]` 视为用默认）：

```
rm -rf /*        rm -rf ~*       mkfs*          dd if=*       shutdown*   reboot*
diskpart*        format *        git push --force*   *:(){*     curl * | sh*   wget * | sh*
```

> 匹配对象是 opencode 给出的 permission 元数据（`PendingPermission.patterns/always`，
> types.ts:131），bash 类请求的 pattern 即命令前缀，黑名单按前缀通配足够；匹配不做 shell 语义
> 解析，绕过是可能的（§4 风险 3），定位是「挡误操作」而非「挡恶意」。

### 2.6 审计与事件流

复用 `EventView` 环形缓冲（registry.ts events），新增事件类型（前端 EventStream 过滤器
`permission` 关键字已能命中展示）：

| type | summary 示例 | 触发点 |
|---|---|---|
| `maxperm.grant` | `MAXPERM grant ses_xxx 60min once by win-dev-01` | 创建/续期 |
| `maxperm.revoke` | `MAXPERM revoke ses_xxx by ttl-expire` | 手动/TTL/级联/清理，`by` 记原因 |
| `maxperm.auto` | `MAXPERM auto ses_xxx bash "npm install*"` | 每次自动应答成功 |
| `maxperm.blocked` | `MAXPERM blocked ses_xxx 命中 denyPattern: rm -rf*` | 护栏/黑名单/熔断拦下 |

快照不新增审计通道；`maxperm.auto` 事件天然随 `recentEvents` 推给全队 UI。

---

## 3. 授予 / 回收时机（状态机）

```
        ┌────────────── 手动关闭 / TTL 到期 / 主开关级联 / 会话消失24h ──────────────┐
        ▼                                                                          │
 [无 grant]──UI 开关(带 TTL/mode)──▶ [生效中]──命中熔断──▶ [暂停 5min]──超时自动──▶ [生效中]
   ▲  人工授权（现状）                  │  sweep 每轮: SSE kickPoll ~300ms / 轮询 ≤5s     │
   └───────────────────────────────────┴── 自动应答 once/always ────────────────────────┘
```

- **授予时机**：
  1. 人在面板会话详情/卡片上打开「最大权限」开关，选 TTL 与 mode（显式动作，默认值即安全值）；
  2. 后续演进：任务派发（一键 prompt）时可勾选「本次任务自动放行」，prompt 成功即建 grant，
     `session.idle` 且任务完成态时自动撤销——首版不做，接口已支持（就是 grant+revoke 两次调用）。
- **续期**：重复 POST enabled:true 即续期（`until = now + ttlMin`，`grantedAt` 不变）。
  不做「busy 自动续命」——续期必须是显式动作，防止任务失控时 grant 永生。
- **回收时机**（任一命中即回到人工授权态，方向永远是 fail-safe）：
  | 触发 | 实现点 |
  |---|---|
  | TTL 到期 | registry 30s sweeper（挂在 scheduleFlush 节拍），过期 → 删除 + `maxperm.revoke by ttl-expire` |
  | 手动关闭 | UI 开关 → POST enabled:false |
  | 主开关关闭 | `max-perm-settings enabled:false` → 级联撤销该 hub 全部 grant |
  | 节点离线 > 10min | sweep 时对 offline 节点的 grant 直接清除（机器都不在了，留着只会复活） |
  | 会话从节点消失 > 24h | sweep 清理孤儿 grant（对齐墓碑思路，防配置堆积） |
  | hub 重启 | 加载 `maxPermGrants` 时丢弃全部过期条目；未过期的继续生效（这是持久化的本意） |
  | 熔断 | 不是回收，是暂停 5min；UI 角标变灰 + 提醒中心通知，人工可立即恢复（重新 POST 一次） |
- **撤销的语义边界**：mode=once 下撤销即刻生效（下一条挂起请求就回到人工）；mode=always 下
  已被 `always` 批准的 pattern 在 opencode 侧继续放行至该 server 会话结束——**这是选 always 档
  的固有代价**，UI 在选 always 时必须弹一次明示确认（文案归 C 篇）。

---

## 4. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **always 残留不可回收**：撤 grant 后 opencode 侧已批 pattern 仍然放行 | 撤销语义打折 | 默认 mode=once；always 为显式 opt-in + 确认弹窗；文档/UI 明示「always 的批准活到 opencode 会话结束」；真要立即止血走既有 abort/重启 opencode 控制（`/api/local-opencode/control`） |
| 2 | **团队密钥 = 机队自动放行权**：拿到密钥者可在任何开了主开关的机器上给任意会话挂 grant，配合 prompt 注入即可远程执行命令 | 高 | 现状密钥持有者本就能逐条点授权 + 发 prompt（威胁模型未扩权，只是提效）；增量防线：每机主开关（loopback 管理）、TTL 上限 8h、grant/放行全量事件审计（by 字段记操作来源实例）、机器主人可随时级联关停 |
| 3 | **黑名单可绕过**：pattern 前缀匹配无 shell 语义（`bash -c`、变量拼接、编码） | 危险命令被自动放行 | 明示定位是「挡误操作不挡恶意」；doom_loop/external_directory 默认转人工；ratePerMin 熔断限制爆炸半径；真正的隔离靠 opencode 侧 deny 规则/沙箱（用户机器自治，atrium 不越俎） |
| 4 | **prompt 注入放大**：会话内容诱导 agent 调危险工具，无人值守下没人把关 | 中 | 这是所有 auto 模式（含 opencode `--auto`）的固有属性；建议话术进 README：只对可信项目目录/可信任务开 grant；黑名单 + 熔断 + 事件流事后追溯 |
| 5 | **双写竞态**：人点授权与 sweep 自动应答同一条请求 | 低 | replyPermission 幂等（opencode 对已应答请求返回错误，client 已 catch 返回 false）；sweep 对失败静默，下轮 pendingPermissions 自然不含该条 |
| 6 | **SSE 断连期间延迟放行**：长任务卡在 ask 上最多 5s×N | 低 | 轮询兜底本来就是全量拉 pending；SSE 重连（sseLoop backoff）后 kickPoll 立即补扫；无人值守场景对秒级延迟不敏感 |
| 7 | **持久化 grant 在 hub 重启后「复活」**，操作者以为已关 | 中 | 加载时过期即弃；UI 快照角标常显（全队可见「哪些会话正在自动放行」）；主开关关闭时清空并落盘空数组 |
| 8 | **时钟依赖**：TTL 用 owner hub 本地时钟 | 低 | grant 只在一处判定（owner），无跨机时钟比较；peer UI 只展示 `until` 剩余时长，偏差秒级无碍 |
| 9 | **grant 泄漏到已 fork/compact 的会话**：fork 出的新 sessionID 不继承 grant | 低（方向安全） | 有意不继承——新会话默认人工，需重新显式授予；文档写明 |
| 10 | 事件缓冲刷屏：高频放行把 `recentEvents`（60 条）挤爆，淹没其它事件 | 低 | `maxperm.auto` 在 normalizeEvent 阶段做 10s 窗口聚合（同会话同 pattern 合并计数），UI 角标 `autoCount` 仍精确 |

---

## 5. 落地步骤

### Step 1 — 类型与配置（0.5 天，`src/types.ts`、`src/config.ts`）

- types.ts：§2.2 的 `MaxPermMode` / `MaxPermGrant` / `FleetConfig.maxPerm(.Grants)` / `SessionView.maxPerm`；
- config.ts `normalize()`：maxPerm 默认值（enabled=true、defaultTtlMin=60、maxTtlMin=480、
  ratePerMin=60、approveGuards=false、denyPatterns 内置表）；`maxPermGrants` 加载时过滤过期条目；
- 验证：起服务看 `~/.atrium/config.json` 出现 maxPerm 节。

### Step 2 — Registry 核心（1 天，`src/registry.ts`）

- `FleetRegistry.maxPerm: Map` + `setSessionMaxPerm(nodeId, sessionID, opts, by)` /
  `revokeSessionMaxPerm(key, reason)`（内部改内存 + 记事件 + 标脏，落盘由 index.ts saveConfig 分工）；
- `sweepAutoApprove(node)`：§2.5 判定链，挂在 NodeState poll 完成回调（onDirty 同款注入）
  与 `permission.*` 事件 kickPoll 之后各跑一次；应答调用既有 `replyPermission`（owner 本地路径）；
- 30s TTL/离线/孤儿 sweeper；`NodeState.view()` 把生效 grant 映射进 `SessionView.maxPerm`；
- 通配匹配工具函数（`*`/`?`，与 opencode pattern 语义一致）+ 10s 聚合的 `maxperm.auto` 事件。
- 验证：临时脚本注入假 pendingPermissions 跑判定链（护栏/黑名单/熔断/过期各一条路径）。

### Step 3 — API 路由（0.5 天，`src/index.ts`）

- §2.4 三条路由；`::` 前缀走 `forwardPeerResult`（照抄 `sessionCommand` 的转发写法）；
  settings 路由 `isLocal(c)` 开头；授予/撤销成功后 `saveConfig(cfgPath, { maxPermGrants })`；
- 验证：curl 清单——本机授予/撤销/续期、peer 转发、主开关关闭 403、TTL 夹取、非法 sid 404。

### Step 4 — 前端（1 天，`web/src/`）

- 会话详情 + 卡片角标：「自动放行中（剩 42min · once · 已放行 17 次）」，暂停态灰色 + 感叹号；
  开关弹层选 TTL/mode，always 档二次确认（风险 1 文案）；
- 提醒中心（AlertItem）新增 `maxperm.blocked` / 熔断 / 主开关级联撤销三类通知；
- 设置页（节点归属机的）主开关 + 黑名单编辑，仅本机可见（快照 `self` 判断，对齐 B 篇 admin 入口思路）。
- 契约即 §2.4 + `SessionView.maxPerm`，无新增 SSE 处理。

### Step 5 — openspec 与收尾（0.5 天）

- `openspec/changes/max-permission/{proposal.md,tasks.md}`（声明 Critical）+
  `openspec/specs/max-permission/spec.md`：SHALL/Scenario 覆盖——会话级隔离、TTL 到期回收、
  doom_loop 默认转人工、黑名单命中保持挂起、熔断、主开关 loopback 边界、always 残留告知义务、审计事件；
- README「界面/仓库结构」补一句；`npm run typecheck && npm run build`；
- 双机实测：本机授予→peer UI 见角标→远端会话跑 `npm install` 自动放行→撤 grant 后下一条转人工→
  TTL 到期自动回收→主开关级联；bump 版本发布。

依赖顺序 1→2→3→4 严格串行，5 可并行穿插。总量约 3–4 人日。

### 5.4 演进方向（本期不做，接口已留缝）

1. **plugin 直通**（方案 B）：扩展 `atrium-report.js` 订阅 `permission.asked`，带 sessionID 问
   hub `GET /api/maxperm/check` 后用 SDK client 直接 reply——延迟归零，但需每机装插件，且决策
   入口从一处变两处；hub 侧判定逻辑可直接复用（同一份 §2.5 函数）。
2. **任务级 grant**：派发任务时勾选自动放行，`session.idle` + 完成态自动撤销（§3 授予时机 2）。
3. **per-tool 策略**：mode 从 once/always 细化为 `{ bash:"once", edit:"always", webfetch:"deny" }`，
   判定链第 5 步按类型分流即可，数据形状向后兼容。
4. **机队策略同步**：denyPatterns 通过 teamMeta LWW 全队共享一份基线（各机只能加严不能放松）。
