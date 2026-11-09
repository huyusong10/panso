// 网盘链接特征正则与分类器

const DRIVE_RULES = [
  { type: 'quark', re: /https?:\/\/pan\.quark\.cn\/(?:s|g)\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: 'baidu', re: /https?:\/\/(?:pan|yun)\.baidu\.com\/s\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: 'aliyun', re: /https?:\/\/(?:www\.)?(?:alipan\.com|aliyundrive\.com)\/s\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: 'uc', re: /https?:\/\/(?:drive|fast)\.uc\.cn\/s\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: 'tianyi', re: /https?:\/\/cloud\.189\.cn\/(?:t\/[A-Za-z0-9_-]+|web\/share\?[A-Za-z0-9_=&%-]+)/gi },
  { type: 'xunlei', re: /https?:\/\/pan\.xunlei\.com\/s\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: '115', re: /https?:\/\/(?:115\.com|115cdn\.com|anxia\.com)\/s\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: '123', re: /https?:\/\/(?:www\.)?(?:123pan\.com|123pan\.cn|123684\.com|123685\.com|123865\.com|123912\.com|123592\.com)\/s\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: 'pikpak', re: /https?:\/\/mypikpak\.com\/s\/[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_=&%-]*)?/gi },
  { type: 'mobile', re: /https?:\/\/(?:caiyun\.139\.com|feixin\.10086\.cn)\/[A-Za-z0-9/_?=&%-]+/gi }
];

const PWD_NEARBY_RE = /(?:提取码|访问码|密码|取件码|口令|pwd|password|passcode|code)\s*[:：=\s]\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/i;

export function detectDriveType(rawUrl = '', fallbackType = '') {
  const lower = String(rawUrl).toLowerCase();
  if (lower.includes('pan.quark.cn')) return 'quark';
  if (lower.includes('pan.baidu.com') || lower.includes('yun.baidu.com')) return 'baidu';
  if (lower.includes('alipan.com') || lower.includes('aliyundrive.com')) return 'aliyun';
  if (lower.includes('drive.uc.cn') || lower.includes('fast.uc.cn')) return 'uc';
  if (lower.includes('cloud.189.cn')) return 'tianyi';
  if (lower.includes('pan.xunlei.com')) return 'xunlei';
  if (lower.includes('115.com') || lower.includes('115cdn.com') || lower.includes('anxia.com')) return '115';
  if (/123(?:pan|684|685|865|912|592)\.(?:com|cn)/.test(lower)) return '123';
  if (lower.includes('mypikpak.com')) return 'pikpak';
  if (lower.includes('caiyun.139.com') || lower.includes('10086.cn')) return 'mobile';

  const fb = String(fallbackType).toLowerCase().trim();
  if (['quark', 'baidu', 'aliyun', 'uc', 'tianyi', 'xunlei', '115', '123', 'pikpak', 'mobile'].includes(fb)) {
    return fb;
  }
  if (fb === 'bdy') return 'baidu';
  if (fb === 'aly' || fb === 'alipan' || fb === 'aliyundrive') return 'aliyun';
  if (fb === 'caiyun' || fb === '139') return 'mobile';
  if (fb === '123pan') return '123';
  return 'others';
}

export function cleanShareUrl(rawUrl = '') {
  let u = String(rawUrl).trim();
  u = u.replace(/&amp;/g, '&');
  // 剔除末尾可能粘连的中文标点、括号或多余的 ? &
  u = u.replace(/[)"'<>\]）】。，；、！!?&]+$/g, '');
  return u;
}

export function extractPasswordFromUrl(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl);
    for (const k of ['pwd', 'password', 'passcode', 'code', 'pass']) {
      const val = (parsed.searchParams.get(k) || '').trim();
      if (/^[A-Za-z0-9]{4,8}$/.test(val)) {
        return val;
      }
    }
    if (parsed.hash) {
      const m = parsed.hash.match(/(?:pwd|password|code)=([A-Za-z0-9]{4,8})/i);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }
  return '';
}

export function extractNearbyPassword(linkUrl, fullText = '') {
  const fromUrl = extractPasswordFromUrl(linkUrl);
  if (fromUrl) return fromUrl;
  if (!fullText) return '';

  const baseLink = linkUrl.split('?')[0];
  const idx = fullText.indexOf(baseLink);
  if (idx !== -1) {
    // 截取链接后方 80 个字符窗口（若遇到下一个 http 链接则提前截断，防止多链接串码）
    let after = fullText.slice(idx + baseLink.length, idx + baseLink.length + 90);
    const nextHttp = after.search(/https?:\/\//i);
    if (nextHttp !== -1) {
      after = after.slice(0, nextHttp);
    }
    const m = after.match(PWD_NEARBY_RE);
    if (m) return m[1];
  }

  const globalMatch = fullText.match(PWD_NEARBY_RE);
  return globalMatch ? globalMatch[1] : '';
}

export function extractLinksFromText(text = '') {
  const found = [];
  const seen = new Set();

  for (const rule of DRIVE_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const url = cleanShareUrl(m[0]);
      const key = normalizeLinkKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      const password = extractNearbyPassword(url, text);
      found.push({
        url: attachPasswordToUrl(url, rule.type, password),
        type: rule.type,
        password
      });
    }
  }
  return found;
}

export function attachPasswordToUrl(url, type, password) {
  if (!password) return url;
  if (url.includes('pwd=') || url.includes('password=')) return url;
  if (['baidu', 'quark', 'xunlei', '123'].includes(type)) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}pwd=${password}`;
  }
  return url;
}

export function normalizeLinkKey(rawUrl = '') {
  try {
    const u = new URL(cleanShareUrl(rawUrl));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '');
    // 天翼云盘 web/share?code=xxx
    const code = u.searchParams.get('code') || u.searchParams.get('surl') || '';
    return `${host}${pathname}${code ? ':' + code : ''}`;
  } catch {
    return String(rawUrl).trim().toLowerCase();
  }
}

export function extractCleanTitle(textWithBreaks = '', fallbackKeyword = '') {
  const lines = String(textWithBreaks)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^https?:\/\//i.test(line)) continue;
    if (/^(?:链接|地址|提取码|访问码|密码|标签|来源|频道|群组|投稿)\s*[:：]/i.test(line)) continue;
    let cleaned = line
      .replace(/^(?:名称|资源名称|片名|剧名|书名|标题|资源|🔥|🎬|📺|📁|📌|✨|▶️|【[^】]{1,8}】)\s*[:：]?\s*/gi, '')
      .replace(/https?:\/\/\S+/gi, '')
      .trim();
    if (cleaned.length >= 2) {
      return cleaned.slice(0, 120);
    }
  }
  return fallbackKeyword || '未命名网盘资源';
}

const PRIORITY_WORDS = ['4k', '2160p', '1080p', '合集', '全集', '完结', '臻彩', '杜比', '蓝光', '原盘', 'remux', '高码', '60fps', '60帧'];
const SPAM_PENALTY_WORDS = ['关注公众号', '公众号回复', '付费解压', '加微信', '引流', '点击领取', '内部群', '免费领', '解压密码请', '代找'];

/**
 * 从标题与简介中提纯结构化规格与集数印记
 */
export function extractResourceSpecs(title = '', content = '') {
  const combined = `${title} ${content}`;
  const specs = [];
  const add = (label, kind = 'spec') => {
    if (!specs.some(s => s.label === label) && specs.length < 5) {
      specs.push({ label, kind });
    }
  };

  if (/\b(?:4k|2160p|uhd)\b/i.test(combined)) add('4K', 'cinnabar');
  else if (/\b1080p\b/i.test(combined)) add('1080P', 'spec');

  if (/(?:杜比视界|杜比|dolby\s*vision|\bdv\b|臻彩)/i.test(combined)) add('杜比', 'pine');
  else if (/\bhdr(?:10\+?)?\b/i.test(combined)) add('HDR', 'pine');

  if (/(?:\bremux\b|蓝光原盘|原盘|bdmv|iso\b)/i.test(combined)) add('原盘', 'pine');
  if (/(?:\b60\s*fps\b|60帧|高帧率)/i.test(combined)) add('60帧', 'spec');
  if (/(?:高码率?|hq|臻享)/i.test(combined)) add('高码', 'spec');

  const epMatch = combined.match(/(?:更新?至|更至|更)\s*第?\s*(\d{1,4})\s*[集期话]/i) ||
                  combined.match(/【\s*更\s*(\d{1,4})\s*集?\s*】/i);
  if (epMatch) {
    add(`更至${epMatch[1]}集`, 'progress');
  } else if (/(?:全集|完结|\d+\s*集全|全\s*\d+\s*集)/i.test(combined)) {
    add('全集', 'progress');
  }

  if (/(?:国粤|双语|多音轨)/i.test(combined)) add('双语', 'spec');
  if (/(?:flac|无损|dts-hd|truehd|atmos)/i.test(combined)) add('无损音轨', 'spec');

  return specs;
}

export function scoreResultItem(item, keyword = '') {
  let score = 0;
  const kw = keyword.trim().toLowerCase();
  const title = (item.title || '').toLowerCase();
  const content = (item.content || '').toLowerCase();
  const combined = `${title} ${content}`;

  // 1. 标题相关性权重
  if (kw) {
    if (title === kw) score += 200;
    else if (title.startsWith(kw) || title.includes(`《${kw}》`)) score += 140;
    else if (title.includes(kw)) score += 90;
    else if (content.includes(kw)) score += 35;
  }

  // 2. 高画质/全集特征词加分
  for (const w of PRIORITY_WORDS) {
    if (combined.includes(w)) {
      score += 18;
    }
  }

  // 2.5. 引流/诱导类噪音降权
  for (const bad of SPAM_PENALTY_WORDS) {
    if (combined.includes(bad)) {
      score -= 140;
    }
  }

  // 3. 时效性加分
  if (item.datetime) {
    const ts = Date.parse(item.datetime);
    if (!Number.isNaN(ts) && ts > 946684800000) {
      const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 3600 * 24));
      if (ageDays <= 7) score += 60;
      else if (ageDays <= 30) score += 40;
      else if (ageDays <= 180) score += 20;
      else if (ageDays <= 365) score += 10;
    }
  }

  // 4. 带提取码/完整度加分
  if (item.password) score += 8;
  if (String(item.source || '').startsWith('tg:')) score += 12;

  return score;
}
