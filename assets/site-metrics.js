(function () {
  "use strict";

  const valueSlots = Array.from(document.querySelectorAll("[data-site-metric-value]"));
  const plusSlots = Array.from(document.querySelectorAll("[data-site-metric-plus]"));
  const asOfSlots = Array.from(document.querySelectorAll("[data-site-metric-asof]"));
  const countryNameSlots = Array.from(
    document.querySelectorAll("[data-site-metric-country-names]"),
  );

  if (!valueSlots.length && !asOfSlots.length && !countryNameSlots.length) return;

  let currentMetrics = null;

  function localeKey() {
    const language = (document.documentElement.lang || "en").toLowerCase();
    if (language.includes("hans") || language.includes("zh-cn")) return "zhHans";
    if (language.startsWith("zh")) return "zhHant";
    return "en";
  }

  function numberLocale(key) {
    if (key === "zhHant") return "zh-TW";
    if (key === "zhHans") return "zh-CN";
    return "en-US";
  }

  function formatValue(field, includePlus) {
    const key = localeKey();
    const value = Number(currentMetrics[field] || 0);
    const plus = includePlus && Boolean(currentMetrics[`${field}Plus`]);
    return `${value.toLocaleString(numberLocale(key))}${plus ? "+" : ""}`;
  }

  function formatPeriod(period) {
    const [yearText, monthText] = String(period || "").split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    if (!year || !month) return "";
    const key = localeKey();
    if (key === "en") {
      return new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(year, month - 1, 1)));
    }
    return `${year} 年 ${month} 月`;
  }

  function formatAsOf(period) {
    const formatted = formatPeriod(period);
    if (!formatted) return "";
    return localeKey() === "en" ? `as of ${formatted}` : `截至 ${formatted}`;
  }

  function render() {
    if (!currentMetrics) return;

    valueSlots.forEach((slot) => {
      const field = slot.dataset.siteMetricValue;
      if (!field || !(field in currentMetrics)) return;
      const isAnimatedCounter = slot.hasAttribute("data-count");
      const includePlus = !isAnimatedCounter;
      slot.textContent = formatValue(field, includePlus);
      if (isAnimatedCounter) {
        slot.setAttribute("data-count", String(Number(currentMetrics[field] || 0)));
      }
    });

    plusSlots.forEach((slot) => {
      const field = slot.dataset.siteMetricPlus;
      const visible = field && Boolean(currentMetrics[`${field}Plus`]);
      slot.hidden = !visible;
      slot.textContent = visible ? "+" : "";
    });

    asOfSlots.forEach((slot) => {
      slot.textContent = formatAsOf(currentMetrics.period);
    });

    countryNameSlots.forEach((slot) => {
      const names = currentMetrics.countryNames || {};
      const text = names[localeKey()];
      if (typeof text === "string" && text.trim()) slot.textContent = text;
    });
  }

  async function load() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("/api/site-metrics", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data || !data.metrics) return;
      currentMetrics = data.metrics;
      render();
    } catch {
      // Keep the server-rendered fallback when the public metrics API is unavailable.
    } finally {
      window.clearTimeout(timeout);
    }
  }

  window.addEventListener("ihear:language", render);
  load();
})();
