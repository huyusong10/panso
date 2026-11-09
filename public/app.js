(function () {
  'use strict';

  const DRIVE_META = {
    quark:  { label: '夸克', order: 1 },
    baidu:  { label: '百度', order: 2 },
    aliyun: { label: '阿里', order: 3 },
    uc:     { label: 'UC',   order: 4 },
    tianyi: { label: '天翼', order: 5 },
    '115':  { label: '115',  order: 6 },
    xunlei: { label: '迅雷', order: 7 },
    '123':  { label: '123盘', order: 8 },
    mobile: { label: '移动', order: 9 },
    pikpak: { label: 'PikPak', order: 10 },
    others: { label: '其他', order: 99 }
  };

  const state = {
    kw: '',
    loading: false,
    error: null,
    results: [],
    meta: null,
    activeDrive: 'all',
    sourceFilter: 'all',
    exactSourceFilter: '',
    specFilter: '',
    subFilter: '',
    sortBy: 'score',
    foldMultiDrive: true,
    hideDead: false,
    page: 1,
    perPage: 20,
    linkStates: new Map(),
    checkAbort: null,
    searchAbort: null,
    eventSource: null,
    streaming: false,
    hotWords: ['凡人修仙传', '仙逆', '奥德赛', '牧神记', '现在就出发', '庆余年', '沙丘', '剑来'],
    viewMode: 'wall',
    wallChannels: [
      { id: 'hot_tv',     label: '热播剧集' },
      { id: 'hot_movie',  label: '热门电影' },
      { id: 'top_movie',  label: '豆瓣高分' },
      { id: 'cn_tv',      label: '国产剧' },
      { id: 'anime',      label: '动漫番剧' },
      { id: 'us_tv',      label: '美剧' },
      { id: 'kr_tv',      label: '日韩剧' },
      { id: 'variety',    label: '热门综艺' },
      { id: 'doc',        label: '纪录片' },
      { id: 'hidden_gem', label: '冷门佳片' }
    ],
    wallChannel: 'hot_tv',
    wallSort: 'recommend',
    wallFilterKw: '',
    wallItems: [],
    wallSeenTitles: new Set(),
    wallNextStart: 0,
    wallHasMore: true,
    wallLoading: false,
    wallScrollY: 0,
    history: [],
    favorites: [],
    serverConfig: null,
    availablePlugins: [],
    pluginHealth: {},
    tgHealth: { channels: [], deadCandidates: [] },
    runtimeStats: null
  };

  const $ = (id) => document.getElementById(id);

  function loadLocalData() {
    try {
      const h = JSON.parse(localStorage.getItem('pansong_history') || '[]');
      if (Array.isArray(h)) state.history = h.slice(0, 6);
    } catch {}
    try {
      const f = JSON.parse(localStorage.getItem('pansong_favorites') || '[]');
      if (Array.isArray(f)) state.favorites = f;
    } catch {}
    updateFavBadge();
  }

  function saveHistory(kw) {
    if (!kw) return;
    state.history = [kw, ...state.history.filter(x => x !== kw)].slice(0, 6);
    try { localStorage.setItem('pansong_history', JSON.stringify(state.history)); } catch {}
    renderQuickTags();
  }

  function isFav(url) {
    return state.favorites.some(x => x.url === url);
  }

  function toggleFav(item) {
    const idx = state.favorites.findIndex(x => x.url === item.url);
    if (idx >= 0) {
      state.favorites.splice(idx, 1);
      showToast('已从私藏书签移除');
    } else {
      state.favorites.unshift({
        url: item.url,
        title: item.title,
        type: item.type,
        password: item.password || '',
        source: item.source || '',
        datetime: item.datetime || '',
        specs: item.specs || []
      });
      showToast('已收入私藏书签');
    }
    try { localStorage.setItem('pansong_favorites', JSON.stringify(state.favorites)); } catch {}
    updateFavBadge();
  }

  function updateFavBadge() {
    const el = $('favCountBadge');
    if (el) el.textContent = String(state.favorites.length);
  }

  function initTheme() {
    const btn = $('themeToggleBtn');
    const text = $('themeText');
    function syncUI() {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (text) text.textContent = dark ? '松烟' : '宣纸';
    }
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('pansong_theme', next); } catch {}
      syncUI();
    });
    syncUI();
  }

  function showToast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function highlightKeyword(text, kw) {
    const safe = escapeHtml(text);
    if (!kw) return safe;
    try {
      const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return safe.replace(new RegExp(`(${escapedKw})`, 'gi'), '<mark>$1</mark>');
    } catch {
      return safe;
    }
  }

  function formatDate(d) {
    if (!d) return '';
    const ts = Date.parse(d);
    if (Number.isNaN(ts) || String(d).startsWith('0001')) return '';
    const dt = new Date(ts);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatUptime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const remS = s % 60;
    if (d > 0) return `${d}天 ${h}小时 ${m}分`;
    if (h > 0) return `${h}小时 ${m}分 ${remS}秒`;
    if (m > 0) return `${m}分 ${remS}秒`;
    return `${remS}秒`;
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function renderQuickTags() {
    const row = $('quickTagsRow');
    if (!row) return;
    let html = '';
    if (state.history.length > 0) {
      html += `<span class="quick-label">近寻：</span>`;
      html += state.history
        .map(w => `<button type="button" class="quick-tag" data-kw="${escapeHtml(w)}">${escapeHtml(w)}</button>`)
        .join('');
    }
    html += `<span class="quick-label">常阅：</span>`;
    html += state.hotWords
      .map(w => `<button type="button" class="quick-tag" data-kw="${escapeHtml(w)}">${escapeHtml(w)}</button>`)
      .join('');

    row.innerHTML = html;
    row.querySelectorAll('.quick-tag[data-kw]').forEach(btn => {
      btn.addEventListener('click', () => {
        const w = btn.dataset.kw;
        $('kwInput').value = w;
        syncSearchBoxClass();
        doSearch(w);
      });
    });
  }

  function updateWallSummary() {
    const summaryEl = $('wallSummaryText');
    if (!summaryEl) return;
    const chObj = state.wallChannels.find(c => c.id === state.wallChannel) || state.wallChannels[0];
    const sortMap = { recommend: '按热度推荐', time: '按最新上映', rank: '按豆瓣高分' };
    const filterKw = state.wallFilterKw.trim();
    if (filterKw) {
      summaryEl.innerHTML = `当前分类：<b>${escapeHtml(chObj?.label || '热播')}</b> · 墙内筛选「<b>${escapeHtml(filterKw)}</b>」`;
    } else {
      summaryEl.innerHTML = `当前分类：<b>${escapeHtml(chObj?.label || '热播')}</b>（${sortMap[state.wallSort] || '推荐'} · 已展卷 <b>${state.wallItems.length}</b> 部佳作）`;
    }
  }

  function applyWallFilter() {
    const gridEl = $('posterGrid');
    if (!gridEl) return;
    const kw = state.wallFilterKw.trim().toLowerCase();
    gridEl.querySelectorAll('.poster-card').forEach(card => {
      const title = (card.dataset.kw || '').toLowerCase();
      card.hidden = Boolean(kw && !title.includes(kw));
    });
    updateWallSummary();
  }

  function renderWallChannels() {
    const tabsEl = $('wallChannelTabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = state.wallChannels
      .map(
        c =>
          `<button type="button" class="wall-tab ${c.id === state.wallChannel ? 'active' : ''}" data-channel="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>`
      )
      .join('');

    tabsEl.querySelectorAll('.wall-tab[data-channel]').forEach(btn => {
      btn.addEventListener('click', () => {
        const ch = btn.dataset.channel;
        if (ch === state.wallChannel && state.wallItems.length > 0) return;
        state.wallChannel = ch;
        renderWallChannels();
        loadWallPage(true);
      });
    });

    document.querySelectorAll('#wallSortTabs .sort-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === state.wallSort);
    });
    updateWallSummary();
  }

  function renderPosterSkeletons(count = 12) {
    return Array.from({ length: count })
      .map(
        () => `
        <div class="poster-skeleton">
          <div class="poster-skel-box"></div>
          <div class="poster-skel-line"></div>
          <div class="poster-skel-line short"></div>
        </div>
      `
      )
      .join('');
  }

  function createPosterCardElement(it, idx) {
    const card = document.createElement('article');
    card.className = 'poster-card';
    card.dataset.kw = it.title;
    card.style.animationDelay = `${Math.min(idx * 18, 220)}ms`;
    const firstChar = String(it.title || '影').slice(0, 1);
    const subLabel = it.rate ? `豆瓣 ${it.rate}` : (it.note || '精选佳作');

    card.innerHTML = `
      <div class="poster-frame">
        ${
          it.cover
            ? `<img class="poster-img" src="${escapeHtml(it.cover)}" alt="${escapeHtml(it.title)}" loading="lazy" decoding="async" />`
            : ''
        }
        <div class="poster-fallback" ${it.cover ? 'hidden' : ''}>
          <span class="poster-fallback-char">${escapeHtml(firstChar)}</span>
          <div class="poster-fallback-title">${escapeHtml(it.title)}</div>
        </div>
        <div class="poster-badges">
          ${it.isNew ? `<span class="poster-badge-new">新</span>` : `<span></span>`}
          ${it.rate ? `<span class="poster-badge-rate">★ ${escapeHtml(it.rate)}</span>` : ''}
        </div>
        <div class="poster-bottom-shade">
          <span class="poster-ep">${escapeHtml(it.note || '')}</span>
          <span class="poster-cta">寻盘 ↗</span>
        </div>
      </div>
      <div class="poster-title-row">
        <div class="poster-title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</div>
        ${
          it.doubanUrl
            ? `<a class="poster-douban-link js-douban-ext" href="${escapeHtml(it.doubanUrl)}" target="_blank" rel="noopener noreferrer" title="在豆瓣查看简介与演职员">豆瓣 ↗</a>`
            : ''
        }
      </div>
      <div class="poster-sub">${escapeHtml(subLabel)}</div>
    `;

    const img = card.querySelector('.poster-img');
    const fb = card.querySelector('.poster-fallback');
    if (img) {
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('is-loaded');
      } else {
        img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
      }
      img.addEventListener(
        'error',
        () => {
          img.hidden = true;
          if (fb) fb.hidden = false;
        },
        { once: true }
      );
    }

    const extLink = card.querySelector('.js-douban-ext');
    if (extLink) {
      extLink.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    card.addEventListener('click', () => {
      const w = card.dataset.kw;
      $('kwInput').value = w;
      syncSearchBoxClass();
      doSearch(w);
    });

    const filterKw = state.wallFilterKw.trim().toLowerCase();
    if (filterKw && !String(it.title).toLowerCase().includes(filterKw)) {
      card.hidden = true;
    }

    return card;
  }

  async function loadWallPage(reset = false) {
    if (state.wallLoading && !reset) return;
    if (!reset && !state.wallHasMore) return;

    const gridEl = $('posterGrid');
    const moreBtn = $('loadMorePostersBtn');
    if (!gridEl) return;

    if (reset) {
      state.wallNextStart = 0;
      state.wallHasMore = true;
      state.wallItems = [];
      state.wallSeenTitles = new Set();
      gridEl.innerHTML = renderPosterSkeletons(12);
      updateWallSummary();
    }

    state.wallLoading = true;
    if (moreBtn) {
      moreBtn.disabled = true;
      moreBtn.textContent = '正在加载更多佳作…';
    }

    const reqChannel = state.wallChannel;
    const reqSort = state.wallSort;
    const reqStart = state.wallNextStart;

    try {
      const url = `/api/explore?channel=${encodeURIComponent(reqChannel)}&sort=${encodeURIComponent(reqSort)}&start=${reqStart}&limit=24`;
      const res = await fetch(url);
      const json = await res.json();
      if (reqChannel !== state.wallChannel || reqSort !== state.wallSort) {
        return;
      }

      if (json.code === 0 && json.data) {
        if (Array.isArray(json.data.channels) && json.data.channels.length) {
          state.wallChannels = json.data.channels;
          renderWallChannels();
        }
        const incoming = Array.isArray(json.data.items) ? json.data.items : [];
        if (reset) {
          gridEl.innerHTML = '';
        }

        const frag = document.createDocumentFragment();
        let added = 0;
        for (const it of incoming) {
          if (!it || !it.title || state.wallSeenTitles.has(it.title)) continue;
          state.wallSeenTitles.add(it.title);
          state.wallItems.push(it);
          frag.appendChild(createPosterCardElement(it, added));
          added++;
        }
        gridEl.appendChild(frag);

        state.wallNextStart = typeof json.data.nextStart === 'number'
          ? json.data.nextStart
          : reqStart + incoming.length;
        state.wallHasMore = Boolean(json.data.hasMore) && incoming.length > 0;
        updateWallSummary();
      } else if (reset) {
        gridEl.innerHTML = `<div class="empty-stage" style="grid-column:1/-1">暂时无法获取海报墙数据，请稍后重试</div>`;
      }
    } catch {
      if (reset && !state.wallItems.length) {
        gridEl.innerHTML = `<div class="empty-stage" style="grid-column:1/-1">海报墙加载异常，点击下方按钮重试</div>`;
      }
    } finally {
      state.wallLoading = false;
      if (moreBtn) {
        moreBtn.disabled = !state.wallHasMore;
        moreBtn.textContent = state.wallHasMore
          ? '向下滚动或点击加载更多佳作…'
          : '已展示该分类下全部精选佳作';
      }
    }
  }

  function setupWallInfiniteScroll() {
    const sentinel = $('wallSentinel');
    if (!sentinel || typeof window.IntersectionObserver !== 'function') return;

    const io = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            state.viewMode === 'wall' &&
            !state.wallLoading &&
            state.wallHasMore &&
            state.wallItems.length > 0 &&
            !state.wallFilterKw.trim()
          ) {
            loadWallPage(false);
          }
        }
      },
      { rootMargin: '480px 0px' }
    );
    io.observe(sentinel);
  }

  function enterSearchView(kw) {
    if (state.viewMode === 'wall') {
      state.wallScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    }
    state.viewMode = 'search';
    const wallStage = $('posterWallStage');
    const searchStage = $('searchResultsStage');
    const banner = $('currentQueryBanner');
    if (wallStage) wallStage.hidden = true;
    if (searchStage) searchStage.hidden = false;
    if (banner) {
      banner.innerHTML = `正在寻访：<b>${escapeHtml(kw)}</b>`;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function backToWall() {
    stopActiveStream();
    state.viewMode = 'wall';
    state.kw = '';
    state.results = [];
    state.error = null;
    state.loading = false;
    state.streaming = false;
    $('searchSubmitBtn').disabled = false;
    $('kwInput').value = '';
    syncSearchBoxClass();

    const wallStage = $('posterWallStage');
    const searchStage = $('searchResultsStage');
    if (searchStage) searchStage.hidden = true;
    if (wallStage) wallStage.hidden = false;

    const u = new URL(location.href);
    u.searchParams.delete('q');
    history.replaceState(null, '', u.pathname);

    if (!state.wallItems.length && !state.wallLoading) {
      loadWallPage(true);
    }

    requestAnimationFrame(() => {
      window.scrollTo({ top: state.wallScrollY || 0, behavior: 'instant' });
    });
  }

  function syncSearchBoxClass() {
    const v = $('kwInput').value;
    $('searchForm').classList.toggle('has-text', Boolean(v));
  }

  function matchesSpecFilter(item, specFilter) {
    if (!specFilter) return true;
    const combined = `${item.title || ''} ${item.content || ''}`;
    if (specFilter === '4K') return /\b(?:4k|2160p|uhd)\b/i.test(combined);
    if (specFilter === '杜比') return /(?:杜比|dolby|\bdv\b|\bhdr)/i.test(combined);
    if (specFilter === '全集') return /(?:全集|完结|\d+\s*集全|全\s*\d+\s*集)/i.test(combined);
    return true;
  }

  function getFilteredItems() {
    let list = state.results.slice();

    if (state.exactSourceFilter) {
      if (state.exactSourceFilter === 'tg:') {
        list = list.filter(x => String(x.source || '').startsWith('tg:'));
      } else {
        list = list.filter(x => String(x.source || '') === state.exactSourceFilter);
      }
    } else if (state.sourceFilter === 'tg') {
      list = list.filter(x => String(x.source || '').startsWith('tg:'));
    } else if (state.sourceFilter === 'plugin') {
      list = list.filter(x => !String(x.source || '').startsWith('tg:'));
    }

    if (state.specFilter) {
      list = list.filter(x => matchesSpecFilter(x, state.specFilter));
    }

    const sub = state.subFilter.trim().toLowerCase();
    if (sub) {
      list = list.filter(x =>
        (x.title || '').toLowerCase().includes(sub) ||
        (x.content || '').toLowerCase().includes(sub) ||
        (x.source || '').toLowerCase().includes(sub)
      );
    }

    if (state.hideDead) {
      list = list.filter(x => {
        const st = state.linkStates.get(x.url);
        return !st || st.state !== 'invalid';
      });
    }

    return list;
  }

  /**
   * 将同一帖或完全同名剧集下的不同网盘链接折叠进主条目，避免刷屏
   */
  function foldMultiDriveItems(items) {
    if (!state.foldMultiDrive || state.activeDrive !== 'all') {
      return items.map(it => ({ ...it, siblings: [] }));
    }

    const groups = new Map();
    const out = [];

    for (const item of items) {
      const cleanTitleKey = String(item.title || '')
        .toLowerCase()
        .replace(/(?:夸克|百度|阿里|迅雷|天翼|115|uc|网盘|云盘)/g, '')
        .replace(/[\s·•\-_【】\[\]()（）《》:：]+/g, '');

      const groupKey =
        cleanTitleKey.length >= 6
          ? `t:${cleanTitleKey}`
          : `${item.source}|${cleanTitleKey}`;

      if (!groups.has(groupKey)) {
        const cloned = { ...item, siblings: [] };
        groups.set(groupKey, cloned);
        out.push(cloned);
      } else {
        const primary = groups.get(groupKey);
        const hasType =
          primary.type === item.type ||
          primary.siblings.some(s => s.type === item.type);
        if (!hasType && primary.siblings.length < 5) {
          primary.siblings.push(item);
        } else if (!hasType) {
          out.push({ ...item, siblings: [] });
        }
      }
    }

    return out;
  }

  function getDriveFilteredItems(baseList) {
    const list = baseList || getFilteredItems();
    const filtered = state.activeDrive === 'all'
      ? list.slice()
      : list.filter(x => x.type === state.activeDrive);

    if (state.sortBy === 'date') {
      filtered.sort((a, b) => (Date.parse(b.datetime) || 0) - (Date.parse(a.datetime) || 0));
    } else if (state.sortBy === 'alive') {
      const rank = (u) => {
        const s = state.linkStates.get(u)?.state;
        if (s === 'valid' || s === 'locked') return 0;
        if (!s || s === 'checking' || s === 'unknown') return 1;
        return 2;
      };
      filtered.sort((a, b) => rank(a.url) - rank(b.url) || (b._score || 0) - (a._score || 0));
    } else {
      filtered.sort((a, b) => (b._score || 0) - (a._score || 0));
    }

    return foldMultiDriveItems(filtered);
  }

  function renderDriveFilters(baseList) {
    const matrixBar = $('matrixBar');
    const el = $('driveFilters');
    if (!state.results.length && state.loading) {
      matrixBar.hidden = true;
      return;
    }
    if (!state.kw) {
      matrixBar.hidden = true;
      return;
    }
    matrixBar.hidden = false;

    const counts = {};
    for (const it of baseList) {
      counts[it.type] = (counts[it.type] || 0) + 1;
    }

    const types = Object.keys(counts).sort((a, b) => {
      const oa = DRIVE_META[a]?.order || 99;
      const ob = DRIVE_META[b]?.order || 99;
      return oa - ob;
    });

    const tabs = [
      `<button type="button" class="drive-tab ${state.activeDrive === 'all' ? 'active' : ''}" data-drive="all">
        <span>全部</span>
        <span class="cnt">${baseList.length}</span>
      </button>`
    ];

    for (const t of types) {
      const m = DRIVE_META[t] || DRIVE_META.others;
      tabs.push(
        `<button type="button" class="drive-tab ${state.activeDrive === t ? 'active' : ''}" data-drive="${escapeHtml(t)}">
          <span>${escapeHtml(m.label)}</span>
          <span class="cnt">${counts[t]}</span>
        </button>`
      );
    }

    el.innerHTML = tabs.join('');
    el.querySelectorAll('.drive-tab[data-drive]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeDrive = btn.dataset.drive;
        state.page = 1;
        renderAll();
      });
    });

    document.querySelectorAll('#specQuickChips .spec-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.spec === state.specFilter);
    });
  }

  function renderStreamProgress() {
    const track = $('streamProgressTrack');
    const bar = $('streamProgressBar');
    if (!track || !bar) return;
    if (!state.streaming) {
      track.hidden = true;
      return;
    }
    track.hidden = false;
    const done = Number(state.meta?.completedTasks) || 1;
    const total = Math.max(1, Number(state.meta?.totalTasks) || 11);
    const pct = Math.min(96, Math.max(14, Math.round((done / total) * 100)));
    bar.style.width = `${pct}%`;
  }

  function renderTelemetry(driveList) {
    const teleBar = $('telemetryBar');
    renderStreamProgress();

    if (!state.results.length || state.loading) {
      teleBar.hidden = true;
      return;
    }
    teleBar.hidden = false;

    let validCnt = 0;
    let deadCnt = 0;
    for (const v of state.linkStates.values()) {
      if (v.state === 'valid' || v.state === 'locked') validCnt++;
      else if (v.state === 'invalid') deadCnt++;
    }

    const elapsedSec = state.meta?.elapsedMs ? (state.meta.elapsedMs / 1000).toFixed(2) : '0.10';
    const streamBadge = state.streaming
      ? `<span class="tele-item tele-stream">流式汇聚中 (${escapeHtml(state.meta?.progress || '实时')})</span>`
      : '';
    const exactFilterBadge = state.exactSourceFilter
      ? `<button type="button" class="diag-pill active" id="clearExactSourceBtn">单源过滤: ${escapeHtml(state.exactSourceFilter)} ✕</button>`
      : '';

    $('toolbarStats').innerHTML = `
      ${streamBadge}
      <span class="tele-item">共得 <b>${state.results.length}</b> 条</span>
      <span class="tele-item">展示 <b>${driveList.length}</b> 组</span>
      <span class="tele-item">耗时 <b>${elapsedSec}s</b>${state.meta?.cacheHit ? ' · 缓存秒回' : ''}</span>
      ${validCnt || deadCnt ? `<span class="tele-item">实测有效 <b class="tele-ok">${validCnt}</b> · 失效 <b class="tele-bad">${deadCnt}</b></span>` : ''}
      ${exactFilterBadge}
    `;

    const clearBtn = $('clearExactSourceBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        state.exactSourceFilter = '';
        state.page = 1;
        renderAll();
      });
    }

    const parts = [];
    if (state.meta?.tgStats) {
      const tg = state.meta.tgStats;
      const isAct = state.exactSourceFilter === 'tg:';
      parts.push(
        `<button type="button" class="diag-pill ${isAct ? 'active' : ''}" data-src-filter="tg:" title="点击仅看 Telegram 频道结果">TG(${tg.activeChannels}/${tg.totalChannels}): <b>${tg.count}</b></button>`
      );
    }
    if (state.meta?.pluginStats) {
      for (const [pid, st] of Object.entries(state.meta.pluginStats)) {
        const srcKey = `plugin:${pid}`;
        const isAct = state.exactSourceFilter === srcKey;
        const label = st.circuitOpen ? `${pid}[熔断]` : pid;
        parts.push(
          `<button type="button" class="diag-pill ${isAct ? 'active' : ''} ${st.ok ? '' : 'tele-bad'}" data-src-filter="${escapeHtml(srcKey)}" title="点击仅看 ${escapeHtml(pid)} 结果">${escapeHtml(label)}: <b>${st.count}</b></button>`
        );
      }
    }
    const diagEl = $('sourceDiagBar');
    diagEl.innerHTML = parts.join('');
    diagEl.querySelectorAll('.diag-pill[data-src-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.srcFilter;
        state.exactSourceFilter = state.exactSourceFilter === target ? '' : target;
        state.page = 1;
        renderAll();
      });
    });
  }

  function aliveCellHtml(url) {
    const info = state.linkStates.get(url);
    if (!info) {
      return `<span class="st-tag" data-state="checking"><span class="st-dot"></span>检测中</span>`;
    }
    if (info.state === 'valid') {
      return `<span class="st-tag" data-state="valid"><span class="st-dot"></span>有效</span>`;
    }
    if (info.state === 'locked') {
      return `<span class="st-tag" data-state="locked"><span class="st-dot"></span>需提取码</span>`;
    }
    if (info.state === 'invalid') {
      return `<span class="st-tag" data-state="invalid"><span class="st-dot"></span>已失效</span>`;
    }
    return `<span class="st-tag" data-state="unknown"><span class="st-dot"></span>待确认</span>`;
  }

  function realFileHtml(url) {
    const info = state.linkStates.get(url);
    if (!info || !info.shareTitle) return '';
    const sizeText = info.fileSize ? ` · ${info.fileSize}` : '';
    return `<div class="real-file-banner" title="网盘官方接口实测内含文件：${escapeHtml(info.shareTitle + sizeText)}"><span>✓ 实测内含：${escapeHtml(info.shareTitle)}${escapeHtml(sizeText)}</span></div>`;
  }

  function renderRow(item) {
    const m = DRIVE_META[item.type] || DRIVE_META.others;
    const dt = formatDate(item.datetime);
    const saved = isFav(item.url);
    const st = state.linkStates.get(item.url);
    const isDead = st && st.state === 'invalid';
    const specs = Array.isArray(item.specs) ? item.specs : [];
    const siblings = Array.isArray(item.siblings) ? item.siblings : [];

    const specsHtml = specs
      .map(s => `<span class="spec-seal" data-kind="${escapeHtml(s.kind || 'spec')}">${escapeHtml(s.label)}</span>`)
      .join('');

    const siblingsHtml = siblings.length
      ? `<div class="sibling-drives">
          <span class="sib-label">同源多盘直达：</span>
          ${siblings
            .map(sib => {
              const sm = DRIVE_META[sib.type] || DRIVE_META.others;
              return `<a class="sib-pill js-smart-open" href="${escapeHtml(sib.url)}" target="_blank" rel="noopener noreferrer" data-pwd="${escapeHtml(sib.password || '')}" title="点击直达 ${escapeHtml(sm.label)}网盘（自动复制提取码）">+ ${escapeHtml(sm.label)}${sib.password ? ` (${escapeHtml(sib.password)})` : ''} ↗</a>`;
            })
            .join('')}
        </div>`
      : '';

    return `
      <article class="row-item ${isDead ? 'is-dead' : ''}" data-card-url="${escapeHtml(item.url)}">
        <div class="cell-left">
          <span class="drive-tag" data-drive="${escapeHtml(item.type)}">${escapeHtml(m.label)}</span>
          <div data-status-cell="${escapeHtml(item.url)}">
            ${aliveCellHtml(item.url)}
          </div>
        </div>
        <div class="cell-main">
          <div class="title-row">
            <a class="item-title js-smart-open" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" data-pwd="${escapeHtml(item.password || '')}">
              ${highlightKeyword(item.title, state.kw)}
            </a>
            ${specsHtml}
          </div>
          <div data-realfile-cell="${escapeHtml(item.url)}">${realFileHtml(item.url)}</div>
          ${item.content ? `<div class="item-sub">${highlightKeyword(item.content, state.kw)}</div>` : ''}
          ${siblingsHtml}
          <div class="item-meta-line">
            <button type="button" class="source-filter-chip js-src-chip" data-src="${escapeHtml(item.source || '')}" title="点击筛选该来源">来源：${escapeHtml(item.source || '聚合源')}</button>
            ${dt ? `<span>· 发布于 ${escapeHtml(dt)}</span>` : ''}
          </div>
        </div>
        <div class="cell-right">
          ${
            item.password
              ? `<button type="button" class="pwd-btn js-copy-pwd" data-pwd="${escapeHtml(item.password)}" title="点击复制提取码">码 · ${escapeHtml(item.password)}</button>`
              : ''
          }
          <button type="button" class="act-btn fav ${saved ? 'saved' : ''} js-fav-btn" data-url="${escapeHtml(item.url)}" title="收入私藏书签">${saved ? '★' : '☆'}</button>
          <button type="button" class="act-btn js-qr-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}" data-drive="${escapeHtml(m.label)}" data-pwd="${escapeHtml(item.password || '')}" title="手机扫码直达">扫码</button>
          <button type="button" class="act-btn js-copy-link" data-url="${escapeHtml(item.url)}" data-pwd="${escapeHtml(item.password || '')}">复制</button>
          <a class="act-btn primary js-smart-open" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" data-pwd="${escapeHtml(item.password || '')}">直达 ↗</a>
        </div>
      </article>
    `;
  }

  function renderSkeletonRows() {
    return `
      <div class="skeleton-wrap">
        <div class="empty-stage" style="padding:26px 20px 10px">正在寻访「${escapeHtml(state.kw)}」相关的多网盘资源，最先响应的源将即刻呈现…</div>
        ${Array.from({ length: 5 })
          .map(
            () => `
          <div class="skeleton-row">
            <div class="skel-bar" style="width:64px;height:28px"></div>
            <div style="display:flex;flex-direction:column;gap:8px">
              <div class="skel-bar" style="width:65%"></div>
              <div class="skel-bar" style="width:40%;height:11px"></div>
            </div>
            <div class="skel-bar" style="width:140px;height:30px"></div>
          </div>
        `
          )
          .join('')}
      </div>
    `;
  }

  function renderResultsList(driveList) {
    const mount = $('resultsMount');
    document.body.classList.toggle('has-searched', Boolean(state.kw));

    if (!state.kw) {
      mount.innerHTML = '';
      return;
    }

    if (state.loading) {
      mount.innerHTML = renderSkeletonRows();
      return;
    }

    if (state.error) {
      mount.innerHTML = `
        <div class="empty-stage">
          <div style="color:var(--bad);margin-bottom:14px">检索异常：${escapeHtml(state.error)}</div>
          <button type="button" class="pine-btn" id="retryBtn">重新检索</button>
        </div>
      `;
      const rb = $('retryBtn');
      if (rb) rb.addEventListener('click', () => doSearch(state.kw, true));
      return;
    }

    if (!driveList.length) {
      mount.innerHTML = `<div class="empty-stage">未找到符合当前筛选条件的网盘资源</div>`;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(driveList.length / state.perPage));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const start = (state.page - 1) * state.perPage;
    const pageItems = driveList.slice(start, start + state.perPage);

    let pagerHtml = '';
    if (totalPages > 1) {
      const pageBtns = [];
      pageBtns.push(`<button type="button" class="pg-cell" data-pg="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>`);
      const startP = Math.max(1, state.page - 2);
      const endP = Math.min(totalPages, state.page + 2);
      for (let p = startP; p <= endP; p++) {
        pageBtns.push(`<button type="button" class="pg-cell ${p === state.page ? 'active' : ''}" data-pg="${p}">${p}</button>`);
      }
      pageBtns.push(`<button type="button" class="pg-cell" data-pg="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>`);

      pagerHtml = `
        <div class="pager-bar">
          <div class="pager-meta">第 ${state.page} / ${totalPages} 页 · 显示第 ${start + 1}–${start + pageItems.length} 组（共 ${driveList.length} 组）</div>
          <div class="pager-btns">${pageBtns.join('')}</div>
        </div>
      `;
    }

    mount.innerHTML = pageItems.map(it => renderRow(it)).join('') + pagerHtml;

    bindRowEvents(mount, pageItems);
    triggerPageLinkCheck(pageItems);
  }

  function openQrModal({ url, title, drive, pwd }) {
    const modal = $('qrModal');
    const svgMount = $('qrSvgMount');
    $('qrItemTitle').textContent = title || '网盘分享资源';
    $('qrItemMeta').textContent = `${drive}网盘${pwd ? ` · 提取码：${pwd}` : ''}`;
    if (typeof window.renderPanSongQrSvg === 'function') {
      svgMount.innerHTML = window.renderPanSongQrSvg(url, 176);
    }
    modal.hidden = false;
  }

  function bindRowEvents(scope, pageItems) {
    const itemByUrl = new Map(pageItems.map(x => [x.url, x]));

    scope.querySelectorAll('.js-copy-pwd').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pwd = btn.dataset.pwd || '';
        if (await copyToClipboard(pwd)) {
          showToast(`已复制提取码：${pwd}`);
        }
      });
    });

    scope.querySelectorAll('.js-copy-link').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.dataset.url || '';
        const pwd = btn.dataset.pwd || '';
        const text = pwd ? `${url} 提取码: ${pwd}` : url;
        if (await copyToClipboard(text)) {
          showToast('已复制分享链接与提取码');
        }
      });
    });

    scope.querySelectorAll('.js-qr-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openQrModal({
          url: btn.dataset.url || '',
          title: btn.dataset.title || '',
          drive: btn.dataset.drive || '',
          pwd: btn.dataset.pwd || ''
        });
      });
    });

    scope.querySelectorAll('.js-smart-open').forEach(a => {
      a.addEventListener('click', async () => {
        const pwd = a.dataset.pwd || '';
        if (pwd) {
          await copyToClipboard(pwd);
          showToast(`已自动复制提取码：${pwd}`);
        }
      });
    });

    scope.querySelectorAll('.js-src-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.src || '';
        if (!src) return;
        state.exactSourceFilter = state.exactSourceFilter === src ? '' : src;
        state.page = 1;
        renderAll();
      });
    });

    scope.querySelectorAll('.js-fav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        const item = itemByUrl.get(url) || state.results.find(x => x.url === url);
        if (item) {
          toggleFav(item);
          const s = isFav(url);
          btn.classList.toggle('saved', s);
          btn.textContent = s ? '★' : '☆';
        }
      });
    });

    scope.querySelectorAll('.pg-cell[data-pg]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        state.page = Number(btn.dataset.pg) || 1;
        renderAll();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  async function batchCopyPageValidLinks() {
    const driveList = getDriveFilteredItems(getFilteredItems());
    const start = (state.page - 1) * state.perPage;
    const pageItems = driveList.slice(start, start + state.perPage);
    const validItems = pageItems.filter(it => {
      const st = state.linkStates.get(it.url)?.state;
      return st !== 'invalid';
    });

    if (!validItems.length) {
      showToast('当前页暂无可复制的有效链接');
      return;
    }

    const lines = validItems.map((it, idx) => {
      const m = DRIVE_META[it.type] || DRIVE_META.others;
      const pwdPart = it.password ? ` 提取码: ${it.password}` : '';
      return `${idx + 1}. 【${m.label}】${it.title}\n${it.url}${pwdPart}`;
    });

    if (await copyToClipboard(lines.join('\n\n'))) {
      showToast(`已批量复制本页 ${validItems.length} 条有效资源链接`);
    }
  }

  async function triggerPageLinkCheck(pageItems) {
    const unchecked = pageItems.filter(it => it.url && !state.linkStates.has(it.url));
    if (!unchecked.length) return;

    if (state.checkAbort) {
      try { state.checkAbort.abort(); } catch {}
    }
    const ac = new AbortController();
    state.checkAbort = ac;

    try {
      const res = await fetch('/api/check/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: unchecked.map(x => ({ url: x.url, disk_type: x.type, password: x.password }))
        }),
        signal: ac.signal
      });
      if (!res.ok) return;
      const data = await res.json();
      const arr = Array.isArray(data.results) ? data.results : [];
      for (const r of arr) {
        if (!r.url) continue;
        state.linkStates.set(r.url, {
          state: r.state,
          message: r.message,
          shareTitle: r.shareTitle || '',
          fileSize: r.fileSize || ''
        });
        updateRowAliveDOM(r.url);
      }
      const baseList = getFilteredItems();
      const driveList = getDriveFilteredItems(baseList);
      renderTelemetry(driveList);
      if (state.hideDead || state.sortBy === 'alive') {
        renderResultsList(driveList);
      }
    } catch {}
  }

  function updateRowAliveDOM(url) {
    const st = state.linkStates.get(url)?.state;
    document.querySelectorAll(`.row-item[data-card-url="${CSS.escape(url)}"]`).forEach(row => {
      row.classList.toggle('is-dead', st === 'invalid');
      const cell = row.querySelector('[data-status-cell]');
      if (cell) {
        cell.innerHTML = aliveCellHtml(url);
      }
      const rfCell = row.querySelector('[data-realfile-cell]');
      if (rfCell) {
        rfCell.innerHTML = realFileHtml(url);
      }
    });
  }

  function renderAll() {
    const baseList = getFilteredItems();
    const driveList = getDriveFilteredItems(baseList);
    renderDriveFilters(baseList);
    renderTelemetry(driveList);
    renderResultsList(driveList);
  }

  function stopActiveStream() {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch {}
      state.eventSource = null;
    }
    if (state.searchAbort) {
      try { state.searchAbort.abort(); } catch {}
      state.searchAbort = null;
    }
    clearTimeout(doSearch._renderTimer);
  }

  async function fallbackPostSearch(kw, forceRefresh) {
    const ac = new AbortController();
    state.searchAbort = ac;
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kw, forceRefresh }),
        signal: ac.signal
      });
      const json = await res.json();
      if (!res.ok || json.code !== 0) {
        throw new Error(json.message || `HTTP ${res.status}`);
      }
      state.results = Array.isArray(json.data?.results) ? json.data.results : [];
      state.meta = json.data?.meta || {};
    } catch (err) {
      if (err.name === 'AbortError') return;
      state.error = err.message || '请求失败';
    } finally {
      state.loading = false;
      state.streaming = false;
      $('searchSubmitBtn').disabled = false;
      renderAll();
    }
  }

  function doSearch(kw, forceRefresh = false) {
    kw = (kw || '').trim();
    if (!kw) {
      $('kwInput').focus();
      return;
    }

    stopActiveStream();
    enterSearchView(kw);

    state.kw = kw;
    state.loading = true;
    state.streaming = true;
    state.error = null;
    state.results = [];
    state.meta = null;
    state.page = 1;
    if (!forceRefresh) {
      state.activeDrive = 'all';
      state.exactSourceFilter = '';
      state.specFilter = '';
      state.subFilter = '';
      $('subFilterInput').value = '';
    }
    $('searchSubmitBtn').disabled = true;

    const u = new URL(location.href);
    u.searchParams.set('q', kw);
    history.replaceState(null, '', u.toString());

    saveHistory(kw);
    renderAll();

    if (typeof window.EventSource !== 'function') {
      fallbackPostSearch(kw, forceRefresh);
      return;
    }

    const streamUrl = `/api/search/stream?kw=${encodeURIComponent(kw)}${forceRefresh ? '&refresh=1' : ''}`;
    const es = new EventSource(streamUrl);
    state.eventSource = es;
    let receivedBatch = false;

    const scheduleRender = (immediate = false) => {
      if (immediate) {
        clearTimeout(doSearch._renderTimer);
        renderAll();
        return;
      }
      if (doSearch._renderTimer) return;
      doSearch._renderTimer = setTimeout(() => {
        doSearch._renderTimer = null;
        renderAll();
      }, 110);
    };

    es.addEventListener('batch', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const firstPaint = !receivedBatch && Array.isArray(data.results) && data.results.length > 0;
        if (Array.isArray(data.results)) {
          state.results = data.results;
        }
        if (data.meta) {
          state.meta = data.meta;
        }
        if (state.results.length > 0) {
          receivedBatch = true;
          state.loading = false;
        }
        scheduleRender(firstPaint);
      } catch {}
    });

    es.addEventListener('done', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (Array.isArray(data.results)) {
          state.results = data.results;
        }
        if (data.meta) {
          state.meta = data.meta;
        }
      } catch {}
      stopActiveStream();
      state.loading = false;
      state.streaming = false;
      $('searchSubmitBtn').disabled = false;
      renderAll();
    });

    es.onerror = () => {
      stopActiveStream();
      if (!receivedBatch) {
        fallbackPostSearch(kw, forceRefresh);
      } else {
        state.loading = false;
        state.streaming = false;
        $('searchSubmitBtn').disabled = false;
        renderAll();
      }
    };
  }

  function goHome() {
    backToWall();
  }

  async function loadServerConfig() {
    try {
      const res = await fetch('/api/config');
      const json = await res.json();
      if (json.code === 0 && json.data) {
        state.serverConfig = json.data.config;
        state.availablePlugins = json.data.availablePlugins || [];
        state.pluginHealth = json.data.health || {};
        state.tgHealth = json.data.tgHealth || { channels: [], deadCandidates: [] };
        state.runtimeStats = json.data.runtime || null;
        if (Array.isArray(state.serverConfig.hotWords)) {
          state.hotWords = state.serverConfig.hotWords;
          renderQuickTags();
        }
        const chCnt = Array.isArray(state.serverConfig.channels) ? state.serverConfig.channels.length : 0;
        const plCnt = Array.isArray(state.serverConfig.enabledPlugins) ? state.serverConfig.enabledPlugins.length : 0;
        const metaEl = $('headerMetaInfo');
        if (metaEl) {
          metaEl.textContent = `${chCnt} 个 TG 频道 · ${plCnt} 个插件守护运行中`;
        }
      }
    } catch {}
  }

  function renderRuntimeShield() {
    const rt = state.runtimeStats;
    const uptimeEl = $('runtimeUptimeText');
    const gridEl = $('runtimeMetricsGrid');
    if (!rt || !uptimeEl || !gridEl) return;

    uptimeEl.textContent = `已无间断运行：${formatUptime(rt.uptimeSec)} · ${rt.platform || ''}`;

    const searchHits = (rt.searchCache?.cacheHits || 0) + (rt.searchCache?.coalescedHits || 0);
    const checkHits = rt.checker?.cacheHits || 0;
    const posterHits = rt.posterCache?.hits || 0;

    gridEl.innerHTML = `
      <div class="shield-metric-box">
        <span class="shield-metric-label">进程内存 (RSS / 堆)</span>
        <span class="shield-metric-val">${rt.memory?.rssMB || 0} / ${rt.memory?.heapUsedMB || 0} MB</span>
      </div>
      <div class="shield-metric-box">
        <span class="shield-metric-label">检索缓存 / 合并防击穿</span>
        <span class="shield-metric-val">${rt.searchCache?.entries || 0} 组 · 命中 ${searchHits} 次</span>
      </div>
      <div class="shield-metric-box">
        <span class="shield-metric-label">死链实测缓存池</span>
        <span class="shield-metric-val">${rt.checker?.cacheEntries || 0} 条 · 命中 ${checkHits} 次</span>
      </div>
      <div class="shield-metric-box">
        <span class="shield-metric-label">海报缓存 / 分域节流</span>
        <span class="shield-metric-val">${rt.posterCache?.entries || 0} 张(命中${posterHits}) · 节流 ${rt.http?.totalThrottledWaits || 0} 次</span>
      </div>
    `;
  }

  function renderPluginCells() {
    const cfg = state.serverConfig || {};
    const enabledSet = new Set(cfg.enabledPlugins || []);
    $('cfgPluginsGrid').innerHTML = state.availablePlugins
      .map(p => {
        const h = state.pluginHealth[`plugin:${p.id}`];
        let healthTag = `<span class="plugin-meta-tag">就绪</span>`;
        if (h) {
          if (h.state === 'OPEN') {
            healthTag = `<span class="plugin-meta-tag open">已熔断 · 冷却 ${h.cooldownRemainingSec || 0}s</span>`;
          } else if (h.okCount > 0) {
            healthTag = `<span class="plugin-meta-tag ok">正常 · 均耗 ${h.avgLatencyMs}ms (成功${h.okCount})</span>`;
          } else if (h.failCount > 0) {
            healthTag = `<span class="plugin-meta-tag open">异常 ${h.consecutiveFailures}/3</span>`;
          }
        }
        return `
        <label class="plugin-cell">
          <input type="checkbox" name="cfgPlugin" value="${escapeHtml(p.id)}" ${enabledSet.has(p.id) ? 'checked' : ''} />
          <div>
            <div style="font-weight:600;font-size:13px">${escapeHtml(p.name)}</div>
            <div style="font-size:11.5px;color:var(--ink-3);margin-top:2px">${escapeHtml(p.desc)}</div>
            ${healthTag}
          </div>
        </label>
      `;
      })
      .join('');
  }

  async function openSettingsModal() {
    await loadServerConfig();
    const modal = $('settingsModal');
    const cfg = state.serverConfig || {};
    $('cfgProxyInput').value = cfg.proxy || '';
    $('cfgEnableTg').checked = cfg.enableTelegram !== false;
    $('cfgHideOwn').checked = cfg.hideAdsAndOwn !== false;
    const channels = Array.isArray(cfg.channels) ? cfg.channels : [];
    $('cfgChannelsTextarea').value = channels.join(', ');
    $('cfgChannelCountHint').textContent = `（共 ${channels.length} 个）`;

    const deadList = state.tgHealth?.deadCandidates || [];
    const hintEl = $('tgChannelHealthHint');
    if (hintEl) {
      hintEl.textContent = deadList.length
        ? `检测到 ${deadList.length} 个失效或无公开预览频道：${deadList.join(', ')}（可点击右上角一键剔除）`
        : '所有已测 Telegram 频道状态正常（引擎已自动按历史命中率排优抓取）';
    }

    renderRuntimeShield();
    renderPluginCells();
    modal.hidden = false;
  }

  function pruneDeadChannels() {
    const deadSet = new Set(state.tgHealth?.deadCandidates || []);
    if (!deadSet.size) {
      showToast('当前未发现失效频道');
      return;
    }
    const current = $('cfgChannelsTextarea')
      .value.split(/[\s,，;；\n]+/)
      .map(s => s.trim().replace(/^@/, ''))
      .filter(Boolean);
    const next = current.filter(ch => !deadSet.has(ch));
    const removedCount = current.length - next.length;
    $('cfgChannelsTextarea').value = next.join(', ');
    $('cfgChannelCountHint').textContent = `（共 ${next.length} 个）`;
    $('tgChannelHealthHint').textContent = `已从列表中剔除 ${removedCount} 个失效频道，点击右下角「保存并应用」即可生效`;
    showToast(`已剔除 ${removedCount} 个失效频道`);
  }

  async function saveSettings() {
    const proxy = $('cfgProxyInput').value.trim();
    const enableTelegram = $('cfgEnableTg').checked;
    const hideAdsAndOwn = $('cfgHideOwn').checked;
    const channels = $('cfgChannelsTextarea').value;
    const enabledPlugins = Array.from(document.querySelectorAll('input[name="cfgPlugin"]:checked')).map(el => el.value);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxy, enableTelegram, hideAdsAndOwn, channels, enabledPlugins })
      });
      const json = await res.json();
      if (json.code === 0) {
        state.serverConfig = json.data;
        $('settingsModal').hidden = true;
        loadServerConfig();
        showToast('设置已保存并生效');
        if (state.kw) doSearch(state.kw, true);
      }
    } catch (err) {
      showToast('保存失败：' + err.message);
    }
  }

  async function probeLocalProxy() {
    const statusEl = $('proxyProbeStatus');
    const btn = $('probeProxyBtn');
    btn.disabled = true;
    statusEl.textContent = '正在探测本机常用代理端口 (7890 / 7897 / 10808 / 10809) 并测试 Telegram 连通性…';

    try {
      const res = await fetch('/api/proxy/probe', { method: 'POST' });
      const json = await res.json();
      const { localProxies = [], tgStatus = {} } = json.data || {};

      if (localProxies.length > 0 && !$('cfgProxyInput').value.trim()) {
        $('cfgProxyInput').value = localProxies[0].url;
      }

      const proxySummary = localProxies.length
        ? `发现本机端口：${localProxies.map(p => p.url).join(' / ')}`
        : '未探测到常用代理端口';

      const tgSummary = tgStatus.reachable
        ? `Telegram 可直达 (${tgStatus.latencyMs}ms)`
        : `Telegram 不可达 (${tgStatus.error || '超时'})`;

      statusEl.textContent = `${proxySummary} · ${tgSummary}`;
    } catch (err) {
      statusEl.textContent = '探测异常：' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  function openFavModal() {
    const modal = $('favModal');
    const mount = $('favListMount');
    if (!state.favorites.length) {
      mount.innerHTML = `<div class="empty-stage">尚无私藏书签</div>`;
    } else {
      mount.innerHTML = state.favorites.map(it => renderRow(it)).join('');
      bindRowEvents(mount, state.favorites);
    }
    modal.hidden = false;
  }

  function initEvents() {
    $('searchForm').addEventListener('submit', e => {
      e.preventDefault();
      doSearch($('kwInput').value);
    });

    $('kwInput').addEventListener('input', syncSearchBoxClass);
    $('clearInputBtn').addEventListener('click', () => {
      $('kwInput').value = '';
      syncSearchBoxClass();
      $('kwInput').focus();
    });

    $('brandHome').addEventListener('click', goHome);
    if ($('backToWallBtn')) {
      $('backToWallBtn').addEventListener('click', backToWall);
    }
    if ($('batchCopyValidBtn')) {
      $('batchCopyValidBtn').addEventListener('click', batchCopyPageValidLinks);
    }
    if ($('loadMorePostersBtn')) {
      $('loadMorePostersBtn').addEventListener('click', () => loadWallPage(false));
    }
    if ($('wallFilterInput')) {
      $('wallFilterInput').addEventListener('input', (e) => {
        state.wallFilterKw = e.target.value;
        applyWallFilter();
      });
    }

    document.querySelectorAll('#wallSortTabs .sort-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = btn.dataset.sort;
        if (s === state.wallSort && state.wallItems.length > 0) return;
        state.wallSort = s;
        renderWallChannels();
        loadWallPage(true);
      });
    });

    document.querySelectorAll('#specQuickChips .spec-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const sp = chip.dataset.spec;
        state.specFilter = state.specFilter === sp ? '' : sp;
        state.page = 1;
        renderAll();
      });
    });

    $('subFilterInput').addEventListener('input', e => {
      state.subFilter = e.target.value;
      state.page = 1;
      renderAll();
    });

    $('sourceFilterSelect').addEventListener('change', e => {
      state.sourceFilter = e.target.value;
      state.exactSourceFilter = '';
      state.page = 1;
      renderAll();
    });

    $('sortSelect').addEventListener('change', e => {
      state.sortBy = e.target.value;
      state.page = 1;
      renderAll();
    });

    $('foldMultiDriveCheckbox').addEventListener('change', e => {
      state.foldMultiDrive = e.target.checked;
      state.page = 1;
      renderAll();
    });

    $('hideDeadCheckbox').addEventListener('change', e => {
      state.hideDead = e.target.checked;
      state.page = 1;
      renderAll();
    });

    $('forceRefreshBtn').addEventListener('click', () => {
      if (state.kw) doSearch(state.kw, true);
    });

    $('closeQrBtn').addEventListener('click', () => ($('qrModal').hidden = true));

    $('openSettingsBtn').addEventListener('click', openSettingsModal);
    $('closeSettingsBtn').addEventListener('click', () => ($('settingsModal').hidden = true));
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('probeProxyBtn').addEventListener('click', probeLocalProxy);
    $('pruneDeadChannelsBtn').addEventListener('click', pruneDeadChannels);
    $('resetBreakersBtn').addEventListener('click', async () => {
      await fetch('/api/breaker/reset', { method: 'POST' });
      await loadServerConfig();
      renderRuntimeShield();
      renderPluginCells();
      showToast('已重置所有插件熔断器');
    });
    $('clearServerCacheBtn').addEventListener('click', async () => {
      await fetch('/api/cache/clear', { method: 'POST' });
      await loadServerConfig();
      renderRuntimeShield();
      showToast('已清空搜索缓存');
    });

    $('openFavBtn').addEventListener('click', openFavModal);
    $('closeFavBtn').addEventListener('click', () => ($('favModal').hidden = true));
    $('clearAllFavBtn').addEventListener('click', () => {
      state.favorites = [];
      try { localStorage.removeItem('pansong_favorites'); } catch {}
      updateFavBadge();
      openFavModal();
    });

    ['settingsModal', 'favModal', 'qrModal'].forEach(id => {
      $(id).addEventListener('click', e => {
        if (e.target === $(id)) $(id).hidden = true;
      });
    });

    const backTopBtn = $('backToTopBtn');
    if (backTopBtn) {
      window.addEventListener(
        'scroll',
        () => {
          backTopBtn.hidden = (window.scrollY || document.documentElement.scrollTop || 0) < 520;
        },
        { passive: true }
      );
      backTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== $('kwInput') && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        $('kwInput').focus();
        $('kwInput').select();
      }
      if (e.key === 'Escape') {
        $('settingsModal').hidden = true;
        $('favModal').hidden = true;
        $('qrModal').hidden = true;
      }
    });
  }

  loadLocalData();
  initTheme();
  initEvents();
  renderQuickTags();
  renderWallChannels();
  setupWallInfiniteScroll();
  loadServerConfig();
  loadWallPage(true);

  const initialQ = new URLSearchParams(location.search).get('q');
  if (initialQ) {
    $('kwInput').value = initialQ;
    syncSearchBoxClass();
    doSearch(initialQ);
  }
})();
