#!/usr/bin/env bash
# QQ 农场抓包服务启动脚本（macOS / Linux）
# 可选环境变量见 README。
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 18+。"
  exit 1
fi

if ! command -v mitmdump >/dev/null 2>&1; then
  echo "[提示] 未检测到 mitmdump（mitmproxy）。抓包功能需要它。"
  echo "        安装方式：pip install mitmproxy   （需要 Python 3.9+）"
  echo
fi

exec node src/server.js
