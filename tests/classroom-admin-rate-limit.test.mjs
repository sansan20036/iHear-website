import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// R-8 (2026-11-08): the open classroom overview asks for a tick every 15 seconds and after each
// change. It used to share the owner's 30-a-minute admin allowance with every admin change, so a
// busy overview could get a cancel or a revoke refused. These tests run the site's own routes
// with the real limiter (its in-process store; tests/classroom-admin-rate-limit-postgres.test.mjs
// covers the shared PostgreSQL store), synthetic data only (TEST- codes, example.test addresses).
//
// Each test states its success condition in its title, and fails on any other outcome.
const afterResponse = vi.hoisted(() => []);
vi.mock("next/server", async original => ({ ...await original(), after: task => { afterResponse.push(task); } }));
vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));

import { auth } from "../auth.js";
import { appendAdminActivity, findAdminAccount } from "../lib/admin-store";

const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-r8-limit-"));
const ORIGIN = "http://localhost:3000";
// One owner per test: the limiter keeps its count per signed-in owner for the whole file.
const OWNERS = Array.from({ length: 8 }, (_, n) => `r8-owner-${n + 1}@example.test`);
const EDITOR = "r8-editor@example.test";
const TUTOR = "r8-tutor@example.test";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNERS.join(","));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("POSTGRES_URL", "");
vi.stubEnv("DATABASE_URL", "");
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", "r8-webhook-test-only");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "r8-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
const lessonsRoute = await import("../app/api/admin/classrooms/route");
const lessonRoute = await import("../app/api/admin/classrooms/[lessonId]/route");
const tickRoute = await import("../app/api/admin/classrooms/tick/route");
const consents = await import("../app/api/admin/classrooms/consents/route");
const { RATE_LIMIT_POLICIES } = await import("../lib/rate-limit");

vi.useFakeTimers({ toFake: ["Date"] });
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  afterResponse.length = 0;
  auth.mockResolvedValue(null);
  findAdminAccount.mockImplementation(async email => (email === EDITOR ? { email, enabled: true } : null));
  appendAdminActivity.mockResolvedValue(undefined);
  vi.setSystemTime(new Date("2026-12-03T07:00:00Z"));
});

const SEC = 1000;
const TICKS = RATE_LIMIT_POLICIES.classroomTick.limit;
const CHANGES = RATE_LIMIT_POLICIES.adminMutation.limit;
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const params = lessonId => ({ params: Promise.resolve({ lessonId }) });
const request = (pathname, body = {}, { method = "POST", origin = ORIGIN } = {}) =>
  new Request(`${ORIGIN}${pathname}`, { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async response => ({ status: response.status, body: await response.json().catch(() => ({})), headers: response.headers });
const tick = async (options = {}) => read(await tickRoute.POST(request("/api/admin/classrooms/tick", {}, options)));
const change = async (lesson, action, options = {}) => read(await lessonRoute.PATCH(request(`/api/admin/classrooms/${lesson.id}`, { action }, { ...options, method: "PATCH" }), params(lesson.id)));
const consent = async (personCode, role = "student") => read(await consents.POST(request("/api/admin/classrooms/consents", { personCode, role, status: "granted" })));
const statuses = answers => answers.map(answer => answer.status).sort().reduce((count, status) => ({ ...count, [status]: (count[status] ?? 0) + 1 }), {});

let codes = 0;
// A TEST- lesson with consent for both people: three admin changes.
async function lessonBy(owner) {
  codes += 1;
  const code = `TEST-R${codes}`;
  signedIn(owner);
  const created = await read(await lessonsRoute.POST(request("/api/admin/classrooms", { code, date: "2026-12-03", time: "16:00", minutes: 60, tutorCode: `${code}-T`, tutorEmail: TUTOR, studentCode: `${code}-S` })));
  expect(created.status).toBe(201);
  expect((await consent(`${code}-S`)).status).toBe(200);
  expect((await consent(`${code}-T`, "tutor")).status).toBe(200);
  return { code, id: created.body.lesson.lessonId };
}

describe("R-8: the overview's tick and the owner's changes have separate allowances", () => {
  test("the tick allows its own 60 a minute and then answers 429 with Retry-After; meanwhile revoke, reissue, consent, a new lesson and cancel all still succeed", async () => {
    const owner = OWNERS[0];
    const lesson = await lessonBy(owner);
    signedIn(owner);
    const ticks = [];
    for (let n = 0; n < TICKS + 2; n += 1) ticks.push(await tick());
    expect(ticks.slice(0, TICKS).every(answer => answer.status === 200)).toBe(true);
    expect(ticks.slice(TICKS).map(answer => [answer.status, answer.body.code])).toEqual([[429, "RATE_LIMITED"], [429, "RATE_LIMITED"]]);
    const refused = ticks.at(-1);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(refused.headers.get("RateLimit-Limit")).toBe(String(TICKS));
    expect(ticks[0].headers.get("RateLimit-Limit")).toBe(String(TICKS));

    // The overview's allowance is spent; the owner's changes are not touched by it.
    expect((await change(lesson, "revoke_link")).status).toBe(200);
    const reissued = await change(lesson, "reissue_link");
    expect(reissued.status).toBe(200);
    expect(reissued.body.studentLink).toMatch(/#k=/);
    expect((await consent(`${lesson.code}-S`)).status).toBe(200);
    const other = await lessonBy(owner);
    const cancelled = await change(other, "cancel");
    expect(cancelled.status).toBe(200);
    expect(cancelled.headers.get("RateLimit-Limit")).toBe(String(CHANGES));
    // And the tick is still refused: the changes did not give it more either.
    expect((await tick()).status).toBe(429);
  });

  test("the owner's 30 changes a minute still stand (the 31st is refused), and the overview's tick still runs after them", async () => {
    const owner = OWNERS[1];
    const lesson = await lessonBy(owner); // 3 changes
    signedIn(owner);
    for (let n = 3; n < CHANGES; n += 1) expect((await consent(`${lesson.code}-S`)).status).toBe(200);
    const refused = await change(lesson, "cancel");
    expect([refused.status, refused.body.code]).toEqual([429, "RATE_LIMITED"]);
    expect(refused.headers.get("RateLimit-Limit")).toBe(String(CHANGES));
    // The refused cancel changed nothing.
    const overview = await read(await lessonsRoute.GET(new Request(`${ORIGIN}/api/admin/classrooms`)));
    expect(overview.body.lessons.find(item => item.code === lesson.code)?.cancelled).toBeFalsy();
    const ticked = await tick();
    expect(ticked.status).toBe(200);
    expect(ticked.headers.get("RateLimit-Limit")).toBe(String(TICKS));
  });

  test("at the same time, 80 ticks and 30 changes: exactly 60 ticks and 27 changes (30 less the lesson's 3) go through, every other one is 429, and nothing fails otherwise", async () => {
    const owner = OWNERS[2];
    const lesson = await lessonBy(owner);
    signedIn(owner);
    const [ticks, changes] = await Promise.all([
      Promise.all(Array.from({ length: 80 }, () => tick())),
      Promise.all(Array.from({ length: 30 }, () => consent(`${lesson.code}-S`))),
    ]);
    expect(statuses(ticks)).toEqual({ 200: TICKS, 429: 80 - TICKS });
    expect(statuses(changes)).toEqual({ 200: CHANGES - 3, 429: 3 });
  });

  test("a cancel sent while the overview is ticking hard (100 at once) is not refused and is stored; a minute later the overview's tick runs again", async () => {
    const owner = OWNERS[3];
    const lesson = await lessonBy(owner);
    signedIn(owner);
    const [ticks, cancelled] = await Promise.all([
      Promise.all(Array.from({ length: 100 }, () => tick())),
      change(lesson, "cancel"),
    ]);
    expect(cancelled.status).toBe(200);
    expect(statuses(ticks)).toEqual({ 200: TICKS, 429: 100 - TICKS });
    vi.setSystemTime(new Date(Date.now() + 61 * SEC));
    expect((await tick()).status).toBe(200);
    const overview = await read(await lessonsRoute.GET(new Request(`${ORIGIN}/api/admin/classrooms`)));
    expect(overview.body.lessons.find(item => item.code === lesson.code)?.cancelled).toBe(true);
  });

  test("a refused tick or change can be retried once its minute has passed (Retry-After says when), and not before", async () => {
    const owner = OWNERS[4];
    const lesson = await lessonBy(owner);
    signedIn(owner);
    for (let n = 0; n < TICKS; n += 1) expect((await tick()).status).toBe(200);
    const refusedTick = await tick();
    expect(refusedTick.status).toBe(429);
    const wait = Number(refusedTick.headers.get("Retry-After"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    for (let n = 3; n < CHANGES; n += 1) expect((await consent(`${lesson.code}-S`)).status).toBe(200);
    expect((await change(lesson, "revoke_link")).status).toBe(429);

    vi.setSystemTime(new Date(Date.now() + (wait - 1) * SEC));
    expect((await tick()).status).toBe(429);
    vi.setSystemTime(new Date(Date.now() + 2 * SEC));
    expect((await tick()).status).toBe(200);
    expect((await change(lesson, "revoke_link")).status).toBe(200);
  });

  test("the tick keeps its checks: signed out, an editor and another site's page get 403 and use none of the owner's allowance; each owner has their own", async () => {
    const owner = OWNERS[5];
    signedIn(null);
    expect((await tick()).status).toBe(403);
    signedIn(EDITOR);
    expect((await tick()).status).toBe(403);
    signedIn(owner);
    const crossSite = await tick({ origin: "https://elsewhere.example" });
    expect([crossSite.status, crossSite.body.error]).toEqual([403, "Cross-origin request blocked"]);
    // None of those counted: the owner still has the whole minute's allowance.
    for (let n = 0; n < TICKS; n += 1) expect((await tick()).status).toBe(200);
    expect((await tick()).status).toBe(429);
    // Another owner's overview is not held up by this one.
    signedIn(OWNERS[6]);
    expect((await tick()).status).toBe(200);
  });

  test("an owner change from another site's page is still blocked (403) and changes nothing, whatever the tick's allowance", async () => {
    const owner = OWNERS[7];
    const lesson = await lessonBy(owner);
    signedIn(owner);
    const blocked = await change(lesson, "cancel", { origin: "https://elsewhere.example" });
    expect([blocked.status, blocked.body.error]).toEqual([403, "Cross-origin request blocked"]);
    const overview = await read(await lessonsRoute.GET(new Request(`${ORIGIN}/api/admin/classrooms`)));
    expect(overview.body.lessons.find(item => item.code === lesson.code)?.cancelled).toBeFalsy();
    expect((await change(lesson, "cancel")).status).toBe(200);
  });
});
