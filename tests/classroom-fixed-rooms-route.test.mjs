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

// Classroom 3.0 round 7 (2026-11-21): the fixed rooms' admin route when the activity record cannot
// be written. The change is made before the record is written, so the answer must still reach the
// owner (a new room's link exists in that answer only), say that the record is missing, and never
// put the answer into the server's log. Synthetic data, the file store, the synthetic provider.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-fixed-rooms-route-"));
const OWNER = "rooms-owner@example.test";
const ORIGIN = "http://localhost:3000";
vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_WEBHOOK_SECRET", "classroom-rooms-route-webhook-test-only");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "classroom-rooms-route-token-test-only");
vi.stubEnv("VERCEL_ENV", "");
vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
const route = await import("../app/api/admin/classrooms/rooms/route");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { email: OWNER } });
  findAdminAccount.mockResolvedValue(null);
  appendAdminActivity.mockResolvedValue(undefined);
  enforceRateLimit.mockResolvedValue({ limited: false, result: { allowed: true, limit: 30, remaining: 29, retryAfter: 60, resetAt: "2026-11-21T00:01:00.000Z" } });
});

const post = body => new Request(`${ORIGIN}/api/admin/classrooms/rooms`, {
  method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
});
const read = async response => ({ status: response.status, body: await response.json() });
const LINK = /^\/classroom\/r\/FR-[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/;

describe("fixed rooms' admin route: an activity record that cannot be written", () => {
  test("FR-A1: the change is made and its answer comes back with its link, saying the record is missing; the server's log names the action only; with the record written nothing is added", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      appendAdminActivity.mockRejectedValueOnce(new Error("activity store down"));
      const made = await read(await route.POST(post({ action: "create", label: "Audit Room" })));
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ ok: true, activity: "not_recorded" });
      expect(made.body.link).toMatch(LINK);
      const lines = logged.mock.calls.map(args => args.join(" "));
      expect(lines).toEqual(["[classroom] fixed room change classroom.fixed_room_create made, but its activity record could not be written"]);
      expect(lines.join(" ")).not.toContain(made.body.link.split("#k=")[1]);
      // The room really exists, once; its link from that answer is the current one.
      const rooms = (await read(await route.GET(new Request(`${ORIGIN}/api/admin/classrooms/rooms`)))).body.rooms;
      expect(rooms.filter(room => room.label === "Audit Room")).toHaveLength(1);
      // A later change whose record is written says nothing more.
      const room = rooms.find(entry => entry.label === "Audit Room");
      const replaced = await read(await route.POST(post({ action: "replace_link", room: room.id })));
      expect(replaced.status).toBe(200);
      expect(replaced.body.activity).toBeUndefined();
      expect(appendAdminActivity).toHaveBeenCalledTimes(2);
      expect(appendAdminActivity.mock.calls.map(([entry]) => entry.action)).toEqual(["classroom.fixed_room_create", "classroom.fixed_room_replace_link"]);
      expect(JSON.stringify(appendAdminActivity.mock.calls)).not.toMatch(/#k=|\/classroom\/r\//);
    } finally {
      logged.mockRestore();
    }
  });

  test("FR-A2: a refusal changes nothing, writes no record and says nothing about one", async () => {
    const refused = await read(await route.POST(post({ action: "admit", room: `FR-${"0".repeat(32)}`, request: "R-none" })));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(refused.body.code).toBe("NO_SUCH_ROOM");
    expect(appendAdminActivity).not.toHaveBeenCalled();
    expect(refused.body.activity).toBeUndefined();
  });
});
