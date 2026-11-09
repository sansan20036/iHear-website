import { randomBytes, randomUUID } from "node:crypto";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { deriveLesson } from "../tools/recording-pathway/classroom/lesson-state.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { LABELS } from "../tools/recording-pathway/classroom/live-dashboard.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { FILE_NAME_SAFE } from "../tools/recording-pathway/classroom/block-naming.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript.
import { OPERATION_EVENT } from "../tools/recording-pathway/classroom/operations.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { storeEvent } from "../tools/recording-pathway/classroom/webhook-ingest.mjs";
import {
  blockPhase, hashKey, inBlockWindow, isStaff, MAX_MEMBERS, MAX_ROOMS, memberOf, memberState, newYorkDate, openConnections, presenceIn, recordingModeOf, ROOM_CAPACITY, seatOf, STALE_PRESENCE_MS,
  type BlockPhase, type BlockTarget, type RecordingMode,
} from "./classroom-block-rules";
import type { ClassroomDrive } from "./classroom-drive";
import type { ClassroomProvider } from "./classroom-provider";
import {
  ClassroomInputError, effectiveTarget, emergencyStopRecording, forRules, PERSON_CODE, recordingDecision, recordingRoomGate, roomMayRecordNow, stopRecordingForCancelledLesson,
} from "./classroom-service";
import type { BlockRole, ClassroomBlock, ClassroomBlockMember, ClassroomEvent, ClassroomLesson, ClassroomParticipant, ClassroomStore } from "./classroom-store";
import { multiRecordingEnabled } from "./classroom-switches";

// P3-Multi (2026-11-09): a block (班次) with a Lobby (主會議室) and several teaching rooms, each room
// its own Zoom session, consent decision, recording and filing (an ordinary lesson underneath).
// The manager enters the Lobby first; the server alone decides who may be where, and every change
// a manager makes is checked again here (owner or the block's own manager), names the block's
// version it was made on, and is stored with who made it. Nothing here starts a recording: a
// block is Classroom Only until an owner switches it, and even then each room's own consent check
// decides (the existing rules).

const RECORDING_LABELS: Record<string, string> = LABELS.recording;
const BLOCK_CODE = /^[A-Za-z0-9-]{1,30}$/;
const ROOM_LABEL = /^[A-Za-z0-9-]{1,8}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The confirmed English display name (18.4) as it appears in Drive's file names: letters, spaces,
// . and ' only, up to 60 characters. "-" joins names and "_" separates the parts of a file name, so
// a name holding either (Mary-Jane) is entered the way iHear confirms it for files (Mary Jane).
const ENGLISH_NAME: RegExp = FILE_NAME_SAFE;
const ROLES: BlockRole[] = ["manager", "lead_tutor", "co_tutor", "observer", "student"];
const shortId = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, "")}`;
const blockLinkOf = (blockId: string, key: string) => `/classroom/b/${blockId}#k=${key}`;
const eventKey = (type: string, blockId: string, now: number) => `${type}:${blockId}:${now}:${randomUUID()}`;

// How a member takes part in each kind of lesson: the manager hosts the Lobby, tutors their rooms;
// everyone else in the Lobby, and an observer anywhere, takes part without host controls.
function lobbyRole(member: ClassroomBlockMember): ClassroomParticipant["role"] {
  return member.role === "manager" ? "tutor" : member.role === "student" ? "student" : "observer";
}
function roomRole(member: ClassroomBlockMember): ClassroomParticipant["role"] {
  return member.role === "lead_tutor" || member.role === "co_tutor" ? "tutor" : member.role === "student" ? "student" : "observer";
}

export type BlockInput = {
  code?: unknown; date?: unknown; time?: unknown; minutes?: unknown;
  rooms?: unknown; members?: unknown; assignments?: unknown;
  // Draft 030: the course the block belongs to (optional), and for an imported block its place in
  // that course's schedule (set by the schedule import only).
  course?: unknown; sourceKey?: unknown;
};
const SOURCE_KEY = /^[A-Za-z0-9:._-]{1,120}$/;

// A block with its Lobby, rooms, members and first seats, all in one step. Students' personal
// links are in this answer only (their hashes are kept). Times are Taipei time, as for lessons;
// everything is stored in UTC.
export async function createClassroomBlock({ store, input, actor, now }: { store: ClassroomStore; input: BlockInput; actor: string; now: number }) {
  const issues: Record<string, string> = {};
  const code = String(input.code ?? "").trim();
  const date = String(input.date ?? "").trim();
  const time = String(input.time ?? "").trim();
  const minutes = Number(input.minutes);
  if (!BLOCK_CODE.test(code)) issues.code = "Use 1–30 letters, digits or hyphens";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+08:00`))) issues.date = "Use YYYY-MM-DD";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) issues.time = "Use HH:MM";
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) issues.minutes = "Use 15–240 minutes";
  const labels = Array.isArray(input.rooms) ? input.rooms.map((entry) => String(entry ?? "").trim()) : [];
  if (!labels.length || labels.length > MAX_ROOMS) issues.rooms = `Name 1–${MAX_ROOMS} rooms`;
  else if (labels.some((label) => !ROOM_LABEL.test(label) || label.toUpperCase() === "LOBBY")) issues.rooms = "Room names: 1–8 letters, digits or hyphens (not LOBBY)";
  else if (new Set(labels.map((label) => label.toUpperCase())).size !== labels.length) issues.rooms = "Each room needs its own name";
  const rawMembers = Array.isArray(input.members) ? input.members : [];
  const members: ClassroomBlockMember[] = [];
  const keys = new Map<string, string>();
  if (!rawMembers.length || rawMembers.length > MAX_MEMBERS) issues.members = `Add 1–${MAX_MEMBERS} people`;
  for (const [index, raw] of rawMembers.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const memberCode = String(entry.code ?? "").trim();
    const role = String(entry.role ?? "") as BlockRole;
    const englishName = String(entry.englishName ?? "").trim().replace(/\s+/g, " ");
    const email = String(entry.email ?? "").trim().toLowerCase();
    const where = `members.${index}`;
    if (!PERSON_CODE.test(memberCode)) issues[`${where}.code`] = "Use 1–20 letters, digits or hyphens";
    if (!ROLES.includes(role)) issues[`${where}.role`] = `Use one of: ${ROLES.join(", ")}`;
    if (!ENGLISH_NAME.test(englishName)) issues[`${where}.englishName`] = "Enter the confirmed English name for file names (letters, spaces, . and '; no - or _)";
    if (role === "student") {
      if (email) issues[`${where}.email`] = "Students enter with their personal link, not an e-mail";
      const key = randomBytes(32).toString("base64url");
      keys.set(memberCode, key);
      members.push({ id: shortId("M"), code: memberCode, role, englishName, staffEmail: null, joinKeyHash: hashKey(key) });
    } else {
      if (!EMAIL.test(email) || email.length > 320) issues[`${where}.email`] = "Enter the sign-in e-mail";
      members.push({ id: shortId("M"), code: memberCode, role, englishName, staffEmail: email, joinKeyHash: null });
    }
  }
  if (new Set(members.map((member) => member.code)).size !== members.length) issues.members = "Each person needs their own code";
  if (members.filter((member) => member.role === "manager").length !== 1) issues.manager = "Name exactly one manager";
  const emails = members.filter((member) => member.staffEmail).map((member) => member.staffEmail);
  if (new Set(emails).size !== emails.length) issues.members = "Each staff member signs in with their own e-mail";
  // First seats: who sits in which room when the breakout starts (they can be changed later).
  const assignments = Array.isArray(input.assignments) ? input.assignments : [];
  const seats = new Map<string, string>();
  for (const [index, raw] of assignments.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const memberCode = String(entry.member ?? "").trim();
    const label = String(entry.room ?? "").trim();
    const member = members.find((item) => item.code === memberCode);
    if (!member || member.role === "manager") issues[`assignments.${index}`] = "Seat a student, a tutor or an observer of this block";
    else if (!labels.includes(label)) issues[`assignments.${index}`] = "No such room";
    else if (seats.has(memberCode)) issues[`assignments.${index}`] = "One room per person";
    else seats.set(memberCode, label);
  }
  for (const label of labels) {
    if ([...seats.values()].filter((value) => value === label).length > ROOM_CAPACITY) issues.assignments = `A room holds at most ${ROOM_CAPACITY} people`;
  }
  // Draft 030: a course that exists, is not cancelled and whose program is not archived.
  let courseId: string | null = null;
  if (input.course != null && input.course !== "") {
    const { programs, courses } = await store.listPrograms();
    const course = courses.find((item) => item.id === input.course || item.code === input.course);
    const program = course ? programs.find((item) => item.id === course.programId) : null;
    if (!course || !program) issues.course = "No such course";
    else if (course.cancelled || program.archived) issues.course = "That course is cancelled or its program archived";
    else courseId = course.id;
  }
  const sourceKey = input.sourceKey == null || input.sourceKey === "" ? null : String(input.sourceKey);
  if (sourceKey && (!SOURCE_KEY.test(sourceKey) || input.course == null)) issues.sourceKey = "A schedule place needs a course";
  if (Object.keys(issues).length) throw new ClassroomInputError("The block is not valid", issues);

  const startsAt = Date.parse(`${date}T${time}:00+08:00`);
  const block: ClassroomBlock = {
    id: shortId("B"), code, date, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(startsAt + minutes * 60_000).toISOString(),
    cancelled: false, createdBy: actor, createdAt: new Date(now).toISOString(), lobbyId: shortId("L"), roomIds: labels.map(() => shortId("L")), members, version: 0,
    ...(courseId ? { courseId, sourceKey } : {}),
  };
  const lessonOf = (id: string, kind: "lobby" | "room", label: string, participants: ClassroomParticipant[]): ClassroomLesson => ({
    id, code: `${code}-${label}`, date, startsAt: block.startsAt, endsAt: block.endsAt, cancelled: false, createdBy: actor, createdAt: block.createdAt,
    participants, blockId: block.id, roomKind: kind, roomLabel: label,
  });
  const lobby = lessonOf(block.lobbyId, "lobby", "LOBBY", members.map((member) => ({
    id: shortId("P"), code: member.code, role: lobbyRole(member), staffEmail: null, joinKeyHash: null, memberId: member.id, active: true, seat: "lobby" as const,
  })));
  const rooms = labels.map((label, index) => lessonOf(block.roomIds[index], "room", label, members.filter((member) => seats.get(member.code) === label).map((member) => ({
    id: shortId("P"), code: member.code, role: roomRole(member), staffEmail: null, joinKeyHash: null, memberId: member.id, active: true, seat: "assigned" as const,
  }))));
  await store.createBlock(block, [lobby, ...rooms]);
  await serverEvents(store, [{ source: "server", type: "server.block_audit", lessonId: block.lobbyId, blockId: block.id, action: "create", actor, version: 0, occurredAt: now, receivedAt: now, key: eventKey("server.block_audit", block.id, now) }]);
  return {
    block: { blockId: block.id, code: block.code, startsAt: block.startsAt, endsAt: block.endsAt, rooms: labels },
    studentLinks: members.filter((member) => member.role === "student").map((member) => ({ code: member.code, link: blockLinkOf(block.id, keys.get(member.code)!) })),
  };
}

async function serverEvents(store: ClassroomStore, events: ClassroomEvent[]) {
  if (!events.length) return;
  await store.transaction(async (tx) => {
    for (const event of events) await storeEvent(tx, event);
  });
}

async function roomsOf(store: ClassroomStore, block: ClassroomBlock) {
  return (await Promise.all(block.roomIds.map((id) => store.lesson(id)))).filter((room): room is ClassroomLesson => Boolean(room));
}

// Who may run a block: a site owner, or the block's own manager signed in with that e-mail. Asked
// again on every request (18.1): a manager whose sign-in ended gets nothing until they sign in again.
export type BlockPrincipal = { email: string | null; owner: boolean };
function managerOf(block: ClassroomBlock, principal: BlockPrincipal) {
  if (principal.owner) return { allowed: true, actor: principal.email ?? "owner", as: "owner" as const };
  const manager = block.members.find((member) => member.role === "manager");
  if (principal.email && manager?.staffEmail === principal.email) return { allowed: true, actor: principal.email, as: "manager" as const };
  return { allowed: false, actor: principal.email ?? "", as: null };
}

const refused = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => ({ status, body: { error, code, ...extra } });

export const BLOCK_ACTIONS = [
  "open_lobby", "start_breakout", "assign", "visit", "end_visit", "recall", "end_block", "cancel_block",
  "revoke_link", "reissue_link", "set_recording_mode", "check_recording", "stop_room_recording",
] as const;
export type BlockAction = (typeof BLOCK_ACTIONS)[number];
// Actions that change the block: they name the version they were made on.
const VERSIONED = new Set<BlockAction>(["open_lobby", "start_breakout", "assign", "visit", "end_visit", "recall", "end_block", "cancel_block", "revoke_link", "reissue_link", "set_recording_mode"]);
const NEXT_PHASE: Partial<Record<BlockAction, { from: BlockPhase[]; to: BlockPhase }>> = {
  open_lobby: { from: ["SETUP"], to: "LOBBY_OPEN" },
  start_breakout: { from: ["LOBBY_OPEN", "RECALLED"], to: "BREAKOUT" },
  recall: { from: ["BREAKOUT"], to: "RECALLED" },
  end_block: { from: ["SETUP", "LOBBY_OPEN", "BREAKOUT", "RECALLED"], to: "ENDED" },
};

// One change by a manager or an owner (18.1/18.2): checked against who is asking, the block's
// phase, the people and rooms named, the rooms' capacity and recording, and the block's version
// (a change made on an older version is refused: STALE_VERSION, the current version given back).
export async function manageBlock({ store, provider, drive, blockId, principal, action, input = {}, now }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; blockId: string; principal: BlockPrincipal;
  action: unknown; input?: Record<string, unknown>; now: number;
}) {
  if (!BLOCK_ACTIONS.includes(action as BlockAction)) return refused(400, "INVALID_ACTION", `Use one of: ${BLOCK_ACTIONS.join(", ")}`);
  const act = action as BlockAction;
  const block = await store.block(blockId);
  if (!block) return refused(404, "BLOCK_NOT_FOUND", "Block not found");
  const who = managerOf(block, principal);
  if (!who.allowed) return refused(403, "NOT_BLOCK_MANAGER", "Only this block's manager or an owner can do this");
  const version = Number(input.version);
  if (VERSIONED.has(act) && !Number.isInteger(version)) return refused(400, "VERSION_REQUIRED", "Name the version this change was made on", { version: block.version });
  if (block.cancelled) return refused(409, "BLOCK_CANCELLED", "The block is cancelled");
  const lobbyEvents = await store.eventsFor([block.lobbyId]);
  const { phase } = blockPhase(lobbyEvents);
  if (phase === "ENDED" && act !== "check_recording" && act !== "stop_room_recording") return refused(409, "BLOCK_ENDED", "The block has ended");
  const rooms = await roomsOf(store, block);
  const roomByLabel = (value: unknown) => rooms.find((room) => room.roomLabel === String(value ?? ""));
  const memberByCode = (value: unknown) => block.members.find((member) => member.code === String(value ?? ""));
  const audit = (details: Record<string, unknown>): ClassroomEvent => ({
    source: "server", type: "server.block_audit", lessonId: block.lobbyId, blockId: block.id, action: act, actor: who.actor, as: who.as, version, blockVersion: version + 1, ...details,
    occurredAt: now, receivedAt: now, key: eventKey("server.block_audit", block.id, now),
  });
  // The rooms whose roster changed: each decides again whether it may be recorded (G2, 第五部分 4).
  const rosterChanged = (roomIds: (string | null | undefined)[], reason: string): ClassroomEvent[] => [...new Set(roomIds.filter(Boolean) as string[])].map((roomId) => ({
    source: "server", type: "server.consent_changed", lessonId: roomId, reason, occurredAt: now, receivedAt: now, key: eventKey("server.consent_changed", roomId, now),
  }));
  const commit = async (change: Omit<Parameters<ClassroomStore["changeBlock"]>[0], "blockId" | "expectedVersion">) => {
    const result = await store.changeBlock({ blockId: block.id, expectedVersion: version, ...change });
    if (!result.ok) {
      const status = result.reason === "STALE_VERSION" || result.reason === "CHANGED_CONCURRENTLY" ? 409 : result.reason === "ROOM_FULL" ? 409 : 400;
      return { done: false as const, response: refused(status, result.reason, result.reason === "STALE_VERSION" ? "The block changed meanwhile; look again and retry" : result.reason === "ROOM_FULL" ? `The room is full (${ROOM_CAPACITY})` : "The change could not be made", { version: result.version ?? block.version }) };
    }
    return { done: true as const, result };
  };
  const answer = async (extra: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, ...extra, view: await blockView({ store, blockId: block.id, now }) } });

  const step = NEXT_PHASE[act];
  if (step) {
    if (!step.from.includes(phase)) return refused(409, "WRONG_PHASE", `Not possible while the block is ${phase}`, { phase });
    if (act === "open_lobby" && !(await managerEntered(store, block))) return refused(409, "MANAGER_NOT_IN_LOBBY", "The manager enters the Lobby first");
    if (act === "start_breakout" && input.confirm !== true) return refused(400, "CONFIRM_REQUIRED", "Confirm the rooms before starting");
    if (act === "start_breakout" && !rooms.some((room) => room.participants.some((entry) => entry.active !== false && entry.seat === "assigned"))) return refused(409, "NO_ASSIGNMENTS", "Seat people in rooms first");
    const committed = await commit({ events: [
      { source: "server", type: "server.block_phase", lessonId: block.lobbyId, blockId: block.id, phase: step.to, actor: who.actor, blockVersion: version + 1, occurredAt: now, receivedAt: now, key: eventKey("server.block_phase", block.id, now) },
      audit({ phase: step.to }),
    ] });
    if (!committed.done) return committed.response;
    if (act === "end_block") await closeLessons({ store, provider, drive, block, reason: "block_ended", now });
    return answer();
  }

  if (act === "cancel_block") {
    const committed = await commit({ cancel: true, events: [audit({})] });
    if (!committed.done) return committed.response;
    await closeLessons({ store, provider, drive, block, reason: "block_cancelled", now });
    return answer();
  }

  if (act === "assign" || act === "visit" || act === "end_visit") {
    const member = act === "assign" || input.member != null ? memberByCode(input.member) : block.members.find((entry) => entry.role === "manager" && entry.staffEmail === principal.email);
    if (!member) return refused(404, "NO_SUCH_MEMBER", "No such person in this block");
    const seat = act === "assign" ? "assigned" : "visit";
    if (act === "assign" && member.role === "manager") return refused(400, "MANAGER_NOT_SEATED", "The manager stays in the Lobby and visits rooms");
    if (act !== "assign" && member.role !== "manager" && member.role !== "observer") return refused(400, "ONLY_STAFF_VISIT", "Only the manager or an observer visits rooms");
    if (act === "visit" && phase !== "BREAKOUT") return refused(409, "WRONG_PHASE", "Rooms are visited during the breakout", { phase });
    const room = act === "end_visit" || input.room == null || input.room === "" ? null : roomByLabel(input.room);
    if (act !== "end_visit" && input.room != null && input.room !== "" && !room) return refused(404, "NO_SUCH_ROOM", "No such room");
    if (act === "visit" && !room) return refused(400, "ROOM_REQUIRED", "Name the room to visit");
    // 18.2 step 6–7: nobody without a valid consent (student) or notice (staff) goes into a room
    // that may be recording; the change is refused and nothing moves.
    if (room && (await roomMayRecordNow(store, room, now))) {
      const gate = await recordingRoomGate(store, room, member, now);
      if (gate) return refused(409, gate, "That room may be recording, and this person's consent or notice is not valid now");
    }
    const held = seatOf(rooms, member, seat);
    const committed = await commit({
      seat: { memberId: member.id, roomId: room?.id ?? null, seat, capacity: ROOM_CAPACITY, ...(room ? { participant: { id: shortId("P"), code: member.code, role: roomRole(member) } } : {}) },
      events: [
        { source: "server", type: "server.seat_changed", lessonId: block.lobbyId, blockId: block.id, blockVersion: version + 1, memberId: member.id, code: member.code, seat, from: held?.room.roomLabel ?? null, to: room?.roomLabel ?? null, actor: who.actor, occurredAt: now, receivedAt: now, key: eventKey("server.seat_changed", block.id, now) },
        audit({ member: member.code, seat, from: held?.room.roomLabel ?? null, to: room?.roomLabel ?? null }),
        ...rosterChanged([held?.room.id, room?.id], `seat_${act}`),
      ],
    });
    if (!committed.done) return committed.response;
    return answer({ changed: committed.result.seat?.changed ?? false });
  }

  if (act === "revoke_link" || act === "reissue_link") {
    const member = memberByCode(input.member);
    if (!member || member.role !== "student") return refused(404, "NO_SUCH_STUDENT", "No such student in this block");
    const all = [await store.lesson(block.lobbyId), ...rooms].filter((lesson): lesson is ClassroomLesson => Boolean(lesson));
    const rotations = all.flatMap((lesson) => lesson.participants.filter((entry) => entry.memberId === member.id).map((entry) => ({ lessonId: lesson.id, fromId: entry.id, toId: shortId("P") })));
    const key = randomBytes(32).toString("base64url");
    const seatedIn = rooms.filter((room) => room.participants.some((entry) => entry.memberId === member.id && entry.active !== false)).map((room) => room.id);
    const committed = await commit({
      rotate: { memberId: member.id, keyHash: hashKey(key), rotations },
      events: [
        ...rotations.map((rotation) => ({ source: "server", type: "server.participant_rotated", lessonId: rotation.lessonId, from: rotation.fromId, to: rotation.toId, reason: act, occurredAt: now, receivedAt: now, key: `server.participant_rotated:${rotation.lessonId}:${rotation.toId}` })),
        { source: "server", type: "server.member_link", lessonId: block.lobbyId, blockId: block.id, blockVersion: version + 1, memberId: member.id, action: act === "revoke_link" ? "revoked" : "reissued", actor: who.actor, occurredAt: now, receivedAt: now, key: eventKey("server.member_link", block.id, now) },
        audit({ member: member.code }),
        ...rosterChanged(seatedIn, act),
      ],
    });
    if (!committed.done) return committed.response;
    return answer(act === "reissue_link" ? { studentLink: blockLinkOf(block.id, key), member: member.code } : { member: member.code });
  }

  if (act === "set_recording_mode") {
    // 18.6: only an owner changes it, after checking again: Classroom Only only once no room may
    // still be recording or has a recording action in an unknown state; Classroom + Recording only
    // where recording in blocks is on for the site and nothing is in an unknown state.
    if (!principal.owner) return refused(403, "OWNER_REQUIRED", "Only an owner changes the recording mode");
    const mode = String(input.mode ?? "") as RecordingMode;
    if (mode !== "classroom_only" && mode !== "classroom_recording") return refused(400, "INVALID_MODE", "Use classroom_only or classroom_recording");
    const unknown: string[] = [];
    const recording: string[] = [];
    for (const room of rooms) {
      const facts = await store.eventsFor([room.id]);
      if (facts.some((event) => event.type === OPERATION_EVENT && ["UNKNOWN", "UNCERTAIN", "IN_FLIGHT"].includes(String(event.state)))) unknown.push(String(room.roomLabel));
      const state = deriveLesson(forRules(room, facts), facts, now);
      if (["START_REQUESTED", "RECORDING", "PAUSED", "POSSIBLY_STOPPED"].includes(String(state.recording.status))) recording.push(String(room.roomLabel));
    }
    if (unknown.length) return refused(409, "UNKNOWN_RECORDING_STATE", "A recording action's result is not known yet: check it or stop the room first", { rooms: unknown });
    if (mode === "classroom_only" && recording.length) return refused(409, "RECORDING_MAY_BE_ON", "A room may still be recording: stop it first", { rooms: recording });
    if (mode === "classroom_recording" && !multiRecordingEnabled()) return refused(409, "RECORDING_NOT_AVAILABLE", "Recording in blocks is not turned on for this site");
    const committed = await commit({ events: [
      ...[block.lobbyId, ...block.roomIds].map((lessonId) => ({ source: "server", type: "server.recording_mode", lessonId, blockId: block.id, blockVersion: version + 1, mode, actor: who.actor, occurredAt: now, receivedAt: now, key: eventKey("server.recording_mode", lessonId, now) })),
      audit({ mode }),
      ...rosterChanged(block.roomIds, "recording_mode"),
    ] });
    if (!committed.done) return committed.response;
    return answer();
  }

  const room = roomByLabel(input.room);
  if (!room) return refused(404, "NO_SUCH_ROOM", "No such room");
  if (act === "stop_room_recording") {
    // 18.7: the protective stop (and the session ended if Zoom does not confirm), as the owners'
    // emergency stop; never shown as stopped without Zoom's word.
    const result = await emergencyStopRecording({ store, provider, drive, lessonId: room.id, now });
    await serverEvents(store, [audit({ room: room.roomLabel })]);
    return { status: result.status, body: { ...result.body, view: await blockView({ store, blockId: block.id, now }) } };
  }
  // check_recording (18.7): a read-only look at Zoom for the room's sessions that may be recording
  // or whose recording action is unresolved. It sends nothing; what Zoom says is kept as a fact
  // (the next tick settles an unresolved action with it).
  const facts = await store.eventsFor([room.id]);
  const state = deriveLesson(forRules(room, facts), facts, now);
  const targets = new Set<string>();
  for (const event of facts) {
    if (event.type === OPERATION_EVENT && ["UNKNOWN", "UNCERTAIN", "IN_FLIGHT"].includes(String(event.state))) {
      for (const id of ((event.params as { targets?: string[] } | undefined)?.targets ?? [])) targets.add(String(id));
    }
  }
  for (const entry of (state.sessions ?? []) as { id: string; live?: boolean; capture?: string }[]) if (entry.live && entry.capture && entry.capture !== "NONE") targets.add(entry.id);
  const observed: { sessionId: string; live: boolean | null; recording: boolean | null }[] = [];
  const kept: ClassroomEvent[] = [];
  for (const sessionId of targets) {
    let seen: { live: boolean | null; recording: boolean | null } = { live: null, recording: null };
    try { if (provider.observe) seen = await provider.observe(room, sessionId); } catch { seen = { live: null, recording: null }; }
    observed.push({ sessionId, ...seen });
    const base = { lessonId: room.id, providerSessionId: sessionId, occurredAt: now, receivedAt: now };
    if (seen.live === false) kept.push({ source: "server", type: "server.session_verified", ended: true, ...base, key: `observed:manual:${room.id}:${sessionId}:${now}:ended` });
    if (seen.recording === true) kept.push({ source: "zoom_api", type: "session.recording_started", status: "Recording", ...base, key: `observed:manual:${room.id}:${sessionId}:${now}:recording` });
    if (seen.recording === false && seen.live !== false) kept.push({ source: "zoom_api", type: "session.recording_stopped", status: "Stopped", ...base, key: `observed:manual:${room.id}:${sessionId}:${now}:stopped` });
  }
  await serverEvents(store, [...kept, audit({ room: room.roomLabel, observed: observed.length })]);
  return answer({ observed, sent: 0 });
}

// The manager has entered the Lobby: a token for it was given to the manager (the server's own
// record), or Zoom reported them in it.
async function managerEntered(store: ClassroomStore, block: ClassroomBlock) {
  const manager = block.members.find((member) => member.role === "manager");
  const lobby = await store.lesson(block.lobbyId);
  const row = lobby?.participants.find((entry) => entry.memberId === manager?.id);
  if (!row) return false;
  return (await store.listJoinTokens(block.lobbyId)).some((token) => token.participantId === row.id);
}

// Ending or cancelling the block closes every lesson in it through the lessons' own cancellation
// (D-2): each one stops any recording on both channels and ends its sessions, with the retries and
// Zoom's confirmation that rule has; the reason says which it was.
async function closeLessons({ store, provider, drive, block, reason, now }: { store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; block: ClassroomBlock; reason: string; now: number }) {
  for (const lessonId of [block.lobbyId, ...block.roomIds]) {
    await store.setLessonCancelled(lessonId);
    await serverEvents(store, [{ source: "server", type: "server.lesson_cancelled", lessonId, reason, occurredAt: now, receivedAt: now, key: `server.lesson_cancelled:${lessonId}` }]);
    try {
      await stopRecordingForCancelledLesson({ store, provider, drive, lessonId, now });
    } catch {
      // Stored; the scheduled tick carries on.
    }
  }
}

// Where a member of the block belongs now (the student's link page and the staff's page ask this
// every few seconds), with their state (18.2). The page may say how joining went (joining or
// failed); that is kept as the page's own word, never as having joined.
// B4: how soon the page asks again. Sooner while someone is between rooms; slower when nothing is
// expected to change. A move, a recall or the end changes the block's version, which the page's
// cheap question ("since") notices at its next ask.
export const POLL_MS = { moving: 2_000, breakout: 4_000, steady: 6_000, waiting: 8_000 } as const;
const MOVING_STATES = new Set(["MOVING", "JOINING", "RETURNING", "FAILED"]);

export async function blockWhere({ store, blockId, key, sessionEmail, report, since, now }: {
  store: ClassroomStore; blockId: string; key?: string | null; sessionEmail?: string | null; report?: unknown; since?: unknown; now: number;
}) {
  // The cheap question (B4): has anything about the block changed since the version the page last
  // saw? One read; it says nothing about anyone. The page still asks fully at least every 30 s
  // (what no version marks, such as a consent lapsing, is also enforced at every door).
  if (Number.isInteger(since) && report == null) {
    const version = await store.blockVersion(blockId);
    if (version != null && version === since) return { status: 200, body: { ok: true, unchanged: true, version } };
  }
  const block = await store.block(blockId);
  if (!block) return refused(404, "BLOCK_NOT_FOUND", "Block not found");
  const member = memberOf(block, key, sessionEmail);
  if (!member) return refused(403, key ? "NOT_ON_ROSTER" : "IDENTITY_UNVERIFIED", "You are not in this block");
  if (block.cancelled) return refused(403, "BLOCK_CANCELLED", "The block is cancelled");
  if (!inBlockWindow(block, now)) return refused(403, "OUTSIDE_JOIN_WINDOW", "The block is not open now");
  // The block's lessons and all their facts in two reads; the target's join tokens in one.
  const lessons = await store.lessonsOfBlock(block.id);
  const rooms = lessons.filter((lesson) => lesson.roomKind === "room");
  const facts = await store.eventsFor(lessons.map((lesson) => lesson.id));
  const lobbyEvents = facts.filter((event) => event.lessonId === block.lobbyId);
  const target = await effectiveTarget({ store, block, rooms, member, lobbyEvents, now, facts });
  if (target.kind === "ended") return refused(403, "BLOCK_ENDED", "The block has ended");
  const page = report as { state?: unknown; lessonId?: unknown } | null;
  if (page && (page.state === "joining" || page.state === "failed") && typeof page.lessonId === "string" && page.lessonId === target.lessonId) {
    await store.transaction((tx) => tx.keepLatest({ source: "server", type: "server.member_report", lessonId: block.lobbyId, memberId: member.id, report: page.state, forLesson: page.lessonId, occurredAt: now, receivedAt: now, key: `server.member_report:${member.id}` }));
  }
  const byLesson = new Map(lessons.map((lesson) => [lesson.id, facts.filter((event) => event.lessonId === lesson.id)]));
  const tokens = new Map(target.lessonId ? [[target.lessonId, await store.listJoinTokens(target.lessonId)]] : []);
  const state = memberState({ member, target, lessons, eventsByLesson: byLesson, tokensByLesson: tokens, lobbyEvents, now });
  const phase = blockPhase(lobbyEvents).phase;
  const room = target.kind === "room" ? rooms.find((entry) => entry.id === target.lessonId) : null;
  return {
    status: 200,
    body: {
      ok: true,
      version: block.version,
      pollMs: MOVING_STATES.has(state) ? POLL_MS.moving : phase === "BREAKOUT" ? POLL_MS.breakout : target.kind === "wait" ? POLL_MS.waiting : POLL_MS.steady,
      block: { code: block.code, startsAt: block.startsAt, endsAt: block.endsAt, phase },
      member: { code: member.code, role: member.role },
      // Only where this person belongs; never another room's id or anyone's name.
      target: { kind: target.kind, lessonId: target.lessonId, label: target.label, ...(target.heldBack ? { heldBack: target.heldBack } : {}) },
      // How many hold a seat in that room (a phone shows at most 9 videos).
      ...(room ? { roomSize: room.participants.filter((entry) => entry.active !== false && (entry.seat === "assigned" || entry.seat === "visit")).length } : {}),
      state,
    },
  };
}

// A member's own choice during the breakout (18.8 step 12): back to the Lobby, or back to their room
// (which passes the same checks as any other way in).
export async function chooseInBlock({ store, blockId, key, sessionEmail, choice, now }: {
  store: ClassroomStore; blockId: string; key?: string | null; sessionEmail?: string | null; choice: unknown; now: number;
}) {
  if (choice !== "lobby" && choice !== "room") return refused(400, "INVALID_CHOICE", "Choose lobby or room");
  const block = await store.block(blockId);
  if (!block) return refused(404, "BLOCK_NOT_FOUND", "Block not found");
  const member = memberOf(block, key, sessionEmail);
  if (!member || member.role === "manager") return refused(403, member ? "NOT_FOR_MANAGER" : "NOT_ON_ROSTER", "Not possible");
  if (block.cancelled) return refused(403, "BLOCK_CANCELLED", "The block is cancelled");
  const lobbyEvents = await store.eventsFor([block.lobbyId]);
  if (blockPhase(lobbyEvents).phase !== "BREAKOUT") return refused(409, "WRONG_PHASE", "Only during the breakout");
  await serverEvents(store, [{ source: "server", type: "server.member_choice", lessonId: block.lobbyId, blockId: block.id, blockVersion: block.version, memberId: member.id, choice, occurredAt: now, receivedAt: now, key: eventKey("server.member_choice", block.id, now) }]);
  return blockWhere({ store, blockId, key, sessionEmail, now });
}

async function eventsByLesson(store: ClassroomStore, lessons: ClassroomLesson[]) {
  const events = await store.eventsFor(lessons.map((lesson) => lesson.id));
  const map = new Map<string, ClassroomEvent[]>();
  for (const lesson of lessons) map.set(lesson.id, events.filter((event) => event.lessonId === lesson.id));
  return map;
}
async function tokensByLesson(store: ClassroomStore, lessons: ClassroomLesson[]) {
  const all = await store.listJoinTokensFor(lessons.map((lesson) => lesson.id));
  return new Map(lessons.map((lesson) => [lesson.id, all.filter((token) => token.lessonId === lesson.id)]));
}

// What the block's manager (or an owner) sees (18.7): the phase and version, each person's place and
// state, and each room's people, sessions, recording state, unresolved recording actions with what
// to do about them, files and problems. English names are shown to staff only; never a link, key,
// e-mail or token.
export async function blockView({ store, blockId, now }: { store: ClassroomStore; blockId: string; now: number }) {
  const block = await store.block(blockId);
  if (!block) return null;
  const lessons = await store.lessonsOfBlock(block.id);
  const lobby = lessons.find((lesson) => lesson.id === block.lobbyId) ?? null;
  const rooms = lessons.filter((lesson) => lesson.roomKind === "room").sort((a, b) => String(a.roomLabel).localeCompare(String(b.roomLabel)));
  // B4: every fact, token and recording of the block in one read each (it was ~55 reads a refresh).
  const byLesson = await eventsByLesson(store, lessons);
  const facts = [...byLesson.values()].flat();
  const tokens = await tokensByLesson(store, lessons);
  const lobbyEvents = byLesson.get(block.lobbyId) ?? [];
  const { phase } = blockPhase(lobbyEvents);
  const mode = recordingModeOf(lobbyEvents);
  const members = [];
  for (const member of block.members) {
    const target: BlockTarget = await effectiveTarget({ store, block, rooms, member, lobbyEvents, now, facts });
    members.push({
      code: member.code, role: member.role, englishName: member.englishName,
      seat: seatOf(rooms, member, "assigned")?.room.roomLabel ?? null,
      visit: seatOf(rooms, member, "visit")?.room.roomLabel ?? null,
      target: target.label, heldBack: target.heldBack ?? null,
      state: memberState({ member, target, lessons, eventsByLesson: byLesson, tokensByLesson: tokens, lobbyEvents, now }),
      // The same link or sign-in in use on more than one device right now (alert only, H5).
      devices: lessons.reduce((sum, lesson) => sum + openConnections(lesson, byLesson.get(lesson.id) ?? [], member), 0),
      // Still in another room, by Zoom's word, longer than a move takes.
      staleIn: lessons.filter((lesson) => lesson.id !== target.lessonId).filter((lesson) => {
        const presence = presenceIn(lesson, byLesson.get(lesson.id) ?? [], member);
        return presence.state === "in" && presence.at != null && now - presence.at > STALE_PRESENCE_MS;
      }).map((lesson) => (lesson.roomKind === "lobby" ? "Lobby" : lesson.roomLabel)),
    });
  }
  const files = (await store.filings(lessons.map((lesson) => lesson.id))).map(({ record: file }) => ({ lessonId: String(file.lessonId), name: file.plannedName ?? null, status: file.status, hold: file.hold ?? null }));
  const roomCard = (lesson: ClassroomLesson) => {
    const facts = byLesson.get(lesson.id) ?? [];
    const state = deriveLesson(forRules(lesson, facts), facts, now);
    const operations = facts.filter((event) => event.type === OPERATION_EVENT).map((event) => ({
      action: event.action, state: event.state, attempts: event.attempts, since: event.since, updatedAt: event.updatedAt,
      sessions: (event.params as { targets?: string[] } | undefined)?.targets ?? [], outcome: event.outcome ?? null,
    }));
    const unresolved = operations.filter((entry) => ["UNKNOWN", "UNCERTAIN", "IN_FLIGHT"].includes(String(entry.state)));
    return {
      label: lesson.roomLabel, kind: lesson.roomKind, lessonId: lesson.id,
      capacity: lesson.roomKind === "room" ? ROOM_CAPACITY : null,
      occupied: lesson.participants.filter((entry) => entry.active !== false && (entry.seat === "assigned" || entry.seat === "visit")).length,
      people: lesson.participants.filter((entry) => entry.active !== false).map((entry) => ({ code: entry.code, role: entry.role, seat: entry.seat ?? null })),
      sessions: ((state.sessions ?? []) as { id: string; live?: boolean; generation?: number | null; capture?: string }[]).map((entry) => ({ id: entry.id, live: entry.live ?? null, generation: entry.generation ?? null, capture: entry.capture ?? null })),
      recording: {
        status: state.recording.status, basis: state.recording.basis, allowed: recordingDecision(facts).allowed,
        // Not recording because it never may (the Lobby, a Classroom Only block): said as such, not
        // as missing consent. Anything that may be recording keeps its own label.
        label: ["NOT_RECORDING", "NOT_REQUESTED"].includes(String(state.recording.status)) && (lesson.roomKind === "lobby" || mode === "classroom_only")
          ? (lesson.roomKind === "lobby" ? "主會議室永不錄影" : "Classroom Only：不錄影")
          : RECORDING_LABELS[state.recording.status] ?? state.recording.status,
      },
      operations,
      // 18.7: never skipped, never shown as stopped without Zoom, never restarted blindly.
      advice: unresolved.length ? "UNKNOWN：執行唯讀查核；需要確保不再錄影時，執行停止並結束 Session。系統不會重送開始錄影。" : null,
      files: files.filter((file) => file.lessonId === lesson.id),
      anomalies: (state.anomalies ?? []).map((entry: { code: string; severity: string }) => ({ code: entry.code, severity: entry.severity })),
    };
  };
  return {
    block: {
      id: block.id, code: block.code, startsAt: block.startsAt, endsAt: block.endsAt, cancelled: block.cancelled, phase, version: block.version,
      recordingMode: mode, recordingAvailable: multiRecordingEnabled(), capacity: ROOM_CAPACITY,
    },
    members,
    lobby: lobby ? roomCard(lobby) : null,
    rooms: rooms.map(roomCard),
  };
}

// For the manage page: whether this sign-in may run the block, and its view.
export async function blockManageView({ store, blockId, principal, now }: { store: ClassroomStore; blockId: string; principal: BlockPrincipal; now: number }) {
  const block = await store.block(blockId);
  if (!block) return refused(404, "BLOCK_NOT_FOUND", "Block not found");
  if (!managerOf(block, principal).allowed) return refused(403, "NOT_BLOCK_MANAGER", "Only this block's manager or an owner can see this");
  return { status: 200, body: { ok: true, view: await blockView({ store, blockId, now }) } };
}

// "My lessons" for staff: the blocks they are in, from a day ago to two weeks ahead.
const DAY_MS = 24 * 60 * 60 * 1000;
export async function myClassroomBlocks({ store, email, now }: { store: ClassroomStore; email: string; now: number }) {
  if (!email) return [];
  const blocks = await store.listBlocksForStaff(email, { from: now - DAY_MS, to: now + 14 * DAY_MS });
  return blocks.map((block) => {
    const member = block.members.find((entry) => isStaff(entry) && entry.staffEmail === email)!;
    return { blockId: block.id, code: block.code, startsAt: block.startsAt, endsAt: block.endsAt, cancelled: block.cancelled, role: member.role, manages: member.role === "manager" };
  });
}

export async function listClassroomBlocks({ store, now }: { store: ClassroomStore; now: number }) {
  const blocks = await store.listBlocks({ from: now - DAY_MS, to: now + 14 * DAY_MS });
  return blocks.map((block) => ({ blockId: block.id, code: block.code, startsAt: block.startsAt, endsAt: block.endsAt, cancelled: block.cancelled, rooms: block.roomIds.length, members: block.members.length, courseId: block.courseId ?? null }));
}

// 18.5 (P3-Multi): the owners' list of block recordings and where each one's filing stands,
// newest New York date first (section 9), with what may be retried. Codes and file names only.
export async function listBlockFilings({ store, now }: { store: ClassroomStore; now: number }) {
  const blocks = await store.listBlocks({ from: now - 90 * DAY_MS, to: now + DAY_MS });
  const rooms = new Map<string, { block: ClassroomBlock; lesson: ClassroomLesson }>();
  for (const block of blocks) {
    for (const id of block.roomIds) {
      const lesson = await store.lesson(id);
      if (lesson) rooms.set(id, { block, lesson });
    }
  }
  const rows = await store.filings([...rooms.keys()]);
  return rows.map(({ record, job }) => {
    const place = rooms.get(String(record.lessonId))!;
    return {
      recordingId: record.providerFileId, block: place.block.code, room: place.lesson.roomLabel, date: newYorkDate(place.lesson.startsAt),
      recordingStart: (record.recordingStart as number | null | undefined) ?? null, name: (record.plannedName as string | null | undefined) ?? null,
      status: record.status === "STORED" ? "ARCHIVED" : record.status, hold: (record.hold as string | null | undefined) ?? null,
      job, retryable: record.status === "FAILED" && !record.hold,
    };
  }).sort((a, b) => b.date.localeCompare(a.date) || (b.recordingStart ?? 0) - (a.recordingStart ?? 0) || a.recordingId.localeCompare(b.recordingId));
}

// An owner sends a failed filing back to the queue, with a reason (18.7: who, when, why). Only a
// FAILED recording of a block room that is not held: a recording held for consent, a withdrawal or
// an unknown person is never sent on this way, and one already archived is left alone. The job runs
// again under its own id, so filing it twice is impossible (the same checks, no second copy).
export async function retryBlockFiling({ store, providerFileId, actor, reason, now }: { store: ClassroomStore; providerFileId: unknown; actor: string; reason: unknown; now: number }) {
  const id = String(providerFileId ?? "");
  const why = String(reason ?? "").trim();
  if (!id) return refused(400, "RECORDING_REQUIRED", "Name the recording");
  if (why.length < 3 || why.length > 300) return refused(400, "REASON_REQUIRED", "Say why (3–300 characters)");
  const record = await store.fileRecord(id);
  const lesson = record?.lessonId ? await store.lesson(String(record.lessonId)) : null;
  if (!record || !lesson?.blockId) return refused(404, "NOT_FOUND", "No such recording in a block");
  const result = await store.requeueFiling({
    providerFileId: id, now,
    events: [{ source: "server", type: "p1.filing_retry", lessonId: lesson.id, providerFileId: id, actor, reason: why, occurredAt: now, receivedAt: now, key: `p1.filing_retry:${id}:${now}:${randomUUID()}` }],
  });
  if (!result.ok) return refused(result.reason === "NOT_FOUND" ? 404 : 409, result.reason, result.reason === "HELD" ? "A held recording is never filed this way" : result.reason === "ALREADY_ARCHIVED" ? "Already archived" : "Only a failed filing can be retried");
  return { status: 200, body: { ok: true, requeued: id } };
}
