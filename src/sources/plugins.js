import * as cheerio from 'cheerio';
import { getConfig } from '../config.js';
import {
  canExecuteSource,
  recordSourceFailure,
  recordSourceSuccess
} from '../services/breaker.js';
import { fetchJson, fetchText, httpFetch } from '../utils/http.js';
import {
  attachPasswordToUrl,
  cleanShareUrl,
  detectDriveType,
  extractNearbyPassword,
  extractPasswordFromUrl,
  normalizeLinkKey
} from '../utils/parser.js';

/**
 * 1. 小酷盘 (xiaokupan) 插件 — TanStack Start ServerFn Seroval AST 解析
 */
const XIAOKUPAN_DEFAULT_FN = 'ffb7ba806a267ced7478dc27716e79ea729a98a801af2ac9c3647bdaca91af78';
let cachedXiaokupanFn = '';
let cachedXiaokupanExp = 0;
let inflightXiaokupanFn = null;

async function getXiaokupanFnId(timeoutMs = 3500) {
  if (cachedXiaokupanFn && Date.now() < cachedXiaokupanExp) {
    return cachedXiaokupanFn;
  }
  if (inflightXiaokupanFn) return inflightXiaokupanFn;

  inflightXiaokupanFn = (async () => {
    try {
      const html = await fetchText('https://xiaokupan.com/', { timeoutMs });
      const assetMatch = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
      if (assetMatch) {
        const js = await fetchText(`https://xiaokupan.com${assetMatch[0]}`, { timeoutMs });
        const routeIdx = js.indexOf('"/s/$query"');
        const segment = routeIdx >= 0 ? js.slice(Math.max(0, routeIdx - 1500), routeIdx + 500) : js;
        const fnMatch = segment.match(/createServerRpc\("([a-f0-9]{64})"\)/);
        if (fnMatch?.[1]) {
          cachedXiaokupanFn = fnMatch[1];
          cachedXiaokupanExp = Date.now() + 6 * 3600 * 1000;
          return cachedXiaokupanFn;
        }
      }
    } catch {
      // fallback to default function id
    } finally {
      inflightXiaokupanFn = null;
    }
    cachedXiaokupanFn = XIAOKUPAN_DEFAULT_FN;
    cachedXiaokupanExp = Date.now() + 1800 * 1000;
    return cachedXiaokupanFn;
  })();

  return inflightXiaokupanFn;
}

function indexSerovalNodes(node, refs) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) indexSerovalNodes(item, refs);
    return;
  }
  if (typeof node.i === 'number' && node.t !== 4) {
    refs.set(node.i, node);
  }
  for (const val of Object.values(node)) {
    indexSerovalNodes(val, refs);
  }
}

function decodeSerovalNode(node, refs, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 28) return node;
  const t = node.t;
  if (t === 4) {
    const refId = Number(node.s ?? node.i);
    const target = refs.get(refId);
    return target ? decodeSerovalNode(target, refs, depth + 1) : null;
  }
  if (t === 1) return typeof node.s === 'string' ? node.s : '';
  if (t === 0 || t === 2) return node.s ?? null;
  if (t === 9 && Array.isArray(node.a)) {
    return node.a.map(item => decodeSerovalNode(item, refs, depth + 1));
  }
  if (t === 10 && node.p && Array.isArray(node.p.k) && Array.isArray(node.p.v)) {
    const out = {};
    const len = Math.min(node.p.k.length, node.p.v.length);
    for (let idx = 0; idx < len; idx++) {
      out[String(node.p.k[idx])] = decodeSerovalNode(node.p.v[idx], refs, depth + 1);
    }
    return out;
  }
  return null;
}

async function queryXiaokupanWithFn(fnId, keyword, timeoutMs) {
  const payload = {
    t: {
      t: 10,
      i: 0,
      p: {
        k: ['data'],
        v: [
          {
            t: 10,
            i: 1,
            p: {
              k: ['query'],
              v: [{ t: 1, s: keyword }]
            },
            o: 0
          }
        ]
      },
      o: 0
    },
    f: 63,
    m: []
  };

  const url = `https://xiaokupan.com/_serverFn/${fnId}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const raw = await fetchText(url, {
    timeoutMs,
    headers: {
      'x-tsr-serverfn': 'true',
      accept: 'application/x-tss-framed, application/x-ndjson, application/json',
      referer: `https://xiaokupan.com/s/${encodeURIComponent(keyword)}`
    }
  });

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      const rootNode = parsed?.t && typeof parsed.t === 'object' ? parsed.t : parsed;
      const refs = new Map();
      indexSerovalNodes(rootNode, refs);
      const decoded = decodeSerovalNode(rootNode, refs);
      const merged =
        decoded?.result?.searchResults?.merged_by_type ||
        decoded?.searchResults?.merged_by_type ||
        decoded?.merged_by_type;
      if (merged && typeof merged === 'object') {
        return merged;
      }
    } catch {
      // try previous line
    }
  }
  return null;
}

async function pluginXiaokupan(keyword, timeoutMs = 7000) {
  const initialFn = cachedXiaokupanFn || XIAOKUPAN_DEFAULT_FN;
  let merged = await queryXiaokupanWithFn(initialFn, keyword, timeoutMs);
  if (!merged) {
    const discoveredFn = await getXiaokupanFnId(3000);
    if (discoveredFn && discoveredFn !== initialFn) {
      merged = await queryXiaokupanWithFn(discoveredFn, keyword, timeoutMs);
    }
  }
  if (!merged) return [];

  const cfg = getConfig();
  const results = [];
  for (const [dtype, list] of Object.entries(merged)) {
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const src = String(it.source || 'plugin:xiaokupan').trim();
      if (cfg.hideAdsAndOwn && (src === 'own' || src === 'cms')) {
        continue;
      }
      const rawUrl = cleanShareUrl(it.url || it.link || '');
      const type = detectDriveType(rawUrl, dtype);
      if (!rawUrl || type === 'others') continue;
      const password = String(it.password || '').trim() || extractPasswordFromUrl(rawUrl);
      results.push({
        unique_id: `xiaokupan:${normalizeLinkKey(rawUrl)}`,
        title: String(it.note || it.title || keyword).trim(),
        content: String(it.content || '').trim().slice(0, 200),
        url: attachPasswordToUrl(rawUrl, type, password),
        type,
        password,
        datetime: String(it.datetime || ''),
        source: src.startsWith('plugin:') || src.startsWith('tg:') ? src : `plugin:xiaokupan`
      });
    }
  }
  return results;
}

/**
 * 2. 影盘社 (melost) 插件
 */
async function pluginMelost(keyword, timeoutMs = 7000) {
  const api = 'https://www.melost.cn/v1/search/disk';
  const pages = [1, 2];
  const allItems = [];

  await Promise.all(
    pages.map(async (page) => {
      try {
        const json = await fetchJson(api, {
          method: 'POST',
          timeoutMs,
          headers: {
            'content-type': 'application/json',
            origin: 'https://www.melost.cn',
            referer: 'https://www.melost.cn/search'
          },
          body: JSON.stringify({
            page,
            q: keyword,
            user: '',
            exact: false,
            user_distinct: false,
            format: [],
            share_time: '',
            share_year: '',
            size: 30,
            order: '',
            type: '',
            search_ticket: '',
            exclude_user: [],
            adv_params: {
              wechat_pwd: '',
              search_code: '',
              platform: 'pc',
              fp_data: '',
              automated: '0'
            }
          })
        });
        if (json?.code === 200 && Array.isArray(json?.data?.list)) {
          for (const it of json.data.list) {
            const rawUrl = cleanShareUrl(it.link || '');
            if (!rawUrl) continue;
            const type = detectDriveType(rawUrl, it.disk_type);
            if (type === 'others') continue;
            const password = (it.disk_pass || '').trim() || extractPasswordFromUrl(rawUrl);
            const title = String(it.disk_name || '').replace(/<[^>]+>/g, '').trim() || keyword;
            const files = String(it.files || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            allItems.push({
              unique_id: `melost:${it.disk_id || normalizeLinkKey(rawUrl)}`,
              title,
              content: files.slice(0, 200),
              url: attachPasswordToUrl(rawUrl, type, password),
              type,
              password,
              datetime: it.shared_time ? new Date(it.shared_time.replace(' ', 'T') + '+08:00').toISOString() : '',
              source: 'plugin:melost'
            });
          }
        }
      } catch {
        // ignore single page error
      }
    })
  );

  return allItems;
}

/**
 * 3. 爱看资源 (ikantv) 插件
 */
async function pluginIkantv(keyword, timeoutMs = 7000) {
  const url = `https://api.naspt.vip/api/open/pansou/search?kw=${encodeURIComponent(keyword)}&limit=50`;
  const json = await fetchJson(url, {
    timeoutMs,
    headers: { referer: 'https://api.naspt.vip/' }
  });
  if (json?.code !== 0 || !Array.isArray(json?.data)) return [];

  const results = [];
  for (const item of json.data) {
    if (!Array.isArray(item.links)) continue;
    for (const link of item.links) {
      const rawUrl = cleanShareUrl(link.url || '');
      const type = detectDriveType(rawUrl, link.type);
      if (!rawUrl || type === 'others') continue;
      const password = (link.password || '').trim() || extractPasswordFromUrl(rawUrl);
      results.push({
        unique_id: `ikantv:${item.unique_id || normalizeLinkKey(rawUrl)}`,
        title: (link.work_title || item.title || keyword).trim(),
        content: String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        url: attachPasswordToUrl(rawUrl, type, password),
        type,
        password,
        datetime: link.datetime || item.datetime || '',
        source: 'plugin:ikantv'
      });
    }
  }
  return results;
}

/**
 * 4. 小云搜索 (yunso) 插件（含 XOR 解密）
 */
const YUNSO_KEY = Buffer.from('pWz1vnL1fTkOvTMW3f9M1jJWfneUIh50', 'utf-8');

function decryptYunsoUrl(val = '') {
  const s = val.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  try {
    const padded = s.length % 4 === 0 ? s : s + '='.repeat(4 - (s.length % 4));
    const buf = Buffer.from(padded, 'base64');
    const direct = buf.toString('utf-8').trim();
    if (/^https?:\/\//i.test(direct)) return direct;
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ YUNSO_KEY[i % YUNSO_KEY.length];
    }
    const res = out.toString('utf-8').trim();
    return /^https?:\/\//i.test(res) ? res : '';
  } catch {
    return '';
  }
}

async function pluginYunso(keyword, timeoutMs = 7000) {
  const params = new URLSearchParams({
    requestID: '',
    mode: '90002',
    scope_content: '0',
    stype: '',
    wd: keyword,
    uk: '',
    page: '1',
    limit: '25',
    screen_filetype: ''
  });
  const url = `https://www.yunso.net/api/Core/search2?${params.toString()}`;
  const json = await fetchJson(url, {
    method: 'POST',
    timeoutMs,
    headers: {
      origin: 'https://www.yunso.net',
      referer: `https://www.yunso.net/index/user/s?wd=${encodeURIComponent(keyword)}`,
      'x-requested-with': 'XMLHttpRequest'
    }
  });
  if (json?.code !== 0 || typeof json?.data !== 'string') return [];

  const $ = cheerio.load(`<div id="root">${json.data}</div>`);
  const results = [];
  $('div.layui-card[data-qid]').each((_, card) => {
    const $card = $(card);
    const $a = $card.find('a[onclick*="open_sid"]').first();
    if (!$a.length) return;
    const title = $a.text().replace(/\s+/g, ' ').trim();
    const encUrl = $a.attr('url') || '';
    const realUrl = cleanShareUrl(decryptYunsoUrl(encUrl));
    if (!realUrl) return;
    const type = detectDriveType(realUrl);
    if (type === 'others') return;
    const password = ($a.attr('pa') || '').trim() || extractPasswordFromUrl(realUrl);
    const headerText = $card.find('.layui-card-header').text();
    const dtMatch = headerText.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    const summary = $card.find('p.result.container.p').first().text().replace(/\s+/g, ' ').trim();
    results.push({
      unique_id: `yunso:${normalizeLinkKey(realUrl)}`,
      title: title || keyword,
      content: summary.slice(0, 180),
      url: attachPasswordToUrl(realUrl, type, password),
      type,
      password,
      datetime: dtMatch ? new Date(dtMatch[0].replace(' ', 'T') + '+08:00').toISOString() : '',
      source: 'plugin:yunso'
    });
  });
  return results;
}

/**
 * 5. 影搜 (yingso) 插件 — UTF-16 XOR 加密协议
 */
const YINGSO_API = 'https://ysapi.yingso.fun';
let cachedYingsoCfg = null;
let cachedYingsoExp = 0;
let inflightYingsoCfg = null;

function xorUTF16(text = '', key = '') {
  if (!text || !key) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

function randomAlphaNum(len = 24) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function getYingsoConfig(timeoutMs = 4000) {
  if (cachedYingsoCfg && Date.now() < cachedYingsoExp) {
    return cachedYingsoCfg;
  }
  if (inflightYingsoCfg) return inflightYingsoCfg;

  inflightYingsoCfg = (async () => {
    try {
      const attempts = [
        { path: '/test1', key: '672134612' },
        { path: '/test', key: '12345678' }
      ];
      for (const a of attempts) {
        try {
          const json = await fetchJson(`${YINGSO_API}${a.path}`, {
            timeoutMs,
            headers: {
              origin: 'https://yingso.fun',
              referer: 'https://yingso.fun/'
            }
          });
          if (json?.code === 200 && typeof json.data === 'string') {
            const cfg = JSON.parse(xorUTF16(json.data, a.key));
            if (cfg?.url_version && cfg?.user_id && cfg?.end > cfg?.start) {
              cachedYingsoCfg = cfg;
              cachedYingsoExp = Date.now() + 15 * 60 * 1000;
              return cfg;
            }
          }
        } catch {
          // try next
        }
      }
      throw new Error('Failed to fetch yingso dynamic config');
    } finally {
      inflightYingsoCfg = null;
    }
  })();

  return inflightYingsoCfg;
}

function encryptYingsoBody(payload, cfg) {
  const no = randomAlphaNum(Math.max(24, Number(cfg.end) || 24));
  const sliceKey = no.slice(cfg.start, cfg.end);
  const info = xorUTF16(JSON.stringify(payload), sliceKey);
  return JSON.stringify({ no, info });
}

async function pluginYingso(keyword, timeoutMs = 7500) {
  const cfg = await getYingsoConfig(3500);
  const searchRes = await fetchJson(`${YINGSO_API}/${cfg.url_version}/search`, {
    method: 'POST',
    timeoutMs,
    headers: {
      'content-type': 'application/json',
      origin: 'https://yingso.fun',
      referer: 'https://yingso.fun/'
    },
    body: encryptYingsoBody(
      {
        pageSize: 16,
        pageNum: 1,
        title: keyword,
        root: 0,
        cat: 'all',
        userId: cfg.user_id
      },
      cfg
    )
  });

  const items = Array.isArray(searchRes?.data) ? searchRes.data.slice(0, 12) : [];
  if (!items.length) return [];

  const rootTypeMap = { 1: 'aliyun', 2: 'quark', 3: 'xunlei', 4: 'baidu', 5: 'uc' };
  const rootPrefixMap = {
    1: 'https://www.aliyundrive.com/s/',
    2: 'https://pan.quark.cn/s/',
    3: 'https://pan.xunlei.com/s/',
    4: 'https://pan.baidu.com/s/',
    5: 'https://drive.uc.cn/s/'
  };
  const results = [];

  await Promise.all(
    items.map(async (item) => {
      if (!item?.id) return;
      try {
        const keyRes = await fetchJson(`${YINGSO_API}/${cfg.url_version}/getKey670I23762183`, {
          method: 'POST',
          timeoutMs: 4500,
          headers: {
            'content-type': 'application/json',
            origin: 'https://yingso.fun',
            referer: 'https://yingso.fun/'
          },
          body: encryptYingsoBody({ id: item.id, userId: cfg.user_id }, cfg)
        });
        let rawKey = String(keyRes?.data || keyRes?.key || '').trim();
        if (!rawKey) return;
        const prefix = rootPrefixMap[item.root] || '';
        if (!/^https?:\/\//i.test(rawKey)) {
          if (!prefix) return;
          rawKey = prefix + rawKey.replace(/^\/+/, '');
        }
        const rawUrl = cleanShareUrl(rawKey);
        if (!rawUrl) return;
        const type = detectDriveType(rawUrl, rootTypeMap[item.root] || '');
        if (type === 'others') return;
        const password = extractPasswordFromUrl(rawUrl);
        results.push({
          unique_id: `yingso:${item.id}`,
          title: String(item.title || keyword).replace(/<[^>]+>/g, '').trim(),
          content: '',
          url: attachPasswordToUrl(rawUrl, type, password),
          type,
          password,
          datetime: item.time || '',
          source: 'plugin:yingso'
        });
      } catch {
        // ignore single item resolve failure
      }
    })
  );

  return results;
}

/**
 * 6. 爱盼影视 (aipan) 插件
 */
async function pluginAipan(keyword, timeoutMs = 7000) {
  const baseUrl = 'https://www.aipan.me';
  const searchJson = await fetchJson(`${baseUrl}/api/movies/search?q=${encodeURIComponent(keyword)}`, {
    timeoutMs,
    headers: { referer: `${baseUrl}/` }
  });
  const movies = Array.isArray(searchJson?.movies) ? searchJson.movies.slice(0, 6) : [];
  if (!movies.length) return [];

  const results = [];
  await Promise.all(
    movies.map(async (m) => {
      try {
        const detail = await fetchJson(`${baseUrl}/api/movies/detail/${encodeURIComponent(m.id)}`, {
          timeoutMs: 5000,
          headers: { referer: `${baseUrl}/movie/${encodeURIComponent(m.id)}` }
        });
        const rawList = [
          ...(Array.isArray(detail?.panLinks) ? detail.panLinks.map(x => ({ ...x, name: x.title })) : []),
          ...(Array.isArray(detail?.resources) ? detail.resources : [])
        ];
        const descParts = [];
        if (detail?.year) descParts.push(`${detail.year}年`);
        if (detail?.region) descParts.push(detail.region);
        if (Array.isArray(detail?.genres) && detail.genres.length) descParts.push(detail.genres.join('/'));
        if (detail?.imdbRating) descParts.push(`评分 ${detail.imdbRating}`);
        const baseDesc = descParts.join(' · ');

        for (const link of rawList) {
          const rawUrl = cleanShareUrl(link.url || '');
          const type = detectDriveType(rawUrl, link.kind);
          if (!rawUrl || type === 'others') continue;
          const password = extractNearbyPassword(rawUrl, `${link.name || ''} ${rawUrl}`);
          results.push({
            unique_id: `aipan:${m.id}:${normalizeLinkKey(rawUrl)}`,
            title: (link.name || detail.title || m.title || keyword).trim(),
            content: baseDesc,
            url: attachPasswordToUrl(rawUrl, type, password),
            type,
            password,
            datetime: '',
            source: 'plugin:aipan'
          });
        }
      } catch {
        // ignore single movie failure
      }
    })
  );
  return results;
}

/**
 * 7. 488网盘 (488run) 插件 — 含会话 Cookie 自动握手
 */
let cached488Cookie = '';
let cached488Exp = 0;
let inflight488Cookie = null;

async function get488Cookie(timeoutMs = 4000) {
  if (cached488Cookie && Date.now() < cached488Exp) {
    return cached488Cookie;
  }
  if (inflight488Cookie) return inflight488Cookie;

  inflight488Cookie = (async () => {
    try {
      const res = await httpFetch('https://488.run/', {
        timeoutMs,
        headers: { referer: 'https://488.run/' }
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
      try { await res.body?.cancel(); } catch {}
      for (const c of setCookie) {
        const m = String(c).match(/yd_frontend=[^;\s]+/);
        if (m) {
          cached488Cookie = m[0];
          cached488Exp = Date.now() + 6 * 3600 * 1000;
          return cached488Cookie;
        }
      }
      return '';
    } finally {
      inflight488Cookie = null;
    }
  })();

  return inflight488Cookie;
}

async function plugin488run(keyword, timeoutMs = 7000) {
  const cookie = await get488Cookie(2500).catch(() => '');
  const url = `https://488.run/api/frontend/search?q=${encodeURIComponent(keyword)}&limit=24&theme=wechat-cinehunt`;
  const headers = {
    accept: 'application/json',
    referer: `https://488.run/oeol/${encodeURIComponent(keyword)}.htm`
  };
  if (cookie) headers.cookie = cookie;

  const json = await fetchJson(url, { timeoutMs, headers });
  if (json?.code !== 0 || !json?.data) return [];

  const combined = [
    ...(Array.isArray(json.data.list) ? json.data.list : []),
    ...(Array.isArray(json.data.items) ? json.data.items : [])
  ];

  const results = [];
  for (const item of combined) {
    const rawUrl = cleanShareUrl(item.share_link || item.link || item.url || '');
    if (!rawUrl) continue;
    const type = detectDriveType(rawUrl, item.disk_type || item.drive_type);
    if (type === 'others') continue;
    const password = extractPasswordFromUrl(rawUrl);
    results.push({
      unique_id: `488run:${item.id || normalizeLinkKey(rawUrl)}`,
      title: String(item.title || item.name || keyword).trim(),
      content: String(item.desc || item.description || item.type_name || '').trim().slice(0, 180),
      url: attachPasswordToUrl(rawUrl, type, password),
      type,
      password,
      datetime: String(item.updated_at || item.share_time || ''),
      source: 'plugin:488run'
    });
  }
  return results;
}

/**
 * 8. 夸克搜 / 闪电资源 (quarksoo) 插件
 */
async function pluginQuarksoo(keyword, timeoutMs = 7000) {
  const results = [];

  await Promise.all([
    // 通道 A: quarksoo.cc
    (async () => {
      try {
        const html = await fetchText(`https://quarksoo.cc/search.php?q=${encodeURIComponent(keyword)}`, {
          timeoutMs,
          headers: { referer: 'https://quarksoo.cc/' }
        });
        const $ = cheerio.load(html);
        $('table tr').each((_, tr) => {
          const tds = $(tr).find('td');
          if (tds.length < 2) return;
          const title = $(tds[0]).text().replace(/\s+/g, ' ').trim();
          const rawText = $(tr).html() || '';
          const urlMatches = rawText.match(/https?:\/\/pan\.quark\.cn\/s\/[A-Za-z0-9]+/gi) || [];
          for (const u of urlMatches) {
            const cleaned = cleanShareUrl(u);
            const pwd = extractNearbyPassword(cleaned, $(tr).text());
            results.push({
              unique_id: `quarksoo:${normalizeLinkKey(cleaned)}`,
              title: title || keyword,
              content: '',
              url: attachPasswordToUrl(cleaned, 'quark', pwd),
              type: 'quark',
              password: pwd,
              datetime: '',
              source: 'plugin:quarksoo'
            });
          }
        });
      } catch {
        // ignore
      }
    })(),
    // 通道 B: sd.sduc.site (闪电资源库)
    (async () => {
      try {
        const baseUrl = 'http://sd.sduc.site';
        const html = await fetchText(`${baseUrl}/index.php/vod/search.html?wd=${encodeURIComponent(keyword)}`, {
          timeoutMs,
          headers: { referer: `${baseUrl}/` }
        });
        const $ = cheerio.load(html);
        const detailLinks = [];
        $('a[href*="/vod/detail/id/"]').each((_, a) => {
          const href = $(a).attr('href') || '';
          const title = ($(a).attr('title') || $(a).text() || '').trim();
          if (href && !detailLinks.some(d => d.href === href) && detailLinks.length < 4) {
            detailLinks.push({ href: href.startsWith('http') ? href : `${baseUrl}${href}`, title });
          }
        });

        await Promise.all(
          detailLinks.map(async (item) => {
            try {
              const dHtml = await fetchText(item.href, { timeoutMs: 4500, headers: { referer: baseUrl } });
              const $d = cheerio.load(dHtml);
              const pageTitle = ($d('h1').first().text() || item.title || keyword).trim();
              $d('a[href], .module-row-info, .module-downlist').each((__, el) => {
                const combined = `${$d(el).attr('href') || ''} ${$d(el).text() || ''}`;
                const m = combined.match(/https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&+,;=%-]+/g) || [];
                for (const u of m) {
                  const cleaned = cleanShareUrl(u);
                  const type = detectDriveType(cleaned);
                  if (type === 'others') continue;
                  const pwd = extractNearbyPassword(cleaned, combined);
                  results.push({
                    unique_id: `quarksoo:${normalizeLinkKey(cleaned)}`,
                    title: pageTitle,
                    content: '',
                    url: attachPasswordToUrl(cleaned, type, pwd),
                    type,
                    password: pwd,
                    datetime: '',
                    source: 'plugin:quarksoo'
                  });
                }
              });
            } catch {
              // ignore
            }
          })
        );
      } catch {
        // ignore
      }
    })()
  ]);

  return results;
}

/**
 * 9. 二小盘 (erxiaopan) 插件
 */
async function pluginErxiaopan(keyword, timeoutMs = 7000) {
  const baseUrl = 'https://www.2xiaopan.one';
  const html = await fetchText(`${baseUrl}/index.php/vod/search.html?wd=${encodeURIComponent(keyword)}`, {
    timeoutMs,
    headers: { referer: `${baseUrl}/` }
  });
  const $ = cheerio.load(html);
  const detailLinks = [];
  $('a[href*="/vod/detail/id/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const title = ($(a).attr('title') || $(a).text() || '').trim();
    if (href && !detailLinks.some(d => d.href === href) && detailLinks.length < 5) {
      detailLinks.push({ href: href.startsWith('http') ? href : `${baseUrl}${href}`, title });
    }
  });

  const results = [];
  await Promise.all(
    detailLinks.map(async (item) => {
      try {
        const dHtml = await fetchText(item.href, { timeoutMs: 5000, headers: { referer: baseUrl } });
        const $d = cheerio.load(dHtml);
        const pageTitle = ($d('h1').first().text() || item.title || keyword).trim();
        $d('a[href], .module-row-info, .module-downlist').each((__, el) => {
          const text = $d(el).text() || '';
          const href = $d(el).attr('href') || '';
          const combined = `${href} ${text}`;
          const m = combined.match(/https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&+,;=%-]+/g) || [];
          for (const u of m) {
            const cleaned = cleanShareUrl(u);
            const type = detectDriveType(cleaned);
            if (type === 'others') continue;
            const pwd = extractNearbyPassword(cleaned, combined);
            results.push({
              unique_id: `erxiaopan:${normalizeLinkKey(cleaned)}`,
              title: pageTitle,
              content: '',
              url: attachPasswordToUrl(cleaned, type, pwd),
              type,
              password: pwd,
              datetime: '',
              source: 'plugin:erxiaopan'
            });
          }
        });
      } catch {
        // ignore
      }
    })
  );
  return results;
}

/**
 * 10. 上游聚合加速源 (mipan_relay)
 */
let cachedMipanToken = '';
let cachedMipanExp = 0;
let inflightMipanToken = null;

async function getMipanToken(timeoutMs = 4000) {
  if (cachedMipanToken && Date.now() < cachedMipanExp) {
    return cachedMipanToken;
  }
  if (inflightMipanToken) return inflightMipanToken;

  inflightMipanToken = (async () => {
    try {
      const json = await fetchJson('https://www.mipan.so/api/token', {
        timeoutMs,
        headers: { referer: 'https://www.mipan.so/' }
      });
      if (json?.token) {
        cachedMipanToken = json.token;
        cachedMipanExp = Date.now() + Math.max(300, (json.ttl || 7200) - 300) * 1000;
        return cachedMipanToken;
      }
      throw new Error('Failed to fetch relay token');
    } finally {
      inflightMipanToken = null;
    }
  })();

  return inflightMipanToken;
}

async function pluginMipanRelay(keyword, timeoutMs = 8000) {
  const cfg = getConfig();
  let token = await getMipanToken(4000);
  let res = await httpFetch('https://www.mipan.so/api/search', {
    method: 'POST',
    timeoutMs,
    headers: {
      'content-type': 'application/json',
      'x-mipan-token': token,
      origin: 'https://www.mipan.so',
      referer: 'https://www.mipan.so/'
    },
    body: JSON.stringify({ kw: keyword })
  });

  if (res.status === 403) {
    cachedMipanToken = '';
    token = await getMipanToken(4000);
    res = await httpFetch('https://www.mipan.so/api/search', {
      method: 'POST',
      timeoutMs,
      headers: {
        'content-type': 'application/json',
        'x-mipan-token': token,
        origin: 'https://www.mipan.so',
        referer: 'https://www.mipan.so/'
      },
      body: JSON.stringify({ kw: keyword })
    });
  }

  if (!res.ok) return [];
  const json = await res.json();
  const merged = json?.data?.merged_by_type || {};
  const results = [];

  for (const [dtype, arr] of Object.entries(merged)) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const src = String(it.source || '').trim();
      if (cfg.hideAdsAndOwn && (src === 'own' || src === 'cms')) {
        continue;
      }
      const rawUrl = cleanShareUrl(it.url || it.link || '');
      const type = detectDriveType(rawUrl, dtype);
      if (!rawUrl || type === 'others') continue;
      const password = (it.password || '').trim() || extractPasswordFromUrl(rawUrl);
      results.push({
        unique_id: `relay:${normalizeLinkKey(rawUrl)}`,
        title: (it.note || it.title || keyword).trim(),
        content: (it.content || '').trim(),
        url: attachPasswordToUrl(rawUrl, type, password),
        type,
        password,
        datetime: it.datetime || '',
        source: src || 'plugin:relay'
      });
    }
  }
  return results;
}

export const PLUGIN_HANDLERS = {
  xiaokupan: pluginXiaokupan,
  melost: pluginMelost,
  ikantv: pluginIkantv,
  yunso: pluginYunso,
  yingso: pluginYingso,
  aipan: pluginAipan,
  '488run': plugin488run,
  quarksoo: pluginQuarksoo,
  erxiaopan: pluginErxiaopan,
  mipan_relay: pluginMipanRelay
};

/**
 * 执行单个插件（内置熔断器保护与耗时统计）
 */
export async function runSinglePlugin(id, keyword, timeoutMs = 7500) {
  const handler = PLUGIN_HANDLERS[id];
  if (!handler) {
    return { id, items: [], stat: { ok: false, count: 0, error: 'Unknown plugin', elapsedMs: 0 } };
  }

  const breakerKey = `plugin:${id}`;
  if (!canExecuteSource(breakerKey)) {
    return {
      id,
      items: [],
      stat: {
        ok: false,
        circuitOpen: true,
        count: 0,
        error: 'CIRCUIT_OPEN (COOLDOWN)',
        elapsedMs: 0
      }
    };
  }

  const t0 = Date.now();
  try {
    const items = await handler(keyword, timeoutMs);
    const elapsedMs = Date.now() - t0;
    recordSourceSuccess(breakerKey, elapsedMs);
    return {
      id,
      items,
      stat: {
        ok: true,
        count: items.length,
        elapsedMs
      }
    };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    recordSourceFailure(breakerKey, elapsedMs, err.message);
    return {
      id,
      items: [],
      stat: {
        ok: false,
        count: 0,
        error: err.message,
        elapsedMs
      }
    };
  }
}

export async function runEnabledPlugins(keyword, enabledIds = [], timeoutMs = 7500) {
  const activeIds = enabledIds.filter(id => PLUGIN_HANDLERS[id]);
  const pluginStats = {};
  const allItems = [];

  await Promise.all(
    activeIds.map(async (id) => {
      const { items, stat } = await runSinglePlugin(id, keyword, timeoutMs);
      pluginStats[id] = stat;
      if (items.length > 0) {
        allItems.push(...items);
      }
    })
  );

  return {
    items: allItems,
    pluginStats
  };
}
