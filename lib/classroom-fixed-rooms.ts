// Classroom 3.0 round 3 (2026-11-21): fixed classroom links (每間教室一個固定連結), the direction the
// user gave on 2026-11-21 (planning/2026-11-21-classroom-room-links-requirements.md). Each room has
// one link that keeps working until the iHear teacher replaces it. A person opens it, types a first
// name and waits; the iHear teacher (an owner of the site) lets them in, or not.
//
// Safe defaults while the teacher and iHear decide (the round 3 instructions; D-14, D-16):
//   - a link and a typed name never let anyone in by themselves: every person waits for the iHear
//     teacher's decision. Direct entry is not built: D-16 is not approved.
//   - nobody in a room can let others in or remove them; only owners act, from the admin pages.
//   - the typed name is shown to the iHear teacher (a second "Kyle" as "Kyle B", a second "王小明" as
//     "王小明（2）"); the person's own answer never says who else is there. Since 2026-11-24 Zoom shows
//     the name the server recorded when they were let in (Chinese or English, round 16), not the code.
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
import { distinctName, entryNameOf, rosterNameOf } from "./classroom-names";
import { nameKeyOf } from "./classroom-display-names";
import type { ClassroomProvider } from "./classroom-provider";
import { LESSON_TIME_UP, PARTICIPANT_ALIAS, PARTICIPANT_DISPLAY_NAME, roomRecordingOn } from "./classroom-fixed-room-facts";
import { changeLessonAccess, consentPolicy, forRules, PERSON_CODE, roomMayRecordNow, stopRecordingForCancelledLesson } from "./classroom-service";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { personConsentProblem } from "../tools/recording-pathway/classroom/eligibility.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { deriveLesson } from "../tools/recording-pathway/classroom/lesson-state.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { LABELS } from "../tools/recording-pathway/classroom/live-dashboard.mjs";
import type { ClassroomEvent, ClassroomLesson, ClassroomParticipant, ClassroomStore } from "./classroom-store";
import { fixedRoomRecordingEnabled } from "./classroom-switches";
import { HOUSE_TIME_ZONE, LEGACY_LESSON_TIME_ZONE, wallIn } from "./zoned-time";

// The most a room may hold (requirement 8); a room's own capacity is set between 2 and this.
export const FIXED_ROOM_CAPACITY = 10;
export const ROOM_CAPACITY_MIN = 2;
export const WAITING_MAX = 20;
export const REQUEST_TTL_MS = 30 * 60_000;
// The user, 2026-11-24 (tentative): a lesson lasts at most 120 minutes unless the owner extends it, 30
// minutes at a time, to at most 180 in all. A room's own length may be set between 30 and 180; it
// applies from the room's next lesson. At its end the server ends the lesson (endLessonsPastTime).
export const LESSON_MINUTES = 120;
export const LESSON_MINUTES_MIN = 30;
export const LESSON_MAX_MINUTES = 180;
export const EXTEND_MINUTES = 30;
// One-to-one or a group (the user, 2026-11-24: both, a setting per room); each starts with its own
// capacity, which the owner may change.
export const ROOM_FORMS = ["one_to_one", "group"] as const;
export type RoomForm = (typeof ROOM_FORMS)[number];
const FORM_CAPACITY: Record<RoomForm, number> = { one_to_one: 2, group: FIXED_ROOM_CAPACITY };
// Round 18 (2026-11-26): how people come in. "direct": the door lets them in at once; "approval": an
// owner lets them in (D-16, as before; the default for rooms with no setting and for the API).
export const ROOM_ENTRIES = ["direct", "approval"] as const;
export type RoomEntry = (typeof ROOM_ENTRIES)[number];
type RoomSettings = { form: RoomForm; capacity: number; minutes: number; entry: RoomEntry };
const DEFAULT_SETTINGS: RoomSettings = { form: "group", capacity: FIXED_ROOM_CAPACITY, minutes: LESSON_MINUTES, entry: "approval" };
const DOOR_ACTOR = "door";
export const ROOM_ID = /^FR-[0-9a-f]{32}$/;
const REGISTRY = "FR-REGISTRY";
// A room's name goes into its recordings' file names: letters and digits first, then letters,
// digits, spaces, . and ' (no - or _, which separate a file name's parts), at most 40.
const ROOM_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .']{0,39}$/;
const RECORDING_LABELS: Record<string, string> = LABELS.recording;

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
// Gate B (round 10, 2026-11-22): a student's own pass for the room, also behind # (p=).
const passLinkOf = (roomId: string, pass: string) => `/classroom/r/${roomId}#p=${pass}`;
// Gate B: a student's code on a room's list is the code their recording consent is kept under (the
// same rule as every person's code), never one of the codes admissions make up (R<room>-<hex>).
const ADMISSION_CODE = /^R[0-9a-f]{8}-[0-9a-f]{6}$/i;
const rosterCode = (value: unknown) => { const code = String(value ?? "").trim(); return PERSON_CODE.test(code) && !ADMISSION_CODE.test(code) ? code : null; };
export const ROSTER_MAX = 100;

type DecisionKind = "admitted" | "declined" | "removed";
// personCode/boundBy (Gate B): the student on the room's list this admission is (by their pass, or
// by the owner's word); null for an admission of a code of its own.
type Decision = { kind: DecisionKind; at: number; actor: string; classLessonId: string | null; code: string | null; personCode: string | null; boundBy: string | null };
// personCode/passHash: a request made with a student's own pass (Gate B); null for the room's link.
type RoomRequest = { id: string; name: string; shown: string; ticketHash: string; at: number; generation: number; decisions: Decision[]; personCode: string | null; passHash: string | null };
// startedAt: when the lesson opened; endsAt: its planned end, moved by each extension (2026-11-24).
type RoomLesson = { classLessonId: string; n: number; startedAt: number; endsAt: number; ended: boolean };
// A student on the room's list (Gate B): their code, the first name the list gives, their pass's hash.
type RoomMember = { code: string; name: string; passHash: string; at: number };
// rosterSeq: how many changes the room's list has had (each change takes the next number, so of two
// changes at the same moment one is made and the other is said as such).
export type FixedRoom = { id: string; label: string; createdAt: number; recording: boolean; disabled: boolean; lastDisabledAt: number | null; links: { generation: number; keyHash: string }[]; lessons: RoomLesson[]; requests: RoomRequest[]; members: RoomMember[]; rosterSeq: number; settingsSeq: number } & RoomSettings;
// "closed": the person was waiting when the room was taken out of use (2026-11-21, round 7).
export type RequestState = "waiting" | "admitted" | "declined" | "removed" | "expired" | "replaced" | "ended" | "closed";

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
    list.push({
      kind: event.decision as DecisionKind, at: event.occurredAt, actor: String(event.actor ?? ""), classLessonId: event.classLessonId == null ? null : String(event.classLessonId), code: event.code == null ? null : String(event.code),
      personCode: typeof event.personCode === "string" ? event.personCode : null, boundBy: typeof event.boundBy === "string" ? event.boundBy : null,
    });
    decisions.set(String(event.requestId), list);
  }
  // In use or not (round 7): the latest of the server's own facts; at the same moment, not in use stands.
  const uses = [
    ...serverFacts(own, "server.room_enabled").map((event) => ({ inUse: true, at: event.occurredAt })),
    ...serverFacts(own, "server.room_disabled").map((event) => ({ inUse: false, at: event.occurredAt })),
  ].sort((a, b) => a.at - b.at || Number(b.inUse) - Number(a.inUse));
  // Extensions (2026-11-24): the latest planned end written for each lesson.
  const extended = new Map<string, number>();
  for (const event of serverFacts(own, "server.room_lesson_extended")) {
    const id = String(event.classLessonId), endsAt = Number(event.endsAt);
    if (Number.isFinite(endsAt)) extended.set(id, Math.max(extended.get(id) ?? 0, endsAt));
  }
  return {
    id, label: String(definition.label), createdAt: definition.occurredAt, recording: roomRecordingOn(own), disabled: uses.length > 0 && !uses.at(-1)!.inUse,
    lastDisabledAt: uses.filter((use) => !use.inUse).at(-1)?.at ?? null,
    links: serverFacts(own, "server.room_link").map((event) => ({ generation: Number(event.generation), keyHash: String(event.keyHash) })).sort((a, b) => a.generation - b.generation),
    lessons: serverFacts(own, "server.room_lesson").map((event) => ({
      classLessonId: String(event.classLessonId), n: Number(event.n), startedAt: event.occurredAt,
      endsAt: Math.max(Number(event.endsAt), extended.get(String(event.classLessonId)) ?? 0), ended: ended.has(String(event.classLessonId)),
    })).sort((a, b) => a.n - b.n),
    ...settingsOf(own),
    settingsSeq: serverFacts(own, "server.room_settings").reduce((most, event) => Math.max(most, Number(event.seq) || 0), 0),
    requests: serverFacts(own, "server.room_request").map((event) => ({
      id: String(event.requestId), name: String(event.name), shown: String(event.shown), ticketHash: String(event.ticketHash),
      at: event.occurredAt, generation: Number(event.generation), decisions: decisions.get(String(event.requestId)) ?? [],
      personCode: typeof event.personCode === "string" ? event.personCode : null, passHash: typeof event.passHash === "string" ? event.passHash : null,
    })).sort((a, b) => a.at - b.at),
    members: membersOf(own),
    rosterSeq: rosterFacts(own).reduce((most, event) => Math.max(most, Number(event.seq) || 0), 0),
  };
}

// A room's settings (2026-11-24): the latest the owner set, each value checked again as it is read;
// none set (or a value out of range): the defaults (a group of up to 10, 120 minutes).
function settingsOf(own: readonly ClassroomEvent[]): RoomSettings {
  // The latest by its number: each change takes the next one, so of two at the same moment one is made.
  const last = serverFacts(own, "server.room_settings").sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || a.occurredAt - b.occurredAt).at(-1);
  if (!last) return { ...DEFAULT_SETTINGS };
  const form = ROOM_FORMS.includes(last.form as RoomForm) ? (last.form as RoomForm) : DEFAULT_SETTINGS.form;
  const capacity = Number(last.capacity), minutes = Number(last.minutes);
  return {
    form,
    capacity: Number.isInteger(capacity) && capacity >= ROOM_CAPACITY_MIN && capacity <= FIXED_ROOM_CAPACITY ? capacity : FORM_CAPACITY[form],
    minutes: Number.isInteger(minutes) && minutes >= LESSON_MINUTES_MIN && minutes <= LESSON_MAX_MINUTES ? minutes : LESSON_MINUTES,
    entry: ROOM_ENTRIES.includes(last.entry as RoomEntry) ? (last.entry as RoomEntry) : DEFAULT_SETTINGS.entry,
  };
}

// Gate B (round 10): the room's list of students, from the server's own facts: the latest fact per
// code stands (a pass reissued replaces the old one; a removal takes the student off the list).
const rosterFacts = (own: readonly ClassroomEvent[]) => [...serverFacts(own, "server.room_member"), ...serverFacts(own, "server.room_member_removed")]
  .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || a.occurredAt - b.occurredAt);
function membersOf(own: readonly ClassroomEvent[]): RoomMember[] {
  const latest = new Map<string, ClassroomEvent>();
  for (const event of rosterFacts(own)) latest.set(String(event.personCode), event);
  return [...latest.values()].filter((event) => event.type === "server.room_member")
    .map((event) => ({ code: String(event.personCode), name: String(event.name), passHash: String(event.passHash), at: event.occurredAt }))
    .sort((a, b) => a.code.localeCompare(b.code));
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
  // Waiting when the room was taken out of use: closed, and still closed once it is back in use (their
  // page has said so and stopped waiting; letting them in later would let in nobody).
  if (room.disabled || (room.lastDisabledAt != null && request.at <= room.lastDisabledAt)) return "closed";
  // A request made with a student's own pass (Gate B) stands as long as that pass does; one made with
  // the room's link, as long as that link does.
  if (request.personCode) {
    const member = room.members.find((entry) => entry.code === request.personCode);
    if (!member || member.passHash !== request.passHash) return "replaced";
  } else if (request.generation !== room.links.at(-1)?.generation) return "replaced";
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

// Round 18l (the user, 2026-11-28: the entry page as the concept image, "Classroom A" and the notice that
// the lesson is recorded): what the door shows before a name is typed. Only to someone holding the
// room's current link, with the door's own answers otherwise (an older link: replaced; anything else:
// not found). `recorded`: the room's lessons are recorded (the site may record fixed rooms, and the room
// is set to), so the page says so before anyone comes in.
export async function roomDoorInfo({ store, roomId, key }: { store: ClassroomStore; roomId: unknown; key: unknown }) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  const room = await readRoom(store, roomId);
  if (!room || typeof key !== "string" || !key || !room.links.length) return refused(404, "NOT_FOUND", "Not found");
  const keyHash = hashKey(key);
  if (keyHash !== room.links.at(-1)!.keyHash) {
    return room.links.some((link) => link.keyHash === keyHash) ? refused(410, "LINK_REPLACED", "This link was replaced; ask your teacher for the new one") : refused(404, "NOT_FOUND", "Not found");
  }
  return { status: 200, body: { ok: true, label: room.label, recorded: fixedRoomRecordingEnabled() && room.recording, disabled: room.disabled } };
}

// A person asks to come in: the room's current link and a first name. They wait; the answer holds
// a ticket only their page keeps (the server keeps its hash), which, once they are let in, is their
// personal key to the room's lesson. Nothing in the answer says who else is there.
export async function requestEntry({ store, roomId, key, name, pass, now }: { store: ClassroomStore; roomId: unknown; key: unknown; name: unknown; pass?: unknown; now: number }) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  // A pass counts only while the site may record fixed rooms; otherwise it is ignored and the request
  // is what it was before Gate B (round 10 review: the same answers with the switch off).
  if (typeof pass === "string" && pass && fixedRoomRecordingEnabled()) return requestWithPass({ store, roomId, pass, now });
  const room = await readRoom(store, roomId);
  if (!room || typeof key !== "string" || !key || !room.links.length) return refused(404, "NOT_FOUND", "Not found");
  const keyHash = hashKey(key);
  if (keyHash !== room.links.at(-1)!.keyHash) {
    // An older link of this very room is said as such (ask the teacher for the new one); a key of
    // no link of this room is the same as no room at all.
    return room.links.some((link) => link.keyHash === keyHash) ? refused(410, "LINK_REPLACED", "This link was replaced; ask your teacher for the new one") : refused(404, "NOT_FOUND", "Not found");
  }
  // Only someone holding the room's current link learns that it is out of use; anyone else still
  // gets "not found" above.
  if (room.disabled) return refused(409, "ROOM_DISABLED", "This classroom is not in use now; please check with your teacher");
  const clean = entryNameOf(name);
  if (!clean) return refused(400, "INVALID_NAME", "Enter your name in English letters");
  const present = inRoom(room, now), queued = waiting(room, now);
  if (present.length >= room.capacity) return refused(409, "ROOM_FULL", "The classroom is full now; please ask your teacher");
  if (queued.length >= WAITING_MAX) return refused(409, "TOO_MANY_WAITING", "Many people are waiting; please try again in a moment");
  const ticket = randomBytes(32).toString("base64url");
  const requestId = shortId("Q");
  // Round 18 (f1's question): the shown name is claimed for this lesson of the room, so two people
  // typing the same name at the same moment are told apart; the request is written only with its claim.
  const lessonNo = currentLesson(room, now)?.n ?? ((room.lessons.at(-1)?.n ?? 0) + 1);
  const taken = [...present, ...queued].map((request) => request.shown);
  let shown: string | null = null;
  for (let attempt = 0; attempt < 27; attempt += 1) {
    const candidate = distinctName(clean, taken);
    if (!candidate) break;
    const kept = await store.transaction(async (tx) => {
      if (!(await tx.insertEvent({ source: "server", type: "server.room_name_claim", lessonId: room.id, roomId: room.id, requestId, lessonNo, occurredAt: now, receivedAt: now, key: `server.room_name_claim:${room.id}:${lessonNo}:${nameKeyOf(candidate)}` }))) return false;
      return tx.insertEvent({
        source: "server", type: "server.room_request", lessonId: room.id, roomId: room.id, requestId, name: clean, shown: candidate, ticketHash: hashKey(ticket),
        generation: room.links.at(-1)!.generation, occurredAt: now, receivedAt: now, key: `server.room_request:${room.id}:${requestId}`,
      });
    });
    if (kept) { shown = candidate; break; }
    taken.push(candidate);
  }
  if (!shown) return refused(409, "NAME_TAKEN", "Too many people with this name; add an initial");
  // Round 18: a direct room lets the person in now, through the owner's own admit (capacity, the
  // lesson, the name Zoom shows). If that does not go through (full meanwhile, many changes at once),
  // the request stays waiting as before, and the page keeps asking.
  if (room.entry === "direct") {
    const admitted = await admit({ store, roomId: room.id, requestId, actor: DOOR_ACTOR, now });
    if (admitted.status === 200) return { status: 200, body: { ok: true, requestId, ticket, name: clean, admitted: true } };
  }
  return { status: 200, body: { ok: true, requestId, ticket, name: clean } };
}

// Gate B (round 10, 2026-11-22): a student asks with their own pass (option A of the Gate B
// decision, not chosen yet). The pass says who they are: their name is the list's, never typed, and
// once let in their code in the lesson is the student's code their consent is kept under. Only while
// the site may record fixed rooms at all; otherwise, and for a pass that is not on the room's list,
// it is the same as no room (nothing tells a guesser that a room or a student exists).
async function requestWithPass({ store, roomId, pass, now }: { store: ClassroomStore; roomId: unknown; pass: string; now: number }) {
  if (!fixedRoomRecordingEnabled()) return refused(404, "NOT_FOUND", "Not found");
  const room = await readRoom(store, roomId);
  const passHash = hashKey(pass.slice(0, 200));
  const member = room?.members.find((entry) => entry.passHash === passHash);
  if (!room || !member) return refused(404, "NOT_FOUND", "Not found");
  if (room.disabled) return refused(409, "ROOM_DISABLED", "This classroom is not in use now; please check with your teacher");
  const present = inRoom(room, now), queued = waiting(room, now);
  if (present.length >= room.capacity) return refused(409, "ROOM_FULL", "The classroom is full now; please ask your teacher");
  if (queued.length >= WAITING_MAX) return refused(409, "TOO_MANY_WAITING", "Many people are waiting; please try again in a moment");
  const shown = distinctName(member.name, [...present, ...queued].map((request) => request.shown));
  if (!shown) return refused(409, "NAME_TAKEN", "Too many people with this name; please ask your teacher");
  const ticket = randomBytes(32).toString("base64url");
  const requestId = shortId("Q");
  await remember(store, [{
    source: "server", type: "server.room_request", lessonId: room.id, roomId: room.id, requestId, name: member.name, shown, ticketHash: hashKey(ticket),
    generation: room.links.at(-1)?.generation ?? 0, personCode: member.code, passHash, occurredAt: now, receivedAt: now, key: `server.room_request:${room.id}:${requestId}`,
  }]);
  return { status: 200, body: { ok: true, requestId, ticket, name: member.name } };
}

// Where the person's request stands, for their page only (their ticket). Let in: the lesson to enter
// with the ticket as its personal key.
export async function requestStatus({ store, roomId, requestId, ticket, now }: { store: ClassroomStore; roomId: unknown; requestId: unknown; ticket: unknown; now: number }) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  const room = await readRoom(store, roomId);
  const request = room?.requests.find((entry) => entry.id === String(requestId ?? ""));
  if (!room || !request || typeof ticket !== "string" || hashKey(ticket) !== request.ticketHash) return refused(404, "NOT_FOUND", "Not found");
  const state = requestState(room, request, now);
  // Round 18: in a direct room nobody may be there to let a waiting person in; their page asks every
  // few seconds, and each time the door tries again (an admit that lost a race at the door, a room that
  // was switched to direct while they waited).
  if (state === "waiting" && room.entry === "direct") {
    const admitted = await admit({ store, roomId: room.id, requestId: request.id, actor: DOOR_ACTOR, now });
    if (admitted.status === 200) {
      const again = await readRoom(store, room.id);
      const now2 = again?.requests.find((entry) => entry.id === request.id);
      if (again && now2 && requestState(again, now2, now) === "admitted") return { status: 200, body: { ok: true, state: "admitted", lessonId: latestDecision(now2)!.classLessonId } };
    }
  }
  return { status: 200, body: { ok: true, state, ...(state === "admitted" ? { lessonId: latestDecision(request)!.classLessonId } : {}) } };
}

async function createRoom({ store, label, entry, actor, now }: { store: ClassroomStore; label: unknown; entry?: unknown; actor: string; now: number }) {
  if (entry !== undefined && !ROOM_ENTRIES.includes(entry as RoomEntry)) return refused(400, "INVALID_ENTRY", `Use one of: ${ROOM_ENTRIES.join(", ")}`);
  const clean = String(label ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!ROOM_LABEL.test(clean)) return refused(400, "INVALID_LABEL", "Use English letters and digits (spaces, . and ' too), at most 40, no - or _");
  if ((await definitions(store)).some((event) => String(event.label).toLowerCase() === clean.toLowerCase())) return refused(409, "LABEL_TAKEN", "A room with this name exists");
  const roomId = `FR-${randomUUID().replace(/-/g, "")}`;
  const key = randomBytes(32).toString("base64url");
  // The name decides the definition's key, so two rooms of the same name never both exist. The link
  // is written only when the definition was new (round 9: a request that lost the race for the name
  // left a link of a room that never existed).
  const made = await store.transaction(async (tx) => {
    if (!(await tx.insertEvent({ source: "server", type: "server.room_defined", lessonId: REGISTRY, roomId, label: clean, actor, occurredAt: now, receivedAt: now, key: `server.room_defined:${clean.toLowerCase()}` }))) return false;
    // Round 18: a room made "direct" starts with that setting (the other settings are the defaults).
    if (entry === "direct" && !(await tx.insertEvent({ source: "server", type: "server.room_settings", lessonId: roomId, roomId, ...DEFAULT_SETTINGS, entry: "direct", seq: 1, actor, occurredAt: now, receivedAt: now, key: `server.room_settings:${roomId}:1` }))) return false;
    return tx.insertEvent({ source: "server", type: "server.room_link", lessonId: roomId, roomId, generation: 1, keyHash: hashKey(key), actor, occurredAt: now, receivedAt: now, key: `server.room_link:${roomId}:1` });
  });
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
  const endsAt = now + room.minutes * 60_000;
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
    timeZone: HOUSE_TIME_ZONE, localDate: local.date, localTime: local.time, zoneGiven: false, minutes: room.minutes, fixedRoomId: room.id,
  }, { source: "server", type: "server.room_recording", lessonId: classLessonId, roomId: room.id, on: room.recording, copied: true, actor, occurredAt: now, receivedAt: now, key: `server.room_recording:${classLessonId}:opened` }]);
  return classLessonId;
}

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function admit({ store, roomId, requestId, bindTo, actor, now }: { store: ClassroomStore; roomId: string; requestId: string; bindTo?: unknown; actor: string; now: number }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const room = await readRoom(store, roomId);
    const request = room?.requests.find((entry) => entry.id === requestId);
    if (!room || !request) return refused(404, "NO_SUCH_REQUEST", "No such person");
    if (room.disabled) return refused(409, "ROOM_DISABLED", "This room is not in use: nobody is let in");
    const state = requestState(room, request, now);
    if (state !== "waiting") return refused(409, "NOT_WAITING", `This person is not waiting (${state})`);
    if (inRoom(room, now).length >= room.capacity) return refused(409, "ROOM_FULL", `The room is full (${room.capacity})`);
    // Gate B (round 10): who this person is. A request made with a student's own pass is that student
    // (option A); an owner may say which student on the room's list a request made with the room's
    // link is (option B: bindTo). Bound, their code in the lesson is the student's code, which their
    // recording consent is kept under; otherwise a code of its own, as before. Neither option is
    // chosen yet (the Gate B decision), and both need the site's recording switch.
    const bound = boundMember(room, request, bindTo);
    if ("refusal" in bound) return bound.refusal;
    const member = bound.member;
    if (member && room.requests.some((entry) => entry.id !== request.id && requestState(room, entry, now) === "admitted" && latestDecision(entry)?.code === member.code)) {
      return refused(409, "ALREADY_IN_LESSON", "This student is already in the room");
    }
    // Round 10 review: one student, one room at a time (their consent is one; their files are named once).
    if (member && (await admissionsElsewhere(store, room.id, member.code, now)).length) {
      return refused(409, "ALREADY_IN_ANOTHER_ROOM", "This student is in another room's lesson now");
    }
    const classLessonId = await lessonToFill({ store, room, actor, now });
    if (!classLessonId) { await pause(100); continue; }
    const ofLesson = room.requests.filter((entry) => entry.decisions.some((decision) => decision.kind === "admitted" && decision.classLessonId === classLessonId));
    const removed = ofLesson.filter((entry) => requestState(room, entry, now) === "removed").length;
    // A code of its own (random, so people let in at the same moment never take each other's).
    const code = member ? member.code : `R${room.id.slice(3, 11)}-${randomBytes(3).toString("hex")}`;
    const participant: ClassroomParticipant = { id: shortId("P"), code, role: "student", staffEmail: null, joinKeyHash: request.ticketHash };
    // Round 10 review: in Zoom everyone shows by code, and a student's code is their consent's: a
    // student let in as themselves shows by a name of this lesson only (the same shape as anyone's),
    // so the others in the room never see the student's code.
    const alias = member ? `R${room.id.slice(3, 11)}-${randomBytes(3).toString("hex")}` : null;
    // The person's row and the decision in one step: never let in without the record of who did it.
    const result = await store.addLessonParticipant({
      lessonId: classLessonId, participant, max: room.capacity + removed,
      events: [{
        source: "server", type: "server.room_decision", lessonId: room.id, roomId: room.id, requestId, decision: "admitted", classLessonId, code, actor,
        ...(member ? { personCode: member.code, boundName: member.name, boundBy: request.personCode ? "pass" : "owner" } : {}),
        occurredAt: now, receivedAt: now, key: `server.room_decision:${room.id}:${requestId}:admitted`,
      }, ...(member && alias ? [{
        source: "server", type: PARTICIPANT_ALIAS, lessonId: classLessonId, participantCode: member.code, alias,
        occurredAt: now, receivedAt: now, key: `${PARTICIPANT_ALIAS}:${classLessonId}:${member.code}:${requestId}`,
      }] : []), {
        // The name Zoom shows for this person (the user, 2026-11-24): the one the iHear teacher saw
        // when letting them in (their typed first name, or the list's for a student let in as
        // themselves), already checked and made distinct in this room.
        source: "server", type: PARTICIPANT_DISPLAY_NAME, lessonId: classLessonId, participantCode: code, name: request.shown,
        occurredAt: now, receivedAt: now, key: `${PARTICIPANT_DISPLAY_NAME}:${classLessonId}:${code}:${requestId}`,
      }],
    });
    if (result.ok) {
      if (member) {
        const undone = await settleBinding({ store, roomId: room.id, requestId, request, member, now });
        if (undone) return undone;
      }
      return { status: 200, body: { ok: true, admitted: requestId, code, ...(member ? { student: member.code } : {}) } };
    }
    if (result.reason === "ROOM_FULL") return refused(409, "ROOM_FULL", `The room is full (${room.capacity})`);
    // A student's own code taken: let in just now by another press (the next look says so), or they
    // already have a place in this lesson (also when taken out earlier: the next lesson can let them in).
    if (member && result.reason === "CODE_TAKEN") {
      const again = await readRoom(store, roomId);
      const now2 = again?.requests.find((entry) => entry.id === requestId);
      if (again && now2 && requestState(again, now2, now) !== "waiting") return refused(409, "NOT_WAITING", `This person is not waiting (${requestState(again, now2, now)})`);
      return refused(409, "ALREADY_IN_LESSON", "This student already has a place in this lesson");
    }
    // The lesson opened at the same moment is not there yet, or ended meanwhile; or another admission
    // took this code (or let this person in just now): look again.
    await pause(50);
  }
  return refused(409, "TRY_AGAIN", "Many changes at once; please try again");
}

// Gate B (round 10): the student on the room's list a request is bound to, if any.
function boundMember(room: FixedRoom, request: RoomRequest, bindTo: unknown): { member: RoomMember | null } | { refusal: ReturnType<typeof refused> } {
  const asked = typeof bindTo === "string" && bindTo ? bindTo : null;
  if (!request.personCode && !asked) return { member: null };
  // With the site's switch off nothing records: the owner's word and a pass are both ignored and the
  // person is let in as anyone is, as before Gate B (round 10 review).
  if (!fixedRoomRecordingEnabled()) return { member: null };
  if (request.personCode && asked && asked !== request.personCode) return { refusal: refused(409, "ALREADY_BOUND", "This request was made with another student's own pass") };
  const code = request.personCode ?? asked!;
  const member = room.members.find((entry) => entry.code === code) ?? null;
  if (!member) return { refusal: refused(request.personCode ? 409 : 404, request.personCode ? "NOT_ON_ROSTER" : "NO_SUCH_MEMBER", "This student is not on the room's list") };
  return { member };
}

// Round 10 review: the people let in as this student in other rooms' lessons now (at most one should be).
async function admissionsElsewhere(store: ClassroomStore, roomId: string, code: string, now: number) {
  return (await allRooms(store)).filter((other) => other.id !== roomId).flatMap((other) => other.requests
    .filter((entry) => requestState(other, entry, now) === "admitted" && latestDecision(entry)?.code === code)
    .map((entry) => ({ roomId: other.id, requestId: entry.id, at: latestDecision(entry)!.at })));
}

// Round 10 review: a student let in as themselves is let in on what the list said when the owner
// pressed. Meanwhile their pass may have been reissued or they taken off the list, or another room may
// have let the same student in at the same moment: then this admission is undone (as a decline that
// raced an admission is) and said. Of two rooms, the earlier admission stays (the same moment: the
// smaller request id), so exactly one does whatever the timing.
async function settleBinding({ store, roomId, requestId, request, member, now }: { store: ClassroomStore; roomId: string; requestId: string; request: RoomRequest; member: RoomMember; now: number }) {
  const again = await readRoom(store, roomId);
  const mine = again?.requests.find((entry) => entry.id === requestId);
  const decision = mine ? latestDecision(mine) : null;
  if (!again || !mine || decision?.kind !== "admitted") return null;
  const listed = again.members.find((entry) => entry.code === member.code);
  let reason: "BINDING_CHANGED" | "ALREADY_IN_ANOTHER_ROOM" | null = null;
  if (!listed || (request.personCode && listed.passHash !== request.passHash)) reason = "BINDING_CHANGED";
  else {
    const others = await admissionsElsewhere(store, roomId, member.code, now);
    if (others.some((other) => other.at < decision.at || (other.at === decision.at && other.requestId < requestId))) reason = "ALREADY_IN_ANOTHER_ROOM";
  }
  if (!reason) return null;
  const out = await takeOut({ store, room: again, request: mine }, now);
  if (out && out.status !== 200) return refused(409, `${reason}_NOT_UNDONE`, "Let in on a list that changed meanwhile, and could not be taken out again: take this person out of the room");
  await remember(store, [{ source: "server", type: "server.room_decision", lessonId: again.id, roomId: again.id, requestId, decision: "removed", actor: "server:binding-check", reason, occurredAt: now, receivedAt: now, key: `server.room_decision:${again.id}:${requestId}:removed` }]);
  return refused(409, reason, reason === "BINDING_CHANGED"
    ? "The student's pass was replaced, or they left the room's list, while they were let in: not let in"
    : "The same student was let in to another room at the same moment: not let in here");
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

// The room's own recording switch (item 36: each room its own, set by the iHear teacher). On only
// where the site allows fixed rooms to record at all; written to the room and to its lesson now, so
// the lesson's next decision follows it (off: a recording there is stopped at the next tick).
async function setRecording({ store, room, on, actor, now }: { store: ClassroomStore; room: FixedRoom; on: unknown; actor: string; now: number }) {
  if (on !== true && on !== false) return refused(400, "INVALID_SWITCH", "Say on: true or false");
  if (on && !fixedRoomRecordingEnabled()) return refused(409, "RECORDING_NOT_AVAILABLE", "Recording in fixed rooms is not turned on for this site");
  const stamp = `${now}:${randomUUID()}`;
  const lesson = currentLesson(room, now);
  // Off while the room's lesson may be recording is refused, as for a block (18.6): ending the lesson
  // stops it (and ends its session); then the switch can be turned off.
  const row = lesson ? await store.lesson(lesson.classLessonId) : null;
  if (!on && row && await roomMayRecordNow(store, row, now)) return refused(409, "RECORDING_MAY_BE_ON", "The room may be recording now: end this lesson to stop it first");
  await remember(store, [
    { source: "server", type: "server.room_recording", lessonId: room.id, roomId: room.id, on, actor, occurredAt: now, receivedAt: now, key: `server.room_recording:${room.id}:${stamp}` },
    ...(lesson ? [
      { source: "server", type: "server.room_recording", lessonId: lesson.classLessonId, roomId: room.id, on, actor, occurredAt: now, receivedAt: now, key: `server.room_recording:${lesson.classLessonId}:${stamp}` },
      // The lesson decides again whether it may record (its earlier decision was made on the old switch).
      { source: "server", type: "server.consent_changed", lessonId: lesson.classLessonId, reason: "room_recording_switch", occurredAt: now, receivedAt: now, key: `server.consent_changed:${lesson.classLessonId}:${stamp}` },
    ] : []),
  ]);
  return { status: 200, body: { ok: true, recording: on } };
}

// timeUp (2026-11-24): the server ends the lesson because its time is over. It says so on the lesson
// first, so each person's page tells them the time is up, not that the lesson was cancelled.
async function endLesson({ store, provider, drive, room, actor, now, timeUp = false }: { store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; room: FixedRoom; actor: string; now: number; timeUp?: boolean }) {
  const last = room.lessons.at(-1);
  if (!last || last.ended) return refused(409, "NO_LESSON", "No lesson is open in this room");
  const lesson = await store.lesson(last.classLessonId);
  if (lesson && !lesson.cancelled) {
    if (timeUp) await remember(store, [{ source: "server", type: LESSON_TIME_UP, lessonId: lesson.id, roomId: room.id, endsAt: last.endsAt, occurredAt: now, receivedAt: now, key: `${LESSON_TIME_UP}:${lesson.id}` }]);
    await changeLessonAccess({ store, lessonId: lesson.id, action: "cancel", now });
    await stopRecordingForCancelledLesson({ store, provider, drive, lessonId: lesson.id, now });
  }
  await remember(store, [{ source: "server", type: "server.room_lesson_ended", lessonId: room.id, roomId: room.id, classLessonId: last.classLessonId, actor, ...(timeUp ? { reason: "time_up" } : {}), occurredAt: now, receivedAt: now, key: `server.room_lesson_ended:${room.id}:${last.classLessonId}` }]);
  return { status: 200, body: { ok: true, ended: last.classLessonId, ...(timeUp ? { reason: "time_up" } : {}) } };
}

// The lessons whose time is over (the user, 2026-11-24): the server ends each one as the owner's "end
// this lesson" does (everyone leaves, a recording stops, the Zoom session ends), and says why. Run by
// the classroom's regular tick; nothing while the fixed rooms are off.
export async function endLessonsPastTime({ store, provider, drive, now }: { store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; now: number }) {
  if (!fixedRoomsEnabled()) return { ended: [] as string[] };
  const ended: string[] = [];
  for (const room of await allRooms(store)) {
    const last = room.lessons.at(-1);
    if (!last || last.ended || now < last.endsAt) continue;
    const answer = await endLesson({ store, provider, drive, room, actor: "server:time-limit", now, timeUp: true });
    if (answer.status === 200) ended.push(last.classLessonId);
  }
  return { ended };
}

// The lesson now, longer (the user, 2026-11-24): 30 more minutes each time, to at most 180 minutes from
// its start, only while it runs. The lesson's own record moves too, so the join window and every rule
// that reads the lesson's end see the new one. Two presses at the same moment extend once.
async function extendLesson({ store, room, actor, now }: { store: ClassroomStore; room: FixedRoom; actor: string; now: number }) {
  const lesson = currentLesson(room, now);
  if (!lesson) return refused(409, "NO_LESSON", "No lesson is open in this room");
  const endsAt = lesson.endsAt + EXTEND_MINUTES * 60_000;
  if (endsAt > lesson.startedAt + LESSON_MAX_MINUTES * 60_000) return refused(409, "EXTEND_LIMIT", `A lesson lasts at most ${LESSON_MAX_MINUTES} minutes`);
  const made = await remember(store, [{ source: "server", type: "server.room_lesson_extended", lessonId: room.id, roomId: room.id, classLessonId: lesson.classLessonId, endsAt, actor, occurredAt: now, receivedAt: now, key: `server.room_lesson_extended:${room.id}:${lesson.classLessonId}:${endsAt}` }]);
  if (!made) return refused(409, "CHANGED_CONCURRENTLY", "This lesson was just extended; look again");
  await store.setLessonEndsAt(lesson.classLessonId, iso(endsAt));
  return { status: 200, body: { ok: true, lessonId: lesson.classLessonId, endsAt: iso(endsAt) } };
}

// A room's settings (the user, 2026-11-24): its form (one-to-one or a group), how many it holds (2 to
// 10) and how long its lessons last (30 to 180 minutes). Each value left out stays as it is; a form
// changed without a capacity takes that form's own (one-to-one 2, a group 10). The capacity counts for
// the next person let in (people already in stay); the length, from the room's next lesson.
async function setSettings({ store, room, input, actor, now }: { store: ClassroomStore; room: FixedRoom; input: Record<string, unknown>; actor: string; now: number }) {
  const form = input.form === undefined ? room.form : input.form;
  if (!ROOM_FORMS.includes(form as RoomForm)) return refused(400, "INVALID_FORM", `Use one of: ${ROOM_FORMS.join(", ")}`);
  const capacity = input.capacity !== undefined ? input.capacity : form !== room.form ? FORM_CAPACITY[form as RoomForm] : room.capacity;
  if (!Number.isInteger(capacity) || (capacity as number) < ROOM_CAPACITY_MIN || (capacity as number) > FIXED_ROOM_CAPACITY) {
    return refused(400, "INVALID_CAPACITY", `A room holds ${ROOM_CAPACITY_MIN} to ${FIXED_ROOM_CAPACITY} people`);
  }
  const minutes = input.minutes === undefined ? room.minutes : input.minutes;
  if (!Number.isInteger(minutes) || (minutes as number) < LESSON_MINUTES_MIN || (minutes as number) > LESSON_MAX_MINUTES) {
    return refused(400, "INVALID_MINUTES", `A lesson lasts ${LESSON_MINUTES_MIN} to ${LESSON_MAX_MINUTES} minutes`);
  }
  const entry = input.entry === undefined ? room.entry : input.entry;
  if (!ROOM_ENTRIES.includes(entry as RoomEntry)) return refused(400, "INVALID_ENTRY", `Use one of: ${ROOM_ENTRIES.join(", ")}`);
  const settings: RoomSettings = { form: form as RoomForm, capacity: capacity as number, minutes: minutes as number, entry: entry as RoomEntry };
  const seq = room.settingsSeq + 1;
  const made = await remember(store, [{ source: "server", type: "server.room_settings", lessonId: room.id, roomId: room.id, ...settings, seq, actor, occurredAt: now, receivedAt: now, key: `server.room_settings:${room.id}:${seq}` }]);
  if (!made) return refused(409, "CHANGED_CONCURRENTLY", "The room's settings were just changed by someone else; look again");
  return { status: 200, body: { ok: true, settings, inRoom: inRoom(room, now).length } };
}

// A room taken out of use, or back into use (round 7, 2026-11-21). Out of use: its link stays the
// same, but nobody can ask to come in (the holder of its current link is told it is not in use),
// people waiting are closed out, and nobody is let in. Refused while a lesson is open: the iHear
// teacher ends that lesson first (what should happen to people in class is a decision not made
// here). Back in use: the same link works again. A lesson opened at the very moment the room is taken
// out of use is not ended by it: those people stay until it ends; nobody new comes in.
async function setInUse({ store, room, inUse, actor, now }: { store: ClassroomStore; room: FixedRoom; inUse: boolean; actor: string; now: number }) {
  if (inUse === !room.disabled) return { status: 200, body: { ok: true, inUse, unchanged: true } };
  if (!inUse && currentLesson(room, now)) return refused(409, "LESSON_IN_PROGRESS", "A lesson is open in this room: end it first, then take the room out of use");
  const type = inUse ? "server.room_enabled" : "server.room_disabled";
  await remember(store, [{ source: "server", type, lessonId: room.id, roomId: room.id, actor, occurredAt: now, receivedAt: now, key: `${type}:${room.id}:${now}:${randomUUID()}` }]);
  return { status: 200, body: { ok: true, inUse } };
}

// Gate B (round 10, 2026-11-22): the room's list of students, policy neutral and off. A student on
// the list has their code (the one their recording consent is kept under) and the first name the
// list gives; their own pass (option A) is made here, shown once and kept as its hash only, as a
// room's link is. Who may be on a list, how a pass reaches a student (or a guardian) and which
// option is used are the Gate B decision's; all of it answers only while the site may record fixed
// rooms (CLASSROOM_FIXED_ROOM_RECORDING), so with Gate B closed nothing here exists.
async function changeRoster({ store, room, fact, actor, now }: { store: ClassroomStore; room: FixedRoom; fact: { type: "server.room_member"; code: string; name: string; passHash: string } | { type: "server.room_member_removed"; code: string }; actor: string; now: number }) {
  const seq = room.rosterSeq + 1;
  return remember(store, [{
    source: "server", type: fact.type, lessonId: room.id, roomId: room.id, seq, personCode: fact.code,
    ...(fact.type === "server.room_member" ? { name: fact.name, passHash: fact.passHash } : {}),
    actor, occurredAt: now, receivedAt: now, key: `server.room_roster:${room.id}:${seq}`,
  }]);
}
const rosterClosed = () => refused(409, "RECORDING_NOT_AVAILABLE", "A room's list of students exists only where the site may record fixed rooms");
const memberOf = (room: FixedRoom, code: unknown) => room.members.find((entry) => entry.code === String(code ?? "").trim()) ?? null;

async function addMember({ store, room, code, name, actor, now }: { store: ClassroomStore; room: FixedRoom; code: unknown; name: unknown; actor: string; now: number }) {
  if (!fixedRoomRecordingEnabled()) return rosterClosed();
  const clean = rosterCode(code);
  if (!clean) return refused(400, "INVALID_CODE", "Use the student's code: 1–20 letters, digits or hyphens (not a code the room made up)");
  // A name on a room's list also names files in Drive: English letters only (lib/classroom-names.ts).
  const first = rosterNameOf(name);
  if (!first) return refused(400, "INVALID_NAME", "Enter the student's first name in English letters");
  if (room.members.some((entry) => entry.code.toLowerCase() === clean.toLowerCase())) return refused(409, "MEMBER_EXISTS", "This student is on the room's list already");
  if (room.members.length >= ROSTER_MAX) return refused(409, "ROSTER_FULL", `At most ${ROSTER_MAX} students on a room's list`);
  // Round 10 review: one code is one student across the rooms (one consent, one name on files): on
  // another room's list it must be the very same code with the same name.
  const elsewhere = (await allRooms(store)).filter((other) => other.id !== room.id).flatMap((other) => other.members.map((entry) => ({ entry, label: other.label })))
    .find(({ entry }) => entry.code.toLowerCase() === clean.toLowerCase() && (entry.code !== clean || entry.name !== first));
  if (elsewhere) return refused(409, "CODE_NAME_MISMATCH", `This code is on the list of ${elsewhere.label} as ${elsewhere.entry.code} ${elsewhere.entry.name}: one code is one student`);
  const pass = randomBytes(32).toString("base64url");
  if (!(await changeRoster({ store, room, fact: { type: "server.room_member", code: clean, name: first, passHash: hashKey(pass) }, actor, now }))) {
    return refused(409, "ROSTER_CHANGED", "The room's list just changed; look again");
  }
  return { status: 201, body: { ok: true, member: { code: clean, name: first }, passLink: passLinkOf(room.id, pass) } };
}

// A new pass for a student on the list (theirs was lost or reached someone else): the old one asks
// nobody in any more, and a request made with it and still waiting is no longer valid. Someone let in
// with it stays (as with a room's link replaced): the iHear teacher takes them out if need be.
async function reissuePass({ store, room, code, actor, now }: { store: ClassroomStore; room: FixedRoom; code: unknown; actor: string; now: number }) {
  if (!fixedRoomRecordingEnabled()) return rosterClosed();
  const member = memberOf(room, code);
  if (!member) return refused(404, "NO_SUCH_MEMBER", "This student is not on the room's list");
  const pass = randomBytes(32).toString("base64url");
  if (!(await changeRoster({ store, room, fact: { type: "server.room_member", code: member.code, name: member.name, passHash: hashKey(pass) }, actor, now }))) {
    return refused(409, "ROSTER_CHANGED", "The room's list just changed; look again");
  }
  return { status: 200, body: { ok: true, member: { code: member.code, name: member.name }, passLink: passLinkOf(room.id, pass) } };
}

// Off the list: their pass asks nobody in any more. Someone in the room's lesson now stays in it
// (taking a person out is its own step); their consent is not changed here (consent is its own record).
async function removeMember({ store, room, code, actor, now }: { store: ClassroomStore; room: FixedRoom; code: unknown; actor: string; now: number }) {
  if (!fixedRoomRecordingEnabled()) return rosterClosed();
  const member = memberOf(room, code);
  if (!member) return refused(404, "NO_SUCH_MEMBER", "This student is not on the room's list");
  if (!(await changeRoster({ store, room, fact: { type: "server.room_member_removed", code: member.code }, actor, now }))) {
    return refused(409, "ROSTER_CHANGED", "The room's list just changed; look again");
  }
  return { status: 200, body: { ok: true, removedMember: member.code } };
}

export const FIXED_ROOM_ACTIONS = ["create", "replace_link", "admit", "decline", "remove", "end_lesson", "extend_lesson", "set_settings", "set_recording", "disable", "enable", "add_member", "reissue_pass", "remove_member"] as const;
export type FixedRoomAction = (typeof FIXED_ROOM_ACTIONS)[number];
// The list's actions exist only while the site may record fixed rooms; otherwise they are unknown, as
// before Gate B (round 10 review).
const ROSTER_ACTIONS: readonly string[] = ["add_member", "reissue_pass", "remove_member"];
const actionsNow = (): string[] => (fixedRoomRecordingEnabled() ? [...FIXED_ROOM_ACTIONS] : FIXED_ROOM_ACTIONS.filter((entry) => !ROSTER_ACTIONS.includes(entry)));

// What an owner does with the fixed rooms (the iHear teacher, signed in). The route checks the
// owner first; this checks again.
export async function manageFixedRoom({ store, provider, drive, principal, action, input = {}, now }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; principal: { email: string; owner: boolean } | null;
  action: unknown; input?: Record<string, unknown>; now: number;
}) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  if (!principal?.owner || !principal.email) return refused(403, "OWNER_REQUIRED", "Only an owner manages the fixed rooms");
  if (!actionsNow().includes(String(action))) return refused(400, "INVALID_ACTION", `Use one of: ${actionsNow().join(", ")}`);
  const actor = principal.email;
  if (action === "create") return createRoom({ store, label: input.label, entry: input.entry, actor, now });
  const room = await readRoom(store, input.room);
  if (!room) return refused(404, "NO_SUCH_ROOM", "No such room");
  if (action === "replace_link") return replaceLink({ store, room, actor, now });
  if (action === "end_lesson") return endLesson({ store, provider, drive, room, actor, now });
  if (action === "extend_lesson") return extendLesson({ store, room, actor, now });
  if (action === "set_settings") return setSettings({ store, room, input, actor, now });
  if (action === "set_recording") return setRecording({ store, room, on: input.on, actor, now });
  if (action === "disable" || action === "enable") return setInUse({ store, room, inUse: action === "enable", actor, now });
  if (action === "add_member") return addMember({ store, room, code: input.code, name: input.name, actor, now });
  if (action === "reissue_pass") return reissuePass({ store, room, code: input.code, actor, now });
  if (action === "remove_member") return removeMember({ store, room, code: input.code, actor, now });
  const requestId = String(input.request ?? "");
  if (action === "admit") return admit({ store, roomId: room.id, requestId, bindTo: input.bindTo, actor, now });
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

// Round 18c (the user's point 17, 2026-11-27): who of the people let in is in the room now, by Zoom's
// word when the owner asks (read only, so no webhook is needed: the online test site gets none). Each
// person let in this lesson: in (Zoom lists one of their participant ids among the people still in
// the room's live session) or not; others: people in that session who are none of ours. available
// false: this site's classroom cannot ask (the synthetic stand-in); 503: Zoom could not be asked now.
export async function fixedRoomLive({ store, provider, roomId, now }: { store: ClassroomStore; provider: ClassroomProvider; roomId: unknown; now: number }) {
  const room = await readRoom(store, roomId);
  if (!room) return refused(404, "NOT_FOUND", "Not found");
  const lessonNow = currentLesson(room, now);
  const lesson = lessonNow ? await store.lesson(lessonNow.classLessonId) : null;
  if (!lesson) return { status: 200, body: { ok: true, room: room.id, lesson: false, checkedAt: iso(now) } };
  if (!provider.livePeople) return { status: 200, body: { ok: true, room: room.id, lesson: true, available: false, checkedAt: iso(now) } };
  const live = await provider.livePeople(lesson);
  if (!live) return refused(503, "ZOOM_UNAVAILABLE", "Zoom could not be asked now; try again in a moment");
  const codeOf = new Map(lesson.participants.map((entry) => [entry.id, entry.code]));
  const codesIn = new Set(live.userKeys.map((key) => codeOf.get(key)).filter((code): code is string => Boolean(code)));
  const others = live.userKeys.filter((key) => !codeOf.has(key)).length + live.others;
  const people = inRoom(room, now).map((request) => ({ request: request.id, in: codesIn.has(String(latestDecision(request)!.code)) }));
  return { status: 200, body: { ok: true, room: room.id, lesson: true, available: true, sessions: live.sessions, people, others, checkedAt: iso(now) } };
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
  // Gate B (round 10): only where the site may record fixed rooms, the room's list, who each request
  // and each person let in is on it, each person's consent as the recording rule reads it, and the
  // room's recording now (status prompts for the iHear teacher). Nothing of it with Gate B closed.
  const available = fixedRoomRecordingEnabled();
  // Round 10 review: consent is read for the same people the recording rule counts: every student row
  // of the lesson (someone taken out keeps theirs and still counts), not only who is in the room now.
  const studentRows = (row: ClassroomLesson | null) => (row ? row.participants.filter((entry) => entry.role === "student" && entry.active !== false) : []);
  const lessonCodes = available ? [...new Set([...lessons.values()].flatMap((row) => studentRows(row).map((entry) => entry.code)))] : [];
  const consents = lessonCodes.length ? await store.listConsents(lessonCodes) : [];
  const policy = consentPolicy();
  const consentOf = (code: string | null) => (code ? personConsentProblem(consents.find((record) => record.personCode === code) ?? null, policy, now) ?? "CONSENTED" : "CONSENT_MISSING");
  return rooms.map((room) => {
    const lesson = currentLesson(room, now);
    const row = lesson ? lessons.get(lesson.classLessonId) ?? null : null;
    const facts = row ? lessonEvents.filter((event) => event.lessonId === row.id) : [];
    const state = available && row ? deriveLesson(forRules(row, facts), facts, now) : null;
    const presentCodes = new Set(inRoom(room, now).map((request) => latestDecision(request)!.code));
    const lacking = available ? [...new Set(studentRows(row).map((entry) => entry.code))].filter((code) => consentOf(code) !== "CONSENTED") : [];
    return {
      id: room.id, label: room.label, createdAt: iso(room.createdAt), linkGeneration: room.links.at(-1)?.generation ?? 0, capacity: room.capacity, form: room.form, minutes: room.minutes, entry: room.entry,
      recording: {
        on: room.recording, available,
        ...(state ? {
          status: String(state.recording.status), label: RECORDING_LABELS[state.recording.status] ?? String(state.recording.status),
          anomalies: (state.anomalies ?? []).map((entry: { code: string; severity: string }) => ({ code: entry.code, severity: entry.severity })),
          // Without a valid consent: in the room now, and taken out but still counted in this lesson.
          consentLacking: { inRoom: lacking.filter((code) => presentCodes.has(code)).length, takenOut: lacking.filter((code) => !presentCodes.has(code)) },
        } : {}),
      },
      disabled: room.disabled,
      // The lesson now, its start and planned end, and whether 30 more minutes still fit (2026-11-24).
      lesson: lesson ? {
        lessonId: lesson.classLessonId, startedAt: iso(lesson.startedAt), endsAt: iso(lesson.endsAt),
        extendable: lesson.endsAt + EXTEND_MINUTES * 60_000 <= lesson.startedAt + LESSON_MAX_MINUTES * 60_000,
      } : null,
      waiting: waiting(room, now).map((request) => ({ request: request.id, name: request.shown, at: iso(request.at), ...(available ? { student: request.personCode } : {}) })),
      inRoom: inRoom(room, now).map((request) => {
        const decision = latestDecision(request)!;
        return {
          request: request.id, name: request.shown, code: decision.code, at: iso(decision.at), presence: presenceOf(row, lessonEvents, decision.code),
          ...(available ? { student: decision.personCode, boundBy: decision.boundBy, consent: consentOf(decision.code) } : {}),
        };
      }),
      // passIssuedAt: when the student's current pass was made (a pass replaced shows a new time).
      ...(available ? { members: room.members.map((member) => ({ code: member.code, name: member.name, passIssuedAt: iso(member.at) })) } : {}),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------------------------
// The rooms in bulk (2026-11-21: the iHear teacher asked for 100 rooms named Room1, Room2, …).
// Additions only. Each step below is the single room's own step taken once per room (createRoom,
// replaceLink, setRecording), so every rule of one room holds for many: names, the owner, a link
// kept as its hash only, the recording switches. A request is checked whole before anything is
// written; what cannot be done for one room afterwards (two owners at the same moment) is said
// for that room and never hidden.
export const BULK_MAX = 100;
export const FIXED_ROOM_BULK_ACTIONS = ["create_many", "export_links", "set_recording_all"] as const;
export type FixedRoomBulkAction = (typeof FIXED_ROOM_BULK_ACTIONS)[number];

const cleanLabel = (label: unknown) => String(label ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
// Room2 before Room10: a number inside a name counts as a number.
const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" });
const refusedFor = (status: number, code: string, error: string, labels: string[]) => ({ status, body: { ok: false, code, error, labels } });

// The names asked for: a list, or a run of numbers after a prefix ("Room" 1 to 100: Room1 … Room100).
// Null: the request is not one of the two shapes. More than BULK_MAX names is said by the caller.
function labelsAsked(input: Record<string, unknown>): string[] | "TOO_MANY" | null {
  if (Array.isArray(input.labels)) {
    if (!input.labels.every((label) => typeof label === "string")) return null;
    return input.labels.length > BULK_MAX ? "TOO_MANY" : input.labels.map(cleanLabel);
  }
  const { prefix, from, to } = input;
  if (typeof prefix !== "string" || !Number.isInteger(from) || !Number.isInteger(to)) return null;
  const first = from as number, last = to as number;
  if (first < 1 || last < first || last > 9999) return null;
  if (last - first + 1 > BULK_MAX) return "TOO_MANY";
  return Array.from({ length: last - first + 1 }, (_, index) => cleanLabel(`${prefix}${first + index}`));
}

const allRooms = async (store: ClassroomStore) => {
  const defs = await definitions(store);
  const ids = defs.map((event) => String(event.roomId));
  const events = ids.length ? await store.eventsFor(ids) : [];
  return defs.map((definition) => roomFrom(definition, events)).sort(byLabel);
};

// Many rooms at once, each with a link of its own, given in this answer only. Nothing is made unless
// every name is right, new, and asked for once.
async function createRooms({ store, input, actor, now }: { store: ClassroomStore; input: Record<string, unknown>; actor: string; now: number }) {
  const labels = labelsAsked(input);
  if (labels === "TOO_MANY") return refused(400, "TOO_MANY", `At most ${BULK_MAX} rooms at a time`);
  if (!labels || !labels.length) return refused(400, "INVALID_BULK", "Give labels (a list of names), or prefix, from and to (whole numbers from 1)");
  const bad = labels.filter((label) => !ROOM_LABEL.test(label));
  if (bad.length) return refusedFor(400, "INVALID_LABEL", "Use English letters and digits (spaces, . and ' too), at most 40, no - or _", bad);
  const lower = labels.map((label) => label.toLowerCase());
  const twice = labels.filter((_, index) => lower.indexOf(lower[index]) !== index);
  if (twice.length) return refusedFor(409, "DUPLICATE_LABEL", "A name is asked for more than once", [...new Set(twice)]);
  const existing = new Set((await definitions(store)).map((event) => String(event.label).toLowerCase()));
  const taken = labels.filter((label) => existing.has(label.toLowerCase()));
  if (taken.length) return refusedFor(409, "LABEL_TAKEN", "A room with this name exists", taken);
  const rooms: { id: string; label: string; link: string }[] = [];
  const failed: { label: string; code: string }[] = [];
  // Round 4 (2026-11-21): a store that fails part-way never takes the rooms already made with it.
  // The room it failed on may or may not exist now (unknown); the ones after it are not tried.
  const unknown: { label: string }[] = [];
  const notAttempted: { label: string }[] = [];
  for (const [index, label] of labels.entries()) {
    let made;
    try { made = await createRoom({ store, label, entry: input.entry, actor, now }); } catch (error) {
      if (!rooms.length) throw error;
      unknown.push({ label });
      notAttempted.push(...labels.slice(index + 1).map((rest) => ({ label: rest })));
      break;
    }
    const body = made.body as { room?: { id: string; label: string }; link?: string; code?: string };
    if (made.status === 201 && body.room && body.link) rooms.push({ id: body.room.id, label: body.room.label, link: body.link });
    else failed.push({ label, code: String(body.code ?? "FAILED") });
  }
  if (!rooms.length) return refusedFor(409, "LABEL_TAKEN", "A room with this name exists", failed.map((entry) => entry.label));
  return { status: 201, body: { ok: true, rooms, failed, unknown, notAttempted } };
}

// Every room's link, once more. Only a link's hash is kept, so a link that was lost cannot be shown
// again: each room here gets a new link (its old one lets nobody new in; people already in stay), and
// the new links are in this answer only. All rooms, or the ones named.
async function exportLinks({ store, input, actor, now }: { store: ClassroomStore; input: Record<string, unknown>; actor: string; now: number }) {
  const every = await allRooms(store);
  let chosen = every;
  if (input.rooms !== undefined) {
    if (!Array.isArray(input.rooms) || !input.rooms.length || !input.rooms.every((id) => typeof id === "string" && ROOM_ID.test(id))) return refused(400, "INVALID_BULK", "Give rooms as a list of room ids, or leave it out for every room");
    const ids = new Set(input.rooms as string[]);
    chosen = every.filter((room) => ids.has(room.id));
    if (chosen.length !== ids.size) return refused(404, "NO_SUCH_ROOM", "No such room");
  }
  if (!chosen.length) return refused(409, "NO_ROOMS", "There are no rooms yet");
  if (chosen.length > BULK_MAX) return refused(400, "TOO_MANY", `At most ${BULK_MAX} rooms at a time: name the rooms`);
  const links: { room: string; label: string; link: string; generation: number }[] = [];
  const failed: { room: string; label: string; code: string }[] = [];
  // Round 4 (2026-11-21): a store that fails part-way never takes the links already made with it
  // (they exist nowhere else). The room it failed on may or may not have a new link now (unknown);
  // the rooms after it are not tried. A failure before any link was made is thrown as before.
  const unknown: { room: string; label: string }[] = [];
  const notAttempted: { room: string; label: string }[] = [];
  for (const [index, room] of chosen.entries()) {
    let replaced;
    try { replaced = await replaceLink({ store, room, actor, now }); } catch (error) {
      if (!links.length) throw error;
      unknown.push({ room: room.id, label: room.label });
      notAttempted.push(...chosen.slice(index + 1).map((rest) => ({ room: rest.id, label: rest.label })));
      break;
    }
    const body = replaced.body as { link?: string; generation?: number; code?: string };
    if (replaced.status === 200 && body.link) links.push({ room: room.id, label: room.label, link: body.link, generation: Number(body.generation) });
    else failed.push({ room: room.id, label: room.label, code: String(body.code ?? "FAILED") });
  }
  return { status: 200, body: { ok: true, links, failed, unknown, notAttempted } };
}

// Every room's own recording switch at once, by the single room's rules: on only where the site
// allows fixed rooms to record at all (then nothing changes anywhere); off is refused for a room that
// may be recording now, and said for that room.
async function setRecordingAll({ store, input, actor, now }: { store: ClassroomStore; input: Record<string, unknown>; actor: string; now: number }) {
  const { on } = input;
  if (on !== true && on !== false) return refused(400, "INVALID_SWITCH", "Say on: true or false");
  if (on && !fixedRoomRecordingEnabled()) return refused(409, "RECORDING_NOT_AVAILABLE", "Recording in fixed rooms is not turned on for this site");
  const changed: string[] = [];
  const unchanged: string[] = [];
  const refusedRooms: { room: string; label: string; code: string }[] = [];
  for (const room of await allRooms(store)) {
    if (room.recording === on) { unchanged.push(room.id); continue; }
    const result = await setRecording({ store, room, on, actor, now });
    if (result.status === 200) changed.push(room.id);
    else refusedRooms.push({ room: room.id, label: room.label, code: String((result.body as { code?: string }).code ?? "FAILED") });
  }
  return { status: 200, body: { ok: true, recording: on, changed, unchanged, refused: refusedRooms } };
}

// What an owner does with many rooms at once. Off with the fixed rooms; an owner only, checked here
// as manageFixedRoom checks it (the route checks first).
export async function manageFixedRoomsBulk({ store, principal, action, input = {}, now }: {
  store: ClassroomStore; principal: { email: string; owner: boolean } | null; action: unknown; input?: Record<string, unknown>; now: number;
}) {
  if (!fixedRoomsEnabled()) return refused(404, "NOT_FOUND", "Not found");
  if (!principal?.owner || !principal.email) return refused(403, "OWNER_REQUIRED", "Only an owner manages the fixed rooms");
  if (!FIXED_ROOM_BULK_ACTIONS.includes(action as FixedRoomBulkAction)) return refused(400, "INVALID_ACTION", `Use one of: ${FIXED_ROOM_BULK_ACTIONS.join(", ")}`);
  const actor = principal.email;
  if (action === "create_many") return createRooms({ store, input, actor, now });
  if (action === "export_links") return exportLinks({ store, input, actor, now });
  return setRecordingAll({ store, input, actor, now });
}
