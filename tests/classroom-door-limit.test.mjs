import { beforeEach, describe, expect, test, vi } from "vitest";

// Round 17 (f1's finding F3, 2026-11-25): which allowance a lesson's door uses. A one-to-one lesson
// keeps one allowance per address and lesson; a block's room and a fixed room (no blockId; its
// schedule event names the room) count per person, with a larger one for everyone behind an address.
const lessons = new Map();
const events = new Map();
vi.mock("../lib/classroom-store", () => ({
  classroomStore: () => ({
    lesson: async (id) => lessons.get(id) ?? null,
    eventsFor: async ([id]) => { if (id === "L-broken") throw new Error("store down"); return events.get(id) ?? []; },
  }),
}));
const enforceRateLimit = vi.fn(async () => ({ limited: false, kind: "single" }));
const enforceRateLimits = vi.fn(async () => ({ limited: false, kind: "pair" }));
vi.mock("../lib/rate-limit", () => ({ clientIp: () => "203.0.113.7", enforceRateLimit, enforceRateLimits }));
const { lessonDoorLimit } = await import("../lib/classroom-rate-limit");

const request = new Request("https://test.example/api/classroom/L-1/join", { method: "POST" });
const ask = (lessonId) => lessonDoorLimit(request, { scope: "classroom-join", lessonId, person: "K-person", single: 10, perPerson: 10, perPlace: 200 });

describe("the door's allowance", () => {
  beforeEach(() => { lessons.clear(); events.clear(); enforceRateLimit.mockClear(); enforceRateLimits.mockClear(); });

  test("DL-1: a fixed room's lesson counts per person (10) and per address (200), like a block's room; a one-to-one lesson keeps ten per address and lesson", async () => {
    lessons.set("L-fixed", { id: "L-fixed", code: "ROOM-A-1" });
    events.set("L-fixed", [{ source: "server", type: "server.lesson_scheduled", fixedRoomId: "FR-1" }]);
    lessons.set("L-block", { id: "L-block", blockId: "B-1" });
    lessons.set("L-one", { id: "L-one", code: "ROOM-LIKE-BUT-ONE-TO-ONE" });
    events.set("L-one", [{ source: "server", type: "server.lesson_scheduled" }]);

    expect(await ask("L-fixed")).toEqual({ limited: false, kind: "pair" });
    const [, policies] = enforceRateLimits.mock.calls[0];
    expect(policies.map((p) => [p.scope, p.limit])).toEqual([["classroom-join", 200], ["classroom-join-person", 10]]);
    expect(policies[0].identifier).toBe("203.0.113.7:L-fixed");
    expect(policies[1].identifier).toMatch(/^203\.0\.113\.7:L-fixed:[0-9a-f]{16}$/);

    expect(await ask("L-block")).toEqual({ limited: false, kind: "pair" });
    expect(await ask("L-one")).toEqual({ limited: false, kind: "single" });
    expect(enforceRateLimit).toHaveBeenCalledWith(request, { scope: "classroom-join", limit: 10, windowSeconds: 60, identifier: "203.0.113.7:L-one" });
    // An unknown lesson, or events that cannot be read: the single allowance, as before.
    expect(await ask("L-none")).toEqual({ limited: false, kind: "single" });
    lessons.set("L-broken", { id: "L-broken" });
    expect(await ask("L-broken")).toEqual({ limited: false, kind: "single" });
    expect(enforceRateLimits).toHaveBeenCalledTimes(2);
  });
});
