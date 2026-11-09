import { getConfig } from '../config.js';
import { PLUGIN_HANDLERS, runEnabledPlugins, runSinglePlugin } from '../sources/plugins.js';
import { searchAllTgChannels } from '../sources/telegram.js';
import {
  cleanShareUrl,
  detectDriveType,
  extractPasswordFromUrl,
  extractResourceSpecs,
  normalizeLinkKey,
  scoreResultItem
} from '../utils/parser.js';

// 内存搜索缓存 (LRU)
const searchCache = new Map();
const MAX_CACHE_ENTRIES = 120;

// 并发请求合并 (Singleflight / 订阅广播中心) — 防止相同关键词并发搜索重复打击上游
const activeStreamHubs = new Map();
const inFlightPostSearches = new Map();

// 全局上游搜索并发信号量（防止极端并发请求导致本机端口耗尽或上游封禁）
const MAX_CONCURRENT_SEARCH_JOBS = 4;
let runningSearchJobs = 0;
const searchJobQueue = [];

let totalSearchRequests = 0;
let searchCacheHits = 0;
let searchCoalescedHits = 0;

function acquireSearchJobSlot() {
  if (runningSearchJobs < MAX_CONCURRENT_SEARCH_JOBS) {
    runningSearchJobs++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    searchJobQueue.push(resolve);
  });
}

function releaseSearchJobSlot() {
  runningSearchJobs = Math.max(0, runningSearchJobs - 1);
  if (searchJobQueue.length > 0) {
    const next = searchJobQueue.shift();
    runningSearchJobs++;
    next();
  }
}

export function clearSearchCache() {
  searchCache.clear();
}

export function sweepSearchCache() {
  const cfg = getConfig();
  const ttlMs = Math.max(1, Number(cfg.cacheTtlMinutes) || 30) * 60 * 1000;
  const now = Date.now();
  for (const [k, v] of searchCache.entries()) {
    if (now - v.timestamp >= ttlMs) {
      searchCache.delete(k);
    }
  }
}

export function getSearchCacheStats() {
  return {
    entries: searchCache.size,
    maxEntries: MAX_CACHE_ENTRIES,
    totalSearches: totalSearchRequests,
    cacheHits: searchCacheHits,
    coalescedHits: searchCoalescedHits,
    runningJobs: runningSearchJobs,
    queuedJobs: searchJobQueue.length
  };
}

function buildCacheKey(kw, cfg) {
  return `${kw.toLowerCase()}|tg:${cfg.enableTelegram}|p:${(cfg.enabledPlugins || []).join(',')}|pure:${cfg.hideAdsAndOwn}`;
}

function getFromCache(cacheKey, ttlMs) {
  if (!searchCache.has(cacheKey)) return null;
  const cached = searchCache.get(cacheKey);
  if (Date.now() - cached.timestamp < ttlMs) {
    // LRU 晋升
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, cached);
    searchCacheHits++;
    return cached.payload;
  }
  searchCache.delete(cacheKey);
  return null;
}

function saveToCache(cacheKey, payload) {
  if (payload.total > 0) {
    if (searchCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = searchCache.keys().next().value;
      searchCache.delete(oldestKey);
    }
    searchCache.set(cacheKey, {
      timestamp: Date.now(),
      payload
    });
  }
}

function mergeIntoDedupMap(dedupedMap, rawItems, kw) {
  let changed = 0;
  for (const item of rawItems) {
    const url = cleanShareUrl(item.url || '');
    if (!url) continue;
    const key = normalizeLinkKey(url);
    const type = detectDriveType(url, item.type);
    if (type === 'others') continue;

    const password = (item.password || '').trim() || extractPasswordFromUrl(url);
    const normalizedItem = {
      unique_id: item.unique_id || key,
      title: (item.title || kw).trim(),
      content: (item.content || '').trim(),
      url,
      type,
      password,
      datetime: item.datetime || '',
      source: item.source || 'unknown'
    };

    if (!dedupedMap.has(key)) {
      normalizedItem.specs = extractResourceSpecs(normalizedItem.title, normalizedItem.content);
      normalizedItem._score = scoreResultItem(normalizedItem, kw);
      dedupedMap.set(key, normalizedItem);
      changed++;
    } else {
      const prev = dedupedMap.get(key);
      let updated = false;
      if (!prev.password && normalizedItem.password) {
        prev.password = normalizedItem.password;
        prev.url = normalizedItem.url;
        updated = true;
      }
      if ((!prev.content || prev.content.length < normalizedItem.content.length) && normalizedItem.content) {
        prev.content = normalizedItem.content;
        updated = true;
      }
      if (!prev.datetime && normalizedItem.datetime) {
        prev.datetime = normalizedItem.datetime;
        updated = true;
      }
      if (prev.title === kw && normalizedItem.title !== kw) {
        prev.title = normalizedItem.title;
        updated = true;
      }
      if (updated) {
        prev.specs = extractResourceSpecs(prev.title, prev.content);
        prev._score = scoreResultItem(prev, kw);
        changed++;
      }
    }
  }
  return changed;
}

function buildSortedPayload(dedupedMap, kw, meta) {
  const allItems = Array.from(dedupedMap.values());
  allItems.sort((a, b) => b._score - a._score);

  const mergedByType = {};
  for (const item of allItems) {
    if (!mergedByType[item.type]) {
      mergedByType[item.type] = [];
    }
    mergedByType[item.type].push({
      unique_id: item.unique_id,
      url: item.url,
      password: item.password,
      note: item.title,
      title: item.title,
      content: item.content,
      datetime: item.datetime,
      source: item.source,
      type: item.type,
      score: item._score
    });
  }

  return {
    total: allItems.length,
    results: allItems,
    merged_by_type: mergedByType,
    meta: {
      ...meta,
      dedupedCount: allItems.length
    }
  };
}

export async function performAggregatedSearch(keyword, { forceRefresh = false } = {}) {
  const kw = String(keyword || '').trim().slice(0, 80);
  if (!kw) {
    return {
      code: 0,
      message: 'empty keyword',
      data: { total: 0, results: [], merged_by_type: {}, meta: {} }
    };
  }

  totalSearchRequests++;
  const cfg = getConfig();
  const ttlMs = Math.max(1, Number(cfg.cacheTtlMinutes) || 30) * 60 * 1000;
  const cacheKey = buildCacheKey(kw, cfg);

  if (!forceRefresh) {
    const cachedPayload = getFromCache(cacheKey, ttlMs);
    if (cachedPayload) {
      return {
        code: 0,
        message: 'success (cached)',
        data: {
          ...cachedPayload,
          meta: {
            ...cachedPayload.meta,
            cacheHit: true,
            elapsedMs: 1
          }
        }
      };
    }
    if (inFlightPostSearches.has(cacheKey)) {
      searchCoalescedHits++;
      return inFlightPostSearches.get(cacheKey);
    }
  }

  const jobPromise = (async () => {
    await acquireSearchJobSlot();
    const t0 = Date.now();
    try {
      const [tgOut, pluginOut] = await Promise.all([
        cfg.enableTelegram
          ? searchAllTgChannels(kw, cfg.channels || [], cfg.tgConcurrency || 16, cfg.tgTimeoutMs || 4200)
          : Promise.resolve({ items: [], stats: { totalChannels: 0, activeChannels: 0, count: 0 } }),
        runEnabledPlugins(kw, cfg.enabledPlugins || [], cfg.pluginTimeoutMs || 7500)
      ]);

      const rawCombined = [...tgOut.items, ...pluginOut.items];
      const dedupedMap = new Map();
      mergeIntoDedupMap(dedupedMap, rawCombined, kw);

      const elapsedMs = Date.now() - t0;
      const payload = buildSortedPayload(dedupedMap, kw, {
        keyword: kw,
        rawCount: rawCombined.length,
        elapsedMs,
        cacheHit: false,
        tgStats: tgOut.stats,
        pluginStats: pluginOut.pluginStats
      });

      saveToCache(cacheKey, payload);

      return {
        code: 0,
        message: 'success',
        data: payload
      };
    } finally {
      releaseSearchJobSlot();
      inFlightPostSearches.delete(cacheKey);
    }
  })();

  if (!forceRefresh) {
    inFlightPostSearches.set(cacheKey, jobPromise);
  }
  return jobPromise;
}

/**
 * SSE 渐进流式搜索：支持多端并发订阅同一在途搜索 (Singleflight Hub)
 */
export async function streamAggregatedSearch(
  keyword,
  { forceRefresh = false, onBatch = () => {}, onDone = () => {} } = {}
) {
  const kw = String(keyword || '').trim().slice(0, 80);
  if (!kw) {
    onDone({ total: 0, results: [], merged_by_type: {}, meta: {} });
    return;
  }

  totalSearchRequests++;
  const cfg = getConfig();
  const ttlMs = Math.max(1, Number(cfg.cacheTtlMinutes) || 30) * 60 * 1000;
  const cacheKey = buildCacheKey(kw, cfg);

  if (!forceRefresh) {
    const cachedPayload = getFromCache(cacheKey, ttlMs);
    if (cachedPayload) {
      const payload = {
        ...cachedPayload,
        meta: {
          ...cachedPayload.meta,
          cacheHit: true,
          elapsedMs: 1
        }
      };
      onBatch({
        source: 'cache',
        results: payload.results,
        meta: payload.meta
      });
      onDone(payload);
      return;
    }

    // 若已有相同关键词的流式任务在途，直接挂载订阅并立刻发送当前已汇聚的快照
    if (activeStreamHubs.has(cacheKey)) {
      searchCoalescedHits++;
      const hub = activeStreamHubs.get(cacheKey);
      if (hub.latestBatch) {
        try { onBatch(hub.latestBatch); } catch {}
      }
      hub.subscribers.add({ onBatch, onDone });
      return hub.promise;
    }
  }

  const subscribers = new Set([{ onBatch, onDone }]);
  const hub = {
    latestBatch: null,
    subscribers,
    promise: null
  };

  if (!forceRefresh) {
    activeStreamHubs.set(cacheKey, hub);
  }

  hub.promise = (async () => {
    await acquireSearchJobSlot();
    const t0 = Date.now();
    const dedupedMap = new Map();
    const pluginStats = {};
    let rawCount = 0;
    let tgStats = {
      totalChannels: cfg.enableTelegram ? (cfg.channels || []).length : 0,
      activeChannels: 0,
      count: 0
    };

    const activePlugins = (cfg.enabledPlugins || []).filter(id => PLUGIN_HANDLERS[id]);
    const totalTasks = activePlugins.length + (cfg.enableTelegram ? 1 : 0);
    let completedTasks = 0;

    const emitProgress = (sourceLabel) => {
      const allItems = Array.from(dedupedMap.values());
      allItems.sort((a, b) => b._score - a._score);
      const batchPayload = {
        source: sourceLabel,
        results: allItems,
        meta: {
          keyword: kw,
          rawCount,
          dedupedCount: allItems.length,
          elapsedMs: Date.now() - t0,
          cacheHit: false,
          streaming: completedTasks < totalTasks,
          completedTasks,
          totalTasks,
          progress: `${completedTasks}/${totalTasks}`,
          tgStats,
          pluginStats
        }
      };
      hub.latestBatch = batchPayload;
      for (const sub of subscribers) {
        try { sub.onBatch(batchPayload); } catch {}
      }
    };

    try {
      const tasks = [];

      for (const id of activePlugins) {
        tasks.push(
          runSinglePlugin(id, kw, cfg.pluginTimeoutMs || 7500).then(({ items, stat }) => {
            completedTasks++;
            pluginStats[id] = stat;
            rawCount += items.length;
            mergeIntoDedupMap(dedupedMap, items, kw);
            emitProgress(`plugin:${id}`);
          })
        );
      }

      if (cfg.enableTelegram) {
        tasks.push(
          searchAllTgChannels(
            kw,
            cfg.channels || [],
            cfg.tgConcurrency || 16,
            cfg.tgTimeoutMs || 4200,
            (ch, chItems, liveTgStats) => {
              rawCount += chItems.length;
              tgStats = liveTgStats;
              const changed = mergeIntoDedupMap(dedupedMap, chItems, kw);
              if (changed > 0) {
                emitProgress(`tg:${ch}`);
              }
            }
          ).then((tgOut) => {
            completedTasks++;
            tgStats = tgOut.stats;
            emitProgress('tg:done');
          })
        );
      }

      await Promise.allSettled(tasks);

      const payload = buildSortedPayload(dedupedMap, kw, {
        keyword: kw,
        rawCount,
        elapsedMs: Date.now() - t0,
        cacheHit: false,
        streaming: false,
        completedTasks: totalTasks,
        totalTasks,
        progress: `${totalTasks}/${totalTasks}`,
        tgStats,
        pluginStats
      });

      saveToCache(cacheKey, payload);
      for (const sub of subscribers) {
        try { sub.onDone(payload); } catch {}
      }
    } finally {
      releaseSearchJobSlot();
      activeStreamHubs.delete(cacheKey);
    }
  })();

  return hub.promise;
}
