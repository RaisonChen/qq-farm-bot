# Debug Session: long-run-capture
- **Status**: [OPEN]
- **Issue**: 服务运行较长时间后，Bot 点击“开始抓取”没有响应；预期是请求被接收并启动抓取。
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-long-run-capture.ndjson

## Reproduction Steps
1. 重启 capture 服务以加载诊断上报。
2. 持续运行服务至问题出现。
3. 在 Bot 端点击“开始抓取”。
4. 保持服务运行，反馈 Bot 的实际表现。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Bot 到服务端的请求或鉴权会话在长时间运行后失效 | High | Low | Pending |
| B | 前一抓取会话或队列锁未释放，阻塞新的开始请求 | High | Low | Pending |
| C | mitmproxy 子进程或其通信通道退出/卡住 | Medium | Low | Pending |
| D | 长时间运行产生资源耗尽或未处理异常，导致 HTTP 处理器不再完成 | Medium | Medium | Pending |
| E | Bot 侧收到服务端响应前超时或异常但未展示 | Medium | Low | Pending |

## Instrumentation
- `src/logger.js`: 将服务现有关键事件通过本地 HTTP 上报至调试服务；涵盖启动、排队、代理启动失败、mitmdump 退出与抓取回传，不改变抓取或会话逻辑。

## Log Evidence
Pending reproduction.

## Verification Conclusion
Pending.
