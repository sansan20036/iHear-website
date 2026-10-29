// Homepage calendar: model validation, the public and administrator API, and the local
// file store. Synthetic data only; no production credentials or requests.
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  HOME_CALENDAR_LIMITS,
  HOME_CALENDAR_MAX_EVENTS,
  emptyHomeCalendar,
  homeCalendarChangedFields,
  homeCalendarStartInstant,
  parseHomeCalendarConfig,
  publicHomeCalendar,
} from "../lib/home-calendar-types";

const event = (overrides = {}) => ({
  id: "event-0001", title: "Volunteer orientation", date: "2026-11-05", startTime: "19:00", endTime: "20:30",
  description: "Line one\nLine two", link: { url: "https://example.org/join", label: "Sign up" }, ...overrides,
});
const config = (events = [event()]) => ({ ...emptyHomeCalendar(), events });
const reason = (value) => { try { parseHomeCalendarConfig(value); return "ok"; } catch (error) { return `${error.field}:${error.code}`; } };

describe("calendar model", () => {
  test("an empty calendar and a full event are accepted; events come back sorted", () => {
    expect(parseHomeCalendarConfig(emptyHomeCalendar())).toEqual({ schemaVersion: 1, timeZone: "Asia/Taipei", events: [] });
    const parsed = parseHomeCalendarConfig(config([
      event({ id: "event-0003", date: "2026-11-06", startTime: null, endTime: null }),
      event({ id: "event-0002", date: "2026-11-05", startTime: "09:00", endTime: null }),
      event(),
      event({ id: "event-0004", date: "2026-11-05", startTime: null, endTime: null, title: "All day" }),
    ]));
    expect(parsed.events.map(item => item.id)).toEqual(["event-0004", "event-0002", "event-0001", "event-0003"]);
    expect(parsed.events[2]).toEqual(event());
  });

  test("text is trimmed and CRLF becomes LF; an empty link becomes null", () => {
    const parsed = parseHomeCalendarConfig(config([event({ title: "  Talk  ", description: "a\r\nb ", link: { url: "", label: "" } })]));
    expect(parsed.events[0]).toMatchObject({ title: "Talk", description: "a\nb", link: null });
    expect(parseHomeCalendarConfig(config([event({ link: null, description: undefined })])).events[0]).toMatchObject({ link: null, description: "" });
  });

  test.each([
    ["missing title", event({ title: "  " }), "events.0.title:required"],
    ["title too long", event({ title: "字".repeat(HOME_CALENDAR_LIMITS.title + 1) }), "events.0.title:too_long"],
    ["title on two lines", event({ title: "a\nb" }), "events.0.title:single_line"],
    ["control character", event({ description: "bell\u0007" }), "events.0.description:unsupported"],
    ["description too long", event({ description: "x".repeat(HOME_CALENDAR_LIMITS.description + 1) }), "events.0.description:too_long"],
    ["impossible date", event({ date: "2026-02-30" }), "events.0.date:invalid_date"],
    ["date out of range", event({ date: "1999-12-31" }), "events.0.date:invalid_date"],
    ["bad time", event({ startTime: "24:00" }), "events.0.startTime:invalid_time"],
    ["end without start", event({ startTime: null }), "events.0.startTime:required"],
    ["end before start", event({ endTime: "18:59" }), "events.0.endTime:end_before_start"],
    ["end equal to start", event({ endTime: "19:00" }), "events.0.endTime:end_before_start"],
    ["javascript link", event({ link: { url: "javascript:alert(1)", label: "" } }), "events.0.link.url:invalid_link"],
    ["mailto link", event({ link: { url: "mailto:a@example.org", label: "" } }), "events.0.link.url:invalid_link"],
    ["relative link", event({ link: { url: "/admin", label: "" } }), "events.0.link.url:invalid_link"],
    ["link with credentials", event({ link: { url: "https://user:pass@example.org", label: "" } }), "events.0.link.url:invalid_link"],
    ["label without address", event({ link: { url: "", label: "Open" } }), "events.0.link.url:required"],
    ["bad id", event({ id: "<script>" }), "events.0.id:invalid_request"],
    ["unknown field", { ...event(), color: "red" }, "events.0:invalid_request"],
  ])("rejects %s", (_name, item, expected) => {
    expect(reason(config([item]))).toBe(expected);
  });

  test("rejects duplicate ids, too many events, and a wrong schema or time zone", () => {
    expect(reason(config([event(), event({ title: "Copy" })]))).toBe("events.1.id:duplicate_id");
    const many = Array.from({ length: HOME_CALENDAR_MAX_EVENTS + 1 }, (_, index) => event({ id: `event-${String(index).padStart(4, "0")}` }));
    expect(reason(config(many))).toBe("events:too_many");
    expect(reason({ ...config(), timeZone: "America/New_York" })).toBe("config:invalid_request");
    expect(reason({ ...config(), schemaVersion: 2 })).toBe("config:invalid_request");
    expect(reason({ ...config(), extra: true })).toBe("config:invalid_request");
  });

  test("the largest calendar fits the 400,000-character database limit", () => {
    const longest = Array.from({ length: HOME_CALENDAR_MAX_EVENTS }, (_, index) => event({
      id: `event-${String(index).padStart(4, "0")}-${"a".repeat(28)}`, title: "標".repeat(HOME_CALENDAR_LIMITS.title),
      description: "說".repeat(HOME_CALENDAR_LIMITS.description), link: { url: `https://example.org/${"p".repeat(HOME_CALENDAR_LIMITS.linkUrl - 20)}`, label: "連".repeat(HOME_CALENDAR_LIMITS.linkLabel) },
    }));
    expect(JSON.stringify(parseHomeCalendarConfig(config(longest))).length).toBeLessThan(400_000);
  });

  test("changed fields name created, updated and deleted events", () => {
    const before = parseHomeCalendarConfig(config([event(), event({ id: "event-0002" })]));
    const after = parseHomeCalendarConfig(config([event({ title: "Renamed" }), event({ id: "event-0003" })]));
    expect(homeCalendarChangedFields(before, after)).toEqual(["events.event-0001.updated", "events.event-0003.created", "events.event-0002.deleted"]);
  });

  test("Taipei 19:00 on 5 Nov is 11:00 UTC; the public projection hides the editor", () => {
    expect(homeCalendarStartInstant(event()).toISOString()).toBe("2026-11-05T11:00:00.000Z");
    expect(homeCalendarStartInstant(event({ startTime: null }))).toBeNull();
    expect(publicHomeCalendar({ config: config(), recordVersion: 4, updatedAt: "2026-10-29T00:00:00.000Z", updatedBy: "private@example.com" }))
      .toEqual({ config: config(), recordVersion: 4 });
  });
});

describe("calendar API", async () => {
  vi.resetModules();
  vi.doMock("../auth.js", () => ({ auth: vi.fn() }));
  vi.doMock("../lib/admin-store", () => ({ findAdminAccount: vi.fn() }));
  vi.doMock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));
  vi.doMock("../lib/home-calendar-store", async original => ({ ...await original(), readHomeCalendar: vi.fn(), updateHomeCalendar: vi.fn() }));
  vi.stubEnv("AUTH_OWNER_EMAILS", "owner@example.com");
  const { auth } = await import("../auth.js");
  const { findAdminAccount } = await import("../lib/admin-store");
  const { enforceRateLimit } = await import("../lib/rate-limit");
  const store = await import("../lib/home-calendar-store");
  const route = await import("../app/api/home-calendar/route");
  afterAll(() => { vi.unstubAllEnvs(); vi.doUnmock("../auth.js"); vi.doUnmock("../lib/admin-store"); vi.doUnmock("../lib/rate-limit"); vi.doUnmock("../lib/home-calendar-store"); });

  const ORIGIN = "https://www.ihearus.org";
  const record = { config: parseHomeCalendarConfig(config()), recordVersion: 3, updatedAt: "2026-10-29T00:00:00.000Z", updatedBy: "private@example.com" };
  const post = (body = { config: config(), expectedVersion: 3 }, headers = {}) => new Request(`${ORIGIN}/api/home-calendar`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  beforeEach(() => {
    vi.mocked(auth).mockReset().mockResolvedValue({ user: { email: "owner@example.com" } });
    vi.mocked(findAdminAccount).mockReset().mockResolvedValue(null);
    vi.mocked(enforceRateLimit).mockReset().mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-10-29T00:01:00.000Z" } });
    vi.mocked(store.readHomeCalendar).mockReset().mockResolvedValue(record);
    vi.mocked(store.updateHomeCalendar).mockReset().mockImplementation(async input => ({ ...record, config: input.config, recordVersion: 4, updatedBy: input.updatedBy }));
  });
  const json = async response => ({ status: response.status, body: await response.json(), cache: response.headers.get("cache-control") });

  test("visitors read the events and version, uncached, without the editor's identity", async () => {
    const result = await json(await route.GET());
    expect(result).toEqual({ status: 200, body: { config: record.config, recordVersion: 3 }, cache: "no-store" });
    expect(JSON.stringify(result.body)).not.toContain("private@example.com");
  });

  test("an unavailable store answers 503 without details", async () => {
    vi.mocked(store.readHomeCalendar).mockRejectedValue(new store.HomeCalendarUnavailableError());
    expect(await json(await route.GET())).toMatchObject({ status: 503, body: { code: "CALENDAR_UNAVAILABLE" } });
  });

  test("an owner saves; the identity and role come from the session, not the body", async () => {
    const result = await json(await route.POST(post()));
    expect(result).toMatchObject({ status: 200, body: { ok: true, recordVersion: 4 }, cache: "no-store" });
    expect(store.updateHomeCalendar).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 3, updatedBy: "owner@example.com", updatedByRole: "owner" }));
  });

  test("an enabled database editor saves as editor", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "editor@example.com" } });
    vi.mocked(findAdminAccount).mockResolvedValue({ email: "editor@example.com", role: "editor", enabled: true });
    expect((await route.POST(post())).status).toBe(200);
    expect(store.updateHomeCalendar).toHaveBeenCalledWith(expect.objectContaining({ updatedBy: "editor@example.com", updatedByRole: "editor" }));
  });

  test("visitors and non-administrators cannot save", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    expect(await json(await route.POST(post()))).toMatchObject({ status: 401, body: { code: "SIGN_IN_REQUIRED" } });
    vi.mocked(auth).mockResolvedValue({ user: { email: "someone@example.com" } });
    expect(await json(await route.POST(post()))).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    vi.mocked(auth).mockResolvedValue({ user: { email: "editor@example.com" } });
    vi.mocked(findAdminAccount).mockResolvedValue({ email: "editor@example.com", role: "editor", enabled: false });
    expect((await route.POST(post())).status).toBe(403);
    expect(store.updateHomeCalendar).not.toHaveBeenCalled();
  });

  test("a cross-site or origin-less request is refused before the session is read", async () => {
    expect((await route.POST(post(undefined, { Origin: "https://evil.example" }))).status).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/api/home-calendar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: config(), expectedVersion: 3 }) });
    expect((await route.POST(noOrigin)).status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
  });

  test("bad requests: no version 428, invalid event 400, extra field 400, wrong type 415, too large 413", async () => {
    expect(await json(await route.POST(post({ config: config() })))).toMatchObject({ status: 428, body: { code: "CALENDAR_VERSION_REQUIRED" } });
    expect(await json(await route.POST(post({ config: config([event({ title: "" })]), expectedVersion: 3 }))))
      .toMatchObject({ status: 400, body: { code: "CALENDAR_INVALID_INPUT", field: "events.0.title", reason: "required" } });
    expect((await route.POST(post({ config: config(), expectedVersion: 3, updatedBy: "x" }))).status).toBe(400);
    expect((await route.POST(post(undefined, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect((await route.POST(post(undefined, { "Content-Length": "999999999" }))).status).toBe(413);
    expect(store.updateHomeCalendar).not.toHaveBeenCalled();
  });

  test("a version conflict answers 409", async () => {
    vi.mocked(store.updateHomeCalendar).mockRejectedValue(new store.HomeCalendarConflictError());
    expect(await json(await route.POST(post()))).toMatchObject({ status: 409, body: { code: "CALENDAR_VERSION_CONFLICT" } });
  });

  test("other methods answer 405", async () => {
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) expect((await route[method]()).status).toBe(405);
  });
});

describe("calendar local store", () => {
  const root = path.resolve("output", "home-calendar-local-tests");
  let directory;
  let store;
  beforeEach(async () => {
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(path.join(root, "store-"));
    for (const key of ["POSTGRES_URL", "DATABASE_URL", "VERCEL", "NETLIFY", "CONTEXT"]) vi.stubEnv(key, "");
    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
    vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
    vi.resetModules();
    vi.doUnmock("../lib/home-calendar-store");
    store = await import("../lib/home-calendar-store");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const resolved = await realpath(directory);
    if (!resolved.startsWith(await realpath(root) + path.sep)) throw new Error("Refusing cleanup outside the test folder");
    await rm(resolved, { recursive: true, force: true });
  });
  const save = (events, expectedVersion) => store.updateHomeCalendar({ config: config(events), expectedVersion, updatedBy: "editor@example.com", updatedByRole: "editor" });

  test("starts empty at version 1; saves increment the version and log the change", async () => {
    expect(await store.readHomeCalendar()).toMatchObject({ config: emptyHomeCalendar(), recordVersion: 1 });
    expect(await save([event()], 1)).toMatchObject({ recordVersion: 2, updatedBy: "editor@example.com" });
    expect(await save([], 2)).toMatchObject({ recordVersion: 3, config: emptyHomeCalendar() });
    const stored = JSON.parse(await readFile(path.join(directory, "home-calendar.json"), "utf8"));
    expect(stored.activity.map(entry => [entry.action, entry.entityType, entry.changedFields])).toEqual([
      ["calendar.events.updated", "calendar", ["events.event-0001.created"]],
      ["calendar.events.updated", "calendar", ["events.event-0001.deleted"]],
    ]);
  });

  test("a stale version is a conflict and changes nothing", async () => {
    await save([event()], 1);
    await expect(save([], 1)).rejects.toBeInstanceOf(store.HomeCalendarConflictError);
    expect(await store.readHomeCalendar()).toMatchObject({ recordVersion: 2, config: { events: [event()] } });
  });

  test("two saves at the same version: exactly one wins", async () => {
    const results = await Promise.allSettled([save([event()], 1), save([event({ id: "event-0002" })], 1)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.readHomeCalendar()).recordVersion).toBe(2);
  });

  test("a hosted deployment without a database reports unavailable, never an empty calendar", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.resetModules();
    const hosted = await import("../lib/home-calendar-store");
    await expect(hosted.readHomeCalendar()).rejects.toBeInstanceOf(hosted.HomeCalendarUnavailableError);
  });
});
