// The pre-class screen's look at one lesson (Classroom 2.1 lobby, 2026-11-13): before anyone
// enters, the person who opened the room page sees which lesson it is, when, as whom, and whether
// the classroom is open yet. It answers only the person the room would let in anyway (a student by
// the personal link, the lesson's tutor by sign-in) and only what entering would tell them: the
// lesson's code and times, their own role and code, and the state of the door. Unlike entering it
// needs no time window (so a student who is early learns when the door opens), and it never issues
// a token, starts anything at the video service or stores anything about the lesson.
import { hashKey } from "./classroom-block-rules";
import { JOIN_WINDOW_AFTER_MS, JOIN_WINDOW_BEFORE_MS } from "../tools/recording-pathway/classroom/eligibility.mjs";
import type { ClassroomLesson, ClassroomStore } from "./classroom-store";

export type LessonDoorState = "before" | "open" | "ended" | "cancelled";

export type LessonPreview = {
  ok: true;
  lesson: { code: string; startsAt: string; endsAt: string; opensAt: string; closesAt: string };
  state: LessonDoorState;
  role: "tutor" | "student";
  participantCode: string;
  // Who else the lesson has, by code only, as the room shows them on their tiles: the tutor for a
  // student, the student for the tutor. Never a name, an e-mail or anything behind a code.
  with: { role: "tutor" | "student"; codes: string[] };
};

// The door of a one-to-one lesson, as the entry check applies it: open from 15 minutes before the
// lesson until 15 minutes after it ends (lib/classroom-service.ts, myClassroomLessons).
export function lessonDoorOf(lesson: Pick<ClassroomLesson, "startsAt" | "endsAt" | "cancelled">, now: number) {
  const opensAt = Date.parse(lesson.startsAt) - JOIN_WINDOW_BEFORE_MS;
  const closesAt = Date.parse(lesson.endsAt) + JOIN_WINDOW_AFTER_MS;
  const state: LessonDoorState = lesson.cancelled ? "cancelled" : now < opensAt ? "before" : now <= closesAt ? "open" : "ended";
  return { state, opensAt, closesAt };
}

export async function classroomPreview({ store, lessonId, key, sessionEmail, now }: {
  store: Pick<ClassroomStore, "lesson">; lessonId: string; key?: string | null; sessionEmail?: string | null; now: number;
}): Promise<{ status: number; body: LessonPreview | { error: string; code: string } }> {
  const lesson = await store.lesson(lessonId);
  if (!lesson) return { status: 404, body: { error: "Lesson not found", code: "LESSON_NOT_FOUND" } };
  // A block's Lobby and rooms (P3-Multi) are entered through the block's own page, which tells each
  // member where they belong; this screen is for one-to-one lessons only.
  if (lesson.blockId) return { status: 409, body: { error: "This lesson is entered through its block", code: "BLOCK_LESSON" } };
  // The same person the entry check would find: the student whose personal key this is, or the
  // lesson's tutor signed in. Nobody else learns anything about the lesson, not even its state.
  const keyHash = key ? hashKey(key) : null;
  const participant = (keyHash && lesson.participants.find((entry) => entry.role === "student" && entry.joinKeyHash === keyHash))
    || (sessionEmail && lesson.participants.find((entry) => entry.role === "tutor" && entry.staffEmail === sessionEmail))
    || null;
  if (!participant || (participant.role !== "tutor" && participant.role !== "student")) {
    return { status: 403, body: { error: "You cannot see this classroom", code: "NOT_ON_ROSTER" } };
  }
  const door = lessonDoorOf(lesson, now);
  const other = participant.role === "student" ? "tutor" : "student";
  const codes = lesson.participants.filter((entry) => entry.role === other && entry.active !== false).map((entry) => entry.code);
  return {
    status: 200,
    body: {
      ok: true,
      lesson: {
        code: lesson.code, startsAt: lesson.startsAt, endsAt: lesson.endsAt,
        opensAt: new Date(door.opensAt).toISOString(), closesAt: new Date(door.closesAt).toISOString(),
      },
      state: door.state,
      role: participant.role,
      participantCode: participant.code,
      with: { role: other, codes },
    },
  };
}
