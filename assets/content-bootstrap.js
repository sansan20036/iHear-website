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
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener("DOMContentLoaded", () => observer.disconnect(), { once: true });
  window.iHearPublishedContent = { store, slots: seed.slots, metrics: seed.metrics, valueFor, update(latest) { store = latest; this.store = latest; } };
})();
