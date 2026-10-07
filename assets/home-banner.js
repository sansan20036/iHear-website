(() => {
  'use strict';

  const root = document.querySelector('[data-home-banner]');
  const focus = root?.closest('[data-home-focus]');
  const seed = document.getElementById('ihear-home-banner');
  if (!root || !focus || !seed || window.iHearHomeBanner) return;

  const LOCALES = ['en', 'zhHant', 'zhHans'];
  const IMAGE_SIZES = '(min-width: 1160px) 762px, (min-width: 1024px) calc((100vw - 72px) * 0.7), calc(100vw - 48px)';
  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
  const string = value => { if (typeof value !== 'string') throw new Error('Invalid Banner text'); return value; };
  const translations = value => {
    if (!record(value)) throw new Error('Invalid Banner translations');
    return Object.fromEntries(LOCALES.map(key => [key, string(value[key])]));
  };
  function imageUrl(value) {
    const url = string(value);
    if (!url.startsWith('/') || url.startsWith('//') || /[\s\\\u0000-\u001f\u007f]/.test(url) || new URL(url, location.origin).origin !== location.origin) throw new Error('Invalid Banner image URL');
    return url;
  }
  function bounded(value, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error('Invalid Banner image metadata');
    return value;
  }
  function imageMetadata(value, slot) {
    if (!record(value) || value.slot !== slot || !integer(value.recordVersion) || !Array.isArray(value.variants)) throw new Error('Invalid Banner image');
    const srcSet = string(value.srcSet);
    if (!srcSet || srcSet.split(',').some(entry => {
      const match = /^(\S+) ([1-9]\d*)w$/.exec(entry.trim());
      if (!match) return true;
      imageUrl(match[1]); return false;
    })) throw new Error('Invalid Banner responsive image');
    const variants = value.variants.map(variant => {
      if (!record(variant) || !integer(variant.width, 1) || !integer(variant.pixelWidth, 1) || !integer(variant.pixelHeight, 1) || !integer(variant.byteSize) || variant.mimeType !== 'image/webp') throw new Error('Invalid Banner image variant');
      return { width: variant.width, pixelWidth: variant.pixelWidth, pixelHeight: variant.pixelHeight, byteSize: variant.byteSize, mimeType: 'image/webp', url: imageUrl(variant.url) };
    });
    const src = imageUrl(value.src);
    if (!variants.length && !(slot === 'home.hero' && src === '/assets/images/hero-classroom-1200.webp')) throw new Error('Missing Banner dimensions');
    return { slot, alt: translations(value.alt), focalX: bounded(value.focalX, 0, 100), focalY: bounded(value.focalY, 0, 100), zoom: bounded(value.zoom, 100, 250), recordVersion: value.recordVersion, updatedAt: string(value.updatedAt), src, srcSet, variants };
  }
  // Match CP3's public allowlist. A failed/malformed read is never an empty read.
  function gallerySnapshot(gallery) {
    if (!record(gallery) || gallery.id !== 'home-banner' || !integer(gallery.version) || !Array.isArray(gallery.items) || gallery.items.length > 20) throw new Error('Invalid Banner gallery');
    const ids = new Set();
    const items = gallery.items.map(item => {
      if (!record(item) || item.kind !== 'photo' || item.hidden !== false || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.assetSlot !== 'string' || !item.assetSlot || !Object.hasOwn(item, 'title')) throw new Error('Invalid Banner item');
      ids.add(item.id);
      return { id: item.id, kind: 'photo', hidden: false, assetSlot: item.assetSlot, title: item.title === null ? null : translations(item.title), caption: translations(item.caption), image: imageMetadata(item.image, item.assetSlot) };
    });
    return { schemaVersion: 1, galleryId: 'home-banner', state: items.length ? 'ready' : 'empty', version: gallery.version, updatedAt: string(gallery.updatedAt), items };
  }
  function initialSnapshot(value) {
    if (!record(value) || value.schemaVersion !== 1 || value.galleryId !== 'home-banner') throw new Error('Invalid Banner snapshot');
    if (value.state === 'error') {
      if (value.version !== null || value.updatedAt !== null || !Array.isArray(value.items) || value.items.length) throw new Error('Invalid Banner error');
      return { schemaVersion: 1, galleryId: 'home-banner', state: 'error', version: null, updatedAt: null, items: [] };
    }
    const result = gallerySnapshot({ id: value.galleryId, version: value.version, updatedAt: value.updatedAt, items: value.items });
    if (result.state !== value.state) throw new Error('Invalid Banner state');
    return result;
  }

  let snapshot;
  try { snapshot = initialSnapshot(JSON.parse(seed.textContent)); }
  catch { return; } // Leave CP3 HTML and native retry intact if takeover is impossible.

  const node = (tag, className = '') => { const element = document.createElement(tag); element.className = className; return element; };
  const locale = () => document.documentElement.lang.toLowerCase().includes('hans') ? 'zhHans' : document.documentElement.lang.startsWith('zh') ? 'zhHant' : 'en';
  const language = key => ({ en: 'en', zhHant: 'zh-Hant', zhHans: 'zh-Hans' })[key];
  const localized = (values, key = locale()) => values?.[key]?.trim() ? values[key] : values?.en?.trim() ? values.en : '';
  const textLanguage = (values, key = locale()) => language(values?.[key]?.trim() ? key : 'en');
  const labels = focus.querySelector('[data-home-banner-controls-template]');
  const label = (key, values = {}) => {
    const source = labels?.content.querySelector(`[data-home-banner-label="${key}"]`);
    const translated = source && window.iHearPublishedContent?.valueFor(source, locale());
    return String(translated ?? source?.textContent ?? '').replace(/\{(current|total)\}/g, (match, name) => values[name] ?? match);
  };
  // Treat a missing source template as an initialization failure, not an excuse
  // to replace readable SSR with incomplete or unnamed controls.
  if (!labels || ['previous', 'next', 'choose', 'counter', 'region', 'changed', 'refreshError', 'retry'].some(key => !label(key))) return;

  let activeId = snapshot.items.some(item => item.id === root.dataset.activeId) ? root.dataset.activeId : snapshot.items[0]?.id || '';
  let contentSignature = JSON.stringify(snapshot.items);
  let snapshotGeneration = 0, selectionGeneration = 0, lifecycleGeneration = 0;
  let requestSequence = 0, inFlight = null, dirty = false;
  let suspended = false, destroyed = false, timer = 0, channel = null, unregister = null;
  let gesture = null;
  const removers = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  const controls = node('div', 'home-banner__controls');
  controls.hidden = true;
  const previous = node('button', 'home-banner__arrow'); previous.type = 'button'; previous.dataset.homeBannerPrevious = ''; previous.textContent = '‹';
  const next = node('button', 'home-banner__arrow'); next.type = 'button'; next.dataset.homeBannerNext = ''; next.textContent = '›';
  const selection = node('div', 'home-banner__selection');
  const counter = node('span', 'home-banner__counter'); counter.dataset.homeBannerCounter = '';
  const dots = node('div', 'home-banner__dots');
  selection.append(counter, dots); controls.append(previous, selection, next);
  const status = node('span', 'home-focus__sr-only'); status.dataset.homeBannerStatus = ''; status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const refreshNotice = node('div', 'home-banner__refresh'); refreshNotice.hidden = true;
  const refreshMessage = node('span', 'home-focus__sr-only'); refreshMessage.dataset.homeBannerRefreshMessage = ''; refreshMessage.id = 'home-banner-refresh-description';
  const refreshRetry = node('button'); refreshRetry.type = 'button'; refreshRetry.dataset.homeBannerRefreshRetry = '';
  refreshRetry.setAttribute('aria-describedby', refreshMessage.id);
  refreshNotice.append(refreshMessage, refreshRetry);

  root.dataset.bannerController = 'ready';
  root.tabIndex = -1;
  root.setAttribute('role', 'region');
  root.append(controls, status, refreshNotice);
  const selectedItem = () => snapshot.items.find(item => item.id === activeId);
  function write(element, value) { if (element.textContent !== value) element.textContent = value; }
  function focusFallback(previousFocus) {
    if (!previousFocus || previousFocus === document.body) return;
    if (snapshot.state === 'ready') {
      if (previousFocus.isConnected && !previousFocus.closest('[hidden]')) {
        if (document.activeElement !== previousFocus) previousFocus.focus({ preventScroll: true });
      } else (snapshot.items.length > 1 ? next : root).focus({ preventScroll: true });
    } else focus.querySelector('[data-home-quick-cards] a')?.focus({ preventScroll: true });
  }
  function paintText(element, values, key = locale(), attribute = false) {
    const value = localized(values, key);
    if (attribute) element.setAttribute('alt', value);
    else { write(element, value); element.hidden = !value; }
    element.lang = textLanguage(values, key);
  }
  function copyFor(item, key) {
    const copy = node('div', 'home-banner__text');
    const title = node('h3'), caption = node('p');
    paintText(title, item.title, key); paintText(caption, item.caption, key);
    copy.hidden = !localized(item.title, key) && !localized(item.caption, key);
    copy.append(title, caption); return copy;
  }
  function ensureVisual() {
    root.querySelector('.home-banner__error')?.remove();
    let frame = root.querySelector('.home-banner__image');
    if (!frame) { frame = node('div', 'home-banner__image'); root.insertBefore(frame, controls); }
    let failure = frame.querySelector('[data-home-banner-image-error]');
    if (!failure) { failure = node('div', 'home-banner__image-error'); failure.dataset.homeBannerImageError = ''; failure.hidden = true; frame.append(failure); }
    let copy = root.querySelector('.home-banner__copy');
    if (!copy) {
      copy = node('div', 'home-banner__copy');
      const visible = node('div', 'home-banner__text');
      const title = node('h3'), caption = node('p'); title.dataset.homeBannerField = 'title'; caption.dataset.homeBannerField = 'caption';
      visible.append(title, caption);
      const reserve = node('div', 'home-banner__reserve'); reserve.setAttribute('aria-hidden', 'true');
      copy.append(visible, reserve); root.insertBefore(copy, controls);
    }
    return { frame, failure, copy };
  }
  function rebuildReserve() {
    const { copy } = ensureVisual();
    const hasCopy = snapshot.items.some(item => LOCALES.some(key => localized(item.title, key) || localized(item.caption, key)));
    copy.hidden = !hasCopy;
    copy.querySelector('.home-banner__reserve').replaceChildren(...snapshot.items.flatMap(item => LOCALES.map(key => copyFor(item, key))));
  }
  function updateCopy() {
    const item = selectedItem();
    if (!item) return;
    const title = root.querySelector('[data-home-banner-field="title"]');
    const caption = root.querySelector('[data-home-banner-field="caption"]');
    const image = root.querySelector('[data-home-banner-image]');
    if (title) paintText(title, item.title);
    if (caption) paintText(caption, item.caption);
    if (title?.parentElement) title.parentElement.hidden = !localized(item.title) && !localized(item.caption);
    if (image) paintText(image, item.image.alt, locale(), true);
  }
  function updateLabels() {
    root.setAttribute('aria-label', label('region'));
    previous.setAttribute('aria-label', label('previous')); next.setAttribute('aria-label', label('next'));
    write(refreshMessage, label('refreshError'));
    write(refreshRetry, label(root.dataset.refreshState === 'refreshing' ? 'refreshing' : 'retry'));
    const position = { current: Math.max(1, snapshot.items.findIndex(item => item.id === activeId) + 1), total: snapshot.items.length };
    write(counter, label('counter', position));
    refreshRetry.setAttribute('aria-label', `${refreshRetry.textContent}. ${label('counter', position)}`);
    [...dots.children].forEach((button, index) => {
      button.setAttribute('aria-label', label('choose', { current: index + 1, total: snapshot.items.length }));
      button.setAttribute('aria-current', button.dataset.id === activeId ? 'true' : 'false');
    });
    const failure = root.querySelector('[data-home-banner-image-error]');
    if (failure) write(failure, label('imageError'));
    updateCopy();
  }
  function updateControls() {
    const existing = new Map([...dots.children].map(button => [button.dataset.id, button]));
    const ids = new Set(snapshot.items.map(item => item.id));
    [...dots.children].filter(button => !ids.has(button.dataset.id)).forEach(button => button.remove());
    snapshot.items.forEach((item, index) => {
      let button = existing.get(item.id);
      if (!button) {
        button = node('button', 'home-banner__dot'); button.type = 'button'; button.dataset.homeBannerDot = ''; button.dataset.id = item.id;
        const mark = node('span'); mark.setAttribute('aria-hidden', 'true'); button.append(mark);
      }
      if (dots.children[index] !== button) dots.insertBefore(button, dots.children[index] || null);
    });
    controls.hidden = snapshot.state !== 'ready' || snapshot.items.length < 2;
    updateLabels();
  }
  const imageIdentity = item => JSON.stringify([item.id, item.assetSlot, item.image.recordVersion, item.image.src, item.image.srcSet]);
  function observeImage(image, item, initial = false) {
    const token = ++selectionGeneration, generation = snapshotGeneration, life = lifecycleGeneration;
    const identity = imageIdentity(item);
    const current = () => !destroyed && !suspended && token === selectionGeneration && generation === snapshotGeneration && life === lifecycleGeneration && selectedItem()?.id === item.id && imageIdentity(selectedItem()) === identity && root.querySelector('[data-home-banner-image]') === image;
    const settle = failed => {
      if (!current()) return;
      root.dataset.imageState = failed ? 'error' : 'ready';
      root.querySelector('[data-home-banner-image-error]').hidden = !failed;
      root.removeAttribute('aria-busy');
    };
    if (initial && image.complete) { settle(image.naturalWidth === 0); return; }
    if (!initial) { root.dataset.imageState = 'loading'; root.setAttribute('aria-busy', 'true'); }
    // The new DOM has already replaced a withdrawn photo. Decoding only changes
    // loading/error presentation; it can never append or resurrect an old item.
    if (typeof image.decode === 'function') Promise.resolve().then(() => image.decode()).then(() => settle(false), () => settle(true));
    else {
      image.addEventListener('load', () => settle(false), { once: true });
      image.addEventListener('error', () => settle(true), { once: true });
      if (image.complete) settle(image.naturalWidth === 0);
    }
  }
  function paintSelection(manual = false, preserveImage = false) {
    const item = selectedItem();
    if (!item) return;
    const { frame, failure } = ensureVisual();
    let image = frame.querySelector('[data-home-banner-image]');
    if (!preserveImage || !image) {
      // Remove the previous image synchronously, before assigning replacement
      // URLs or awaiting decode. Text/controls use this same accepted selection.
      image?.remove(); failure.hidden = true;
      image = new Image(); image.dataset.homeBannerImage = ''; image.dataset.homeBannerField = 'alt';
      image.decoding = 'async'; image.loading = 'eager'; image.fetchPriority = 'auto'; image.sizes = IMAGE_SIZES;
      const largest = item.image.variants.reduce((current, variant) => !current || variant.pixelWidth > current.pixelWidth ? variant : current, null);
      image.width = largest?.pixelWidth || 1200; image.height = largest?.pixelHeight || 799;
      paintText(image, item.image.alt, locale(), true);
      image.srcset = item.image.srcSet; image.src = item.image.src;
      frame.insertBefore(image, failure);
    }
    root.dataset.activeId = activeId;
    updateLabels(); observeImage(image, item, preserveImage);
    if (manual) write(status, label('changed', { current: snapshot.items.findIndex(candidate => candidate.id === activeId) + 1, total: snapshot.items.length }));
  }
  function select(id, manual = false) {
    if (destroyed || suspended || activeId === id || !snapshot.items.some(item => item.id === id)) return;
    activeId = id; paintSelection(manual);
  }
  function step(direction) {
    if (snapshot.items.length < 2) return;
    const index = snapshot.items.findIndex(item => item.id === activeId);
    select(snapshot.items[(index + direction + snapshot.items.length) % snapshot.items.length].id, true);
  }
  function accept(nextSnapshot) {
    if (snapshot.version !== null && nextSnapshot.version < snapshot.version) return false;
    const signature = JSON.stringify(nextSnapshot.items);
    const changed = signature !== contentSignature || snapshot.state !== nextSnapshot.state;
    const oldItem = selectedItem();
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    snapshot = nextSnapshot; contentSignature = signature;
    root.dataset.galleryVersion = String(snapshot.version);
    root.dataset.refreshState = 'fresh'; refreshNotice.hidden = true;
    // Keep the embedded public state current too: removed IDs/URLs do not linger
    // in the controller's input node or a consumed SSR preload link.
    seed.textContent = JSON.stringify(snapshot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    if (!changed) { updateLabels(); focusFallback(focused); return true; }
    ++snapshotGeneration; ++selectionGeneration; gesture = null;
    status.textContent = '';
    document.querySelector('[data-home-banner-preload]')?.remove();
    focus.dataset.bannerState = snapshot.state;
    root.hidden = snapshot.state === 'empty';
    activeId = snapshot.items.some(item => item.id === activeId) ? activeId : snapshot.items[0]?.id || '';
    root.dataset.activeId = activeId;
    if (snapshot.state === 'empty') {
      root.querySelector('.home-banner__image')?.remove(); root.querySelector('.home-banner__copy')?.remove(); root.querySelector('.home-banner__error')?.remove();
      root.removeAttribute('aria-busy'); delete root.dataset.imageState;
    } else {
      const preserveImage = oldItem && oldItem.id === activeId && imageIdentity(oldItem) === imageIdentity(selectedItem());
      rebuildReserve(); paintSelection(false, preserveImage);
    }
    updateControls();
    // A detached button cannot be found with contains() after reconciliation.
    // Restore only when the previously focused Banner node was affected.
    focusFallback(focused);
    return true;
  }
  function failed() {
    root.dataset.refreshState = 'stale';
    refreshNotice.hidden = snapshot.state !== 'ready';
    updateLabels();
  }
  function refresh() {
    if (destroyed || suspended) return Promise.resolve();
    if (document.hidden) { dirty = true; return Promise.resolve(); }
    if (inFlight) { dirty = true; return inFlight.promise; }
    dirty = false;
    const request = { id: ++requestSequence, life: lifecycleGeneration, controller: new AbortController(), timer: 0, cancel: null, promise: null };
    inFlight = request;
    root.dataset.refreshState = 'refreshing';
    updateLabels();
    const valid = () => !destroyed && !suspended && inFlight === request && request.life === lifecycleGeneration;
    const deadline = new Promise((_, reject) => {
      request.cancel = () => { request.controller.abort(); reject(new Error('Banner request cancelled')); };
      request.timer = window.setTimeout(request.cancel, 5000);
    });
    const read = Promise.resolve().then(async () => {
      const response = await fetch('/api/media-galleries?gallery_id=home-banner', { cache: 'no-store', credentials: 'same-origin', signal: request.controller.signal });
      if (!response.ok) throw new Error('Banner unavailable');
      const data = await response.json();
      if (!record(data) || !Array.isArray(data.items) || data.items.length !== 1) throw new Error('Invalid Banner response');
      return gallerySnapshot(data.items[0]);
    });
    // Racing the complete body read also bounds browsers/mocks that finish a
    // response after abort. Late completion is consumed, never allowed to render.
    request.promise = Promise.race([read, deadline]).then(value => {
      if (valid() && !request.controller.signal.aborted) {
        if (!accept(value)) failed();
      }
    }, () => { if (valid()) failed(); }).finally(() => {
      window.clearTimeout(request.timer);
      if (inFlight !== request) return;
      inFlight = null;
      if (dirty && !destroyed && !suspended && !document.hidden) { dirty = false; void refresh(); }
    });
    return request.promise;
  }
  function stopPolling() { window.clearInterval(timer); timer = 0; }
  function startPolling() {
    stopPolling();
    if (!document.hidden && !suspended && !destroyed) timer = window.setInterval(() => { void refresh(); }, 15000);
  }
  function connect() {
    if (destroyed || suspended) return;
    if (!unregister && window.iHearLiveContent) unregister = window.iHearLiveContent.register('content', { refresh });
    if (!channel && 'BroadcastChannel' in window) {
      try {
        channel = new BroadcastChannel('ihear-media-galleries');
        channel.addEventListener('message', event => { if (event.data === 'updated') void refresh(); });
      } catch { channel = null; } // Direct polling remains available.
    }
    startPolling();
  }
  function disconnect() {
    stopPolling(); unregister?.(); unregister = null; channel?.close(); channel = null; gesture = null;
  }
  function suspend() {
    if (suspended || destroyed) return;
    suspended = true; ++lifecycleGeneration; ++selectionGeneration; dirty = false;
    disconnect();
    if (inFlight) { const previousRequest = inFlight; inFlight = null; window.clearTimeout(previousRequest.timer); previousRequest.cancel(); }
  }
  function resume() {
    if (destroyed) return;
    if (suspended) {
      suspended = false; connect();
      const item = selectedItem(), image = root.querySelector('[data-home-banner-image]');
      if (item && image) observeImage(image, item, true);
    }
    void refresh();
  }
  function destroy() {
    if (destroyed) return;
    suspend(); destroyed = true;
    removers.splice(0).forEach(remove => remove());
    controls.remove(); status.remove(); refreshNotice.remove();
    delete root.dataset.bannerController;
    delete window.iHearHomeBanner;
  }

  listen(previous, 'click', () => step(-1)); listen(next, 'click', () => step(1));
  listen(dots, 'click', event => { const button = event.target.closest('[data-home-banner-dot]'); if (button && dots.contains(button)) select(button.dataset.id, true); });
  listen(refreshRetry, 'click', () => { void refresh(); });
  listen(root, 'click', event => {
    const retry = event.target.closest('[data-home-banner-retry]');
    if (retry && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); void refresh(); }
  });
  listen(root, 'keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select, a, [contenteditable="true"]') || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || snapshot.items.length < 2) return;
    event.preventDefault(); step(event.key === 'ArrowRight' ? 1 : -1);
  });
  listen(root, 'pointerdown', event => {
    if (!event.isPrimary) { gesture = null; return; }
    if (!['touch', 'pen'].includes(event.pointerType) || event.target.closest('button, a, input, textarea, select') || snapshot.items.length < 2) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now() };
  }, { passive: true });
  listen(root, 'pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const x = Math.abs(event.clientX - gesture.x), y = Math.abs(event.clientY - gesture.y);
    if (y > 10 && y > x) gesture = null;
  }, { passive: true });
  listen(root, 'pointerup', event => {
    const start = gesture; gesture = null;
    if (!start || start.id !== event.pointerId) return;
    const x = event.clientX - start.x, y = event.clientY - start.y;
    if (Math.abs(x) >= 50 && Math.abs(x) > Math.abs(y) * 1.5 && Date.now() - start.time < 1000) step(x < 0 ? 1 : -1);
  }, { passive: true });
  listen(root, 'pointercancel', () => { gesture = null; }, { passive: true });
  listen(root, 'lostpointercapture', () => { gesture = null; }, { passive: true });
  listen(window, 'ihear:language', () => {
    updateLabels();
    if (status.textContent) write(status, label('changed', { current: snapshot.items.findIndex(item => item.id === activeId) + 1, total: snapshot.items.length }));
  });
  listen(window, 'focus', () => { void refresh(); });
  listen(window, 'online', () => { void refresh(); });
  listen(window, 'resize', () => { gesture = null; }, { passive: true });
  listen(document, 'visibilitychange', () => {
    gesture = null;
    if (document.hidden) stopPolling();
    else { startPolling(); void refresh(); }
  });
  listen(window, 'message', event => {
    if (event.origin !== location.origin || event.data?.type !== 'ihear:gallery-editor-saved') return;
    if ([...document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source)) void refresh();
  });
  listen(window, 'pagehide', suspend);
  listen(window, 'pageshow', event => { if (event.persisted || suspended) resume(); });
  window.iHearHomeBanner = { refresh, destroy };

  root.dataset.activeId = activeId;
  if (snapshot.version !== null) root.dataset.galleryVersion = String(snapshot.version);
  root.dataset.refreshState = snapshot.state === 'error' ? 'stale' : 'fresh';
  updateControls();
  const initialImage = root.querySelector('[data-home-banner-image]');
  if (initialImage && selectedItem()) observeImage(initialImage, selectedItem(), true);
  // Register every signal before the unconditional initial calibration. The
  // shared revision's first baseline is deliberately not treated as sync proof.
  connect(); void refresh();
})();
