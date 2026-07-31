(function () {
  "use strict";

  const valueSlots = Array.from(document.querySelectorAll("[data-site-metric-value]"));
  const plusSlots = Array.from(document.querySelectorAll("[data-site-metric-plus]"));
  const asOfSlots = Array.from(document.querySelectorAll("[data-site-metric-asof]"));
  const countryNameSlots = Array.from(
    document.querySelectorAll("[data-site-metric-country-names]"),
  );
  const latestCards = Array.from(document.querySelectorAll("[data-latest-impact]"));
  const latestLabelSlots = Array.from(document.querySelectorAll("[data-latest-impact-label]"));
  const latestPeriodSlots = Array.from(document.querySelectorAll("[data-latest-impact-period]"));
  const latestHeadlineSlots = Array.from(document.querySelectorAll("[data-latest-impact-headline]"));
  const latestDescriptionSlots = Array.from(document.querySelectorAll("[data-latest-impact-description]"));
  const latestLinkSlots = Array.from(document.querySelectorAll("[data-latest-impact-link]"));

  if (!valueSlots.length && !asOfSlots.length && !countryNameSlots.length && !latestCards.length) return;

  const latestLabels = {
    en: {
      label: "Latest impact",
      link: "View our journey →",
      volunteers: "volunteers",
      students: "students",
      sessions: "sessions",
    },
    zhHant: {
      label: "最新成果",
      link: "查看我們的歷程 →",
      volunteers: "位志工",
      students: "位學生",
      sessions: "堂課",
    },
    zhHans: {
      label: "最新成果",
      link: "查看我们的历程 →",
      volunteers: "位志愿者",
      students: "位学生",
      sessions: "节课",
    },
  };

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
    latestLabels: latestLabelSlots.map((slot) => ({ slot, text: slot.textContent })),
    latestPeriods: latestPeriodSlots.map((slot) => ({
      slot,
      text: slot.textContent,
      dateTime: slot.getAttribute("datetime"),
    })),
    latestHeadlines: latestHeadlineSlots.map((slot) => ({ slot, text: slot.textContent })),
    latestDescriptions: latestDescriptionSlots.map((slot) => ({ slot, text: slot.textContent })),
    latestLinks: latestLinkSlots.map((slot) => ({ slot, text: slot.textContent })),
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
    fallback.latestLabels.forEach(({ slot, text }) => { slot.textContent = text; });
    fallback.latestPeriods.forEach(({ slot, text, dateTime }) => {
      slot.textContent = text;
      if (dateTime === null) slot.removeAttribute("datetime");
      else slot.setAttribute("datetime", dateTime);
    });
    fallback.latestHeadlines.forEach(({ slot, text }) => { slot.textContent = text; });
    fallback.latestDescriptions.forEach(({ slot, text }) => { slot.textContent = text; });
    fallback.latestLinks.forEach(({ slot, text }) => { slot.textContent = text; });
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

  function localizedText(values) {
    if (!values || typeof values !== "object") return "";
    const key = localeKey();
    return values[key] || values.en || values.zhHant || values.zhHans || "";
  }

  function formatLatestHeadline() {
    const key = localeKey();
    const labels = latestLabels[key] || latestLabels.en;
    return [
      `${formatValue("volunteers", true)} ${labels.volunteers}`,
      `${formatValue("students", true)} ${labels.students}`,
      `${formatValue("sessions", true)} ${labels.sessions}`,
    ].join(" · ");
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
      const text = localizedText(names);
      if (typeof text === "string" && text.trim()) slot.textContent = text;
    });

    const labels = latestLabels[localeKey()] || latestLabels.en;
    latestLabelSlots.forEach((slot) => { slot.textContent = labels.label; });
    latestPeriodSlots.forEach((slot) => {
      slot.textContent = formatPeriod(currentMetrics.period);
      slot.setAttribute("datetime", currentMetrics.period || "");
    });
    latestHeadlineSlots.forEach((slot) => { slot.textContent = formatLatestHeadline(); });
    latestDescriptionSlots.forEach((slot) => {
      const description = localizedText(currentMetrics.description);
      if (description) slot.textContent = description;
    });
    latestLinkSlots.forEach((slot) => { slot.textContent = labels.link; });
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
