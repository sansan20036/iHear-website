(() => {
  const roots = [...document.querySelectorAll('[data-media-gallery]')];
  if (!roots.length) return;
  const locale = () => document.documentElement.lang.toLowerCase().includes('hans') ? 'zhHans' : document.documentElement.lang.startsWith('zh') ? 'zhHant' : 'en';
  const text = () => ({ en: { previous: 'Previous', next: 'Next', play: 'Play video', open: 'Watch on YouTube', retry: 'Could not load media. Retry', photo: 'Photo', video: 'Video' }, zhHant: { previous: '上一個', next: '下一個', play: '播放影片', open: '在 YouTube 開啟', retry: '無法載入媒體，點此重試', photo: '照片', video: '影片' }, zhHans: { previous: '上一个', next: '下一个', play: '播放视频', open: '在 YouTube 打开', retry: '无法加载媒体，点击重试', photo: '照片', video: '视频' } })[locale()];
  const localized = value => value?.[locale()] || value?.en || '';
  const node = (tag, cls, content) => { const el = document.createElement(tag); if (cls) el.className = cls; if (content) el.textContent = content; return el; };
  const controllers = roots.map(root => {
    let items = [], selected = '', generation = 0, signature = '', playing = false;
    const frame = node('div', 'gallery-frame');
    const caption = node('p', 'gallery-caption');
    const controls = node('div', 'gallery-controls');
    const previous = node('button', 'gallery-arrow');
    const next = node('button', 'gallery-arrow');
    previous.type = next.type = 'button';
    const counter = node('span', 'gallery-counter');
    counter.setAttribute('aria-live', 'polite');
    const thumbnails = node('div', 'gallery-thumbnails');
    const external = node('a', 'gallery-external');
    external.target = '_blank'; external.rel = 'noopener noreferrer'; external.hidden = true;
    controls.append(previous, counter, next);
    root.replaceChildren(frame, caption, external, controls, thumbnails);
    root.classList.add('media-gallery');
    const labels = () => {
      previous.textContent = '‹'; next.textContent = '›';
      previous.setAttribute('aria-label', text().previous); next.setAttribute('aria-label', text().next);
      external.textContent = text().open;
      thumbnails.setAttribute('aria-label', locale() === 'en' ? 'Media selection' : '選擇媒體');
    };
    async function select(id, force = false) {
      const item = items.find(i => i.id === id);
      if (!item || (selected === id && !force)) return;
      const token = ++generation;
      frame.setAttribute('aria-busy', 'true');
      // Stop sound immediately, even when the next photo is still downloading.
      if (playing) { frame.replaceChildren(); playing = false; }
      let visual;
      if (item.kind === 'photo') {
        const image = new Image();
        image.alt = localized(item.image?.alt);
        image.decoding = 'async'; image.fetchPriority = 'high';
        image.sizes = '(max-width: 900px) calc(100vw - 48px), 800px';
        if (item.image?.srcSet) image.srcset = item.image.srcSet;
        image.src = item.image?.src || '';
        try { await image.decode(); }
        catch {
          if (token !== generation) return;
          frame.removeAttribute('aria-busy');
          let retry = root.querySelector('.gallery-error');
          if (!retry) { retry = node('button', 'gallery-error'); retry.type = 'button'; root.append(retry); }
          retry.textContent = text().retry; retry.onclick = () => { void select(id, true); };
          return;
        }
        visual = image;
      } else {
        const button = node('button', 'gallery-video-cover'); button.type = 'button';
        button.setAttribute('aria-label', text().play);
        const cover = new Image(); cover.src = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`; cover.alt = '';
        cover.onerror = () => { cover.style.visibility = 'hidden'; };
        const icon = node('span', 'gallery-play', '▶'); icon.setAttribute('aria-hidden', 'true');
        button.append(cover, icon);
        button.onclick = () => {
          if (selected !== id) return;
          const iframe = node('iframe');
          iframe.src = `https://www.youtube-nocookie.com/embed/${item.videoId}?autoplay=1&playsinline=1`;
          iframe.title = localized(item.caption) || text().video;
          iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
          iframe.allowFullscreen = true; iframe.referrerPolicy = 'strict-origin-when-cross-origin';
          frame.replaceChildren(iframe); playing = true;
        };
        visual = button;
      }
      if (token !== generation) return;
      root.querySelector('.gallery-error')?.remove();
      frame.replaceChildren(visual); frame.removeAttribute('aria-busy'); selected = id;
      caption.textContent = localized(item.caption); caption.hidden = !caption.textContent;
      external.hidden = item.kind !== 'youtube';
      if (item.kind === 'youtube') external.href = `https://www.youtube.com/watch?v=${item.videoId}`;
      const index = items.findIndex(i => i.id === id);
      counter.textContent = `${index + 1} / ${items.length}`;
      previous.disabled = index <= 0; next.disabled = index >= items.length - 1;
      [...thumbnails.children].forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === id)));
    }
    const step = direction => { const index = items.findIndex(i => i.id === selected); const item = items[index + direction]; if (item) void select(item.id); };
    previous.onclick = () => step(-1); next.onclick = () => step(1);
    thumbnails.addEventListener('keydown', event => {
      const buttons = [...thumbnails.children];
      const index = buttons.indexOf(document.activeElement);
      const target = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : -1;
      if (buttons[target]) { event.preventDefault(); buttons[target].focus(); buttons[target].click(); }
    });
    function update(gallery, force = false) {
      const nextSignature = JSON.stringify([gallery?.items, locale()]);
      if (nextSignature === signature && !force) return;
      signature = nextSignature; ++generation;
      items = gallery?.items || [];
      const section = root.closest('[data-gallery-section]');
      if (section) section.hidden = !items.length; else root.hidden = !items.length;
      if (!items.length) { frame.replaceChildren(); playing = false; selected = ''; return; }
      labels(); thumbnails.replaceChildren();
      items.forEach((item, index) => {
        const button = node('button', 'gallery-thumb'); button.type = 'button'; button.dataset.id = item.id;
        button.setAttribute('aria-label', `${item.kind === 'photo' ? text().photo : text().video} ${index + 1}: ${localized(item.caption) || localized(item.image?.alt)}`);
        const image = new Image(); image.loading = 'lazy'; image.alt = '';
        image.onerror = () => { image.style.visibility = 'hidden'; };
        image.src = item.kind === 'photo' ? item.image?.variants?.[0]?.url || item.image?.src || '' : `https://i.ytimg.com/vi/${item.videoId}/default.jpg`;
        button.append(image);
        if (item.kind === 'youtube') button.append(node('span', '', '▶'));
        button.onclick = () => { void select(item.id); };
        thumbnails.append(button);
      });
      controls.hidden = thumbnails.hidden = items.length < 2;
      const current = items.find(i => i.id === selected) || items[0];
      void select(current.id, true);
    }
    return { id: root.dataset.mediaGallery, update, error() {
      if (items.length) return;
      const retry = node('button', 'gallery-error', text().retry); retry.type = 'button'; retry.onclick = refresh;
      frame.replaceChildren(retry);
    } };
  });
  let fetching = false, last = [];
  async function refresh() {
    if (fetching || document.hidden) return;
    fetching = true;
    try {
      const response = await fetch('/api/media-galleries', { cache: 'no-store' });
      if (!response.ok) throw new Error('Gallery unavailable');
      const data = await response.json(); last = data.items;
      controllers.forEach(c => c.update(last.find(g => g.id === c.id)));
    } catch { controllers.forEach(c => c.error()); }
    finally { fetching = false; }
  }
  window.addEventListener('ihear:language', () => controllers.forEach(c => c.update(last.find(g => g.id === c.id))));
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.iHearLiveContent?.register('content', { refresh });
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel('ihear-media-galleries');
    channel.addEventListener('message', refresh);
  }
  setInterval(refresh, 15_000);
  void refresh();
})();
