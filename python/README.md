# opencode-fleet-atrium

一个包 = 完整服务：看板 UI + 本机进程扫描 + 局域网自动发现 + 团队密钥。

## 安装

```bash
pip install -U opencode-fleet-atrium
```

## 使用

```bash
atrium                 # 起服务并自动打开浏览器（默认 6080，被占用自动顺延）
atrium --port 6082     # 指定端口
atrium --no-open       # 不自动开浏览器
atrium --print-key     # 打印团队密钥
```

每台机器装同一个包、跑 `atrium`：

- 同一网段会自动互相发现（UDP 广播），不需要配置文件、不需要 sidecar
- 各机器把团队密钥填成同一个（在「组网」面板里粘贴一次），即可互相看到并下发指令
- 本机浏览器免密钥；从局域网打开需填一次密钥

配置与数据放在 `~/.atrium/`（Windows 为 `%APPDATA%\atrium\`）。

## 规格与源码

源码与规格文档（OpenSpec）：https://github.com/haowen3699-del/atrium
规格入口：`openspec/config.yaml`，能力规格在 `openspec/specs/<capability>/spec.md`。
