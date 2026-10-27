# E · 前端 UI 设计 — 团队页「知识/技能」面板

> team-designer 系列 E 篇（前端 UI）。产品需求见 A 篇（四类知识/属主/密级动机），
> **接口契约以 B 篇 §5 为准**（13 个 `/api/teamkb/*` 端点 + snapshot 摘要），自动放行角标归 D 篇 Step 4。
> 对齐现有实现：`web/src/App.tsx`（弹窗壳/设置菜单/toast/askConfirm）、`web/src/components/Topology.tsx`
> （`.set-ov` 全屏面板 + 密钥打码先例）、`web/src/hooks/useSnapshot.ts`（SSE 状态流）、
> `web/src/lib/api.ts`（apiJson/apiPost/x-atrium-key）、`web/src/components/Markdown.tsx`（安全渲染）、
> `web/src/index.css`（design tokens，六主题 + light 模式）。
>
> 变更分级（openspec 规则）：本篇属「面板可视状态」= **Standard**，但作为 Critical 的 teamkb 提案
> （B 篇 §7 Step 5）的前端分册合入同一 `openspec/changes/teamkb/`；其中新增的
> 「密级密钥进浏览器 localStorage」触碰到密钥物料的存放位置，须在 spec Scenario 中明示（§8 风险 1）。

---

## 1. 目的

B 篇给机队补上了知识沉淀层的后端，但没有 UI 它只是 13 个 curl 端点。本篇定义团队页的
**「知识/技能」面板**：一个入口查全团队知识、就地增删改、密级可见可控。

设计原则（全部是对现有先例的引用，不是发明）：

1. **面板 = 全屏弹窗，不是路由**。App.tsx 没有 router，「组网」「事件」「帮助」都是
   `AnimatePresence` 包裹的 `.set-ov/.set` 弹窗（App.tsx:3116-3128、Topology.tsx:221-241），
   知识面板同款，入口挂顶栏「设置」下拉菜单，与「组网」同级（App.tsx:1967-1970 的 `pop-i` 模式）。
2. **零新依赖、零状态库**。React 19 `useState` + 自定义 hook（`useTeamKb`），照抄 `useSnapshot`
   的「hook 即 store」模式；不引 pinia/zustand/tailwind/组件库，样式全部进 `index.css` 现有 token 体系。
3. **密级文案与能力不硬编码**。级别名、keySet、clearance、admin、配额全部来自
   `GET /api/teamkb/meta`（B §5.1「前端零硬编码」）；颜色是唯一的前端常量（§6.1，安全语义色）。
4. **安全渲染**。正文走自研 `<Markdown>`（无 dangerouslySetInnerHTML，天然防 XSS）；
   检索 snippet 的 `<mark>` 高亮用 split-to-ReactNode 手写（§5.2），同样不碰 innerHTML。
5. **App.tsx 只增 ~10 行**（菜单项 + open 状态 + 渲染 + Esc 注册）。App.tsx 已 3300+ 行，
   一切新逻辑收进 `components/TeamKb.tsx` 与 `hooks/useTeamKb.ts`。

**「知识/技能」与 A 篇四类知识的关系**：B 篇契约是扁平 `kb_doc`（无 kind/section 字段），
A 篇的 capability/resource/account/sop 四类在 UI 层用**保留标签约定**落地（§2.3）：
页签「全部 / 项目能力 / 开发资源 / 账号 / 技能 SOP」= `?tag=kind/<slug>` 过滤，
「技能」页签即 SOP 类。用户在哪个页签点「新建」，就自动带上对应 kind 标签。

非目标（本期 UI 不做）：协同编辑/评论、附件上传（B §9.4 演进）、版本历史 diff、
A 篇 §2.3 的 secret 密文「取回」交互（B 契约未定义该端点，见 §9 演进）、账号到期提醒
（依赖 A 篇 `expiresAt` 字段，同列演进）。

---

## 2. 数据与接口

### 2.1 面板消费的端点清单（B §5 子集 + 快照）

| 端点 | 面板用途 | 触发时机 |
| --- | --- | --- |
| `GET /api/teamkb/meta` | clearance/admin/levels 文案/keySet/limits/fts，驱动全部权限态 UI | 面板打开、kbkey 变更、ACL 变更后 |
| `GET /api/teamkb/docs` | 列表浏览（tag/level/q/since/cursor/limit） | 打开、切页签/过滤、加载更多、增量刷新 |
| `GET /api/teamkb/docs/:id` | 详情全文（含 body） | 点列表行；403 时渲染「密级不足」卡（§5.6） |
| `GET /api/teamkb/search` | 全文检索（snippet/score/tookMs） | 搜索框非空（180ms 延迟，§5.2） |
| `POST /api/teamkb/docs` | 新建 | 编辑弹窗提交（新建态） |
| `POST /api/teamkb/docs/:id/update` | 更新（带 baseVersion 乐观锁） | 编辑弹窗提交（编辑态） |
| `POST /api/teamkb/docs/:id/remove` | 软删除（带 baseVersion） | 详情页删除 → askConfirm |
| `GET /api/teamkb/acl` | 密级现状（keySet/keyHint/counts） | 仅 `meta.admin=true`：ACL 分节展开时 |
| `POST /api/teamkb/acl/level-key` | 设/生成/清密级密钥 | ACL 面板操作 |
| `POST /api/teamkb/acl/sync-max-level` | 机队复制上限 | ACL 面板操作 |
| snapshot 顶层 `teamkb` 摘要 | `{ count, maxUpdatedAt, localRev, syncMaxLevel, fts }`（B §6.4） | SSE 既有 `snapshot` 事件捎带，**不加通道不加轮询** |

不消费：`digest`/`sync`/`sync/push`（peer 专用，前端永不触碰）。

### 2.2 前端类型与 api 封装

web 侧不从 `src/` import 类型（`useSnapshot.ts:124-134` 本地定义 `Snapshot` 是先例），
新增 `web/src/lib/kb.ts` 镜像 B 篇 §3.3 的 `KbLevel/KbDoc/KbDocMeta` 并补 meta/acl 形状：

```ts
// web/src/lib/kb.ts —— 类型 + 端点封装（字段以 src/types.ts 为源，B 篇 Step 1 落地后对齐）
export interface KbMeta {
  ok: boolean; enabled: boolean;
  clearance: KbLevel; admin: boolean;
  levels: { level: KbLevel; label: string; keySet?: boolean }[];
  syncMaxLevel: KbLevel; count: number; maxUpdatedAt: number; fts: boolean;
  limits: { maxBodyBytes: number; maxDocs: number; maxTags: number };
}

/** 密级密钥：localStorage["atrium.kbkey"]，只进 x-teamkb-key 头，绝不进 query/日志 */
export function getKbKey(): string { try { return localStorage.getItem("atrium.kbkey") ?? ""; } catch { return ""; } }
export function setKbKey(k: string) { k ? localStorage.setItem("atrium.kbkey", k) : localStorage.removeItem("atrium.kbkey"); }
export function kbHeaders(): Record<string, string> { const k = getKbKey(); return k ? { "x-teamkb-key": k } : {}; }

/** 全部端点收口（apiJson/apiPost 已自动带 x-atrium-key，api.ts:33-54）：
 *  kb.meta() / kb.list(opts) / kb.get(id) / kb.search(q, opts)
 *  kb.create(input) / kb.update(id, patch) / kb.remove(id)
 *  kb.acl() / kb.setLevelKey(level, key?, generate?) / kb.setSyncMaxLevel(level)
 *  GET 用 apiJson(path, { headers: kbHeaders() })，POST 用 apiFetch 包一层带上 kbHeaders。 */
```

`useSnapshot.ts` 的 `Snapshot` 接口追加（B §6.4）：

```ts
export interface Snapshot {
  // ...现有字段不动...
  /** 团队知识库摘要：localRev 变化 = 该重拉列表了 */
  teamkb?: { count: number; maxUpdatedAt: number; localRev: number; syncMaxLevel: number; fts: boolean };
}
```

localStorage 约定（统一 `atrium.*` 前缀，同 `atrium.key`/`atrium.view`/`atrium.notify` 先例）：

| 键 | 内容 | 说明 |
| --- | --- | --- |
| `atrium.kbkey` | 密级密钥明文 | 浏览器是唯一存放点；UI 打码展示、可一键清除（§6.4） |
| `atrium.kbTab` | 上次停留的 kind 页签 | 面板重开恢复，轻量记忆 |
| `atrium.kbSeenAt` | 上次打开面板时的 `maxUpdatedAt` | 设置菜单角标「新增 N 条」计数依据（§3.2） |

### 2.3 kind → 保留标签映射（A 篇四类 × B 篇扁平 docs）

```ts
// TeamKb.tsx 顶部常量。kind 是 UI 侧组织约定，非密级文案，允许前端硬编码（§1 原则 3 的例外）
export const KB_KINDS = [
  { slug: "capability", tag: "kind/capability", label: "项目能力" },
  { slug: "resource",   tag: "kind/resource",   label: "开发资源" },
  { slug: "account",    tag: "kind/account",    label: "账号" },
  { slug: "sop",        tag: "kind/sop",        label: "技能 SOP" },
] as const;
```

- 页签 = `{ 全部, ...KB_KINDS, 未归档 }`；「未归档」= 不带任何 `kind/*` 标签的条目
  （agent 通过 curl 直接入库的条目天然落这里，B §7 Step 5 的 agent 用法不受约定破坏）。
- 在某页签点「新建」→ tags 预填对应 `kind/<slug>`（用户可删，删了即归未归档）。
- 过滤实现：「全部」不传 tag；kind 页签传 `?tag=kind/<slug>`；「未归档」前端过滤
  （`docs` 接口无「不含某 tag」参数，首版在已加载页内客户端滤，接口不动）。

---

## 3. 组件结构

### 3.1 文件落位与组件树

```
web/src/
├─ lib/kb.ts                    # §2.2 类型 + 端点封装 + kbkey 存取
├─ hooks/useTeamKb.ts           # 面板全部数据态与副作用（§4）
├─ components/
│  ├─ TeamKb.tsx                # 面板壳 + 布局（唯一被 App.tsx import 的组件）
│  ├─ kb/KbToolbar.tsx          # 搜索框 + clearance 徽标 + 密钥钮 + 新建钮 + admin 钮
│  ├─ kb/KbTabs.tsx             # kind 页签（全部/四类/未归档）+ level/tag 过滤 chips
│  ├─ kb/KbList.tsx             # 左栏列表：行卡片、加载更多、空态、更新浮条
│  ├─ kb/KbDetail.tsx           # 右栏详情：meta 头 + Markdown 正文 + 操作行 + 403 卡
│  ├─ kb/KbEditModal.tsx        # 新建/编辑弹窗（title/level/tags/author/body + 预览）
│  ├─ kb/KbAclPanel.tsx         # 密级管理分节（meta.admin 才渲染，§6.5）
│  ├─ kb/KbKeyPopover.tsx       # 密级密钥输入浮层（打码/清除，§6.4）
│  └─ kb/KbLevelChip.tsx        # 密级徽标（全面板唯一色源，§6.1）
└─ index.css                    # 追加 --kb-l0..3 token + .kb-* 类（一个连续区块）
```

组件树（props 单向，`useTeamKb` 的返回值在 TeamKb 解构后下传，同 App→视图的现状模式）：

```
App（+菜单项「知识/技能」+ kbOpen 状态 + Esc 注册）
└─ TeamKb  { open, onClose, snap, onToast, askConfirm }
   ├─ .set-h 标题栏：知识/技能 · teamkb ｜ KbToolbar
   ├─ KbTabs
   ├─ .kb-main（左右分栏）
   │  ├─ KbList        { rows, mode:"list"|"search", total, cursor, onLoadMore, onPick }
   │  └─ KbDetail      { doc | notFound | forbidden{need,have}, onEdit, onRemove }
   ├─ KbAclPanel       （admin 时作为底部分节，topo-sec 先例）
   ├─ KbKeyPopover / KbEditModal （浮层，AnimatePresence）
   └─ .set-f 底栏：「共 N 条 · 我的密级 Lx · FTS/简易匹配」计数（ev-count 先例，EventStream.tsx:125-129）
```

### 3.2 入口与面板壳

- **入口**：设置下拉菜单加一项，与「组网」同款 `pop-i`（App.tsx:1967-1970）：

```tsx
<button className="pop-i" onClick={() => { setSettingsMenuOpen(false); setKbOpen(true); }}>
  <span className="pop-ico">❖</span>知识/技能
  {kbNew > 0 && <span className="pop-cnt">+{kbNew}</span>}
</button>
// kbNew：snap.teamkb.count 与上次打开时记录（atrium.kbSeenAt 对应的 count 快照）之差；
// 面板每次打开时刷新 kbSeenAt。数据源是既有 SSE 快照，角标零额外请求。
```

- **壳**：`.set-ov` 遮罩 + `.set.kb-modal`，动效参数与全库统一
  （`initial={{y:-18,scale:0.97,opacity:0}}` + spring 420/32，Topology.tsx:222-239 同款）；
  宽度类 `.kb-modal { width: min(1080px, 96vw); }` 照 `.ev-modal`（index.css:2149）加宽先例。
  点遮罩关闭；Esc 关闭注册进 App.tsx:1594-1609 的集中处理（顺序见 §5.7）。
- 命令面板（⌘K）加一条静态命令「打开 知识/技能」（App.tsx:1664-1682 的 hay 列表追加）。

### 3.3 布局（桌面 ≥860px）

```
┌────────────────────────────── .kb-modal ──────────────────────────────┐
│ ❖ 知识/技能 · teamkb          [⌕ 搜索…      ] [L2 机密▾] [🔑] [＋新建] [×] │ ← .set-h + KbToolbar
│  全部 │ 项目能力 │ 开发资源 │ 账号 │ 技能SOP │ 未归档      #发布 ×  L≥1 ×   │ ← KbTabs + 过滤 chips
├──────────────── .kb-list (360px) ─────────┬──────── .kb-detail ────────┤
│ ▍内网 PyPI 发布流程            [L1 内部]   │  内网 PyPI 发布流程          │
│   twine upload 前先用 build_wheels…      │  ┌ meta 行 ───────────────┐  │
│   老王 · macbook-a1b2 · v3 · 2小时前      │  │[L1 内部] 老王@macbook…  │  │
│ ▍atrium 组网排障手册           [L0 公开]   │  │v7 · 10-08 14:32 更新   │  │
│   …检查 Windows 防火墙是否放行<mark>专用…   │  │#组网 #排障 (可点=过滤)  │  │
│   · win-dev-01 · v7 · 昨天               │  └───────────────────────┘  │
│ ▍跳板机账号档案                [L2 机密]   │  ## 步骤                    │
│   （密级不足时 excerpt 为空，仅标题+徽标）    │  1. ssh ops@…              │
│                                          │  <Markdown text={body}/>    │
│        [ 加载更多（37/128） ]              │            [✎编辑] [🗑删除]  │
├──────────────────────────────────────────┴────────────────────────────┤
│ 共 128 条 · 我的密级 L2(机密) · 检索: FTS          （admin 时 +「密级管理」钮）│ ← .set-f
└───────────────────────────────────────────────────────────────────────┘
```

- 窄屏（<860px）单栏：列表全宽，点行后详情以覆盖层滑入（`framer-motion` x 位移），
  详情内「‹ 返回列表」。移动端只保证可用，不做深度适配（现状面板皆是桌面优先）。
- 详情未选中时右栏空态：`.p-empty`（index.css:1014）斜体灰字「选一条知识，或 ⌘/ 搜索」。

### 3.4 组件 × 复用先例对照

| 组件 | 复用样式/交互先例 | 出处 |
| --- | --- | --- |
| KbToolbar 搜索框 | `.pj-search`（⌕ 图标 + input + 结果计数 + ✕ 清除；`/` 聚焦 Esc 清空） | ProjectsView.tsx:843-860、index.css:2554-2571 |
| KbTabs | `.pj-mode-switch` 分段钮（`role="tablist"` 补 aria，ViewSwitcher 先例） | ProjectsView.tsx:1093-1097、ViewSwitcher.tsx:11-28 |
| KbList 行 | `.set-row` 双行结构（主标题 + 灰摘要 + 右侧 mono 元信息），命中 `mark` 样式 | index.css:1640-1660、2572 |
| 过滤 chips | `.pj-tag-chip` 圆角药丸（点标签=加过滤，✕=移除） | index.css:2639-2644 |
| KbDetail 正文 | `<Markdown text={body}/>` 安全渲染 | components/Markdown.tsx |
| KbEditModal | `.pj-modal-ov/.pj-modal` 小弹窗 + TagEditor（逗号分隔 Enter 提交） | ProjectsView.tsx:313-336、253-283 |
| KbAclPanel 行 | NotifyPanel 的 `Row(label,desc,on,toggle)` + `.nt-sw` 开关、`topo-sec` 分节 | NotifyPanel.tsx、index.css:2127-2146 |
| KbKeyPopover 打码 | 团队密钥 `showKey` 眼睛切换 + `xxxx…yyyy` 打码 | Topology.tsx:307-325 |
| 密级徽标 | `.chip` 半透明公式（底 0.10 / 边 0.45 / 文字本色） | index.css:890-899 |
| 确认/提示 | `askConfirm({danger:true})`、`onToast(showToast)` | App.tsx:984、1215 |
| 「仅本机不同步」角标 | `.topo-tag.warn` | index.css:2318-2324 |

---

## 4. 状态管理（useTeamKb）

### 4.1 状态形状

hook 挂载即取数（TeamKb 仅在 `kbOpen` 时渲染，关闭即卸载，无后台驻留）：

```ts
// web/src/hooks/useTeamKb.ts
export function useTeamKb(snap: Snapshot | null, onToast: (m: string) => void) {
  // —— 服务端自描述 ——
  const [meta, setMeta]     = useState<KbMeta | null>(null);   // null = 加载中
  const [metaErr, setMetaErr] = useState("");                  // 非空 = 面板级错误态（如 enabled:false）
  // —— 列表/检索（同一 rows，mode 区分来源）——
  const [mode, setMode]     = useState<"list" | "search">("list");
  const [rows, setRows]     = useState<KbDocMeta[]>([]);
  const [total, setTotal]   = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);   // null = 没有更多
  const [loading, setLoading] = useState(false);               // 180ms 延迟生效，chatLoading 先例（App.tsx:614-623）
  const [searchInfo, setSearchInfo] = useState<{ tookMs: number; fts: boolean } | null>(null);
  // —— 过滤器（全部进 list/search 的 query）——
  const [tab, setTab]       = useState<string>(localStorage["atrium.kbTab"] ?? "all"); // all|kind/*|unkinded
  const [q, setQ]           = useState("");
  const [tag, setTag]       = useState<string | null>(null);   // 单选足够；tag 与 kind 页签正交
  const [level, setLevel]   = useState<KbLevel | null>(null);
  // —— 详情 ——
  const [openId, setOpenId] = useState<string | null>(null);
  const [doc, setDoc]       = useState<KbDoc | null>(null);
  const [docErr, setDocErr] = useState<{ status: 403 | 404; need?: number; have?: number } | null>(null);
  // —— 编辑弹窗 ——
  const [editing, setEditing] = useState<{ base?: KbDoc } | null>(null);  // null=关；base 无=新建
  // —— 实时性 ——
  const [stale, setStale]   = useState(0);        // localRev 变化计数 → 更新浮条「N 处更新 · 点击刷新」
  const [aclOpen, setAclOpen] = useState(false);  // admin 分节展开态
}
```

### 4.2 数据流

```
                       ┌──────────────────────────────────────────────┐
 SSE snapshot 事件 ────▶│ snap.teamkb.localRev 变化（≠挂载时值）          │
 （useSnapshot 既有）    │   面板打开中 → setStale(n+1) → 列表顶部浮条    │
                       │   面板关闭   → 仅设置菜单角标计数（§3.2）        │
                       └──────────────────────────────────────────────┘
 用户动作（切页签/过滤/搜索/翻页/点行/写操作）
   ├─ 读：kb.list / kb.search / kb.get ——带 kbHeaders()——▶ rows / doc
   └─ 写：kb.create / kb.update / kb.remove
        ├─ ok      → 乐观更新 rows/doc + onToast("已保存") + setStale(0)
        ├─ 403     → onToast("密级不足（需 Lx）") + 密钥钮脉冲动画提示
        ├─ 409     → askConfirm 展示 current 摘要（谁/何时/v几）→「加载最新」或「强制覆盖」
        └─ 其它/网络 → onToast(error 中文原文，后端已保证可读)
```

刷新策略的取舍：**不做 `since` 增量静默合并**——列表可能在 cursor 分页中途，插入新行会造成
「翻页错位 + 视觉跳动」。统一用「浮条提示 + 用户点击后整页重拉（回到第一页，保留过滤器）」。
`stale` 浮条只在 `localRev` 真变化时出现，digest 门控保证无变更零打扰（B §6.3）。
写操作后的乐观更新是唯一例外：只改本行、不动排序位置，下一轮自然刷新收敛。

### 4.3 取数时序与竞态

- 挂载：`meta()` 与 `list()` 并行发；meta 失败 → 面板级错误态（`enabled:false` 显示
  「知识库未启用」+ 原因；401 由顶层密钥闸门兜住，不会走到这）。
- 过滤/搜索变化 → 重拉：所有异步回包过 `reqSeq` 自增序号闸门（旧请求回包丢弃），
  防「快速切页签时慢回包覆盖新结果」——现状代码无此保护是因为没有并发列表请求，这里必须有。
- kbkey 变更（§6.4）→ 重拉 `meta()`：clearance 变了则 rows/doc 全部作废重拉（低密级视角
  不能残留高密级数据在内存/DOM 里）。
- `openId` 变化 → `get(id)`；回包时若 `openId` 已变则丢弃（同 reqSeq 思路）。

### 4.4 与 App 的接口面

TeamKb 的 props 收敛为 `{ open, onClose, snap, onToast, askConfirm }`——全部是 App 现有
资源的透传（Topology/EventStream 同款），App 不为面板新增任何状态逻辑，只多 `kbOpen` 一个布尔。

---

## 5. 增删改查与检索交互

### 5.1 浏览（列表）

- 行结构（KbList）：左缘 3px 密级色条（`.kb-row` 的 border-left，扫一眼即分级）+
  标题（单行截断）+ 密级徽标；第二行 excerpt（两行截断，检索态含 `<mark>`）；
  第三行 mono 灰字 `author · origin · vN · ago()`（时间格式复用 `useSnapshot.ts:242-249` 的 `ago`）。
- 排序固定 `updatedAt DESC`（B §5.2），不提供排序切换（首版减法）。
- 分页：底部「加载更多（已载 n / total）」按钮，`cursor` 传回 `nextCursor`；
  total 来自响应，「未归档」页签为前端过滤、不显示 total。
- 空态分叉：无条目 → `.p-empty`「知识库还是空的 · 点右上「新建」写入第一条」；
  过滤无结果 → 「无匹配条目 · 清除过滤」。
- 行点击 → 右栏详情；当前行 `.on` 高亮（viewseg-i.on 同款 accent 描边）。

### 5.2 检索

- `/` 或 ⌘/ 聚焦搜索框（ProjectsView.tsx:851-860 先例），Esc 清空并退出检索态。
- `q` 非空 → **180ms 延迟生效**（照抄 chatLoading 的 setTimeout 模式，App.tsx:614-623，
  全库无防抖依赖，不引）→ `GET /search?q=&tag=&level=&limit=50`；q 清空 → 回 `list` 模式。
- 检索态差异：行内展示 `excerpt` snippet；底栏显示「命中 N 条 · 4ms · FTS」
  （`meta.fts=false` 或响应 `fts:false` → 显示「简易匹配」，B §3.2 降级模式的如实告知）。
- `<mark>` 高亮**不用 innerHTML**：

```tsx
// KbList 内的纯函数：按 <mark> 切段渲染，杜绝 snippet 注入
function renderExcerpt(s: string) {
  return s.split(/(<\/?mark>)/).reduce<{ out: ReactNode[]; hit: boolean }>(
    (acc, part) => {
      if (part === "<mark>") acc.hit = true;
      else if (part === "</mark>") acc.hit = false;
      else acc.out.push(acc.hit ? <mark key={acc.out.length}>{part}</mark> : part);
      return acc;
    }, { out: [], hit: false }).out;
}
```

- 检索永远受服务端 clearance 静默过滤（B §4.2），前端**不做**任何「还有隐藏结果」的暗示（§6.2）。
- 短词（<3 字）后端自动 LIKE 兜底、`score=null`，UI 无需感知差异（不显示相关度分数，减法）。

### 5.3 新建

- 入口：工具栏「＋新建」（主按钮样式）；面板聚焦且非输入态时按 `n`。
- KbEditModal 字段（新建态）：

| 字段 | 控件 | 规则（客户端预检，服务端仍是权威） |
| --- | --- | --- |
| 标题 | input | 必填 trim 非空；>200 字截断提示（meta 无 title 上限字段，按 B §3.5 常量 200） |
| 密级 | 分段选择器（KbLevelChip 复用） | 只列 `level ≤ clearance` 的级别；`keySet=false` 的级别置灰 + 注「未设密钥 · 仅本机」（loopback clearance=3 除外，见 §6.3） |
| 标签 | TagEditor（逗号/空格分隔，Enter 提交） | kind 页签内新建时预填 `kind/<slug>` 药丸（可删）；≤ meta.limits.maxTags 个 |
| 署名 | input | 预填上次用值（`atrium.kbAuthor`）；留空则服务端补 `cfg.label`（B §5.5） |
| 正文 | textarea + 「预览」切换钮 | 预览 = `<Markdown>` 渲染；字节数实时显示 `x / 2MB`，超 meta.limits.maxBodyBytes 禁用提交 |

- 提交 → `POST /docs` → 200：关弹窗、toast「已写入，机队稍后自动同步」、新条目插入
  rows 头部并直接打开详情。400 各分支文案后端已给中文（「标题不能为空」「知识库已满」…），toast 原文。

### 5.4 编辑（乐观锁全流程）

- 详情页「✎编辑」→ 同一 KbEditModal，预填 `doc`，**记下 `baseVersion = doc.version`**。
- 密级改动：选择器仍限 `≤ clearance`。B §4.2 的 `max(旧,新) ≤ clearance` 规则在
  `≤ clearance` 限制下自动满足，无需特判。
- 提交 → `POST /docs/:id/update`（带 baseVersion）：
  - **200**：`doc`/`rows` 就地更新（version+1、updatedAt=now），toast「已保存」。
  - **409**：`askConfirm` 展示冲突——「条目已被他人修改：{current.author} 于 {ago(current.updatedAt)}
    更新到 v{current.version}」，两个出口：**「加载最新」**（放弃本地改动，重开编辑弹窗预填
    current 全文）/ **「强制覆盖」**（不带 baseVersion 重发，last-write-wins，danger 色按钮）。
    不自动合并、不做 diff（版本历史列 §9 演进）。
  - **403**：编辑中密钥被清/降级的边界情况，toast + 关弹窗回详情（详情会重新走 403 卡）。
- 编辑弹窗有未保存改动时关闭 → askConfirm「放弃改动？」。

### 5.5 删除

- 详情页「🗑删除」→ `askConfirm({ danger:true, title:"删除这条知识？",
  desc:"全机队将不再显示（墓碑保留 30 天）。" })` → `POST /remove`（带 baseVersion，409 同 §5.4）。
- 成功：关详情、rows 移除该行、toast「已删除」。软删除语义在确认文案里说清，不提供「恢复」入口
  （墓碑恢复是 loopback 数据库操作，不进 UI）。

### 5.6 单条 403 体验（「存在但看不了」）

`GET /docs/:id` 返回 403 `{ need, have }` 时（只可能来自旧链接/检索缓存穿透，列表本身静默过滤），
详情区渲染 inline 卡片而非 toast 弹走：

```
┌ 🔒 密级不足 ────────────────────────┐
│ 这条知识需要 L2（机密），当前视角 L0。 │
│ [输入密级密钥…]      [返回列表]      │
└────────────────────────────────────┘
```

「输入密级密钥」直接开 KbKeyPopover，提交后自动重拉 meta + 该条。

### 5.7 键盘与 Esc 层级

Esc 集中注册在 App.tsx:1594-1609，按浮层深度依次消费（每次只关一层）：

```
KbEditModal 开 → 关弹窗（先过「放弃改动」确认）
否则 KbKeyPopover/askConfirm 开 → 关浮层
否则详情打开且窄屏覆盖态 → 退回列表
否则 → 关整个面板（= onClose）
```

面板内快捷键仅在焦点不在 input/textarea 时生效：`/` 聚焦搜索、`n` 新建、`↑↓` 移动选中行、
`Enter` 打开详情（命令面板 App.tsx:2717-2728 的键盘导航先例）。

---

## 6. 密级展示

### 6.1 徽标与色彩 token

密级色是**安全语义色，不随装饰主题变**（六套主题只在 light 模式做对比度微调），
`:root` 定义一次 + light 覆盖（index.css:101-127 的覆盖块先例），每级配 `-rgb` 三元组供
半透明公式用（`.chip` 先例：底 `rgba(…,0.10)`、边 `rgba(…,0.45)`、文字本色）：

```css
:root {
  --kb-l0: #8b8fa3; --kb-l0-rgb: 139,143,163;  /* 灰 · 团队公开（B §4.3 建议色） */
  --kb-l1: #60a5fa; --kb-l1-rgb: 96,165,250;   /* 蓝 · 内部 */
  --kb-l2: #f59e0b; --kb-l2-rgb: 245,158,11;   /* 橙 · 机密 */
  --kb-l3: #ef4444; --kb-l3-rgb: 239,68,68;    /* 红 · 绝密 */
}
:root[data-mode="light"] { --kb-l0: #6b7080; --kb-l1: #2563eb; --kb-l2: #d97706; --kb-l3: #dc2626; }
```

`KbLevelChip`（唯一色源，全面板禁止散写颜色）：

```tsx
export function KbLevelChip({ level, label, dim }: { level: KbLevel; label?: string; dim?: boolean }) {
  return <span className={`kb-lv l${level} ${dim ? "dim" : ""}`} title={`密级 ${level}`}>
    L{level}{label ? ` ${label}` : ""}</span>;
}
// label 来自 meta.levels（后端下发文案）；dim = keySet=false 的置灰态
```

出现位置：列表行右缘、详情 meta 头、编辑弹窗选择器、底栏「我的密级」、ACL 面板行。
列表行另加左缘 3px 色条（§5.1），色条与徽标同 token。

### 6.2 clearance 视角的如实表达

- 工具栏常驻「我的密级」徽标：`L2 机密`（clearance=3 且 meta.admin 时显示 `L3 · 本机`，
  提示这是 loopback 特权视角，换台机器/换个浏览器就不是了）。
- 底栏计数：`共 {meta.count} 条`——**这是 clearance 内可见数**，不是全库数；文案不写「全库」。
- **静默过滤零暗示**：列表/检索不显示「有 N 条被隐藏」（B §4.2 有意设计：低密级视角不能
  感知高密级条目的存在）。用户觉得少了，出路是主动点 🔑 输密钥升视角——UI 不推他。
- `meta.levels` 里 `keySet=false` 的级别：编辑弹窗选择器置灰 + 注「未设密钥 · 仅本机可达」；
  这是唯一允许暴露的「级别存在性」（级别表本身不是条目数据，B §5.1 设计即下发）。

### 6.3 密级密钥（kbkey）输入与管理 — KbKeyPopover

🔑 按钮（有 kbkey 时按钮带当前级别色点）点开小浮层，Topology 团队密钥区（L307-325）同款交互：

- 输入框 type=password + 眼睛切换打码（`abcd…wxyz`）；「应用」→ `setKbKey()` → 重拉 meta →
  clearance 变化则全量重拉列表/详情（§4.3）→ toast「密级视角：L2 机密」。
- 密钥无效的表现：后端 sha256 比对不中 → clearance 停留原级，UI 对比 meta 前后 clearance
  未变且输入非空 → 提示「密钥不正确或该级未启用」（后端无专门错误码，用 clearance 差值判断）。
- 「清除」钮：`setKbKey("")` + 重拉，回团队密钥视角（clearance=0）。
- 浮层底部固定警示行（mono 小字）：`密钥仅存于本浏览器（localStorage），共享机器请随手清除`。
- 403 场景（§5.6）与「新建时想选更高级别」场景都引导到这里；403 时 🔑 按钮加一次
  脉冲动画（core-pulse 关键帧先例，index.css:2083）。

### 6.4 ACL 管理面板（仅 meta.admin=true）— KbAclPanel

`meta.admin=false` 时组件整体不渲染、底栏入口不出现（**前端判断只看 meta.admin，
不自行猜测 loopback**——浏览器无从得知，B §5.1 设计即为此）。展开为面板底部分节
（`topo-sec` 分节样式），数据来自 `GET /acl`：

```
密级管理（仅本机）
  统计行：L0 100 · L1 25 · L2 3 · L3 0 · 墓碑 12        （counts.byLevel + deleted）
  ┌ 内部   L1  密钥已设 9f3a…c21d      [重设] [清除] ┐   （keyHint 帮管理员认钥匙）
  ├ 机密   L2  密钥已设 6d1f…e9a2      [重设] [清除] ┤
  ├ 绝密   L3  未设密钥（仅本机可达）    [生成] [手填] ┤
  └ 机队复制上限 syncMaxLevel  [3 绝密 ▾]             ┘
```

- **设/生成密钥**：`[生成]` → `POST /acl/level-key {level, generate:true}` → 200 回显明文一次，
  模态展示 + 「复制」钮 + 文案「明文仅此一次，抄给需要该密级的机器/成员」（B §5.6 的回显语义）；
  `[手填]` → 输入框（≥8 位校验，400 文案后端给）。
- **清除密钥**：askConfirm danger，文案必须含 B §5.6 的两个后果——
  「清除后该级条目除本机外无人能读（条目不会销毁）；已分发的旧密钥立即失效」。
- **syncMaxLevel**：下拉 0-3；调低时 askConfirm 警示「高于新上限的条目将停止对外同步，
  **已同步出去的副本不会被召回**」（B §5.6/风险 5 的如实告知义务）。变更成功后重拉 meta
  （snapshot 摘要随之变化，全队 UI 自然一致）。
- 所有 ACL 写操作成功 → toast + `acl()`/`meta()` 重拉；403（非 loopback 访问）→ 理论不可达
  （入口就不渲染），仍兜底 toast 后端文案。

### 6.5 同步域角标

详情页：`doc.level > snap.teamkb.syncMaxLevel` 时 meta 行追加 `.topo-tag.warn` 角标
「仅本机 · 不进机队」——解释「为什么队友看不到这条」，与 §6.4 的警示呼应。
（snapshot 摘要里的 syncMaxLevel 是本机视角，正好是详情所需语义。）

---

## 7. 落地步骤

前置依赖：B 篇 Step 1-3 已完成（端点可用 + snapshot 带 teamkb 摘要）。前端约 **3 人日**，
按依赖序五步，每步可独立提交验证：

### Step 1 — 基础件（0.5 天）

`lib/kb.ts`（类型 + kb 封装 + kbkey 存取）、`useSnapshot.ts` Snapshot 补 `teamkb` 字段、
`index.css` 追加 `--kb-l0..3` token（含 light 覆盖）与 `.kb-modal/.kb-lv/.kb-row` 基础类、
`KbLevelChip`。验证：控制台手调 `kb.meta()` 走通密钥头；徽标四色在六主题 + light 下截图核对。

### Step 2 — 面板骨架 + 列表（1 天）

`TeamKb.tsx` 壳（.set-ov/.kb-modal/Esc 注册/命令面板项）、设置菜单入口 + `kbNew` 角标、
`useTeamKb` 的 meta/list/分页/reqSeq 竞态闸门、`KbTabs`（kind 页签 + 未归档前端过滤）、
`KbList` + 空态、`localRev` 更新浮条。验证：双机——A 机 curl 写入，B 机面板浮条出现、
点击刷新可见；切页签/加载更多/过滤组合。

### Step 3 — 详情 + 增删改（1 天）

`KbDetail`（Markdown/meta 行/操作行/403 卡/同步域角标）、`KbEditModal`（新建/编辑双态、
limits 预检、预览切换、TagEditor + kind 预填）、409 冲突 askConfirm 流程、删除确认、
「放弃改动」守卫。验证：双机并发编辑同一条 → 后提交方见 409 弹窗两出口都走通；
超 2MB 正文被客户端拦下；墓碑删除后对端消失。

### Step 4 — 检索（0.5 天）

搜索框（/ 聚焦、180ms 延迟、✕ 清除）、`/search` 接入、`renderExcerpt` 安全高亮、
tag/level 过滤 chips 与检索正交、底栏命中统计/简易匹配提示。验证：中文子串检索命中 +
`<mark>` 高亮正常；构造含 `<script>` 的正文确认 Markdown 与 snippet 两路都不执行。

### Step 5 — 密级与 ACL（0.5 天）

`KbKeyPopover`（打码/应用/清除/警示行/403 联动脉冲）、`KbAclPanel`（统计/keyHint/生成回显/
清除警示/syncMaxLevel 警示）、「我的密级」徽标与底栏计数。验证：设 L2 密钥 → 另一浏览器
输密钥前后列表差异（静默过滤生效）；生成密钥回显仅一次；清除密钥 askConfirm 文案含
两个后果；非 loopback 访问（peer 域名打开面板）不见 ACL 入口。

收尾（并入 teamkb 提案的 Critical 变更，B §7 Step 5）：openspec spec 补 UI 侧 Scenario
（密级密钥浏览器存放告知、静默过滤无暗示、409 显式化、ACL 仅 admin 渲染）；
`npm run typecheck && npm run build`；README「界面」一节补一句。

---

## 8. 风险

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | **kbkey 明文存 localStorage**：XSS 或共享机器上可被读取 | 密级视角被冒用 | 与既有 `atrium.key`（团队密钥）同一威胁模型与存放方式，未扩大边界；UI 常驻警示 + 一键清除；atrium 前端无第三方脚本、Markdown 自研渲染无 innerHTML，XSS 面本身收窄；spec Scenario 明示告知义务；演进：sessionStorage 模式（关浏览器即失，需重输） |
| 2 | **静默过滤造成「知识丢了」错觉**：低密级用户看不到条目也无提示 | 支持成本/信任 | 底栏「共 N 条」+「我的密级」徽标常显视角；README/帮助文案解释密级模型；这是 B §4.2 的有意安全设计，UI 不破坏它 |
| 3 | **409 冲突弹窗用户误点「强制覆盖」**，他人改动被吞 | 数据丢失 | 默认焦点在「加载最新」；「强制覆盖」danger 色 + 文案写明后果；baseVersion 由 UI 必带（B 风险 3 的同一防线） |
| 4 | **localRev 浮条与写操作乐观更新打架**：自己刚写完，peer 合并又触发 stale | 浮条噪音 | 写操作成功后记录当前 localRev 为基线，仅「基线之后再变」才出浮条；浮条不自动重拉（用户点击才刷） |
| 5 | **kind 标签约定无后端强制**：agent/手填条目不带 `kind/*`，页签统计失真 | 组织混乱 | 「未归档」页签显式收编而非隐藏；从页签新建自动带标签；若后续 B 契约加 kind 字段（§9），前端只改 KB_KINDS 映射一处 |
| 6 | **App.tsx 巨型组件继续膨胀** | 维护性 | 面板全部逻辑在 TeamKb/useTeamKb，App 只增菜单项/状态/渲染/Esc 约 10 行；props 面收敛为 5 个（§4.4） |
| 7 | **大正文（≤2MB）编辑/预览卡顿** | 体验 | textarea 不做实时预览（切换钮按需渲染 Markdown）；字节计数用轻量 length 估算；列表接口本就不带 body（B §5.2），滚动路径永远轻 |
| 8 | **检索/列表回包竞态**（快速切过滤时旧回包覆盖新结果） | 界面错数据 | reqSeq 序号闸门（§4.3），所有取数回调先验序号 |
| 9 | **六主题 × light 的密级色对比度**：固定色值在某些主题背景下过暗/过亮 | 可读性 | 密级色带 0.10 底 + 0.45 边的 chip 公式自带缓冲；light 模式单独覆盖（§6.1）；Step 1 验收即六主题截图核对 |
| 10 | **admin 判定依赖 meta 单次快照**：面板长开期间用户从本机浏览器换到远程访问，ACL 入口残留 | 越权尝试 | ACL 写端点服务端 isLocal 兜底（403 文案 toast）；面板每次打开都重拉 meta，残留窗口 = 单次会话；不做定时重拉（减法） |

---

## 9. 演进方向（本期不做，组件已留缝）

1. **secret 取回交互**（A 篇 §2.3 的密码密文区）：待后端补 `GET /entry/:id/secret` 契约后，
   KbDetail 加「密文在 @属主机 · 取回」按钮 + 双侧事件流提示；KbEditModal 的 account 类
   增加独立密码输入框（与正文分离，A 篇风险 2 的交互引导）。
2. **版本历史/diff**：409 弹窗的「加载最新」升级为左右 diff（body 按行对比即可，无需库）；
   依赖后端保留历史版本（B §9 演进 3 的删除广播可一并做）。
3. **账号到期提醒**：若契约补 `expiresAt`（A 篇 AccountFields），复用提醒中心
   （App.tsx:1438 AlertItem + notify.ts 桌面通知）做到期推送，样式对齐值班提醒。
4. **命令面板直搜知识**：⌘K 输入 `kb <词>` 即时调 `/search` 前 5 条进命令面板结果，
   Enter 直开详情（hay 列表是现成扩展点，App.tsx:1664-1682）。
5. **附件**：B §9.4 落地后，KbEditModal 加拖拽上传（项目图标 data URL 先例）、KbDetail 加预览。
6. **agent 引用回链**：事件流 `kb.update` 条目点击 → 打开面板定位该条（EventStream 的
   `onJump(nodeId)` 模式扩展为 `onJumpDoc(kbId)`）。
