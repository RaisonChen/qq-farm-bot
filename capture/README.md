# QQ 农场抓包登录服务（capture）

前端「添加账号 → 抓包登录」出现如下报错时：

```
request to http://127.0.0.1:8450/api/sessions failed, reason:
connect ECONNREFUSED 127.0.0.1:8450
```

说明**这个抓包服务没有运行**。core 端只是把请求转发到抓包服务（默认
`http://127.0.0.1:8450`），真正启动代理、拦截 QQ / 微信小程序流量、抓取
`code` / `gid` / 好友列表的工作由本服务完成。本目录即是这个缺失的服务。

## 架构

```
浏览器前端 ──POST /api/capture/sessions──▶ core (转发层)
                                              │  Bearer <apiToken>
                                              ▼
                                        本抓包服务 (:8450)
                                              │  spawn
                                              ▼
                                        mitmdump (mitmproxy 代理)
                                              │  拦截 HTTPS
                                              ▼
                                   QQ / 微信小程序登录流量
```

## 依赖

- Node.js 18+
- [mitmproxy](https://mitmproxy.org/)（提供 `mitmdump` 可执行文件）

安装 mitmproxy（需 Python 3.9+）：

```bash
pip install mitmproxy
```

首次运行会在 `~/.mitmproxy/` 生成 CA 证书。手机 / 抓包设备需要**信任这张
证书**才能解密 HTTPS 流量（前端「使用说明」里有引导，证书可从
core 的 `/api/public/capture-certificate/...` 链接下载，core 会回源到本服务的
`/cert/mitmproxy-ca-cert.cer`）。

## 启动

```bash
# 方式一：仓库根目录
pnpm dev:capture

# 方式二：本目录脚本
./start-capture.sh        # macOS / Linux
start-capture.bat         # Windows

# 方式三
node src/server.js
```

启动后日志会打印 `apiBase`（如 `http://127.0.0.1:8450`）和 `apiToken`。

## 在 core 后台完成对接

进入 core 管理后台 →「系统配置 / 抓包服务配置」：

1. **抓包服务地址**：填服务日志里的 `apiBase`（默认 `http://127.0.0.1:8450`）。
2. **API Token**：填服务日志里的 `apiToken`。
3. 勾选**启用**并保存。可点「测试连接」验证（会调用本服务 `/api/health`）。

对接成功后，前端「抓包登录」即可正常「开始抓取」。

## 配置项（环境变量）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `CAPTURE_HOST` | 服务监听地址 | `127.0.0.1` |
| `CAPTURE_PORT` | 服务端口 | `8450` |
| `CAPTURE_API_TOKEN` | 固定 API Token；不设置则自动生成并存到 `data/api-token.txt` | 自动生成 |
| `CAPTURE_PROXY_PORTS` | mitmproxy 代理端口池（逗号分隔）。池中有几个端口即可几人同时抓包，其余人自动排队 | `8451` |
| `CAPTURE_PUBLIC_HOST` | 对外可达主机名/IP（供设备设置代理/装证书） | 自动探测局域网 IPv4 |
| `CAPTURE_AUTO_STOP_SEC` | 前端展示的自动停止倒计时（秒） | `300` |
| `CAPTURE_MAX_HOLD_SEC` | 单个会话占用端口的最长秒数，超时强制释放端口并切给排队队首 | `180` |
| `CAPTURE_QUEUE_TTL_SEC` | 排队者存活超时（秒）；超过该时长未轮询（关页/断网）则从队列剔除 | `30` |
| `CAPTURE_MITMDUMP_BIN` | `mitmdump` 可执行文件路径 | `mitmdump` |
| `CAPTURE_MITM_CONFDIR` | mitmproxy 证书/配置目录 | `~/.mitmproxy` |

## 排队模式

代理端口是稀缺资源（默认端口池只有 1 个），因此抓包采用**先到先得 + 排队**：

- **端口空闲**：`/api/capture/start` 直接分配端口并启动代理。
- **端口占满**：请求不再报错，而是进入 FIFO 队列，响应返回排队信息
  （`queue.queued=true` / `position` 名次 / `queueLength` 总人数）。前端会持续轮询，
  **轮到队首且有空闲端口时自动开始抓取**，无需用户再次点击。
- **最长占用上限**：持有端口的会话超过 `CAPTURE_MAX_HOLD_SEC`（默认 180 秒）会被
  **强制释放**（停 mitm、回收端口），避免有人挂着页面把后面所有人卡住。
  被强制释放时若**尚未抓到 code**，该会话会**自动重新排到队尾**继续等待——
  用户无需关闭/重开页面，前端会从「剩余时间」自然切回「排队中」，轮到时再次自动开始；
  已抓到 code 的会话视为完成，不再排队。
- **幽灵排队剔除**：排队者每次轮询即心跳；超过 `CAPTURE_QUEUE_TTL_SEC`（默认 30 秒）
  没有轮询（关页/断网）会被移出队列，不阻塞后面的人。

> 想支持多人并发抓包时，把 `CAPTURE_PROXY_PORTS` 配成多个端口即可，队列会按
> 空闲端口数并行放行。

## 对外接口（core 契约）

所有 `/api/*` 请求都要求 `Authorization: Bearer <apiToken>`，并可带
`x-capture-session-id` 指定会话。

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/health` | GET | 健康检查（uptime / sessions / portPool / queueLength） |
| `/api/sessions` | POST | 创建会话 |
| `/api/capture/start` | POST | 启动抓取代理（body: `{ mode, bypassHosts }`）；端口占满时返回 `queue` 排队信息 |
| `/api/sessions/:id/state` | GET | 查询会话状态与已抓取数据；排队中会刷新心跳并回传排队名次 |
| `/api/capture/stop` | POST | 停止抓取（保留会话） |
| `/api/sessions/:id` | DELETE | 删除会话并释放代理 |
| `/cert/mitmproxy-ca-cert.cer` | GET | 下载 mitmproxy CA 证书 |

## 抓包解析逻辑

实际的流量解析在 mitmproxy 插件 [`mitm/capture_addon.py`](./mitm/capture_addon.py)：
它按 host/path 关键字识别小程序登录与好友请求，从 query/body/响应中提取
`code` / `gid` / `openid` 与好友 GID，再异步回传给本服务聚合。

> 不同版本小程序的登录链路可能变化。若某次更新后抓不到 `code`，通常只需在
> `capture_addon.py` 顶部的 `LOGIN_HOST_HINTS` / `LOGIN_PATH_HINTS` /
> `CODE_KEYS` 常量中补充新的匹配关键字，无需改动 Node 侧。

## 测试

```bash
node --test test/*.test.js
```

测试直接复用 core 端 `addCapturedValues()`，确保本服务返回的快照结构能被
core 正确消费。
