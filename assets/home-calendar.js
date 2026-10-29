// Homepage calendar: reads the published events from /api/home-calendar and shows a month
// with the selected day's or upcoming events. Event times are Taipei time (UTC+8); a visitor
// in another time zone also sees the converted local time. Event text is shown as entered,
// in every language. Everything is built with textContent, never as HTML.
(() => {
  "use strict";
  const root = document.querySelector("[data-home-calendar]");
  if (!root) return;

  const TAIPEI = "Asia/Taipei";
  const VISIBLE = 3;
  const intlLocales = { en: "en-US", zhHant: "zh-TW", zhHans: "zh-CN" };
  const labels = {
    en: {
      region: "Event calendar", title: "Event calendar", previous: "Previous month", next: "Next month", today: "This month",
      upcoming: "Upcoming", none: "No events yet.", noneUpcoming: "No upcoming events.", noneDay: "No events on this day.",
      allDay: "All day", taipei: "Taipei time", local: "Your time", link: "Related link", more: count => `Show ${count} more`,
      fewer: "Show fewer", loading: "Loading the calendar…", error: "The calendar is temporarily unavailable.", retry: "Try again",
      note: "Times are in Taipei time (UTC+8).", manage: "✎ Manage calendar", eventsOn: count => count === 1 ? "1 event" : `${count} events`,
    },
    zhHant: {
      region: "活動行事曆", title: "活動行事曆", previous: "上個月", next: "下個月", today: "回到本月",
      upcoming: "即將到來", none: "目前沒有活動。", noneUpcoming: "目前沒有即將到來的活動。", noneDay: "這天沒有活動。",
      allDay: "全天", taipei: "台北時間", local: "你的當地時間", link: "相關連結", more: count => `再顯示 ${count} 個`,
      fewer: "收起", loading: "正在載入行事曆…", error: "行事曆暫時無法載入。", retry: "重試",
      note: "時間以台北時間（UTC+8）為準。", manage: "✎ 管理行事曆", eventsOn: count => `${count} 個活動`,
    },
    zhHans: {
      region: "活动行事历", title: "活动行事历", previous: "上个月", next: "下个月", today: "回到本月",
      upcoming: "即将到来", none: "目前没有活动。", noneUpcoming: "目前没有即将到来的活动。", noneDay: "这天没有活动。",
      allDay: "全天", taipei: "台北时间", local: "你的当地时间", link: "相关链接", more: count => `再显示 ${count} 个`,
      fewer: "收起", loading: "正在加载行事历…", error: "行事历暂时无法加载。", retry: "重试",
      note: "时间以台北时间（UTC+8）为准。", manage: "✎ 管理行事历", eventsOn: count => `${count} 个活动`,
    },
  };

  let locale = localeFromDocument();
  let state = "loading";
  let events = [];
  let view = monthOf(taipeiToday());
  let selected = "";
  let expanded = false;
  let admin = false;

  function localeFromDocument() {
    const lang = (document.documentElement.lang || "").toLowerCase();
    if (lang.startsWith("zh-hans") || lang === "zh-cn") return "zhHans";
    if (lang.startsWith("zh")) return "zhHant";
    return "en";
  }
  const text = () => labels[locale] || labels.en;
  const intl = () => intlLocales[locale] || "en-US";

  function taipeiToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TAIPEI, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function monthOf(date) { const [year, month] = date.split("-").map(Number); return { year, month }; }
  function iso(year, month, day) { return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
  function utcDate(date) { const [year, month, day] = date.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day)); }
  function instant(date, time) {
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
  }
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function safeLink(url) {
    try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : ""; } catch { return ""; }
  }

  function viewerZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
  }
  function sameWallClock(moment, zone) {
    const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: zone }).format(moment)
      === new Intl.DateTimeFormat("en-CA", { ...options, timeZone: TAIPEI }).format(moment);
  }
  function whenLines(item) {
    const day = new Intl.DateTimeFormat(intl(), { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" }).format(utcDate(item.date));
    if (!item.startTime) return [`${day} · ${text().allDay}`];
    const range = `${item.startTime}${item.endTime ? `–${item.endTime}` : ""}`;
    const lines = [`${day} · ${range} ${text().taipei}`];
    const zone = viewerZone();
    const start = instant(item.date, item.startTime);
    if (zone && zone !== TAIPEI && !sameWallClock(start, zone)) {
      const startText = new Intl.DateTimeFormat(intl(), { timeZone: zone, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(start);
      const endText = item.endTime ? new Intl.DateTimeFormat(intl(), { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant(item.date, item.endTime)) : "";
      // The English abbreviation (EST, PDT, GMT+9) reads the same in every language.
      const zoneName = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(start).find(part => part.type === "timeZoneName")?.value || zone;
      const range = `${startText}${endText ? `–${endText}` : ""}`;
      lines.push(locale === "en" ? `${text().local}: ${range} (${zoneName})` : `${text().local}：${range}（${zoneName}）`);
    }
    return lines;
  }

  function eventItem(item) {
    const node = el("li", "home-calendar-event");
    node.dataset.calendarEvent = item.id;
    const [taipei, local] = whenLines(item);
    node.append(el("p", "home-calendar-event-when", taipei));
    if (local) node.append(el("p", "home-calendar-event-local", local));
    node.append(el("h3", "", item.title));
    if (item.description) node.append(el("p", "home-calendar-event-description", item.description));
    const href = item.link && safeLink(item.link.url);
    if (href) {
      const anchor = el("a", "", item.link.label || text().link);
      anchor.href = href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
      node.append(anchor);
    }
    return node;
  }

  function monthGrid(today, byDate) {
    const grid = el("div", "home-calendar-grid");
    grid.setAttribute("role", "group");
    const weekday = new Intl.DateTimeFormat(intl(), { timeZone: "UTC", weekday: "narrow" });
    // 2023-01-01 was a Sunday; weeks start on Sunday.
    for (let index = 0; index < 7; index++) grid.append(el("span", "home-calendar-weekday", weekday.format(new Date(Date.UTC(2023, 0, 1 + index)))));
    const first = new Date(Date.UTC(view.year, view.month - 1, 1));
    const start = new Date(first.getTime() - first.getUTCDay() * 86_400_000);
    const long = new Intl.DateTimeFormat(intl(), { timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "long" });
    for (let index = 0; index < 42; index++) {
      const day = new Date(start.getTime() + index * 86_400_000);
      const date = iso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      const count = (byDate.get(date) || []).length;
      const button = el("button", "home-calendar-day", String(day.getUTCDate()));
      button.type = "button";
      button.dataset.date = date;
      if (day.getUTCMonth() + 1 !== view.month) button.classList.add("is-outside");
      if (date === today) { button.classList.add("is-today"); button.setAttribute("aria-current", "date"); }
      if (count) button.classList.add("has-events");
      button.setAttribute("aria-pressed", String(date === selected));
      button.setAttribute("aria-label", `${long.format(day)}${count ? `, ${text().eventsOn(count)}` : ""}`);
      button.addEventListener("click", () => {
        selected = selected === date ? "" : date;
        expanded = false;
        if (selected && day.getUTCMonth() + 1 !== view.month) view = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1 };
        render(date);
      });
      grid.append(button);
    }
    return grid;
  }

  function render(focusDate) {
    const t = text();
    root.setAttribute("aria-label", t.region);
    root.replaceChildren();
    if (state === "loading") { root.append(el("p", "home-calendar-status", t.loading)); return; }
    if (state === "error") {
      root.append(el("p", "home-calendar-status", t.error));
      const retry = el("button", "home-calendar-retry", t.retry);
      retry.type = "button";
      retry.addEventListener("click", load);
      root.append(retry);
      return;
    }
    const today = taipeiToday();
    const byDate = new Map();
    for (const item of events) byDate.set(item.date, [...(byDate.get(item.date) || []), item]);

    const head = el("div", "home-calendar-head");
    const heading = el("div");
    heading.append(el("h2", "home-calendar-title", t.title));
    const month = el("p", "home-calendar-month", new Intl.DateTimeFormat(intl(), { timeZone: "UTC", year: "numeric", month: "long" }).format(new Date(Date.UTC(view.year, view.month - 1, 1))));
    month.setAttribute("aria-live", "polite");
    heading.append(month);
    const nav = el("div", "home-calendar-nav");
    const current = monthOf(today);
    const move = delta => {
      const next = new Date(Date.UTC(view.year, view.month - 1 + delta, 1));
      view = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
      render();
    };
    const button = (label, symbol, action, extra) => {
      const node = el("button", extra || "", symbol);
      node.type = "button"; node.setAttribute("aria-label", label); node.title = label;
      node.addEventListener("click", action);
      return node;
    };
    nav.append(button(t.previous, "‹", () => move(-1)));
    if (view.year !== current.year || view.month !== current.month) {
      const back = button(t.today, t.today, () => { view = current; render(); }, "home-calendar-today");
      back.removeAttribute("title");
      nav.append(back);
    }
    nav.append(button(t.next, "›", () => move(1)));
    head.append(heading, nav);
    root.append(head, monthGrid(today, byDate));

    const list = el("div", "home-calendar-list");
    const shown = selected ? byDate.get(selected) || [] : events.filter(item => item.date >= today);
    const title = selected
      ? new Intl.DateTimeFormat(intl(), { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" }).format(utcDate(selected))
      : t.upcoming;
    list.append(el("p", "home-calendar-list-title", title));
    if (!events.length) list.append(el("p", "home-calendar-empty", t.none));
    else if (!shown.length) list.append(el("p", "home-calendar-empty", selected ? t.noneDay : t.noneUpcoming));
    else {
      const items = el("ul", "home-calendar-events");
      (expanded ? shown : shown.slice(0, VISIBLE)).forEach(item => items.append(eventItem(item)));
      list.append(items);
      if (shown.length > VISIBLE) {
        const more = el("button", "home-calendar-more", expanded ? t.fewer : t.more(shown.length - VISIBLE));
        more.type = "button";
        more.addEventListener("click", () => { expanded = !expanded; render(); });
        list.append(more);
      }
    }
    const foot = el("div", "home-calendar-foot");
    foot.append(el("span", "", t.note));
    if (admin) {
      const manage = el("a", "home-calendar-admin", t.manage);
      manage.href = "/admin/calendar";
      foot.append(manage);
    }
    list.append(foot);
    root.append(list);
    if (focusDate) root.querySelector(`[data-date="${focusDate}"]`)?.focus();
  }

  async function load() {
    state = "loading";
    render();
    try {
      const response = await fetch("/api/home-calendar", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      if (!Array.isArray(data?.config?.events)) throw new Error("shape");
      events = data.config.events.filter(item => item && typeof item.date === "string" && typeof item.title === "string");
      state = "ready";
    } catch {
      state = "error";
    }
    render();
  }

  window.addEventListener("ihear:language", event => {
    const next = event.detail?.locale;
    locale = labels[next] ? next : localeFromDocument();
    render();
  });
  // auth.js reports the session; only an administrator sees the link to the admin page.
  window.addEventListener("ihear:auth", event => {
    const next = Boolean(event.detail?.session?.user?.isAdmin);
    if (next !== admin) { admin = next; if (state === "ready") render(); }
  });
  void load();
})();
