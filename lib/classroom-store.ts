import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import { claimFor, finishFor, operationEvent, operationKey } from "../tools/recording-pathway/classroom/operations.mjs";

// Storage for the P3 classroom: lessons and their participants (codes only), recording consent
// (synthetic until the policy is approved), the event log the live overview is derived from,
// leased jobs, recording files and persisted anomaly records.
//
// The shared classroom logic in tools/recording-pathway/classroom relies on these guarantees:
// a transaction is all or nothing, event keys and job ids are unique, a job is claimed under a
// lease, and writes that finish a job only succeed with the current lease number (fencing).
// PostgreSQL provides them with constraints and row locks; the file store, used locally and in
// tests, provides them by running every operation one at a time.

// observer (P3-Multi, 2026-11-09): staff in a block's room who is not its host (a manager or an
// observer on a visit, a lead or co-tutor in the Lobby). One-to-one lessons never have one.
export type ClassroomRole = "tutor" | "student" | "observer";
export type ClassroomParticipant = {
  id: string;
  code: string;
  role: ClassroomRole;
  staffEmail?: string | null;
  joinKeyHash?: string | null;
  // P3-Multi: the block member this room seat belongs to; who it is lives on the member (no
  // e-mail or key here). active: false once the member left this room (moved, visit over, link
  // revoked); the row stays so the room's facts about that id are never someone unknown.
  memberId?: string | null;
  active?: boolean;
  seat?: "lobby" | "assigned" | "visit" | null;
};
export type ClassroomLesson = {
  id: string;
  code: string;
  date: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  createdBy: string;
  createdAt: string;
  participants: ClassroomParticipant[];
  // P3-Multi: a block's Lobby or one of its teaching rooms (each its own Zoom session); absent for
  // one-to-one lessons.
  blockId?: string | null;
  roomKind?: "lobby" | "room" | null;
  roomLabel?: string | null;
};

// P3-Multi (2026-11-09): a block (班次) is one Lobby and several teaching rooms. Its members are
// the people in it: one manager, lead and co-tutors, observers and students. Staff sign in with
// their e-mail; a student enters with a personal link (only its hash is kept). The English name
// is for Drive's file names only.
export type BlockRole = "manager" | "lead_tutor" | "co_tutor" | "observer" | "student";
export type ClassroomBlockMember = {
  id: string;
  code: string;
  role: BlockRole;
  englishName: string;
  staffEmail: string | null;
  joinKeyHash: string | null;
};
export type ClassroomBlock = {
  id: string;
  code: string;
  date: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  createdBy: string;
  createdAt: string;
  lobbyId: string;
  roomIds: string[];
  members: ClassroomBlockMember[];
  // Goes up by one with every change; a manager's change names the version it was made on.
  version: number;
};
// A seat change in one step: a member takes an assigned or a visiting seat in a room (giving up
// the one of that kind it had in another room), or gives it up (roomId null). The room holds at
// most `capacity` active seats of both kinds together, whatever arrives at once.
export type SeatChange = {
  blockId: string;
  memberId: string;
  roomId: string | null;
  seat: "assigned" | "visit";
  participant?: { id: string; code: string; role: ClassroomRole };
  capacity: number;
  events: ClassroomEvent[];
};
export type SeatResult =
  | { ok: true; changed: boolean; participantId: string | null; releasedFrom: string | null }
  | { ok: false; reason: "ROOM_FULL" | "NOT_A_ROOM" | "NO_SUCH_MEMBER" | "BLOCK_NOT_FOUND" };
export type ClassroomConsent = {
  personCode: string;
  status: "granted" | "withdrawn";
  version: string;
  grantedAt: number | null;
  withdrawnAt: number | null;
  expiresAt: number | null;
  synthetic: boolean;
  recordedBy: string;
};
export type ClassroomStaffNotice = { personCode: string; version: string; acknowledgedAt: number; recordedBy: string };
export type ClassroomJoinToken = { tokenHash: string; lessonId: string; participantId: string; issuedAt: number; expiresAt: number };
export type ClassroomEvent = Record<string, unknown> & {
  key: string;
  type: string;
  source: string;
  lessonId?: string | null;
  occurredAt: number;
  receivedAt?: number;
};
export type ClassroomJob = {
  id: string;
  type: "file_recording" | "delete_vendor_copy";
  lessonId: string | null;
  providerFileId: string | null;
  status: "pending" | "running" | "done" | "dead";
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: number;
  leaseVersion: number;
  availableAt: number;
  error?: string | null;
  // Why the job is paused (Drive full, access revoked...), or null.
  blockedReason?: string | null;
};
export type RecordingFile = Record<string, unknown> & {
  providerFileId: string;
  lessonId: string | null;
  status: "PENDING" | "SKIPPED" | "HOLD" | "STORED" | "QUARANTINED" | "FAILED";
  driveFileId?: string | null;
  uploadSessionUri?: string | null;
  uploadedBytes?: number;
};
export type ClassroomAnomaly = {
  lessonId: string;
  code: string;
  severity: "error" | "warning";
  firstSeenAt: number;
  // The start of the current occurrence; handling only counts when it came after this.
  openedAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  note: string | null;
};
export type ActiveAnomaly = { code: string; severity: "error" | "warning" };

type JobInput = { id: string; type: ClassroomJob["type"]; lessonId?: string | null; providerFileId?: string | null; availableAt?: number };
type GiveUp = { fileChanges?: Partial<RecordingFile>; events?: ClassroomEvent[] };

export type ClassroomTransaction = {
  insertEvent(event: ClassroomEvent): Promise<boolean>;
  keepLatest(event: ClassroomEvent): Promise<boolean>;
  insertJob(job: JobInput): Promise<boolean>;
  insertFileRecord(record: RecordingFile): Promise<boolean>;
  updateFileRecord(id: string, changes: Partial<RecordingFile>): Promise<void>;
  lesson(id: string): Promise<ClassroomLesson | null>;
  fileRecord(id: string): Promise<RecordingFile | null>;
  fileRecordsForLesson(id: string): Promise<RecordingFile[]>;
  // The latest recording decision; with a generation, the latest made for that generation of the
  // room (0 is the lesson's own decision, made before it started); with `before`, the latest made
  // at or before that moment (consent never reaches back to a recording that started earlier).
  eligibility(id: string, generation?: number, before?: number): Promise<ClassroomEvent | null>;
  withdrawalAt(id: string): Promise<number | null>;
  unknownJoinAt(id: string): Promise<number | null>;
  // P3-Multi: a room's block (its code and members) and the room's facts, for naming its
  // recordings and keeping each one's participant snapshot (18.4).
  block(id: string): Promise<ClassroomBlock | null>;
  eventsOf(lessonId: string): Promise<ClassroomEvent[]>;
  // 18.4: each person's own consent or notice, kept as evidence with each recording.
  consents(codes: string[]): Promise<ClassroomConsent[]>;
  notices(codes: string[]): Promise<ClassroomStaffNotice[]>;
};

export type OperationState = "IN_FLIGHT" | "UNCERTAIN" | "UNKNOWN" | "NOT_EXECUTED" | "DONE";
export type OperationClaimInput = {
  operation: string; lessonId: string; action?: string; params?: Record<string, unknown> | null;
  owner: string; now: number; leaseMs?: number; unknownRetryMs?: number;
};
export type OperationClaim =
  | { acquired: false; state: OperationState | null }
  | { acquired: true; version: number; previous: OperationState | null; since: number; action: string; params: Record<string, unknown> };

export type ClassroomStore = {
  kind: "postgres" | "file";
  transaction<T>(fn: (tx: ClassroomTransaction) => Promise<T>): Promise<T>;
  claimJob(input: { workerId: string; now: number; leaseMs: number }): Promise<{ job: ClassroomJob; leaseVersion: number } | null>;
  failJob(input: { jobId: string; leaseVersion: number; now: number; error: string; maxAttempts: number; retryAfterMs?: number; giveUp?: GiveUp }): Promise<boolean>;
  rescheduleJob(input: { jobId: string; leaseVersion: number; availableAt: number; refundAttempt?: boolean; blockedReason?: string | null; error?: string | null; events?: ClassroomEvent[] }): Promise<boolean>;
  completeJob(input: { jobId: string; leaseVersion: number }): Promise<boolean>;
  recordTransfer(input: { jobId: string; leaseVersion: number; providerFileId: string; uri: string | null; uploadedBytes: number; now: number; leaseMs: number; events?: ClassroomEvent[] }): Promise<boolean>;
  finishFiling(input: { jobId: string; leaseVersion: number; providerFileId: string; changes: Partial<RecordingFile>; events?: ClassroomEvent[]; jobs?: JobInput[] }): Promise<boolean>;
  fileRecord(id: string): Promise<RecordingFile | null>;
  lesson(id: string): Promise<ClassroomLesson | null>;
  withdrawalAt(id: string): Promise<number | null>;
  unknownJoinAt(id: string): Promise<number | null>;
  eventsFor(lessonIds: string[]): Promise<ClassroomEvent[]>;
  // Lessons with a recording still on its way to Drive (pending, running or blocked).
  listOpenFilingLessonIds(): Promise<string[]>;
  createLesson(lesson: ClassroomLesson): Promise<void>;
  listLessons(window: { from: number; to: number }): Promise<ClassroomLesson[]>;
  // The lessons whose tutor signs in with this (lower-case) email, overlapping the window.
  listLessonsForStaff(email: string, window: { from: number; to: number }): Promise<ClassroomLesson[]>;
  // Owners' changes to who can enter: false when there is no such lesson (or student row).
  setLessonCancelled(id: string): Promise<boolean>;
  replaceStudentKeyHash(lessonId: string, participantId: string, keyHash: string): Promise<boolean>;
  // D-4: a revoked or reissued link gives the student a new participant id. The id and key
  // change and the change's facts are stored (the rotation and the room's new generation), all in
  // one step or not at all: false, with nothing changed, when the student no longer has `fromId`
  // (another change came first) or any of the facts is already stored (another change took that
  // generation).
  rotateStudent(lessonId: string, fromId: string, toId: string, keyHash: string, events: ClassroomEvent[]): Promise<boolean>;
  // G1: a recording action (start, stop, end) is carried out by one executor at a time. Its state
  // (op:<action key>) is claimed and finished each in one atomic step; see operations.mjs.
  claimOperation(input: OperationClaimInput): Promise<OperationClaim>;
  // Only while the caller still holds the claim (its version, still IN_FLIGHT); the events (the
  // action's facts) are stored in the same step. False: fenced out, nothing changed.
  finishOperation(input: { operation: string; version: number; state: OperationState; outcome?: Record<string, unknown>; now: number; events?: ClassroomEvent[] }): Promise<boolean>;
  listConsents(codes: string[]): Promise<ClassroomConsent[]>;
  setConsent(consent: ClassroomConsent): Promise<void>;
  listStaffNotices(codes: string[]): Promise<ClassroomStaffNotice[]>;
  setStaffNotice(notice: ClassroomStaffNotice): Promise<void>;
  recordJoinToken(token: ClassroomJoinToken): Promise<void>;
  listJoinTokens(lessonId: string): Promise<ClassroomJoinToken[]>;
  // The join tokens of several lessons in one read (a block's console, B4).
  listJoinTokensFor(lessonIds: string[]): Promise<ClassroomJoinToken[]>;
  syncAnomalies(lessonId: string, active: ActiveAnomaly[], now: number): Promise<void>;
  listAnomalies(lessonIds: string[]): Promise<ClassroomAnomaly[]>;
  acknowledgeAnomaly(input: { lessonId: string; code: string; actor: string; note: string; now: number }): Promise<ClassroomAnomaly | null>;
  // P3-Multi (2026-11-09). A block with its Lobby and rooms (lessons) and their seats, all in one
  // step or none (a code already taken: ClassroomLessonConflictError).
  createBlock(block: ClassroomBlock, lessons: ClassroomLesson[]): Promise<void>;
  block(id: string): Promise<ClassroomBlock | null>;
  // A block's Lobby and rooms in one read (two queries), and its version alone (one): the doors and
  // the members' "where" answers ask these often (P3-Multi, B4).
  lessonsOfBlock(id: string): Promise<ClassroomLesson[]>;
  blockVersion(id: string): Promise<number | null>;
  listBlocks(window: { from: number; to: number }): Promise<ClassroomBlock[]>;
  // The blocks where this (lower-case) e-mail is a staff member, overlapping the window.
  listBlocksForStaff(email: string, window: { from: number; to: number }): Promise<ClassroomBlock[]>;
  // Every change to a block, one at a time per block (PostgreSQL: the block's row locked) and in
  // one step or not at all: with expectedVersion, only if the block is still at that version (two
  // managers acting at once: the later one is refused as stale, 18.1/18.2); then at most one seat
  // change (a room never holds more than its capacity), a link replaced (with every room row of
  // that student rotated, D-4 style), the block and its lessons cancelled, and the facts. The
  // block's version goes up by one.
  changeBlock(change: BlockChange): Promise<BlockChangeResult>;
  // 18.5 (P3-Multi): the recordings of these lessons with their filing job, for the owners' list.
  filings(lessonIds: string[]): Promise<FilingRow[]>;
  // An owner's retry of a failed filing, in one step: only a FAILED recording that is not held
  // (never one held for consent, withdrawal or an unknown person) gets its job back in the queue,
  // with the facts stored; anything else changes nothing. Two retries at once: one is made.
  requeueFiling(input: { providerFileId: string; now: number; events: ClassroomEvent[] }): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" | "ALREADY_ARCHIVED" | "HELD" | "NOT_FAILED" }>;
};
export type FilingRow = { record: RecordingFile; job: { status: string; attempts: number; error: string | null; blockedReason: string | null } | null };
export type BlockChange = {
  blockId: string;
  expectedVersion?: number | null;
  seat?: Omit<SeatChange, "blockId" | "events">;
  rotate?: { memberId: string; keyHash: string; rotations: MemberRotation[] };
  cancel?: boolean;
  events: ClassroomEvent[];
};
export type BlockChangeResult =
  | { ok: true; version: number; seat?: SeatResult & { ok: true } }
  | { ok: false; reason: "BLOCK_NOT_FOUND" | "STALE_VERSION" | "CHANGED_CONCURRENTLY" | "ROOM_FULL" | "NOT_A_ROOM" | "NO_SUCH_MEMBER"; version?: number };

export class ClassroomLessonConflictError extends Error {}

const FINAL_FILE_STATUSES = ["STORED", "QUARANTINED", "HOLD", "FAILED"];
// Protection starts at the earliest of these (withdrawalAt): consent withdrawn, an
// administrator's emergency stop, or the lesson cancelled. A recording that runs past it stays
// with the vendor and is never filed; one that ended before it is filed into _待確認 only.
const PROTECTIVE_STOPS = ["server.consent_withdrawn", "server.emergency_stop", "server.lesson_cancelled"];
// Never before Retry-After, when the service gave one.
const backoffMs = (attempts: number, retryAfterMs = 0) => Math.max(retryAfterMs, Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1)));
const clone = <T>(value: T): T => structuredClone(value);

function newJob(job: JobInput): ClassroomJob {
  return {
    id: job.id,
    type: job.type,
    lessonId: job.lessonId ?? null,
    providerFileId: job.providerFileId ?? null,
    status: "pending",
    attempts: 0,
    leaseOwner: null,
    leaseUntil: 0,
    leaseVersion: 0,
    availableAt: job.availableAt ?? 0,
    error: null,
    blockedReason: null,
  };
}

// P3-Multi (2026-11-09): what one seat change does, worked out from the block and its rooms as they
// are now, the same for both stores: the seat of this kind the member gives up (in another room),
// the one it takes (a new row, or its earlier row in that room made active again), and the answer.
// A room holds at most `capacity` active assigned and visiting seats together.
type SeatPlan = {
  result: SeatResult;
  release?: { lessonId: string; participantId: string };
  take?: { lessonId: string; participant: ClassroomParticipant; existing: boolean };
};
export function planSeat(block: ClassroomBlock | null, rooms: ClassroomLesson[], change: SeatChange): SeatPlan {
  if (!block) return { result: { ok: false, reason: "BLOCK_NOT_FOUND" } };
  const member = block.members.find((entry) => entry.id === change.memberId);
  if (!member) return { result: { ok: false, reason: "NO_SUCH_MEMBER" } };
  const held = rooms.flatMap((room) => room.participants
    .filter((entry) => entry.memberId === member.id && entry.active !== false && entry.seat === change.seat)
    .map((entry) => ({ lessonId: room.id, participantId: entry.id })))[0] ?? null;
  if (change.roomId == null) {
    return { result: { ok: true, changed: Boolean(held), participantId: null, releasedFrom: held?.lessonId ?? null }, ...(held ? { release: held } : {}) };
  }
  const target = rooms.find((room) => room.id === change.roomId && room.roomKind === "room" && room.blockId === block.id);
  if (!target) return { result: { ok: false, reason: "NOT_A_ROOM" } };
  if (held?.lessonId === target.id) return { result: { ok: true, changed: false, participantId: held.participantId, releasedFrom: null } };
  const occupied = target.participants.filter((entry) => entry.active !== false && (entry.seat === "assigned" || entry.seat === "visit")).length;
  if (occupied >= change.capacity) return { result: { ok: false, reason: "ROOM_FULL" } };
  const existing = target.participants.find((entry) => entry.memberId === member.id);
  const role = change.participant?.role ?? existing?.role ?? "student";
  const participant: ClassroomParticipant = existing
    ? { ...existing, role, seat: change.seat, active: true }
    : { id: change.participant?.id ?? "", code: change.participant?.code ?? member.code, role, staffEmail: null, joinKeyHash: null, memberId: member.id, seat: change.seat, active: true };
  if (!participant.id) return { result: { ok: false, reason: "NO_SUCH_MEMBER" } };
  return {
    result: { ok: true, changed: true, participantId: participant.id, releasedFrom: held?.lessonId ?? null },
    ...(held ? { release: held } : {}),
    take: { lessonId: target.id, participant, existing: Boolean(existing) },
  };
}

// A student's link replaced: each of the member's room rows gets a new participant id (as D-4
// does in a one-to-one lesson, so after the change the old id is someone who should not be
// there), and its assigned or visiting seats are given up; the Lobby row stays active.
export type MemberRotation = { lessonId: string; fromId: string; toId: string };

// One block change worked out against the block as it is now, the same for both stores: refused
// as a whole (stale version, a full room, a row another change already moved), or what to write.
type BlockPlan =
  | { ok: false; result: BlockChangeResult & { ok: false } }
  | { ok: true; seat?: SeatPlan & { result: SeatResult & { ok: true } }; rotations?: (MemberRotation & { deactivate: boolean })[] };
export function planBlockChange(block: ClassroomBlock | null, rooms: ClassroomLesson[], change: BlockChange): BlockPlan {
  const fail = (reason: (BlockChangeResult & { ok: false })["reason"]) => ({ ok: false as const, result: { ok: false as const, reason, ...(block ? { version: block.version } : {}) } });
  if (!block) return fail("BLOCK_NOT_FOUND");
  if (change.expectedVersion != null && change.expectedVersion !== block.version) return fail("STALE_VERSION");
  let seat: (SeatPlan & { result: SeatResult & { ok: true } }) | undefined;
  if (change.seat) {
    const planned = planSeat(block, rooms, { ...change.seat, blockId: block.id, events: [] });
    if (!planned.result.ok) return fail(planned.result.reason);
    seat = planned as SeatPlan & { result: SeatResult & { ok: true } };
  }
  let rotations: (MemberRotation & { deactivate: boolean })[] | undefined;
  if (change.rotate) {
    const member = block.members.find((entry) => entry.id === change.rotate!.memberId && entry.role === "student");
    if (!member) return fail("NO_SUCH_MEMBER");
    const rows = rooms.flatMap((room) => room.participants.filter((entry) => entry.memberId === member.id).map((entry) => `${room.id}:${entry.id}`));
    const named = change.rotate.rotations.map((entry) => `${entry.lessonId}:${entry.fromId}`);
    // Every row of the student, exactly as it is now: else another change came first.
    if (rows.length !== named.length || named.some((entry) => !rows.includes(entry))) return fail("CHANGED_CONCURRENTLY");
    if (change.rotate.rotations.some((entry) => rooms.some((room) => room.participants.some((row) => row.id === entry.toId)))) return fail("CHANGED_CONCURRENTLY");
    rotations = change.rotate.rotations.map((entry) => ({ ...entry, deactivate: rooms.find((room) => room.id === entry.lessonId)?.roomKind === "room" }));
  }
  return { ok: true, ...(seat ? { seat } : {}), ...(rotations ? { rotations } : {}) };
}

// File store -----------------------------------------------------------------------------

type FileState = {
  lessons: ClassroomLesson[];
  consents: ClassroomConsent[];
  notices: ClassroomStaffNotice[];
  tokens: ClassroomJoinToken[];
  events: Record<string, ClassroomEvent>;
  jobs: Record<string, ClassroomJob>;
  files: Record<string, RecordingFile>;
  anomalies: ClassroomAnomaly[];
  blocks: ClassroomBlock[];
};

const emptyState = (): FileState => ({ lessons: [], consents: [], notices: [], tokens: [], events: {}, jobs: {}, files: {}, anomalies: [], blocks: [] });

function readers(state: FileState) {
  const lesson = (id: string) => clone(state.lessons.find((item) => item.id === id) ?? null);
  const earliest = (lessonId: string, test: (event: ClassroomEvent) => boolean) => {
    const times = Object.values(state.events).filter((event) => event.lessonId === lessonId && test(event)).map((event) => event.occurredAt);
    return times.length ? Math.min(...times) : null;
  };
  return {
    lesson,
    fileRecord: (id: string) => clone(state.files[id] ?? null),
    fileRecordsForLesson: (id: string) => clone(Object.values(state.files).filter((file) => file.lessonId === id)),
    eligibility: (id: string, generation?: number, before?: number) => clone(Object.values(state.events)
      .filter((event) => event.lessonId === id && event.type === "server.recording_eligibility"
        && (generation === undefined || (Number(event.generation) || 0) === generation)
        && (before === undefined || event.occurredAt <= before))
      .sort((a, b) => a.occurredAt - b.occurredAt).pop() ?? null),
    block: (id: string) => clone(state.blocks.find((item) => item.id === id) ?? null),
    withdrawalAt: (id: string) => earliest(id, (event) => PROTECTIVE_STOPS.includes(String(event.type))),
    // Someone who was never on the roster: an id a revoke or reissue took away still counts as
    // the student for joins up to that change (D-4), as the lesson's own state reads it.
    unknownJoinAt: (id: string) => {
      const roster = new Set((state.lessons.find((item) => item.id === id)?.participants ?? []).map((entry) => entry.id));
      const rotatedAt = new Map(Object.values(state.events)
        .filter((event) => event.lessonId === id && event.type === "server.participant_rotated")
        .map((event) => [String(event.from), event.occurredAt]));
      return earliest(id, (event) => {
        if (event.type !== "session.user_joined" && event.type !== "host.user_added") return false;
        const participantId = String(event.participantId);
        if (roster.has(participantId)) return false;
        const until = rotatedAt.get(participantId);
        return !(until !== undefined && event.occurredAt <= until);
      });
    },
  };
}

function fileTransaction(state: FileState): ClassroomTransaction {
  const read = readers(state);
  return {
    async insertEvent(event) {
      if (state.events[event.key]) return false;
      state.events[event.key] = clone(event);
      return true;
    },
    async keepLatest(event) {
      const kept = state.events[event.key];
      if (kept && kept.occurredAt >= event.occurredAt) return false;
      state.events[event.key] = clone(event);
      return true;
    },
    async insertJob(job) {
      if (state.jobs[job.id]) return false;
      state.jobs[job.id] = newJob(job);
      return true;
    },
    async insertFileRecord(record) {
      if (state.files[record.providerFileId]) return false;
      state.files[record.providerFileId] = clone(record);
      return true;
    },
    async updateFileRecord(id, changes) {
      Object.assign(state.files[id], clone(changes));
    },
    lesson: async (id) => read.lesson(id),
    fileRecord: async (id) => read.fileRecord(id),
    fileRecordsForLesson: async (id) => read.fileRecordsForLesson(id),
    eligibility: async (id, generation, before) => read.eligibility(id, generation, before),
    withdrawalAt: async (id) => read.withdrawalAt(id),
    unknownJoinAt: async (id) => read.unknownJoinAt(id),
    block: async (id) => read.block(id),
    eventsOf: async (lessonId) => clone(Object.values(state.events).filter((event) => event.lessonId === lessonId)),
    consents: async (codes) => clone(state.consents.filter((item) => codes.includes(item.personCode))),
    notices: async (codes) => clone(state.notices.filter((item) => codes.includes(item.personCode))),
  };
}

export function createFileClassroomStore(filePath: string): ClassroomStore {
  let queue: Promise<unknown> = Promise.resolve();
  async function load(): Promise<FileState> {
    try {
      return { ...emptyState(), ...(JSON.parse(await readFile(filePath, "utf8")) as Partial<FileState>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }
  // Every operation reads, changes and writes the whole file in turn; a failure writes nothing.
  function run<T>(fn: (state: FileState) => Promise<T> | T, write = true): Promise<T> {
    const operation = queue.then(async () => {
      const state = await load();
      const result = await fn(state);
      if (write) await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return result;
    });
    queue = operation.catch(() => undefined);
    return operation;
  }
  const holds = (state: FileState, jobId: string, leaseVersion: number) => {
    const job = state.jobs[jobId];
    return Boolean(job && job.status === "running" && job.leaseVersion === leaseVersion);
  };
  return {
    kind: "file",
    transaction<T>(fn: (tx: ClassroomTransaction) => Promise<T>) {
      return run<T>((state) => fn(fileTransaction(state)));
    },
    claimJob: ({ workerId, now, leaseMs }) => run((state) => {
      const job = Object.values(state.jobs)
        .filter((entry) => (entry.status === "pending" && entry.availableAt <= now) || (entry.status === "running" && entry.leaseUntil <= now))
        .sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))[0];
      if (!job) return null;
      Object.assign(job, { status: "running", leaseOwner: workerId, leaseUntil: now + leaseMs, leaseVersion: job.leaseVersion + 1, attempts: job.attempts + 1 });
      return { job: clone(job), leaseVersion: job.leaseVersion };
    }),
    failJob: ({ jobId, leaseVersion, now, error, maxAttempts, retryAfterMs = 0, giveUp = {} }) => run((state) => {
      if (!holds(state, jobId, leaseVersion)) return false;
      const job = state.jobs[jobId];
      Object.assign(job, { error: error.slice(0, 500), leaseOwner: null });
      if (job.attempts >= maxAttempts) {
        job.status = "dead";
        const file = job.providerFileId ? state.files[job.providerFileId] : null;
        if (file && giveUp.fileChanges) Object.assign(file, clone(giveUp.fileChanges));
        for (const event of giveUp.events ?? []) state.events[event.key] ??= clone(event);
      } else {
        Object.assign(job, { status: "pending", availableAt: now + backoffMs(job.attempts, retryAfterMs) });
      }
      return true;
    }),
    // Back in the queue without counting the attempt: to carry on in the next call, or to look
    // again later while the job is blocked.
    rescheduleJob: ({ jobId, leaseVersion, availableAt, refundAttempt = false, blockedReason = null, error = null, events = [] }) => run((state) => {
      if (!holds(state, jobId, leaseVersion)) return false;
      const job = state.jobs[jobId];
      Object.assign(job, {
        status: "pending",
        leaseOwner: null,
        availableAt,
        blockedReason,
        error: error == null ? null : error.slice(0, 500),
        attempts: refundAttempt ? Math.max(0, job.attempts - 1) : job.attempts,
      });
      for (const event of events) state.events[event.key] ??= clone(event);
      return true;
    }),
    completeJob: ({ jobId, leaseVersion }) => run((state) => {
      if (!holds(state, jobId, leaseVersion)) return false;
      Object.assign(state.jobs[jobId], { status: "done", leaseOwner: null });
      return true;
    }),
    // Saved after every chunk: renews the lease, clears a block, and restarts the attempt count
    // when bytes moved.
    recordTransfer: ({ jobId, leaseVersion, providerFileId, uri, uploadedBytes, now, leaseMs, events = [] }) => run((state) => {
      const file = state.files[providerFileId];
      if (!holds(state, jobId, leaseVersion) || !file) return false;
      const job = state.jobs[jobId];
      if (uploadedBytes > Number(file.uploadedBytes ?? 0)) job.attempts = 0;
      Object.assign(file, { uploadSessionUri: uri, uploadedBytes });
      Object.assign(job, { leaseUntil: now + leaseMs, blockedReason: null });
      for (const event of events) state.events[event.key] ??= clone(event);
      return true;
    }),
    finishFiling: ({ jobId, leaseVersion, providerFileId, changes, events = [], jobs = [] }) => run((state) => {
      if (!holds(state, jobId, leaseVersion)) return false;
      const file = state.files[providerFileId];
      if (file && !FINAL_FILE_STATUSES.includes(file.status)) {
        Object.assign(file, clone(changes));
        for (const event of events) state.events[event.key] ??= clone(event);
        for (const job of jobs) state.jobs[job.id] ??= newJob(job);
      }
      Object.assign(state.jobs[jobId], { status: "done", leaseOwner: null });
      return true;
    }),
    fileRecord: (id) => run((state) => readers(state).fileRecord(id), false),
    lesson: (id) => run((state) => readers(state).lesson(id), false),
    withdrawalAt: (id) => run((state) => readers(state).withdrawalAt(id), false),
    unknownJoinAt: (id) => run((state) => readers(state).unknownJoinAt(id), false),
    eventsFor: (lessonIds) => run((state) => clone(Object.values(state.events).filter((event) => lessonIds.includes(String(event.lessonId)))), false),
    listOpenFilingLessonIds: () => run((state) => [...new Set(Object.values(state.jobs)
      .filter((job) => job.type === "file_recording" && (job.status === "pending" || job.status === "running") && job.lessonId)
      .map((job) => String(job.lessonId)))].sort(), false),
    createLesson: (lesson) => run((state) => {
      if (state.lessons.some((item) => item.id === lesson.id || item.code === lesson.code)) throw new ClassroomLessonConflictError("A lesson with this code already exists");
      state.lessons.push(clone(lesson));
    }),
    listLessons: ({ from, to }) => run((state) => clone(state.lessons
      .filter((lesson) => Date.parse(lesson.startsAt) < to && Date.parse(lesson.endsAt) > from)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.code.localeCompare(b.code))), false),
    listLessonsForStaff: (email, { from, to }) => run((state) => clone(email ? state.lessons
      .filter((lesson) => Date.parse(lesson.startsAt) < to && Date.parse(lesson.endsAt) > from)
      .filter((lesson) => lesson.participants.some((entry) => entry.role === "tutor" && entry.staffEmail === email))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.code.localeCompare(b.code)) : []), false),
    setLessonCancelled: (id) => run((state) => {
      const lesson = state.lessons.find((item) => item.id === id);
      if (!lesson) return false;
      lesson.cancelled = true;
      return true;
    }),
    replaceStudentKeyHash: (lessonId, participantId, keyHash) => run((state) => {
      const student = state.lessons.find((item) => item.id === lessonId)?.participants
        .find((entry) => entry.id === participantId && entry.role === "student");
      if (!student) return false;
      student.joinKeyHash = keyHash;
      return true;
    }),
    rotateStudent: (lessonId, fromId, toId, keyHash, events) => run((state) => {
      const lesson = state.lessons.find((item) => item.id === lessonId);
      const student = lesson?.participants.find((entry) => entry.id === fromId && entry.role === "student");
      if (!lesson || !student || lesson.participants.some((entry) => entry.id === toId)) return false;
      // Every fact must be new (another change may have taken this generation): else nothing.
      if (events.some((event) => state.events[event.key])) return false;
      student.id = toId;
      student.joinKeyHash = keyHash;
      for (const event of events) state.events[event.key] = clone(event);
      return true;
    }),
    // One write each (the file store's writes run one at a time): the claim and the result.
    claimOperation: (input) => run((state): OperationClaim => {
      const key = operationKey(input.operation);
      const result = claimFor(state.events[key] ?? null, input);
      if (!result.acquired) return { acquired: false, state: result.state };
      state.events[key] = clone(operationEvent(result.next));
      return { acquired: true, version: result.next.version, previous: result.previous, since: result.next.since, action: result.next.action, params: result.next.params };
    }),
    finishOperation: (input) => run((state) => {
      const key = operationKey(input.operation);
      const next = finishFor(state.events[key] ?? null, input);
      if (!next) return false;
      state.events[key] = clone(operationEvent(next));
      for (const event of input.events ?? []) if (!state.events[event.key]) state.events[event.key] = clone(event);
      return true;
    }),
    listConsents: (codes) => run((state) => clone(state.consents.filter((item) => codes.includes(item.personCode))), false),
    setConsent: (consent) => run((state) => {
      state.consents = [...state.consents.filter((item) => item.personCode !== consent.personCode), clone(consent)];
    }),
    listStaffNotices: (codes) => run((state) => clone(state.notices.filter((item) => codes.includes(item.personCode))), false),
    setStaffNotice: (notice) => run((state) => {
      state.notices = [...state.notices.filter((item) => item.personCode !== notice.personCode), clone(notice)];
    }),
    recordJoinToken: (token) => run((state) => {
      if (!state.tokens.some((item) => item.tokenHash === token.tokenHash)) state.tokens.push(clone(token));
    }),
    listJoinTokens: (lessonId) => run((state) => clone(state.tokens.filter((item) => item.lessonId === lessonId)), false),
    listJoinTokensFor: (lessonIds) => run((state) => clone(state.tokens.filter((item) => lessonIds.includes(item.lessonId))), false),
    syncAnomalies: (lessonId, active, now) => run((state) => {
      for (const anomaly of active) {
        const existing = state.anomalies.find((item) => item.lessonId === lessonId && item.code === anomaly.code);
        if (!existing) {
          state.anomalies.push({ lessonId, code: anomaly.code, severity: anomaly.severity, firstSeenAt: now, openedAt: now, lastSeenAt: now, resolvedAt: null, acknowledgedBy: null, acknowledgedAt: null, note: null });
          continue;
        }
        // A problem that comes back, or a warning that became an error, needs fresh attention.
        // The earlier handling note is kept for context but no longer counts.
        const reopened = existing.resolvedAt != null || (existing.severity === "warning" && anomaly.severity === "error");
        Object.assign(existing, {
          severity: existing.severity === "error" ? "error" : anomaly.severity,
          openedAt: reopened ? now : existing.openedAt,
          lastSeenAt: Math.max(existing.lastSeenAt, now),
          resolvedAt: null,
        });
      }
      const codes = new Set(active.map((item) => item.code));
      for (const existing of state.anomalies) {
        if (existing.lessonId === lessonId && existing.resolvedAt == null && !codes.has(existing.code)) existing.resolvedAt = now;
      }
    }),
    listAnomalies: (lessonIds) => run((state) => clone(state.anomalies.filter((item) => lessonIds.includes(item.lessonId))), false),
    acknowledgeAnomaly: ({ lessonId, code, actor, note, now }) => run((state) => {
      const existing = state.anomalies.find((item) => item.lessonId === lessonId && item.code === code);
      if (!existing) return null;
      Object.assign(existing, { acknowledgedBy: actor, acknowledgedAt: now, note });
      return clone(existing);
    }),
    createBlock: (block, lessons) => run((state) => {
      const codes = new Set(lessons.map((lesson) => lesson.code));
      if (state.blocks.some((item) => item.id === block.id || item.code === block.code)
        || state.lessons.some((item) => codes.has(item.code) || lessons.some((lesson) => lesson.id === item.id))) {
        throw new ClassroomLessonConflictError("A block or lesson with this code already exists");
      }
      state.blocks.push(clone(block));
      for (const lesson of lessons) state.lessons.push(clone(lesson));
    }),
    block: (id) => run((state) => readers(state).block(id), false),
    lessonsOfBlock: (id) => run((state) => clone(state.lessons.filter((lesson) => lesson.blockId === id)), false),
    blockVersion: (id) => run((state) => state.blocks.find((item) => item.id === id)?.version ?? null, false),
    listBlocks: ({ from, to }) => run((state) => clone(state.blocks
      .filter((block) => Date.parse(block.startsAt) < to && Date.parse(block.endsAt) > from)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.code.localeCompare(b.code))), false),
    listBlocksForStaff: (email, { from, to }) => run((state) => clone(email ? state.blocks
      .filter((block) => Date.parse(block.startsAt) < to && Date.parse(block.endsAt) > from)
      .filter((block) => block.members.some((member) => member.role !== "student" && member.staffEmail === email))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.code.localeCompare(b.code)) : []), false),
    filings: (lessonIds) => run((state) => clone(Object.values(state.files).filter((file) => lessonIds.includes(String(file.lessonId))).map((record) => {
      const job = state.jobs[`file:${record.providerFileId}`];
      return { record, job: job ? { status: job.status, attempts: job.attempts, error: job.error ?? null, blockedReason: job.blockedReason ?? null } : null };
    })), false),
    requeueFiling: ({ providerFileId, now, events }) => run((state) => {
      const record = state.files[providerFileId];
      const refused = requeueRefusal(record ?? null);
      if (refused) return { ok: false as const, reason: refused };
      const id = `file:${providerFileId}`;
      const job = state.jobs[id] ?? (state.jobs[id] = newJob({ id, type: "file_recording", lessonId: record.lessonId, providerFileId }));
      Object.assign(job, { status: "pending", attempts: 0, availableAt: now, error: null, blockedReason: null, leaseOwner: null });
      record.status = "PENDING";
      for (const event of events) state.events[event.key] ??= clone(event);
      return { ok: true as const };
    }),
    changeBlock: (change) => run((state): BlockChangeResult => {
      const block = state.blocks.find((item) => item.id === change.blockId) ?? null;
      const rooms = block ? state.lessons.filter((lesson) => lesson.blockId === block.id) : [];
      const plan = planBlockChange(block ? clone(block) : null, clone(rooms), change);
      if (!plan.ok) return plan.result;
      const row = (lessonId: string, participantId: string) => rooms.find((room) => room.id === lessonId)?.participants.find((entry) => entry.id === participantId);
      if (plan.seat?.release) {
        const released = row(plan.seat.release.lessonId, plan.seat.release.participantId);
        if (released) released.active = false;
      }
      if (plan.seat?.take) {
        const room = rooms.find((item) => item.id === plan.seat!.take!.lessonId)!;
        const existing = room.participants.find((entry) => entry.id === plan.seat!.take!.participant.id);
        if (existing) Object.assign(existing, clone(plan.seat.take.participant));
        else room.participants.push(clone(plan.seat.take.participant));
      }
      for (const rotation of plan.rotations ?? []) {
        const rotated = row(rotation.lessonId, rotation.fromId);
        if (!rotated) continue;
        rotated.id = rotation.toId;
        if (rotation.deactivate) rotated.active = false;
      }
      if (change.rotate) {
        const member = block!.members.find((entry) => entry.id === change.rotate!.memberId)!;
        member.joinKeyHash = change.rotate.keyHash;
      }
      if (change.cancel) {
        block!.cancelled = true;
        for (const room of rooms) room.cancelled = true;
      }
      for (const event of change.events) state.events[event.key] ??= clone(event);
      block!.version += 1;
      return { ok: true, version: block!.version, ...(plan.seat ? { seat: plan.seat.result } : {}) };
    }),
  };
}

// PostgreSQL store -----------------------------------------------------------------------

type Sql = postgres.Sql | postgres.TransactionSql;
const asDate = (ms: number | null | undefined) => (ms == null ? null : new Date(ms));
const asMs = (value: unknown) => (value == null ? null : new Date(value as string | Date).getTime());

function fromEventRow(row: Record<string, unknown>) {
  return row.data as ClassroomEvent;
}

function fromJobRow(row: Record<string, unknown>): ClassroomJob {
  return {
    id: String(row.id),
    type: row.type as ClassroomJob["type"],
    lessonId: row.lesson_id == null ? null : String(row.lesson_id),
    providerFileId: row.provider_file_id == null ? null : String(row.provider_file_id),
    status: row.status as ClassroomJob["status"],
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseUntil: asMs(row.lease_until) ?? 0,
    leaseVersion: Number(row.lease_version),
    availableAt: asMs(row.available_at) ?? 0,
    error: row.error == null ? null : String(row.error),
    blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
  };
}

const FILE_COLUMNS: Record<string, string> = {
  provider: "provider",
  lessonId: "lesson_id",
  providerSessionId: "provider_session_id",
  kind: "kind",
  extension: "extension",
  size: "size",
  md5: "md5",
  status: "status",
  hold: "hold",
  recordingStart: "recording_start",
  recordingEnd: "recording_end",
  plannedName: "planned_name",
  uploadSessionUri: "upload_session_uri",
  uploadedBytes: "uploaded_bytes",
  driveFileId: "drive_file_id",
  filedAt: "filed_at",
};
const TIME_COLUMNS = new Set(["recording_start", "recording_end", "filed_at"]);

// The vendor a recording came from, as migration 028 stores it ('zoom' or 'synthetic'). A vendor
// 028 does not list is refused here rather than stored under another vendor's name; letting
// more vendors in needs the migration change in the P1/P3 integration plan first.
const DATABASE_PROVIDERS: Record<string, string> = { "zoom-video-sdk": "zoom", zoom: "zoom", synthetic: "synthetic" };
export function databaseProvider(provider: unknown) {
  // Records made before facts named their vendor came only from Zoom's webhook.
  if (provider == null) return "zoom";
  // Own keys only: '__proto__' or 'constructor' must not read as a vendor.
  const stored = Object.hasOwn(DATABASE_PROVIDERS, String(provider)) ? DATABASE_PROVIDERS[String(provider)] : null;
  if (!stored) throw new Error(`Recordings from ${String(provider)} cannot be stored yet: migration 028 allows only zoom and synthetic`);
  return stored;
}

function fileColumns(record: Partial<RecordingFile>) {
  const columns: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(FILE_COLUMNS)) {
    if (!(field in record)) continue;
    const value = record[field];
    // The vendor as 028 stores it, whichever write carries it.
    columns[column] = column === "provider" ? databaseProvider(value) : TIME_COLUMNS.has(column) ? asDate(value as number | null) : value ?? null;
  }
  return columns;
}

function fromFileRow(row: Record<string, unknown>): RecordingFile {
  const record: Record<string, unknown> = { providerFileId: String(row.provider_file_id) };
  for (const [field, column] of Object.entries(FILE_COLUMNS)) {
    const value = row[column];
    record[field] = TIME_COLUMNS.has(column) ? asMs(value) : column === "size" || column === "uploaded_bytes" ? Number(value ?? 0) : value ?? null;
  }
  return record as RecordingFile;
}

async function lessonsWith(sql: Sql, rows: Record<string, unknown>[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => String(row.id));
  const participants = await sql`
    SELECT * FROM public.classroom_participants WHERE lesson_id IN ${sql(ids)} ORDER BY role DESC, code
  `;
  return rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    date: new Date(row.lesson_date as string | Date).toISOString().slice(0, 10),
    startsAt: new Date(row.starts_at as string | Date).toISOString(),
    endsAt: new Date(row.ends_at as string | Date).toISOString(),
    cancelled: Boolean(row.cancelled),
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    // P3-Multi's columns exist only where the draft 029 is applied; a one-to-one lesson there has
    // them empty. Without 029 the lesson reads exactly as before.
    ...("block_id" in row ? { blockId: row.block_id == null ? null : String(row.block_id), roomKind: (row.room_kind ?? null) as ClassroomLesson["roomKind"], roomLabel: row.room_label == null ? null : String(row.room_label) } : {}),
    participants: participants.filter((entry) => entry.lesson_id === row.id).map((entry) => ({
      id: String(entry.participant_id),
      code: String(entry.code),
      role: entry.role as ClassroomRole,
      staffEmail: entry.staff_email == null ? null : String(entry.staff_email),
      joinKeyHash: entry.join_key_hash == null ? null : String(entry.join_key_hash).trim(),
      ...("member_id" in entry ? { memberId: entry.member_id == null ? null : String(entry.member_id), active: Boolean(entry.active), seat: (entry.seat ?? null) as ClassroomParticipant["seat"] } : {}),
    })),
  }));
}

// P3-Multi: a block with its members and the ids of its Lobby and rooms (draft 029).
async function blocksWith(sql: Sql, rows: Record<string, unknown>[]): Promise<ClassroomBlock[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => String(row.id));
  const members = await sql`SELECT * FROM public.classroom_block_members WHERE block_id IN ${sql(ids)} ORDER BY code`;
  const lessons = await sql`SELECT id, block_id, room_kind, room_label FROM public.classroom_lessons WHERE block_id IN ${sql(ids)} ORDER BY room_label`;
  return rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    date: new Date(row.lesson_date as string | Date).toISOString().slice(0, 10),
    startsAt: new Date(row.starts_at as string | Date).toISOString(),
    endsAt: new Date(row.ends_at as string | Date).toISOString(),
    cancelled: Boolean(row.cancelled),
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    lobbyId: String(lessons.find((lesson) => lesson.block_id === row.id && lesson.room_kind === "lobby")?.id ?? ""),
    roomIds: lessons.filter((lesson) => lesson.block_id === row.id && lesson.room_kind === "room").map((lesson) => String(lesson.id)),
    members: members.filter((member) => member.block_id === row.id).map((member) => ({
      id: String(member.member_id),
      code: String(member.code),
      role: member.role as BlockRole,
      englishName: String(member.english_name),
      staffEmail: member.staff_email == null ? null : String(member.staff_email),
      joinKeyHash: member.join_key_hash == null ? null : String(member.join_key_hash).trim(),
    })),
    version: Number(row.version),
  }));
}

async function readConsents(sql: Sql, codes: string[]): Promise<ClassroomConsent[]> {
  if (!codes.length) return [];
  return (await sql`SELECT * FROM public.classroom_consents WHERE person_code IN ${sql(codes)}`).map((row) => ({
    personCode: String(row.person_code),
    status: row.status as ClassroomConsent["status"],
    version: String(row.version),
    grantedAt: asMs(row.granted_at),
    withdrawnAt: asMs(row.withdrawn_at),
    expiresAt: asMs(row.expires_at),
    synthetic: Boolean(row.synthetic),
    recordedBy: String(row.recorded_by),
  }));
}

async function readNotices(sql: Sql, codes: string[]): Promise<ClassroomStaffNotice[]> {
  if (!codes.length) return [];
  return (await sql`SELECT * FROM public.classroom_staff_notices WHERE person_code IN ${sql(codes)}`).map((row) => ({
    personCode: String(row.person_code),
    version: String(row.version),
    acknowledgedAt: asMs(row.acknowledged_at) ?? 0,
    recordedBy: String(row.recorded_by),
  }));
}

// Whether an owner may send a filing back to the queue (18.5): only a FAILED one, never one held.
function requeueRefusal(record: RecordingFile | null): "NOT_FOUND" | "ALREADY_ARCHIVED" | "HELD" | "NOT_FAILED" | null {
  if (!record) return "NOT_FOUND";
  if (record.status === "STORED") return "ALREADY_ARCHIVED";
  if (record.hold || record.status === "HOLD" || record.status === "QUARANTINED") return "HELD";
  if (record.status !== "FAILED") return "NOT_FAILED";
  return null;
}

// A database without the draft 029 has no block tables (PostgreSQL's undefined_table, 42P01) and
// no block columns on the lessons (undefined_column, 42703). Only the block reads use this.
async function withoutBlocks<T>(read: () => Promise<T>, none: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (["42P01", "42703"].includes(String((error as { code?: string }).code))) return none;
    throw error;
  }
}

async function readBlock(sql: Sql, id: string, lock = false) {
  const rows = lock
    ? await sql`SELECT * FROM public.classroom_blocks WHERE id = ${id} FOR UPDATE`
    : await sql`SELECT * FROM public.classroom_blocks WHERE id = ${id}`;
  return (await blocksWith(sql, rows))[0] ?? null;
}

async function readLesson(sql: Sql, id: string, lock = false) {
  const rows = lock
    ? await sql`SELECT * FROM public.classroom_lessons WHERE id = ${id} FOR UPDATE`
    : await sql`SELECT * FROM public.classroom_lessons WHERE id = ${id}`;
  return (await lessonsWith(sql, rows))[0] ?? null;
}

const earliestEvent = async (sql: Sql, lessonId: string, types: string[]) => {
  const [row] = await sql`
    SELECT min(occurred_at) AS at FROM public.classroom_events WHERE lesson_id = ${lessonId} AND type IN ${sql(types)}
  `;
  return asMs(row?.at);
};

// Someone who was never on the roster. An id a revoke or reissue took away (D-4) still counts as
// the student for joins up to that change, as the lesson's own state reads it.
async function unknownJoinAt(sql: Sql, lessonId: string) {
  const [row] = await sql`
    SELECT min(event.occurred_at) AS at
    FROM public.classroom_events AS event
    WHERE event.lesson_id = ${lessonId}
      AND event.type IN ('session.user_joined', 'host.user_added')
      AND NOT EXISTS (
        SELECT 1 FROM public.classroom_participants AS participant
        WHERE participant.lesson_id = event.lesson_id AND participant.participant_id = event.data->>'participantId'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.classroom_events AS rotation
        WHERE rotation.lesson_id = event.lesson_id AND rotation.type = 'server.participant_rotated'
          AND rotation.data->>'from' = event.data->>'participantId' AND event.occurred_at <= rotation.occurred_at
      )
  `;
  return asMs(row?.at);
}

function eventValues(event: ClassroomEvent) {
  return {
    key: event.key,
    lesson_id: event.lessonId ?? null,
    type: event.type,
    source: event.source,
    occurred_at: new Date(event.occurredAt),
    received_at: new Date(event.receivedAt ?? event.occurredAt),
  };
}

function postgresTransaction(sql: postgres.TransactionSql): ClassroomTransaction {
  return {
    async insertEvent(event) {
      const values = eventValues(event);
      const rows = await sql`
        INSERT INTO public.classroom_events (key, lesson_id, type, source, occurred_at, received_at, data)
        VALUES (${values.key}, ${values.lesson_id}, ${values.type}, ${values.source}, ${values.occurred_at}, ${values.received_at}, ${sql.json(event as postgres.JSONValue)})
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `;
      return rows.length > 0;
    },
    async keepLatest(event) {
      const values = eventValues(event);
      const rows = await sql`
        INSERT INTO public.classroom_events (key, lesson_id, type, source, occurred_at, received_at, data)
        VALUES (${values.key}, ${values.lesson_id}, ${values.type}, ${values.source}, ${values.occurred_at}, ${values.received_at}, ${sql.json(event as postgres.JSONValue)})
        ON CONFLICT (key) DO UPDATE
          SET occurred_at = EXCLUDED.occurred_at, received_at = EXCLUDED.received_at, data = EXCLUDED.data
          WHERE public.classroom_events.occurred_at < EXCLUDED.occurred_at
        RETURNING key
      `;
      return rows.length > 0;
    },
    async insertJob(job) {
      const rows = await sql`
        INSERT INTO public.classroom_jobs (id, type, lesson_id, provider_file_id, available_at)
        VALUES (${job.id}, ${job.type}, ${job.lessonId ?? null}, ${job.providerFileId ?? null}, ${new Date(job.availableAt ?? 0)})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      return rows.length > 0;
    },
    async insertFileRecord(record) {
      const columns = { provider_file_id: record.providerFileId, provider: databaseProvider(record.provider), ...fileColumns(record) };
      const rows = await sql`
        INSERT INTO public.classroom_recording_files ${sql(columns)}
        ON CONFLICT (provider_file_id) DO NOTHING
        RETURNING provider_file_id
      `;
      return rows.length > 0;
    },
    async updateFileRecord(id, changes) {
      const columns = fileColumns(changes);
      if (!Object.keys(columns).length) return;
      await sql`UPDATE public.classroom_recording_files SET ${sql(columns)}, updated_at = NOW() WHERE provider_file_id = ${id}`;
    },
    // Locking the lesson row serializes everything written for one lesson.
    lesson: (id) => readLesson(sql, id, true),
    async fileRecord(id) {
      const [row] = await sql`SELECT * FROM public.classroom_recording_files WHERE provider_file_id = ${id}`;
      return row ? fromFileRow(row) : null;
    },
    async fileRecordsForLesson(id) {
      return (await sql`SELECT * FROM public.classroom_recording_files WHERE lesson_id = ${id} ORDER BY created_at, provider_file_id`).map(fromFileRow);
    },
    async eligibility(id, generation, before) {
      const [row] = await sql`
        SELECT data FROM public.classroom_events
        WHERE lesson_id = ${id} AND type = 'server.recording_eligibility'
          AND (${generation ?? null}::integer IS NULL OR COALESCE(NULLIF(data->>'generation', '')::integer, 0) = ${generation ?? null}::integer)
          AND (${before == null ? null : new Date(before)}::timestamptz IS NULL OR occurred_at <= ${before == null ? null : new Date(before)}::timestamptz)
        ORDER BY occurred_at DESC LIMIT 1
      `;
      return row ? fromEventRow(row) : null;
    },
    withdrawalAt: (id) => earliestEvent(sql, id, PROTECTIVE_STOPS),
    unknownJoinAt: (id) => unknownJoinAt(sql, id),
    block: (id) => readBlock(sql, id),
    async eventsOf(lessonId) {
      return (await sql`SELECT data FROM public.classroom_events WHERE lesson_id = ${lessonId} ORDER BY occurred_at, key`).map(fromEventRow);
    },
    consents: (codes) => readConsents(sql, codes),
    notices: (codes) => readNotices(sql, codes),
  };
}

export function createPostgresClassroomStore(sql: postgres.Sql): ClassroomStore {
  // A fenced statement only touches the job while this worker still holds its lease.
  const holdsLease = async (tx: postgres.TransactionSql, jobId: string, leaseVersion: number) => {
    const [job] = await tx`
      SELECT * FROM public.classroom_jobs WHERE id = ${jobId} AND status = 'running' AND lease_version = ${leaseVersion} FOR UPDATE
    `;
    return job ? fromJobRow(job) : null;
  };
  const insertEvents = async (tx: postgres.TransactionSql, events: ClassroomEvent[]) => {
    for (const event of events) await postgresTransaction(tx).insertEvent(event);
  };
  return {
    kind: "postgres",
    transaction<T>(fn: (tx: ClassroomTransaction) => Promise<T>) {
      return sql.begin((tx) => fn(postgresTransaction(tx))) as Promise<T>;
    },
    async claimJob({ workerId, now, leaseMs }) {
      const [row] = await sql`
        UPDATE public.classroom_jobs
        SET status = 'running', lease_owner = ${workerId}, lease_until = ${new Date(now + leaseMs)},
            lease_version = lease_version + 1, attempts = attempts + 1, updated_at = NOW()
        WHERE id = (
          SELECT id FROM public.classroom_jobs
          WHERE (status = 'pending' AND available_at <= ${new Date(now)}) OR (status = 'running' AND lease_until <= ${new Date(now)})
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `;
      if (!row) return null;
      const job = fromJobRow(row);
      return { job, leaseVersion: job.leaseVersion };
    },
    failJob: ({ jobId, leaseVersion, now, error, maxAttempts, retryAfterMs = 0, giveUp = {} }) => sql.begin(async (tx) => {
      const job = await holdsLease(tx, jobId, leaseVersion);
      if (!job) return false;
      if (job.attempts >= maxAttempts) {
        await tx`UPDATE public.classroom_jobs SET status = 'dead', lease_owner = NULL, error = ${error.slice(0, 500)}, updated_at = NOW() WHERE id = ${jobId}`;
        if (job.providerFileId && giveUp.fileChanges) await postgresTransaction(tx).updateFileRecord(job.providerFileId, giveUp.fileChanges);
        await insertEvents(tx, giveUp.events ?? []);
      } else {
        await tx`
          UPDATE public.classroom_jobs
          SET status = 'pending', lease_owner = NULL, error = ${error.slice(0, 500)}, available_at = ${new Date(now + backoffMs(job.attempts, retryAfterMs))}, updated_at = NOW()
          WHERE id = ${jobId}
        `;
      }
      return true;
    }) as Promise<boolean>,
    rescheduleJob: ({ jobId, leaseVersion, availableAt, refundAttempt = false, blockedReason = null, error = null, events = [] }) => sql.begin(async (tx) => {
      if (!(await holdsLease(tx, jobId, leaseVersion))) return false;
      await tx`
        UPDATE public.classroom_jobs
        SET status = 'pending', lease_owner = NULL, available_at = ${new Date(availableAt)}, blocked_reason = ${blockedReason},
            error = ${error == null ? null : error.slice(0, 500)},
            attempts = CASE WHEN ${refundAttempt}::boolean THEN GREATEST(0, attempts - 1) ELSE attempts END, updated_at = NOW()
        WHERE id = ${jobId}
      `;
      await insertEvents(tx, events);
      return true;
    }) as Promise<boolean>,
    async completeJob({ jobId, leaseVersion }) {
      const rows = await sql`
        UPDATE public.classroom_jobs SET status = 'done', lease_owner = NULL, updated_at = NOW()
        WHERE id = ${jobId} AND status = 'running' AND lease_version = ${leaseVersion}
        RETURNING id
      `;
      return rows.length > 0;
    },
    recordTransfer: ({ jobId, leaseVersion, providerFileId, uri, uploadedBytes, now, leaseMs, events = [] }) => sql.begin(async (tx) => {
      if (!(await holdsLease(tx, jobId, leaseVersion))) return false;
      const [file] = await tx`SELECT uploaded_bytes FROM public.classroom_recording_files WHERE provider_file_id = ${providerFileId} FOR UPDATE`;
      if (!file) return false;
      const progressed = uploadedBytes > Number(file.uploaded_bytes ?? 0);
      await tx`
        UPDATE public.classroom_recording_files SET upload_session_uri = ${uri}, uploaded_bytes = ${uploadedBytes}, updated_at = NOW()
        WHERE provider_file_id = ${providerFileId}
      `;
      await tx`
        UPDATE public.classroom_jobs
        SET lease_until = ${new Date(now + leaseMs)}, blocked_reason = NULL,
            attempts = CASE WHEN ${progressed}::boolean THEN 0 ELSE attempts END, updated_at = NOW()
        WHERE id = ${jobId}
      `;
      await insertEvents(tx, events);
      return true;
    }) as Promise<boolean>,
    finishFiling: ({ jobId, leaseVersion, providerFileId, changes, events = [], jobs = [] }) => sql.begin(async (tx) => {
      if (!(await holdsLease(tx, jobId, leaseVersion))) return false;
      const [file] = await tx`SELECT status FROM public.classroom_recording_files WHERE provider_file_id = ${providerFileId} FOR UPDATE`;
      if (file && !FINAL_FILE_STATUSES.includes(String(file.status))) {
        await postgresTransaction(tx).updateFileRecord(providerFileId, changes);
        await insertEvents(tx, events);
        for (const job of jobs) await postgresTransaction(tx).insertJob(job);
      }
      await tx`UPDATE public.classroom_jobs SET status = 'done', lease_owner = NULL, updated_at = NOW() WHERE id = ${jobId}`;
      return true;
    }) as Promise<boolean>,
    async fileRecord(id) {
      const [row] = await sql`SELECT * FROM public.classroom_recording_files WHERE provider_file_id = ${id}`;
      return row ? fromFileRow(row) : null;
    },
    lesson: (id) => readLesson(sql, id),
    withdrawalAt: (id) => earliestEvent(sql, id, PROTECTIVE_STOPS),
    unknownJoinAt: (id) => unknownJoinAt(sql, id),
    async eventsFor(lessonIds) {
      if (!lessonIds.length) return [];
      return (await sql`SELECT data FROM public.classroom_events WHERE lesson_id IN ${sql(lessonIds)}`).map(fromEventRow);
    },
    async listOpenFilingLessonIds() {
      const rows = await sql`
        SELECT DISTINCT lesson_id FROM public.classroom_jobs
        WHERE type = 'file_recording' AND status IN ('pending', 'running') AND lesson_id IS NOT NULL
        ORDER BY lesson_id
      `;
      return rows.map((row) => String(row.lesson_id));
    },
    async createLesson(lesson) {
      try {
        await sql.begin(async (tx) => {
          await tx`
            INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, cancelled, created_by, created_at)
            VALUES (${lesson.id}, ${lesson.code}, ${lesson.date}, ${new Date(lesson.startsAt)}, ${new Date(lesson.endsAt)}, ${lesson.cancelled}, ${lesson.createdBy}, ${new Date(lesson.createdAt)})
          `;
          for (const participant of lesson.participants) {
            await tx`
              INSERT INTO public.classroom_participants (lesson_id, participant_id, code, role, staff_email, join_key_hash)
              VALUES (${lesson.id}, ${participant.id}, ${participant.code}, ${participant.role}, ${participant.staffEmail ?? null}, ${participant.joinKeyHash ?? null})
            `;
          }
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new ClassroomLessonConflictError("A lesson with this code already exists");
        throw error;
      }
    },
    async listLessons({ from, to }) {
      const rows = await sql`
        SELECT * FROM public.classroom_lessons
        WHERE starts_at < ${new Date(to)} AND ends_at > ${new Date(from)}
        ORDER BY starts_at, code
      `;
      return lessonsWith(sql, rows);
    },
    async listLessonsForStaff(email, { from, to }) {
      if (!email) return [];
      const rows = await sql`
        SELECT l.* FROM public.classroom_lessons l
        WHERE l.starts_at < ${new Date(to)} AND l.ends_at > ${new Date(from)}
          AND EXISTS (
            SELECT 1 FROM public.classroom_participants p
            WHERE p.lesson_id = l.id AND p.role = 'tutor' AND p.staff_email = ${email}
          )
        ORDER BY l.starts_at, l.code
      `;
      return lessonsWith(sql, rows);
    },
    async setLessonCancelled(id) {
      const rows = await sql`UPDATE public.classroom_lessons SET cancelled = TRUE, updated_at = NOW() WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    },
    async replaceStudentKeyHash(lessonId, participantId, keyHash) {
      const rows = await sql`
        UPDATE public.classroom_participants SET join_key_hash = ${keyHash}
        WHERE lesson_id = ${lessonId} AND participant_id = ${participantId} AND role = 'student'
        RETURNING participant_id
      `;
      return rows.length > 0;
    },
    async rotateStudent(lessonId, fromId, toId, keyHash, events) {
      // One transaction: the row keeps its code and consent link (person_code); only its id and
      // key change, and only if it still has the id this request read. Nothing references the id
      // by a foreign key, so no other row moves. Every fact must be new; if one is already stored
      // (another change took this generation), the whole change is rolled back.
      const taken = new Error("a fact of this change is already stored");
      try {
        return await (sql.begin(async (tx) => {
          const rows = await tx`
            UPDATE public.classroom_participants SET participant_id = ${toId}, join_key_hash = ${keyHash}
            WHERE lesson_id = ${lessonId} AND participant_id = ${fromId} AND role = 'student'
            RETURNING participant_id
          `;
          if (!rows.length) return false;
          for (const event of events) if (!(await postgresTransaction(tx).insertEvent(event))) throw taken;
          return true;
        }) as Promise<boolean>);
      } catch (error) {
        if (error === taken) return false;
        throw error;
      }
    },
    // G1. The claim: the operation's row locked (FOR UPDATE), or, the first time, inserted, where of
    // two first claims at once the primary key lets exactly one through; then the rule applied and
    // the new state written, in one transaction.
    async claimOperation(input) {
      const key = operationKey(input.operation);
      return sql.begin(async (tx) => {
        const [row] = await tx`SELECT data FROM public.classroom_events WHERE key = ${key} FOR UPDATE`;
        const result = claimFor(row ? fromEventRow(row) : null, input);
        if (!result.acquired) return { acquired: false, state: result.state };
        const event = operationEvent(result.next) as ClassroomEvent;
        if (row) {
          const values = eventValues(event);
          await tx`
            UPDATE public.classroom_events SET occurred_at = ${values.occurred_at}, received_at = ${values.received_at}, data = ${tx.json(event as postgres.JSONValue)}
            WHERE key = ${key}
          `;
        } else if (!(await postgresTransaction(tx).insertEvent(event))) {
          return { acquired: false, state: "IN_FLIGHT" };
        }
        return { acquired: true, version: result.next.version, previous: result.previous, since: result.next.since, action: result.next.action, params: result.next.params };
      }) as Promise<OperationClaim>;
    },
    // The result: only under the caller's claim (row locked, same version, still IN_FLIGHT); the
    // action's facts are stored in the same transaction.
    async finishOperation(input) {
      const key = operationKey(input.operation);
      return sql.begin(async (tx) => {
        const [row] = await tx`SELECT data FROM public.classroom_events WHERE key = ${key} FOR UPDATE`;
        const next = finishFor(row ? fromEventRow(row) : null, input);
        if (!next) return false;
        const event = operationEvent(next) as ClassroomEvent;
        const values = eventValues(event);
        await tx`
          UPDATE public.classroom_events SET occurred_at = ${values.occurred_at}, received_at = ${values.received_at}, data = ${tx.json(event as postgres.JSONValue)}
          WHERE key = ${key}
        `;
        for (const fact of input.events ?? []) await postgresTransaction(tx).insertEvent(fact);
        return true;
      }) as Promise<boolean>;
    },
    listConsents: (codes) => readConsents(sql, codes),
    async setConsent(consent) {
      await sql`
        INSERT INTO public.classroom_consents (person_code, status, version, granted_at, withdrawn_at, expires_at, synthetic, recorded_by, updated_at)
        VALUES (${consent.personCode}, ${consent.status}, ${consent.version}, ${asDate(consent.grantedAt)}, ${asDate(consent.withdrawnAt)}, ${asDate(consent.expiresAt)}, ${consent.synthetic}, ${consent.recordedBy}, NOW())
        ON CONFLICT (person_code) DO UPDATE SET
          status = EXCLUDED.status, version = EXCLUDED.version, granted_at = EXCLUDED.granted_at, withdrawn_at = EXCLUDED.withdrawn_at,
          expires_at = EXCLUDED.expires_at, synthetic = EXCLUDED.synthetic, recorded_by = EXCLUDED.recorded_by, updated_at = NOW()
      `;
    },
    listStaffNotices: (codes) => readNotices(sql, codes),
    async setStaffNotice(notice) {
      await sql`
        INSERT INTO public.classroom_staff_notices (person_code, version, acknowledged_at, recorded_by)
        VALUES (${notice.personCode}, ${notice.version}, ${new Date(notice.acknowledgedAt)}, ${notice.recordedBy})
        ON CONFLICT (person_code) DO UPDATE SET version = EXCLUDED.version, acknowledged_at = EXCLUDED.acknowledged_at, recorded_by = EXCLUDED.recorded_by
      `;
    },
    async recordJoinToken(token) {
      await sql`
        INSERT INTO public.classroom_join_tokens (token_hash, lesson_id, participant_id, issued_at, expires_at)
        VALUES (${token.tokenHash}, ${token.lessonId}, ${token.participantId}, ${new Date(token.issuedAt)}, ${new Date(token.expiresAt)})
        ON CONFLICT (token_hash) DO NOTHING
      `;
    },
    async listJoinTokens(lessonId) {
      return (await sql`SELECT * FROM public.classroom_join_tokens WHERE lesson_id = ${lessonId}`).map((row) => ({
        tokenHash: String(row.token_hash).trim(),
        lessonId: String(row.lesson_id),
        participantId: String(row.participant_id),
        issuedAt: asMs(row.issued_at) ?? 0,
        expiresAt: asMs(row.expires_at) ?? 0,
      }));
    },
    async listJoinTokensFor(lessonIds) {
      if (!lessonIds.length) return [];
      return (await sql`SELECT * FROM public.classroom_join_tokens WHERE lesson_id IN ${sql(lessonIds)}`).map((row) => ({
        tokenHash: String(row.token_hash).trim(),
        lessonId: String(row.lesson_id),
        participantId: String(row.participant_id),
        issuedAt: asMs(row.issued_at) ?? 0,
        expiresAt: asMs(row.expires_at) ?? 0,
      }));
    },
    syncAnomalies: (lessonId, active, now) => sql.begin(async (tx) => {
      for (const anomaly of active) {
        await tx`
          INSERT INTO public.classroom_anomalies (lesson_id, code, severity, first_seen_at, opened_at, last_seen_at)
          VALUES (${lessonId}, ${anomaly.code}, ${anomaly.severity}, ${new Date(now)}, ${new Date(now)}, ${new Date(now)})
          ON CONFLICT (lesson_id, code) DO UPDATE SET
            opened_at = CASE
              WHEN public.classroom_anomalies.resolved_at IS NOT NULL
                OR (public.classroom_anomalies.severity = 'warning' AND EXCLUDED.severity = 'error')
              THEN EXCLUDED.opened_at ELSE public.classroom_anomalies.opened_at END,
            severity = CASE WHEN public.classroom_anomalies.severity = 'error' THEN 'error' ELSE EXCLUDED.severity END,
            last_seen_at = GREATEST(public.classroom_anomalies.last_seen_at, EXCLUDED.last_seen_at),
            resolved_at = NULL
        `;
      }
      const codes = active.map((item) => item.code);
      if (codes.length) {
        await tx`
          UPDATE public.classroom_anomalies SET resolved_at = ${new Date(now)}
          WHERE lesson_id = ${lessonId} AND resolved_at IS NULL AND code NOT IN ${tx(codes)}
        `;
      } else {
        await tx`UPDATE public.classroom_anomalies SET resolved_at = ${new Date(now)} WHERE lesson_id = ${lessonId} AND resolved_at IS NULL`;
      }
    }) as Promise<void>,
    async listAnomalies(lessonIds) {
      if (!lessonIds.length) return [];
      return (await sql`SELECT * FROM public.classroom_anomalies WHERE lesson_id IN ${sql(lessonIds)} ORDER BY first_seen_at`).map(fromAnomalyRow);
    },
    async acknowledgeAnomaly({ lessonId, code, actor, note, now }) {
      const [row] = await sql`
        UPDATE public.classroom_anomalies SET acknowledged_by = ${actor}, acknowledged_at = ${new Date(now)}, note = ${note}
        WHERE lesson_id = ${lessonId} AND code = ${code}
        RETURNING *
      `;
      return row ? fromAnomalyRow(row) : null;
    },
    // P3-Multi (draft 029): the block, its members, its Lobby and rooms and their rows, at once.
    async createBlock(block, lessons) {
      try {
        await sql.begin(async (tx) => {
          await tx`
            INSERT INTO public.classroom_blocks (id, code, lesson_date, starts_at, ends_at, cancelled, version, created_by, created_at)
            VALUES (${block.id}, ${block.code}, ${block.date}, ${new Date(block.startsAt)}, ${new Date(block.endsAt)}, ${block.cancelled}, ${block.version}, ${block.createdBy}, ${new Date(block.createdAt)})
          `;
          for (const member of block.members) {
            await tx`
              INSERT INTO public.classroom_block_members (block_id, member_id, code, role, english_name, staff_email, join_key_hash)
              VALUES (${block.id}, ${member.id}, ${member.code}, ${member.role}, ${member.englishName}, ${member.staffEmail}, ${member.joinKeyHash})
            `;
          }
          for (const lesson of lessons) {
            await tx`
              INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, cancelled, created_by, created_at, block_id, room_kind, room_label)
              VALUES (${lesson.id}, ${lesson.code}, ${lesson.date}, ${new Date(lesson.startsAt)}, ${new Date(lesson.endsAt)}, ${lesson.cancelled}, ${lesson.createdBy}, ${new Date(lesson.createdAt)}, ${block.id}, ${lesson.roomKind ?? null}, ${lesson.roomLabel ?? null})
            `;
            for (const participant of lesson.participants) {
              await tx`
                INSERT INTO public.classroom_participants (lesson_id, participant_id, code, role, member_id, active, seat)
                VALUES (${lesson.id}, ${participant.id}, ${participant.code}, ${participant.role}, ${participant.memberId ?? null}, ${participant.active !== false}, ${participant.seat ?? null})
              `;
            }
          }
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new ClassroomLessonConflictError("A block or lesson with this code already exists");
        throw error;
      }
    },
    // Where the draft 029 is not applied (every real database today), there are no blocks: the
    // reads answer "none" rather than fail, so nothing that lists lessons breaks.
    block: (id) => withoutBlocks(() => readBlock(sql, id), null),
    lessonsOfBlock: (id) => withoutBlocks(async () => lessonsWith(sql, await sql`SELECT * FROM public.classroom_lessons WHERE block_id = ${id} ORDER BY room_kind, room_label`), []),
    async blockVersion(id) {
      return withoutBlocks(async () => {
        const [row] = await sql`SELECT version FROM public.classroom_blocks WHERE id = ${id}`;
        return row ? Number(row.version) : null;
      }, null);
    },
    async listBlocks({ from, to }) {
      return withoutBlocks(async () => blocksWith(sql, await sql`
        SELECT * FROM public.classroom_blocks WHERE starts_at < ${new Date(to)} AND ends_at > ${new Date(from)} ORDER BY starts_at, code
      `), []);
    },
    async listBlocksForStaff(email, { from, to }) {
      if (!email) return [];
      return withoutBlocks(async () => blocksWith(sql, await sql`
        SELECT b.* FROM public.classroom_blocks b
        WHERE b.starts_at < ${new Date(to)} AND b.ends_at > ${new Date(from)}
          AND EXISTS (SELECT 1 FROM public.classroom_block_members m WHERE m.block_id = b.id AND m.role <> 'student' AND m.staff_email = ${email})
        ORDER BY b.starts_at, b.code
      `), []);
    },
    async filings(lessonIds) {
      if (!lessonIds.length) return [];
      const rows = await sql`
        SELECT f.*, j.status AS job_status, j.attempts AS job_attempts, j.error AS job_error, j.blocked_reason AS job_blocked
        FROM public.classroom_recording_files f LEFT JOIN public.classroom_jobs j ON j.id = 'file:' || f.provider_file_id
        WHERE f.lesson_id IN ${sql(lessonIds)} ORDER BY f.created_at, f.provider_file_id
      `;
      return rows.map((row) => ({ record: fromFileRow(row), job: row.job_status == null ? null : { status: String(row.job_status), attempts: Number(row.job_attempts), error: row.job_error == null ? null : String(row.job_error), blockedReason: row.job_blocked == null ? null : String(row.job_blocked) } }));
    },
    // The recording's row and its job locked (FOR UPDATE): of two retries at once, one requeues.
    async requeueFiling({ providerFileId, now, events }) {
      return sql.begin(async (tx) => {
        const [row] = await tx`SELECT * FROM public.classroom_recording_files WHERE provider_file_id = ${providerFileId} FOR UPDATE`;
        const refused = requeueRefusal(row ? fromFileRow(row) : null);
        if (refused) return { ok: false as const, reason: refused };
        const id = `file:${providerFileId}`;
        const [job] = await tx`SELECT id FROM public.classroom_jobs WHERE id = ${id} FOR UPDATE`;
        if (!job) await postgresTransaction(tx).insertJob({ id, type: "file_recording", lessonId: row.lesson_id == null ? null : String(row.lesson_id), providerFileId });
        await tx`UPDATE public.classroom_jobs SET status = 'pending', attempts = 0, available_at = ${new Date(now)}, error = NULL, blocked_reason = NULL, lease_owner = NULL, updated_at = NOW() WHERE id = ${id}`;
        await tx`UPDATE public.classroom_recording_files SET status = 'PENDING', updated_at = NOW() WHERE provider_file_id = ${providerFileId}`;
        for (const event of events) await postgresTransaction(tx).insertEvent(event);
        return { ok: true as const };
      }) as Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" | "ALREADY_ARCHIVED" | "HELD" | "NOT_FAILED" }>;
    },
    // Every change to a block under its row lock (FOR UPDATE), so changes to one block run one at
    // a time whatever the number of instances: the version check, the room's capacity and the
    // rotations all see the block as it is, and the change commits whole or not at all.
    async changeBlock(change) {
      return sql.begin(async (tx) => {
        const block = await readBlock(tx, change.blockId, true);
        const rooms = block ? await lessonsWith(tx, await tx`SELECT * FROM public.classroom_lessons WHERE block_id = ${block.id} ORDER BY id`) : [];
        const plan = planBlockChange(block, rooms, change);
        if (!plan.ok) return plan.result;
        if (plan.seat?.release) {
          await tx`UPDATE public.classroom_participants SET active = FALSE WHERE lesson_id = ${plan.seat.release.lessonId} AND participant_id = ${plan.seat.release.participantId}`;
        }
        if (plan.seat?.take) {
          const { lessonId, participant, existing } = plan.seat.take;
          if (existing) {
            await tx`
              UPDATE public.classroom_participants SET active = TRUE, seat = ${participant.seat ?? null}, role = ${participant.role}
              WHERE lesson_id = ${lessonId} AND participant_id = ${participant.id}
            `;
          } else {
            await tx`
              INSERT INTO public.classroom_participants (lesson_id, participant_id, code, role, member_id, active, seat)
              VALUES (${lessonId}, ${participant.id}, ${participant.code}, ${participant.role}, ${participant.memberId ?? null}, TRUE, ${participant.seat ?? null})
            `;
          }
        }
        for (const rotation of plan.rotations ?? []) {
          await tx`
            UPDATE public.classroom_participants
            SET participant_id = ${rotation.toId}, active = CASE WHEN ${rotation.deactivate} THEN FALSE ELSE active END
            WHERE lesson_id = ${rotation.lessonId} AND participant_id = ${rotation.fromId}
          `;
        }
        if (change.rotate) {
          await tx`UPDATE public.classroom_block_members SET join_key_hash = ${change.rotate.keyHash} WHERE block_id = ${change.blockId} AND member_id = ${change.rotate.memberId}`;
        }
        if (change.cancel) {
          await tx`UPDATE public.classroom_blocks SET cancelled = TRUE WHERE id = ${change.blockId}`;
          await tx`UPDATE public.classroom_lessons SET cancelled = TRUE, updated_at = NOW() WHERE block_id = ${change.blockId}`;
        }
        for (const event of change.events) await postgresTransaction(tx).insertEvent(event);
        const [row] = await tx`UPDATE public.classroom_blocks SET version = version + 1, updated_at = NOW() WHERE id = ${change.blockId} RETURNING version`;
        return { ok: true, version: Number(row.version), ...(plan.seat ? { seat: plan.seat.result } : {}) };
      }) as Promise<BlockChangeResult>;
    },
  };
}

function fromAnomalyRow(row: Record<string, unknown>): ClassroomAnomaly {
  return {
    lessonId: String(row.lesson_id),
    code: String(row.code),
    severity: row.severity as ClassroomAnomaly["severity"],
    firstSeenAt: asMs(row.first_seen_at) ?? 0,
    openedAt: asMs(row.opened_at) ?? 0,
    lastSeenAt: asMs(row.last_seen_at) ?? 0,
    resolvedAt: asMs(row.resolved_at),
    acknowledgedBy: row.acknowledged_by == null ? null : String(row.acknowledged_by),
    acknowledgedAt: asMs(row.acknowledged_at),
    note: row.note == null ? null : String(row.note),
  };
}

// The process-wide store, chosen like the other stores: PostgreSQL when a database URL is
// configured, otherwise a JSON file next to the other local data.
const globalForClassroom = globalThis as typeof globalThis & { ihearClassroomStore?: ClassroomStore; ihearClassroomSql?: postgres.Sql };

export function classroomStore(): ClassroomStore {
  if (globalForClassroom.ihearClassroomStore) return globalForClassroom.ihearClassroomStore;
  const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1" ? "" : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
  if (databaseUrl) {
    globalForClassroom.ihearClassroomSql ??= postgres(databaseUrl, {
      max: 3,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
      onnotice: () => undefined,
    });
    globalForClassroom.ihearClassroomStore = createPostgresClassroomStore(globalForClassroom.ihearClassroomSql);
  } else {
    const directory = process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data");
    globalForClassroom.ihearClassroomStore = createFileClassroomStore(path.join(directory, "classroom.json"));
  }
  return globalForClassroom.ihearClassroomStore;
}
