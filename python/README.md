# Atrium · AI 机队看板

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/haowen3699-del/atrium/blob/main/LICENSE)

**一个包 = 完整服务**：看板 UI + 本机进程扫描 + 局域网自动发现 + 团队密钥互信。
面向 opencode / cc-connect 的多机多会话实时看板——装完即用，目标机无需预装 Node（wheel 内置运行时）。

## 特性

- 一屏看全机队：会话按「机器 → 项目目录」「时间」「标签」「置顶」组织
- 实时状态：书写 / 待答 / 就绪 / 休眠 / 完成；运行中卡片带跑马灯与流动光晕
- 直接对话：看完整对话、发指令、批准权限、回答提问、切换模型
- 会话草稿：每个会话独立草稿，卡片上标「草稿」
- 异常兜底：会话异常结束给出原因提示，并支持一键重发最后一条
- 团队协作：成员 = 机器 · 项目目录，组长出计划后自动拆解派活
- 组网零配置：UDP 自动发现同网段实例，团队密钥互信
- 自带升级：帮助面板一键升级 / 自动升级，升级源可自定义

## 界面

![看板 · 分组视图](https://raw.githubusercontent.com/haowen3699-del/atrium/main/docs/screenshots/board.png)

![轨道视图](https://raw.githubusercontent.com/haowen3699-del/atrium/main/docs/screenshots/orbit.png)

![会话面板](https://raw.githubusercontent.com/haowen3699-del/atrium/main/docs/screenshots/board-chat.png)

![低语输入](https://raw.githubusercontent.com/haowen3699-del/atrium/main/docs/screenshots/whisper.png)

## 安装

```bash
pip install -U opencode-fleet-atrium
```

## 使用

```bash
atrium                 # 起服务并自动打开浏览器（默认 6080，被占用自动顺延）
atrium --port 6082     # 指定端口
atrium --no-open       # 不自动开浏览器
atrium info            # 状态 / 地址 / 团队密钥
atrium autostart on    # 开机自启（launchd / 登录项 / systemd --user）
atrium --print-key     # 只打印团队密钥
```

每台机器装同一个包、跑 `atrium`：

- 同一网段自动互相发现（UDP 广播），不需要配置文件、不需要 sidecar
- 各机器把团队密钥填成同一个（在「组网」面板粘贴一次），即可互相看到并下发指令
- 本机浏览器免密钥；从局域网打开需填一次密钥

配置与数据放在 `~/.atrium/`（Windows 为 `%APPDATA%\atrium\`）。

## 自定义升级源

默认使用公开 PyPI；可指向自建镜像，优先级：环境变量 > 配置文件 > 默认。

```bash
ATRIUM_PYPI_INDEX=https://your-mirror.example.com/simple atrium
```

或 `~/.atrium/config.json` 写 `"pypiIndex": "https://your-mirror.example.com/simple"`，
也可以在面板「帮助 → 升级源」直接修改。

## 源码与规格

- 源码：https://github.com/haowen3699-del/atrium
- 规格（OpenSpec）：`openspec/specs/<capability>/spec.md`，入口 `openspec/config.yaml`
- 许可：[MIT](https://github.com/haowen3699-del/atrium/blob/main/LICENSE)
