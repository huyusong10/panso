import { fetchJson } from '../utils/http.js';

const PAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 单页缓存 1 小时
const pageCache = new Map();

export const EXPLORE_CHANNELS = [
  { id: 'hot_tv',    label: '热播剧集', type: 'tv',    tag: '热门' },
  { id: 'hot_movie', label: '热门电影', type: 'movie', tag: '热门' },
  { id: 'top_movie', label: '豆瓣高分', type: 'movie', tag: '豆瓣高分' },
  { id: 'cn_tv',     label: '国产剧',   type: 'tv',    tag: '国产剧' },
  { id: 'anime',     label: '动漫番剧', type: 'tv',    tag: '日本动画' },
  { id: 'us_tv',     label: '美剧',     type: 'tv',    tag: '美剧' },
  { id: 'kr_tv',     label: '日韩剧',   type: 'tv',    tag: '韩剧' },
  { id: 'variety',   label: '热门综艺', type: 'tv',    tag: '综艺' },
  { id: 'doc',       label: '纪录片',   type: 'tv',    tag: '纪录片' },
  { id: 'hidden_gem',label: '冷门佳片', type: 'movie', tag: '冷门佳片' }
];

const FALLBACK_POSTERS = [
  { id: 'f1', title: '凡人修仙传', rate: '9.1', episodes_info: '国漫年番', cover: '', is_new: false },
  { id: 'f2', title: '仙逆', rate: '8.8', episodes_info: '修真国漫', cover: '', is_new: false },
  { id: 'f3', title: '漫长的季节', rate: '9.4', episodes_info: '12集全', cover: '', is_new: false },
  { id: 'f4', title: '山花烂漫时', rate: '9.6', episodes_info: '23集全', cover: '', is_new: false },
  { id: 'f5', title: '唐朝诡事录之西行', rate: '8.6', episodes_info: '40集全', cover: '', is_new: false },
  { id: 'f6', title: '边水往事', rate: '8.2', episodes_info: '21集全', cover: '', is_new: false },
  { id: 'f7', title: '沙丘2', rate: '8.2', episodes_info: '科幻巨制', cover: '', is_new: false },
  { id: 'f8', title: '奥本海默', rate: '8.8', episodes_info: '传记剧情', cover: '', is_new: false },
  { id: 'f9', title: '葬送的芙莉莲', rate: '9.5', episodes_info: '28集全', cover: '', is_new: false },
  { id: 'f10', title: '大明王朝1566', rate: '9.8', episodes_info: '46集全', cover: '', is_new: false },
  { id: 'f11', title: '好东西', rate: '9.1', episodes_info: '口碑高分', cover: '', is_new: true },
  { id: 'f12', title: '破·地狱', rate: '8.7', episodes_info: '港片佳作', cover: '', is_new: true }
];

/**
 * 分页拉取豆瓣海报墙数据（支持无限下拉滚动）
 */
export async function fetchExploreWall({
  channel = 'hot_tv',
  sort = 'recommend',
  start = 0,
  limit = 24
} = {}) {
  const chObj = EXPLORE_CHANNELS.find(c => c.id === channel) || EXPLORE_CHANNELS[0];
  const validSort = ['recommend', 'time', 'rank'].includes(sort) ? sort : 'recommend';
  const pageStart = Math.max(0, Number(start) || 0);
  const pageLimit = Math.min(40, Math.max(12, Number(limit) || 24));

  const cacheKey = `${chObj.id}|${validSort}|${pageStart}|${pageLimit}`;
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://movie.douban.com/j/search_subjects?type=${encodeURIComponent(chObj.type)}&tag=${encodeURIComponent(chObj.tag)}&sort=${encodeURIComponent(validSort)}&page_limit=${pageLimit}&page_start=${pageStart}`;

  try {
    const json = await fetchJson(url, {
      timeoutMs: 5000,
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
      if (pageCache.size > 150) {
        const oldest = pageCache.keys().next().value;
        pageCache.delete(oldest);
      }
      pageCache.set(cacheKey, { ts: Date.now(), data: payload });
    }

    return payload;
  } catch (err) {
    // 离线或失败时返回兜底数据
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
}

export async function getTrendingRecommendations() {
  const res = await fetchExploreWall({ channel: 'hot_tv', sort: 'recommend', start: 0, limit: 24 });
  return res;
}
