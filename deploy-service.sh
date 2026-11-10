#!/usr/bin/env bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"
SERVICE_NAME="com.pansong.daemon"
OS_TYPE="$(uname -s)"

if [ -z "$NODE_BIN" ]; then
  echo "❌ 未检测到 Node.js，请先安装 Node.js (>= 18)"
  exit 1
fi

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "📦 正在安装依赖..."
  (cd "$APP_DIR" && npm install --omit=dev)
fi

mkdir -p "$APP_DIR/data"

if [ "$1" = "uninstall" ] || [ "$1" = "stop" ]; then
  if [ "$OS_TYPE" = "Darwin" ]; then
    PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "✅ 已卸载 macOS LaunchAgent 自启服务"
  elif [ "$OS_TYPE" = "Linux" ]; then
    sudo systemctl stop pansong 2>/dev/null || true
    sudo systemctl disable pansong 2>/dev/null || true
    sudo rm -f /etc/systemd/system/pansong.service
    sudo systemctl daemon-reload
    echo "✅ 已卸载 Linux systemd 服务"
  fi
  exit 0
fi

if [ "$OS_TYPE" = "Darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$PLIST_DIR/${SERVICE_NAME}.plist"
  mkdir -p "$PLIST_DIR"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${APP_DIR}/src/daemon.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${APP_DIR}/data/pansong.out.log</string>
  <key>StandardErrorPath</key>
  <string>${APP_DIR}/data/pansong.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load -w "$PLIST_PATH"
  echo "✅ 已部署为 macOS 开机自启后台服务 (${SERVICE_NAME})"
  echo "🌐 访问地址: http://localhost:3200"
  echo "📄 日志路径: $APP_DIR/data/pansong.out.log"
  echo "💡 如需停止并卸载自启: ./deploy-service.sh uninstall"

elif [ "$OS_TYPE" = "Linux" ]; then
  UNIT_PATH="/etc/systemd/system/pansong.service"
  CURRENT_USER="$(whoami)"

  sudo tee "$UNIT_PATH" > /dev/null <<EOF
[Unit]
Description=PanSong Multi-Drive Aggregator Service
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/daemon.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable pansong
  sudo systemctl restart pansong
  echo "✅ 已部署为 Linux systemd 7x24 后台服务 (pansong.service)"
  echo "🌐 访问地址: http://localhost:3200"
  echo "💡 查看状态: sudo systemctl status pansong"
fi
