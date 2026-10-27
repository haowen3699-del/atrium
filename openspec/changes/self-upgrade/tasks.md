# Tasks (completed)

- [x] `src/update.ts`：索引版本查询（缓存）、版本比较、真自启作业检测、升级脚本生成
- [x] `GET /api/update` / `POST /api/update`；`/api/settings` 支持 `autoUpgrade`
- [x] 升级脚本三分支：launchd kickstart / systemd restart / 等端口后 nohup 自启（Windows 用 cmd）
- [x] 自动升级：启动 20s 后检查一次 + 每 6 小时一次（默认关）
- [x] 前端：帮助面板升级区 + 顶栏徽标 + 新版本提示；自动升级开关
- [x] 修 launchd `kickstart -k` 会杀掉正在启动的实例 → 改为不带 `-k`
- [x] 启动器端口选择：首选端口等待 10 秒再看顺延（配合 SO_REUSEADDR）
- [x] 端到端实测：0.1.10→0.1.11→0.1.12→0.1.13→0.1.14 连续自升级，最终回到 6080 且版本正确
