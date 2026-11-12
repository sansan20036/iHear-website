import { describe, expect, test } from "vitest";

import { HAND_NOTICE_MS, initialsOf, newHands, orderPeople, personLabel, spotlightOf, stageModeOf } from "../lib/classroom-room";

// Classroom 2.0 (2026-11-12): the room's layout rules, from the media state alone. Synthetic people
// with test codes only; nothing here touches a page, an SDK or the network.

const words = { tutor: "小老師", student: "學生" };
const person = (id, extra = {}) => ({ id, name: id, host: false, self: false, camera: true, microphone: true, video: "shown", ...extra });

describe("Classroom 2.0: what the room shows", () => {
  test("the stage shows the whiteboard, else the shared screen, else the people; Tencent's classroom is its own page", () => {
    expect(stageModeOf("zoom-video-sdk", "none", "none")).toBe("people");
    expect(stageModeOf("zoom-video-sdk", "receiving", "none")).toBe("share");
    expect(stageModeOf("zoom-video-sdk", "sending", "none")).toBe("share");
    expect(stageModeOf("zoom-video-sdk", "receiving", "viewing")).toBe("board");
    expect(stageModeOf("synthetic", "none", "presenting")).toBe("board");
    expect(stageModeOf("tencent-lcic", "receiving", "viewing")).toBe("embed");
  });

  test("a raised hand is told once, never to the page that raised it, and a hand raised again after lowering is told again", () => {
    const one = { id: "2", name: "TEST-S01", self: false };
    const own = { id: "1", name: "", self: true };
    expect(newHands([], [one, own])).toEqual([one]);
    expect(newHands([one], [one])).toEqual([]);
    expect(newHands([one], [])).toEqual([]);
    expect(newHands([], [one])).toEqual([one]);
    // A few seconds on top of the stage (3 to 5, as decided), then the counts keep it.
    expect(HAND_NOTICE_MS).toBeGreaterThanOrEqual(3_000);
    expect(HAND_NOTICE_MS).toBeLessThanOrEqual(5_000);
  });

  test("the tutor comes first, then raised hands in the order they went up, then the others by code, and this page's own person last", () => {
    const people = [person("TEST-S03"), person("me", { self: true, name: "TEST-S01" }), person("TEST-S02"), person("TEST-T01", { host: true }), person("TEST-S04")];
    expect(orderPeople(people).map(item => item.id)).toEqual(["TEST-T01", "TEST-S02", "TEST-S03", "TEST-S04", "me"]);
    const hands = [{ id: "TEST-S04", name: "TEST-S04", self: false }, { id: "TEST-S03", name: "TEST-S03", self: false }];
    expect(orderPeople(people, hands).map(item => item.id)).toEqual(["TEST-T01", "TEST-S04", "TEST-S03", "TEST-S02", "me"]);
    // The tutor's own page: the tutor is this page's person, so last.
    const tutorsView = [person("TEST-T01", { host: true, self: true }), person("TEST-S01")];
    expect(orderPeople(tutorsView).map(item => item.id)).toEqual(["TEST-S01", "TEST-T01"]);
    expect(people.map(item => item.id)).toEqual(["TEST-S03", "me", "TEST-S02", "TEST-T01", "TEST-S04"]);
  });

  test("a tile says the role and the participant code, never more; the short mark is the end of the code", () => {
    expect(personLabel(person("TEST-T01", { host: true }), words)).toBe("小老師 TEST-T01");
    expect(personLabel(person("TEST-S01"), words)).toBe("學生 TEST-S01");
    // The test room does not know the other person's code.
    expect(personLabel(person("remote", { name: "" }), words)).toBe("學生");
    expect(initialsOf(person("TEST-S01"), words)).toBe("S01");
    expect(initialsOf(person("x", { name: "abcd" }), words)).toBe("ABC");
    expect(initialsOf(person("remote", { name: "", host: true }), words)).toBe("小");
    expect(initialsOf(person("remote", { name: "" }), { tutor: "Tutor", student: "Student" })).toBe("S");
  });

  test("a person enlarged on this page stays enlarged only while they are in the room", () => {
    const people = [person("TEST-S01"), person("TEST-S02")];
    expect(spotlightOf("TEST-S02", people)).toBe("TEST-S02");
    expect(spotlightOf("TEST-S09", people)).toBeNull();
    expect(spotlightOf(null, people)).toBeNull();
  });
});
