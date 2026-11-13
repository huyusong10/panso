#!/usr/bin/env bash
# ==============================================================================
# 盘松 (PANSONG) Docker 一键打包部署脚本（原生兼容 Unraid / 群晖 / 飞牛 fnOS / Linux）
# 用法: ./deploy-docker.sh [NAS_IP] [NAS_USER] [NAS_PASS] [HOST_PORT]
# ==============================================================================
set -euo pipefail

NAS_IP="${1:-192.168.31.141}"
NAS_USER="${2:-root}"
NAS_PASS="${3:-}"
HOST_PORT="${4:-3200}"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> [1/4] 打包盘松 Docker 构建上下文..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TMP_DIR/pansong-docker-ctx.tar.gz" \
  -C "$ROOT_DIR" \
  Dockerfile .dockerignore docker-compose.yml package.json package-lock.json src public

cat > "$TMP_DIR/deploy-remote-docker.sh" << EOF
#!/bin/sh
set -e

NAS_IP="${NAS_IP}"
HOST_PORT="${HOST_PORT}"
BUILD_DIR="/tmp/pansong-docker-build"
CONTAINER_NAME="PanSong"
IMAGE_NAME="pansong:latest"

rm -rf "\$BUILD_DIR"
mkdir -p "\$BUILD_DIR"
tar -xzf /tmp/pansong-docker-ctx.tar.gz -C "\$BUILD_DIR"
rm -f /tmp/pansong-docker-ctx.tar.gz

# 1. 自动准备基础镜像（若本地已缓存则直接复用；若国内家庭宽带直连 Docker Hub 受限，则通过阿里云官方 Alpine 源秒级构建本地 Node 运行底座）
BASE_IMAGE="node:20-alpine"
if docker image inspect node:20-alpine >/dev/null 2>&1; then
  echo "检测到本地已缓存 node:20-alpine 基础镜像，直接复用..."
else
  HUB_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 https://registry-1.docker.io/v2/ || echo "000")
  if [ "\$HUB_CODE" = "200" ] || [ "\$HUB_CODE" = "401" ]; then
    echo "Docker Hub 连通正常，使用官方 node:20-alpine..."
  else
    echo "检测到当前网络无法直连 Docker Hub，正在通过阿里云官方 Alpine 镜像源秒级合成 Node 运行环境..."
    ARCH="\$(uname -m)"
    case "\$ARCH" in
      x86_64|amd64) ALPINE_ARCH="x86_64" ;;
      aarch64|arm64) ALPINE_ARCH="aarch64" ;;
      *) ALPINE_ARCH="\$ARCH" ;;
    esac
    BOOTSTRAP_DIR="/tmp/pansong-alpine-bootstrap"
    rm -rf "\$BOOTSTRAP_DIR"
    mkdir -p "\$BOOTSTRAP_DIR"
    ALPINE_BASE_URL="https://mirrors.aliyun.com/alpine/latest-stable/releases/\${ALPINE_ARCH}"
    TAR_NAME=\$(curl -fsSL --max-time 10 "\${ALPINE_BASE_URL}/latest-releases.yaml" | awk '/file: alpine-minirootfs-.*\.tar\.gz/ {print \$2; exit}')
    if [ -z "\$TAR_NAME" ]; then
      echo "获取 Alpine minirootfs 版本信息失败" >&2
      exit 1
    fi
    curl -fsSL --max-time 60 -o "\$BOOTSTRAP_DIR/rootfs.tar.gz" "\${ALPINE_BASE_URL}/\${TAR_NAME}"
    curl -fsSL --max-time 15 -o "\$BOOTSTRAP_DIR/rootfs.tar.gz.sha256" "\${ALPINE_BASE_URL}/\${TAR_NAME}.sha256"
    (cd "\$BOOTSTRAP_DIR" && awk '{print \$1, "rootfs.tar.gz"}' rootfs.tar.gz.sha256 | sha256sum -c -)
    docker import "\$BOOTSTRAP_DIR/rootfs.tar.gz" pansong-alpine-rootfs:local >/dev/null
    cat > "\$BOOTSTRAP_DIR/Dockerfile.base" << 'BASEEOF'
FROM pansong-alpine-rootfs:local
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories && apk add --no-cache nodejs npm ca-certificates tzdata
CMD ["node"]
BASEEOF
    docker build -t node:20-alpine -f "\$BOOTSTRAP_DIR/Dockerfile.base" "\$BOOTSTRAP_DIR"
    rm -rf "\$BOOTSTRAP_DIR"
  fi
fi

echo "正在构建 Docker 镜像 \$IMAGE_NAME ..."
docker build --build-arg BASE_IMAGE="\$BASE_IMAGE" -t "\$IMAGE_NAME" "\$BUILD_DIR"

# 2. 识别 Unraid OS 或常规 Linux NAS 数据持久化目录
IS_UNRAID=0
if [ -d "/mnt/user/appdata" ] && [ -d "/boot/config/plugins/dockerMan" ]; then
  IS_UNRAID=1
  DATA_PATH="/mnt/user/appdata/pansong"
else
  DATA_PATH="/opt/pansong/data"
fi
mkdir -p "\$DATA_PATH"

# 首次初始化时自动探测 Telegram 连通性，若当前家庭网络无科学环境则默认关闭 TG 抓取以保证秒级响应
if [ ! -f "\$DATA_PATH/config.json" ]; then
  if curl -I -s --max-time 3 https://t.me/s/dedao2019 >/dev/null 2>&1; then
    ENABLE_TG="true"
  else
    ENABLE_TG="false"
    echo "当前网络无法直连 t.me，已初始默认关闭 Telegram 频道抓取（可在网页右上角设置中配置代理后开启）"
  fi
else
  ENABLE_TG=""
fi

# 3. 停止并移除旧容器
docker rm -f "\$CONTAINER_NAME" >/dev/null 2>&1 || true

ICON_URL="http://\${NAS_IP}:\${HOST_PORT}/icon.png"

if [ "\$IS_UNRAID" = "1" ]; then
  echo "检测到 Unraid OS，正在注册 Unraid Dockerman 模板、图标与开机自启..."
  mkdir -p /var/lib/docker/unraid/images
  cp -f "\$BUILD_DIR/public/icon.png" "/var/lib/docker/unraid/images/\${CONTAINER_NAME}-icon.png"
  chmod 644 "/var/lib/docker/unraid/images/\${CONTAINER_NAME}-icon.png"
  if [ -d "/usr/local/emhttp/state/plugins/dynamix.docker.manager/images" ]; then
    cp -f "\$BUILD_DIR/public/icon.png" "/usr/local/emhttp/state/plugins/dynamix.docker.manager/images/\${CONTAINER_NAME}-icon.png"
    chmod 644 "/usr/local/emhttp/state/plugins/dynamix.docker.manager/images/\${CONTAINER_NAME}-icon.png"
  fi

  cat > "/boot/config/plugins/dockerMan/templates-user/my-\${CONTAINER_NAME}.xml" << XML
<?xml version="1.0"?>
<Container version="2">
  <Name>\${CONTAINER_NAME}</Name>
  <Repository>\${IMAGE_NAME}</Repository>
  <Registry>https://github.com/huyusong10/panso</Registry>
  <Network>bridge</Network>
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support>https://github.com/huyusong10/panso</Support>
  <Project>https://github.com/huyusong10/panso</Project>
  <Overview>盘松 PANSONG · 东方极简私人影视海报墙与 7x24 多网盘资源聚合检索引擎（内置 10 大国内直连插件源 + 豆瓣热映海报墙 + 链接存活核验）。</Overview>
  <Category>MediaApp:Video Tools:</Category>
  <WebUI>http://[IP]:[PORT:3200]/</WebUI>
  <Icon>\${ICON_URL}</Icon>
  <ExtraParams>--restart=unless-stopped --init</ExtraParams>
  <PostArgs/>
  <CPUset/>
  <Config Name="WebUI 端口" Target="3200" Default="3200" Mode="tcp" Type="Port" Display="always" Required="true" Mask="false">\${HOST_PORT}</Config>
  <Config Name="持久化配置目录" Target="/app/data" Default="/mnt/user/appdata/pansong" Mode="rw" Type="Path" Display="always" Required="true" Mask="false">\${DATA_PATH}</Config>
  <Config Name="HTTP 代理 (可选)" Target="PROXY" Default="" Mode="" Type="Variable" Display="always" Required="false" Mask="false"></Config>
</Container>
XML
  chmod 600 "/boot/config/plugins/dockerMan/templates-user/my-\${CONTAINER_NAME}.xml"

  # 写入 Unraid 自启动列表
  touch /var/lib/docker/unraid-autostart
  if ! grep -qx "\${CONTAINER_NAME}" /var/lib/docker/unraid-autostart 2>/dev/null; then
    echo "\${CONTAINER_NAME}" >> /var/lib/docker/unraid-autostart
  fi

  docker run -d \
    --name "\$CONTAINER_NAME" \
    --restart=unless-stopped \
    --init \
    -p "\${HOST_PORT}:3200" \
    -v "\${DATA_PATH}:/app/data:rw" \
    -e TZ="Asia/Shanghai" \
    -e PORT="3200" \
    -e HOST="0.0.0.0" \
    \${ENABLE_TG:+-e ENABLE_TELEGRAM="\$ENABLE_TG"} \
    -l net.unraid.docker.managed="dockerman" \
    -l net.unraid.docker.webui="http://[IP]:[PORT:3200]/" \
    -l net.unraid.docker.icon="\$ICON_URL" \
    "\$IMAGE_NAME"
else
  docker run -d \
    --name "\$CONTAINER_NAME" \
    --restart=unless-stopped \
    --init \
    -p "\${HOST_PORT}:3200" \
    -v "\${DATA_PATH}:/app/data:rw" \
    -e TZ="Asia/Shanghai" \
    -e PORT="3200" \
    -e HOST="0.0.0.0" \
    \${ENABLE_TG:+-e ENABLE_TELEGRAM="\$ENABLE_TG"} \
    "\$IMAGE_NAME"
fi

rm -rf "\$BUILD_DIR" /tmp/deploy-remote-docker.sh
sleep 2
docker ps --filter "name=\$CONTAINER_NAME" --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
EOF

echo "==> [2/4] 上传 Docker 构建包至 NAS (${NAS_USER}@${NAS_IP})..."
run_scp() {
  if [ -n "$NAS_PASS" ]; then
    expect -c "
      set timeout 180
      spawn scp -O -o StrictHostKeyChecking=no \"$1\" \"${NAS_USER}@${NAS_IP}:$2\"
      expect {
        \"*password:*\" { send \"${NAS_PASS}\r\"; exp_continue }
        eof
      }
    "
  else
    scp -O -o StrictHostKeyChecking=no "$1" "${NAS_USER}@${NAS_IP}:$2"
  fi
}

run_ssh() {
  if [ -n "$NAS_PASS" ]; then
    expect -c "
      set timeout 300
      spawn ssh -o StrictHostKeyChecking=no ${NAS_USER}@${NAS_IP} \"$1\"
      expect {
        \"*password:*\" { send \"${NAS_PASS}\r\"; exp_continue }
        eof
      }
    "
  else
    ssh -o StrictHostKeyChecking=no "${NAS_USER}@${NAS_IP}" "$1"
  fi
}

run_scp "$TMP_DIR/pansong-docker-ctx.tar.gz" "/tmp/pansong-docker-ctx.tar.gz"
run_scp "$TMP_DIR/deploy-remote-docker.sh" "/tmp/deploy-remote-docker.sh"

echo "==> [3/4] 在 NAS 上构建镜像并启动容器..."
run_ssh "sh /tmp/deploy-remote-docker.sh"

echo "==> [4/4] 部署完成！"
echo "    - 盘松访问地址: http://${NAS_IP}:${HOST_PORT}"
