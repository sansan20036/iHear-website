import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

// Storage for the P3 classroom: lessons and their participants (codes only), recording consent
// (synthetic until the policy is approved), the event log the live overview is derived from,
// leased jobs, recording files and persisted anomaly records.
//
// The shared classroom logic in tools/recording-pathway/classroom relies on these guarantees:
// a transaction is all or nothing, event keys and job ids are unique, a job is claimed under a
// lease, and writes that finish a job only succeed with the current lease number (fencing).
// PostgreSQL provides them with constraints and row locks; the file store, used locally and in
// tests, provides them by running every operation one at a time.

export type ClassroomRole = "tutor" | "student";
export type ClassroomParticipant = {
  id: string;
  code: string;
  role: ClassroomRole;
  staffEmail?: string | null;
  joinKeyHash?: string | null;
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
};
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
  eligibility(id: string): Promise<ClassroomEvent | null>;
  withdrawalAt(id: string): Promise<number | null>;
  unknownJoinAt(id: string): Promise<number | null>;
};

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
  // D-4: a reissued link gives the student a new participant id. The id and key change, and the
  // rotation fact is stored, in one step; false when the student no longer has `fromId` (another
  // change came first), and then nothing changed.
  rotateStudent(lessonId: string, fromId: string, toId: string, keyHash: string, rotation: ClassroomEvent): Promise<boolean>;
  listConsents(codes: string[]): Promise<ClassroomConsent[]>;
  setConsent(consent: ClassroomConsent): Promise<void>;
  listStaffNotices(codes: string[]): Promise<ClassroomStaffNotice[]>;
  setStaffNotice(notice: ClassroomStaffNotice): Promise<void>;
  recordJoinToken(token: ClassroomJoinToken): Promise<void>;
  listJoinTokens(lessonId: string): Promise<ClassroomJoinToken[]>;
  syncAnomalies(lessonId: string, active: ActiveAnomaly[], now: number): Promise<void>;
  listAnomalies(lessonIds: string[]): Promise<ClassroomAnomaly[]>;
  acknowledgeAnomaly(input: { lessonId: string; code: string; actor: string; note: string; now: number }): Promise<ClassroomAnomaly | null>;
};

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
};

const emptyState = (): FileState => ({ lessons: [], consents: [], notices: [], tokens: [], events: {}, jobs: {}, files: {}, anomalies: [] });

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
    eligibility: (id: string) => clone(Object.values(state.events)
      .filter((event) => event.lessonId === id && event.type === "server.recording_eligibility")
      .sort((a, b) => a.occurredAt - b.occurredAt).pop() ?? null),
    withdrawalAt: (id: string) => earliest(id, (event) => PROTECTIVE_STOPS.includes(String(event.type))),
    unknownJoinAt: (id: string) => {
      const roster = new Set((state.lessons.find((item) => item.id === id)?.participants ?? []).map((entry) => entry.id));
      return earliest(id, (event) => (event.type === "session.user_joined" || event.type === "host.user_added") && !roster.has(String(event.participantId)));
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
    eligibility: async (id) => read.eligibility(id),
    withdrawalAt: async (id) => read.withdrawalAt(id),
    unknownJoinAt: async (id) => read.unknownJoinAt(id),
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
    rotateStudent: (lessonId, fromId, toId, keyHash, rotation) => run((state) => {
      const lesson = state.lessons.find((item) => item.id === lessonId);
      const student = lesson?.participants.find((entry) => entry.id === fromId && entry.role === "student");
      if (!lesson || !student || lesson.participants.some((entry) => entry.id === toId)) return false;
      student.id = toId;
      student.joinKeyHash = keyHash;
      if (!state.events[rotation.key]) state.events[rotation.key] = clone(rotation);
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
    participants: participants.filter((entry) => entry.lesson_id === row.id).map((entry) => ({
      id: String(entry.participant_id),
      code: String(entry.code),
      role: entry.role as ClassroomRole,
      staffEmail: entry.staff_email == null ? null : String(entry.staff_email),
      joinKeyHash: entry.join_key_hash == null ? null : String(entry.join_key_hash).trim(),
    })),
  }));
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
    async eligibility(id) {
      const [row] = await sql`
        SELECT data FROM public.classroom_events WHERE lesson_id = ${id} AND type = 'server.recording_eligibility' ORDER BY occurred_at DESC LIMIT 1
      `;
      return row ? fromEventRow(row) : null;
    },
    withdrawalAt: (id) => earliestEvent(sql, id, PROTECTIVE_STOPS),
    unknownJoinAt: (id) => unknownJoinAt(sql, id),
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
    async rotateStudent(lessonId, fromId, toId, keyHash, rotation) {
      // One transaction: the row keeps its code and consent link (person_code); only its id and
      // key change, and only if it still has the id this request read. Nothing references the id
      // by a foreign key, so no other row moves.
      return sql.begin(async (tx) => {
        const rows = await tx`
          UPDATE public.classroom_participants SET participant_id = ${toId}, join_key_hash = ${keyHash}
          WHERE lesson_id = ${lessonId} AND participant_id = ${fromId} AND role = 'student'
          RETURNING participant_id
        `;
        if (!rows.length) return false;
        await postgresTransaction(tx).insertEvent(rotation);
        return true;
      }) as Promise<boolean>;
    },
    async listConsents(codes) {
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
    },
    async setConsent(consent) {
      await sql`
        INSERT INTO public.classroom_consents (person_code, status, version, granted_at, withdrawn_at, expires_at, synthetic, recorded_by, updated_at)
        VALUES (${consent.personCode}, ${consent.status}, ${consent.version}, ${asDate(consent.grantedAt)}, ${asDate(consent.withdrawnAt)}, ${asDate(consent.expiresAt)}, ${consent.synthetic}, ${consent.recordedBy}, NOW())
        ON CONFLICT (person_code) DO UPDATE SET
          status = EXCLUDED.status, version = EXCLUDED.version, granted_at = EXCLUDED.granted_at, withdrawn_at = EXCLUDED.withdrawn_at,
          expires_at = EXCLUDED.expires_at, synthetic = EXCLUDED.synthetic, recorded_by = EXCLUDED.recorded_by, updated_at = NOW()
      `;
    },
    async listStaffNotices(codes) {
      if (!codes.length) return [];
      return (await sql`SELECT * FROM public.classroom_staff_notices WHERE person_code IN ${sql(codes)}`).map((row) => ({
        personCode: String(row.person_code),
        version: String(row.version),
        acknowledgedAt: asMs(row.acknowledged_at) ?? 0,
        recordedBy: String(row.recorded_by),
      }));
    },
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
