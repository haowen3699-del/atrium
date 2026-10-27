# Atrium · AI 机队看板

> 一台机器装一个包，就是一个完整服务：看板 UI + 本机进程扫描 + 局域网自动发现 + 团队密钥互信。
> 同网段自动互相发现，不需要额外 sidecar，也不用维护 peers 列表。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PyPI](https://img.shields.io/pypi/v/opencode-fleet-atrium.svg)](https://pypi.org/project/opencode-fleet-atrium/)

Atrium 是一个面向 **opencode / cc-connect** 多机多会话场景的实时看板：

- **一屏看全机队**：所有机器上的会话按「机器 → 项目目录」「时间」「标签」「置顶」组织
- **实时状态**：书写 / 待答 / 就绪 / 休眠 / 完成，运行中卡片带跑马灯与流动光晕
- **直接对话**：右侧面板看完整对话、发指令、批准权限、回答提问、切换模型
- **会话草稿**：每个会话独立草稿，未发送内容留在原会话并在卡片上标「草稿」
- **团队协作**：成员 = 机器 · 项目目录，组长出计划后自动拆解派活
- **组网零配置**：UDP 广播自动发现同网段实例，团队密钥互信
- **一个包装完**：包内自带 Node 运行时，目标机无需预装 Node

## 安装

macOS / Windows / Linux 用同一个包，pip 会按平台自动选择 wheel：

```bash
pip install -U opencode-fleet-atrium
atrium                 # 起服务并自动打开浏览器（默认 6080，被占用自动顺延）
```

配置与数据在 `~/.atrium/`（Windows 为 `%APPDATA%\atrium\`）。

### 自定义 PyPI 源

升级源默认是公开 PyPI，可指向自建镜像，优先级：环境变量 > 配置文件 > 默认值。

```bash
ATRIUM_PYPI_INDEX=https://your-mirror.example.com/simple atrium
```

或在 `~/.atrium/config.json` 里写 `"pypiIndex": "https://your-mirror.example.com/simple"`，
也可以在面板「帮助 → 升级源」里直接修改。

## 常用命令

```bash
atrium                 # 前台启动，打印本机地址 / 局域网地址 / 团队密钥
atrium info            # 查看运行状态、访问地址、团队密钥
atrium autostart on    # 开机自启（macOS launchd / Windows 登录项 / Linux systemd --user）
atrium autostart off
atrium autostart status
atrium --print-key     # 只打印团队密钥
```

## 组网

- 同一网段的实例通过 UDP 广播自动互相发现（跨网段可在配置里手工加 `peers`）
- 各机器把**团队密钥**填成同一个即可互通；新机器装完会提示「发现机队，要加入吗？」
- 本机浏览器免密钥；从局域网打开需填一次团队密钥
- 面板会提示「密钥不匹配」「版本不一致」

## 升级

- 帮助面板可查看版本并**一键升级**，也可开启自动升级（每 6 小时检查一次）
- 升级流程：写独立脚本 → 退出当前进程 → pip 安装 → 由 launchd/systemd/计划任务重新拉起
- 日志：`~/.atrium/logs/upgrade.log`；升级结果在帮助面板可见

## 开发

```bash
npm install
npm run dev                       # 起 hub（源码模式），默认 6080
npm run dev:web                   # 前端 dev server（vite，代理到 6080）
npm run build                     # 构建前端到 web/dist
npm run typecheck

# 打 pip 包（每平台一个 wheel，内含 Node 运行时）
python3 python/build_wheels.py --targets mac-arm64,mac-x64,win-x64
```

配置示例见 `fleet.config.example.json`（真实配置 `~/.atrium/config.json` 含团队密钥，已被 .gitignore 忽略）。

## 仓库结构

```
src/            hub 服务端（Node/TS）：节点轮询、进程扫描、SSE 快照、peer 合并、自动发现、团队密钥
web/src/        前端（React + Vite + Tailwind v4 + cult/ui）：看板、事件流、组网、提醒、帮助
python/         pip 发行包（opencode-fleet-atrium）：启动器 + 内置 Node 运行时 + 打包脚本
opencode_fleet_sidecar/   早期 Python sidecar（能力已内置，保留作历史）
remote-sidecar.mjs        早期 Windows Node 单文件 sidecar（同上）
```

## 规格文档

项目使用 OpenSpec 记录「应该怎样」的契约，实现细节在 change 记录里：

```
openspec/specs/fleet-hub/spec.md          # 快照契约、节点轮询、peer 合并、事件流、控制转发
openspec/specs/lan-discovery/spec.md      # UDP 自动发现、团队密钥鉴权、加入引导、版本一致性
openspec/specs/local-agent-scan/spec.md   # 本机 opencode server 发现、凭据恢复、进程扫描
openspec/specs/board-ui/spec.md           # 展示风格、状态分类、会话交互、值班提醒
openspec/specs/packaging-release/spec.md  # 一个包=完整服务、启动透明、自启管理、发布流程
openspec/specs/security-credentials/spec.md  # 密钥与凭据处理边界
```

## 许可

[MIT](LICENSE) © 2026 Atrium contributors
