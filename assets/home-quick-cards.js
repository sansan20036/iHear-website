(() => {
  'use strict';

  const root = document.querySelector('[data-home-quick-cards]');
  const labels = document.querySelector('[data-home-cards-labels]');
  if (!root || !labels || window.iHearHomeQuickCards) return;

  const LOCALES = ['en', 'zhHant', 'zhHans'];
  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
  const locale = () => ['zh-Hant', 'zh-TW'].includes(document.documentElement.lang) ? 'zhHant' : ['zh-Hans', 'zh-CN'].includes(document.documentElement.lang) ? 'zhHans' : 'en';
  const language = key => ({ en: 'en', zhHant: 'zh-Hant', zhHans: 'zh-Hans' })[key];
  const label = key => {
    const source = labels.content.querySelector(`[data-home-cards-label="${key}"]`);
    return String((source && window.iHearPublishedContent?.valueFor(source, locale())) ?? source?.textContent ?? '');
  };
  if (['loading', 'error', 'retry', 'announcementsEmpty', 'calendarEmpty', 'resources', 'announcementsLink', 'calendarLink'].some(key => !label(key))) return;

  const cards = ['announcements', 'calendar'].map(slug => {
    const element = root.querySelector(`[data-home-${slug}]`);
    if (!element) return null;
    const part = name => element.querySelector(`[data-home-card-${name}]`);
    const nodes = Object.fromEntries(['title', 'summary', 'status', 'skeleton', 'retry', 'link'].map(name => [name, part(name)]));
    return Object.values(nodes).every(Boolean) ? { slug, element, ...nodes, data: null, state: 'loading', stale: false, renderingFailed: false } : null;
  }).filter(Boolean);
  if (!cards.length) return;

  let inFlight = null, dirty = false, lifecycle = 0, requestSequence = 0;
  let suspended = false, destroyed = false, interval = 0, channel = null, unregister = null;
  let initialTimer = 0, initialSettled = false, takeoverComplete = false;
  const initialDeadline = Date.now() + 10000;
  const removers = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener(type, handler));
  };

  function translations(value, maximum, required) {
    if (!record(value) || LOCALES.some(key => typeof value[key] !== 'string' || Array.from(value[key]).length > maximum) || (required && !value.en.trim())) throw new Error('Invalid Resources translations');
    return Object.fromEntries(LOCALES.map(key => [key, value[key]]));
  }
  function common(value) {
    if (!record(value) || !id(value.id) || !Number.isSafeInteger(value.sortOrder) || value.sortOrder < 0 || value.sortOrder > 1000000) throw new Error('Invalid Resources record');
    return { id: value.id, sortOrder: value.sortOrder, title: translations(value.title, 200, true), description: translations(value.description, 2000, false) };
  }
  function resourceUrl(value) {
    if (typeof value !== 'string' || Array.from(value).length > 2048 || !/^https:\/\/[^/?#@\s\\]+([/?#][^\s\\]*)?$/.test(value)) throw new Error('Invalid Resources URL');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid Resources URL');
    return value;
  }
  // Validate the entire public read before either card projects it. This is the
  // endpoint's enum, not the persisted boolean Guides migration marker. There
  // is no public snapshot version, item version, status or gallery version.
  function snapshot(value) {
    if (!record(value) || !Array.isArray(value.items) || !Array.isArray(value.topics) || !['legacy', 'complete'].includes(value.guidesTakeover)) throw new Error('Invalid Resources snapshot');
    const topicIds = new Set(), itemIds = new Set(), slugs = new Set();
    const topics = value.topics.map(topic => {
      const result = common(topic);
      if (topicIds.has(result.id) || typeof topic.slug !== 'string' || topic.slug.length > 120 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(topic.slug) || slugs.has(topic.slug)) throw new Error('Invalid Resources topic identity');
      topicIds.add(result.id); slugs.add(topic.slug);
      return { ...result, slug: topic.slug };
    });
    const items = value.items.map(item => {
      const result = common(item);
      if (itemIds.has(result.id) || !id(item.topicId) || !topicIds.has(item.topicId) || !['form', 'article'].includes(item.category) || !['external_link', 'email_request', 'text'].includes(item.type)) throw new Error('Invalid Resources item relationship');
      itemIds.add(result.id);
      const url = item.type === 'external_link' ? resourceUrl(item.url) : item.url;
      if (item.type !== 'external_link' && url !== '') throw new Error('Invalid non-link Resources URL');
      return { ...result, topicId: item.topicId, category: item.category, type: item.type, url };
    });
    const guideIds = new Set(['communication', 'classroom', 'family', 'hearing-loss', 'implant', 'hearing-aid', 'activities', 'tracking', 'handbook'].map(key => `guide-${key}`));
    if (value.guidesTakeover === 'legacy' && (takeoverComplete || items.some(item => item.topicId === 'guides' || guideIds.has(item.id)))) throw new Error('Inconsistent Guides takeover');
    return { items, topics, guidesTakeover: value.guidesTakeover };
  }
  function project(data, slug) {
    const topic = data.topics.find(item => item.slug === slug);
    // Missing/empty public topics are legitimate. Never infer admin status or
    // pass a slug as topicId to the item selector.
    const item = topic && data.items.filter(item => item.topicId === topic.id).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))[0];
    return item ? { state: 'ready', topic, item } : { state: 'empty' };
  }
  function translated(values) {
    const key = locale();
    const selected = values[key].trim() ? key : 'en';
    return { text: values[selected], language: language(selected) };
  }
  const excerpt = value => {
    const points = Array.from(value.replace(/\s+/g, ' ').trim());
    return points.length > 160 ? points.slice(0, 160).join('') + '…' : points.join('');
  };
  const write = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  function reflectState(card) {
    card.element.dataset.state = card.state;
    card.element.dataset.homeCardState = card.state;
    const refreshState = card.stale ? 'stale' : inFlight ? 'refreshing' : 'fresh';
    card.element.dataset.refreshState = refreshState;
    card.element.dataset.homeCardRefreshState = refreshState;
    card.element.setAttribute('aria-busy', card.state === 'loading' ? 'true' : 'false');
  }
  function render(card) {
    const ready = card.state === 'ready';
    const focusedRetry = document.activeElement === card.retry;
    const title = ready ? translated(card.data.item.title) : null;
    const description = ready ? translated(card.data.item.description) : null;
    // Text operations preserve literal HTML-like resource content and retained
    // nodes/links. Never turn an external_link/email item into the home CTA.
    write(card.title, title?.text || ''); card.title.hidden = !ready;
    write(card.summary, description ? excerpt(description.text) : ''); card.summary.hidden = !ready || !card.summary.textContent;
    if (title) card.title.lang = title.language;
    if (description) card.summary.lang = description.language;
    const statusKey = card.state === 'loading' ? 'loading' : card.state === 'error' ? 'error' : card.state === 'empty' ? `${card.slug}Empty` : null;
    write(card.status, statusKey ? label(statusKey) : ''); card.status.hidden = !statusKey;
    card.status.lang = language(locale());
    card.skeleton.hidden = card.state !== 'loading';
    write(card.retry, label('retry')); card.retry.hidden = card.state !== 'error';
    card.link.setAttribute('href', ready ? `/resources#${card.data.topic.slug}` : '/resources');
    write(card.link, label(ready ? `${card.slug}Link` : 'resources'));
    card.link.lang = language(locale()); card.retry.lang = language(locale());
    if (ready) { card.element.dataset.itemId = card.data.item.id; card.element.dataset.topicId = card.data.topic.id; }
    else { delete card.element.dataset.itemId; delete card.element.dataset.topicId; }
    reflectState(card);
    if (focusedRetry && card.retry.hidden) card.link.focus({ preventScroll: true });
  }
  function renderFailed(card) {
    // A legal new snapshot can withdraw the previous item even if this card's
    // renderer fails. Clear only this card's dynamic copy, never keep a known
    // withdrawn title or let one broken card block its sibling.
    card.state = 'error'; card.renderingFailed = true;
    card.title.replaceChildren(); card.summary.replaceChildren();
    card.title.hidden = true; card.summary.hidden = true; card.skeleton.hidden = true;
    delete card.element.dataset.itemId; delete card.element.dataset.topicId;
    card.link.setAttribute('href', '/resources');
    card.status.hidden = false; card.retry.hidden = false;
    try { write(card.status, label('error')); write(card.retry, label('retry')); write(card.link, label('resources')); } catch { /* Existing localized retry/link remain usable. */ }
    reflectState(card);
  }
  function paint(card) {
    try { render(card); }
    catch { renderFailed(card); }
  }
  function settleInitial() {
    if (cards.some(card => card.state === 'loading')) return;
    initialSettled = true; window.clearTimeout(initialTimer); initialTimer = 0;
  }
  function fail() {
    for (const card of cards) {
      card.stale = true;
      card.state = card.data && !card.renderingFailed ? card.data.state : 'error';
      paint(card);
    }
    settleInitial();
  }
  function accept(data) {
    if (data.guidesTakeover === 'complete') takeoverComplete = true;
    for (const card of cards) {
      try {
        const next = project(data, card.slug);
        card.data = next; card.state = next.state; card.stale = false; card.renderingFailed = false;
        paint(card);
      } catch { renderFailed(card); }
    }
    settleInitial();
  }
  function scheduleInitialGuard() {
    window.clearTimeout(initialTimer); initialTimer = 0;
    if (initialSettled || destroyed || suspended) return;
    const expire = () => {
      initialTimer = 0;
      for (const card of cards) if (card.state === 'loading') { card.state = 'error'; card.stale = true; paint(card); }
      settleInitial();
    };
    const remaining = initialDeadline - Date.now();
    if (remaining <= 0) expire();
    else initialTimer = window.setTimeout(expire, remaining);
  }
  function reflectRefresh() {
    root.dataset.refreshState = cards.some(card => card.stale) ? 'stale' : inFlight ? 'refreshing' : 'fresh';
    cards.forEach(reflectState);
  }
  function refresh() {
    if (destroyed || suspended) return Promise.resolve();
    if (document.hidden) { dirty = true; return Promise.resolve(); }
    if (inFlight) { dirty = true; return inFlight.promise; }
    dirty = false;
    const request = { id: ++requestSequence, life: lifecycle, controller: new AbortController(), timer: 0, cancel: null, promise: null };
    inFlight = request; reflectRefresh();
    const current = () => !destroyed && !suspended && inFlight === request && request.life === lifecycle;
    const deadline = new Promise((_, reject) => {
      request.cancel = () => { request.controller.abort(); reject(new Error('Resources request cancelled')); };
      request.timer = window.setTimeout(request.cancel, 5000);
    });
    const read = Promise.resolve().then(async () => {
      const response = await fetch('/api/resources', { cache: 'no-store', credentials: 'same-origin', signal: request.controller.signal });
      if (!response.ok) throw new Error('Resources unavailable');
      return snapshot(await response.json());
    });
    // Includes the response body. A non-cooperative late transport/body settles
    // only this consumed promise; it cannot paint or clear a newer request owner.
    request.promise = Promise.race([read, deadline]).then(data => {
      if (current() && !request.controller.signal.aborted) accept(data);
    }, () => { if (current()) fail(); }).finally(() => {
      window.clearTimeout(request.timer);
      if (inFlight !== request) return;
      inFlight = null; reflectRefresh();
      if (dirty && !destroyed && !suspended && !document.hidden) { dirty = false; void refresh(); }
    });
    return request.promise;
  }
  function stopPolling() { window.clearInterval(interval); interval = 0; }
  function startPolling() {
    stopPolling();
    if (!document.hidden && !suspended && !destroyed) interval = window.setInterval(() => { void refresh(); }, 15000);
  }
  function connect() {
    if (suspended || destroyed) return;
    // Structured content notifications, same-page announce, and the existing
    // 10s revision poll are owned by this shared service. Do not create another.
    if (!unregister && window.iHearLiveContent) unregister = window.iHearLiveContent.register('content', { refresh });
    if (!channel && 'BroadcastChannel' in window) {
      try {
        channel = new BroadcastChannel('ihear-resources');
        channel.addEventListener('message', event => { if (event.data === 'updated') void refresh(); });
      } catch { channel = null; }
    }
    startPolling(); scheduleInitialGuard();
  }
  function suspend() {
    if (suspended || destroyed) return;
    suspended = true; ++lifecycle; dirty = false;
    stopPolling(); window.clearTimeout(initialTimer); initialTimer = 0;
    unregister?.(); unregister = null; channel?.close(); channel = null;
    if (inFlight) { const previous = inFlight; inFlight = null; window.clearTimeout(previous.timer); previous.cancel(); }
  }
  function resume() {
    if (destroyed) return;
    if (suspended) { suspended = false; connect(); }
    void refresh();
  }
  function destroy() {
    if (destroyed) return;
    suspend(); destroyed = true;
    removers.splice(0).forEach(remove => remove());
    delete root.dataset.cardsController;
    delete window.iHearHomeQuickCards;
  }

  cards.forEach(card => {
    // Initial HTML keeps its content slots for server/pre-paint translation.
    // After takeover these nodes represent changing states; leave the slot
    // definitions in the inert labels template, so generic content repainting
    // cannot put loading/error copy over a confirmed ready/empty result.
    for (const element of [card.title, card.summary, card.status, card.retry, card.link]) {
      element.removeAttribute('data-i18n');
      element.removeAttribute('data-editable-content');
    }
    listen(card.retry, 'click', () => { void refresh(); });
  });
  listen(window, 'ihear:language', () => cards.forEach(paint));
  listen(window, 'focus', () => { void refresh(); });
  listen(window, 'online', () => { void refresh(); });
  listen(document, 'visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { startPolling(); void refresh(); }
  });
  listen(window, 'pagehide', suspend);
  listen(window, 'pageshow', event => { if (event.persisted || suspended) resume(); });
  window.iHearHomeQuickCards = { refresh, destroy };
  root.dataset.cardsController = 'ready';
  cards.forEach(paint);
  // Install all refresh signals before the independent initial read. The first
  // shared revision is only a baseline, not evidence that these cards are fresh.
  connect(); void refresh();
})();
