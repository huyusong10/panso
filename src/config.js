import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_TG_CHANNELS = [
  'clouddriveresources',
  'dedao2019',
  'seedhub_pro',
  'WFYSFX03',
  'rbzhwpzy',
  'shumozy',
  'tgsearchers7',
  'yy80986098',
  'wpan8',
  'kuyupan',
  'youxigs',
  'alyp_17362',
  'aliyungaoqingshipin',
  'syrjfx_sl',
  'quark_tv',
  'jdbigdiscount',
  'tgbokee',
  'rjyxfx',
  'leoziyuan',
  'XunLeiPinDao',
  'yingshiziyuanpindao',
  'peccxinpd',
  'gimy115',
  'yunpan139',
  'quanwangzy',
  'chxyy2019',
  'xhzpj',
  'phzvip',
  'qianxingba1',
  'douerpan',
  'xx123pan',
  'TG654TG',
  'lihaiCloud',
  'QuarkFree',
  'shareAliyun',
  'zyzhpd123',
  'kkwpzy',
  'jpnd5',
  'xuexiziliaobaibaoku',
  'yunpanx',
  'fuliziyuan'
];

export const AVAILABLE_PLUGINS = [
  { id: 'xiaokupan', name: '小酷盘 (XiaoKuPan)', desc: '超大规模多网盘聚合库，单次命中率极高，国内直连', defaultEnabled: true },
  { id: 'melost', name: '影盘社 (Melost)', desc: '全网主流网盘综合大库，响应极快，国内直连', defaultEnabled: true },
  { id: 'ikantv', name: '爱看资源 (IkanTV)', desc: '高清剧集、动漫、小说综合网盘索引，国内直连', defaultEnabled: true },
  { id: 'yunso', name: '小云搜索 (YunSo)', desc: '老牌网盘搜索引擎，覆盖百度/夸克/阿里/迅雷', defaultEnabled: true },
  { id: 'yingso', name: '影搜 (YingSo)', desc: '专精蓝光原盘、4K、热门院线与剧集分享源', defaultEnabled: true },
  { id: 'aipan', name: '爱盼影视 (AiPan)', desc: '电影与剧集精编网盘库，带豆瓣/IMDB评分简介', defaultEnabled: true },
  { id: '488run', name: '夸搜盘 (488.run)', desc: '夸克/百度/迅雷实时热播资源聚合索引', defaultEnabled: true },
  { id: 'quarksoo', name: '夸克搜 (QuarkSoo)', desc: '专注夸克网盘影视、短剧与动漫资源直采', defaultEnabled: true },
  { id: 'erxiaopan', name: '二小盘 (2XiaoPan)', desc: '热门影视与综艺多网盘分享源', defaultEnabled: true },
  { id: 'mipan_relay', name: '聚合加速源 (Mipan Relay)', desc: '并发拉取上游聚合索引（自动剔除推广），补齐冷门源', defaultEnabled: true }
];

export const DEFAULT_CONFIG = {
  port: Number(process.env.PORT) || 3200,
  host: process.env.HOST || '0.0.0.0',
  proxy: process.env.PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
  enableTelegram: true,
  tgConcurrency: 24,
  tgTimeoutMs: 3600,
  pluginTimeoutMs: 7500,
  cacheTtlMinutes: 30,
  hideAdsAndOwn: true,
  channels: DEFAULT_TG_CHANNELS,
  enabledPlugins: AVAILABLE_PLUGINS.filter(p => p.defaultEnabled).map(p => p.id),
  hotWords: ['凡人修仙传', '仙逆', '奥德赛', '牧神记', '现在就出发', '庆余年', '沙丘', '剑来']
};

let currentConfig = null;

export function loadConfig() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      // 自动合并新版本增加的默认插件
      const savedPlugins = Array.isArray(parsed.enabledPlugins) ? parsed.enabledPlugins : DEFAULT_CONFIG.enabledPlugins;
      const mergedPlugins = Array.from(new Set([...savedPlugins, ...DEFAULT_CONFIG.enabledPlugins]));
      currentConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        channels: Array.isArray(parsed.channels) ? parsed.channels : DEFAULT_CONFIG.channels,
        enabledPlugins: mergedPlugins
      };
      return currentConfig;
    }
  } catch (err) {
    console.warn('[Config] 读取配置文件失败，使用默认配置:', err.message);
  }
  currentConfig = { ...DEFAULT_CONFIG };
  saveConfig(currentConfig);
  return currentConfig;
}

export function getConfig() {
  if (!currentConfig) return loadConfig();
  return currentConfig;
}

export function saveConfig(partial) {
  const next = {
    ...(currentConfig || DEFAULT_CONFIG),
    ...partial
  };
  if (typeof next.channels === 'string') {
    next.channels = next.channels
      .split(/[\s,，;；\n]+/)
      .map(s => s.trim().replace(/^@/, ''))
      .filter(Boolean);
  }
  currentConfig = next;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Config] 保存配置失败:', err.message);
  }
  return currentConfig;
}
