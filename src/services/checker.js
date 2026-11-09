import { httpFetch } from '../utils/http.js';
import { cleanShareUrl, detectDriveType, extractPasswordFromUrl } from '../utils/parser.js';

const checkCache = new Map();
const VALID_TTL_MS = 20 * 60 * 1000;      // 有效链接缓存 20 分钟
const INVALID_TTL_MS = 6 * 60 * 60 * 1000; // 失效链接缓存 6 小时

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!n || n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function getCachedState(url) {
  const entry = checkCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    checkCache.delete(url);
    return null;
  }
  return entry.result;
}

function setCachedState(url, result) {
  const ttl = result.state === 'invalid' ? INVALID_TTL_MS : VALID_TTL_MS;
  if (checkCache.size > 2000) {
    const oldest = checkCache.keys().next().value;
    checkCache.delete(oldest);
  }
  checkCache.set(url, {
    result,
    expiresAt: Date.now() + ttl
  });
}

/**
 * 1. 夸克网盘存活检测 + 真实目录名透视
 */
async function checkQuark(url, password = '') {
  const m = url.match(/pan\.quark\.cn\/(?:s|g)\/([A-Za-z0-9_-]+)/i);
  if (!m) return { state: 'unknown', message: '无法解析分享ID' };
  const pwdId = m[1];
  const pwd = password || extractPasswordFromUrl(url);

  const res = await httpFetch('https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc', {
    method: 'POST',
    timeoutMs: 6500,
    headers: {
      'content-type': 'application/json',
      origin: 'https://pan.quark.cn',
      referer: 'https://pan.quark.cn/'
    },
    body: JSON.stringify({
      pwd_id: pwdId,
      passcode: pwd || '',
      support_visit_limit_private_share: true
    })
  });

  const json = await res.json();
  const code = Number(json?.code);
  const msg = String(json?.message || '');

  if (code === 0 && json?.data?.stoken) {
    return {
      state: 'valid',
      message: '链接有效',
      shareTitle: String(json?.data?.title || '').trim()
    };
  }
  if (code === 41008 || /提取码|密码/.test(msg)) {
    return { state: 'locked', message: '有效(需提取码)' };
  }
  if ([41004, 41010, 41011].includes(code) || /不存在|失效|违规|过期|取消/.test(msg)) {
    return { state: 'invalid', message: msg || '链接已失效' };
  }
  return { state: 'unknown', message: msg || '状态未知' };
}

/**
 * 2. 阿里云盘存活检测 + 真实分享名透视
 */
async function checkAliyun(url) {
  const m = url.match(/(?:alipan\.com|aliyundrive\.com)\/s\/([A-Za-z0-9_-]+)/i);
  if (!m) return { state: 'unknown', message: '无法解析分享ID' };
  const shareId = m[1];

  const res = await httpFetch(
    `https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous?share_id=${encodeURIComponent(shareId)}`,
    {
      method: 'POST',
      timeoutMs: 6500,
      headers: {
        'content-type': 'application/json',
        origin: 'https://www.alipan.com',
        referer: 'https://www.alipan.com/',
        'x-canary': 'client=web,app=share,version=v2.3.1'
      },
      body: JSON.stringify({ share_id: shareId })
    }
  );

  const json = await res.json();
  const code = String(json?.code || '').toLowerCase();
  if (code.includes('sharelink') || /notfound|cancel|forbidden|expired/.test(code)) {
    return { state: 'invalid', message: json?.message || '链接已失效' };
  }
  if (res.status === 200 && (json?.share_name || json?.share_title || Number(json?.file_count) > 0)) {
    const shareTitle = String(
      json?.share_name || json?.share_title || json?.file_infos?.[0]?.file_name || ''
    ).trim();
    return {
      state: 'valid',
      message: '链接有效',
      shareTitle
    };
  }
  return { state: 'unknown', message: json?.message || '无法确认' };
}

/**
 * 3. 百度网盘存活检测 + 真实文件名透视
 */
async function checkBaidu(url) {
  const m = url.match(/baidu\.com\/s\/1([A-Za-z0-9_-]+)/i) || url.match(/baidu\.com\/s\/([A-Za-z0-9_-]+)/i);
  if (!m) return { state: 'unknown', message: '无法解析短链' };
  const shortUrl = m[1];
  const listUrl = `https://pan.baidu.com/share/list?web=1&page=1&num=5&order=time&desc=1&showempty=0&shorturl=${encodeURIComponent(shortUrl)}&root=1&clienttype=0`;

  const res = await httpFetch(listUrl, {
    timeoutMs: 6000,
    headers: { referer: url }
  });
  const json = await res.json();
  const errno = Number(json?.errno);
  if (errno === 0) {
    if (Array.isArray(json?.list) && json.list.length > 0) {
      const first = json.list[0];
      return {
        state: 'valid',
        message: '链接有效',
        shareTitle: String(json?.title || first?.server_filename || '').trim(),
        fileSize: formatBytes(first?.size)
      };
    }
    return { state: 'invalid', message: '文件已失效' };
  }
  if (errno === -9 || errno === -12 || json?.errmsg === 'need verify') {
    const hasPwd = Boolean(extractPasswordFromUrl(url));
    return {
      state: hasPwd ? 'valid' : 'locked',
      message: hasPwd ? '链接有效' : '有效(需提取码)'
    };
  }
  if ([-7, 105, 115, 117, 145].includes(errno)) {
    return { state: 'invalid', message: '链接已失效' };
  }
  return { state: 'unknown', message: json?.errmsg || '未知状态' };
}

/**
 * 4. 天翼云盘存活检测 + 真实文件名透视
 */
async function checkTianyi(url) {
  let shareCode = '';
  const m1 = url.match(/cloud\.189\.cn\/t\/([A-Za-z0-9_-]+)/i);
  if (m1) shareCode = m1[1];
  else {
    try {
      shareCode = new URL(url).searchParams.get('code') || '';
    } catch {
      // ignore
    }
  }
  if (!shareCode) return { state: 'unknown', message: '无法解析分享码' };

  const api = `https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?shareCode=${encodeURIComponent(shareCode)}`;
  const res = await httpFetch(api, {
    timeoutMs: 6500,
    headers: {
      accept: 'application/json;charset=UTF-8',
      referer: url
    }
  });
  const json = await res.json();
  if (json?.res_code === 0 && json?.shareId) {
    return {
      state: 'valid',
      message: '链接有效',
      shareTitle: String(json?.fileName || '').trim(),
      fileSize: formatBytes(json?.fileSize)
    };
  }
  const msg = String(json?.res_message || '');
  if (/取消|不存在|过期|失效|删除/.test(msg)) {
    return { state: 'invalid', message: msg };
  }
  return { state: 'unknown', message: msg || '未知状态' };
}

/**
 * 5. 115网盘存活检测 + 真实文件名与体积透视
 */
async function check115(url, password = '') {
  const m = url.match(/(?:115\.com|115cdn\.com|anxia\.com)\/s\/([A-Za-z0-9_-]+)/i);
  if (!m) return { state: 'unknown', message: '无法解析分享码' };
  const shareCode = m[1];
  const pwd = password || extractPasswordFromUrl(url);

  const api = `https://webapi.115.com/share/snap?share_code=${encodeURIComponent(shareCode)}&receive_code=${encodeURIComponent(pwd || '')}&offset=0&limit=1`;
  const res = await httpFetch(api, {
    timeoutMs: 6000,
    headers: { referer: url }
  });
  const json = await res.json();

  if (json?.state === true && json?.data?.shareinfo) {
    const info = json.data.shareinfo;
    return {
      state: 'valid',
      message: '链接有效',
      shareTitle: String(info.share_title || '').trim(),
      fileSize: formatBytes(info.file_size)
    };
  }
  const errText = String(json?.error || '');
  if (json?.errno === 4100012 || /访问码|提取码|密码/.test(errText)) {
    return { state: 'locked', message: '有效(需提取码)' };
  }
  if (/取消|失效|不存在|删除|过期|违规/.test(errText) || [4100008, 4100009, 4100010, 4100013].includes(Number(json?.errno))) {
    return { state: 'invalid', message: errText || '链接已失效' };
  }
  return { state: 'unknown', message: errText || '未知状态' };
}

/**
 * 6. UC / 123 / 迅雷 网页状态检测
 */
async function checkGenericWeb(url) {
  const res = await httpFetch(url, {
    timeoutMs: 6000,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36'
    }
  });
  if (res.status === 404 || res.status === 410) {
    return { state: 'invalid', message: '页面不存在' };
  }
  const html = (await res.text()).slice(0, 35000);
  if (/已失效|不存在|被取消|已过期|违规|已被删除|分享已取消/.test(html)) {
    return { state: 'invalid', message: '链接已失效' };
  }
  if (/提取码|访问码|请输入密码/.test(html)) {
    return { state: 'locked', message: '有效(需提取码)' };
  }
  if (res.status === 200) {
    return { state: 'valid', message: '链接有效' };
  }
  return { state: 'unknown', message: `HTTP ${res.status}` };
}

export async function checkSingleLink(item) {
  const url = cleanShareUrl(item?.url || '');
  if (!url) return { url: '', state: 'unknown', message: '空链接' };

  const cached = getCachedState(url);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  const diskType = detectDriveType(url, item?.disk_type || item?.type);
  const password = item?.password || extractPasswordFromUrl(url);

  let outcome = { state: 'unknown', message: '暂不支持检测' };
  try {
    if (diskType === 'quark') outcome = await checkQuark(url, password);
    else if (diskType === 'aliyun') outcome = await checkAliyun(url);
    else if (diskType === 'baidu') outcome = await checkBaidu(url);
    else if (diskType === 'tianyi') outcome = await checkTianyi(url);
    else if (diskType === '115') outcome = await check115(url, password);
    else if (['uc', '123', 'xunlei'].includes(diskType)) outcome = await checkGenericWeb(url);
  } catch (err) {
    outcome = { state: 'unknown', message: err.message };
  }

  const finalResult = {
    url,
    disk_type: diskType,
    state: outcome.state,
    message: outcome.message,
    shareTitle: outcome.shareTitle || '',
    fileSize: outcome.fileSize || ''
  };
  if (outcome.state === 'valid' || outcome.state === 'locked' || outcome.state === 'invalid') {
    setCachedState(url, finalResult);
  }
  return finalResult;
}

export async function checkBatchLinks(items = []) {
  const slice = Array.isArray(items) ? items.slice(0, 25) : [];
  const results = await Promise.all(slice.map(it => checkSingleLink(it)));
  return { results };
}
