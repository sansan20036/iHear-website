import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Classroom 3.0 round 3 (2026-11-21): the fixed rooms in bulk, for an owner with many rooms (the
// iHear teacher asked for 100, named Room1, Room2, …): make many at once, get every link once more
// as a list, set every room's recording switch at once. On the server with the file store and a
// scripted stand-in for Zoom. Synthetic only: nothing here says how real Zoom behaves.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-fixed-rooms-bulk-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { classroomDrive } = await import("../lib/classroom-drive");
const { setSyntheticConsent, runClassroomTick } = await import("../lib/classroom-service");
const rooms = await import("../lib/classroom-fixed-rooms");
const { bulkRange, linksCsv, naturalByLabel, occupied, roomsToShow } = await import("../app/admin/classrooms/rooms/room-links");
// @ts-ignore
const { buildSessionTokenClaims, roomNameOf, signSessionToken } = await import("../tools/recording-pathway/classroom/eligibility.mjs");
// @ts-ignore
const { storeEvent } = await import("../tools/recording-pathway/classroom/webhook-ingest.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
  vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
});

const store = classroomStore();
const drive = classroomDrive();
const MIN = 60_000;
const START = Date.parse("2026-12-11T15:00:00Z");
const OWNER = { email: "rooms-owner@example.test", owner: true };
const LINK = /^\/classroom\/r\/(FR-[0-9a-f]{32})#k=([A-Za-z0-9_-]{43})$/;
const keyOf = link => LINK.exec(link)[2];
const starts = [];
const stops = [];
const provider = {
  name: "synthetic", webhookSecret: null,
  sessionToken: ({ lesson, participant, now, generation = 0 }) => {
    const claims = buildSessionTokenClaims({ lesson, participant, appKey: "synthetic-app", now, generation });
    return { token: signSessionToken(claims, "fixed-rooms-bulk-test-secret-not-real"), issuedAt: now, expiresAt: now + 30 * MIN };
  },
  startRecording: async (lesson, sessionId) => { starts.push([lesson.id, sessionId]); return { ok: true, httpStatus: 202 }; },
  stopRecording: async (lesson, sessionId) => { stops.push([lesson.id, sessionId]); return { ok: true, httpStatus: 202 }; },
  endSession: async () => ({ ok: true, httpStatus: 204 }),
  removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, observe: async () => ({ live: false, recording: null }),
  download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
};
const bulk = (action, input = {}, { now = START, principal = OWNER } = {}) => rooms.manageFixedRoomsBulk({ store, principal, action, input, now });
const manage = (action, input = {}, { now = START, principal = OWNER } = {}) => rooms.manageFixedRoom({ store, provider, drive, principal, action, input, now });
const ask = (roomId, key, name, now = START) => rooms.requestEntry({ store, roomId, key, name, now });
const stateOf = async (roomId, asked, now = START) => (await rooms.requestStatus({ store, roomId, requestId: asked.body.requestId, ticket: asked.body.ticket, now })).body.state;
const view = (now = START) => rooms.fixedRoomsView({ store, now });
const labelsNow = async () => (await view()).map(room => room.label);
const everything = async () => JSON.stringify(await store.eventsFor(["FR-REGISTRY", ...(await view()).map(room => room.id)]));

describe("the fixed rooms in bulk", () => {
  test("BR-1: off with the fixed rooms; an owner only; its own three actions, apart from a single room's", async () => {
    expect(rooms.FIXED_ROOM_BULK_ACTIONS).toEqual(["create_many", "export_links", "set_recording_all"]);
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "");
    for (const action of rooms.FIXED_ROOM_BULK_ACTIONS) expect((await bulk(action, { labels: ["Off1"], on: false })).status, action).toBe(404);
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
    for (const principal of [null, { email: "tutor@example.test", owner: false }, { email: "", owner: true }]) {
      for (const action of rooms.FIXED_ROOM_BULK_ACTIONS) expect((await bulk(action, { labels: ["Nope1"], on: false }, { principal })).body.code, action).toBe("OWNER_REQUIRED");
    }
    for (const action of ["create", "replace_link", "admit", "remove", "bogus", "", null, 7]) expect((await bulk(action, { label: "Single" })).body.code, String(action)).toBe("INVALID_ACTION");
    // A single room's manager does not know the bulk actions either.
    for (const action of rooms.FIXED_ROOM_BULK_ACTIONS) expect((await manage(action, { labels: ["Nope2"] })).body.code, action).toBe("INVALID_ACTION");
    expect(await labelsNow()).toEqual([]);
  });

  test("BR-2: with no room yet: nothing to give links for; every switch off is nothing to change", async () => {
    expect((await bulk("export_links")).body).toMatchObject({ ok: false, code: "NO_ROOMS" });
    expect((await bulk("set_recording_all", { on: false })).body).toEqual({ ok: true, recording: false, changed: [], unchanged: [], refused: [] });
  });

  test("BR-3: a run of numbers after a prefix makes that many rooms, in order, each with a link of its own given once; only hashes are kept", async () => {
    const made = await bulk("create_many", { prefix: "Room", from: 1, to: 12 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.failed).toEqual([]);
    expect(made.body.rooms.map(room => room.label)).toEqual(Array.from({ length: 12 }, (_, index) => `Room${index + 1}`));
    const ids = made.body.rooms.map(room => room.id);
    const keys = made.body.rooms.map(room => keyOf(room.link));
    expect(new Set(ids).size).toBe(12);
    expect(new Set(keys).size).toBe(12);
    for (const room of made.body.rooms) {
      expect(room.id).toMatch(rooms.ROOM_ID);
      expect(LINK.exec(room.link)[1]).toBe(room.id);
    }
    const stored = await everything();
    for (const key of keys) expect(stored).not.toContain(key);
    // Each link opens its own room and no other.
    expect((await ask(ids[0], keys[0], "Kyle")).status).toBe(200);
    expect((await ask(ids[1], keys[0], "Kyle")).body.code).toBe("NOT_FOUND");
    expect((await ask(ids[11], keys[11], "Ann")).status).toBe(200);
    // A prefix that ends with a space gives "Lab 1".
    const spaced = await bulk("create_many", { prefix: "Lab ", from: 1, to: 2 });
    expect(spaced.body.rooms.map(room => room.label)).toEqual(["Lab 1", "Lab 2"]);
    expect((await view()).filter(room => room.label.startsWith("Room")).every(room => room.linkGeneration === 1)).toBe(true);
  });

  test("BR-4: a list of names makes those rooms, each name tidied as a single room's is", async () => {
    const made = await bulk("create_many", { labels: ["Alpha", "  Beta  ", "Gamma   3"] });
    expect(made.status).toBe(201);
    expect(made.body.rooms.map(room => room.label)).toEqual(["Alpha", "Beta", "Gamma 3"]);
    expect(await labelsNow()).toEqual(expect.arrayContaining(["Alpha", "Beta", "Gamma 3"]));
  });

  test("BR-5: a request is refused whole, and nothing is made: over 100, a wrong shape, a bad name, a name twice, a name taken", async () => {
    const before = await labelsNow();
    const unchanged = async () => expect(await labelsNow()).toEqual(before);
    expect((await bulk("create_many", { prefix: "Big", from: 1, to: 101 })).body.code).toBe("TOO_MANY");
    expect((await bulk("create_many", { labels: Array.from({ length: 101 }, (_, index) => `Many${index}`) })).body.code).toBe("TOO_MANY");
    for (const shape of [{}, { labels: [] }, { labels: ["Ok1", 2] }, { labels: "Room1" }, { prefix: "Zero", from: 0, to: 3 }, { prefix: "Back", from: 3, to: 1 }, { prefix: "Half", from: 1.5, to: 2 }, { prefix: 5, from: 1, to: 2 }, { prefix: "Text", from: "1", to: "2" }, { prefix: "Far", from: 9999, to: 10000 }]) {
      expect((await bulk("create_many", shape)).body.code, JSON.stringify(shape)).toBe("INVALID_BULK");
    }
    await unchanged();
    expect((await bulk("create_many", { labels: ["Good1", "Bad-1", "小明", "Under_score"] })).body).toMatchObject({ ok: false, code: "INVALID_LABEL", labels: ["Bad-1", "小明", "Under_score"] });
    expect((await bulk("create_many", { prefix: "Bad-", from: 1, to: 2 })).body).toMatchObject({ code: "INVALID_LABEL", labels: ["Bad-1", "Bad-2"] });
    expect((await bulk("create_many", { prefix: "R".repeat(40), from: 1, to: 1 })).body.code).toBe("INVALID_LABEL");
    expect((await bulk("create_many", { labels: ["Twin", "Solo", "twin", "TWIN"] })).body).toMatchObject({ ok: false, code: "DUPLICATE_LABEL", labels: ["twin", "TWIN"] });
    expect((await bulk("create_many", { labels: ["Fresh9", "room1", "Alpha"] })).body).toMatchObject({ ok: false, code: "LABEL_TAKEN", labels: ["room1", "Alpha"] });
    // Room12 is there, Room13 is not: neither is made.
    expect((await bulk("create_many", { prefix: "Room", from: 12, to: 13 })).body).toMatchObject({ code: "LABEL_TAKEN", labels: ["Room12"] });
    await unchanged();
    for (const absent of ["Good1", "Solo", "Fresh9", "Room13"]) expect(before).not.toContain(absent);
  });

  test("BR-6: every link once more: each room named gets a new link, the old one lets nobody new in, people already in stay, and nothing but hashes is kept", async () => {
    const made = (await bulk("create_many", { labels: ["Exp1", "Exp2", "Exp3"] })).body.rooms;
    const [one, two, three] = made;
    const inside = await ask(one.id, keyOf(one.link), "Kyle");
    expect((await manage("admit", { room: one.id, request: inside.body.requestId })).status).toBe(200);
    const waiting = await ask(one.id, keyOf(one.link), "Ann");
    const again = await bulk("export_links", { rooms: [one.id, two.id] }, { now: START + MIN });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.failed).toEqual([]);
    expect(again.body.links.map(entry => [entry.room, entry.label, entry.generation])).toEqual([[one.id, "Exp1", 2], [two.id, "Exp2", 2]]);
    const fresh = Object.fromEntries(again.body.links.map(entry => [entry.room, keyOf(entry.link)]));
    expect(fresh[one.id]).not.toBe(keyOf(one.link));
    // The old link says it was replaced; the new one works; the room not named keeps its link.
    expect((await ask(one.id, keyOf(one.link), "Bo", START + 2 * MIN)).body.code).toBe("LINK_REPLACED");
    expect((await ask(one.id, fresh[one.id], "Bo", START + 2 * MIN)).status).toBe(200);
    expect((await ask(two.id, keyOf(two.link), "Cy", START + 2 * MIN)).body.code).toBe("LINK_REPLACED");
    expect((await ask(three.id, keyOf(three.link), "Dee", START + 2 * MIN)).status).toBe(200);
    // Already let in: stays. Waiting on the old link: no longer valid.
    expect(await stateOf(one.id, inside, START + 2 * MIN)).toBe("admitted");
    expect(await stateOf(one.id, waiting, START + 2 * MIN)).toBe("replaced");
    const stored = await everything();
    for (const key of Object.values(fresh)) expect(stored).not.toContain(key);
    const generations = Object.fromEntries((await view(START + 2 * MIN)).map(room => [room.label, room.linkGeneration]));
    expect([generations.Exp1, generations.Exp2, generations.Exp3]).toEqual([2, 2, 1]);
  });

  test("BR-7: the rooms to give links for are every room or a list of real ones: a wrong list is refused and replaces nothing", async () => {
    const before = Object.fromEntries((await view()).map(room => [room.id, room.linkGeneration]));
    const ids = Object.keys(before);
    for (const wrong of [[], "FR-all", [ids[0], 7], ["Room1"], ["../etc"]]) expect((await bulk("export_links", { rooms: wrong })).body.code, JSON.stringify(wrong)).toBe("INVALID_BULK");
    expect((await bulk("export_links", { rooms: [ids[0], `FR-${"0".repeat(32)}`] })).body.code).toBe("NO_SUCH_ROOM");
    expect(Object.fromEntries((await view()).map(room => [room.id, room.linkGeneration]))).toEqual(before);
    // The same room named twice is one room.
    const twice = await bulk("export_links", { rooms: [ids[0], ids[0]] }, { now: START + 3 * MIN });
    expect(twice.body.links).toHaveLength(1);
    // Every room: one new link each, in the rooms' natural order (Room2 before Room10).
    const all = await bulk("export_links", {}, { now: START + 4 * MIN });
    expect(all.status).toBe(200);
    expect(all.body.links).toHaveLength(ids.length);
    const labels = all.body.links.map(entry => entry.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })));
    expect(labels.indexOf("Room2")).toBeLessThan(labels.indexOf("Room10"));
    expect(new Set(all.body.links.map(entry => keyOf(entry.link))).size).toBe(ids.length);
  });

  describe("every room's recording switch at once", () => {
    let facts = 0;
    const fact = (lessonId, type, at, fields) => { facts += 1; return store.transaction(tx => storeEvent(tx, { source: "zoom_webhook", type, lessonId, occurredAt: at, receivedAt: at, key: `${type}:${lessonId}:${at}:${facts}`, ...fields })); };
    const switches = async (now = START) => Object.fromEntries((await view(now)).map(room => [room.label, room.recording.on]));

    test("BR-8: on only where the site allows fixed rooms to record: otherwise refused and nothing changes; anything but true or false is refused", async () => {
      expect((await bulk("set_recording_all", { on: true })).body.code).toBe("RECORDING_NOT_AVAILABLE");
      expect(Object.values(await switches()).every(on => on === false)).toBe(true);
      for (const wrong of ["yes", 1, null, undefined, "true"]) expect((await bulk("set_recording_all", { on: wrong })).body.code, String(wrong)).toBe("INVALID_SWITCH");
      const off = await bulk("set_recording_all", { on: false });
      expect(off.body.changed).toEqual([]);
      expect(off.body.unchanged).toHaveLength((await view()).length);
    });

    test("BR-9: with the site's switch on: every room on at once; a second time changes nothing; off is refused for a room that may be recording and said for that room, the others go off; after its lesson is ended it goes off too", async () => {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
      const all = await view();
      const on = await bulk("set_recording_all", { on: true });
      expect(on.body).toMatchObject({ ok: true, recording: true, unchanged: [], refused: [] });
      expect(on.body.changed).toHaveLength(all.length);
      expect(Object.values(await switches()).every(value => value === true)).toBe(true);
      expect((await view()).every(room => room.recording.available)).toBe(true);
      const second = await bulk("set_recording_all", { on: true });
      expect(second.body.changed).toEqual([]);
      expect(second.body.unchanged).toHaveLength(all.length);
      // A room whose lesson records: two people let in with consent, in it by Zoom's word, recording started.
      const made = (await bulk("create_many", { labels: ["Rec1"] })).body.rooms[0];
      expect((await manage("set_recording", { room: made.id, on: true })).status).toBe(200);
      const asked = [await ask(made.id, keyOf(made.link), "Ann"), await ask(made.id, keyOf(made.link), "Kyle")];
      for (const person of asked) expect((await manage("admit", { room: made.id, request: person.body.requestId })).status).toBe(200);
      const lessonId = (await rooms.requestStatus({ store, roomId: made.id, requestId: asked[0].body.requestId, ticket: asked[0].body.ticket, now: START })).body.lessonId;
      const lesson = await store.lesson(lessonId);
      for (const person of lesson.participants) await setSyntheticConsent({ store, personCode: person.code, role: "student", status: "granted", actor: OWNER.email, now: START - 30 * MIN });
      const sessionId = `ZS-${lessonId.slice(2, 10)}`;
      await fact(lessonId, "session.started", START + MIN, { providerSessionId: sessionId, sessionName: roomNameOf(lessonId, 0) });
      for (const person of lesson.participants) await fact(lessonId, "session.user_joined", START + MIN, { providerSessionId: sessionId, participantId: person.id });
      for (const at of [2, 3]) await runClassroomTick({ store, provider, drive, now: START + at * MIN, lessonIds: [lessonId], workerId: "br-rec" });
      expect(starts.filter(([id]) => id === lessonId)).toEqual([[lessonId, sessionId]]);
      await fact(lessonId, "session.recording_started", START + 4 * MIN, { providerSessionId: sessionId, status: "Recording" });
      const off = await bulk("set_recording_all", { on: false }, { now: START + 5 * MIN });
      expect(off.status).toBe(200);
      expect(off.body.refused).toEqual([{ room: made.id, label: "Rec1", code: "RECORDING_MAY_BE_ON" }]);
      expect(off.body.changed).toHaveLength(all.length);
      const after = await switches(START + 5 * MIN);
      expect(after.Rec1).toBe(true);
      expect(Object.entries(after).filter(([label]) => label !== "Rec1").every(([, value]) => value === false)).toBe(true);
      // The lesson ended (its recording stopped): now this room's switch goes off with the rest.
      expect((await manage("end_lesson", { room: made.id }, { now: START + 6 * MIN })).status).toBe(200);
      expect(stops.filter(([id]) => id === lessonId).map(([, session]) => session)).toContain(sessionId);
      const last = await bulk("set_recording_all", { on: false }, { now: START + 7 * MIN });
      expect(last.body).toMatchObject({ changed: [made.id], refused: [] });
      expect(Object.values(await switches(START + 7 * MIN)).every(value => value === false)).toBe(true);
      // The site's switch off again: on is refused, and off is still allowed.
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
      expect((await bulk("set_recording_all", { on: true })).body.code).toBe("RECORDING_NOT_AVAILABLE");
      expect((await bulk("set_recording_all", { on: false })).status).toBe(200);
    });
  });

  test("BR-10: exactly 100 rooms at a time are made; with more than 100 rooms in all, giving every link at once is refused and a list of rooms is asked for", async () => {
    const made = await bulk("create_many", { prefix: "Hall", from: 1, to: 100 });
    expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(201);
    expect(made.body.rooms).toHaveLength(100);
    expect(made.body.failed).toEqual([]);
    expect(made.body.rooms.at(-1).label).toBe("Hall100");
    expect(new Set(made.body.rooms.map(room => keyOf(room.link))).size).toBe(100);
    expect((await view()).length).toBeGreaterThan(100);
    expect((await bulk("export_links")).body.code).toBe("TOO_MANY");
    const some = await bulk("export_links", { rooms: made.body.rooms.slice(0, 100).map(room => room.id) }, { now: START + 8 * MIN });
    expect(some.status).toBe(200);
    expect(some.body.links).toHaveLength(100);
    expect((await bulk("export_links", { rooms: [...made.body.rooms.map(room => room.id), (await view()).find(room => room.label === "Room1").id] })).body.code).toBe("TOO_MANY");
  }, 120_000);
});

describe("the admin page's helpers for many rooms", () => {
  test("BR-11: the list of links as a file: a heading, one quoted line per room with its whole address, in the natural order, CRLF", () => {
    const csv = linksCsv("https://www.example.test", [{ label: "Room10", link: "/classroom/r/FR-b#k=B" }, { label: "Room2", link: "/classroom/r/FR-a#k=A" }, { label: "O'Brien 1", link: "/classroom/r/FR-c#k=C" }]);
    expect(csv).toBe('Room,Link\r\n"O\'Brien 1","https://www.example.test/classroom/r/FR-c#k=C"\r\n"Room2","https://www.example.test/classroom/r/FR-a#k=A"\r\n"Room10","https://www.example.test/classroom/r/FR-b#k=B"\r\n');
    expect(linksCsv("https://www.example.test", [{ label: 'Say "hi"', link: "/x" }])).toContain('"Say ""hi""","https://www.example.test/x"');
    expect(linksCsv("https://www.example.test", [])).toBe("Room,Link\r\n");
  });

  test("BR-12: rooms in a natural order; the rooms with somebody; narrowed by what is typed; the bulk form's numbers", () => {
    const list = ["Room10", "room2", "Room1", "Lab 3"].map(label => ({ label, inRoom: [], waiting: [] }));
    expect([...list].sort(naturalByLabel).map(room => room.label)).toEqual(["Lab 3", "Room1", "room2", "Room10"]);
    const some = [{ label: "Room1", inRoom: [{}], waiting: [] }, { label: "Room2", inRoom: [], waiting: [{}] }, { label: "Room10", inRoom: [], waiting: [] }];
    expect(some.map(occupied)).toEqual([true, true, false]);
    expect(roomsToShow(some, { onlyOccupied: true, search: "" }).map(room => room.label)).toEqual(["Room1", "Room2"]);
    expect(roomsToShow(some, { onlyOccupied: false, search: " room1 " }).map(room => room.label)).toEqual(["Room1", "Room10"]);
    expect(roomsToShow(some, { onlyOccupied: true, search: "ROOM10" })).toEqual([]);
    expect(roomsToShow(some, { onlyOccupied: false, search: "" }).map(room => room.label)).toEqual(["Room1", "Room2", "Room10"]);
    expect(bulkRange("Room", "1", "100")).toEqual({ prefix: "Room", from: 1, to: 100 });
    expect(bulkRange("Lab ", " 3 ", "4")).toEqual({ prefix: "Lab ", from: 3, to: 4 });
    for (const [prefix, from, to] of [["", "1", "2"], ["  ", "1", "2"], ["Room", "0", "2"], ["Room", "3", "2"], ["Room", "a", "2"], ["Room", "1", ""], ["Room", "1.5", "2"], ["Room", "-1", "2"], ["Room", "1", "12345"]]) expect(bulkRange(prefix, from, to), `${prefix}|${from}|${to}`).toBeNull();
  });

  test("BR-13: the route sends the three bulk actions to their own manager, and its activity record keeps field names only, never an answer's links", async () => {
    const route = await readFile(path.resolve("app/api/admin/classrooms/rooms/route.ts"), "utf8");
    expect(route).toMatch(/\(FIXED_ROOM_BULK_ACTIONS as readonly string\[\]\)\.includes\(String\(action\)\)\s*\? await manageFixedRoomsBulk\(/);
    expect(route).toContain("changedFields: Object.keys(input)");
    const activity = route.slice(route.indexOf("appendAdminActivity({"), route.indexOf("return respond(result.body, result.status)"));
    expect(activity).not.toMatch(/links|\.link\b|rooms\b(?!\/)/);
    const page = await readFile(path.resolve("app/admin/classrooms/rooms/page.tsx"), "utf8");
    // The list is made in the browser and offered for download; it is never sent anywhere.
    expect(page).toContain("new Blob([linksCsv(window.location.origin, list.rows)]");
    expect(page.match(/fetch\(/g)).toHaveLength(3);
    expect(page).not.toMatch(/localStorage|sessionStorage|console\./);
  });
});
