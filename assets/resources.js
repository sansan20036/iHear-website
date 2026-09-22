(() => {
  'use strict';
  const root = document.querySelector('[data-resource-catalog]');
  if (!root) return;
  const copy = {
    en: { heading: 'Resources', loading: 'Loading resources…', error: 'Resources could not be loaded.', retry: 'Try again', empty: 'There are no published resources yet.', manage: 'Manage resources', manageTopic: 'Manage this topic', external: 'opens in a new tab', email: 'Email request', text: 'Information' },
    zhHant: { heading: '資源', loading: '資源載入中…', error: '資源載入失敗。', retry: '重新載入', empty: '目前沒有公開資源。', manage: '管理資源', manageTopic: '管理此主題', external: '另開新分頁', email: 'Email 索取', text: '資訊' },
    zhHans: { heading: '资源', loading: '资源加载中…', error: '资源加载失败。', retry: '重新加载', empty: '目前没有公开资源。', manage: '管理资源', manageTopic: '管理此主题', external: '另开新分页', email: 'Email 索取', text: '信息' },
  };
  const lang = () => ['zh-Hant', 'zh-TW'].includes(document.documentElement.lang) ? 'zhHant' : ['zh-Hans', 'zh-CN'].includes(document.documentElement.lang) ? 'zhHans' : 'en';
  const localized = value => (typeof value?.[lang()] === 'string' && value[lang()].trim() ? value[lang()] : typeof value?.en === 'string' ? value.en : '');
  const heading = root.querySelector('h1'), container = root.querySelector('[data-resource-topics]');
  const status = root.querySelector('[data-resource-status]'), retry = root.querySelector('[data-resource-retry]'), manage = root.querySelector('[data-resource-manage]');
  let data = null, failed = false, fetching = false, pending = false, rendered = '';
  const legacyGuides = document.querySelector('[data-resource-legacy-guides]');
  let takeoverComplete = false;
  let admin = !!window.iHearAuth?.getSession()?.user?.isAdmin;
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const publicRecord = record => record && /^[a-zA-Z0-9-]{1,80}$/.test(record.id) && (record.status === undefined || record.status === 'published');
  const order = records => records.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const subjects = { en: 'Resource guide request: ', zhHant: '索取指南：', zhHans: '索取指南：' };
  const unavailable = { en: 'This topic is not currently available to visitors.', zhHant: '此主題目前無法供訪客查看。', zhHans: '此主题当前无法供访客查看。' };
  const anchorNotice = node('p', 'resource-anchor-notice');
  anchorNotice.setAttribute('role', 'status'); anchorNotice.hidden = true; status.after(anchorNotice);
  let anchorPending = !!location.hash;
  const fragmentName = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };
  function anchorTarget() {
    const name = fragmentName();
    const topic = [...container.querySelectorAll('[data-resource-slug]')].find(element => element.dataset.resourceSlug === name);
    if (topic) return topic;
    // Preserve only known public destinations, never arbitrary DOM IDs.
    if (['resources', 'resource-links', 'resource-guides', 'resource-articles'].includes(name)) return document.getElementById(name);
    return null;
  }
  function locateAnchor() {
    if (data === null) return;
    const target = anchorTarget();
    anchorNotice.hidden = !location.hash || !!target;
    anchorNotice.textContent = anchorNotice.hidden ? '' : unavailable[lang()];
    if (!anchorPending) return;
    anchorPending = false;
    if (!target) return;
    const offset = Math.max(0, document.querySelector('.nav')?.getBoundingClientRect().bottom || 0) + 12;
    window.scrollTo({ top: Math.max(0, scrollY + target.getBoundingClientRect().top - offset), behavior: 'instant' });
    const focusTarget = target.querySelector('h1,h2') || target;
    focusTarget.tabIndex = -1; focusTarget.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', () => { anchorPending = !!location.hash; locateAnchor(); });
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target === '_blank') return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search && url.hash && url.hash === location.hash) {
      event.preventDefault(); anchorPending = true; locateAnchor();
    }
  });
  function linkUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  function normalize(payload) {
    // Only a public Topic/Item snapshot is accepted. Never use admin or seeded data as a fallback.
    if (!Array.isArray(payload?.topics) || !Array.isArray(payload?.items)) throw new Error('Invalid public resources');
    if (new Set(payload.topics.map(topic => topic.id)).size !== payload.topics.length || new Set(payload.items.map(item => item.id)).size !== payload.items.length) throw new Error('Duplicate resource identifiers');
    if (!['legacy', 'complete'].includes(payload.guidesTakeover)) throw new Error('Guide takeover state unavailable');
    if (payload.guidesTakeover === 'legacy' && (takeoverComplete || payload.items.some(item => item.topicId === 'guides' || /^guide-/.test(item.id)))) throw new Error('Inconsistent guide takeover');
    if (payload.guidesTakeover === 'complete') takeoverComplete = true;
    const topics = order(payload.topics.filter(publicRecord)), ids = new Set(topics.map(topic => topic.id));
    const items = order(payload.items.filter(item => publicRecord(item) && ids.has(item.topicId)
      && ['external_link', 'email_request', 'text'].includes(item.type)
      && (item.type !== 'external_link' || linkUrl(item.url))));
    return { topics: topics.filter(topic => items.some(item => item.topicId === topic.id)), items, guidesTakeover: payload.guidesTakeover };
  }
  function render() {
    if (takeoverComplete) legacyGuides?.remove();
    else if (legacyGuides) legacyGuides.hidden = data?.guidesTakeover !== 'legacy';
    const text = copy[lang()]; heading.textContent = text.heading; manage.textContent = text.manage; manage.hidden = !admin; retry.textContent = text.retry;
    status.textContent = failed ? text.error : data === null ? text.loading : data.topics.length ? '' : text.empty;
    retry.hidden = !failed;
    const signature = JSON.stringify([lang(), admin, data]);
    if (signature === rendered) { locateAnchor(); return; }
    rendered = signature;
    const focus = document.activeElement?.closest('[data-resource-focus]')?.dataset.resourceFocus;
    const fragment = document.createDocumentFragment();
    const usedIds = new Set([...document.querySelectorAll('[id]')].filter(element => !container.contains(element)).map(element => element.id));
    for (const topic of data?.topics || []) {
      const section = node('section', 'resource-topic'); section.dataset.resourceTopic = topic.id;
      if (typeof topic.slug === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(topic.slug)) {
        section.dataset.resourceSlug = topic.slug;
        if (!usedIds.has(topic.slug)) { section.id = topic.slug; usedIds.add(topic.slug); }
      }
      for (const [id, alias] of [['forms', 'resource-links'], ['articles', 'resource-articles']]) {
        if (topic.id !== id) continue;
        section.setAttribute('data-' + alias, '');
        if (!usedIds.has(alias)) { const anchor = node('span'); anchor.id = alias; section.append(anchor); usedIds.add(alias); }
      }
      const title = node('h2', '', localized(topic.title));
      title.tabIndex = -1;
      title.dataset.resourceFocus = `heading:${topic.id}`;
      section.setAttribute('aria-label', localized(topic.title)); section.append(title);
      const intro = localized(topic.description); if (intro) section.append(node('p', 'resource-topic-description', intro));
      const entry = node('a', 'btn btn-outline resource-topic-manage', text.manageTopic);
      entry.href = `/admin/resources?topicId=${encodeURIComponent(topic.id)}`; entry.hidden = !admin;
      entry.setAttribute('aria-label', `${text.manageTopic}: ${localized(topic.title)}`); entry.dataset.resourceFocus = `topic:${topic.id}`; section.append(entry);
      const list = node('ul', 'resource-links-list');
      for (const item of data.items.filter(item => item.topicId === topic.id)) {
        const row = node('li'); row.dataset.resourceItem = item.id; row.dataset.resourceType = item.type;
        const itemHeading = node('h3', 'resource-item-title');
        if (item.type === 'external_link') {
          const link = node('a', '', localized(item.title)); link.href = linkUrl(item.url); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.resourceFocus = `item:${item.id}`;
          link.append(node('span', 'resource-external', ` ↗ (${text.external})`)); itemHeading.append(link);
        } else if (item.type === 'email_request') {
          const link = node('a', '', localized(item.title));
          link.href = 'mailto:ihearprogram@gmail.com?subject=' + encodeURIComponent(subjects[lang()] + localized(item.title));
          link.dataset.resourceFocus = `item:${item.id}`; itemHeading.append(link);
        } else {
          itemHeading.textContent = localized(item.title);
        }
        row.append(itemHeading);
        if (item.type !== 'external_link') row.append(node('span', 'resource-kind', item.type === 'email_request' ? text.email : text.text));
        const description = localized(item.description); if (description) row.append(node('p', '', description));
        list.append(row);
      }
      section.append(list); fragment.append(section);
    }
    container.replaceChildren(fragment);
    locateAnchor();
    // Do not disturb keyboard focus on unchanged refreshes; preserve it across changed records where possible.
    if (focus) {
      const replacement = [...container.querySelectorAll('[data-resource-focus]')].find(element => element.dataset.resourceFocus === focus && !element.hidden);
      if (replacement) replacement.focus({ preventScroll: true });
      else { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }
  async function refresh() {
    if (document.hidden) return;
    if (fetching) { pending = true; return; }
    fetching = true;
    try {
      const response = await fetch('/api/resources', { cache: 'no-store' });
      if (!response.ok) throw new Error('Resources unavailable');
      data = normalize(await response.json()); failed = false;
    } catch {
      // A previous result may now be unpublished. Clear it on failure instead of keeping stale public names.
      data = null; failed = true;
    } finally { fetching = false; render(); if (pending) { pending = false; void refresh(); } }
  }
  retry.addEventListener('click', refresh);
  window.addEventListener('ihear:language', render);
  window.addEventListener('ihear:auth', event => { admin = !!event.detail?.session?.user?.isAdmin && !event.detail?.error; render(); });
  window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
  window.iHearLiveContent?.register('content', { refresh });
  if ('BroadcastChannel' in window) new BroadcastChannel('ihear-resources').addEventListener('message', refresh);
  setInterval(refresh, 15000);
  render(); void refresh();
})();
