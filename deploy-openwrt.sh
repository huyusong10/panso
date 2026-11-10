#!/usr/bin/env bash
# ==============================================================================
# 盘松 (PANSONG) + LuCI 插件 (luci-app-pansong) 路由器一键部署脚本
# 用法: ./deploy-openwrt.sh [ROUTER_IP] [ROUTER_USER] [ROUTER_PASS]
# ==============================================================================
set -euo pipefail

ROUTER_IP="${1:-192.168.6.1}"
ROUTER_USER="${2:-root}"
ROUTER_PASS="${3:-}"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> [1/4] 打包盘松核心服务与 LuCI 插件..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 打包核心 Node 服务（含纯 JS 依赖 node_modules）
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TMP_DIR/pansong-app.tar.gz" \
  -C "$ROOT_DIR" \
  package.json src public node_modules

# 打包 OpenWrt LuCI 插件与 procd 守护脚本
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TMP_DIR/luci-app-pansong.tar.gz" \
  -C "$ROOT_DIR/openwrt" \
  etc usr

cat > "$TMP_DIR/install-remote.sh" << 'EOF'
#!/bin/sh
set -e

if ! command -v node >/dev/null 2>&1; then
  echo "正在安装 OpenWrt Node.js 运行时..."
  ARCH=$(opkg print-architecture | awk '{print $2}' | grep -v 'all' | grep -v 'noarch' | tail -n 1)
  wget -qO /tmp/node.ipk "https://downloads.openwrt.org/releases/24.10.0/packages/${ARCH}/packages/node_20.20.2-r2_${ARCH}.ipk"
  opkg install /tmp/node.ipk
  rm -f /tmp/node.ipk
fi

mkdir -p /usr/share/pansong/data
rm -f /usr/lib/lua/luci/view/pansong/web.htm
tar -xzf /tmp/pansong-app.tar.gz -C /usr/share/pansong
tar -xzf /tmp/luci-app-pansong.tar.gz -C /
rm -f /tmp/pansong-app.tar.gz /tmp/luci-app-pansong.tar.gz /tmp/install-remote.sh

chmod +x /etc/init.d/pansong

# 注册 ucitrack 使 LuCI 保存并应用时自动触发重载
if ! uci show ucitrack 2>/dev/null | grep -q "init='pansong'"; then
  uci add ucitrack pansong >/dev/null 2>&1 || true
  uci set ucitrack.@pansong[-1].init='pansong' >/dev/null 2>&1 || true
  uci commit ucitrack >/dev/null 2>&1 || true
fi

# 清理 LuCI 缓存并重启 rpcd + 盘松服务
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache*
/etc/init.d/rpcd reload || true
/etc/init.d/pansong enable
/etc/init.d/pansong restart

sleep 2
echo "--- 盘松路由器服务状态 ---"
pgrep -fa "/usr/share/pansong/src/server.js" || true
EOF

echo "==> [2/4] 上传安装包至路由器 ${ROUTER_USER}@${ROUTER_IP}..."
run_scp() {
  if [ -n "$ROUTER_PASS" ]; then
    expect -c "
      set timeout 120
      spawn scp -O -o StrictHostKeyChecking=no \"$1\" \"${ROUTER_USER}@${ROUTER_IP}:$2\"
      expect {
        \"*password:*\" { send \"${ROUTER_PASS}\r\"; exp_continue }
        eof
      }
    "
  else
    scp -O -o StrictHostKeyChecking=no "$1" "${ROUTER_USER}@${ROUTER_IP}:$2"
  fi
}

run_ssh() {
  if [ -n "$ROUTER_PASS" ]; then
    expect -c "
      set timeout 120
      spawn ssh -o StrictHostKeyChecking=no ${ROUTER_USER}@${ROUTER_IP} \"$1\"
      expect {
        \"*password:*\" { send \"${ROUTER_PASS}\r\"; exp_continue }
        eof
      }
    "
  else
    ssh -o StrictHostKeyChecking=no "${ROUTER_USER}@${ROUTER_IP}" "$1"
  fi
}

run_scp "$TMP_DIR/pansong-app.tar.gz" "/tmp/pansong-app.tar.gz"
run_scp "$TMP_DIR/luci-app-pansong.tar.gz" "/tmp/luci-app-pansong.tar.gz"
run_scp "$TMP_DIR/install-remote.sh" "/tmp/install-remote.sh"

echo "==> [3/4] 在路由器上安装盘松引擎及 LuCI 插件..."
run_ssh "sh /tmp/install-remote.sh"

echo "==> [4/4] 部署完成！"
echo "    - 路由器 LuCI 管理页: http://${ROUTER_IP}/cgi-bin/luci/admin/services/pansong"
echo "    - 盘松独立海报墙页面: http://${ROUTER_IP}:3200"
