ARG BASE_IMAGE=node:20-alpine
FROM ${BASE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmmirror.com

LABEL org.opencontainers.image.title="PanSong (盘松)" \
      org.opencontainers.image.description="盘松 PANSONG · 东方极简私人影视海报墙与 7x24 多网盘资源聚合检索引擎" \
      org.opencontainers.image.source="https://github.com/huyusong10/panso"

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    HOST=0.0.0.0 \
    PORT=3200 \
    DATA_DIR=/app/data

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY} && \
    npm cache clean --force && \
    mkdir -p /app/data

COPY src ./src
COPY public ./public

VOLUME ["/app/data"]
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3200/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "--max-old-space-size=384", "src/server.js"]
