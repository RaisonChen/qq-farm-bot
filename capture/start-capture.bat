@echo off
REM QQ 农场抓包服务启动脚本（Windows）
REM 用法：双击运行，或在命令行执行 start-capture.bat
REM 可选环境变量：
REM   CAPTURE_API_TOKEN   固定 API Token（不设置则自动生成并保存到 data\api-token.txt）
REM   CAPTURE_PORT        服务端口（默认 8450）
REM   CAPTURE_PUBLIC_HOST 对外可达主机名/IP（默认自动探测局域网 IPv4）

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
