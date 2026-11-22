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

// Gate B round 10 (2026-11-22), after the independent review: the filings route's retention actions.
// With no retention period set they do not exist (the same answer as before Gate B); set, only an
// owner previews and applies, and an apply is recorded in the activity record (or said when it could
// not be). Synthetic data, the file store, the local Drive stand-in.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-retention-route-"));
const OWNER = "retention-owner@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "");
const route = await import("../app/api/admin/classrooms/filings/route");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "");
  vi.stubEnv("CLASSROOM_RECORDING_RETENTION_MODE", "");
  vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "");
  vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", "");
  auth.mockResolvedValue({ user: { email: OWNER } });
  findAdminAccount.mockResolvedValue(null);
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-11-22T00:01:00.000Z" } });
});

const post = body => new Request(`${ORIGIN}/api/admin/classrooms/filings`, {
  method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
});
const read = async response => ({ status: response.status, body: await response.json() });

describe("the filings route's retention actions", () => {
  test("RR-1: with no retention period set the retention actions do not exist: the same answer as before Gate B, nothing recorded", async () => {
    for (const action of ["retention_preview", "retention_apply", "bogus"]) {
      const answer = await read(await route.POST(post({ action, confirm: "x" })));
      expect(answer, action).toEqual({ status: 400, body: { error: "Use action: retry", code: "INVALID_ACTION" } });
    }
    expect(appendAdminActivity).not.toHaveBeenCalled();
  });

  test("RR-2: set, an owner previews (nothing changes) and applies exactly the preview's plan, recorded in the activity record; a plan that changed is refused and not recorded; an activity record that cannot be written is said", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "fixed-room");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", OWNER);
    const preview = await read(await route.POST(post({ action: "retention_preview" })));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ ok: true, days: 30, mode: "trash", scope: ["fixed-room"], byKind: { "fixed-room": 0 }, permanent: false, mayApply: true, due: [], truncated: false });
    expect(appendAdminActivity).not.toHaveBeenCalled();
    const stale = await read(await route.POST(post({ action: "retention_apply", confirm: "0".repeat(24) })));
    expect(stale).toMatchObject({ status: 409, body: { code: "PLAN_CHANGED" } });
    expect(appendAdminActivity).not.toHaveBeenCalled();
    const applied = await read(await route.POST(post({ action: "retention_apply", confirm: preview.body.digest })));
    expect(applied).toMatchObject({ status: 200, body: { ok: true, scope: ["fixed-room"], results: [] } });
    expect(appendAdminActivity).toHaveBeenCalledTimes(1);
    // Round 12: the activity record says what the apply did (here: nothing was due, nothing deleted).
    expect(appendAdminActivity.mock.calls[0][0]).toMatchObject({ actorEmail: OWNER, action: "classroom.recording_retention", changedFields: ["recordings"], entityId: preview.body.digest, entityStatus: "nothing_deleted" });
    appendAdminActivity.mockRejectedValueOnce(new Error("activity store down"));
    const unrecorded = await read(await route.POST(post({ action: "retention_apply", confirm: preview.body.digest })));
    expect(unrecorded).toMatchObject({ status: 200, body: { ok: true, activity: "not_recorded" } });
    // Set but not a whole number of days: said, nothing deleted.
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30d");
    expect(await read(await route.POST(post({ action: "retention_preview" })))).toMatchObject({ status: 409, body: { code: "RETENTION_INVALID" } });
  });

  test("RR-3: only an owner: anyone else is refused before anything is read", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "fixed-room");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", "someone-else@example.test");
    auth.mockResolvedValue({ user: { email: "someone-else@example.test" } });
    for (const action of ["retention_preview", "retention_apply"]) expect((await route.POST(post({ action, confirm: "x" }))).status, action).toBe(403);
    expect(appendAdminActivity).not.toHaveBeenCalled();
  });

  test("RR-4: round 12: an owner the site does not name among those who may delete is refused (403), nothing recorded; a plan that deletes for good needs permanent: true itself, never a look-alike", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "fixed-room");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", "another-owner@example.test");
    const preview = await read(await route.POST(post({ action: "retention_preview" })));
    expect(preview.body).toMatchObject({ ok: true, mayApply: false });
    expect(await read(await route.POST(post({ action: "retention_apply", confirm: preview.body.digest })))).toMatchObject({ status: 403, body: { code: "NOT_A_DELETER" } });
    expect(appendAdminActivity).not.toHaveBeenCalled();
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", OWNER);
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_MODE", "remove");
    const removing = await read(await route.POST(post({ action: "retention_preview" })));
    expect(removing.body).toMatchObject({ mode: "remove", permanent: true, mayApply: true });
    for (const permanent of [undefined, "true", 1, false]) {
      expect(await read(await route.POST(post({ action: "retention_apply", confirm: removing.body.digest, permanent }))), String(permanent)).toMatchObject({ status: 409, body: { code: "PERMANENT_NOT_CONFIRMED" } });
    }
    expect(appendAdminActivity).not.toHaveBeenCalled();
    expect(await read(await route.POST(post({ action: "retention_apply", confirm: removing.body.digest, permanent: true })))).toMatchObject({ status: 200, body: { ok: true } });
    expect(appendAdminActivity).toHaveBeenCalledTimes(1);
  });

  test("RR-5: round 12: a period that names no kind of recording, or a kind that does not exist, is said and deletes nothing", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", OWNER);
    expect(await read(await route.POST(post({ action: "retention_preview" })))).toMatchObject({ status: 409, body: { code: "RETENTION_SCOPE_NOT_SET" } });
    expect(await read(await route.POST(post({ action: "retention_apply", confirm: "x" })))).toMatchObject({ status: 409, body: { code: "RETENTION_SCOPE_NOT_SET" } });
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "all");
    expect(await read(await route.POST(post({ action: "retention_preview" })))).toMatchObject({ status: 409, body: { code: "RETENTION_SCOPE_INVALID" } });
    expect(appendAdminActivity).not.toHaveBeenCalled();
  });
});
