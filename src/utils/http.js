import net from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { getConfig } from '../config.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

let cachedProxyUrl = '';
let cachedAgent = null;

function getDispatcher(useProxy = false) {
  if (!useProxy) return undefined;
  const proxyUrl = (getConfig().proxy || '').trim();
  if (!proxyUrl) return undefined;

  if (proxyUrl !== cachedProxyUrl || !cachedAgent) {
    try {
      cachedAgent = new ProxyAgent(proxyUrl);
      cachedProxyUrl = proxyUrl;
    } catch (err) {
      console.warn('[HTTP] 代理地址格式无效:', proxyUrl, err.message);
      cachedAgent = null;
      cachedProxyUrl = '';
      return undefined;
    }
  }
  return cachedAgent;
}

/**
 * 通用 HTTP 请求封装（支持超时控制与可选代理）
 */
export async function httpFetch(url, options = {}) {
  const {
    timeoutMs = 6000,
    useProxy = false,
    headers = {},
    ...rest
  } = options;

  const dispatcher = getDispatcher(useProxy);
  const mergedHeaders = {
    'user-agent': DEFAULT_UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

  try {
    const fetchOpts = {
      ...rest,
      headers: mergedHeaders,
      signal: controller.signal
    };
    if (dispatcher) {
      fetchOpts.dispatcher = dispatcher;
    }
    return await undiciFetch(url, fetchOpts);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, options = {}) {
  const res = await httpFetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
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
      useProxy: Boolean(proxyUrl)
    });
    const ok = res.status === 200;
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
