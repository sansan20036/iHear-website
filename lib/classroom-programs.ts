import { randomUUID } from "node:crypto";

import { ClassroomInputError } from "./classroom-service";
import type { ClassroomCourse, ClassroomProgram, ClassroomStore } from "./classroom-store";

// P3-Multi (draft 030, 2026-11-09): the smallest course level above the blocks. A program (iHear
// 教學計畫) holds courses (課程); a course holds blocks (班次), and each block keeps its Lobby,
// teaching rooms and seats exactly as before. One-to-one lessons belong to none and are unchanged.
// A course states the time zone its schedule is written in, so imported times are never guessed.
// Owners only. Cancelling a course stops new blocks and imports in it; blocks already made stay as
// they are until each is cancelled on its own (which ends its sessions the usual way): nothing
// here ends a session or touches a recording.

const CODE = /^[A-Za-z0-9-]{1,30}$/;
const shortId = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, "")}`;
const nameOf = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");

/** A real IANA time zone with a region (America/New_York), not an offset or an abbreviation. */
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export async function listClassroomPrograms({ store, now }: { store: ClassroomStore; now: number }) {
  const { programs, courses } = await store.listPrograms();
  const blocks = await store.listBlocks({ from: now - 365 * 86_400_000, to: now + 365 * 86_400_000 });
  return {
    programs: programs.map((program) => ({
      ...program,
      courses: courses.filter((course) => course.programId === program.id).map((course) => ({
        ...course,
        blocks: blocks.filter((block) => block.courseId === course.id).length,
        upcoming: blocks.filter((block) => block.courseId === course.id && !block.cancelled && Date.parse(block.endsAt) > now).length,
      })),
    })),
  };
}

export async function createClassroomProgram({ store, input, actor, now }: { store: ClassroomStore; input: Record<string, unknown>; actor: string; now: number }) {
  const issues: Record<string, string> = {};
  const code = String(input.code ?? "").trim();
  const name = nameOf(input.name);
  if (!CODE.test(code)) issues.code = "Use 1–30 letters, digits or hyphens";
  if (!name || name.length > 120) issues.name = "Name the program (1–120 characters)";
  if (Object.keys(issues).length) throw new ClassroomInputError("The program is not valid", issues);
  const at = new Date(now).toISOString();
  const program: ClassroomProgram = { id: shortId("PG"), code, name, archived: false, createdBy: actor, createdAt: at, updatedAt: at };
  await store.createProgram(program);
  return program;
}

export async function updateClassroomProgram({ store, id, input, now }: { store: ClassroomStore; id: unknown; input: Record<string, unknown>; now: number }) {
  const change: { name?: string; archived?: boolean; updatedAt: string } = { updatedAt: new Date(now).toISOString() };
  if (input.name !== undefined) {
    const name = nameOf(input.name);
    if (!name || name.length > 120) throw new ClassroomInputError("The program is not valid", { name: "Name the program (1–120 characters)" });
    change.name = name;
  }
  if (input.archived !== undefined) change.archived = input.archived === true;
  return store.updateProgram(String(id ?? ""), change);
}

export async function createClassroomCourse({ store, input, actor, now }: { store: ClassroomStore; input: Record<string, unknown>; actor: string; now: number }) {
  const issues: Record<string, string> = {};
  const code = String(input.code ?? "").trim();
  const name = nameOf(input.name);
  if (!CODE.test(code)) issues.code = "Use 1–30 letters, digits or hyphens";
  if (!name || name.length > 120) issues.name = "Name the course (1–120 characters)";
  if (!validTimeZone(input.timeZone)) issues.timeZone = "Choose the time zone the schedule is written in (for example America/New_York)";
  const { programs } = await store.listPrograms();
  const program = programs.find((item) => item.id === input.program || item.code === input.program);
  if (!program) issues.program = "No such program";
  else if (program.archived) issues.program = "That program is archived";
  if (Object.keys(issues).length) throw new ClassroomInputError("The course is not valid", issues);
  const at = new Date(now).toISOString();
  const course: ClassroomCourse = { id: shortId("CR"), programId: program!.id, code, name, timeZone: String(input.timeZone), cancelled: false, createdBy: actor, createdAt: at, updatedAt: at };
  await store.createCourse(course);
  return course;
}

// A course renamed, or cancelled (no new blocks or imports). Its time zone never changes once set:
// blocks already made from its schedule were read in it (a different zone is a new course).
export async function updateClassroomCourse({ store, id, input, now }: { store: ClassroomStore; id: unknown; input: Record<string, unknown>; now: number }) {
  const change: { name?: string; cancelled?: boolean; updatedAt: string } = { updatedAt: new Date(now).toISOString() };
  if (input.timeZone !== undefined) throw new ClassroomInputError("The course is not valid", { timeZone: "A course keeps its time zone; make a new course for another one" });
  if (input.name !== undefined) {
    const name = nameOf(input.name);
    if (!name || name.length > 120) throw new ClassroomInputError("The course is not valid", { name: "Name the course (1–120 characters)" });
    change.name = name;
  }
  if (input.cancelled !== undefined) change.cancelled = input.cancelled === true;
  return store.updateCourse(String(id ?? ""), change);
}
