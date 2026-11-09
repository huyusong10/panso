import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AVAILABLE_PLUGINS, getConfig, loadConfig, ROOT_DIR, saveConfig } from './config.js';
import { getHealthMatrix, resetAllBreakers } from './services/breaker.js';
import { checkBatchLinks, getCheckerStats, sweepCheckerCache } from './services/checker.js';
import {
  clearSearchCache,
  getSearchCacheStats,
  performAggregatedSearch,
  streamAggregatedSearch,
  sweepSearchCache
} from './services/search.js';
import { fetchExploreWall, getExploreStats, getTrendingRecommendations } from './services/trending.js';
import { getTgChannelHealth } from './sources/telegram.js';
import {
  checkTelegramReachability,
  getHttpRuntimeStats,
  httpFetch,
  probeLocalProxies
} from './utils/http.js';

// 7x24 全局异常护盾：防止任何第三方源畸形响应或底层 Socket 异常导致进程退出
process.on('uncaughtException', (err) => {
  console.error('[Process Guard] UncaughtException:', err?.stack || err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process Guard] UnhandledRejection:', reason);
});

const SERVER_STARTED_AT = Date.now();
let activeSseStreams = 0;

// 豆瓣海报内存 LRU 缓存（双限额：最大条目数 + 最大内存字节数）+ Singleflight 防并发重复拉取
const posterMemCache = new Map();
const inFlightPosters = new Map();
const MAX_POSTER_CACHE = 240;
const MAX_POSTER_BYTES = 28 * 1024 * 1024; // 严格限制在 28MB 以内
let currentPosterBytes = 0;
let posterCacheHits = 0;

function getPosterFromCache(url) {
  const entry = posterMemCache.get(url);
  if (!entry) return null;
  // LRU 晋升
  posterMemCache.delete(url);
  posterMemCache.set(url, entry);
  posterCacheHits++;
  return entry;
}

function setPosterToCache(url, contentType, buf) {
  if (!buf || buf.length === 0 || buf.length > 550 * 1024) return;
  if (posterMemCache.has(url)) {
    const prev = posterMemCache.get(url);
    currentPosterBytes -= prev.buf.length;
    posterMemCache.delete(url);
  }
  while (
    posterMemCache.size >= MAX_POSTER_CACHE ||
    (currentPosterBytes + buf.length > MAX_POSTER_BYTES && posterMemCache.size > 0)
  ) {
    const oldestKey = posterMemCache.keys().next().value;
    const oldestVal = posterMemCache.get(oldestKey);
    if (oldestVal) currentPosterBytes -= oldestVal.buf.length;
    posterMemCache.delete(oldestKey);
  }
  posterMemCache.set(url, { contentType, buf, ts: Date.now() });
  currentPosterBytes += buf.length;
}

// 轻量级客户端 IP 令牌桶限流器（防止前端异常死循环或局域网扫描器打爆上游导致 IP 被封）
const clientBuckets = new Map();
function checkClientRateLimit(req, capacity = 40, refillPerSec = 1.2) {
  const ip =
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'local';
  const now = Date.now();
  let bucket = clientBuckets.get(ip);
  if (!bucket) {
    if (clientBuckets.size > 500) {
      const oldest = clientBuckets.keys().next().value;
      clientBuckets.delete(oldest);
    }
    bucket = { tokens: capacity, lastRefill: now };
    clientBuckets.set(ip, bucket);
  } else {
    const elapsedSec = Math.max(0, (now - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

// 7x24 定时后台巡检清理器（每 10 分钟清理过期缓存与闲置桶，释放 V8 堆内存）
const maintenanceTimer = setInterval(() => {
  try {
    sweepSearchCache();
    sweepCheckerCache();
    const now = Date.now();
    for (const [ip, b] of clientBuckets.entries()) {
      if (now - b.lastRefill > 30 * 60 * 1000) {
        clientBuckets.delete(ip);
      }
    }
  } catch (err) {
    console.warn('[Maintenance] 巡检异常:', err.message);
  }
}, 10 * 60 * 1000);
if (maintenanceTimer.unref) maintenanceTimer.unref();

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const netInfo of list) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) {
        return netInfo.address;
      }
    }
  }
  return '127.0.0.1';
}

function buildRuntimeOverview() {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    startedAt: new Date(SERVER_STARTED_AT).toISOString(),
    memory: {
      rssMB: Number((mem.rss / (1024 * 1024)).toFixed(1)),
      heapUsedMB: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
      posterCacheMB: Number((currentPosterBytes / (1024 * 1024)).toFixed(2))
    },
    activeSseStreams,
    searchCache: getSearchCacheStats(),
    checker: getCheckerStats(),
    explore: getExploreStats(),
    posterCache: {
      entries: posterMemCache.size,
      maxEntries: MAX_POSTER_CACHE,
      hits: posterCacheHits
    },
    http: getHttpRuntimeStats(),
    platform: `${process.platform} (${process.arch}) · Node ${process.version}`
  };
}

loadConfig();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type'
      });
      return res.end();
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 0. 7x24 健康检查与运行遥测接口 (GET /api/health)
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        code: 0,
        status: 'ok',
        data: buildRuntimeOverview()
      });
    }

    // 1. 搜索接口 (支持 GET /api/search?kw=xxx 与 POST /api/search)
    if (pathname === '/api/search') {
      if (!checkClientRateLimit(req, 30, 0.8)) {
        return sendJson(res, 429, { code: 429, message: '请求过于频繁，防封护盾已触发，请稍候再试' });
      }

      let kw = parsedUrl.searchParams.get('kw') || parsedUrl.searchParams.get('q') || '';
      let forceRefresh = parsedUrl.searchParams.get('refresh') === '1';

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        kw = body.kw || body.q || kw;
        forceRefresh = Boolean(body.forceRefresh || forceRefresh);
      }

      if (!String(kw).trim()) {
        return sendJson(res, 400, { code: 400, message: '请输入搜索关键词' });
      }

      const result = await performAggregatedSearch(kw, { forceRefresh });
      return sendJson(res, 200, result);
    }

    // 1.5. SSE 渐进流式搜索接口 (GET /api/search/stream?kw=xxx&refresh=1)
    if (pathname === '/api/search/stream' && req.method === 'GET') {
      if (!checkClientRateLimit(req, 30, 0.8)) {
        return sendJson(res, 429, { code: 429, message: '请求过于频繁，请稍候再试' });
      }

      const kw = (parsedUrl.searchParams.get('kw') || parsedUrl.searchParams.get('q') || '').trim();
      const forceRefresh = parsedUrl.searchParams.get('refresh') === '1';

      if (!kw) {
        return sendJson(res, 400, { code: 400, message: '请输入搜索关键词' });
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*'
      });

      activeSseStreams++;
      let closed = false;

      const heartbeatTimer = setInterval(() => {
        if (!closed && !res.writableEnded) {
          try { res.write(': keep-alive\n\n'); } catch {}
        }
      }, 10000);

      // 硬超时兜底保护，防止异常半开连接永久挂起
      const maxStreamTimer = setTimeout(() => {
        if (!closed && !res.writableEnded) {
          closed = true;
          try { res.end(); } catch {}
        }
      }, 24000);

      const cleanupStream = () => {
        if (closed) return;
        closed = true;
        activeSseStreams = Math.max(0, activeSseStreams - 1);
        clearInterval(heartbeatTimer);
        clearTimeout(maxStreamTimer);
      };

      req.on('close', cleanupStream);
      res.on('close', cleanupStream);
      res.on('error', cleanupStream);

      const sendEvent = (event, data) => {
        if (closed || res.writableEnded) return;
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          cleanupStream();
        }
      };

      await streamAggregatedSearch(kw, {
        forceRefresh,
        onBatch: (batchData) => {
          sendEvent('batch', batchData);
        },
        onDone: (finalPayload) => {
          sendEvent('done', {
            total: finalPayload.total,
            results: finalPayload.results,
            meta: finalPayload.meta
          });
          if (!closed && !res.writableEnded) {
            try { res.end(); } catch {}
          }
          cleanupStream();
        }
      });
      return;
    }

    // 2. 批量死链存活检测接口
    if (pathname === '/api/check/links' && req.method === 'POST') {
      if (!checkClientRateLimit(req, 45, 1.5)) {
        return sendJson(res, 429, { code: 429, message: '检测请求过快，请稍候' });
      }
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const data = await checkBatchLinks(items);
      return sendJson(res, 200, data);
    }

    // 2.5. 首页无限流海报墙接口 (GET /api/explore?channel=hot_tv&sort=recommend&start=0&limit=24)
    if (pathname === '/api/explore' && req.method === 'GET') {
      const channel = parsedUrl.searchParams.get('channel') || 'hot_tv';
      const sort = parsedUrl.searchParams.get('sort') || 'recommend';
      const start = Number(parsedUrl.searchParams.get('start')) || 0;
      const limit = Number(parsedUrl.searchParams.get('limit')) || 24;
      const data = await fetchExploreWall({ channel, sort, start, limit });
      return sendJson(res, 200, { code: 0, data });
    }

    // 2.6. 豆瓣海报反防盗链极速代理 (GET /api/poster?url=...)
    if (pathname === '/api/poster' && req.method === 'GET') {
      const rawUrl = (parsedUrl.searchParams.get('url') || '').trim();
      let targetUrl;
      try {
        targetUrl = new URL(rawUrl);
      } catch {
        res.writeHead(400);
        return res.end('Bad URL');
      }
      if (!/^img\d*\.doubanio\.com$/i.test(targetUrl.hostname)) {
        res.writeHead(403);
        return res.end('Forbidden host');
      }

      const cached = getPosterFromCache(rawUrl);
      if (cached) {
        res.writeHead(200, {
          'content-type': cached.contentType,
          'cache-control': 'public, max-age=604800, immutable'
        });
        return res.end(cached.buf);
      }

      try {
        let fetchTask = inFlightPosters.get(rawUrl);
        if (!fetchTask) {
          fetchTask = (async () => {
            const imgRes = await httpFetch(rawUrl, {
              timeoutMs: 6000,
              retries: 1,
              useProxy: false,
              headers: {
                referer: 'https://movie.douban.com/',
                accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
              }
            });
            if (!imgRes.ok) {
              try { await imgRes.body?.cancel(); } catch {}
              throw new Error(`HTTP ${imgRes.status}`);
            }
            const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
            const arrayBuf = await imgRes.arrayBuffer();
            const buf = Buffer.from(arrayBuf);
            setPosterToCache(rawUrl, contentType, buf);
            return { contentType, buf };
          })().finally(() => {
            inFlightPosters.delete(rawUrl);
          });
          inFlightPosters.set(rawUrl, fetchTask);
        }

        const { contentType, buf } = await fetchTask;
        res.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'public, max-age=604800, immutable'
        });
        return res.end(buf);
      } catch {
        res.writeHead(502);
        return res.end();
      }
    }

    // 2.7. 兼容旧风向接口
    if (pathname === '/api/trending' && req.method === 'GET') {
      const data = await getTrendingRecommendations();
      return sendJson(res, 200, { code: 0, data });
    }

    // 3. 获取配置与数据源状态（附带 7x24 运行遥测数据）
    if (pathname === '/api/config' && req.method === 'GET') {
      const cfg = getConfig();
      const runtime = buildRuntimeOverview();
      return sendJson(res, 200, {
        code: 0,
        data: {
          config: cfg,
          availablePlugins: AVAILABLE_PLUGINS,
          health: getHealthMatrix(),
          tgHealth: getTgChannelHealth(cfg.channels || []),
          cache: runtime.searchCache,
          runtime,
          platform: runtime.platform
        }
      });
    }

    // 3.5. 重置插件熔断器
    if (pathname === '/api/breaker/reset' && req.method === 'POST') {
      resetAllBreakers();
      return sendJson(res, 200, {
        code: 0,
        message: 'BREAKER STATES RESET',
        data: getHealthMatrix()
      });
    }

    // 4. 保存配置
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const updated = saveConfig(body);
      clearSearchCache();
      return sendJson(res, 200, {
        code: 0,
        message: '配置已保存并生效',
        data: updated
      });
    }

    // 5. 自动探测本地代理与 Telegram 连通性测试
    if (pathname === '/api/proxy/probe' && req.method === 'POST') {
      const [localProxies, tgStatus] = await Promise.all([
        probeLocalProxies(),
        checkTelegramReachability()
      ]);
      return sendJson(res, 200, {
        code: 0,
        data: {
          localProxies,
          tgStatus
        }
      });
    }

    // 6. 清空搜索缓存
    if (pathname === '/api/cache/clear' && req.method === 'POST') {
      clearSearchCache();
      return sendJson(res, 200, { code: 0, message: '缓存已清空' });
    }

    // 7. 静态资源托管（带流错误保护，防止文件句柄泄漏）
    let safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    if (safePath === '/' || safePath === '\\') {
      safePath = '/index.html';
    }
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-cache'
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      stream.pipe(res);
      return;
    }

    // SPA 回退到 index.html
    const indexHtml = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const stream = fs.createReadStream(indexHtml);
      stream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      stream.pipe(res);
      return;
    }

    sendJson(res, 404, { code: 404, message: 'Not Found' });
  } catch (err) {
    console.error('[Server Error]', err);
    sendJson(res, 500, { code: 500, message: err.message || 'Internal Server Error' });
  }
});

// 配置 HTTP Server 超时参数，防止慢连接耗尽连接池
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;

const cfg = getConfig();
server.listen(cfg.port, cfg.host, () => {
  const lanIp = getLanAddress();
  console.log('\n============================================================');
  console.log('  盘松 PANSONG // 7x24 Multi-Drive Aggregator');
  console.log(`  Local:    http://localhost:${cfg.port}`);
  console.log(`  Network:  http://${lanIp}:${cfg.port}`);
  console.log(`  Channels: ${cfg.channels.length} Telegram channels`);
  console.log(`  Plugins:  ${cfg.enabledPlugins.join(', ')}`);
  console.log('============================================================\n');
});

function gracefulShutdown(signal) {
  console.log(`\n[Server] 收到 ${signal} 信号，正在平滑关闭盘松服务...`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
