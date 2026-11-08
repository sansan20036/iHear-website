import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));
vi.mock("../lib/rate-limit", async original => ({ ...await original(), enforceRateLimit: vi.fn() }));

import { auth } from "../auth.js";
import { appendAdminActivity, findAdminAccount } from "../lib/admin-store";
import { enforceRateLimit } from "../lib/rate-limit";
import { allowRecording, confirmationFor, createTestLesson, driveSettings, lessonSummary, runTick } from "../tools/classroom-recording-test/runner.mjs";

// The local recording test's steps (tools/classroom-recording-test/runner.mjs) against the site's
// own routes, as recording-test.mjs runs them. The provider is the Zoom adapter with placeholder
// settings and an address on this computer that answers nothing, so the trial-consent gate is the
// real one and no request could reach Zoom; nothing in these steps calls Zoom anyway (no session
// is known). Synthetic data only: TEST- codes and test.invalid addresses.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-recording-test-"));
const OWNER = "recording-test-owner@test.invalid";
const TUTOR = "test-t01@test.invalid";
const ORIGIN = "http://localhost:3320";
const CRON = "recording-test-cron-secret-0123456789abcdef";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "zoom-video-sdk");
for (const name of ["ZOOM_VIDEO_SDK_KEY", "ZOOM_VIDEO_SDK_SECRET", "ZOOM_VIDEO_SDK_API_KEY", "ZOOM_VIDEO_SDK_API_SECRET", "ZOOM_VIDEO_SDK_WEBHOOK_SECRET"]) vi.stubEnv(name, `TEST-placeholder-${name}`);
vi.stubEnv("ZOOM_API_BASE", "http://127.0.0.1:9/v2");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_SESSION_REPORTS", "verify");
vi.stubEnv("CLASSROOM_TRIAL_CONSENT", "");
vi.stubEnv("CRON_SECRET", CRON);
vi.stubEnv("VERCEL_ENV", "");
const lessons = await import("../app/api/admin/classrooms/route");
const consents = await import("../app/api/admin/classrooms/consents/route");
const scheduledRoute = await import("../app/api/classroom/scheduled-tick/route");
const { classroomStore } = await import("../lib/classroom-store");

vi.useFakeTimers({ toFake: ["Date"] });
afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  findAdminAccount.mockResolvedValue(null);
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-12-01T00:01:00.000Z" } });
});
const at = iso => vi.setSystemTime(new Date(iso));

// What recording-test.mjs sends over HTTP, handed to the routes directly.
const sent = [];
async function call(method, pathname, { as = null, body = null, headers = {} } = {}) {
  sent.push(`${method} ${pathname}`);
  auth.mockResolvedValue(as === "owner" ? { user: { email: OWNER } } : null);
  const request = new Request(`${ORIGIN}${pathname}`, { method, headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const route = {
    "POST /api/admin/classrooms": () => lessons.POST(request),
    "GET /api/admin/classrooms": () => lessons.GET(request),
    "POST /api/admin/classrooms/consents": () => consents.POST(request),
    "GET /api/classroom/scheduled-tick": () => scheduledRoute.GET(request),
  }[`${method} ${pathname}`];
  if (!route) throw new Error(`the test site has no route for ${method} ${pathname}`);
  const response = await route();
  return { status: response.status, json: await response.json().catch(() => null) };
}

describe("the local recording test's steps", () => {
  const codes = { code: "TEST-R1", tutorCode: "TEST-T01", studentCode: "TEST-S01" };
  let lesson;

  test("a TEST- lesson is added through the site's own route; any other code is refused before anything is sent", async () => {
    at("2026-12-01T01:30:00Z");
    for (const changed of [{ code: "R1" }, { tutorCode: "Tutor-1" }, { studentCode: "S01" }]) {
      await expect(createTestLesson({ call, date: "2026-12-01", time: "10:00", tutorEmail: TUTOR, ...codes, ...changed })).rejects.toThrow(/TEST- code/);
    }
    await expect(createTestLesson({ call, date: "1 Dec", time: "10:00", tutorEmail: TUTOR, ...codes })).rejects.toThrow(/YYYY-MM-DD/);
    expect(sent).toEqual([]);
    lesson = await createTestLesson({ call, date: "2026-12-01", time: "10:00", minutes: 30, tutorEmail: TUTOR, ...codes });
    expect(lesson).toMatchObject({ code: "TEST-R1", startsAt: "2026-12-01T02:00:00.000Z", endsAt: "2026-12-01T02:30:00.000Z" });
    // P3's personal links carry the key behind # (since 2026-11-06), so no server ever sees it.
    expect(lesson.studentLink).toMatch(/^\/classroom\/L-[A-Za-z0-9-]+#k=/);
  });

  test("recording is allowed only by the exact phrase; until then trial consent stays off and nothing is recorded", async () => {
    let switchedOn = 0;
    const enableTrialConsent = () => { switchedOn += 1; vi.stubEnv("CLASSROOM_TRIAL_CONSENT", "1"); };
    // The site itself refuses a consent while the test has not switched trial consent on.
    expect(await call("POST", "/api/admin/classrooms/consents", { as: "owner", body: { personCode: "TEST-S01", role: "student", status: "granted" } }))
      .toMatchObject({ status: 403, json: { code: "POLICY_PENDING" } });
    sent.length = 0;
    for (const typed of ["", "yes", "record TEST-R1", "RECORD TEST-R2", "RECORD  TEST-R1"]) {
      expect(await allowRecording({ call, lesson, ...codes, ask: async () => typed, enableTrialConsent })).toEqual({ allowed: false });
    }
    expect([switchedOn, sent]).toEqual([0, []]);
    expect(await classroomStore().listConsents(["TEST-S01"])).toEqual([]);
    // The exact phrase (spaces around it do not matter): switched on, then both records made.
    const questions = [];
    expect(await allowRecording({ call, lesson, ...codes, ask: async question => { questions.push(question); return ` ${confirmationFor("TEST-R1")} \n`; }, enableTrialConsent })).toEqual({ allowed: true });
    expect(questions[0]).toContain("RECORD TEST-R1");
    expect(switchedOn).toBe(1);
    expect(sent).toEqual(["POST /api/admin/classrooms/consents", "POST /api/admin/classrooms/consents"]);
    expect((await classroomStore().listConsents(["TEST-S01"])).map(record => record.status)).toEqual(["granted"]);
    expect(await classroomStore().listStaffNotices(["TEST-T01"])).toHaveLength(1);
  });

  test("the scheduled tick decides the lesson may be recorded, and the summary shows codes and labels only", async () => {
    at("2026-12-01T01:50:00Z");
    const ticked = await runTick({ call, cronSecret: CRON });
    expect(ticked).toMatchObject({ status: 200, summary: { ok: true } });
    expect((await runTick({ call, cronSecret: "not-the-secret" })).status).toBe(401);
    const decision = (await classroomStore().eventsFor([lesson.lessonId])).find(event => event.type === "server.recording_eligibility");
    expect(decision).toMatchObject({ eligible: true });
    const lines = await lessonSummary({ call, lessonCode: "TEST-R1" });
    expect(lines[0]).toMatch(/^TEST-R1: /);
    const shown = lines.join("\n");
    for (const value of [TUTOR, OWNER, lesson.lessonId, "?k=", "http"]) expect(shown).not.toContain(value);
    expect(await lessonSummary({ call, lessonCode: "TEST-NONE" })).toEqual(["TEST-NONE: not on the overview"]);
  });

  test("Drive settings: the local stand-in, or the test account's grant files outside the repository and a [測試] folder", () => {
    const repo = process.cwd();
    const outside = path.join(os.tmpdir(), "ihear-grant");
    expect(driveSettings({ drive: "local" }, repo)).toEqual({ CLASSROOM_DRIVE: "local" });
    expect(driveSettings({ drive: "google", clientFile: path.join(outside, "client.json"), tokenFile: path.join(outside, "token.json") }, repo)).toEqual({
      CLASSROOM_DRIVE: "google", CLASSROOM_GOOGLE_CLIENT_FILE: path.join(outside, "client.json"), CLASSROOM_GOOGLE_TOKEN_FILE: path.join(outside, "token.json"),
      CLASSROOM_DRIVE_ROOT_NAME: "[測試] iHear P1 錄影測試",
    });
    const refused = (changes, message) => expect(() => driveSettings({ drive: "google", clientFile: path.join(outside, "client.json"), tokenFile: path.join(outside, "token.json"), ...changes }, repo)).toThrow(message);
    refused({ tokenFile: path.join(repo, "token.json") }, /outside the repository/);
    refused({ clientFile: path.join(os.homedir(), "OneDrive", "client.json") }, /OneDrive/);
    refused({ tokenFile: "token.json" }, /full path/);
    refused({ rootName: "iHear 錄影" }, /\[測試\]/);
    expect(() => driveSettings({ drive: "dropbox" }, repo)).toThrow(/local or google/);
  });
});
