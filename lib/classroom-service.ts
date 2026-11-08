import { createHash, randomBytes, randomUUID } from "node:crypto";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { getJoinEligibility, getRecordingEligibility, JOIN_WINDOW_AFTER_MS, JOIN_WINDOW_BEFORE_MS, roomNameOf } from "../tools/recording-pathway/classroom/eligibility.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { fileRecording, ingestApiSnapshot, ingestHostReport, processJobs, storeEvent } from "../tools/recording-pathway/classroom/webhook-ingest.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { cancellationKey, deriveLesson, dueReconciliations, planActions } from "../tools/recording-pathway/classroom/lesson-state.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { buildDashboard, LABELS } from "../tools/recording-pathway/classroom/live-dashboard.mjs";
import type { ClassroomDrive } from "./classroom-drive";
import type { ClassroomProvider } from "./classroom-provider";
import type { ClassroomEvent, ClassroomLesson, ClassroomStore, RecordingFile } from "./classroom-store";
import { sessionReportsEnabled, vendorDeletionEnabled } from "./classroom-switches";

const RECORDING_LABELS: Record<string, string> = LABELS.recording;
const ANOMALY_LABELS: Record<string, string> = LABELS.anomaly;

// The classroom MVP on the website: lessons, entering a classroom, the tutor's reports, the
// periodic "tick" that starts and stops recording, re-checks state against the provider and
// files recordings, and the administrators' overview. The rules themselves live in the shared
// classroom modules; this file only connects them to storage, the provider and Drive.

export const LESSON_CODE = /^[A-Za-z0-9-]{1,40}$/;
export const PERSON_CODE = /^[A-Za-z0-9-]{1,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// Lessons in the overview and the tick: those that started within the last day or start within
// the next day. Older lessons are still looked after by the cron tick until their files settle.
export const OVERVIEW_WINDOW_MS = DAY_MS;

export class ClassroomInputError extends Error {
  constructor(message: string, readonly issues: Record<string, string>) {
    super(message);
  }
}

// Policy versions come from configuration. Until Justine approves the consent policy only
// synthetic versions are used.
export function consentPolicy() {
  return {
    consentVersion: process.env.CLASSROOM_CONSENT_VERSION || "synthetic-2026-11",
    staffNoticeVersion: process.env.CLASSROOM_STAFF_NOTICE_VERSION || "synthetic-2026-11",
  };
}

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const shortId = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, "")}`;

export type LessonInput = { code?: unknown; date?: unknown; time?: unknown; minutes?: unknown; tutorCode?: unknown; tutorEmail?: unknown; studentCode?: unknown };

// One tutor and one student: the MVP is one-to-one lessons. Times are Taipei time (UTC+8).
export async function createClassroomLesson({ store, input, actor, now }: { store: ClassroomStore; input: LessonInput; actor: string; now: number }) {
  const issues: Record<string, string> = {};
  const code = String(input.code ?? "").trim();
  const date = String(input.date ?? "").trim();
  const time = String(input.time ?? "").trim();
  const minutes = Number(input.minutes);
  const tutorCode = String(input.tutorCode ?? "").trim();
  const tutorEmail = String(input.tutorEmail ?? "").trim().toLowerCase();
  const studentCode = String(input.studentCode ?? "").trim();
  if (!LESSON_CODE.test(code)) issues.code = "Use 1–40 letters, digits or hyphens";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+08:00`))) issues.date = "Use YYYY-MM-DD";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) issues.time = "Use HH:MM";
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) issues.minutes = "Use 15–240 minutes";
  if (!PERSON_CODE.test(tutorCode)) issues.tutorCode = "Use 1–20 letters, digits or hyphens";
  if (!EMAIL.test(tutorEmail) || tutorEmail.length > 320) issues.tutorEmail = "Enter the tutor's sign-in email";
  if (!PERSON_CODE.test(studentCode)) issues.studentCode = "Use 1–20 letters, digits or hyphens";
  if (tutorCode && tutorCode === studentCode) issues.studentCode = "The student code must differ from the tutor code";
  if (Object.keys(issues).length) throw new ClassroomInputError("The lesson is not valid", issues);
  const startsAt = Date.parse(`${date}T${time}:00+08:00`);
  const joinKey = randomBytes(32).toString("base64url");
  const lesson: ClassroomLesson = {
    id: shortId("L"),
    code,
    date,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + minutes * 60_000).toISOString(),
    cancelled: false,
    createdBy: actor,
    createdAt: new Date(now).toISOString(),
    participants: [
      { id: shortId("P"), code: tutorCode, role: "tutor", staffEmail: tutorEmail, joinKeyHash: null },
      { id: shortId("P"), code: studentCode, role: "student", staffEmail: null, joinKeyHash: hashKey(joinKey) },
    ],
  };
  await store.createLesson(lesson);
  // The student's personal link is shown once; only its hash is kept.
  return { lesson, studentLink: studentLinkOf(lesson.id, joinKey) };
}

// The key goes behind #: browsers never send that part, so it reaches no server, log or other
// site; the classroom page reads it and takes it out of the address bar (2026-11-06).
const studentLinkOf = (lessonId: string, joinKey: string) => `/classroom/${lessonId}#k=${joinKey}`;

export const LESSON_ACCESS_ACTIONS = ["cancel", "revoke_link", "reissue_link"] as const;
export type LessonAccessAction = (typeof LESSON_ACCESS_ACTIONS)[number];

// An owner's change to who can enter a lesson. Cancelling stops the link and the tutor's
// sign-in alike; revoking replaces the student's key with one nobody is given; reissuing replaces
// it with a new one, shown in this answer only. Either way the old link gets no session token
// from then on: entering, reconnecting and the status all go through the same check.
//
// The page itself leaves the room when its next check is refused: the student's status every 15
// seconds, the tutor's report every 10–30 seconds on a cancel. Beyond that (2026-11-08, P1+P3):
//   D-1  revoking or reissuing opens a new generation of the lesson's room: new tokens lead
//        there, and the legitimate people's pages move to it at their next check. A session
//        already running keeps its name; tokens handed out before the change still lead to the
//        old room only, until they expire (Zoom's shortest is 30 minutes).
//   D-4  reissuing gives the student a new participant id, so in the old room the old link's
//        holder is no longer this student, and is treated as someone who should not be there.
//   D-5  the tick then ends the old room once everyone legitimate has moved (sooner, and with any
//        recording there stopped at once, when someone who should not be there is in it).
//   D-2  cancelling stops recording and ends every live session of the lesson (the route runs
//        stopRecordingForCancelledLesson right after).
// Ending a session needs Zoom's session id, which the server learns from webhooks or a verified
// report from the tutor's page; until then nothing can be ended at Zoom and the tick retries.
export const roomGenerationKey = (lessonId: string, generation: number) => `room_generation:${lessonId}:${generation}`;
export function roomGeneration(events: ClassroomEvent[]) {
  return events.filter((event) => event.type === "server.room_generation").reduce((top, event) => Math.max(top, Number(event.generation) || 0), 0);
}

export async function changeLessonAccess({ store, lessonId, action, studentCode, now = Date.now() }: {
  store: ClassroomStore; lessonId: string; action: unknown; studentCode?: unknown; now?: number;
}) {
  if (!LESSON_ACCESS_ACTIONS.includes(action as LessonAccessAction)) {
    return { status: 400, body: { error: `Use one of: ${LESSON_ACCESS_ACTIONS.join(", ")}`, code: "INVALID_ACTION" } };
  }
  const lesson = await store.lesson(lessonId);
  if (!lesson) return { status: 404, body: { error: "Lesson not found", code: "LESSON_NOT_FOUND" } };
  if (action === "cancel") {
    if (lesson.cancelled) return { status: 200, body: { ok: true, cancelled: true, changed: false } };
    await store.setLessonCancelled(lesson.id);
    return { status: 200, body: { ok: true, cancelled: true, changed: true } };
  }
  const students = lesson.participants.filter((entry) => entry.role === "student");
  const code = typeof studentCode === "string" && studentCode.trim() ? studentCode.trim() : null;
  // One-to-one lessons have one student, who need not be named.
  const student = code ? students.find((entry) => entry.code === code) : students.length === 1 ? students[0] : undefined;
  if (!student) return { status: 404, body: { error: "No such student in this lesson", code: "STUDENT_NOT_FOUND" } };
  if (action === "reissue_link" && lesson.cancelled) {
    return { status: 409, body: { error: "The lesson is cancelled", code: "LESSON_CANCELLED" } };
  }
  // D-1: a new generation of the room first, so that whatever happens next no new token leads to
  // the room the old link may still be in. Two changes at once share the same next generation.
  const generation = roomGeneration(await store.eventsFor([lesson.id])) + 1;
  await serverEvent(store, [{ source: "server", type: "server.room_generation", lessonId: lesson.id, generation, reason: String(action), occurredAt: now, receivedAt: now, key: roomGenerationKey(lesson.id, generation) }]);
  const joinKey = randomBytes(32).toString("base64url");
  // Another change may have given the student a new id since this request read it (D-4): look
  // the student up again by code before giving up.
  const again = async () => (await store.lesson(lesson.id))?.participants.find((entry) => entry.role === "student" && entry.code === student.code);
  if (action === "revoke_link") {
    let target: typeof student | undefined = student;
    for (let attempt = 0; target && attempt < 3; attempt += 1) {
      if (await store.replaceStudentKeyHash(lesson.id, target.id, hashKey(joinKey))) {
        return { status: 200, body: { ok: true, revoked: true, studentCode: student.code } };
      }
      target = await again();
    }
    return { status: 404, body: { error: "No such student in this lesson", code: "STUDENT_NOT_FOUND" } };
  }
  // D-4: the reissued link belongs to a new participant id. If another change rotated the
  // student first, read the student again and rotate from there (the later link wins).
  let current = student;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const toId = shortId("P");
    const rotation: ClassroomEvent = { source: "server", type: "server.participant_rotated", lessonId: lesson.id, from: current.id, to: toId, occurredAt: now, receivedAt: now, key: `server.participant_rotated:${lesson.id}:${toId}` };
    if (await store.rotateStudent(lesson.id, current.id, toId, hashKey(joinKey), rotation)) {
      return { status: 200, body: { ok: true, reissued: true, studentCode: student.code, studentLink: studentLinkOf(lesson.id, joinKey) } };
    }
    const fresh = await again();
    if (!fresh) break;
    current = fresh;
  }
  return { status: 404, body: { error: "No such student in this lesson", code: "STUDENT_NOT_FOUND" } };
}

// "My lessons" on /classroom: the signed-in tutor's own lessons from a day ago to two weeks
// ahead, with codes and times only. Whether one can be entered now follows the same time window
// as the entry check, which still decides at the door. Students enter with their personal link
// and have no list in phase 1.
const MY_LESSONS_AHEAD_MS = 14 * DAY_MS;

export async function myClassroomLessons({ store, email, now }: { store: ClassroomStore; email: string; now: number }) {
  if (!email) return [];
  const lessons = await store.listLessonsForStaff(email, { from: now - DAY_MS, to: now + MY_LESSONS_AHEAD_MS });
  return lessons.map((lesson) => {
    const opensAt = Date.parse(lesson.startsAt) - JOIN_WINDOW_BEFORE_MS;
    const closesAt = Date.parse(lesson.endsAt) + JOIN_WINDOW_AFTER_MS;
    const state = lesson.cancelled ? "cancelled" : now < opensAt ? "before" : now <= closesAt ? "open" : "ended";
    return {
      lessonId: lesson.id,
      code: lesson.code,
      startsAt: lesson.startsAt,
      endsAt: lesson.endsAt,
      opensAt: new Date(opensAt).toISOString(),
      closesAt: new Date(closesAt).toISOString(),
      state,
      participantCode: lesson.participants.find((entry) => entry.role === "tutor" && entry.staffEmail === email)?.code ?? null,
      studentCodes: lesson.participants.filter((entry) => entry.role === "student").map((entry) => entry.code),
    };
  });
}

// Only what the shared rules need: never e-mail addresses or link hashes.
function forRules(lesson: ClassroomLesson) {
  return { ...lesson, participants: lesson.participants.map(({ id, code, role }) => ({ id, code, role })) };
}

function blockedEvent(lessonId: string, reason: string, now: number): ClassroomEvent {
  return { source: "server", type: "server.join_blocked", lessonId, reason, occurredAt: now, receivedAt: now, key: `server.join_blocked:${lessonId}:${now}:${randomUUID()}` };
}

// The person behind a request: a student by the personal link, or the lesson's tutor by sign-in.
// Entering the classroom and reading its status use the same check, which never looks at consent.
function admitted(lesson: ClassroomLesson, key: string | null | undefined, sessionEmail: string | null | undefined, now: number) {
  const keyHash = key ? hashKey(key) : null;
  const participant = (keyHash && lesson.participants.find((entry) => entry.role === "student" && entry.joinKeyHash === keyHash))
    || (sessionEmail && lesson.participants.find((entry) => entry.role === "tutor" && entry.staffEmail === sessionEmail))
    || null;
  const identity = participant
    ? { verified: true, participantId: participant.id, method: participant.role === "tutor" ? "staff_login" : "join_link" }
    : null;
  const decision = getJoinEligibility({ lesson: forRules(lesson), participantId: participant?.id ?? "", identity, now });
  return { participant, decision };
}

export async function joinClassroom({ store, provider, lessonId, key, sessionEmail, now }: {
  store: ClassroomStore; provider: ClassroomProvider; lessonId: string; key?: string | null; sessionEmail?: string | null; now: number;
}) {
  const lesson = await store.lesson(lessonId);
  if (!lesson) return { status: 404, body: { error: "Lesson not found", code: "LESSON_NOT_FOUND" } };
  const { participant, decision } = admitted(lesson, key, sessionEmail, now);
  if (!decision.allowed) {
    await store.transaction((tx) => storeEvent(tx, blockedEvent(lesson.id, decision.reason, now)));
    return { status: 403, body: { error: "You cannot enter this classroom", code: decision.reason } };
  }
  const rules = forRules(lesson) as ClassroomLesson;
  // New tokens lead to the room's current generation (D-1).
  const generation = roomGeneration(await store.eventsFor([lesson.id]));
  const prepared = provider.prepareJoin
    ? await provider.prepareJoin({ lesson: rules, participant: participant!, now, generation })
    : { kind: "sdk" as const, ...provider.sessionToken({ lesson: rules, participant: participant!, now, generation }) };
  // The page compares this name with the room it is in, so every SDK answer carries it.
  const token = prepared.kind === "sdk" ? { ...prepared, sessionName: prepared.sessionName ?? roomNameOf(lesson.id, generation) } : prepared;
  await store.recordJoinToken({ tokenHash: hashKey(token.token), lessonId: lesson.id, participantId: participant!.id, issuedAt: token.issuedAt, expiresAt: token.expiresAt });
  return {
    status: 200,
    body: {
      ok: true,
      provider: provider.name,
      lesson: { code: lesson.code, startsAt: lesson.startsAt, endsAt: lesson.endsAt },
      role: participant!.role,
      participantCode: participant!.code,
      // The token goes only to the media adapter. LCIC's address carries its own login.
      session: token.kind === "embed"
        ? { kind: "embed", embedUrl: token.embedUrl, recordingDisabled: token.recordingDisabled, expiresAt: new Date(token.expiresAt).toISOString() }
        : { kind: "sdk", token: token.token, ...(token.sessionName ? { sessionName: token.sessionName } : {}), expiresAt: new Date(token.expiresAt).toISOString() },
      // Only the tutor's page reports the vendor's session id, and only where it is confirmed.
      ...(participant!.role === "tutor" && sessionReportsEnabled() ? { sessionReports: true } : {}),
    },
  };
}

// Whether the lesson may be recorded right now, from what the server decided: the whole
// roster's consent, no withdrawal since, no emergency stop and no cancellation. The tutor's page
// stops recording when it is not allowed, and says "not decided yet" rather than "not recorded"
// before the decision.
const NO_MORE_RECORDING = new Set(["server.consent_withdrawn", "server.emergency_stop", "server.lesson_cancelled"]);
export function recordingDecision(events: ClassroomEvent[]) {
  const decision = events.filter((event) => event.type === "server.recording_eligibility").sort((a, b) => a.occurredAt - b.occurredAt).pop();
  return {
    decided: Boolean(decision),
    allowed: decision?.eligible === true && !events.some((event) => NO_MORE_RECORDING.has(String(event.type))),
  };
}

// A cancelled lesson's recording is stopped by the server (2026-11-08, P1+P3 integration). P3's
// cancel calls this right after marking the lesson cancelled: the cancellation is stored with its
// time (the same key the tick uses, so it is stored once), and the lesson's tick runs at once,
// which sends the stop on both channels. The tick sends it again at 30 seconds and ends the
// session at 60 seconds if the provider has not confirmed, and never starts a recording for the
// lesson again. If this call fails part-way, the scheduled tick finds the lesson's cancelled flag
// and does the same, so the stop never depends on this request or on any browser.
export async function stopRecordingForCancelledLesson({ store, provider, drive, lessonId, now }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; lessonId: string; now: number;
}) {
  const lesson = await store.lesson(lessonId);
  if (!lesson) return { status: 404, body: { error: "Lesson not found", code: "LESSON_NOT_FOUND" } };
  if (!lesson.cancelled) return { status: 409, body: { error: "The lesson is not cancelled", code: "NOT_CANCELLED" } };
  await serverEvent(store, [{ source: "server", type: "server.lesson_cancelled", lessonId, occurredAt: now, receivedAt: now, key: cancellationKey(lessonId) }]);
  let ticked = true;
  try {
    await runClassroomTick({ store, provider, drive, now, lessonIds: [lessonId], workerId: `cancel-${lessonId}` });
  } catch {
    // The cancellation is stored; the next scheduled tick sends the stop.
    ticked = false;
  }
  const events = await store.eventsFor([lessonId]);
  const state = deriveLesson(forRules(lesson), events, now);
  return {
    status: 200,
    body: {
      ok: true,
      ticked,
      stopRequested: events.some((event) => event.type === "server.stop_requested" && event.reason === "lesson_cancelled"),
      // CONFIRMED only on the provider's word; WAITING while a recording may still be on.
      stopState: state.cancellation?.stopState ?? null,
      recording: { status: state.recording.status, basis: state.recording.basis, label: RECORDING_LABELS[state.recording.status] ?? state.recording.status },
    },
  };
}

// An administrator's emergency stop: from now on the lesson is never recorded. The stop goes to
// the provider at once (the same protective sequence as a withdrawal: both channels now, again
// at 30 seconds, and the session is ended at 60 seconds if the provider has not confirmed), the
// tutor's page is told recording is no longer allowed, and anything recorded is kept out of the
// normal folders. Pressing it again changes nothing.
export async function emergencyStopRecording({ store, provider, drive, lessonId, now }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; lessonId: string; now: number;
}) {
  const lesson = await store.lesson(lessonId);
  if (!lesson) return { status: 404, body: { error: "Lesson not found", code: "LESSON_NOT_FOUND" } };
  const already = (await store.eventsFor([lessonId])).some((event) => event.type === "server.emergency_stop");
  if (!already) {
    await serverEvent(store, [{ source: "server", type: "server.emergency_stop", lessonId, occurredAt: now, receivedAt: now, key: `server.emergency_stop:${lessonId}` }]);
  }
  await runClassroomTick({ store, provider, drive, now, lessonIds: [lessonId], workerId: `emergency-${lessonId}` });
  const events = await store.eventsFor([lessonId]);
  const state = deriveLesson(forRules(lesson), events, now);
  return {
    status: 200,
    body: {
      ok: true,
      alreadyStopped: already,
      stopRequested: events.some((event) => event.type === "server.stop_requested" && event.reason === "emergency_stop"),
      recording: { status: state.recording.status, basis: state.recording.basis, label: RECORDING_LABELS[state.recording.status] ?? state.recording.status },
    },
  };
}

// What everyone in the room may see about recording, so the student is told as plainly as the
// tutor whether the lesson is being recorded. It only reads: nothing is stored, no tick runs and
// no token is issued, and it answers with codes and the recording state only.
export async function classroomStatus({ store, lessonId, key, sessionEmail, now }: {
  store: ClassroomStore; lessonId: string; key?: string | null; sessionEmail?: string | null; now: number;
}) {
  const lesson = await store.lesson(lessonId);
  if (!lesson) return { status: 404, body: { error: "Lesson not found", code: "LESSON_NOT_FOUND" } };
  const { decision } = admitted(lesson, key, sessionEmail, now);
  if (!decision.allowed) return { status: 403, body: { error: "You cannot see this classroom", code: decision.reason } };
  const events = await store.eventsFor([lessonId]);
  const state = deriveLesson(forRules(lesson), events, now);
  const recording = recordingDecision(events);
  return {
    status: 200,
    body: {
      ok: true,
      recordingAllowed: recording.allowed,
      recordingDecided: recording.decided,
      recording: { status: state.recording.status, basis: state.recording.basis, label: RECORDING_LABELS[state.recording.status] ?? state.recording.status },
      // The room new tokens lead to (D-1); a page in another room moves there (D-5).
      room: roomNameOf(lesson.id, roomGeneration(events)),
    },
  };
}

// The tutor's page reports while its room can be open: from when the door opens until an hour
// after it closes. A lesson may run over, and its last "left the room" may come late; a token
// handed out at the last moment lasts 30 minutes, which the hour covers. Reports outside that
// time, or for a cancelled lesson, are refused before anything is stored, so they never set off
// the lesson's work (and its calls to the provider). Told the lesson is cancelled, the tutor's
// page leaves the room.
export const HOST_REPORT_AFTER_MS = 60 * 60_000;

export async function recordHostReport({ store, provider, drive, lessonId, sessionEmail, report, now }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; lessonId: string; sessionEmail: string; report: unknown; now: number;
}) {
  const lesson = await store.lesson(lessonId);
  const tutor = lesson?.participants.find((entry) => entry.role === "tutor");
  if (!lesson || !tutor || !sessionEmail || tutor.staffEmail !== sessionEmail) return { status: 403, body: { error: "Only this lesson's tutor can report", code: "FORBIDDEN" } };
  if (lesson.cancelled) return { status: 403, body: { error: "The lesson is cancelled", code: "LESSON_CANCELLED" } };
  const opensAt = Date.parse(lesson.startsAt) - JOIN_WINDOW_BEFORE_MS;
  const lastReportAt = Date.parse(lesson.endsAt) + JOIN_WINDOW_AFTER_MS + HOST_REPORT_AFTER_MS;
  if (!(now >= opensAt && now <= lastReportAt)) return { status: 403, body: { error: "The classroom is not open now", code: "OUTSIDE_JOIN_WINDOW" } };
  // A session id is kept only where reported ids are confirmed with the vendor; elsewhere it is
  // answered like any report and dropped.
  const dropped = (report as { type?: unknown } | null)?.type === "session" && !sessionReportsEnabled();
  if (!dropped) {
    const result = await ingestHostReport({ report, lessonId, tutorId: tutor.id, now, store });
    if (result.status !== 200) return result;
  }
  await runClassroomTick({ store, provider, drive, now, lessonIds: [lessonId], workerId: `host-${lessonId}` });
  const events = await store.eventsFor([lessonId]);
  const state = deriveLesson(forRules(lesson), events, now);
  const decision = recordingDecision(events);
  return {
    status: 200,
    body: {
      ok: true,
      recordingAllowed: decision.allowed,
      recordingDecided: decision.decided,
      recording: { status: state.recording.status, basis: state.recording.basis, label: RECORDING_LABELS[state.recording.status] ?? state.recording.status },
      // The room new tokens lead to (D-1); the tutor's page in another room moves there (D-5).
      room: roomNameOf(lesson.id, roomGeneration(events)),
    },
  };
}

type Action = { key: string; type: string; lessonId: string; attempt?: number; reason?: string; channels?: string[]; userKey?: string; code?: string; targets?: string[] };

async function serverEvent(store: ClassroomStore, events: ClassroomEvent[]) {
  await store.transaction(async (tx) => {
    for (const event of events) await storeEvent(tx, event);
  });
}

async function callSafely(call: () => Promise<{ ok: boolean; httpStatus: number }>) {
  try {
    return await call();
  } catch {
    return { ok: false, httpStatus: 0 };
  }
}

// One request per session the plan named (G-3), each answer kept; with none named, one request
// for the provider's latest known session (Zoom's adapter answers 409 when it knows none, G-1).
// What is stored says which sessions were named, so a later plan knows which ones it reached.
async function toSessions(targets: string[] | undefined, call: (sessionId?: string) => Promise<{ ok: boolean; httpStatus: number }>) {
  if (!targets?.length) {
    const result = await callSafely(() => call(undefined));
    return { ok: result.ok, httpStatus: result.httpStatus, ...(targets ? { targets, results: [] } : {}) };
  }
  const results: { sessionId: string; ok: boolean; httpStatus: number }[] = [];
  for (const sessionId of targets) {
    const result = await callSafely(() => call(sessionId));
    results.push({ sessionId, ok: result.ok, httpStatus: result.httpStatus });
  }
  return { ok: results.every((result) => result.ok), httpStatus: results[0].httpStatus, targets, results };
}

async function perform({ store, provider, lesson, action, now }: { store: ClassroomStore; provider: ClassroomProvider; lesson: ClassroomLesson; action: Action; now: number }) {
  const base = { source: "server", lessonId: lesson.id, occurredAt: now, receivedAt: now };
  switch (action.type) {
    case "DECIDE_RECORDING": {
      const students = lesson.participants.filter((entry) => entry.role === "student");
      const tutor = lesson.participants.find((entry) => entry.role === "tutor");
      const consents = (await store.listConsents(students.map((entry) => entry.code))).flatMap((record) => {
        const student = students.find((entry) => entry.code === record.personCode);
        return student ? [{ participantId: student.id, status: record.status, version: record.version, grantedAt: record.grantedAt, withdrawnAt: record.withdrawnAt, expiresAt: record.expiresAt }] : [];
      });
      const notices = tutor ? (await store.listStaffNotices([tutor.code])).map((record) => ({ participantId: tutor.id, version: record.version, acknowledgedAt: record.acknowledgedAt })) : [];
      const decision = getRecordingEligibility({ lesson: forRules(lesson), consents, notices, policy: consentPolicy(), now });
      await serverEvent(store, [{ ...base, type: "server.recording_eligibility", eligible: decision.eligible, reason: decision.reason, count: "count" in decision ? decision.count : 0, key: action.key }]);
      return;
    }
    case "START_RECORDING": {
      // The request and the provider's answer are stored together; 202 only means "accepted".
      const { targets, results, ...result } = await toSessions(action.targets, (sessionId) => provider.startRecording(lesson, sessionId));
      const named = targets ? { targets, results } : {};
      await serverEvent(store, [
        { ...base, type: "server.start_requested", attempt: action.attempt, key: action.key, ...named },
        { ...base, type: "server.start_response", attempt: action.attempt, ok: result.ok, httpStatus: result.httpStatus, key: `${action.key}:response`, ...named },
      ]);
      return;
    }
    case "STOP_RECORDING": {
      // Accepted (202) is a request, never a stop: only Zoom's own word confirms it.
      const { targets, results, ok } = await toSessions(action.targets, (sessionId) => provider.stopRecording(lesson, sessionId));
      await serverEvent(store, [{ ...base, type: "server.stop_requested", reason: action.reason, attempt: action.attempt, channels: action.channels, ok, key: action.key, ...(targets ? { targets, results } : {}) }]);
      return;
    }
    case "END_SESSION": {
      // Accepted (204) is a request, never an end: only Zoom's notice or answer confirms it (G-2).
      const { targets, results, ok } = await toSessions(action.targets, (sessionId) => provider.endSession(lesson, sessionId));
      await serverEvent(store, [{ ...base, type: "server.session_end_requested", reason: action.reason, ok, key: action.key, ...(targets ? { targets, results } : {}) }]);
      return;
    }
    case "REMOVE_USER": {
      const result = await callSafely(() => provider.removeUser(lesson, String(action.userKey)));
      await serverEvent(store, [{ ...base, type: "server.remove_requested", userKey: action.userKey, ok: result.ok, key: action.key }]);
      return;
    }
    case "RECORD_CANCELLATION":
      // The lesson is cancelled but its cancellation was not stored: store it now, so that the
      // stop's retries and the session end are timed from here.
      await serverEvent(store, [{ ...base, type: "server.lesson_cancelled", key: action.key }]);
      return;
    case "NOTIFY_ADMIN":
      // No e-mail in the MVP: the record itself is the notice, and the overview shows it at once.
      await serverEvent(store, [{ ...base, type: "server.admin_notified", code: action.code, key: action.key }]);
      return;
    default:
      return;
  }
}

const RECONCILED = new Set(["api.snapshot", "server.reconcile_failed", "server.reconcile_partial"]);
function lastReconciled(events: ClassroomEvent[]) {
  const times = events.filter((event) => RECONCILED.has(event.type)).map((event) => event.occurredAt);
  return times.length ? Math.max(...times) : null;
}

// What a reconciliation stored. An answer that held recordings but no details of the session
// (the vendor no longer describes it) is noted too, so the next look waits its turn.
async function noteReconciliation(store: ClassroomStore, lessonId: string, stored: { status: number }, snapshot: { details: unknown } | null, now: number) {
  const minute = Math.floor(now / 60_000);
  if (stored.status !== 200) {
    await serverEvent(store, [{ source: "server", type: "server.reconcile_failed", lessonId, occurredAt: now, receivedAt: now, key: `server.reconcile_failed:${lessonId}:${minute}` }]);
  } else if (!snapshot?.details) {
    await serverEvent(store, [{ source: "server", type: "server.reconcile_partial", lessonId, occurredAt: now, receivedAt: now, key: `server.reconcile_partial:${lessonId}:${minute}` }]);
  }
}

// Session ids the tutor's page reported, checked with the vendor before anything acts on them.
// A confirmed id becomes trusted (server.session_verified, which knownSessions reads); an id the
// vendor does not know, or knows as another lesson's, is refused (server.session_rejected, which
// the overview raises). Each id is asked about once and, while the vendor cannot answer, at most
// once a minute.
async function confirmReportedSessions({ store, provider, lesson, events, now }: {
  store: ClassroomStore; provider: ClassroomProvider; lesson: ClassroomLesson; events: ClassroomEvent[]; now: number;
}) {
  if (!provider.verifySession) return 0;
  const minute = Math.floor(now / 60_000);
  const settled = new Set(events.filter((event) => event.type === "server.session_verified" || event.type === "server.session_rejected").map((event) => String(event.reportedSessionId)));
  const askedNow = new Set(events.filter((event) => event.type === "server.session_unconfirmed" && event.minute === minute).map((event) => String(event.reportedSessionId)));
  const reported = [...new Set(events.filter((event) => event.type === "host.session").map((event) => String(event.reportedSessionId)))];
  let asked = 0;
  for (const id of reported) {
    if (settled.has(id) || askedNow.has(id)) continue;
    const check = await provider.verifySession(lesson, id).catch(() => null);
    const base = { source: "server", lessonId: lesson.id, reportedSessionId: id, occurredAt: now, receivedAt: now };
    let event: ClassroomEvent;
    if (check?.verified) event = { ...base, type: "server.session_verified", providerSessionId: id, ended: check.ended, ...(check.name ? { sessionName: check.name } : {}), key: `server.session_verified:${lesson.id}:${id}` };
    else if (check) event = { ...base, type: "server.session_rejected", reason: check.reason, key: `server.session_rejected:${lesson.id}:${id}` };
    else event = { ...base, type: "server.session_unconfirmed", minute, key: `server.session_unconfirmed:${lesson.id}:${id}:${minute}` };
    await serverEvent(store, [event]);
    asked += 1;
  }
  return asked;
}

const groupByLesson = (lessons: ClassroomLesson[], events: ClassroomEvent[]) => {
  const map = new Map<string, ClassroomEvent[]>(lessons.map((lesson) => [lesson.id, []]));
  for (const event of events) map.get(String(event.lessonId))?.push(event);
  return map;
};

// The lessons the overview and the scheduled tick look after: those around now, and older ones
// whose recordings are still on their way to Drive (blocked by a full Drive, say), so a filing
// problem never drops out of sight before it is solved.
async function lessonsInView(store: ClassroomStore, now: number) {
  const around = await store.listLessons({ from: now - OVERVIEW_WINDOW_MS, to: now + OVERVIEW_WINDOW_MS });
  const known = new Set(around.map((lesson) => lesson.id));
  const filing = (await store.listOpenFilingLessonIds()).filter((id) => !known.has(id));
  const older = (await Promise.all(filing.map((id) => store.lesson(id)))).filter((lesson): lesson is ClassroomLesson => Boolean(lesson));
  return [...older, ...around];
}

// One pass of the server's work: decide and act for each lesson, re-check against the provider
// when facts are late or missing, file finished recordings, and update the anomaly records.
// Safe to run often and from several places: every action has a fixed key.
//
// Filing gets a time budget. Ticks that run inside a request (a heartbeat, the overview, a
// webhook) keep it short; the scheduled tick gives it most of the function's time. A recording
// that does not fit carries on in the next tick from the byte Drive confirmed.
export async function runClassroomTick({ store, provider, drive, now, lessonIds, workerId = "tick", heavyBudget = 20, maxJobs = 5, filingBudgetMs = 10_000, filingSafetyMs = 5_000 }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; now: number; lessonIds?: string[]; workerId?: string; heavyBudget?: number; maxJobs?: number;
  filingBudgetMs?: number; filingSafetyMs?: number;
}) {
  const startedAt = Date.now();
  // The tick's own time: starts at `now` and moves with the real time spent.
  const clock = () => now + (Date.now() - startedAt);
  const lessons = lessonIds
    ? (await Promise.all(lessonIds.map((id) => store.lesson(id)))).filter((lesson): lesson is ClassroomLesson => Boolean(lesson))
    : await lessonsInView(store, now);
  const ids = lessons.map((lesson) => lesson.id);
  let byLesson = groupByLesson(lessons, await store.eventsFor(ids));
  const summary = { lessons: lessons.length, sessionsChecked: 0, actions: 0, reconciliations: 0, jobs: 0, continued: 0 };
  // Reported session ids first, so a confirmed one can be used by this tick's actions.
  if (sessionReportsEnabled()) {
    for (const lesson of lessons) summary.sessionsChecked += await confirmReportedSessions({ store, provider, lesson, events: byLesson.get(lesson.id) ?? [], now });
    if (summary.sessionsChecked) byLesson = groupByLesson(lessons, await store.eventsFor(ids));
  }
  for (const lesson of lessons) {
    for (const action of planActions(forRules(lesson), byLesson.get(lesson.id) ?? [], now) as Action[]) {
      await perform({ store, provider, lesson, action, now });
      summary.actions += 1;
    }
  }
  byLesson = groupByLesson(lessons, await store.eventsFor(ids));
  const lastReconciledAt = new Map(lessons.map((lesson) => [lesson.id, lastReconciled(byLesson.get(lesson.id) ?? []) ?? -Infinity]));
  for (const due of dueReconciliations(lessons.map(forRules), byLesson, now, { lastReconciledAt, heavyBudget }) as { lessonId: string }[]) {
    const lesson = lessons.find((entry) => entry.id === due.lessonId)!;
    const snapshot = await provider.snapshot(lesson).catch(() => null);
    // Named, so the Recording Adapter maps this vendor's recording types.
    const stored = snapshot ? await ingestApiSnapshot({ snapshot: { ...snapshot, provider: provider.name }, now, store }) : { status: 503 };
    await noteReconciliation(store, lesson.id, stored, snapshot, now);
    summary.reconciliations += 1;
  }
  const results: { status?: string }[] = await processJobs({
    store,
    clock,
    deadline: clock() + filingBudgetMs,
    safetyMs: filingSafetyMs,
    workerId,
    max: maxJobs,
    handlers: {
      file_recording: ({ job, leaseVersion, clock: time, deadline, leaseMs }: { job: Record<string, unknown>; leaseVersion: number; clock: () => number; deadline: number; leaseMs: number }) =>
        fileRecording({
          store,
          drive,
          download: (record: RecordingFile, range: { start: number; end: number }) => provider.download(record, range),
          job,
          leaseVersion,
          clock: time,
          deadline,
          leaseMs,
          rootFolderId: drive.rootFolderId,
          options: { safetyMs: filingSafetyMs },
        }),
      delete_vendor_copy: async ({ job, leaseVersion }: { job: { id: string; providerFileId: string | null; lessonId?: string | null }; leaseVersion: number }) => {
        // Deleting the vendor's copy is off (lib/classroom-switches.ts): the copy is kept, the
        // vendor is not asked, and that it was kept is recorded.
        if (!vendorDeletionEnabled()) {
          const at = clock();
          await serverEvent(store, [{ source: "p1", type: "p1.vendor_copy_kept", lessonId: job.lessonId ?? null, providerFileId: job.providerFileId, occurredAt: at, receivedAt: at, key: `p1.vendor_copy_kept:${job.providerFileId}` }]);
          await store.completeJob({ jobId: job.id, leaseVersion });
          return { status: "VENDOR_COPY_KEPT" };
        }
        const result = await provider.deleteRecording(job);
        if (!result.ok) throw new Error(`vendor copy not deleted (${result.httpStatus})`);
        await store.completeJob({ jobId: job.id, leaseVersion });
        return { status: "VENDOR_COPY_DELETED" };
      },
    },
  });
  summary.jobs = results.length;
  summary.continued = results.filter((result) => result.status === "CONTINUE").length;
  byLesson = groupByLesson(lessons, await store.eventsFor(ids));
  for (const lesson of lessons) {
    const state = deriveLesson(forRules(lesson), byLesson.get(lesson.id) ?? [], now);
    await store.syncAnomalies(lesson.id, state.anomalies.map((item: { code: string; severity: "error" | "warning" }) => ({ code: item.code, severity: item.severity })), now);
  }
  return summary;
}

// An administrator's "check now": ask the provider for the lesson's current state whatever the
// schedule says, then let the tick act on what it found.
export async function reconcileLessonNow({ store, provider, drive, lessonId, now }: {
  store: ClassroomStore; provider: ClassroomProvider; drive: ClassroomDrive; lessonId: string; now: number;
}) {
  const lesson = await store.lesson(lessonId);
  if (!lesson) return { status: 404, body: { error: "Lesson not found", code: "LESSON_NOT_FOUND" } };
  const snapshot = await provider.snapshot(lesson).catch(() => null);
  const stored = snapshot ? await ingestApiSnapshot({ snapshot: { ...snapshot, provider: provider.name }, now, store }) : { status: 503 };
  await noteReconciliation(store, lessonId, stored, snapshot, now);
  await runClassroomTick({ store, provider, drive, now, lessonIds: [lessonId], workerId: `reconcile-${lessonId}` });
  return { status: 200, body: { ok: true, reconciled: stored.status === 200 } };
}

// What the administrators' overview shows: the four groups of cards (codes only), the anomaly
// records with how they were handled, and the lessons in the window.
type FilingItemCard = { driveFileId: string | null; destination: string | null; link?: string | null };
type DashboardCard = { filing: { items: FilingItemCard[] } };

// Where each filed copy can be opened: a Google Drive file's page for a copy filed in Google Drive
// (an owner of the test folder sees it there); nothing for a copy in the local stand-in, whose
// files are on this computer. It goes by where each copy was filed, not by today's setting.
function withDriveLinks(dashboard: { groups: Record<string, DashboardCard[]> }) {
  for (const cards of Object.values(dashboard.groups)) {
    for (const card of cards) {
      for (const item of card.filing.items) {
        item.link = item.destination === "google" && item.driveFileId ? `https://drive.google.com/file/d/${encodeURIComponent(item.driveFileId)}/view` : null;
      }
    }
  }
  return dashboard;
}

export async function classroomOverview({ store, now }: { store: ClassroomStore; now: number }) {
  const lessons = await lessonsInView(store, now);
  const ids = lessons.map((lesson) => lesson.id);
  const [events, anomalies] = await Promise.all([store.eventsFor(ids), store.listAnomalies(ids)]);
  const codeOf = new Map(lessons.map((lesson) => [lesson.id, lesson.code]));
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  return {
    dashboard: withDriveLinks(buildDashboard({ lessons: lessons.map(forRules), events, now })),
    anomalies: anomalies.map((item) => ({
      lessonCode: codeOf.get(item.lessonId) ?? null,
      lessonId: item.lessonId,
      code: item.code,
      label: ANOMALY_LABELS[item.code] ?? item.code,
      severity: item.severity,
      firstSeenAt: iso(item.firstSeenAt),
      openedAt: iso(item.openedAt),
      lastSeenAt: iso(item.lastSeenAt),
      resolvedAt: iso(item.resolvedAt),
      // Handled means handled after the current occurrence began.
      handled: item.acknowledgedAt != null && item.acknowledgedAt >= item.openedAt,
      acknowledgedBy: item.acknowledgedBy,
      acknowledgedAt: iso(item.acknowledgedAt),
      note: item.note,
    })),
    lessons: lessons.map((lesson) => ({
      lessonId: lesson.id,
      code: lesson.code,
      startsAt: lesson.startsAt,
      endsAt: lesson.endsAt,
      cancelled: lesson.cancelled,
      tutorCode: lesson.participants.find((entry) => entry.role === "tutor")?.code ?? null,
      studentCodes: lesson.participants.filter((entry) => entry.role === "student").map((entry) => entry.code),
    })),
  };
}

// The lessons around now with this person in this role.
async function lessonsWith(store: ClassroomStore, personCode: string, role: "student" | "tutor", now: number) {
  const lessons = await store.listLessons({ from: now - OVERVIEW_WINDOW_MS, to: now + OVERVIEW_WINDOW_MS });
  return lessons.filter((lesson) => lesson.participants.some((entry) => entry.role === role && entry.code === personCode));
}

// A consent or notice change is written to the person's lessons around now, so a lesson that
// has not started yet is decided again; a live lesson keeps its decision.
async function markConsentChanged(store: ClassroomStore, personCode: string, role: "student" | "tutor", now: number) {
  const affected = await lessonsWith(store, personCode, role, now);
  await serverEvent(store, affected.map((lesson) => ({
    source: "server",
    type: "server.consent_changed",
    lessonId: lesson.id,
    occurredAt: now,
    receivedAt: now,
    key: `server.consent_changed:${lesson.id}:${personCode}:${now}`,
  })));
}

// Synthetic consent for local work only, while the consent policy is still Justine's to decide.
// A withdrawal during a lesson that day is written to that lesson, which starts the protective
// stop.
export async function setSyntheticConsent({ store, personCode, role, status, actor, now }: {
  store: ClassroomStore; personCode: string; role: "student" | "tutor"; status: "granted" | "withdrawn"; actor: string; now: number;
}) {
  const policy = consentPolicy();
  if (role === "tutor") {
    await store.setStaffNotice({ personCode, version: policy.staffNoticeVersion, acknowledgedAt: now, recordedBy: actor });
    await markConsentChanged(store, personCode, "tutor", now);
    return;
  }
  await store.setConsent({
    personCode,
    status,
    version: policy.consentVersion,
    grantedAt: now,
    withdrawnAt: status === "withdrawn" ? now : null,
    expiresAt: null,
    synthetic: true,
    recordedBy: actor,
  });
  if (status !== "withdrawn") {
    await markConsentChanged(store, personCode, "student", now);
    return;
  }
  const affected = await lessonsWith(store, personCode, "student", now);
  await serverEvent(store, affected.map((lesson) => ({
    source: "server",
    type: "server.consent_withdrawn",
    lessonId: lesson.id,
    participantId: lesson.participants.find((entry) => entry.code === personCode)?.id,
    occurredAt: now,
    receivedAt: now,
    key: `server.consent_withdrawn:${lesson.id}:${personCode}`,
  })));
}
