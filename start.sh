#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "📦 首次运行，正在安装依赖..."
  npm install
fi

if [ "$1" = "--daemon" ] || [ "$1" = "-d" ]; then
  echo "🛡️ 正在以 7x24 自愈守护模式启动 盘松 (PANSONG)..."
  npm run daemon
else
  echo "🚀 正在启动 盘松 (PANSONG)..."
  npm start
fi
