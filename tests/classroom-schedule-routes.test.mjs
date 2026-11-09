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

// P3-Multi (draft 030, §10): the programs and import routes. Owners only (an editor, a signed-out
// visitor and a cross-site request get nothing); every change and every import that made blocks
// is logged; a preview logs and changes nothing. Synthetic data only.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-schedule-routes-"));
const OWNER = "owner@example.test";
const EDITOR = "editor@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("VERCEL_ENV", "");
const programsRoute = await import("../app/api/admin/classrooms/programs/route");
const importRoute = await import("../app/api/admin/classrooms/import/route");

afterAll(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
  findAdminAccount.mockResolvedValue(null);
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-11-20T00:01:00.000Z" } });
});
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const post = (pathname, body = {}, headers = {}) => new Request(`${ORIGIN}${pathname}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const read = async response => ({ status: response.status, body: await response.json() });
const DIRECTORY = "Code,Role,English Name,Sign-in Email,Schedule Names\nTEST-M,manager,Mia Manager,m@example.test,\nTEST-T1,tutor,Carol Chen,t1@example.test,Carol\nTEST-S1,student,Amy Wang,,Amy";
const SCHEDULE = "Tutee,Date,Start,End,Lead Tutor,Co-Tutor,Observer,Pre-assign Room Name,Email Address\nAmy,2026-12-01,16:00,17:00,Carol,,,R1,";

describe("programs and import routes", () => {
  test("only an owner, from this site, may list or change programs and import; others get 401 or 403", async () => {
    expect([401, 403]).toContain((await programsRoute.GET(new Request(`${ORIGIN}/api/admin/classrooms/programs`))).status);
    expect([401, 403]).toContain((await importRoute.POST(post("/api/admin/classrooms/import", { action: "preview" }))).status);
    signedIn(EDITOR);
    findAdminAccount.mockResolvedValue({ email: EDITOR, enabled: true });
    expect((await programsRoute.POST(post("/api/admin/classrooms/programs", { action: "create_program", input: { code: "TEST-P", name: "X" } }))).status).toBe(403);
    expect((await importRoute.POST(post("/api/admin/classrooms/import", { action: "preview" }))).status).toBe(403);
    signedIn(OWNER);
    expect((await programsRoute.POST(post("/api/admin/classrooms/programs", { action: "create_program", input: { code: "TEST-P", name: "X" } }, { origin: "https://elsewhere.example.test" }))).status).toBe(403);
    expect(appendAdminActivity).not.toHaveBeenCalled();
  });

  test("an owner makes a program and a course, previews an import (nothing logged or made) and confirms it (logged once); a bad CSV is a 400", async () => {
    signedIn(OWNER);
    const program = await read(await programsRoute.POST(post("/api/admin/classrooms/programs", { action: "create_program", input: { code: "TEST-RP", name: "Synthetic Program" } })));
    expect(program.status).toBe(200);
    const course = await read(await programsRoute.POST(post("/api/admin/classrooms/programs", { action: "create_course", input: { program: "TEST-RP", code: "TEST-RC", name: "Synthetic Course", timeZone: "America/New_York" } })));
    expect(course.body.item).toMatchObject({ code: "TEST-RC", timeZone: "America/New_York" });
    expect((await read(await programsRoute.POST(post("/api/admin/classrooms/programs", { action: "create_course", input: { program: "TEST-RP", code: "TEST-RC", name: "Again", timeZone: "America/New_York" } })))).status).toBe(409);
    expect(appendAdminActivity).toHaveBeenCalledTimes(2);
    appendAdminActivity.mockClear();
    const body = { course: course.body.item.id, timeZone: "America/New_York", manager: "TEST-M", schedule: SCHEDULE, directory: DIRECTORY };
    const preview = await read(await importRoute.POST(post("/api/admin/classrooms/import", { action: "preview", ...body })));
    expect(preview.body.plan).toMatchObject({ ready: true, counts: { new: 1 } });
    expect(appendAdminActivity).not.toHaveBeenCalled();
    const listed = await read(await programsRoute.GET(new Request(`${ORIGIN}/api/admin/classrooms/programs`)));
    expect(listed.body.programs[0].courses[0].blocks).toBe(0);
    const applied = await read(await importRoute.POST(post("/api/admin/classrooms/import", { action: "apply", planHash: preview.body.plan.planHash, ...body })));
    expect(applied.status).toBe(200);
    expect(applied.body.created).toHaveLength(1);
    expect(appendAdminActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "classroom.schedule_import", entityStatus: "created:1" }));
    expect((await read(await importRoute.POST(post("/api/admin/classrooms/import", { action: "preview", ...body, schedule: 'Tutee,"Date' })))).body.code).toBe("UNTERMINATED_QUOTE");
  });
});
