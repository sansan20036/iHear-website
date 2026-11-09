import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";

// P3-Auth (2026-11-08): the three roles end to end through the website's own routes, on a
// localhost-only disposable PostgreSQL with migration 028, created and removed by this test. It
// never loads .env, never uses an inherited database URL and never connects to a hosted
// database. Synthetic identities only (example.test, TEST- codes); the synthetic provider stands
// in for Zoom, so nothing here says anything about real Zoom behaviour. Sign-in is simulated
// (Auth.js is mocked): the real Google sign-in is not part of this test. The rate limiter is the
// real one, in memory.
vi.mock("../auth.js", () => ({ auth: vi.fn() }));
vi.mock("../lib/admin-store", () => ({ findAdminAccount: vi.fn(), appendAdminActivity: vi.fn() }));

const OWNER = "owner@example.test";
const EDITOR = "editor@example.test";
const TUTOR = "tutor@example.test";
const OTHER_TUTOR = "other-tutor@example.test";
const ORIGIN = "http://localhost:3000";
const container = `ihear-classroom-auth-${randomUUID()}`;
const password = "isolated-classroom-auth-test-only";
const docker = args => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }).trim();
const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "ihear-classroom-auth-data-"));

vi.stubEnv("AUTH_OWNER_EMAILS", OWNER);
vi.stubEnv("POSTGRES_URL", "");
vi.stubEnv("DATABASE_URL", "");
// The rate limiter keeps its counts in memory; the classroom store is the disposable database.
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", dataDirectory);
vi.stubEnv("CLASSROOM_PROVIDER", "synthetic");
vi.stubEnv("CLASSROOM_DRIVE", "local");
vi.stubEnv("CLASSROOM_SYNTHETIC_SECRET", "classroom-auth-token-test-only");
vi.stubEnv("VERCEL_ENV", "");

const { auth } = await import("../auth.js");
const { appendAdminActivity, findAdminAccount } = await import("../lib/admin-store");
const { createPostgresClassroomStore } = await import("../lib/classroom-store");
const { entryEndedBy } = await import("../lib/classroom-join-client");
const lessonsRoute = await import("../app/api/admin/classrooms/route");
const lessonRoute = await import("../app/api/admin/classrooms/[lessonId]/route");
const joinRoute = await import("../app/api/classroom/[lessonId]/join/route");
const statusRoute = await import("../app/api/classroom/[lessonId]/status/route");
const hostRoute = await import("../app/api/classroom/[lessonId]/host-events/route");
const myLessonsRoute = await import("../app/api/classroom/my-lessons/route");

let started = false, port, workspace, sql, store;
const clients = [];
const databaseUrl = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
function connect(database) {
  const client = postgres(databaseUrl(database), { ssl: false, max: 4, prepare: false, connect_timeout: 2, onnotice: () => {} });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  docker(["run", "--detach", "--pull=never", "--name", container, "--label", "ihear-test=classroom-auth", "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${password}`, "postgres:17-alpine"]);
  started = true;
  port = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Expected a localhost-only PostgreSQL port");
  const root = connect("postgres");
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await root`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  await root.unsafe("CREATE DATABASE classroom_auth_test");
  workspace = await mkdtemp(path.join(os.tmpdir(), "ihear-classroom-auth-migrations-"));
  await mkdir(path.join(workspace, "db", "migrations"), { recursive: true });
  for (const file of (await readdir("db/migrations")).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name))) {
    await copyFile(path.join("db", "migrations", file), path.join(workspace, "db", "migrations", file));
  }
  const result = spawnSync(process.execPath, [path.resolve("scripts/migrate-database.mjs")], {
    cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: databaseUrl("classroom_auth_test"), DATABASE_URL: "", POSTGRES_SSL: "disable" },
  });
  if (result.status !== 0) throw new Error(`Migration runner failed: ${result.stderr}`);
  sql = connect("classroom_auth_test");
  store = createPostgresClassroomStore(sql);
  // The routes ask lib/classroom-store for the store; it is this database.
  globalThis.ihearClassroomStore = store;
  vi.useFakeTimers({ toFake: ["Date"] });
}, 180000);

afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete globalThis.ihearClassroomStore;
  for (const client of clients) await client.end({ timeout: 2 });
  if (started) docker(["rm", "--force", "--volumes", container]);
  for (const directory of [workspace, dataDirectory]) {
    if (directory && (await realpath(directory)).startsWith(await realpath(os.tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
}, 30000);

const at = iso => vi.setSystemTime(new Date(iso));
const signedIn = email => auth.mockResolvedValue(email ? { user: { email } } : null);
const params = lessonId => ({ params: Promise.resolve({ lessonId }) });
const request = (method, pathname, body) => new Request(`${ORIGIN}${pathname}`, {
  method, headers: { origin: ORIGIN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = async response => ({ status: response.status, body: await response.json() });
const keyOf = link => new URLSearchParams(new URL(link, ORIGIN).hash.slice(1)).get("k");
const claimsOf = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

// Each role as the website sees it: a sign-in (or none) and, for the student, the link's key.
const as = email => {
  signedIn(email);
  return {
    create: fields => lessonsRoute.POST(request("POST", "/api/admin/classrooms", fields)).then(read),
    change: (lessonId, body) => lessonRoute.PATCH(request("PATCH", `/api/admin/classrooms/${lessonId}`, body), params(lessonId)).then(read),
    myLessons: () => myLessonsRoute.GET(new Request(`${ORIGIN}/api/classroom/my-lessons`)).then(read),
    join: (lessonId, key) => joinRoute.POST(request("POST", `/api/classroom/${lessonId}/join`, key ? { key } : {}), params(lessonId)).then(read),
    status: (lessonId, key) => statusRoute.POST(request("POST", `/api/classroom/${lessonId}/status`, key ? { key } : {}), params(lessonId)).then(read),
    report: (lessonId, report) => hostRoute.POST(request("POST", `/api/classroom/${lessonId}/host-events`, { at: new Date().toISOString(), ...report }), params(lessonId)).then(read),
  };
};

describe("three roles end to end on PostgreSQL (synthetic)", () => {
  test("administrator, tutor and student: create, list, enter, report, revoke, reissue and cancel, with every refusal along the way", async () => {
    findAdminAccount.mockImplementation(async email => (email === EDITOR ? { email: EDITOR, enabled: true } : null));
    appendAdminActivity.mockResolvedValue(undefined);
    const lessonFields = { date: "2026-11-25", time: "10:00", minutes: 60, tutorCode: "TEST-PT1", tutorEmail: TUTOR, studentCode: "TEST-PS1" };

    // 1. Only an owner adds a lesson; the personal link is in that answer only.
    at("2026-11-25T00:00:00Z");
    expect((await as(EDITOR).create({ ...lessonFields, code: "TEST-P1" })).status).toBe(403);
    expect((await as(TUTOR).create({ ...lessonFields, code: "TEST-P1" })).status).toBe(403);
    expect((await as(null).create({ ...lessonFields, code: "TEST-P1" })).status).toBe(403);
    const created = await as(OWNER).create({ ...lessonFields, code: "TEST-P1" });
    expect(created.status).toBe(201);
    const lessonId = created.body.lesson.lessonId;
    const firstKey = keyOf(created.body.studentLink);
    const other = await as(OWNER).create({ ...lessonFields, code: "TEST-P2", tutorCode: "TEST-PT2", tutorEmail: OTHER_TUTOR, studentCode: "TEST-PS2" });
    const otherId = other.body.lesson.lessonId;
    const otherKey = keyOf(other.body.studentLink);

    // 2. The tutor's list shows their own lesson only; signed out there is no list.
    expect((await as(TUTOR).myLessons()).body.lessons.map(lesson => lesson.code)).toEqual(["TEST-P1"]);
    expect((await as(OTHER_TUTOR).myLessons()).body.lessons.map(lesson => lesson.code)).toEqual(["TEST-P2"]);
    expect((await as(null).myLessons()).status).toBe(401);
    // Before the door opens nobody enters.
    expect(await as(TUTOR).join(lessonId)).toMatchObject({ status: 403, body: { code: "OUTSIDE_JOIN_WINDOW" } });

    // 3. In the window: the tutor by sign-in, the student by link; nobody else, and not across lessons.
    at("2026-11-25T01:50:00Z");
    const tutor = await as(TUTOR).join(lessonId);
    const student = await as(null).join(lessonId, firstKey);
    expect(tutor).toMatchObject({ status: 200, body: { role: "tutor", participantCode: "TEST-PT1" } });
    expect(student).toMatchObject({ status: 200, body: { role: "student", participantCode: "TEST-PS1" } });
    expect(claimsOf(tutor.body.session.token)).toMatchObject({ role_type: 1, session_key: lessonId });
    expect(claimsOf(student.body.session.token)).toMatchObject({ role_type: 0, session_key: lessonId });
    for (const [who, key] of [[OWNER, null], [EDITOR, null], [OTHER_TUTOR, null], [null, otherKey], [null, null]]) {
      expect(await as(who).join(lessonId, key), `${who} ${key ? "with another key" : ""}`).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    }
    expect(await as(TUTOR).join(otherId)).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });
    expect(await as(null).join(otherId, firstKey)).toMatchObject({ status: 403, body: { code: "NOT_ON_ROSTER" } });

    // 4. In the room: the tutor reports, the student reads the recording state; others cannot.
    expect((await as(TUTOR).report(lessonId, { type: "heartbeat" })).status).toBe(200);
    expect((await as(OTHER_TUTOR).report(lessonId, { type: "heartbeat" })).status).toBe(403);
    expect((await as(null).status(lessonId, firstKey)).status).toBe(200);
    expect((await as(TUTOR).change(lessonId, { action: "cancel" })).status).toBe(403);
    expect((await as(EDITOR).change(lessonId, { action: "revoke_link" })).status).toBe(403);

    // 5. Revoking: the student's page is told to leave; entering again is refused; the tutor carries on.
    // (A minute on, so the entry attempts above do not count towards the rate limit below.)
    at("2026-11-25T01:51:30Z");
    expect((await as(OWNER).change(lessonId, { action: "revoke_link" })).status).toBe(200);
    const revoked = await as(null).status(lessonId, firstKey);
    expect(entryEndedBy({ status: revoked.status, code: revoked.body.code }, { role: "student", hasKey: true })).toBe("LINK_REVOKED");
    expect((await as(null).join(lessonId, firstKey)).status).toBe(403);
    expect((await as(TUTOR).report(lessonId, { type: "heartbeat" })).status).toBe(200);

    // 6. Reissuing: the new link enters as the same student; the old one still does not.
    const reissued = await as(OWNER).change(lessonId, { action: "reissue_link" });
    const newKey = keyOf(reissued.body.studentLink);
    expect(await as(null).join(lessonId, newKey)).toMatchObject({ status: 200, body: { role: "student", participantCode: "TEST-PS1" } });
    expect((await as(null).join(lessonId, firstKey)).status).toBe(403);

    // 7. Cancelling: both pages are told to leave at their next check, nobody enters, the list says so.
    at("2026-11-25T01:53:00Z");
    expect((await as(OWNER).change(lessonId, { action: "cancel" })).status).toBe(200);
    const tutorReport = await as(TUTOR).report(lessonId, { type: "heartbeat" });
    expect(tutorReport).toMatchObject({ status: 403, body: { code: "LESSON_CANCELLED" } });
    expect(entryEndedBy({ status: tutorReport.status, code: tutorReport.body.code }, { role: "tutor", hasKey: false })).toBe("LESSON_CANCELLED");
    const studentStatus = await as(null).status(lessonId, newKey);
    expect(entryEndedBy({ status: studentStatus.status, code: studentStatus.body.code }, { role: "student", hasKey: true })).toBe("LESSON_CANCELLED");
    for (const [who, key] of [[TUTOR, null], [null, newKey]]) expect(await as(who).join(lessonId, key)).toMatchObject({ status: 403, body: { code: "LESSON_CANCELLED" } });
    expect((await as(TUTOR).myLessons()).body.lessons.find(lesson => lesson.code === "TEST-P1")).toMatchObject({ state: "cancelled" });
    expect(appendAdminActivity.mock.calls.map(([entry]) => entry.action)).toEqual([
      "classroom.lesson_created", "classroom.lesson_created", "classroom.student_link_revoked", "classroom.student_link_reissued", "classroom.lesson_cancelled",
    ]);

    // 8. The database holds hashes only: no key, no token, and a token row for each entry let in.
    const everything = JSON.stringify(await Promise.all([
      sql`SELECT * FROM public.classroom_lessons`, sql`SELECT * FROM public.classroom_participants`,
      sql`SELECT * FROM public.classroom_join_tokens`, sql`SELECT * FROM public.classroom_events`,
    ]));
    for (const secret of [firstKey, newKey, otherKey, tutor.body.session.token, student.body.session.token]) expect(everything).not.toContain(secret);
    const tokens = await sql`SELECT participant_id FROM public.classroom_join_tokens WHERE lesson_id = ${lessonId}`;
    expect(tokens.length).toBe(3);
  });

  test("the real rate limiter stops a flood of entry attempts on one lesson within a minute", async () => {
    at("2026-11-25T01:55:00Z");
    const created = await as(OWNER).create({ code: "TEST-P3", date: "2026-11-25", time: "10:00", minutes: 60, tutorCode: "TEST-PT3", tutorEmail: TUTOR, studentCode: "TEST-PS3" });
    const lessonId = created.body.lesson.lessonId;
    const answers = [];
    for (let attempt = 0; attempt < 11; attempt += 1) answers.push((await as(null).join(lessonId, `guess-${attempt}`)).status);
    expect(answers.slice(0, 10)).toEqual(Array(10).fill(403));
    expect(answers[10]).toBe(429);
    // A minute later the door is open again for the right key.
    at("2026-11-25T01:56:01Z");
    expect((await as(null).join(lessonId, keyOf(created.body.studentLink))).status).toBe(200);
  });
});
