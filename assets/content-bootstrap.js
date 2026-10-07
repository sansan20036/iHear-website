(function () {
  "use strict";
  const node = document.getElementById("ihear-published-content");
  if (!node) return;
  const seed = JSON.parse(node.textContent);
  const definitions = new Map(seed.slots.map(slot => [`${slot.page}\u0000${slot.key}`, slot]));
  let store = seed.store;
  let language = "";
  try { language = localStorage.getItem("ihear-lang") || ""; } catch {}
  if (!["en", "zhTW", "zhCN"].includes(language)) {
    const browserLanguage = navigator.language || "en";
    language = /^zh/i.test(browserLanguage) ? (/tw|hk|mo|hant/i.test(browserLanguage) ? "zhTW" : "zhCN") : "en";
  }
  const initialLocale = { en: "en", zhTW: "zhHant", zhCN: "zhHans" }[language];
  const htmlLanguage = locale => locale === "zhHant" ? "zh-Hant" : locale === "zhHans" ? "zh-Hans" : "en";
  document.documentElement.lang = htmlLanguage(initialLocale);
  // Banner JSON is produced from the same request-time public read as the HTML.
  // No network read or gallery takeover is needed to apply a browser preference.
  let banner = null;
  try {
    const snapshot = JSON.parse(document.getElementById("ihear-home-banner")?.textContent || "null");
    if (snapshot?.state === "ready" && Array.isArray(snapshot.items)) banner = snapshot.items[0] || null;
  } catch { /* Keep the server-rendered content if an unrelated script damaged the JSON. */ }
  function applyBanner(locale) {
    // Once enhanced, the controller owns the currently selected public item.
    // Never put the original SSR item's text back after a refresh or selection.
    const root = document.querySelector('[data-home-banner]');
    if (root?.dataset.bannerController === 'ready') return;
    // An explicit controller teardown can leave its newer, readable DOM in
    // place. Use that accepted public snapshot, not the initial SSR closure.
    if (root?.hasAttribute('data-gallery-version')) {
      try {
        const current = JSON.parse(document.getElementById('ihear-home-banner')?.textContent || 'null');
        banner = current?.state === 'ready' && Array.isArray(current.items)
          ? current.items.find(item => item.id === root.dataset.activeId) || null : null;
      } catch { return; }
    }
    if (!banner) return;
    document.querySelectorAll("[data-home-banner] [data-home-banner-field]").forEach(element => {
      const field = element.dataset.homeBannerField;
      const values = field === "alt" ? banner.image?.alt : field === "title" ? banner.title : field === "caption" ? banner.caption : null;
      const translated = typeof values?.[locale] === "string" && values[locale].trim() ? values[locale] : "";
      const value = translated || (typeof values?.en === "string" ? values.en : "");
      if (field === "alt") { element.setAttribute("alt", value); element.lang = htmlLanguage(translated ? locale : "en"); return; }
      if (element.textContent !== value) element.textContent = value;
      element.hidden = !value.trim();
      element.lang = htmlLanguage(translated ? locale : "en");
    });
    const title = document.querySelector('[data-home-banner-field="title"]');
    const caption = document.querySelector('[data-home-banner-field="caption"]');
    const text = title?.closest('.home-banner__text');
    if (text) text.hidden = Boolean(title.hidden && caption?.hidden);
  }
  function reflectBannerImage(image) {
    if (!(image instanceof HTMLImageElement) || !image.matches("[data-home-banner-image]") || !image.complete) return;
    const root = image.closest("[data-home-banner]");
    if (!root) return;
    if (root.dataset.bannerController === "ready") return;
    const failed = image.naturalWidth === 0;
    root.dataset.imageState = failed ? "error" : "ready";
    const message = root.querySelector("[data-home-banner-image-error]");
    if (message) message.hidden = !failed;
  }
  // Listen during parsing, including errors that occur before DOMContentLoaded.
  // This only reveals the SSR fallback; it does not replace or refetch the image.
  document.addEventListener("error", event => reflectBannerImage(event.target), true);
  document.addEventListener("load", event => reflectBannerImage(event.target), true);
  function valueFor(element, locale) {
    if (element.hasAttribute("data-published-metric")) return seed.metricText?.[element.dataset.publishedMetric]?.[locale];
    const page = element.dataset.editablePage || seed.page;
    const key = element.dataset.editableContent;
    return store.locales?.[locale]?.pages?.[page]?.[key] ?? definitions.get(`${page}\u0000${key}`)?.values[locale];
  }
  function apply(element) {
    const value = valueFor(element, initialLocale);
    if (value == null) return;
    // Preserve nested links, icons and screen-reader notices.
    const texts = Array.from(element.childNodes).filter(child => child.nodeType === Node.TEXT_NODE);
    const target = texts.find(child => child.nodeValue.trim()) || texts[0];
    if (target) {
      if (target.nodeValue !== value) target.nodeValue = value;
      texts.filter(child => child !== target).forEach(child => { child.nodeValue = ""; });
    }
  }
  // The server already renders the cookie/header locale. Apply a saved browser
  // preference as the HTML is parsed, before paint, without hiding the page.
  const observer = new MutationObserver(() => {
    observer.disconnect();
    document.querySelectorAll("[data-editable-content], [data-published-metric]").forEach(apply);
    applyBanner(initialLocale);
    document.querySelectorAll("[data-home-banner-image]").forEach(reflectBannerImage);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  applyBanner(initialLocale);
  document.addEventListener("DOMContentLoaded", () => observer.disconnect(), { once: true });
  window.addEventListener("ihear:language", event => {
    const locale = event.detail?.locale;
    if (["en", "zhHant", "zhHans"].includes(locale)) applyBanner(locale);
  });
  window.iHearPublishedContent = { store, slots: seed.slots, metrics: seed.metrics, valueFor, update(latest) { store = latest; this.store = latest; } };
})();
