import { createHash } from "node:crypto";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { JOIN_WINDOW_AFTER_MS, JOIN_WINDOW_BEFORE_MS } from "../tools/recording-pathway/classroom/eligibility.mjs";
import type { ClassroomBlock, ClassroomBlockMember, ClassroomEvent, ClassroomJoinToken, ClassroomLesson, ClassroomParticipant } from "./classroom-store";
import { multiRecordingEnabled } from "./classroom-switches";

// P3-Multi (2026-11-09): the rules of a block (班次) that the server applies at every door. They
// only read: the block, its rooms (lessons), the Lobby's facts and the join tokens. Every answer
// the browser gets (where to go, whether a token is given) is decided here, never from anything
// the page sends but the person's own key or sign-in.
//
// A block's own facts (its phase, seat changes, a member's choice, link changes, the recording
// mode) are stored as events of its Lobby.

export const ROOM_CAPACITY = 10;
export const MAX_ROOMS = 12;
export const MAX_MEMBERS = 80;
export const BLOCK_PHASES = ["SETUP", "LOBBY_OPEN", "BREAKOUT", "RECALLED", "ENDED"] as const;
export type BlockPhase = (typeof BLOCK_PHASES)[number];
export type RecordingMode = "classroom_only" | "classroom_recording";
// Where a member belongs now. "wait": the Lobby is not open yet; "ended"/"cancelled": nowhere.
export type BlockTarget = {
  kind: "wait" | "lobby" | "room" | "ended" | "cancelled";
  lessonId: string | null;
  label: string | null;
  // Why the member is in the Lobby rather than its room (a recording room it may not enter).
  heldBack?: string;
};
// 18.2: each member's state, from the server's facts only (a page's own word only ever adds
// JOINING or FAILED, never JOINED).
export const MEMBER_STATES = ["ASSIGNED", "WAITING", "MOVING", "JOINING", "JOINED", "RETURNING", "FAILED", "DISCONNECTED", "REVOKED"] as const;
export type MemberState = (typeof MEMBER_STATES)[number];

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const STAFF_ROLES = new Set(["manager", "lead_tutor", "co_tutor", "observer"]);
export const isStaff = (member: ClassroomBlockMember) => STAFF_ROLES.has(member.role);

// A block's own facts are ordered by the block version they belong to (every change raises it by
// one, atomically), so two changes in the same millisecond still have one order; then by time.
const versionOf = (event: ClassroomEvent) => (Number.isInteger(event.blockVersion) ? Number(event.blockVersion) : -1);
const byTime = (a: ClassroomEvent, b: ClassroomEvent) => versionOf(a) - versionOf(b) || a.occurredAt - b.occurredAt || String(a.key).localeCompare(String(b.key));
const latest = (events: ClassroomEvent[], test: (event: ClassroomEvent) => boolean) => events.filter(test).sort(byTime).pop() ?? null;

export function blockPhase(lobbyEvents: ClassroomEvent[]): { phase: BlockPhase; at: number | null; version: number } {
  const last = latest(lobbyEvents, (event) => event.type === "server.block_phase");
  return last ? { phase: last.phase as BlockPhase, at: last.occurredAt, version: versionOf(last) } : { phase: "SETUP", at: null, version: -1 };
}

// 18.6: a block records only when recording in blocks is on for the site and an owner switched
// this block to Classroom + Recording; it starts Classroom Only. The mode is written to each room
// too (server.recording_mode), so a room's own facts say whether it may record.
export function recordingModeOf(events: ClassroomEvent[]): RecordingMode {
  const last = latest(events, (event) => event.type === "server.recording_mode");
  return last?.mode === "classroom_recording" ? "classroom_recording" : "classroom_only";
}
export function roomMayRecordByMode(lesson: ClassroomLesson, roomEvents: ClassroomEvent[]) {
  return lesson.roomKind === "room" && multiRecordingEnabled() && recordingModeOf(roomEvents) === "classroom_recording";
}

// The person behind a request: a student by the personal link (its hash), staff by sign-in. A
// key, when given, decides; a signed-in student's e-mail never makes them staff.
export function memberOf(block: ClassroomBlock, key: string | null | undefined, email: string | null | undefined) {
  if (key) return block.members.find((member) => member.role === "student" && member.joinKeyHash === hashKey(key)) ?? null;
  if (email) return block.members.find((member) => isStaff(member) && member.staffEmail === email) ?? null;
  return null;
}

export function inBlockWindow(block: ClassroomBlock, now: number) {
  return now >= Date.parse(block.startsAt) - JOIN_WINDOW_BEFORE_MS && now <= Date.parse(block.endsAt) + JOIN_WINDOW_AFTER_MS;
}

export const seatOf = (rooms: ClassroomLesson[], member: ClassroomBlockMember, seat: "assigned" | "visit") => {
  for (const room of rooms) {
    if (room.roomKind !== "room") continue;
    const row = room.participants.find((entry) => entry.memberId === member.id && entry.active !== false && entry.seat === seat);
    if (row) return { room, row };
  }
  return null;
};
export const rowIn = (lesson: ClassroomLesson, member: ClassroomBlockMember): ClassroomParticipant | null =>
  lesson.participants.find((entry) => entry.memberId === member.id && entry.active !== false) ?? null;

// The member's own choice during breakout (18.8: a student may go back to the Lobby), counted only
// when made on the block as it was after the breakout began and after the member's last seat change
// (a choice records the block version it saw).
function choiceOf(lobbyEvents: ClassroomEvent[], member: ClassroomBlockMember, since: number) {
  const choice = latest(lobbyEvents, (event) => event.type === "server.member_choice" && event.memberId === member.id);
  const seatChange = latest(lobbyEvents, (event) => event.type === "server.seat_changed" && event.memberId === member.id);
  if (!choice || versionOf(choice) < since || (seatChange && versionOf(seatChange) > versionOf(choice))) return null;
  return String(choice.choice);
}

// Where the member belongs now: the server's answer, from the block's phase and the member's seats.
//   manager: the Lobby (first in, 18.1), or the room it is visiting during breakout
//   others:  nowhere until the Lobby opens; the Lobby; during breakout its visiting seat, else its
//            assigned room (unless it chose the Lobby), else the Lobby
export function targetOf({ block, rooms, member, lobbyEvents }: { block: ClassroomBlock; rooms: ClassroomLesson[]; member: ClassroomBlockMember; lobbyEvents: ClassroomEvent[] }): BlockTarget {
  if (block.cancelled) return { kind: "cancelled", lessonId: null, label: null };
  const { phase, version: phaseVersion } = blockPhase(lobbyEvents);
  if (phase === "ENDED") return { kind: "ended", lessonId: null, label: null };
  const lobby: BlockTarget = { kind: "lobby", lessonId: block.lobbyId, label: "Lobby" };
  const room = (entry: { room: ClassroomLesson } | null): BlockTarget | null => entry ? { kind: "room", lessonId: entry.room.id, label: entry.room.roomLabel ?? null } : null;
  if (member.role === "manager") return phase === "BREAKOUT" ? room(seatOf(rooms, member, "visit")) ?? lobby : lobby;
  if (phase === "SETUP") return { kind: "wait", lessonId: null, label: null };
  if (phase !== "BREAKOUT") return lobby;
  const visiting = room(seatOf(rooms, member, "visit"));
  if (visiting) return visiting;
  if (choiceOf(lobbyEvents, member, phaseVersion) === "lobby") return lobby;
  return room(seatOf(rooms, member, "assigned")) ?? lobby;
}

// Presence in each of the block's lessons from the room's facts: in, out (it was in and left), or
// never. Zoom's word (webhook, API) or the host page's report of a user; a page's own report never.
const IN = new Set(["session.user_joined", "host.user_added"]);
const OUT = new Set(["session.user_left", "host.user_removed"]);
export function presenceIn(lesson: ClassroomLesson, events: ClassroomEvent[], member: ClassroomBlockMember) {
  const ids = new Set(lesson.participants.filter((entry) => entry.memberId === member.id).map((entry) => entry.id));
  const facts = events.filter((event) => event.lessonId === lesson.id && (IN.has(String(event.type)) || OUT.has(String(event.type))) && ids.has(String(event.participantId))).sort(byTime);
  const last = facts.at(-1);
  if (!last) return { state: "never" as const, at: null };
  return { state: IN.has(String(last.type)) ? ("in" as const) : ("out" as const), at: last.occurredAt };
}

// 18.2 state machine, worked out from what the server knows (never from a page saying it joined):
//   REVOKED       the personal link was revoked and not given again
//   WAITING       in the Lobby (confirmed), or due there and never joined yet
//   JOINED        confirmed in the room it is due in
//   MOVING        confirmed in another room than the one it is due in
//   RETURNING     confirmed in a room while due in the Lobby
//   JOINING       a token for where it is due was given out lately, not confirmed there yet
//   FAILED        its page reported that joining failed, after that token
//   DISCONNECTED  was in, left, and is not in where it is due
//   ASSIGNED      has a room, has not joined anything yet
// A member confirmed in two rooms at once is JOINED in neither but MOVING: only the room it is
// due in can make it JOINED.
export const JOINING_FOR_MS = 2 * 60_000;
export function memberState({ member, target, lessons, eventsByLesson, tokensByLesson, lobbyEvents, now }: {
  member: ClassroomBlockMember; target: BlockTarget; lessons: ClassroomLesson[]; eventsByLesson: Map<string, ClassroomEvent[]>;
  tokensByLesson: Map<string, ClassroomJoinToken[]>; lobbyEvents: ClassroomEvent[]; now: number;
}): MemberState {
  const link = latest(lobbyEvents, (event) => event.type === "server.member_link" && event.memberId === member.id);
  if (member.role === "student" && link?.action === "revoked") return "REVOKED";
  const presence = lessons.map((lesson) => ({ lesson, ...presenceIn(lesson, eventsByLesson.get(lesson.id) ?? [], member) }));
  const due = target.lessonId ? presence.find((entry) => entry.lesson.id === target.lessonId) : null;
  const elsewhere = presence.filter((entry) => entry.state === "in" && entry.lesson.id !== target.lessonId);
  const dueIsLobby = target.kind === "lobby";
  if (due?.state === "in" && !elsewhere.length) return dueIsLobby ? "WAITING" : "JOINED";
  if (elsewhere.length) return dueIsLobby ? "RETURNING" : "MOVING";
  if (target.lessonId) {
    const row = lessons.find((lesson) => lesson.id === target.lessonId)?.participants.filter((entry) => entry.memberId === member.id).map((entry) => entry.id) ?? [];
    const token = (tokensByLesson.get(target.lessonId) ?? []).filter((entry) => row.includes(entry.participantId)).sort((a, b) => a.issuedAt - b.issuedAt).pop();
    const report = latest(lobbyEvents, (event) => event.type === "server.member_report" && event.memberId === member.id && event.forLesson === target.lessonId);
    if (token && report?.report === "failed" && report.occurredAt >= token.issuedAt) return "FAILED";
    if (token && now - token.issuedAt <= JOINING_FOR_MS) return "JOINING";
  }
  if (presence.some((entry) => entry.state === "out")) return "DISCONNECTED";
  const assigned = lessons.some((lesson) => lesson.roomKind === "room" && lesson.participants.some((entry) => entry.memberId === member.id && entry.active !== false && entry.seat === "assigned"));
  return assigned && !dueIsLobby ? "ASSIGNED" : "WAITING";
}

// The America/New_York calendar date of a moment (18.3): Intl's time zone data, so EST and EDT,
// the day boundary and the DST change are all handled; never a fixed offset from Taipei.
const NEW_YORK = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export function newYorkDate(at: string | number) {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
