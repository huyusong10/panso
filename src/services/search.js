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

export function clearSearchCache() {
  searchCache.clear();
}

export function getSearchCacheStats() {
  return {
    entries: searchCache.size
  };
}

function buildCacheKey(kw, cfg) {
  return `${kw.toLowerCase()}|tg:${cfg.enableTelegram}|p:${(cfg.enabledPlugins || []).join(',')}|pure:${cfg.hideAdsAndOwn}`;
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

export async function performAggregatedSearch(keyword, { forceRefresh = false } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) {
    return {
      code: 0,
      message: 'empty keyword',
      data: { total: 0, results: [], merged_by_type: {}, meta: {} }
    };
  }

  const cfg = getConfig();
  const ttlMs = Math.max(1, Number(cfg.cacheTtlMinutes) || 30) * 60 * 1000;
  const cacheKey = buildCacheKey(kw, cfg);

  if (!forceRefresh && searchCache.has(cacheKey)) {
    const cached = searchCache.get(cacheKey);
    if (Date.now() - cached.timestamp < ttlMs) {
      return {
        code: 0,
        message: 'success (cached)',
        data: {
          ...cached.payload,
          meta: {
            ...cached.payload.meta,
            cacheHit: true,
            elapsedMs: 1
          }
        }
      };
    }
    searchCache.delete(cacheKey);
  }

  const t0 = Date.now();

  const [tgOut, pluginOut] = await Promise.all([
    cfg.enableTelegram
      ? searchAllTgChannels(kw, cfg.channels || [], cfg.tgConcurrency || 12, cfg.tgTimeoutMs || 5500)
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
}

/**
 * SSE 渐进流式搜索：任何单个插件或 TG 频道返回即立刻去重推送给前端
 */
export async function streamAggregatedSearch(
  keyword,
  { forceRefresh = false, onBatch = () => {}, onDone = () => {} } = {}
) {
  const kw = String(keyword || '').trim();
  if (!kw) {
    onDone({ total: 0, results: [], merged_by_type: {}, meta: {} });
    return;
  }

  const cfg = getConfig();
  const ttlMs = Math.max(1, Number(cfg.cacheTtlMinutes) || 30) * 60 * 1000;
  const cacheKey = buildCacheKey(kw, cfg);

  if (!forceRefresh && searchCache.has(cacheKey)) {
    const cached = searchCache.get(cacheKey);
    if (Date.now() - cached.timestamp < ttlMs) {
      const payload = {
        ...cached.payload,
        meta: {
          ...cached.payload.meta,
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
    searchCache.delete(cacheKey);
  }

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
    onBatch({
      source: sourceLabel,
      results: allItems,
      meta: {
        keyword: kw,
        rawCount,
        dedupedCount: allItems.length,
        elapsedMs: Date.now() - t0,
        cacheHit: false,
        streaming: completedTasks < totalTasks,
        progress: `${completedTasks}/${totalTasks}`,
        tgStats,
        pluginStats
      }
    });
  };

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
        cfg.tgConcurrency || 12,
        cfg.tgTimeoutMs || 5500,
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
    tgStats,
    pluginStats
  });

  saveToCache(cacheKey, payload);
  onDone(payload);
}
