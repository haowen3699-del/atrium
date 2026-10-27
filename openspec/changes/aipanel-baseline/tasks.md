# Tasks (completed)

## hub / 后端
- [x] 节点轮询、状态派生（online/stale/offline）、SSE `/api/stream`
- [x] 事件环形缓冲 + `GET /api/events`（since/node/type/limit）
- [x] peer 合并改为"只接受对方本机条目"，修掉多层 `@A @B` 套娃
- [x] UDP 自动发现（广播 + 回环、TTL、同机多实例）
- [x] 团队密钥鉴权（loopback 豁免、`/api/node-info` 公开、`?key=` 供 SSE）+ `/api/settings` 热更新并落盘
- [x] 配置迁移到 `~/.atrium/config.json`，首次运行自动生成 id/label/key
- [x] 本机 opencode server 发现；凭据从进程环境恢复（逐进程配对、多候选试通）；`ATRIUM_DISABLE_ENV_SCAN` 开关
- [x] 手工凭据补录 `POST /api/local-auth`（先验证再落盘、立即生效）
- [x] run agent 扫描补齐 OpenCode 桌面版主进程（排除 helper/renderer/gpu/crashpad/serve）
- [x] 端口探测超时放宽到 8s、连续 3 轮失败才摘除节点、发现异常不再静默
- [x] 版本一致性：peer 列表带 older/newer；`/api/help` 自描述

## 前端
- [x] 四种展示风格（泳道/螺旋/轨道/磁贴）+ 切换器 + `V` 快捷键 + 记忆
- [x] 螺旋/轨道：稳定槽位（增删不跳位）、拖拽旋转带惯性、悬停减速不停转、rAF 自愈
- [x] 值班提醒：新增待处理 → 浮层卡片 + 桌面通知 + 提示音 + 标题徽标；四开关 + 测试
- [x] 事件流弹窗：2s 拉取、可暂停、按节点/类型过滤、新事件高亮、点行跳转
- [x] 延迟 sparkline（泳道头 + 磁贴）
- [x] 组网面板：本机信息/密钥显示复制改设、自动发现列表、手工节点、版本不一致提示
- [x] 加入机队引导：发现未互通实例时主动弹出，粘密钥即加入；"稍后再说"按实例集合记忆
- [x] 使用帮助面板：实例信息 + 安装/升级命令 + 常用命令 + 排障（由 `/api/help` 提供）
- [x] 本机端口凭据补录表单；密钥闸门（局域网访问）
- [x] 修掉事件流 key 撞车导致列表"收不回去"

## 发行与自动化
- [x] `python/` 包：启动器（找运行时、端口顺延、banner、非法实例识别）、内置 Node 运行时、`atrium info`
- [x] 开机自启：launchd / Windows 注册表 / systemd --user，含 preflight 与 PATH 注入
- [x] 构建脚本 `python/build_wheels.py`：三平台 wheel，修掉 setuptools 缓存导致的串平台运行时
- [x] 发布到内网 PyPI 0.1.0 → 0.1.6，并从内网源端到端验证安装/运行/自启
- [x] 源码推送 GitLab，含口令文件 gitignore + 示例脱敏（含 `.pypirc.example`）
