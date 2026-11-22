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
    const preview = await read(await route.POST(post({ action: "retention_preview" })));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ ok: true, days: 30, mode: "trash", due: [], truncated: false });
    expect(appendAdminActivity).not.toHaveBeenCalled();
    const stale = await read(await route.POST(post({ action: "retention_apply", confirm: "0".repeat(24) })));
    expect(stale).toMatchObject({ status: 409, body: { code: "PLAN_CHANGED" } });
    expect(appendAdminActivity).not.toHaveBeenCalled();
    const applied = await read(await route.POST(post({ action: "retention_apply", confirm: preview.body.digest })));
    expect(applied).toMatchObject({ status: 200, body: { ok: true, results: [] } });
    expect(appendAdminActivity).toHaveBeenCalledTimes(1);
    expect(appendAdminActivity.mock.calls[0][0]).toMatchObject({ actorEmail: OWNER, action: "classroom.recording_retention", changedFields: ["recordings"], entityId: preview.body.digest });
    appendAdminActivity.mockRejectedValueOnce(new Error("activity store down"));
    const unrecorded = await read(await route.POST(post({ action: "retention_apply", confirm: preview.body.digest })));
    expect(unrecorded).toMatchObject({ status: 200, body: { ok: true, activity: "not_recorded" } });
    // Set but not a whole number of days: said, nothing deleted.
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30d");
    expect(await read(await route.POST(post({ action: "retention_preview" })))).toMatchObject({ status: 409, body: { code: "RETENTION_INVALID" } });
  });

  test("RR-3: only an owner: anyone else is refused before anything is read", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    auth.mockResolvedValue({ user: { email: "someone-else@example.test" } });
    for (const action of ["retention_preview", "retention_apply"]) expect((await route.POST(post({ action, confirm: "x" }))).status, action).toBe(403);
    expect(appendAdminActivity).not.toHaveBeenCalled();
  });
});
