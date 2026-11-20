// Classroom 3.0 round 3 (2026-11-21): fixed classroom links (每間教室一個固定連結), the direction the
// user gave on 2026-11-21 (planning/2026-11-21-classroom-room-links-requirements.md). Each room has
// one link that keeps working until the iHear teacher replaces it. A person opens it, types a first
// name and waits; the iHear teacher (an owner of the site) lets them in, or not.
//
// Safe defaults while the teacher and iHear decide (the round 3 instructions; D-14, D-16):
//   - a link and a typed name never let anyone in by themselves: every person waits for the iHear
//     teacher's decision. Direct entry is not built: D-16 is not approved.
//   - nobody in a room can let others in or remove them; only owners act, from the admin pages.
//   - the typed name is shown to the iHear teacher (a second "Kyle" as "Kyle B"); the person's own
//     answer never says who else is there; in Zoom everyone shows by code (no name reaches Zoom).
//   - at most 10 people in a room, at most 20 waiting; a request nobody answers lapses in 30 minutes.
//   - a replaced link lets nobody new in: people already let in stay, requests made with an older
//     link are no longer valid. Removing a person moves the room's lesson to a new Zoom session (D-4,
//     as a revoked link in a one-to-one lesson does), so the token they hold leads nowhere.
//   - recording: a fixed room's lesson is an ordinary lesson for the recording rules (every
//     person's valid consent, the switches) and in addition needs two people in it
//     (lib/classroom-fixed-room-facts.ts). Nothing here turns recording on.
//
// Storage, no migration: a room's definition, its links, requests and decisions are the server's own
// facts (classroom_events: the definitions under FR-REGISTRY, the rest under the room's id). The
// people let in are the students of an ordinary lesson that the room opens when the first person is
// let in (at most 3 hours), so the classroom page, its sound fix, reconnects and recording rules are
// the one-to-one lesson's. Off unless CLASSROOM_FIXED_ROOMS=on (the pages and API answer 404).

import { randomBytes, randomUUID } from "node:crypto";

import { hashKey } from "./classroom-block-rules";
import type { ClassroomDrive } from "./classroom-drive";
import { distinctName, entryNameOf } from "./classroom-names";
import type { ClassroomProvider } from "./classroom-provider";
import { changeLessonAccess, stopRecordingForCancelledLesson } from "./classroom-service";
import type { ClassroomEvent, ClassroomLesson, ClassroomParticipant, ClassroomStore } from "./classroom-store";
import { HOUSE_TIME_ZONE, LEGACY_LESSON_TIME_ZONE, wallIn } from "./zoned-time";

export const FIXED_ROOM_CAPACITY = 10;
export const WAITING_MAX = 20;
export const REQUEST_TTL_MS = 30 * 60_000;
export const LESSON_LENGTH_MS = 3 * 60 * 60_000;
export const ROOM_ID = /^FR-[0-9a-f]{32}$/;
const REGISTRY = "FR-REGISTRY";
// A room's name goes into its recordings' file names: letters and digits first, then letters,
// digits, spaces, . and ' (no - or _, which separate a file name's parts), at most 40.
const ROOM_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .']{0,39}$/;

export function fixedRoomsEnabled(env: Record<string, string | undefined> = process.env) {
  return env.CLASSROOM_FIXED_ROOMS === "on";
}

const shortId = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, "")}`;
const iso = (ms: number) => new Date(ms).toISOString();
const refused = (status: number, code: string, error: string) => ({ status, body: { ok: false, code, error } });
const serverFacts = (events: readonly ClassroomEvent[], type: string) => events.filter((event) => event.source === "server" && event.type === type);
const remember = (store: ClassroomStore, events: ClassroomEvent[]) => store.transaction(async (tx) => {
  let all = true;
  for (const event of events) all = (await tx.insertEvent(event)) && all;
  return all;
});
// The key goes behind #: browsers never send it to any server; the page takes it out of the address.
const linkOf = (roomId: string, key: string) => `/classroom/r/${roomId}#k=${key}`;

type DecisionKind = "admitted" | "declined" | "removed";
type Decision = { kind: DecisionKind; at: number; actor: string; classLessonId: string | null; code: string | null };
type RoomRequest = { id: string; name: string; shown: string; ticketHash: string; at: number; generation: number; decisions: Decision[] };
type RoomLesson = { classLessonId: string; n: number; endsAt: number; ended: boolean };
export type FixedRoom = { id: string; label: string; createdAt: number; links: { generation: number; keyHash: string }[]; lessons: RoomLesson[]; requests: RoomRequest[] };
export type RequestState = "waiting" | "admitted" | "declined" | "removed" | "expired" | "replaced" | "ended";

// Of decisions made at the same moment, the stricter one stands.
const STRICTNESS: Record<DecisionKind, number> = { admitted: 0, declined: 1, removed: 2 };
const latestDecision = (request: RoomRequest) => [...request.decisions].sort((a, b) => a.at - b.at || STRICTNESS[a.kind] - STRICTNESS[b.kind]).at(-1) ?? null;

function roomFrom(definition: ClassroomEvent, events: readonly ClassroomEvent[]): FixedRoom {
  const id = String(definition.roomId);
  const own = events.filter((event) => event.lessonId === id);
  const ended = new Set(serverFacts(own, "server.room_lesson_ended").map((event) => String(event.classLessonId)));
  const decisions = new Map<string, Decision[]>();
  for (const event of serverFacts(own, "server.room_decision")) {
    const list = decisions.get(String(event.requestId)) ?? [];
    list.push({ kind: event.decision as DecisionKind, at: event.occurredAt, actor: String(event.actor ?? ""), classLessonId: event.classLessonId == null ? null : String(event.classLessonId), code: event.code == null ? null : String(event.code) });
    decisions.set(String(event.requestId), list);
  }
  return {
    id, label: String(definition.label), createdAt: definition.occurredAt,
    links: serverFacts(own, "server.room_link").map((event) => ({ generation: Number(event.generation), keyHash: String(event.keyHash) })).sort((a, b) => a.generation - b.generation),
    lessons: serverFacts(own, "server.room_lesson").map((event) => ({ classLessonId: String(event.classLessonId), n: Number(event.n), endsAt: Number(event.endsAt), ended: ended.has(String(event.classLessonId)) })).sort((a, b) => a.n - b.n),
    requests: serverFacts(own, "server.room_request").map((event) => ({
      id: String(event.requestId), name: String(event.name), shown: String(event.shown), ticketHash: String(event.ticketHash),
      at: event.occurredAt, generation: Number(event.generation), decisions: decisions.get(String(event.requestId)) ?? [],
    })).sort((a, b) => a.at - b.at),
  };
}

// The room's lesson now: the latest one opened, not ended and not past its end.
export function currentLesson(room: FixedRoom, now: number) {
  const last = room.lessons.at(-1);
  return last && !last.ended && now < last.endsAt ? last : null;
}

// Where a request stands, from the server's facts only.
export function requestState(room: FixedRoom, request: RoomRequest, now: number): RequestState {
  const decision = latestDecision(request);
  if (decision?.kind === "removed") return "removed";
  if (decision?.kind === "declined") return "declined";
  if (decision?.kind === "admitted") {
    const lesson = room.lessons.find((entry) => entry.classLessonId === decision.classLessonId);
    return lesson && !lesson.ended && now < lesson.endsAt ? "admitted" : "ended";
  }
  if (request.generation !== room.links.at(-1)?.generation) return "replaced";
  return now - request.at < REQUEST_TTL_MS ? "waiting" : "expired";
}

const definitions = async (store: ClassroomStore) => serverFacts(await store.eventsFor([REGISTRY]), "server.room_defined");
export async function readRoom(store: ClassroomStore, roomId: unknown): Promise<FixedRoom | null> {
  if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) return null;
  const definition = (await definitions(store)).find((event) => event.roomId === roomId);
  return definition ? roomFrom(definition, await store.eventsFor([roomId])) : null;
}

const inRoom = (room: FixedRoom, now: number) => room.requests.filter((request) => requestState(room, request, now) === "admitted");
const waiting = (room: FixedRoom, now: number) => room.requests.filter((request) => requestState(room, request, now) === "waiting");

// A person asks to come in: the room's current link and a first name. They wait; the answer holds
// a ticket only their page keeps (the server keeps its hash), which, once they are let in, is their
// personal key to the room's lesson. Nothing in the answer says who else is there.
export async function requestEntry({ store, roomId, key, name, now }: { store: ClassroomStore; roomId: unknown; key: unknown; name: unknown; now: number }) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  const room = await readRoom(store, roomId);
  if (!room || typeof key !== "string" || !key || !room.links.length) return refused(404, "NOT_FOUND", "Not found");
  const keyHash = hashKey(key);
  if (keyHash !== room.links.at(-1)!.keyHash) {
    // An older link of this very room is said as such (ask the teacher for the new one); a key of
    // no link of this room is the same as no room at all.
    return room.links.some((link) => link.keyHash === keyHash) ? refused(410, "LINK_REPLACED", "This link was replaced; ask your teacher for the new one") : refused(404, "NOT_FOUND", "Not found");
  }
  const clean = entryNameOf(name);
  if (!clean) return refused(400, "INVALID_NAME", "Enter your first name in English letters");
  const present = inRoom(room, now), queued = waiting(room, now);
  if (present.length >= FIXED_ROOM_CAPACITY) return refused(409, "ROOM_FULL", "The classroom is full now; please ask your teacher");
  if (queued.length >= WAITING_MAX) return refused(409, "TOO_MANY_WAITING", "Many people are waiting; please try again in a moment");
  const shown = distinctName(clean, [...present, ...queued].map((request) => request.shown));
  if (!shown) return refused(409, "NAME_TAKEN", "Too many people with this name; add an initial");
  const ticket = randomBytes(32).toString("base64url");
  const requestId = shortId("Q");
  await remember(store, [{
    source: "server", type: "server.room_request", lessonId: room.id, roomId: room.id, requestId, name: clean, shown, ticketHash: hashKey(ticket),
    generation: room.links.at(-1)!.generation, occurredAt: now, receivedAt: now, key: `server.room_request:${room.id}:${requestId}`,
  }]);
  return { status: 200, body: { ok: true, requestId, ticket, name: clean } };
}

// Where the person's request stands, for their page only (their ticket). Let in: the lesson to enter
// with the ticket as its personal key.
export async function requestStatus({ store, roomId, requestId, ticket, now }: { store: ClassroomStore; roomId: unknown; requestId: unknown; ticket: unknown; now: number }) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  const room = await readRoom(store, roomId);
  const request = room?.requests.find((entry) => entry.id === String(requestId ?? ""));
  if (!room || !request || typeof ticket !== "string" || hashKey(ticket) !== request.ticketHash) return refused(404, "NOT_FOUND", "Not found");
  const state = requestState(room, request, now);
  return { status: 200, body: { ok: true, state, ...(state === "admitted" ? { lessonId: latestDecision(request)!.classLessonId } : {}) } };
}

async function createRoom({ store, label, actor, now }: { store: ClassroomStore; label: unknown; actor: string; now: number }) {
  const clean = String(label ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!ROOM_LABEL.test(clean)) return refused(400, "INVALID_LABEL", "Use English letters and digits (spaces, . and ' too), at most 40, no - or _");
  if ((await definitions(store)).some((event) => String(event.label).toLowerCase() === clean.toLowerCase())) return refused(409, "LABEL_TAKEN", "A room with this name exists");
  const roomId = `FR-${randomUUID().replace(/-/g, "")}`;
  const key = randomBytes(32).toString("base64url");
  // The name decides the definition's key, so two rooms of the same name never both exist.
  const made = await remember(store, [
    { source: "server", type: "server.room_defined", lessonId: REGISTRY, roomId, label: clean, actor, occurredAt: now, receivedAt: now, key: `server.room_defined:${clean.toLowerCase()}` },
    { source: "server", type: "server.room_link", lessonId: roomId, roomId, generation: 1, keyHash: hashKey(key), actor, occurredAt: now, receivedAt: now, key: `server.room_link:${roomId}:1` },
  ]);
  if (!made) return refused(409, "LABEL_TAKEN", "A room with this name exists");
  return { status: 201, body: { ok: true, room: { id: roomId, label: clean }, link: linkOf(roomId, key) } };
}

async function replaceLink({ store, room, actor, now }: { store: ClassroomStore; room: FixedRoom; actor: string; now: number }) {
  const generation = (room.links.at(-1)?.generation ?? 0) + 1;
  const key = randomBytes(32).toString("base64url");
  const made = await remember(store, [{ source: "server", type: "server.room_link", lessonId: room.id, roomId: room.id, generation, keyHash: hashKey(key), actor, occurredAt: now, receivedAt: now, key: `server.room_link:${room.id}:${generation}` }]);
  if (!made) return refused(409, "CHANGED_CONCURRENTLY", "The link was just replaced by someone else; look again");
  return { status: 200, body: { ok: true, link: linkOf(room.id, key), generation } };
}

// The room's lesson to let a person into: the current one, or a new one, claimed by its number first
// so that two admissions at the same moment open one lesson, never two.
async function lessonToFill({ store, room, actor, now }: { store: ClassroomStore; room: FixedRoom; actor: string; now: number }): Promise<string | null> {
  const current = currentLesson(room, now);
  if (current) return current.classLessonId;
  const n = (room.lessons.at(-1)?.n ?? 0) + 1;
  const classLessonId = shortId("L");
  const endsAt = now + LESSON_LENGTH_MS;
  const claimed = await remember(store, [{ source: "server", type: "server.room_lesson", lessonId: room.id, roomId: room.id, classLessonId, n, endsAt, actor, occurredAt: now, receivedAt: now, key: `server.room_lesson:${room.id}:${n}` }]);
  if (!claimed) return (await readRoom(store, room.id))?.lessons.find((entry) => entry.n === n)?.classLessonId ?? null;
  const slug = room.label.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "Room";
  const lesson: ClassroomLesson = {
    id: classLessonId, code: `ROOM-${slug}-${room.id.slice(3, 11)}-${n}`, date: wallIn(now, LEGACY_LESSON_TIME_ZONE).date,
    startsAt: iso(now), endsAt: iso(endsAt), cancelled: false, createdBy: actor, createdAt: iso(now), participants: [],
  };
  const local = wallIn(now, HOUSE_TIME_ZONE);
  await store.createLesson(lesson, [{
    source: "server", type: "server.lesson_scheduled", key: `server.lesson_scheduled:${classLessonId}`, lessonId: classLessonId, occurredAt: now, receivedAt: now,
    timeZone: HOUSE_TIME_ZONE, localDate: local.date, localTime: local.time, zoneGiven: false, minutes: LESSON_LENGTH_MS / 60_000, fixedRoomId: room.id,
  }]);
  return classLessonId;
}

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function admit({ store, roomId, requestId, actor, now }: { store: ClassroomStore; roomId: string; requestId: string; actor: string; now: number }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const room = await readRoom(store, roomId);
    const request = room?.requests.find((entry) => entry.id === requestId);
    if (!room || !request) return refused(404, "NO_SUCH_REQUEST", "No such person");
    const state = requestState(room, request, now);
    if (state !== "waiting") return refused(409, "NOT_WAITING", `This person is not waiting (${state})`);
    if (inRoom(room, now).length >= FIXED_ROOM_CAPACITY) return refused(409, "ROOM_FULL", `The room is full (${FIXED_ROOM_CAPACITY})`);
    const classLessonId = await lessonToFill({ store, room, actor, now });
    if (!classLessonId) { await pause(100); continue; }
    const ofLesson = room.requests.filter((entry) => entry.decisions.some((decision) => decision.kind === "admitted" && decision.classLessonId === classLessonId));
    const removed = ofLesson.filter((entry) => requestState(room, entry, now) === "removed").length;
    const code = `R${room.id.slice(3, 11)}-${String(ofLesson.length + 1 + attempt).padStart(3, "0")}`;
    const participant: ClassroomParticipant = { id: shortId("P"), code, role: "student", staffEmail: null, joinKeyHash: request.ticketHash };
    // The person's row and the decision in one step: never let in without the record of who did it.
    const result = await store.addLessonParticipant({
      lessonId: classLessonId, participant, max: FIXED_ROOM_CAPACITY + removed,
      events: [{ source: "server", type: "server.room_decision", lessonId: room.id, roomId: room.id, requestId, decision: "admitted", classLessonId, code, actor, occurredAt: now, receivedAt: now, key: `server.room_decision:${room.id}:${requestId}:admitted` }],
    });
    if (result.ok) return { status: 200, body: { ok: true, admitted: requestId, code } };
    if (result.reason === "ROOM_FULL") return refused(409, "ROOM_FULL", `The room is full (${FIXED_ROOM_CAPACITY})`);
    // The lesson opened at the same moment is not there yet, or ended meanwhile; or another admission
    // took this code (or let this person in just now): look again.
    await pause(50);
  }
  return refused(409, "TRY_AGAIN", "Many changes at once; please try again");
}

// Out of the room: their row gets a new id and key nobody has, and the lesson moves to a new Zoom
// session (D-4); the tick ends the old one once everyone else has moved (D-5).
async function takeOut({ store, room, request }: { store: ClassroomStore; room: FixedRoom; request: RoomRequest }, now: number) {
  const admitted = request.decisions.filter((decision) => decision.kind === "admitted").at(-1);
  if (!admitted?.classLessonId || !admitted.code) return null;
  const lesson = await store.lesson(admitted.classLessonId);
  if (!lesson || lesson.cancelled) return null;
  return changeLessonAccess({ store, lessonId: lesson.id, action: "revoke_link", studentCode: admitted.code, now });
}

async function decide({ store, roomId, requestId, kind, actor, now }: { store: ClassroomStore; roomId: string; requestId: string; kind: "declined" | "removed"; actor: string; now: number }) {
  const room = await readRoom(store, roomId);
  const request = room?.requests.find((entry) => entry.id === requestId);
  if (!room || !request) return refused(404, "NO_SUCH_REQUEST", "No such person");
  const state = requestState(room, request, now);
  if (kind === "declined" && state !== "waiting") return refused(409, "NOT_WAITING", `This person is not waiting (${state})`);
  if (kind === "removed" && state !== "admitted") return refused(409, "NOT_IN_ROOM", `This person is not in the room (${state})`);
  if (kind === "removed") {
    const out = await takeOut({ store, room, request }, now);
    if (out && out.status !== 200) return out;
  }
  await remember(store, [{ source: "server", type: "server.room_decision", lessonId: room.id, roomId: room.id, requestId, decision: kind, actor, occurredAt: now, receivedAt: now, key: `server.room_decision:${room.id}:${requestId}:${kind}` }]);
  // Declined while someone else let them in at the same moment: taken out again (the stricter stands).
  if (kind === "declined") {
    const again = await readRoom(store, roomId);
    const now2 = again?.requests.find((entry) => entry.id === requestId);
    if (again && now2 && now2.decisions.some((decision) => decision.kind === "admitted")) await takeOut({ store, room: again, request: now2 }, now);
  }
  return { status: 200, body: { ok: true, [kind]: requestId } };
}

async function endLesson({ store, provider, drive, room, actor, now }: { store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; room: FixedRoom; actor: string; now: number }) {
  const last = room.lessons.at(-1);
  if (!last || last.ended) return refused(409, "NO_LESSON", "No lesson is open in this room");
  const lesson = await store.lesson(last.classLessonId);
  if (lesson && !lesson.cancelled) {
    await changeLessonAccess({ store, lessonId: lesson.id, action: "cancel", now });
    await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now });
  }
  await remember(store, [{ source: "server", type: "server.room_lesson_ended", lessonId: room.id, roomId: room.id, classLessonId: last.classLessonId, actor, occurredAt: now, receivedAt: now, key: `server.room_lesson_ended:${room.id}:${last.classLessonId}` }]);
  return { status: 200, body: { ok: true, ended: last.classLessonId } };
}

export const FIXED_ROOM_ACTIONS = ["create", "replace_link", "admit", "decline", "remove", "end_lesson"] as const;
export type FixedRoomAction = (typeof FIXED_ROOM_ACTIONS)[number];

// What an owner does with the fixed rooms (the iHear teacher, signed in). The route checks the
// owner first; this checks again.
export async function manageFixedRoom({ store, provider, drive, principal, action, input = {}, now }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; principal: { email: string; owner: boolean } | null;
  action: unknown; input?: Record<string, unknown>; now: number;
}) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  if (!principal?.owner || !principal.email) return refused(403, "OWNER_REQUIRED", "Only an owner manages the fixed rooms");
  if (!FIXED_ROOM_ACTIONS.includes(action as FixedRoomAction)) return refused(400, "INVALID_ACTION", `Use one of: ${FIXED_ROOM_ACTIONS.join(", ")}`);
  const actor = principal.email;
  if (action === "create") return createRoom({ store, label: input.label, actor, now });
  const room = await readRoom(store, input.room);
  if (!room) return refused(404, "NO_SUCH_ROOM", "No such room");
  if (action === "replace_link") return replaceLink({ store, room, actor, now });
  if (action === "end_lesson") return endLesson({ store, provider, drive, room, actor, now });
  const requestId = String(input.request ?? "");
  if (action === "admit") return admit({ store, roomId: room.id, requestId, actor, now });
  return decide({ store, roomId: room.id, requestId, kind: action === "decline" ? "declined" : "removed", actor, now });
}

// Presence in a lesson by Zoom's word (webhooks) for the person's rows: in, out, or unknown.
const IN = new Set(["session.user_joined", "host.user_added"]);
const OUT = new Set(["session.user_left", "host.user_removed"]);
function presenceOf(lesson: ClassroomLesson | null, events: readonly ClassroomEvent[], code: string | null): "in" | "out" | null {
  if (!lesson || !code) return null;
  const ids = new Set(lesson.participants.filter((entry) => entry.code === code).map((entry) => entry.id));
  const last = events.filter((event) => event.lessonId === lesson.id && ids.has(String(event.participantId)) && (IN.has(String(event.type)) || OUT.has(String(event.type)))).sort((a, b) => a.occurredAt - b.occurredAt).at(-1);
  return last ? (IN.has(String(last.type)) ? "in" : "out") : null;
}

// What an owner sees: each room, its lesson now, who waits and who was let in (with Zoom's word on
// who is in, where Zoom has said so). Names are for the iHear teacher only; never a key or ticket.
export async function fixedRoomsView({ store, now }: { store: ClassroomStore; now: number }) {
  const defs = await definitions(store);
  const ids = defs.map((event) => String(event.roomId));
  const events = ids.length ? await store.eventsFor(ids) : [];
  const rooms = defs.map((definition) => roomFrom(definition, events));
  const lessonIds = rooms.map((room) => currentLesson(room, now)?.classLessonId).filter((id): id is string => Boolean(id));
  const lessons = new Map<string, ClassroomLesson>();
  for (const id of lessonIds) { const lesson = await store.lesson(id); if (lesson) lessons.set(id, lesson); }
  const lessonEvents = lessonIds.length ? await store.eventsFor(lessonIds) : [];
  return rooms.map((room) => {
    const lesson = currentLesson(room, now);
    const row = lesson ? lessons.get(lesson.classLessonId) ?? null : null;
    return {
      id: room.id, label: room.label, createdAt: iso(room.createdAt), linkGeneration: room.links.at(-1)?.generation ?? 0, capacity: FIXED_ROOM_CAPACITY,
      lesson: lesson ? { lessonId: lesson.classLessonId, endsAt: iso(lesson.endsAt) } : null,
      waiting: waiting(room, now).map((request) => ({ request: request.id, name: request.shown, at: iso(request.at) })),
      inRoom: inRoom(room, now).map((request) => {
        const decision = latestDecision(request)!;
        return { request: request.id, name: request.shown, code: decision.code, at: iso(decision.at), presence: presenceOf(row, lessonEvents, decision.code) };
      }),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}
