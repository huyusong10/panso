import net from 'node:net';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { getConfig } from '../config.js';

/**
 * 真实桌面浏览器指纹池（按域名 + 时间窗粘性轮换，兼顾防封禁与会话一致性）
 */
const BROWSER_PROFILES = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    platform: '"macOS"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
    secChUa: '"Microsoft Edge";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    platform: '"Windows"'
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    secChUa: '',
    platform: '"macOS"'
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    platform: '"Linux"'
  }
];

function pickBrowserProfile(hostname = '') {
  const timeBucket = Math.floor(Date.now() / (10 * 60 * 1000)); // 10分钟时间窗
  let hash = timeBucket;
  for (let i = 0; i < hostname.length; i++) {
    hash = (hash * 31 + hostname.charCodeAt(i)) >>> 0;
  }
  return BROWSER_PROFILES[hash % BROWSER_PROFILES.length];
}

/**
 * 分域并发闸门与微抖动节流器（防止短时间高频并发触发上游 WAF / 429 封禁）
 */
const HOST_POLICIES = [
  { match: 'movie.douban.com', maxConcurrent: 2, minIntervalMs: 140, jitterMs: 90 },
  { match: '.doubanio.com', maxConcurrent: 6, minIntervalMs: 30, jitterMs: 40 },
  { match: 'drive-pc.quark.cn', maxConcurrent: 3, minIntervalMs: 90, jitterMs: 70 },
  { match: 'pan.baidu.com', maxConcurrent: 3, minIntervalMs: 110, jitterMs: 80 },
  { match: 'api.aliyundrive.com', maxConcurrent: 3, minIntervalMs: 90, jitterMs: 60 },
  { match: 'cloud.189.cn', maxConcurrent: 3, minIntervalMs: 100, jitterMs: 70 },
  { match: 'webapi.115.com', maxConcurrent: 2, minIntervalMs: 130, jitterMs: 90 },
  { match: 't.me', maxConcurrent: 14, minIntervalMs: 20, jitterMs: 30 }
];

const DEFAULT_HOST_POLICY = { maxConcurrent: 6, minIntervalMs: 25, jitterMs: 35 };
const hostQueues = new Map();

let totalOutboundRequests = 0;
let totalRetriedRequests = 0;
let totalThrottledWaits = 0;

function getHostPolicy(hostname) {
  for (const p of HOST_POLICIES) {
    if (hostname === p.match || hostname.endsWith(p.match)) {
      return p;
    }
  }
  return DEFAULT_HOST_POLICY;
}

function getHostState(hostname) {
  if (!hostQueues.has(hostname)) {
    // 定期清理过多闲置 host 状态，避免 7x24 内存增长
    if (hostQueues.size > 300) {
      const now = Date.now();
      for (const [k, v] of hostQueues.entries()) {
        if (v.active === 0 && v.queue.length === 0 && now - v.lastRunAt > 10 * 60 * 1000) {
          hostQueues.delete(k);
        }
      }
    }
    hostQueues.set(hostname, {
      active: 0,
      lastRunAt: 0,
      queue: []
    });
  }
  return hostQueues.get(hostname);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withHostGate(urlStr, fn) {
  let hostname = 'default';
  try {
    hostname = new URL(urlStr).hostname.toLowerCase();
  } catch {
    // ignore
  }

  const policy = getHostPolicy(hostname);
  const state = getHostState(hostname);

  if (state.active >= policy.maxConcurrent) {
    totalThrottledWaits++;
    await new Promise((resolve) => state.queue.push(resolve));
  }

  state.active++;
  try {
    const now = Date.now();
    const elapsed = now - state.lastRunAt;
    const targetGap = policy.minIntervalMs + Math.floor(Math.random() * (policy.jitterMs + 1));
    if (elapsed < targetGap) {
      const waitMs = targetGap - elapsed;
      state.lastRunAt = now + waitMs;
      await sleep(waitMs);
    } else {
      state.lastRunAt = now;
    }
    return await fn(hostname);
  } finally {
    state.active--;
    if (state.queue.length > 0) {
      const next = state.queue.shift();
      next();
    }
  }
}

export function getHttpRuntimeStats() {
  let activeHostTasks = 0;
  let queuedHostTasks = 0;
  for (const st of hostQueues.values()) {
    activeHostTasks += st.active;
    queuedHostTasks += st.queue.length;
  }
  return {
    totalOutboundRequests,
    totalRetriedRequests,
    totalThrottledWaits,
    activeHostTasks,
    queuedHostTasks,
    trackedHosts: hostQueues.size
  };
}

/**
 * 全局连接池复用（避免高并发下频繁握手与端口耗尽）
 */
const directAgent = new Agent({
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 60000,
  connections: 64,
  pipelining: 1
});

let cachedProxyUrl = '';
let cachedProxyAgent = null;

function getDispatcher(useProxy = false) {
  if (!useProxy) return directAgent;
  const proxyUrl = (getConfig().proxy || '').trim();
  if (!proxyUrl) return directAgent;

  if (proxyUrl !== cachedProxyUrl || !cachedProxyAgent) {
    try {
      cachedProxyAgent = new ProxyAgent({
        uri: proxyUrl,
        keepAliveTimeout: 15000,
        connections: 32
      });
      cachedProxyUrl = proxyUrl;
    } catch (err) {
      console.warn('[HTTP] 代理地址格式无效:', proxyUrl, err.message);
      cachedProxyAgent = null;
      cachedProxyUrl = '';
      return directAgent;
    }
  }
  return cachedProxyAgent;
}

/**
 * 通用 HTTP 请求封装（内置分域节流、指纹轮换、超时控制与瞬态错误自动重试）
 */
export async function httpFetch(url, options = {}) {
  const {
    timeoutMs = 6000,
    useProxy = false,
    retries = 1,
    headers = {},
    ...rest
  } = options;

  return withHostGate(url, async (hostname) => {
    const profile = pickBrowserProfile(hostname);
    const dispatcher = getDispatcher(useProxy);

    const mergedHeaders = {
      'user-agent': profile.ua,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(profile.secChUa ? { 'sec-ch-ua': profile.secChUa, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': profile.platform } : {}),
      ...headers
    };

    let lastErr = null;
    const maxAttempts = Math.max(1, retries + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      totalOutboundRequests++;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)),
        timeoutMs
      );

      try {
        const res = await undiciFetch(url, {
          ...rest,
          headers: mergedHeaders,
          dispatcher,
          signal: controller.signal
        });

        // 遇到上游 429 / 502 / 503 且还有重试次数时，退避等待后重试
        if ([429, 502, 503].includes(res.status) && attempt < maxAttempts) {
          totalRetriedRequests++;
          try { await res.body?.cancel(); } catch {}
          await sleep(220 * attempt + Math.floor(Math.random() * 150));
          continue;
        }

        return res;
      } catch (err) {
        lastErr = err;
        const isTransient =
          err.name !== 'AbortError' &&
          /ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|fetch failed/i.test(String(err.message || err.code || ''));
        if (isTransient && attempt < maxAttempts) {
          totalRetriedRequests++;
          await sleep(180 * attempt + Math.floor(Math.random() * 120));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr || new Error('Request failed');
  });
}

export async function fetchText(url, options = {}) {
  const res = await httpFetch(url, options);
  if (!res.ok) {
    try { await res.body?.cancel(); } catch {}
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  // 防止异常超大页面耗尽内存（限制 4MB）
  return text.length > 4 * 1024 * 1024 ? text.slice(0, 4 * 1024 * 1024) : text;
}

export async function fetchJson(url, options = {}) {
  const res = await httpFetch(url, {
    ...options,
    headers: {
      accept: 'application/json, text/plain, */*',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch {}
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * 自动探测本机常见代理软件端口（Clash / Mihomo / v2rayN / Surge）
 */
export async function probeLocalProxies() {
  const candidates = [
    { port: 7890, label: 'Clash / Mihomo 默认混合端口 (7890)' },
    { port: 7897, label: 'Clash Verge Rev 默认端口 (7897)' },
    { port: 10809, label: 'v2rayN HTTP 端口 (10809)' },
    { port: 10808, label: 'v2rayN 端口 (10808)' },
    { port: 6152, label: 'Surge HTTP 端口 (6152)' },
    { port: 20171, label: 'v2rayA 默认 HTTP 端口 (20171)' }
  ];

  const checkPort = (port) =>
    new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(350);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });

  const found = [];
  await Promise.all(
    candidates.map(async (c) => {
      const open = await checkPort(c.port);
      if (open) {
        found.push({
          url: `http://127.0.0.1:${c.port}`,
          port: c.port,
          label: c.label
        });
      }
    })
  );
  return found.sort((a, b) => a.port - b.port);
}

/**
 * 测试 Telegram 连通性（直连 vs 代理）
 */
export async function checkTelegramReachability() {
  const testUrl = 'https://t.me/s/clouddriveresources';
  const proxyUrl = (getConfig().proxy || '').trim();
  const t0 = Date.now();
  try {
    const res = await httpFetch(testUrl, {
      timeoutMs: 4500,
      retries: 0,
      useProxy: Boolean(proxyUrl)
    });
    const ok = res.status === 200;
    try { await res.body?.cancel(); } catch {}
    return {
      reachable: ok,
      status: res.status,
      latencyMs: Date.now() - t0,
      viaProxy: Boolean(proxyUrl),
      proxyUrl
    };
  } catch (err) {
    return {
      reachable: false,
      error: err.message,
      latencyMs: Date.now() - t0,
      viaProxy: Boolean(proxyUrl),
      proxyUrl
    };
  }
}
