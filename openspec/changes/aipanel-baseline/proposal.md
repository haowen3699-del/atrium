# Change: aipanel baseline（一个包 = 完整服务 + 自动组网 + 看板四风格）

## Status
Archived — shipped in opencode-fleet-atrium 0.1.0 → 0.1.6

## Why
原来每台机器要装两样东西（hub 服务 + Python sidecar）并手写 `fleet.config.json`（nodes 要写账号密码、peers 要写 URL/token），
运行进程的识别逻辑只存在于 sidecar，跨机器依赖人工配置，装机和维护成本高。

## What Shipped
- **hub**（`src/`）：节点轮询与 SSE 快照、peer 合并（一跳，避免mesh套娃）、事件流 `/api/events`、
  本机 opencode server 发现与凭据恢复、run agent 扫描（cc-connect / openclaw / hermes / OpenCode 桌面版主进程）
- **局域网自动发现**（`src/discovery.ts`）：UDP 41800 广播 + 15s TTL + 同机多实例回环；announce 不含密钥
- **团队密钥**（`src/config.ts`、鉴权中间件）：`x-atrium-key` 鉴权；loopback 免密钥、`/api/node-info` 公开；
  密钥来源标记 auto/user/env；版本一致性提示
- **前端**（`web/src/`）：泳道/螺旋/轨道/磁贴 四种展示风格与切换、会话对话与权限批准、
  值班提醒（浮层+桌面通知+提示音+标题徽标）、事件流、组网面板、加入机队引导、使用帮助、本机端口凭据补录
- **pip 发行**（`python/`）：`opencode-fleet-atrium`，三平台 wheel 内含 Node 运行时；
  `atrium` / `atrium info` / `atrium autostart on|off|status`；launchd / 注册表 / systemd --user 自启；
  构建脚本一次产出全部平台 wheel 并直接给出发布命令
- **仓库**：源码推送至 https://github.com/haowen3699-del/atrium （含口令的配置与 `.pypirc` 已 gitignore，
  示例文件脱敏）

## References
- 仓库：https://github.com/haowen3699-del/atrium
- 内网 PyPI：https://pypi.org/simple/opencode-fleet-atrium/
- 规格：`openspec/specs/{fleet-hub,lan-discovery,local-agent-scan,board-ui,packaging-release,security-credentials}`
