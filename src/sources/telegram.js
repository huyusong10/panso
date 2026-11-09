import * as cheerio from 'cheerio';
import { getConfig } from '../config.js';
import { fetchText } from '../utils/http.js';
import {
  attachPasswordToUrl,
  cleanShareUrl,
  detectDriveType,
  extractCleanTitle,
  extractLinksFromText,
  extractNearbyPassword,
  normalizeLinkKey
} from '../utils/parser.js';

const channelTelemetry = new Map();

function ensureChStat(ch) {
  if (!channelTelemetry.has(ch)) {
    channelTelemetry.set(ch, {
      channel: ch,
      runs: 0,
      hits: 0,
      fails: 0,
      totalItems: 0,
      noPreview: false
    });
  }
  return channelTelemetry.get(ch);
}

export function getTgChannelHealth(configuredChannels = []) {
  const list = [];
  const deadCandidates = [];
  for (const raw of configuredChannels) {
    const ch = String(raw).trim().replace(/^@/, '');
    if (!ch) continue;
    const st = channelTelemetry.get(ch) || { channel: ch, runs: 0, hits: 0, fails: 0, totalItems: 0, noPreview: false };
    const isDead = st.noPreview || (st.runs >= 2 && st.hits === 0 && st.fails >= 1) || (st.runs >= 3 && st.hits === 0);
    if (isDead) deadCandidates.push(ch);
    list.push({ ...st, isDead });
  }
  return {
    channels: list,
    deadCandidates
  };
}

/**
 * 抓取单个 Telegram 公开频道的网页预览搜索页
 * URL: https://t.me/s/<channel>?q=<keyword>
 */
export async function searchSingleTgChannel(channel, keyword, timeoutMs = 5500) {
  const cleanChannel = String(channel).trim().replace(/^@/, '');
  if (!cleanChannel || !keyword) return [];

  const stat = ensureChStat(cleanChannel);
  stat.runs++;

  const searchUrl = `https://t.me/s/${encodeURIComponent(cleanChannel)}?q=${encodeURIComponent(keyword)}`;
  const useProxy = Boolean((getConfig().proxy || '').trim());

  let html = '';
  try {
    html = await fetchText(searchUrl, {
      timeoutMs,
      useProxy,
      headers: {
        referer: `https://t.me/s/${cleanChannel}`
      }
    });
  } catch (err) {
    // 若配置了代理但失败，尝试直连兜底；反之亦然
    if (useProxy) {
      try {
        html = await fetchText(searchUrl, { timeoutMs: 3500, useProxy: false });
      } catch {
        stat.fails++;
        return [];
      }
    } else {
      stat.fails++;
      return [];
    }
  }

  if (html && !html.includes('tgme_channel_info') && !html.includes('tgme_widget_message_wrap')) {
    stat.noPreview = true;
  }

  const parsed = parseTgChannelHtml(html, cleanChannel, keyword);
  if (parsed.length > 0) {
    stat.hits++;
    stat.totalItems += parsed.length;
    stat.noPreview = false;
  }
  return parsed;
}

export function parseTgChannelHtml(html, channel, keyword) {
  if (!html || !html.includes('tgme_widget_message_wrap')) {
    return [];
  }

  const $ = cheerio.load(html);
  const items = [];

  $('.tgme_widget_message_wrap').each((_, wrap) => {
    const msgEl = $(wrap).find('.tgme_widget_message');
    const dataPost = msgEl.attr('data-post') || '';
    const msgId = dataPost.split('/')[1] || '';
    const datetime =
      msgEl.find('.tgme_widget_message_date time').attr('datetime') || '';

    const textEl = msgEl.find('.tgme_widget_message_text');
    if (!textEl.length) return;

    // 将 <br> 替换为换行符以保留行结构
    const htmlWithNewlines = (textEl.html() || '').replace(/<br\s*\/?>/gi, '\n');
    const $frag = cheerio.load(`<div>${htmlWithNewlines}</div>`);
    const textWithBreaks = $frag('div').text().trim();

    if (!textWithBreaks) return;

    // 校验消息内容是否包含搜索关键词（避免频道无匹配时返回无关置顶消息）
    const kwLower = String(keyword || '').trim().toLowerCase();
    if (kwLower && !textWithBreaks.toLowerCase().includes(kwLower)) {
      const tokens = kwLower.split(/\s+/).filter(Boolean);
      if (tokens.length > 0 && !tokens.some(t => textWithBreaks.toLowerCase().includes(t))) {
        return;
      }
    }

    const title = extractCleanTitle(textWithBreaks, keyword);

    // 按行解析，解决“每日合集推文”中多部剧集共用同一个首行标题的问题
    const lines = textWithBreaks.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const lineTitleForUrl = new Map();
    let currentSectionTitle = title;

    for (const line of lines) {
      const lineLinks = extractLinksFromText(line);
      const strippedLine = line
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/(?:链接|地址|提取码|访问码|密码|pwd|code)\s*[:：=]?\s*[A-Za-z0-9]{0,8}/gi, '')
        .replace(/^[🔥🎬📺📁📌✨▶️•·\-\s]+/, '')
        .trim();

      if (lineLinks.length > 0) {
        if (strippedLine.length >= 2) {
          currentSectionTitle = strippedLine.slice(0, 120);
        }
        for (const l of lineLinks) {
          lineTitleForUrl.set(normalizeLinkKey(l.url), currentSectionTitle);
        }
      } else if (
        strippedLine.length >= 2 &&
        !/^(?:描述|简介|标签|大小|格式|关注|频道|群组|资源|分享)\s*[:：]/i.test(strippedLine)
      ) {
        currentSectionTitle = strippedLine.slice(0, 120);
      }
    }

    // 1. 提取正文中明文匹配的网盘链接
    const linkMap = new Map();
    for (const l of extractLinksFromText(textWithBreaks)) {
      const k = normalizeLinkKey(l.url);
      linkMap.set(k, {
        ...l,
        itemTitle: lineTitleForUrl.get(k) || title
      });
    }

    // 2. 提取 <a href="..."> 隐藏的超链接（如“点击保存夸克网盘”）
    textEl.find('a[href]').each((__, a) => {
      const href = cleanShareUrl($(a).attr('href') || '');
      const type = detectDriveType(href);
      if (type === 'others') return;
      const key = normalizeLinkKey(href);
      if (!linkMap.has(key)) {
        const anchorText = $(a).text().trim();
        const pwd = extractNearbyPassword(href, `${anchorText} ${textWithBreaks}`);
        linkMap.set(key, {
          url: attachPasswordToUrl(href, type, pwd),
          type,
          password: pwd,
          itemTitle: lineTitleForUrl.get(key) || title
        });
      }
    });

    if (linkMap.size === 0) return;

    const briefContent = lines
      .filter(s => s && !/^https?:\/\//i.test(s) && s !== title)
      .slice(0, 3)
      .join(' · ')
      .slice(0, 220);

    for (const link of linkMap.values()) {
      const finalTitle = link.itemTitle || title;
      // 如果一条推文里有多个不同链接且分属不同剧名，过滤掉与搜索词无关的其他剧集链接
      if (linkMap.size > 3 && kwLower && !finalTitle.toLowerCase().includes(kwLower) && !title.toLowerCase().includes(kwLower)) {
        continue;
      }
      items.push({
        unique_id: `tg:${channel}:${msgId}:${normalizeLinkKey(link.url)}`,
        title: finalTitle,
        content: briefContent,
        url: link.url,
        type: link.type,
        password: link.password || '',
        datetime: datetime || '',
        source: `tg:${channel}`
      });
    }
  });

  return items;
}

/**
 * 并发搜索多个 Telegram 频道（带并发池控制，支持流式单频道回调）
 */
export async function searchAllTgChannels(
  keyword,
  channels = [],
  concurrency = 12,
  timeoutMs = 5500,
  onChannelResult = null
) {
  if (!channels.length) return { items: [], stats: { totalChannels: 0, activeChannels: 0, count: 0 } };

  const results = [];
  let activeChannels = 0;
  let index = 0;

  const workerCount = Math.min(Math.max(1, concurrency), channels.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < channels.length) {
      const ch = channels[index++];
      try {
        const list = await searchSingleTgChannel(ch, keyword, timeoutMs);
        if (list.length > 0) {
          activeChannels++;
          results.push(...list);
          if (typeof onChannelResult === 'function') {
            try {
              onChannelResult(ch, list, {
                totalChannels: channels.length,
                activeChannels,
                count: results.length
              });
            } catch {
              // ignore callback error
            }
          }
        }
      } catch {
        // 单频道失败静默忽略，不影响整体
      }
    }
  });

  await Promise.all(workers);

  return {
    items: results,
    stats: {
      totalChannels: channels.length,
      activeChannels,
      count: results.length
    }
  };
}
