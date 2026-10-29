// The event calendar, from the published events at /api/home-calendar:
// - on the homepage ([data-home-calendar]) a compact month with the selected day's or upcoming
//   events, and a link to the full calendar page;
// - on /events ([data-home-calendar-page]) the full calendar with three views of the same events:
//   Monthly (a month grid), Agenda (a list by month) and Pinboard (event cards).
// Event times are Taipei time (UTC+8); a visitor in another time zone also sees the converted
// local time. Event text is shown as entered, in every language. Everything is built with
// textContent, never as HTML, and only http(s) links are shown.
(() => {
  "use strict";
  const widget = document.querySelector("[data-home-calendar]");
  const page = document.querySelector("[data-home-calendar-page]");
  if (!widget && !page) return;

  const TAIPEI = "Asia/Taipei";
  // The homepage lists at most two events, so the calendar stays about as tall as the photo.
  const VISIBLE = 2;
  const VIEWS = ["monthly", "agenda", "pinboard"];
  const VIEW_KEY = "ihear-calendar-view";
  const intlLocales = { en: "en-US", zhHant: "zh-TW", zhHans: "zh-CN" };
  const labels = {
    en: {
      region: "Event calendar", title: "Event calendar", previous: "Previous month", next: "Next month", today: "This month",
      upcoming: "Upcoming", none: "No events yet.", noneUpcoming: "No upcoming events.", noneDay: "No events on this day.",
      noneMonth: "No events this month.", allDay: "All day", taipei: "Taipei time", local: "Your time", link: "Related link",
      more: count => `Show ${count} more`, fewer: "Show fewer", loading: "Loading the calendar…", error: "The calendar is temporarily unavailable.",
      retry: "Try again", note: "Times are in Taipei time (UTC+8).", manage: "✎ Manage calendar", all: "See all events →",
      eventsOn: count => count === 1 ? "1 event" : `${count} events`, views: { monthly: "Monthly", agenda: "Agenda", pinboard: "Pinboard" },
      viewLabel: "Calendar layout", monthEvents: "This month", showPast: "Show past events", hidePast: "Hide past events", past: "Past events",
      intro: "Events and activities from iHear. Choose how to view them.", moreOnDay: count => `+${count} more`,
    },
    zhHant: {
      region: "活動行事曆", title: "活動行事曆", previous: "上個月", next: "下個月", today: "回到本月",
      upcoming: "即將到來", none: "目前沒有活動。", noneUpcoming: "目前沒有即將到來的活動。", noneDay: "這天沒有活動。",
      noneMonth: "這個月沒有活動。", allDay: "全天", taipei: "台北時間", local: "你的當地時間", link: "相關連結",
      more: count => `再顯示 ${count} 個`, fewer: "收起", loading: "正在載入行事曆…", error: "行事曆暫時無法載入。",
      retry: "重試", note: "時間以台北時間（UTC+8）為準。", manage: "✎ 管理行事曆", all: "查看所有活動 →",
      eventsOn: count => `${count} 個活動`, views: { monthly: "月曆", agenda: "活動清單", pinboard: "活動卡片" },
      viewLabel: "顯示方式", monthEvents: "本月活動", showPast: "顯示已過去的活動", hidePast: "隱藏已過去的活動", past: "已過去的活動",
      intro: "iHear 的活動與課程資訊。可以選擇不同的顯示方式。", moreOnDay: count => `還有 ${count} 個`,
    },
    zhHans: {
      region: "活动行事历", title: "活动行事历", previous: "上个月", next: "下个月", today: "回到本月",
      upcoming: "即将到来", none: "目前没有活动。", noneUpcoming: "目前没有即将到来的活动。", noneDay: "这天没有活动。",
      noneMonth: "这个月没有活动。", allDay: "全天", taipei: "台北时间", local: "你的当地时间", link: "相关链接",
      more: count => `再显示 ${count} 个`, fewer: "收起", loading: "正在加载行事历…", error: "行事历暂时无法加载。",
      retry: "重试", note: "时间以台北时间（UTC+8）为准。", manage: "✎ 管理行事历", all: "查看所有活动 →",
      eventsOn: count => `${count} 个活动`, views: { monthly: "月历", agenda: "活动清单", pinboard: "活动卡片" },
      viewLabel: "显示方式", monthEvents: "本月活动", showPast: "显示已过去的活动", hidePast: "隐藏已过去的活动", past: "已过去的活动",
      intro: "iHear 的活动与课程信息。可以选择不同的显示方式。", moreOnDay: count => `还有 ${count} 个`,
    },
  };

  let locale = localeFromDocument();
  let state = "loading";
  let events = [];
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
  const dayLabel = date => new Intl.DateTimeFormat(intl(), { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" }).format(utcDate(date));
  const monthLabel = (year, month) => new Intl.DateTimeFormat(intl(), { timeZone: "UTC", year: "numeric", month: "long" }).format(new Date(Date.UTC(year, month - 1, 1)));

  function timeLines(item) {
    if (!item.startTime) return [text().allDay];
    const lines = [`${item.startTime}${item.endTime ? `–${item.endTime}` : ""} ${text().taipei}`];
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

  // One event as the homepage and the Monthly view list it. The homepage (compact) leaves out the
  // description, which the full calendar page shows.
  function eventItem(item, { compact = false } = {}) {
    const node = el("li", "home-calendar-event");
    node.dataset.calendarEvent = item.id;
    const [time, local] = timeLines(item);
    // Date and time wrap between each other, never inside "台北時間".
    const when = el("p", "home-calendar-event-when");
    when.append(el("span", "", dayLabel(item.date)), el("span", "", ` · ${time}`));
    node.append(when);
    if (local) node.append(el("p", "home-calendar-event-local", local));
    node.append(el("h3", "", item.title));
    if (item.description && !compact) node.append(el("p", "home-calendar-event-description", item.description));
    appendLink(node, item);
    return node;
  }
  function appendLink(node, item) {
    const href = item.link && safeLink(item.link.url);
    if (!href) return;
    const anchor = el("a", "home-calendar-event-link", item.link.label || text().link);
    anchor.href = href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
    node.append(anchor);
  }
  function eventList(items, options) {
    const list = el("ul", "home-calendar-events");
    items.forEach(item => list.append(eventItem(item, options)));
    return list;
  }

  function byDate() {
    const map = new Map();
    for (const item of events) map.set(item.date, [...(map.get(item.date) || []), item]);
    return map;
  }

  // The month header with previous/next and "this month"; `view` is the shared month state.
  function monthHead(holder, view, rerender, { heading = true } = {}) {
    const t = text();
    const head = el("div", "home-calendar-head");
    const titles = el("div");
    if (heading) titles.append(el("h2", "home-calendar-title", t.title));
    const month = el("p", "home-calendar-month", monthLabel(view.year, view.month));
    month.setAttribute("aria-live", "polite");
    titles.append(month);
    const nav = el("div", "home-calendar-nav");
    const current = monthOf(taipeiToday());
    const button = (label, symbol, action, extra) => {
      const node = el("button", extra || "", symbol);
      node.type = "button"; node.setAttribute("aria-label", label);
      if (!extra) node.title = label;
      node.addEventListener("click", action);
      return node;
    };
    const move = delta => {
      const next = new Date(Date.UTC(view.year, view.month - 1 + delta, 1));
      holder.view = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
      holder.selected = ""; holder.expanded = false;
      rerender();
    };
    nav.append(button(t.previous, "‹", () => move(-1)));
    if (view.year !== current.year || view.month !== current.month) {
      nav.append(button(t.today, t.today, () => { holder.view = current; holder.selected = ""; rerender(); }, "home-calendar-today"));
    }
    nav.append(button(t.next, "›", () => move(1)));
    head.append(titles, nav);
    return head;
  }

  // The month grid. `chips` shows event titles inside the days (the full Monthly view).
  function monthGrid(holder, rerender, { chips = false } = {}) {
    const t = text();
    const today = taipeiToday();
    const dates = byDate();
    const grid = el("div", `home-calendar-grid${chips ? " has-chips" : ""}`);
    grid.setAttribute("role", "group");
    const weekday = new Intl.DateTimeFormat(intl(), { timeZone: "UTC", weekday: chips ? "short" : "narrow" });
    // 2023-01-01 was a Sunday; weeks start on Sunday.
    for (let index = 0; index < 7; index++) grid.append(el("span", "home-calendar-weekday", weekday.format(new Date(Date.UTC(2023, 0, 1 + index)))));
    const first = new Date(Date.UTC(holder.view.year, holder.view.month - 1, 1));
    const start = new Date(first.getTime() - first.getUTCDay() * 86_400_000);
    const long = new Intl.DateTimeFormat(intl(), { timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "long" });
    for (let index = 0; index < 42; index++) {
      const day = new Date(start.getTime() + index * 86_400_000);
      const date = iso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      const items = dates.get(date) || [];
      const cell = el("button", "home-calendar-day");
      cell.type = "button";
      cell.dataset.date = date;
      cell.append(el("span", "home-calendar-day-number", String(day.getUTCDate())));
      if (chips && items.length) {
        const list = el("span", "home-calendar-chips");
        items.slice(0, 2).forEach(item => list.append(el("span", "home-calendar-chip", `${item.startTime ? `${item.startTime} ` : ""}${item.title}`)));
        if (items.length > 2) list.append(el("span", "home-calendar-chip more", t.moreOnDay(items.length - 2)));
        cell.append(list);
      }
      if (day.getUTCMonth() + 1 !== holder.view.month) cell.classList.add("is-outside");
      if (date === today) { cell.classList.add("is-today"); cell.setAttribute("aria-current", "date"); }
      if (items.length) cell.classList.add("has-events");
      cell.setAttribute("aria-pressed", String(date === holder.selected));
      cell.setAttribute("aria-label", `${long.format(day)}${items.length ? `, ${t.eventsOn(items.length)}` : ""}`);
      cell.addEventListener("click", () => {
        holder.selected = holder.selected === date ? "" : date;
        holder.expanded = false;
        if (holder.selected && day.getUTCMonth() + 1 !== holder.view.month) holder.view = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1 };
        rerender(date);
      });
      grid.append(cell);
    }
    return grid;
  }

  function statusOnly(root) {
    const t = text();
    root.replaceChildren();
    if (state === "loading") { root.append(el("p", "home-calendar-status", t.loading)); return true; }
    if (state === "error") {
      root.append(el("p", "home-calendar-status", t.error));
      const retry = el("button", "home-calendar-retry", t.retry);
      retry.type = "button";
      retry.addEventListener("click", load);
      root.append(retry);
      return true;
    }
    return false;
  }
  function footer(extra) {
    const t = text();
    const foot = el("div", "home-calendar-foot");
    foot.append(el("span", "", t.note));
    const links = el("span", "home-calendar-foot-links");
    if (extra) links.append(extra);
    if (admin) {
      const manage = el("a", "home-calendar-admin", t.manage);
      manage.href = "/admin/calendar";
      links.append(manage);
    }
    if (links.childNodes.length) foot.append(links);
    return foot;
  }

  // ----- the homepage widget -----
  const compact = { view: monthOf(taipeiToday()), selected: "", expanded: false };
  function renderWidget(focusDate) {
    if (!widget) return;
    const t = text();
    widget.setAttribute("aria-label", t.region);
    if (statusOnly(widget)) return;
    const today = taipeiToday();
    const rerender = date => renderWidget(date);
    widget.append(monthHead(compact, compact.view, rerender), monthGrid(compact, rerender));
    const list = el("div", "home-calendar-list");
    const dates = byDate();
    const shown = compact.selected ? dates.get(compact.selected) || [] : events.filter(item => item.date >= today);
    list.append(el("p", "home-calendar-list-title", compact.selected ? dayLabel(compact.selected) : t.upcoming));
    if (!events.length) list.append(el("p", "home-calendar-empty", t.none));
    else if (!shown.length) list.append(el("p", "home-calendar-empty", compact.selected ? t.noneDay : t.noneUpcoming));
    else {
      list.append(eventList(compact.expanded ? shown : shown.slice(0, VISIBLE), { compact: true }));
      if (shown.length > VISIBLE) {
        const more = el("button", "home-calendar-more", compact.expanded ? t.fewer : t.more(shown.length - VISIBLE));
        more.type = "button";
        more.addEventListener("click", () => { compact.expanded = !compact.expanded; renderWidget(); });
        list.append(more);
      }
    }
    const all = el("a", "home-calendar-all", t.all);
    all.href = "/events";
    list.append(footer(all));
    widget.append(list);
    if (focusDate) widget.querySelector(`[data-date="${focusDate}"]`)?.focus();
  }

  // ----- the full calendar page -----
  const full = { view: monthOf(taipeiToday()), selected: "", expanded: false, showPast: false, layout: initialLayout() };
  function initialLayout() {
    const fromUrl = new URLSearchParams(location.search).get("view");
    if (VIEWS.includes(fromUrl)) return fromUrl;
    try { const saved = localStorage.getItem(VIEW_KEY); if (VIEWS.includes(saved)) return saved; } catch { /* storage may be blocked */ }
    // Phones start with the list, which reads best on a narrow screen.
    return window.matchMedia("(max-width: 720px)").matches ? "agenda" : "monthly";
  }
  function chooseLayout(layout) {
    full.layout = layout;
    try { localStorage.setItem(VIEW_KEY, layout); } catch { /* optional */ }
    const url = new URL(location.href);
    url.searchParams.set("view", layout);
    history.replaceState(null, "", url);
    renderPage();
    page.querySelector(`[data-calendar-view="${layout}"]`)?.focus();
  }

  function pastToggle(list) {
    const t = text();
    const past = events.filter(item => item.date < taipeiToday());
    if (!past.length) return null;
    const button = el("button", "home-calendar-more", full.showPast ? t.hidePast : t.showPast);
    button.type = "button";
    button.setAttribute("aria-expanded", String(full.showPast));
    button.addEventListener("click", () => { full.showPast = !full.showPast; renderPage(); });
    list.append(button);
    return past;
  }

  function monthlyView(container) {
    const t = text();
    const rerender = date => { renderPage(); if (date) page.querySelector(`[data-date="${date}"]`)?.focus(); };
    container.append(monthHead(full, full.view, rerender, { heading: false }), monthGrid(full, rerender, { chips: true }));
    const list = el("div", "home-calendar-list");
    const prefix = `${full.view.year}-${String(full.view.month).padStart(2, "0")}-`;
    const shown = full.selected ? byDate().get(full.selected) || [] : events.filter(item => item.date.startsWith(prefix));
    list.append(el("h2", "home-calendar-list-title", full.selected ? dayLabel(full.selected) : t.monthEvents));
    if (!events.length) list.append(el("p", "home-calendar-empty", t.none));
    else if (!shown.length) list.append(el("p", "home-calendar-empty", full.selected ? t.noneDay : t.noneMonth));
    else list.append(eventList(shown));
    container.append(list);
  }

  function agendaView(container) {
    const t = text();
    const today = taipeiToday();
    const upcoming = events.filter(item => item.date >= today);
    const wrap = el("div", "home-calendar-agenda");
    if (!events.length) wrap.append(el("p", "home-calendar-empty", t.none));
    else if (!upcoming.length) wrap.append(el("p", "home-calendar-empty", t.noneUpcoming));
    const groups = (items, title) => {
      let month = "";
      let list = null;
      if (title) wrap.append(el("h2", "home-calendar-agenda-section", title));
      for (const item of items) {
        const key = item.date.slice(0, 7);
        if (key !== month) {
          month = key;
          const [year, value] = key.split("-").map(Number);
          wrap.append(el("h3", "home-calendar-agenda-month", monthLabel(year, value)));
          list = el("ol", "home-calendar-agenda-list");
          wrap.append(list);
        }
        const row = el("li", "home-calendar-agenda-item");
        row.dataset.calendarEvent = item.id;
        const badge = el("div", "home-calendar-date-badge");
        const date = utcDate(item.date);
        badge.append(el("span", "home-calendar-date-day", String(date.getUTCDate())), el("span", "home-calendar-date-weekday", new Intl.DateTimeFormat(intl(), { timeZone: "UTC", weekday: "short" }).format(date)));
        const body = el("div", "home-calendar-agenda-body");
        const [time, local] = timeLines(item);
        body.append(el("p", "home-calendar-event-when", time));
        if (local) body.append(el("p", "home-calendar-event-local", local));
        body.append(el("h4", "home-calendar-agenda-title", item.title));
        if (item.description) body.append(el("p", "home-calendar-event-description", item.description));
        appendLink(body, item);
        row.append(badge, body);
        list.append(row);
      }
    };
    groups(upcoming);
    const past = pastToggle(wrap);
    if (past && full.showPast) groups([...past].reverse(), t.past);
    container.append(wrap);
  }

  function pinboardView(container) {
    const t = text();
    const today = taipeiToday();
    const upcoming = events.filter(item => item.date >= today);
    const wrap = el("div", "home-calendar-pinboard-wrap");
    if (!events.length) wrap.append(el("p", "home-calendar-empty", t.none));
    else if (!upcoming.length) wrap.append(el("p", "home-calendar-empty", t.noneUpcoming));
    const board = items => {
      const grid = el("ul", "home-calendar-pinboard");
      for (const item of items) {
        const card = el("li", "home-calendar-card");
        card.dataset.calendarEvent = item.id;
        const date = utcDate(item.date);
        const top = el("div", "home-calendar-card-date");
        top.append(
          el("span", "home-calendar-card-month", new Intl.DateTimeFormat(intl(), { timeZone: "UTC", month: "short" }).format(date)),
          el("span", "home-calendar-card-day", String(date.getUTCDate())),
          el("span", "home-calendar-card-weekday", new Intl.DateTimeFormat(intl(), { timeZone: "UTC", weekday: "short" }).format(date)),
        );
        const body = el("div", "home-calendar-card-body");
        body.append(el("h3", "home-calendar-card-title", item.title));
        const [time, local] = timeLines(item);
        body.append(el("p", "home-calendar-event-when", time));
        if (local) body.append(el("p", "home-calendar-event-local", local));
        if (item.description) body.append(el("p", "home-calendar-event-description", item.description));
        appendLink(body, item);
        card.append(top, body);
        grid.append(card);
      }
      wrap.append(grid);
    };
    if (upcoming.length) board(upcoming);
    const past = pastToggle(wrap);
    if (past && full.showPast) { wrap.append(el("h2", "home-calendar-agenda-section", t.past)); board([...past].reverse()); }
    container.append(wrap);
  }

  function renderPage() {
    if (!page) return;
    const t = text();
    page.setAttribute("aria-label", t.region);
    if (statusOnly(page)) return;
    const head = el("div", "home-calendar-page-head");
    const titles = el("div");
    titles.append(el("h1", "home-calendar-page-title", t.title), el("p", "home-calendar-page-intro", t.intro));
    const tabs = el("div", "home-calendar-views");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", t.viewLabel);
    for (const layout of VIEWS) {
      const tab = el("button", "home-calendar-view", t.views[layout]);
      tab.type = "button";
      tab.dataset.calendarView = layout;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(layout === full.layout));
      tab.tabIndex = layout === full.layout ? 0 : -1;
      tab.addEventListener("click", () => chooseLayout(layout));
      tab.addEventListener("keydown", event => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step) { event.preventDefault(); chooseLayout(VIEWS[(VIEWS.indexOf(layout) + step + VIEWS.length) % VIEWS.length]); }
      });
      tabs.append(tab);
    }
    head.append(titles, tabs);
    const body = el("div", `home-calendar-page-body view-${full.layout}`);
    body.setAttribute("role", "tabpanel");
    body.dataset.calendarLayout = full.layout;
    if (full.layout === "monthly") monthlyView(body);
    else if (full.layout === "agenda") agendaView(body);
    else pinboardView(body);
    page.append(head, body, footer());
  }

  function renderAll() { renderWidget(); renderPage(); }

  async function load() {
    state = "loading";
    renderAll();
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
    renderAll();
  }

  window.addEventListener("ihear:language", event => {
    const next = event.detail?.locale;
    locale = labels[next] ? next : localeFromDocument();
    renderAll();
  });
  // auth.js reports the session; only an administrator sees the link to the admin page.
  window.addEventListener("ihear:auth", event => {
    const next = Boolean(event.detail?.session?.user?.isAdmin);
    if (next !== admin) { admin = next; if (state === "ready") renderAll(); }
  });
  void load();
})();
