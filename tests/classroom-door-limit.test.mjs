import { beforeEach, describe, expect, test, vi } from "vitest";

// Round 17 (f1's finding F3 and the review, 2026-11-25): which allowance a lesson's door uses. A
// one-to-one lesson keeps one allowance per address and lesson, and costs no extra read; a block's room
// counts per person with a block's address allowance; a fixed room (its lessons are coded ROOM-…, and
// its schedule event names the room) counts per person with six times the one-to-one address allowance.
const lessons = new Map();
const events = new Map();
const eventsFor = vi.fn(async ([id]) => { if (id === "L-broken") throw new Error("store down"); return events.get(id) ?? []; });
vi.mock("../lib/classroom-store", () => ({
  classroomStore: () => ({ lesson: async (id) => lessons.get(id) ?? null, eventsFor }),
}));
const enforceRateLimit = vi.fn(async () => ({ limited: false, kind: "single" }));
const enforceRateLimits = vi.fn(async () => ({ limited: false, kind: "pair" }));
vi.mock("../lib/rate-limit", () => ({ clientIp: () => "203.0.113.7", enforceRateLimit, enforceRateLimits }));
const { lessonDoorLimit } = await import("../lib/classroom-rate-limit");

const request = new Request("https://test.example/api/classroom/L-1/join", { method: "POST" });
const join = (lessonId) => lessonDoorLimit(request, { scope: "classroom-join", lessonId, person: "K-person", single: 10, perPerson: 10, perPlace: 200 });
const status = (lessonId) => lessonDoorLimit(request, { scope: "classroom-status", lessonId, person: "K-person", single: 30, perPerson: 30, perPlace: 400 });
const limitsOf = (call) => call[1].map((p) => [p.scope, p.limit]);

describe("the door's allowance", () => {
  beforeEach(() => { lessons.clear(); events.clear(); eventsFor.mockClear(); enforceRateLimit.mockClear(); enforceRateLimits.mockClear(); });

  test("DL-1: a fixed room counts per person (10 joins) with 60 a minute per address (30 and 180 for status); a block's room keeps 200; a one-to-one lesson keeps ten per address and lesson", async () => {
    lessons.set("L-fixed", { id: "L-fixed", code: "ROOM-A-1" });
    events.set("L-fixed", [{ source: "server", type: "server.lesson_scheduled", fixedRoomId: "FR-1" }]);
    lessons.set("L-block", { id: "L-block", code: "B-1", blockId: "B-1" });
    lessons.set("L-one", { id: "L-one", code: "TEST-1" });

    expect(await join("L-fixed")).toEqual({ limited: false, kind: "pair" });
    expect(limitsOf(enforceRateLimits.mock.calls[0])).toEqual([["classroom-join", 60], ["classroom-join-person", 10]]);
    expect(enforceRateLimits.mock.calls[0][1][0].identifier).toBe("203.0.113.7:L-fixed");
    expect(enforceRateLimits.mock.calls[0][1][1].identifier).toMatch(/^203\.0\.113\.7:L-fixed:[0-9a-f]{16}$/);
    expect(await status("L-fixed")).toEqual({ limited: false, kind: "pair" });
    expect(limitsOf(enforceRateLimits.mock.calls[1])).toEqual([["classroom-status", 180], ["classroom-status-person", 30]]);

    expect(await join("L-block")).toEqual({ limited: false, kind: "pair" });
    expect(limitsOf(enforceRateLimits.mock.calls[2])).toEqual([["classroom-join", 200], ["classroom-join-person", 10]]);

    // A one-to-one lesson: the single allowance, and its events are never read for it.
    eventsFor.mockClear();
    expect(await join("L-one")).toEqual({ limited: false, kind: "single" });
    expect(enforceRateLimit).toHaveBeenCalledWith(request, { scope: "classroom-join", limit: 10, windowSeconds: 60, identifier: "203.0.113.7:L-one" });
    expect(eventsFor).not.toHaveBeenCalled();
  });

  test("DL-2: a one-to-one lesson an owner coded ROOM-… keeps its allowance (its events name no room); a ROOM-… lesson whose events cannot be read counts as the fixed room's; an unknown lesson keeps the single allowance", async () => {
    lessons.set("L-coded", { id: "L-coded", code: "ROOM-LIKE-BUT-ONE-TO-ONE" });
    events.set("L-coded", [{ source: "server", type: "server.lesson_scheduled" }]);
    lessons.set("L-broken", { id: "L-broken", code: "ROOM-B-2" });

    expect(await join("L-coded")).toEqual({ limited: false, kind: "single" });
    expect(eventsFor).toHaveBeenCalledWith(["L-coded"]);
    expect(await join("L-broken")).toEqual({ limited: false, kind: "pair" });
    expect(limitsOf(enforceRateLimits.mock.calls[0])).toEqual([["classroom-join", 60], ["classroom-join-person", 10]]);
    expect(await join("L-none")).toEqual({ limited: false, kind: "single" });
    expect(enforceRateLimits).toHaveBeenCalledTimes(1);
  });
});
