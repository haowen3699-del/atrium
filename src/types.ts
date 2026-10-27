export interface NodeConfig {
  id: string;
  label: string;
  url: string;
  username?: string;
  password?: string;
  runAgentsUrl?: string;
}

export interface PeerConfig {
  id: string;
  label: string;
  url: string;
  token?: string;
}

export interface FleetConfig {
  port: number;
  pollIntervalMs: number;
  nodes: NodeConfig[];
  discoverLocal?: boolean;
  peers?: PeerConfig[];
  /** 本实例标识（自动生成，用于 peer 命名与去重） */
  id?: string;
  /** 本实例显示名（默认主机名） */
  label?: string;
  /** 团队密钥：所有实例填同一个才能互相拉数据/下发指令 */
  key?: string;
  /** 密钥来源：auto=首次自动生成（还没加入任何机队）/ user=用户设置过 / env=环境变量 */
  keySource?: "auto" | "user" | "env";
  /** 是否开启局域网自动发现（默认开） */
  discover?: boolean;
  /** 自动升级：发现内网索引有更新时自动升级并重启（默认关） */
  autoUpgrade?: boolean;
  /** 升级用的 PyPI 简单索引（可指向自建源；留空用内置默认，环境变量 ATRIUM_PYPI_INDEX 优先） */
  pypiIndex?: string;
  /** 首次引导完成时间（没有=还没走过引导，前端会弹组网向导；重装会重新走一遍） */
  onboardedAt?: number;
  /** 自动恢复不到凭据的本机端口 → 手填账号密码（面板里填，落盘到配置） */
  localAuth?: Record<string, { username: string; password: string }>;
  /** 自动发现的实例是否参与合并（默认开） */
  autoPeers?: boolean;
  /** 跨网段自动扫描：要扫的网段（CIDR，如 10.253.3.0/24）；留空则只扫本机 /24 */
  scanSubnets?: string[];
  /** 扫描端口（默认 6080/6081/6082） */
  scanPorts?: number[];
  /** 是否开启网段扫描（默认开） */
  scanEnabled?: boolean;
  /** 扫描间隔毫秒（默认 120000） */
  scanIntervalMs?: number;
  /** 机器（节点）显示名覆盖：nodeId -> 自定义名。存后端配置，团队共享；peer 节点用 `${peerId}::${nodeId}` 作 key */
  nodeLabels?: Record<string, string>;
  /** 团队共享元数据（标签/别名/颜色/置顶等，随快照在全队机群间合并，last-write-wins） */
  teamMeta?: Record<string, TeamMetaEntry>;
}

/** 一条团队共享元数据：v 为任意 JSON 值，at 为写入时间戳（合并时新者赢） */
export interface TeamMetaEntry {
  v: unknown;
  at: number;
}

export type NodeStatus = "online" | "stale" | "offline";

/** 一台机器的实时负载（每个 atrium 实例采集自己所在机器，peer 之间互相合并） */
export interface HostMetrics {
  /** 机器标识：与 NodeView.machine 对齐，前端据此把负载挂到对应机器 */
  machine: string;
  /** 展示名（实例名 / peer 标签） */
  label?: string;
  hostname: string;
  platform: string;
  cpuCount: number;
  /** 整体 CPU 使用率 0-100（两次采样间的平均值） */
  cpuPct: number;
  /** 系统负载 [1m, 5m, 15m] */
  loadavg: [number, number, number];
  memTotal: number;
  memUsed: number;
  /** 内存使用率 0-100 */
  memPct: number;
  /** 是否本机（hub 自己所在的机器） */
  self?: boolean;
  /** 采样时间戳 */
  at: number;
}


export interface SessionView {
  id: string;
  title: string;
  directory: string;
  busy: boolean;
  updatedAt: number;
  cost: number;
  tokens: { input: number; output: number };
  model?: string;
  /** 当前模型所属 provider（切换模型时要 providerID + modelID 一起提交） */
  providerID?: string;
  agent?: string;
  /** 用户最后一次提问 / 消息原文（用于执行中卡片、详情标题的 tip 展示） */
  lastPrompt?: string;
  /** 最近一次 session.error 的可读信息；开始新任务或发送成功后清空 */
  lastError?: string;
  lastErrorAt?: number;
}

/** opencode prompt_async 的模型引用：providerID + modelID 一起决定用哪个模型 */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** 一个 provider 下可选的模型（已裁剪，只留看板要用的字段） */
export interface ModelOption {
  id: string;
  name: string;
}

export interface ProviderModels {
  id: string;
  name: string;
  models: ModelOption[];
}

/** GET /api/nodes/:id/models 的响应 */
export interface ModelsResponse {
  ok: boolean;
  providers?: ProviderModels[];
  /** 各 provider 的默认模型：providerID -> modelID */
  default?: Record<string, string>;
  reason?: string;
}


export interface PendingPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
}

export interface PendingQuestion {
  id: string;
  sessionID: string;
  questions: { question: string; header?: string; options: { label: string; description?: string }[]; multiple?: boolean }[];
}

export interface EventView {
  ts: number;
  type: string;
  sessionID?: string;
  summary: string;
}

/** opencode 项目（/project）的看板侧元数据：图标图片本体不进快照，走 /projects/icon 按需取 */
export interface ProjectMeta {
  id: string;
  worktree: string;
  name?: string;
  icon?: {
    color?: string;
    /** 用户手动上传的图标（优先级最高） */
    hasOverride?: boolean;
    /** 自动发现的图标（favicon 等，color 未设置时才展示） */
    hasImage?: boolean;
  };
  sandboxes?: string[];
}

export interface NodeView {
  id: string;
  label: string;
  /** 覆盖前的原始名（自定义机器名时 label=自定义、baseLabel=原名；前端占位/恢复原名用） */
  baseLabel?: string;
  url: string;
  status: NodeStatus;
  lastOkAt: number | null;
  latencyMs: number | null;
  error: string | null;
  sessions: SessionView[];
  busyCount: number;
  recentEvents: EventView[];
  sseConnected: boolean;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  machine?: string;
  /** 该节点可用的工作目录（项目目录 + 额外轮询目录 + 已有会话目录，去重） */
  dirs?: string[];
  /** opencode 登记过的项目（名称/图标/颜色），目录头展示与设置用 */
  projects?: ProjectMeta[];
}

export interface RunAgentView {
  id: string;
  kind: "run";
  label: string;
  pid: number;
  procCount: number;
  bridge: string;
  proc?: string;
  workDir: string;
  cpuSeconds: number;
  active: boolean;
  busyCount: number;
  lastActivityAt: number;
  activeDir?: string;
  sessions: SessionView[];
  machine?: string;
  sessionId?: string;
  finished?: boolean;
  finishedAt?: number;
}

/** 团队派活的一个子任务（派给某成员后的执行记录） */
export interface TeamAssign {
  member: string;   // "node · dir"
  node: string;
  dir: string;
  task: string;
  sessionId?: string;
  status: "queued" | "running" | "done" | "fail";
  at: number;
  output?: string;
  /** 已转发给组长并回填给组员的问题/权限 id（前缀 q:/p:） */
  answered?: string[];
  /** 与组长中转中的一条（问题/权限）：kind + id + 发出时刻 */
  relayKind?: "question" | "permission";
  relayId?: string;
  relayAt?: number;
  /** 已把产出交组长验收、等组长结论的时刻 */
  verifyAt?: number;
  verifying?: boolean;
}

/** 团队派活任务：组长出计划 → 按策略/并发把子任务派给成员 */
export interface TeamJobView {
  id: string;
  teamId: string;
  leader: string;
  task: string;
  at: number;
  status: string;
  subtasks: string[];      // 组长拆出的计划
  assigns: TeamAssign[];   // 每条的实际派发记录（状态/产出）
  summary?: string;
  pool?: TeamMember[];     // 本任务的成员池（持久化，重启后可续跑）
  policy?: string;         // 分发策略
  concurrency?: number;    // 并发上限
  rr?: number;             // 轮询游标
  /** 组长定位（组员提问/验收都发给它） */
  leaderNode?: string;
  leaderDir?: string;
  leaderSession?: string;
}

/** 团队成员：一台机器(node)上的一个项目目录(dir) */
export interface TeamMember { node: string; dir: string; }

/** 团队调度配置 */
export interface TeamOpts {
  policy?: "idle" | "roundrobin" | "least"; // 分发策略
  includeLeader?: boolean;                  // 组长是否也接子任务
  concurrency?: number;                     // 同时最多几个成员干活
  parts?: unknown[];                        // 附加的消息 parts（文件/图片）
}

/** opencode 一键初始化的单步进度 */
export interface OcInitStep {
  key: string;
  label: string;
  status: "pending" | "running" | "ok" | "fail" | "skip";
  detail?: string;
}

/** opencode 一键初始化任务进度（按节点维度，前端轮询） */
export interface OcInitJob {
  id: string;
  node: string;
  status: "running" | "done" | "fail";
  steps: OcInitStep[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
