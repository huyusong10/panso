import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AVAILABLE_PLUGINS, getConfig, loadConfig, ROOT_DIR, saveConfig } from './config.js';
import { getHealthMatrix, resetAllBreakers } from './services/breaker.js';
import { checkBatchLinks } from './services/checker.js';
import {
  clearSearchCache,
  getSearchCacheStats,
  performAggregatedSearch,
  streamAggregatedSearch
} from './services/search.js';
import { fetchExploreWall, getTrendingRecommendations } from './services/trending.js';
import { getTgChannelHealth } from './sources/telegram.js';
import { checkTelegramReachability, httpFetch, probeLocalProxies } from './utils/http.js';

const posterMemCache = new Map();
const MAX_POSTER_CACHE = 180;

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

function readJsonBody(req, maxBytes = 1024 * 1024) {
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
      } catch (err) {
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

    // 1. 搜索接口 (支持 GET /api/search?kw=xxx 与 POST /api/search)
    if (pathname === '/api/search') {
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
      const kw = (parsedUrl.searchParams.get('kw') || parsedUrl.searchParams.get('q') || '').trim();
      const forceRefresh = parsedUrl.searchParams.get('refresh') === '1';

      if (!kw) {
        return sendJson(res, 400, { code: 400, message: '请输入搜索关键词' });
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*'
      });

      let closed = false;
      req.on('close', () => {
        closed = true;
      });

      const sendEvent = (event, data) => {
        if (closed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
            res.end();
          }
        }
      });
      return;
    }

    // 2. 批量死链存活检测接口
    if (pathname === '/api/check/links' && req.method === 'POST') {
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
      if (!targetUrl.hostname.endsWith('.doubanio.com')) {
        res.writeHead(403);
        return res.end('Forbidden host');
      }

      if (posterMemCache.has(rawUrl)) {
        const cached = posterMemCache.get(rawUrl);
        res.writeHead(200, {
          'content-type': cached.contentType,
          'cache-control': 'public, max-age=604800, immutable'
        });
        return res.end(cached.buf);
      }

      try {
        const imgRes = await httpFetch(rawUrl, {
          timeoutMs: 6000,
          useProxy: false,
          headers: {
            referer: 'https://movie.douban.com/',
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          }
        });
        if (!imgRes.ok) {
          res.writeHead(imgRes.status);
          return res.end();
        }
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const arrayBuf = await imgRes.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        if (buf.length > 0 && buf.length < 600 * 1024) {
          if (posterMemCache.size >= MAX_POSTER_CACHE) {
            const oldestKey = posterMemCache.keys().next().value;
            posterMemCache.delete(oldestKey);
          }
          posterMemCache.set(rawUrl, { contentType, buf });
        }
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

    // 3. 获取配置与数据源状态
    if (pathname === '/api/config' && req.method === 'GET') {
      const cfg = getConfig();
      return sendJson(res, 200, {
        code: 0,
        data: {
          config: cfg,
          availablePlugins: AVAILABLE_PLUGINS,
          health: getHealthMatrix(),
          tgHealth: getTgChannelHealth(cfg.channels || []),
          cache: getSearchCacheStats(),
          platform: `${process.platform} (${process.arch}) · Node ${process.version}`
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

    // 7. 静态资源托管
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
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA 回退到 index.html
    const indexHtml = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexHtml).pipe(res);
      return;
    }

    sendJson(res, 404, { code: 404, message: 'Not Found' });
  } catch (err) {
    console.error('[Server Error]', err);
    sendJson(res, 500, { code: 500, message: err.message || 'Internal Server Error' });
  }
});

const cfg = getConfig();
server.listen(cfg.port, cfg.host, () => {
  const lanIp = getLanAddress();
  console.log('\n============================================================');
  console.log('  盘松 PANSONG // Multi-Drive Aggregator');
  console.log(`  Local:    http://localhost:${cfg.port}`);
  console.log(`  Network:  http://${lanIp}:${cfg.port}`);
  console.log(`  Channels: ${cfg.channels.length} Telegram channels`);
  console.log(`  Plugins:  ${cfg.enabledPlugins.join(', ')}`);
  console.log('============================================================\n');
});
