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
  const fallback = {
    values: valueSlots.map((slot) => ({
      slot,
      text: slot.textContent,
      count: slot.getAttribute("data-count"),
    })),
    plus: plusSlots.map((slot) => ({ slot, text: slot.textContent, hidden: slot.hidden })),
    asOf: asOfSlots.map((slot) => ({ slot, text: slot.textContent })),
    countries: countryNameSlots.map((slot) => ({ slot, text: slot.textContent })),
  };

  function restoreFallback() {
    fallback.values.forEach(({ slot, text, count }) => {
      slot.textContent = text;
      if (count === null) slot.removeAttribute("data-count");
      else slot.setAttribute("data-count", count);
    });
    fallback.plus.forEach(({ slot, text, hidden }) => {
      slot.textContent = text;
      slot.hidden = hidden;
    });
    fallback.asOf.forEach(({ slot, text }) => { slot.textContent = text; });
    fallback.countries.forEach(({ slot, text }) => { slot.textContent = text; });
  }

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

  async function load(context) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const revision = context && context.revision ? `?live=${encodeURIComponent(context.revision)}` : "";
      const response = await fetch(`/api/site-metrics${revision}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (context) throw new Error("site metrics load failed");
        return;
      }
      const data = await response.json();
      if (!data || !data.metrics) {
        currentMetrics = null;
        restoreFallback();
        return;
      }
      currentMetrics = data.metrics;
      render();
    } catch (error) {
      // Keep the server-rendered fallback when the public metrics API is unavailable.
      if (context) throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  window.addEventListener("ihear:language", render);
  window.iHearSiteMetrics = { refresh: load };
  if (window.iHearLiveContent) {
    window.iHearLiveContent.register("impact", { refresh: load });
  }
  load();
})();
