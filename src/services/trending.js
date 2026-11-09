import path from 'node:path';
import { DATA_DIR, readJsonSafe, writeJsonAtomic } from '../config.js';
import { fetchJson } from '../utils/http.js';

const PAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 内存鲜活期 1 小时
const STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 陈旧可用期 7 天（防豆瓣短时限流）
const EXPLORE_SNAPSHOT_FILE = path.join(DATA_DIR, 'explore_snapshot.json');

const pageCache = new Map();
const inFlightExplore = new Map();
let persistTimer = null;

export const EXPLORE_CHANNELS = [
  { id: 'hot_tv',     label: '热播剧集', type: 'tv',    tag: '热门' },
  { id: 'hot_movie',  label: '热门电影', type: 'movie', tag: '热门' },
  { id: 'top_movie',  label: '豆瓣高分', type: 'movie', tag: '豆瓣高分' },
  { id: 'cn_tv',      label: '国产剧',   type: 'tv',    tag: '国产剧' },
  { id: 'anime',      label: '动漫番剧', type: 'tv',    tag: '日本动画' },
  { id: 'us_tv',      label: '美剧',     type: 'tv',    tag: '美剧' },
  { id: 'kr_tv',      label: '日韩剧',   type: 'tv',    tag: '韩剧' },
  { id: 'variety',    label: '热门综艺', type: 'tv',    tag: '综艺' },
  { id: 'doc',        label: '纪录片',   type: 'tv',    tag: '纪录片' },
  { id: 'hidden_gem', label: '冷门佳片', type: 'movie', tag: '冷门佳片' }
];

const CHANNEL_ALIAS = {
  kr_jp_tv: 'kr_tv',
  cold_gems: 'hidden_gem'
};

const FALLBACK_POSTERS = [
  { id: 'f1', title: '凡人修仙传', rate: '9.1', note: '国漫年番', cover: '', isNew: false },
  { id: 'f2', title: '仙逆', rate: '8.8', note: '修真国漫', cover: '', isNew: false },
  { id: 'f3', title: '漫长的季节', rate: '9.4', note: '12集全', cover: '', isNew: false },
  { id: 'f4', title: '山花烂漫时', rate: '9.6', note: '23集全', cover: '', isNew: false },
  { id: 'f5', title: '唐朝诡事录之西行', rate: '8.6', note: '40集全', cover: '', isNew: false },
  { id: 'f6', title: '边水往事', rate: '8.2', note: '21集全', cover: '', isNew: false },
  { id: 'f7', title: '沙丘2', rate: '8.2', note: '科幻巨制', cover: '', isNew: false },
  { id: 'f8', title: '奥本海默', rate: '8.8', note: '传记剧情', cover: '', isNew: false },
  { id: 'f9', title: '葬送的芙莉莲', rate: '9.5', note: '28集全', cover: '', isNew: false },
  { id: 'f10', title: '大明王朝1566', rate: '9.8', note: '46集全', cover: '', isNew: false },
  { id: 'f11', title: '好东西', rate: '9.1', note: '口碑高分', cover: '', isNew: true },
  { id: 'f12', title: '破·地狱', rate: '8.7', note: '港片佳作', cover: '', isNew: true }
];

// 启动时从本地磁盘恢复上次成功抓取的海报墙快照（实现重启秒开与离线高可用）
function initFromDiskSnapshot() {
  const snap = readJsonSafe(EXPLORE_SNAPSHOT_FILE, null);
  if (!snap || typeof snap !== 'object') return;
  for (const [k, entry] of Object.entries(snap)) {
    if (entry && entry.ts && entry.data && Date.now() - entry.ts < STALE_MAX_AGE_MS) {
      pageCache.set(k, entry);
    }
  }
}
initFromDiskSnapshot();

function scheduleSnapshotPersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const out = {};
    let count = 0;
    // 仅持久化前 40 个核心分类页，控制磁盘文件体积
    for (const [k, v] of pageCache.entries()) {
      if (count >= 40) break;
      out[k] = v;
      count++;
    }
    writeJsonAtomic(EXPLORE_SNAPSHOT_FILE, out);
  }, 3000);
}

/**
 * 分页拉取豆瓣海报墙数据（内置 Singleflight 合并、SWR 陈旧兜底与磁盘快照）
 */
export async function fetchExploreWall({
  channel = 'hot_tv',
  sort = 'recommend',
  start = 0,
  limit = 24
} = {}) {
  const normalizedChannel = CHANNEL_ALIAS[channel] || channel;
  const chObj = EXPLORE_CHANNELS.find(c => c.id === normalizedChannel) || EXPLORE_CHANNELS[0];
  const validSort = ['recommend', 'time', 'rank'].includes(sort) ? sort : 'recommend';
  const pageStart = Math.max(0, Number(start) || 0);
  const pageLimit = Math.min(40, Math.max(12, Number(limit) || 24));

  const cacheKey = `${chObj.id}|${validSort}|${pageStart}|${pageLimit}`;
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL_MS) {
    // LRU 晋升
    pageCache.delete(cacheKey);
    pageCache.set(cacheKey, cached);
    return cached.data;
  }

  if (inFlightExplore.has(cacheKey)) {
    return inFlightExplore.get(cacheKey);
  }

  const task = (async () => {
    const url = `https://movie.douban.com/j/search_subjects?type=${encodeURIComponent(chObj.type)}&tag=${encodeURIComponent(chObj.tag)}&sort=${encodeURIComponent(validSort)}&page_limit=${pageLimit}&page_start=${pageStart}`;

    try {
      const json = await fetchJson(url, {
        timeoutMs: 5500,
        useProxy: false,
        headers: {
          referer: 'https://movie.douban.com/',
          accept: 'application/json, text/plain, */*'
        }
      });

      const subjects = Array.isArray(json?.subjects) ? json.subjects : [];
      const items = subjects
        .map(s => {
          const rawCover = String(s.cover || '').trim();
          return {
            id: String(s.id || s.title),
            title: String(s.title || '').trim(),
            rate: String(s.rate || '').trim(),
            note: String(s.episodes_info || '').trim() || chObj.label,
            isNew: Boolean(s.is_new),
            cover: rawCover ? `/api/poster?url=${encodeURIComponent(rawCover)}` : '',
            doubanUrl: String(s.url || '')
          };
        })
        .filter(x => x.title);

      const payload = {
        channel: chObj.id,
        sort: validSort,
        start: pageStart,
        limit: pageLimit,
        hasMore: items.length >= Math.floor(pageLimit * 0.6),
        nextStart: pageStart + items.length,
        items,
        channels: EXPLORE_CHANNELS
      };

      if (items.length > 0) {
        if (pageCache.size >= 160) {
          const oldest = pageCache.keys().next().value;
          pageCache.delete(oldest);
        }
        pageCache.set(cacheKey, { ts: Date.now(), data: payload });
        if (pageStart <= 48) {
          scheduleSnapshotPersist();
        }
        return payload;
      }

      // 若豆瓣返回空列表但有陈旧缓存，优先返回陈旧缓存
      if (cached?.data) {
        return cached.data;
      }
      return payload;
    } catch {
      // 若豆瓣短时限流或离线，优先使用 Stale 缓存快照
      if (cached?.data) {
        return cached.data;
      }
      return {
        channel: chObj.id,
        sort: validSort,
        start: pageStart,
        limit: pageLimit,
        hasMore: false,
        nextStart: pageStart + FALLBACK_POSTERS.length,
        items: pageStart === 0 ? FALLBACK_POSTERS : [],
        channels: EXPLORE_CHANNELS
      };
    }
  })().finally(() => {
    inFlightExplore.delete(cacheKey);
  });

  inFlightExplore.set(cacheKey, task);
  return task;
}

export async function getTrendingRecommendations() {
  return fetchExploreWall({ channel: 'hot_tv', sort: 'recommend', start: 0, limit: 24 });
}

export function getExploreStats() {
  return {
    cachedPages: pageCache.size,
    inFlight: inFlightExplore.size
  };
}
