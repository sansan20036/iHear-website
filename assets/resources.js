(() => {
  const root = document.querySelector('[data-resource-links]');
  if (!root) return;
  const copy = {
    en: { heading: 'Forms & useful links', intro: 'Find registration forms, session reflections and scheduling links here.', loading: 'Loading resources…', error: 'Resources could not be loaded.', retry: 'Try again', empty: 'There are no published forms yet.', manage: 'Manage forms / links', external: 'opens in a new tab' },
    zhHant: { heading: '表單／常用連結', intro: '在這裡查找報名、課後反思及授課時間登記等表單。', loading: '資源載入中…', error: '資源載入失敗。', retry: '重新載入', empty: '目前沒有公開表單。', manage: '管理表單／連結', external: '另開新分頁' },
    zhHans: { heading: '表单／常用链接', intro: '在这里查找报名、课后反思及授课时间登记等表单。', loading: '资源加载中…', error: '资源加载失败。', retry: '重新加载', empty: '目前没有公开表单。', manage: '管理表单／链接', external: '另开新分页' },
  };
  const lang = () => document.documentElement.lang === 'zh-Hant' || document.documentElement.lang === 'zh-TW' ? 'zhHant' : document.documentElement.lang === 'zh-Hans' || document.documentElement.lang === 'zh-CN' ? 'zhHans' : 'en';
  const localized = value => value?.[lang()] || value?.en || '';
  const heading = root.querySelector('h1'), intro = root.querySelector('[data-resource-intro]');
  const list = root.querySelector('ul'), status = root.querySelector('[role="status"]'), retry = root.querySelector('[data-resource-retry]'), manage = root.querySelector('[data-resource-manage]');
  let items = null, failed = false, fetching = false, pending = false, rendered = '';
  function render() {
    const text = copy[lang()]; heading.textContent = text.heading; intro.textContent = text.intro; manage.textContent = text.manage; retry.textContent = text.retry;
    status.textContent = failed ? text.error : items === null ? text.loading : items.length ? '' : text.empty;
    retry.hidden = !failed;
    if (!items) return;
    const signature = JSON.stringify([lang(), items]);
    if (signature === rendered) return;
    rendered = signature;
    list.replaceChildren();
    for (const item of items) {
      let url;
      try { url = new URL(item.url); if (url.protocol !== 'https:' || url.username || url.password) continue; } catch { continue; }
      const row = document.createElement('li'), link = document.createElement('a'), hint = document.createElement('span');
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = localized(item.title);
      hint.className = 'resource-external'; hint.textContent = ` ↗ (${text.external})`; link.append(hint); row.append(link);
      const description = localized(item.description);
      if (description) { const paragraph = document.createElement('p'); paragraph.textContent = description; row.append(paragraph); }
      list.append(row);
    }
  }
  async function refresh() {
    if (document.hidden) return;
    if (fetching) { pending = true; return; }
    fetching = true;
    try {
      const response = await fetch('/api/resources', { cache: 'no-store' });
      if (!response.ok) throw new Error('Resources unavailable');
      const data = await response.json(); if (!Array.isArray(data.items)) throw new Error('Invalid resources');
      items = data.items; failed = false;
    } catch { failed = true; }
    finally { fetching = false; render(); if (pending) { pending = false; void refresh(); } }
  }
  manage.hidden = !window.iHearAuth?.getSession()?.user?.isAdmin;
  retry.addEventListener('click', refresh);
  window.addEventListener('ihear:language', render);
  window.addEventListener('ihear:auth', event => { manage.hidden = !event.detail?.session?.user?.isAdmin || Boolean(event.detail?.error); });
  window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
  window.iHearLiveContent?.register('content', { refresh });
  if ('BroadcastChannel' in window) new BroadcastChannel('ihear-resources').addEventListener('message', refresh);
  setInterval(refresh, 15000);
  render(); void refresh();
})();
