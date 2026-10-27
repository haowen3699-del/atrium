# Change: 版本检测与自升级（一键 / 可选自动）

## Status
Shipped — opencode-fleet-atrium 0.1.10 → 0.1.14

## Why
包已经"一个包 = 完整服务"，但升级还得人工到每台机器上 pip install + 重启；机队里版本不一致时
（组网面板只提示"版本不一致"）没人愿意逐台处理，容易长期漂移。

## What Shipped
- 版本检测：`GET /api/update` 查内网索引最新版本（缓存 10 分钟），返回当前/最新/是否有更新、
  当前安装用的 python、是否被开机自启托管、手动升级命令；索引不可达时只报错不阻塞
- 一键升级：`POST /api/update` → 生成独立升级脚本（先让本进程退出，pip 升级，再按原方式拉起）
  - 被 launchd/systemd 托管 → 复用 supervisor 重启（保持端口/数据目录）
  - 手动启动 → 等首选端口释放后自己拉起（修复"升级后跑到 6081"）
  - Windows → `upgrade.cmd`（timeout 等进程退出 → pip → pythonw 重启）
  - 非 pip 包启动 → 拒绝并给出手动命令
- 可选自动升级：config `autoUpgrade`（默认关），开启后每 6 小时检查并自动升级重启
- 界面：帮助面板「版本与升级」（当前/最新/检查更新/立即升级/自动升级开关）；有新版本时顶栏
  「帮助」加徽标 + 启动 4 秒后提示一次
- 端口修复：启动器选端口改为"首选端口先等 10 秒"，升级/重启不再莫名漂到下一个端口

## References
- 规格：`openspec/specs/packaging-release/spec.md`（Version discovery / One-click upgrade / Optional auto-upgrade）
