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
const { bulkRange, chunks, EXPORT_AT_ONCE, exportInParts, generationsOf, labelOf, labelsOfRange, linksCsv, linkStates, mergeMade, naturalByLabel, occupied, partOutcome, roomsToShow, rowsToExport, summaryOf } = await import("../app/admin/classrooms/rooms/room-links");
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

    test("BR-20 (round 4): every room's switch on at once never gets round the other rules: one person alone, or two with one consent missing, never record; two with consent do; the site's switch turned off afterwards wins over every room's switch left on", async () => {
      vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "on");
      try {
        const at = minutes => START + minutes * MIN;
        const made = (await bulk("create_many", { labels: ["Rec2", "Rec3", "Rec4", "Rec5"] }, { now: at(10) })).body.rooms;
        const on = await bulk("set_recording_all", { on: true }, { now: at(10) });
        expect(on.status).toBe(200);
        for (const room of made) expect(on.body.changed).toContain(room.id);
        // A room's lesson: these people let in (in this order), consent for those marked, all in by Zoom's word.
        const lessonIn = async (room, names, consented) => {
          const asked = [];
          for (const name of names) asked.push(await ask(room.id, keyOf(room.link), name, at(10)));
          for (const person of asked) expect((await manage("admit", { room: room.id, request: person.body.requestId }, { now: at(10) })).status).toBe(200);
          const lessonId = (await rooms.requestStatus({ store, roomId: room.id, requestId: asked[0].body.requestId, ticket: asked[0].body.ticket, now: at(10) })).body.lessonId;
          const lesson = await store.lesson(lessonId);
          for (const [index, person] of lesson.participants.entries()) if (consented[index]) await setSyntheticConsent({ store, personCode: person.code, role: "student", status: "granted", actor: OWNER.email, now: START });
          const sessionId = `ZS-${lessonId.slice(2, 10)}`;
          await fact(lessonId, "session.started", at(11), { providerSessionId: sessionId, sessionName: roomNameOf(lessonId, 0) });
          for (const person of lesson.participants) await fact(lessonId, "session.user_joined", at(11), { providerSessionId: sessionId, participantId: person.id });
          return { lessonId, sessionId };
        };
        const tick = (lessonId, minutes) => runClassroomTick({ store, provider, drive, now: at(minutes), lessonIds: [lessonId], workerId: "br-rec-all" });
        const decided = async lessonId => (await store.eventsFor([lessonId])).filter(event => event.type === "server.recording_eligibility").at(-1);
        const startsOf = lessonId => starts.filter(([id]) => id === lessonId);
        const alone = await lessonIn(made[0], ["Ann"], [true]);
        const missing = await lessonIn(made[1], ["Ann", "Bo"], [true, false]);
        const both = await lessonIn(made[2], ["Cy", "Di"], [true, true]);
        for (const { lessonId } of [alone, missing, both]) for (const minutes of [12, 13]) await tick(lessonId, minutes);
        expect(startsOf(alone.lessonId)).toEqual([]);
        expect(startsOf(missing.lessonId)).toEqual([]);
        expect(await decided(missing.lessonId)).toMatchObject({ eligible: false, reason: "CONSENT_MISSING" });
        expect(startsOf(both.lessonId)).toEqual([[both.lessonId, both.sessionId]]);
        // The site's switch off afterwards: two people with every consent, the room's own switch still
        // on from "every room on", never record.
        vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
        const late = await lessonIn(made[3], ["Ed", "Fay"], [true, true]);
        for (const minutes of [14, 15]) await tick(late.lessonId, minutes);
        expect((await switches(at(15))).Rec5).toBe(true);
        expect(startsOf(late.lessonId)).toEqual([]);
        expect(await decided(late.lessonId)).toMatchObject({ eligible: false, reason: "RECORDING_DISABLED" });
      } finally {
        vi.stubEnv("CLASSROOM_FIXED_ROOM_RECORDING", "");
      }
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

  test("BR-14: more rooms than the server takes at a time go in parts: every room once, in order, no part over the limit; the page's limit is the server's", () => {
    expect(EXPORT_AT_ONCE).toBe(rooms.BULK_MAX);
    const many = Array.from({ length: 250 }, (_, index) => index);
    const parts = chunks(many, EXPORT_AT_ONCE);
    expect(parts.map(part => part.length)).toEqual([100, 100, 50]);
    expect(parts.flat()).toEqual(many);
    expect(chunks(many.slice(0, 100), 100).map(part => part.length)).toEqual([100]);
    expect(chunks(many.slice(0, 101), 100).map(part => part.length)).toEqual([100, 1]);
    expect(chunks([], 100)).toEqual([]);
    // A size that makes no sense never loops for ever or drops a room.
    expect(chunks([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(chunks([1, 2, 3], 2.9)).toEqual([[1, 2], [3]]);
  });

  test("BR-16: every link anew in parts: the run stops at the first part refused or not known, never sends the parts after it, and always gives back the links of the parts done before; a room is only taken from its own part's answer", async () => {
    const list = Array.from({ length: 7 }, (_, index) => ({ id: `FR-${index}`, label: `Room${index + 1}` }));
    const labelOfId = id => `Room${Number(id.slice(3)) + 1}`;
    const made = ids => ids.map(id => ({ room: id, label: labelOfId(id), link: `/classroom/r/${id}#k=new`, generation: 2 }));
    const answered = ids => ({ ok: true, status: 200, data: { ok: true, links: made(ids), failed: [] } });
    const sent = [];
    const good = async ids => { sent.push(ids); return answered(ids); };
    // Every part answered.
    const all = await exportInParts(list, good, 3);
    expect(sent).toEqual([["FR-0", "FR-1", "FR-2"], ["FR-3", "FR-4", "FR-5"], ["FR-6"]]);
    expect(all).toEqual({ made: made(list.map(room => room.id)), notChanged: [], unknown: [], problem: null });
    // The second part refused whole (a 4xx with the server's code): nothing of it was changed; the
    // first part's links are kept, the rest is not changed, nothing more is sent.
    const at2 = reply => async ids => { sent.push(ids); return sent.length === 2 ? reply(ids) : answered(ids); };
    sent.length = 0;
    const refusedAt2 = await exportInParts(list, at2(() => ({ ok: false, status: 409, data: { ok: false, code: "NO_ROOMS" } })), 3);
    expect(sent).toHaveLength(2);
    expect(refusedAt2).toEqual({ made: made(["FR-0", "FR-1", "FR-2"]), notChanged: ["Room4", "Room5", "Room6", "Room7"], unknown: [], problem: { kind: "refused", data: { ok: false, code: "NO_ROOMS" } } });
    // The second part with no answer, a server error, an answer that cannot be read, or a 4xx with no
    // code of ours: its rooms are not known (the server may have changed them), the parts after it are
    // not sent and not changed, and the first part's links are kept.
    for (const reply of [
      () => { throw new TypeError("Failed to fetch"); },
      () => ({ ok: false, status: 503, data: { error: "The rooms are temporarily unavailable" } }),
      () => ({ ok: false, status: 500, data: { code: "ANY" } }),
      () => ({ ok: true, status: 200, data: {} }),
      () => ({ ok: true, status: 200, data: { links: "none" } }),
      () => ({ ok: false, status: 413, data: {} }),
    ]) {
      sent.length = 0;
      const result = await exportInParts(list, at2(reply), 3);
      expect(sent).toHaveLength(2);
      expect(result).toEqual({ made: made(["FR-0", "FR-1", "FR-2"]), notChanged: ["Room7"], unknown: ["Room4", "Room5", "Room6"], problem: { kind: "unknown" } });
    }
    // The very first part not known: nothing made, nothing more sent.
    sent.length = 0;
    expect(await exportInParts(list, async ids => { sent.push(ids); throw new Error("offline"); }, 3)).toEqual({ made: [], notChanged: ["Room4", "Room5", "Room6", "Room7"], unknown: ["Room1", "Room2", "Room3"], problem: { kind: "unknown" } });
    expect(sent).toHaveLength(1);
    // A part that answers for each room: a room someone else changed at the same moment is not changed
    // by this run (the look afterwards says whether its link still works); the run goes on.
    const some = await exportInParts(list.slice(0, 4), async ids => ({ ok: true, status: 200, data: { links: made(ids.slice(1)), failed: [{ room: ids[0], label: labelOfId(ids[0]), code: "CHANGED_CONCURRENTLY" }] } }), 2);
    expect(some).toEqual({ made: made(["FR-1", "FR-3"]), notChanged: ["Room1", "Room3"], unknown: [], problem: null });
    // The server's store failed part-way through a part (round 4): the links made are given back, the
    // room it failed on is not known, the rooms it did not try are not changed, and the run stops.
    sent.length = 0;
    const storeDown = await exportInParts(list, async ids => {
      sent.push(ids);
      if (sent.length === 1) return answered(ids);
      return { ok: true, status: 200, data: { links: made([ids[0]]), failed: [], unknown: [{ room: ids[1], label: labelOfId(ids[1]) }], notAttempted: [{ room: ids[2], label: labelOfId(ids[2]) }] } };
    }, 3);
    expect(sent).toHaveLength(2);
    expect(storeDown).toEqual({ made: made(["FR-0", "FR-1", "FR-2", "FR-3"]), notChanged: ["Room6", "Room7"], unknown: ["Room5"], problem: { kind: "unknown" } });
    // An answer about other rooms, a room twice or a link without a version gives nothing for them; a
    // room of the part the answer leaves out is not known, never taken as done.
    const odd = await exportInParts(list.slice(0, 2), async () => ({ ok: true, status: 200, data: { links: [
      { room: "FR-9", label: "Room10", link: "/x#k=a", generation: 2 },
      { room: "FR-0", label: "Room1", link: "/classroom/r/FR-0#k=first", generation: 2 },
      { room: "FR-0", label: "Room1", link: "/classroom/r/FR-0#k=again", generation: 3 },
      { room: "FR-1", label: "Room2", link: "/classroom/r/FR-1#k=b" },
      null,
    ] } }), 2);
    expect(odd).toEqual({ made: [{ room: "FR-0", label: "Room1", link: "/classroom/r/FR-0#k=first", generation: 2 }], notChanged: [], unknown: ["Room2"], problem: { kind: "unknown" } });
    // No rooms: nothing sent.
    sent.length = 0;
    expect(await exportInParts([], good)).toEqual({ made: [], notChanged: [], unknown: [], problem: null });
    expect(sent).toEqual([]);
  });

  test("BR-17: what an answer says: only a 4xx carrying the server's own code is a refusal (nothing changed); no answer, a server error or an answer that cannot be read is not known", () => {
    expect(partOutcome(null, "links")).toBe("unknown");
    expect(partOutcome({ ok: true, status: 200, data: { links: [] } }, "links")).toBe("answered");
    expect(partOutcome({ ok: true, status: 201, data: { rooms: [] } }, "rooms")).toBe("answered");
    expect(partOutcome({ ok: true, status: 200, data: { changed: [] } }, "changed")).toBe("answered");
    expect(partOutcome({ ok: true, status: 200, data: { rooms: [] } }, "links")).toBe("unknown");
    expect(partOutcome({ ok: true, status: 200, data: {} }, "rooms")).toBe("unknown");
    for (const status of [400, 403, 404, 409, 429]) expect(partOutcome({ ok: false, status, data: { code: "ANY" } }, "links")).toBe("refused");
    for (const status of [400, 408, 413]) expect(partOutcome({ ok: false, status, data: {} }, "links")).toBe("unknown");
    for (const status of [500, 502, 503, 504]) expect(partOutcome({ ok: false, status, data: { code: "ANY" } }, "links")).toBe("unknown");
    expect(partOutcome({ ok: false, data: { code: "ANY" } }, "links")).toBe("unknown");
    expect(partOutcome({ ok: false, status: 0, data: {} }, "links")).toBe("unknown");
  });

  test("BR-18: where each room stands after a change, from what was received and each link's version before and now; the file holds only links that work now; never complete unless every room is done", () => {
    const link = (label, generation) => ({ room: `FR-${label}`, label, link: `/classroom/r/FR-${label}#k=${label}${generation}`, generation });
    const asked = ["Room1", "Room2", "Room3", "Room4", "Room5", "Room6", "Room7", "Room10"];
    const baseline = { room1: 1, room2: 1, room3: 1, room4: 1, room5: 4, room6: 2, room10: 3 };
    const made = mergeMade({}, [link("Room1", 2), link("Room2", 2), link("Room10", 4)]);
    const current = { room1: 2, room2: 3, room3: 2, room4: 1, room5: 3, room6: 2, room10: 4 };
    const states = linkStates({ asked, baseline, made, current });
    expect(states).toEqual({
      room1: "done", // received, and it is the room's link now
      room2: "replacedAgain", // received, then replaced again: it no longer works
      room3: "lost", // replaced, no link received: the old one no longer works
      room4: "unchanged", // the link it had still works
      room5: "unknown", // older now than before: makes no sense
      room6: "unchanged",
      room7: "notCreated", // asked to be made, there is no such room
      room10: "done",
    });
    expect(rowsToExport(made, states)).toEqual([{ label: "Room1", link: "/classroom/r/FR-Room1#k=Room12" }, { label: "Room10", link: "/classroom/r/FR-Room10#k=Room104" }]);
    expect(summaryOf(asked, states)).toEqual({ done: ["Room1", "Room10"], replacedAgain: ["Room2"], lost: ["Room3"], unchanged: ["Room4", "Room6"], notCreated: ["Room7"], unknown: ["Room5"], complete: false });
    // The rooms could not be read again: what was received is shown, everything else is not known.
    const unread = linkStates({ asked, baseline, made, current: null });
    expect(summaryOf(asked, unread)).toMatchObject({ done: ["Room1", "Room2", "Room10"], unknown: ["Room3", "Room4", "Room5", "Room6", "Room7"], complete: false });
    // A link received for a room that is not listed now, or newer than the room's link: not known.
    expect(linkStates({ asked: ["Room1"], baseline: {}, made, current: {} })).toEqual({ room1: "unknown" });
    expect(linkStates({ asked: ["Room1"], baseline: {}, made, current: { room1: 1 } })).toEqual({ room1: "unknown" });
    // Names are matched without regard to capitals, as the server keeps them unique.
    expect(linkStates({ asked: ["ROOM1"], baseline: {}, made, current: { room1: 2 } })).toEqual({ room1: "done" });
    // Complete only when every room asked about is done; an empty list is never complete.
    const doneAll = linkStates({ asked: ["Room1", "Room10"], baseline, made, current });
    expect(summaryOf(["Room1", "Room10"], doneAll).complete).toBe(true);
    expect(summaryOf([], {}).complete).toBe(false);
    // The newest link of a room wins, whatever order the links come in.
    expect(mergeMade(mergeMade({}, [link("Room1", 3)]), [link("room1", 2)]).room1.generation).toBe(3);
    expect(mergeMade(mergeMade({}, [link("Room1", 2)]), [link("Room1", 3)]).room1.generation).toBe(3);
    expect(generationsOf([{ label: "Room1", linkGeneration: 2 }, { label: "Lab A", linkGeneration: 1 }])).toEqual({ room1: 2, "lab a": 1 });
    // The page names the rooms of a run exactly as the server keeps them.
    expect(labelsOfRange({ prefix: "  Lab  ", from: 9, to: 11 })).toEqual(["Lab 9", "Lab 10", "Lab 11"]);
    expect(labelOf(" Room  1 ")).toBe("Room 1");
    expect(labelsOfRange({ prefix: "Room", from: 3, to: 2 })).toEqual([]);
  });

  test("BR-15: the server takes the page's parts: 112 rooms in parts of 100 and 12 give every room one new link", async () => {
    const all = await view(START + 9 * MIN);
    expect(all.length).toBeGreaterThan(100);
    const before = Object.fromEntries(all.map(room => [room.id, room.linkGeneration]));
    const got = [];
    for (const part of chunks(all, EXPORT_AT_ONCE)) {
      const answer = await bulk("export_links", { rooms: part.map(room => room.id) }, { now: START + 10 * MIN });
      expect(answer.status, JSON.stringify(answer.body).slice(0, 200)).toBe(200);
      expect(answer.body.failed).toEqual([]);
      got.push(...answer.body.links);
    }
    expect(got).toHaveLength(all.length);
    expect(new Set(got.map(entry => entry.room)).size).toBe(all.length);
    expect(new Set(got.map(entry => keyOf(entry.link))).size).toBe(all.length);
    for (const entry of got) expect(entry.generation).toBe(before[entry.room] + 1);
  }, 120_000);

  test("BR-13: the route sends the three bulk actions to their own manager, and its activity record keeps field names only, never an answer's links", async () => {
    const route = await readFile(path.resolve("app/api/admin/classrooms/rooms/route.ts"), "utf8");
    expect(route).toMatch(/\(FIXED_ROOM_BULK_ACTIONS as readonly string\[\]\)\.includes\(String\(action\)\)\s*\? await manageFixedRoomsBulk\(/);
    expect(route).toContain("changedFields: Object.keys(input)");
    const activity = route.slice(route.indexOf("appendAdminActivity({"), route.indexOf("return respond(result.body, result.status)"));
    expect(activity).not.toMatch(/links|\.link\b|rooms\b(?!\/)/);
    const page = await readFile(path.resolve("app/admin/classrooms/rooms/page.tsx"), "utf8");
    // The list is made in the browser and offered for download; it is never sent anywhere.
    expect(page).toContain("new Blob([linksCsv(window.location.origin, rows)]");
    expect(page).toContain("const rows = rowsToExport(list.made, states);");
    expect(page.match(/fetch\(/g)).toHaveLength(3);
    expect(page).not.toMatch(/localStorage|sessionStorage|console\./);
    // Every link anew: the rooms go in parts the server takes, and the confirm says what happens to
    // the links handed out and to the people waiting.
    expect(page).toContain('exportInParts(targets, (ids) => send("export_links", { rooms: ids }))');
    expect(page).toContain("已經發出去的舊連結都不能再用來進教室（已經在教室裡的人不受影響）。正在等待進入的人，要用新連結重新輸入名字。");
    // Round 4: the links received are shown before the rooms are read again; nothing is sent again by
    // itself (a change only ever starts from a person's press, after a confirm); every answer is waited
    // for a limited time, and a request with no answer is caught, never thrown past the list.
    const lf = page.replace(/\r\n/g, "\n");
    const settle = lf.slice(lf.indexOf("async function settle("), lf.indexOf("async function recheck("));
    expect(settle.indexOf("setList(")).toBeGreaterThan(-1);
    expect(settle.indexOf("setList(")).toBeLessThan(settle.indexOf("await recheck(run)"));
    expect(lf.match(/await regenerate\(/g)).toHaveLength(2);
    expect(lf.match(/await makeRooms\(/g)).toHaveLength(2);
    for (const caller of ["async function exportAll()", "async function fillLinks(", "async function makeMissing("]) {
      const body = lf.slice(lf.indexOf(caller), lf.indexOf("\n  }\n", lf.indexOf(caller)));
      const change = Math.max(body.indexOf("await regenerate("), body.indexOf("await makeRooms("));
      expect(change, caller).toBeGreaterThan(-1);
      expect(body.indexOf("window.confirm("), caller).toBeGreaterThan(-1);
      expect(body.indexOf("window.confirm("), caller).toBeLessThan(change);
    }
    expect(lf).toContain("signal: AbortSignal.timeout(ANSWER_WITHIN_MS)");
    expect(lf.match(/try \{ answer = await send\(/g)).toHaveLength(2);
    expect(lf).toContain("ERRORS.OUTCOME_UNKNOWN");
    // The file is made only after the rooms were read again (a link replaced since is left out).
    const download = lf.slice(lf.indexOf("async function download()"), lf.indexOf("function dismiss()"));
    expect(download.indexOf("await recheck(")).toBeGreaterThan(-1);
    expect(download.indexOf("await recheck(")).toBeLessThan(download.indexOf("new Blob("));
    // A list with links not yet downloaded asks before the page is left or the list is put away.
    expect(lf).toContain('window.addEventListener("beforeunload", warn)');
    expect(lf).toContain("這份清單還沒有下載。");
  });
});

describe("a bulk change when the store fails part-way (round 4)", () => {
  // A store whose n-th write fails: before it is made ("before"), or after it was made with its
  // answer lost ("after"). Everything else goes to the real store.
  const failing = (at, when) => {
    let writes = 0;
    return new Proxy(store, {
      get(target, prop) {
        if (prop === "transaction") return async fn => {
          writes += 1;
          if (writes === at && when === "before") throw new Error("store down (test)");
          const result = await target.transaction(fn);
          if (writes === at && when === "after") throw new Error("answer lost (test)");
          return result;
        };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const bulkWith = (s, action, input, now = START + 20 * MIN) => rooms.manageFixedRoomsBulk({ store: s, principal: OWNER, action, input, now });

  test("BR-19: rooms and links made before the store failed are given back; the room it failed on is not known and the rest not tried; the page then says each room as it stands; a failure before anything was made is thrown (the route answers 503, which the page takes as not known)", async () => {
    const before = await view(START + 20 * MIN);
    // Making Flaky1 to Flaky5: the third room is made, but its answer is lost.
    const madeAnswer = await bulkWith(failing(3, "after"), "create_many", { prefix: "Flaky", from: 1, to: 5 });
    expect(madeAnswer.status).toBe(201);
    expect(madeAnswer.body.rooms.map(room => room.label)).toEqual(["Flaky1", "Flaky2"]);
    expect(madeAnswer.body.unknown).toEqual([{ label: "Flaky3" }]);
    expect(madeAnswer.body.notAttempted).toEqual([{ label: "Flaky4" }, { label: "Flaky5" }]);
    const listed = await view(START + 20 * MIN);
    expect(listed.map(room => room.label)).toEqual(expect.arrayContaining(["Flaky1", "Flaky2", "Flaky3"]));
    expect(listed.map(room => room.label)).not.toEqual(expect.arrayContaining(["Flaky4"]));
    const asked = labelsOfRange({ prefix: "Flaky", from: 1, to: 5 });
    const made = mergeMade({}, madeAnswer.body.rooms.map(room => ({ room: room.id, label: room.label, link: room.link, generation: 1 })));
    const states = linkStates({ asked, baseline: generationsOf(before), made, current: generationsOf(listed) });
    expect(summaryOf(asked, states)).toMatchObject({ done: ["Flaky1", "Flaky2"], lost: ["Flaky3"], notCreated: ["Flaky4", "Flaky5"], unknown: [], complete: false });
    expect(rowsToExport(made, states).map(row => row.label)).toEqual(["Flaky1", "Flaky2"]);

    // Every link of Flaky1 to Flaky3 anew: the second write fails before it is made.
    const ids = Object.fromEntries(listed.map(room => [room.label, room.id]));
    const exported = await bulkWith(failing(2, "before"), "export_links", { rooms: [ids.Flaky1, ids.Flaky2, ids.Flaky3] });
    expect(exported.status).toBe(200);
    expect(exported.body.links.map(entry => entry.label)).toEqual(["Flaky1"]);
    expect(exported.body.unknown).toEqual([{ room: ids.Flaky2, label: "Flaky2" }]);
    expect(exported.body.notAttempted).toEqual([{ room: ids.Flaky3, label: "Flaky3" }]);
    const after = await view(START + 21 * MIN);
    expect(linkStates({ asked: ["Flaky1", "Flaky2", "Flaky3"], baseline: generationsOf(listed), made: mergeMade({}, exported.body.links), current: generationsOf(after) }))
      .toEqual({ flaky1: "done", flaky2: "unchanged", flaky3: "unchanged" });
    // The same with the second write made and its answer lost: that room's old link no longer works.
    const lostAnswer = await bulkWith(failing(2, "after"), "export_links", { rooms: [ids.Flaky1, ids.Flaky2, ids.Flaky3] }, START + 22 * MIN);
    expect(lostAnswer.body.unknown).toEqual([{ room: ids.Flaky2, label: "Flaky2" }]);
    const later = await view(START + 22 * MIN);
    expect(linkStates({ asked: ["Flaky1", "Flaky2", "Flaky3"], baseline: generationsOf(after), made: mergeMade({}, lostAnswer.body.links), current: generationsOf(later) }))
      .toEqual({ flaky1: "done", flaky2: "lost", flaky3: "unchanged" });

    // Nothing made yet when the store fails: thrown as before, and nothing was changed.
    await expect(bulkWith(failing(1, "before"), "export_links", { rooms: [ids.Flaky1] })).rejects.toThrow("store down (test)");
    await expect(bulkWith(failing(1, "before"), "create_many", { labels: ["Flaky9"] })).rejects.toThrow("store down (test)");
    const last = await view(START + 23 * MIN);
    expect(last.map(room => room.label)).not.toContain("Flaky9");
    expect(generationsOf(last).flaky1).toBe(generationsOf(later).flaky1);
  });
});
