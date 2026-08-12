# QQ Farm Bot

> 支持多账号管理的 QQ 农场自动化工具。

## 简介

这是一个基于 Node.js 的 QQ 农场自动化工具，支持多账号管理，并提供 Web 控制面板、实时日志、数据统计、好友管理、活动、商城、图鉴和后台管理等功能。

## 本次更新（2026-08-03）

### 土地展示重做

- 参考游戏内农场土地布局，实现等距视角土地地块展示。
- 完善所有普通作物生产阶段图片，并可展示生长阶段。
- 完善四格作物展示，根据官方资源生成对应图片截图。
- 新增土地资源图片更新指令。

### 新增生涯统计

- 新增神秘商人自动购买开关。

### 新增生涯统计

- 点击头像即可弹出生涯统计页面。

### 历史问题修复

- 修复每日任务进度展示错误。
- 修复反馈的种子获取策略问题。


## 历史更新（2026-07-31）

### 心许千灯星垂野活动支持

- 新增“心许千灯星垂野”活动页面，支持查看活动进度、星砂余额和奖励状态。
- 支持“观星礼录”星宿奖励领取与“星砂兑换商店”奖励批量兑换。
- 支持领取“千星游记”阶段奖励和“节令小札”节令奖励。
- 新增“千星游记”和“观星礼录”自动领取选项，每 5 分钟检查一次可领取奖励。
- 补充活动作物、种子、装扮等奖励配置及活动专属图片资源。

### WASM协议更新

- TSDK/WASM 升级至官方 `v3.8.6.1785240280`，同步适配新版运行时、数据段解密和完整性校验。
- 更新默认 WASM 文件及 SHA-256 校验，确保网关 Token、ACE 心跳和多账号运行正常。
- 新增 TSDK/WASM 更新检查工具，可自动比较版本、导入导出、数据段和关键运行参数。
- 补充标准更新、验证与回退流程，降低后续官方协议升级的适配风险。



### 2×2 作物种植

- 修复活动四格作物“星语铃花”的占地配置，背包中增加 2×2 标识。
- 优化四格作物土地预留：优先选择已清空土地更多的区域，并在进度相同时保持原预留，减少预留位置反复变化。
- 收获后土地状态不明确时不再自动铲除，避免误铲仍在生长或进入下一季的四格作物。
- 补充土地展示、活动作物配置和 2×2 种植预留测试。

## 当前状态

- 后端：Node.js / CommonJS / Express / Socket.IO
- 前端：Vue 3 / Vite / TypeScript / Pinia / UnoCSS
- 包管理：pnpm workspace
- 部署：源码运行、Docker、二进制打包
- 默认面板端口：`3007`
- 默认管理员账号：`admin`
- 默认管理员密码：`admin`

部署后请立即修改默认密码。

## 技术栈

**后端**

[<img src="https://skillicons.dev/icons?i=nodejs" height="48" title="Node.js 20+" />](https://nodejs.org/)
[<img src="https://skillicons.dev/icons?i=express" height="48" title="Express 4" />](https://expressjs.com/)
[<img src="https://skillicons.dev/icons?i=socketio" height="48" title="Socket.IO 4" />](https://socket.io/)

**前端**

[<img src="https://skillicons.dev/icons?i=vue" height="48" title="Vue 3" />](https://vuejs.org/)
[<img src="https://skillicons.dev/icons?i=vite" height="48" title="Vite 7" />](https://vitejs.dev/)
[<img src="https://skillicons.dev/icons?i=ts" height="48" title="TypeScript 5" />](https://www.typescriptlang.org/)
[<img src="https://cdn.simpleicons.org/pinia/FFD859" height="48" title="Pinia 3" />](https://pinia.vuejs.org/)
[<img src="https://skillicons.dev/icons?i=unocss" height="48" title="UnoCSS" />](https://unocss.dev/)

**部署**

[<img src="https://skillicons.dev/icons?i=pnpm" height="48" title="pnpm 10" />](https://pnpm.io/)
[<img src="https://skillicons.dev/icons?i=docker" height="48" title="Docker" />](https://www.docker.com/)

## 环境要求

- Node.js 20+
- pnpm，推荐通过 `corepack enable` 启用
- Docker，可选，仅 Docker 部署时需要

## 快速启动

```powershell
git clone https://github.com/RaisonChen/qq-farm-bot.git
cd qq-farm-bot

corepack enable
pnpm install
pnpm build:web
pnpm dev:core
```

git pull
启动后访问：

- 本机：`http://localhost:3007`
- 局域网：`http://<你的IP>:3007`

如需修改端口：

```powershell
$env:ADMIN_PORT="你的新端口"
pnpm dev:core
```

## Docker 部署

```bash
git clone https://github.com/cwser/qq-farm-bot.git
cd qq-farm-bot

docker compose up -d --build
docker compose logs -f
```

停止并移除容器：

```bash
docker compose down
```

Docker 部署修改版本号或配置后，建议重新构建容器：

```bash
docker compose down
docker compose up -d --build
```

## 二进制发布版

构建：

```bash
pnpm install
pnpm package:release
```

产物输出在 `dist/` 目录。

| 平台 | 文件名 |
| --- | --- |
| Windows x64 | `qq-farm-bot.exe` |
| Linux x64 | `qq-farm-bot` |
| macOS Intel | `qq-farm-bot-x64` |
| macOS Apple Silicon | `qq-farm-bot-arm64` |

运行：

```bash
# Windows：双击 exe 或在终端执行
.\qq-farm-bot-win-x64.exe

# Linux / macOS
chmod +x ./qq-farm-bot
./qq-farm-bot
```

程序会在可执行文件同级目录自动创建 `data/`，用于保存账号、用户、日志和缓存等运行时数据。

## 登录与安全

- 面板首次访问需要登录
- 默认管理员账号：`admin`
- 默认管理员密码：`admin`
- 部署后请立即修改默认密码
- 不要把运行时数据、账号文件、日志或 `.env` 文件提交到仓库

## 数据与隐私

以下内容已通过 `.gitignore` 排除，不应提交到仓库：

- `core/data/`
- `node_modules/`
- `web/dist/`
- `.env`
- `.env.*`
- `*.log`
- `logs/`
- `tmp/`

`core/data/` 会在运行时自动生成，可能包含账号、用户、登录日志、好友缓存、统计数据和其他敏感信息。备份或迁移服务器时可以单独处理该目录，但不要提交到 GitHub。

## 项目结构

```text
qq-farm-bot/
├── core/                  # 后端（Node.js 机器人引擎）
│   ├── src/
│   │   ├── config/        # 配置管理
│   │   ├── controllers/   # HTTP API
│   │   ├── gameConfig/    # 游戏静态数据
│   │   ├── models/        # 数据模型与持久化
│   │   ├── proto/         # Protobuf 协议定义
│   │   ├── runtime/       # 运行时引擎与 Worker 管理
│   │   └── services/      # 业务逻辑（农场、好友、任务等）
│   └── client.js          # 后端入口
├── web/                   # 前端（Vue 3 + Vite）
│   ├── src/
│   │   ├── api/           # API 客户端
│   │   ├── components/    # Vue 组件
│   │   ├── stores/        # Pinia 状态管理
│   │   └── views/         # 页面视图
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

## 常用命令

```bash
# 安装依赖
pnpm install

# 构建前端
pnpm build:web

# 启动后端和面板
pnpm dev:core

# 前后端检查
pnpm lint

# 从QQ官方资源更新全部植物阶段图片（在仓库根目录执行）
npm run extract:plant-phases -- \
  --install-tool \
  --download-missing \
  --all

# size: 2 的 Spine 作物也会自动从本机 mainscene atlas 拆出静态阶段图（需 ffmpeg）

# 打包发布版
pnpm package:release
```

## 维护说明

- 只提交源码、配置、锁文件、静态资源和文档。
- 不提交 `core/data/`、依赖目录、构建产物或本地日志。
- 更新 TSDK/WASM 时遵循
  [TSDK/WASM 标准更新手册](core/docs/tsdk-update-runbook.md)，并先运行
  `cd core && npm run inspect:tsdk -- --wasm <文件> --game-js <文件> --baseline <当前版本>`。
- 适配新限时活动时遵循
  [限时活动适配标准手册](core/docs/activity-update-runbook.md)，先采集“打开、领取、操作、
  刷新”完整抓包，再补协议、资源和种子/植物/果实映射。
- 更新植物阶段图片时，在仓库根目录运行
  `npm run extract:plant-phases -- --install-tool --download-missing --all`。工具只读QQ缓存，
  将缺失资源下载到临时目录，并把转换后的透明PNG与清单写入
  `core/src/gameConfig/plant_images/`。2x2 Spine 作物的成熟动画由多个骨骼附件组成，
  静态页面使用官方成熟物品图作为第 6 阶段。
- 更新功能前优先确认是可见功能、隐藏功能、内部能力还是休眠能力。
- 前端大页面逐步拆分到 `components/`、`composables/` 和 `stores/`。
- 后端入口只保留 wiring，具体接口逻辑优先下沉到领域路由、helper 或 service。
- 中文显示异常时先确认文件真实 UTF-8 内容，不要只按终端乱码判断。

## 特别感谢

- 基于 [Penty-d/qq-farm-bot-ui](https://github.com/Penty-d/qq-farm-bot-ui) 二改
- 核心功能：[linguo2625469/qq-farm-bot](https://github.com/linguo2625469/qq-farm-bot)
- 部分功能：[QianChenJun/qq-farm-bot](https://github.com/QianChenJun/qq-farm-bot)
- 扫码登录：[lkeme/QRLib](https://github.com/lkeme/QRLib)
- 推送通知：[imaegoo/pushoo](https://github.com/imaegoo/pushoo)

## 免责声明

本项目仅供学习与研究用途。使用本工具可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。
