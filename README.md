# 盘松 · PANSONG

一个**零 Docker、零数据库依赖、纯 Node.js 跨平台（macOS / Windows / Linux）**的私人影视海报墙与多网盘资源聚合检索引擎，采用**「东方极简 · 松烟墨与宣纸风 (Neo-Oriental Pine & Ink)」**设计语言，内置 **7×24 小时防封护盾与自愈守护进程**。

## ✨ 核心特性

- **开箱即用，全平台通用**：无任何二进制或 Docker 依赖，仅需 Node.js (`>= 18`)，在 macOS、Windows、Linux 上一键 `npm start` 或 `npm run daemon` 运行。
- **无限流影视海报墙主视图**：
  - 内置 **10 大豆瓣影视分类**（`热播剧集`、`热门电影`、`豆瓣高分`、`国产剧`、`动漫番剧`、`美剧`、`日韩剧`、`热门综艺`、`纪录片`、`冷门佳片`）、**3 种排序**（`按热度` / `按最新` / `按高分`）与墙内实时速筛；
  - 后端内置豆瓣封面防盗链代理与双限额 LRU 内存缓存（`GET /api/poster`），支持 `IntersectionObserver` 无限滚动翻页与本地磁盘快照容灾（`data/explore_snapshot.json`）；
  - 点击任意海报即刻切入多网盘流式检索，支持一键返回海报墙并**精准恢复原先的浏览滚动位置**。
- **双引擎并发 + SSE 流式渐进聚合 (`GET /api/search/stream`)**：
  1. **41 个 Telegram 公开资源频道智能排优并发直采**（免 TG 账号、免 API Key，自动按历史命中率优先抓取高产频道，支持频道健康度监控与一键剔除失效频道）。
  2. **10 路主流网盘资源站直连插件 + 自适应指数退避熔断器 (Adaptive Circuit Breaker)**：内置小酷盘 `xiaokupan`、影盘社 `melost`、爱看资源 `ikantv`、小云搜索 `yunso`、影搜 `yingso`、爱盼影视 `aipan`、488影视 `488run`、夸克搜 `quarksoo`、二小盘 `erxiaopan`、聚合加速源 `mipan_relay`。
- **7×24 防封护盾与并发安全工程化设计**：
  - **浏览器指纹粘性轮换池**：按域名与 10 分钟时间窗粘性轮换真实桌面浏览器 `User-Agent` 与 `Sec-CH-UA` 指纹，兼顾防封禁与会话一致性；
  - **分域并发闸门与微抖动节流 (`withHostGate`)**：针对豆瓣、Telegram 与各大网盘官方验活接口独立限制最大并发数并注入随机微抖动间隔，杜绝短时高频突发请求触发 `429 / 403` 封禁；
  - **全链路 Singleflight 并发合并防击穿**：并发搜索同一关键词、并发检测同一网盘链接、并发拉取同一海报或插件握手凭证时，自动合并为单次上游请求并共享广播结果；
  - **严格内存水位控制与定时巡检 GC**：所有缓存（搜索、验活、海报字节池）均设上限并每 10 分钟后台自动巡检清理过期项，配合 `src/daemon.js` 健康探针实现 7×24 小时无人值守稳定运行。
- **核心信息突出与高频交互打磨**：
  - 自动提纯 `4K`（朱砂印）、`杜比/HDR`、`原盘`、`60帧`、`全集`、`更至XX集` 规格墨印；
  - **官方接口实测验货横幅**：在检测夸克、百度、阿里、天翼、115 存活状态的同时，高亮展示网盘内真实分享目录名/文件名与文件大小（`✓ 实测内含：xxx · 52.4GB`）；
  - 支持同源多盘自动折叠、单源点击速筛、一键批量复制本页有效链接、纯前端零依赖手机扫码直达（`public/qrcode.js`）及宣纸/松烟双主题。

## 🚀 快速启动

### macOS / Linux
```bash
git clone https://github.com/huyusong10/panso.git
cd panso
npm install

# 标准启动
npm start

# 或以 7x24 自愈守护模式启动（内置进程监控与 /api/health 自动探活重启）
npm run daemon
# 也可直接执行 ./start.sh --daemon
```

### Windows
双击运行 `start.bat`，或在终端执行：
```powershell
npm install
npm run daemon
```

启动后浏览器访问：**`http://localhost:3200`**（局域网内其他设备可直接访问终端输出的 `Network` IP 地址）。

### Docker / NAS 部署（原生适配 Unraid / 群晖 / 飞牛 fnOS）
```bash
# 方式一：本地 Docker Compose 一键启动
docker compose up -d --build

# 方式二：远程一键打包部署至局域网 NAS（自动适配国内网络，若为 Unraid 自动注册 Dockerman 模板、图标与自启）
./deploy-docker.sh <NAS_IP> root '<SSH_PASSWORD>' 3200
```

### OpenWrt 软路由部署 (`luci-app-pansong`)
```bash
./openwrt/deploy-openwrt.sh <ROUTER_IP> root '<SSH_PASSWORD>'
```

## ⚙️ 配置文件与运行监控

- 所有配置首次启动时自动通过原子写入（Write-Ahead Rename）持久化在 `data/config.json`。
- 点击网页右上角 **「引擎」** 按钮，即可查看 **7×24 守护与防封护盾实时看板**（连续运行时间、内存水位、Singleflight 防击穿命中数、分域节流次数、各插件熔断状态）并在线调整配置。
