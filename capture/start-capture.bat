@echo off
REM QQ 农场抓包服务启动脚本（Windows）
REM 用法：双击运行，或在命令行执行 start-capture.bat
REM 可选环境变量：
REM   CAPTURE_API_TOKEN   固定 API Token（不设置则自动生成并保存到 data\api-token.txt）
REM   CAPTURE_PORT        服务端口（默认 8450）
REM   CAPTURE_PUBLIC_HOST 对外可达主机名/IP（默认自动探测局域网 IPv4）
REM   CAPTURE_PROXY_PORTS 代理端口池（逗号分隔，默认 8451）；有几个端口即可几人同时抓包，其余排队
REM   CAPTURE_MAX_HOLD_SEC  单会话最长占用端口秒数，超时强制释放切给下一位（默认 180）
REM   CAPTURE_QUEUE_TTL_SEC 排队者存活超时秒数，超时未轮询则移出队列（默认 30）

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 18+。
  pause
  exit /b 1
)

where mitmdump >nul 2>nul
if errorlevel 1 (
  echo [提示] 未检测到 mitmdump（mitmproxy）。抓包功能需要它。
  echo         安装方式：pip install mitmproxy   （需要 Python 3.9+）
  echo         安装后请重新运行本脚本。
  echo.
)

node src\server.js
pause
endlocal
