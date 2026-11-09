#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "📦 首次运行，正在安装依赖..."
  npm install
fi

echo "🚀 正在启动 PanSo Node..."
npm start
