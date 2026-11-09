import { afterAll, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// P3-Multi (2026-11-09; 18.3–18.5 and the task book's section 9): a block room's recordings in
// Drive, with the file store and the stand-in Drive. Each recording is named by the people it
// covers and the New York date of the scheduled start, keeps its own participant snapshot with each
// person's consent or notice, is held at Zoom when anyone it covers lacked them, is never written
// over another file, and is only reported as filed when the copy is in its own folder with its own
// name. Synthetic only.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-multi-filing-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("VERCEL_ENV", "");
const { createFileClassroomStore } = await import("../lib/classroom-store");
const { createClassroomBlock, listBlockFilings, retryBlockFiling } = await import("../lib/classroom-blocks");
const { setSyntheticConsent } = await import("../lib/classroom-service");
// @ts-ignore
const { storeEvent } = await import("../tools/recording-pathway/classroom/webhook-ingest.mjs");
// @ts-ignore
const { fileRecording, processJobs } = await import("../tools/recording-pathway/classroom/recording-filing.mjs");
// @ts-ignore
const { createDrive, syntheticContent } = await import("../tools/recording-pathway/test/fake-classroom-store.mjs");

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const MIN = 60_000;
// Taipei 09:00 on 1 December 2026 = New York 20:00 on 30 November (EST).
const START = Date.parse("2026-12-01T01:00:00Z");
const NAME = "Alice Wang-Bob Lee_Carol Chen-Dan Wu_2026-11-30";
let blocks = 0;

// A room with a lead and a co-tutor, an observer (not seated) and three students; everyone but
// those named in `without` has given consent or the notice.
async function room({ without = [] } = {}) {
  blocks += 1;
  const code = `TEST-MF${blocks}`;
  // Each room its own store, so a test's filing runs see only its own jobs.
  const store = createFileClassroomStore(path.join(directory, `filing-${blocks}.json`));
  const members = [
    { code: `${code}-M`, role: "manager", englishName: "Mia Manager", email: `fm${blocks}@example.test` },
    { code: `${code}-T`, role: "lead_tutor", englishName: "Carol Chen", email: `ft${blocks}@example.test` },
    { code: `${code}-U`, role: "co_tutor", englishName: "Dan Wu", email: `fu${blocks}@example.test` },
    { code: `${code}-O`, role: "observer", englishName: "Olly Obs", email: `fo${blocks}@example.test` },
    { code: `${code}-A`, role: "student", englishName: "Alice Wang" },
    { code: `${code}-B`, role: "student", englishName: "Bob Lee" },
    { code: `${code}-C`, role: "student", englishName: "Cara Lin" },
  ];
  const created = await createClassroomBlock({
    store, actor: "filing-owner@example.test", now: START - 60 * MIN,
    input: { code, date: "2026-12-01", time: "09:00", minutes: 60, rooms: ["R1", "R2"], members, assignments: ["T", "U", "A", "B"].map(suffix => ({ member: `${code}-${suffix}`, room: "R1" })).concat([{ member: `${code}-C`, room: "R2" }]) },
  });
  for (const member of members.filter(entry => !without.includes(entry.code.slice(code.length + 1)))) {
    await setSyntheticConsent({ store, personCode: member.code, role: member.role === "student" ? "student" : "tutor", status: "granted", actor: "filing-owner@example.test", now: START - 30 * MIN });
  }
  const block = await store.block(created.block.blockId);
  const lesson = await store.lesson(block.roomIds[0]);
  let n = 0;
  const fact = async (type, at, fields) => { n += 1; await store.transaction(tx => storeEvent(tx, { source: "zoom_webhook", type, lessonId: lesson.id, occurredAt: at, receivedAt: at, key: `${type}:${lesson.id}:${at}:${n}`, ...fields })); };
  // The room's own decision allowed recording (as its consent check would), then everyone joins.
  await fact("server.recording_eligibility", START, { source: "server", eligible: true, reason: "ALL_CONSENTED", count: 0 });
  const rowOf = async suffix => (await store.lesson(lesson.id)).participants.find(entry => entry.code === `${code}-${suffix}`)?.id;
  for (const suffix of ["T", "U", "A", "B"]) await fact("session.user_joined", START + MIN, { providerSessionId: "ZS-F", participantId: await rowOf(suffix) });
  return { code, block, lesson, rowOf, fact, store };
}
const completed = (ctx, id, from, to) => ctx.fact("session.recording_completed", to + 5 * MIN, {
  source: "zoom_api", provider: "synthetic", providerSessionId: "ZS-F", sessionName: `ihear-${ctx.lesson.id.toLowerCase()}`,
  files: [{ providerFileId: id, kind: "composite", extension: "mp4", size: 1000, status: "completed", recordingStart: from, recordingEnd: to }],
});
const file = (ctx, drive) => async now => (await processJobs({
  store: ctx.store, now, workerId: "filing", handlers: {
    file_recording: input => fileRecording({ store: ctx.store, drive, download: async (record, { start, end }) => syntheticContent(record.providerFileId, start, end), rootFolderId: drive.rootFolderId, ...input }),
    delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await ctx.store.completeJob({ jobId: job.id, leaseVersion })) ? "DONE" : "LEASE_LOST" }),
  },
})).filter(result => String(result.jobId).startsWith("file:"));
const recordOf = (ctx, id) => ctx.store.fileRecord(id);
const snapshotOf = async (ctx, id) => (await ctx.store.eventsFor([ctx.lesson.id])).find(event => event.type === "p1.recording_snapshot" && event.providerFileId === id)?.snapshot;
const folderOf = (drive, students, tutors) => drive.ensureFolder(drive.ensureFolder(drive.rootFolderId, students), tutors);

describe("a block room's recordings in Drive", () => {
  test("named students_tutors_New-York-date (section 9), filed in <students>/<tutors>; a second segment is its own file with its own snapshot", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-F1`, START + 2 * MIN, START + 20 * MIN);
    // Bob leaves; the second recording covers Alice and both tutors only.
    await ctx.fact("session.user_left", START + 25 * MIN, { providerSessionId: "ZS-F", participantId: await ctx.rowOf("B") });
    await completed(ctx, `${ctx.code}-F2`, START + 30 * MIN, START + 50 * MIN);
    expect((await recordOf(ctx, `${ctx.code}-F1`)).plannedName).toBe(`${NAME}.mp4`);
    expect((await recordOf(ctx, `${ctx.code}-F2`)).plannedName).toBe("Alice Wang_Carol Chen-Dan Wu_2026-11-30.mp4");
    const first = await snapshotOf(ctx, `${ctx.code}-F1`);
    expect(first).toMatchObject({ blockCode: ctx.code, roomLabel: "R1", providerSessionId: "ZS-F", date: "2026-11-30", decision: { eligible: true }, hold: null, filing: { eligible: true, problems: [] } });
    expect(first.people.filter(entry => entry.covered).map(entry => [entry.code.slice(ctx.code.length + 1), entry.evidence.kind, entry.problem]).sort()).toEqual([["A", "consent", null], ["B", "consent", null], ["T", "notice", null], ["U", "notice", null]]);
    expect((await snapshotOf(ctx, `${ctx.code}-F2`)).people.find(entry => entry.code === `${ctx.code}-B`).covered).toBe(false);
    expect((await file(ctx, drive)(START + 60 * MIN)).map(result => result.status)).toEqual(["STORED", "STORED"]);
    expect(await drive.listNames(folderOf(drive, "Alice Wang-Bob Lee", "Carol Chen-Dan Wu"))).toEqual([`${NAME}.mp4`]);
    expect(await drive.listNames(folderOf(drive, "Alice Wang", "Carol Chen-Dan Wu"))).toEqual(["Alice Wang_Carol Chen-Dan Wu_2026-11-30.mp4"]);
  });

  test("a later recording with the same people gets the next part, and a file already there with that name (not ours) is never written over", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-G1`, START + 2 * MIN, START + 10 * MIN);
    await completed(ctx, `${ctx.code}-G2`, START + 12 * MIN, START + 20 * MIN);
    expect((await recordOf(ctx, `${ctx.code}-G2`)).plannedName).toBe(`${NAME}_P02.mp4`);
    const folder = folderOf(drive, "Alice Wang-Bob Lee", "Carol Chen-Dan Wu");
    const theirs = drive.addFile({ name: `${NAME}.mp4`, parentId: folder, appProperties: { providerFileId: "someone-else" }, size: 5 });
    expect((await file(ctx, drive)(START + 60 * MIN)).map(result => result.status)).toEqual(["STORED", "STORED"]);
    const names = await drive.listNames(folder);
    expect(names.filter(name => name === `${NAME}.mp4`)).toHaveLength(1);
    expect(drive.trashedFiles().map(entry => entry.id)).not.toContain(theirs);
    expect(names).toContain(`${NAME}_P02.mp4`);
  });

  test("18.5: a copy of the recording found outside its own folder is never reported as filed, and nothing is deleted", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-H1`, START + 2 * MIN, START + 20 * MIN);
    const stray = drive.addFile({ name: `${NAME}.mp4`, parentId: drive.ensureFolder(drive.rootFolderId, "somewhere-else"), appProperties: { providerFileId: `${ctx.code}-H1` }, size: 1000 });
    expect((await file(ctx, drive)(START + 60 * MIN)).map(result => result.status)).not.toContain("STORED");
    expect((await recordOf(ctx, `${ctx.code}-H1`)).status).not.toBe("STORED");
    expect(drive.trashedFiles().map(entry => entry.id)).not.toContain(stray);
  });

  test("18.5: a copy found in its own folder but under another name (renamed by someone) is never reported as filed, and nothing is deleted", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-H2`, START + 2 * MIN, START + 20 * MIN);
    const renamed = drive.addFile({ name: "Renamed by someone.mp4", parentId: folderOf(drive, "Alice Wang-Bob Lee", "Carol Chen-Dan Wu"), appProperties: { providerFileId: `${ctx.code}-H2` }, size: 1000 });
    expect((await file(ctx, drive)(START + 60 * MIN)).map(result => result.status)).not.toContain("STORED");
    expect((await recordOf(ctx, `${ctx.code}-H2`)).status).not.toBe("STORED");
    expect(drive.trashedFiles().map(entry => entry.id)).not.toContain(renamed);
  });
});

describe("18.4: each recording's people and their own consent", () => {
  test("a student without consent in the recording (let in some other way): the recording is held at Zoom, never uploaded, and the snapshot says who and why", async () => {
    const ctx = await room({ without: ["B"] });
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-K1`, START + 2 * MIN, START + 20 * MIN);
    const record = await recordOf(ctx, `${ctx.code}-K1`);
    expect([record.status, record.hold]).toEqual(["HOLD", "PARTICIPANT_CONSENT_MISSING"]);
    const snapshot = await snapshotOf(ctx, `${ctx.code}-K1`);
    expect(snapshot.filing).toMatchObject({ eligible: false, problems: [{ code: "CONSENT_MISSING", member: `${ctx.code}-B` }] });
    expect(snapshot.people.find(entry => entry.code === `${ctx.code}-A`)).toMatchObject({ problem: null, evidence: { kind: "consent", status: "granted" } });
    expect(await file(ctx, drive)(START + 60 * MIN)).toEqual([]);
    expect(drive.counters.sessionsStarted).toBe(0);
  });

  test("a withdrawal during the recording: held (as after any withdrawal), and the snapshot keeps the time the consent ended", async () => {
    const ctx = await room();
    await setSyntheticConsent({ store: ctx.store, personCode: `${ctx.code}-A`, role: "student", status: "withdrawn", actor: "filing-owner@example.test", now: START + 10 * MIN });
    await completed(ctx, `${ctx.code}-W1`, START + 2 * MIN, START + 20 * MIN);
    const record = await recordOf(ctx, `${ctx.code}-W1`);
    expect(record.status).toBe("HOLD");
    const alice = (await snapshotOf(ctx, `${ctx.code}-W1`)).people.find(entry => entry.code === `${ctx.code}-A`);
    expect(alice).toMatchObject({ covered: true, evidence: { kind: "consent", status: "withdrawn", withdrawnAt: START + 10 * MIN } });
    expect(alice.problem).toMatch(/^CONSENT_WITHDRAWN/);
  });

  test("a student moved in, a substitute tutor and an observer visiting during the recording: each is in the snapshot with their times, seat change and evidence; the observer is not in the name", async () => {
    const ctx = await room();
    const block = await ctx.store.block(ctx.block.id);
    const cara = block.members.find(member => member.code === `${ctx.code}-C`);
    const olly = block.members.find(member => member.code === `${ctx.code}-O`);
    // Cara moves from R2 to R1 at minute 8 and joins at 9; the observer visits 10–12; Carol hands
    // over to Dan at 15 (Dan stays to the end).
    for (const [member, seat, to, at] of [[cara, "assigned", ctx.lesson.id, 8], [olly, "visit", ctx.lesson.id, 10]]) {
      const result = await ctx.store.changeBlock({ blockId: block.id, seat: { memberId: member.id, roomId: to, seat, capacity: 10, participant: { id: `P-${member.id.slice(2)}`, code: member.code, role: member.role === "student" ? "student" : "observer" } }, events: [
        { source: "server", type: "server.seat_changed", lessonId: block.lobbyId, blockId: block.id, blockVersion: 99, memberId: member.id, code: member.code, seat, from: member === cara ? "R2" : null, to: "R1", occurredAt: START + at * MIN, receivedAt: START + at * MIN, key: `seat:${member.id}:${at}` },
      ] });
      expect(result.ok).toBe(true);
    }
    await ctx.fact("session.user_joined", START + 9 * MIN, { providerSessionId: "ZS-F", participantId: await ctx.rowOf("C") });
    await ctx.fact("session.user_joined", START + 10 * MIN, { providerSessionId: "ZS-F", participantId: await ctx.rowOf("O") });
    await ctx.fact("session.user_left", START + 12 * MIN, { providerSessionId: "ZS-F", participantId: await ctx.rowOf("O") });
    await ctx.fact("session.user_left", START + 15 * MIN, { providerSessionId: "ZS-F", participantId: await ctx.rowOf("T") });
    await completed(ctx, `${ctx.code}-S1`, START + 5 * MIN, START + 30 * MIN);
    const snapshot = await snapshotOf(ctx, `${ctx.code}-S1`);
    expect(snapshot.filing.eligible).toBe(true);
    expect((await recordOf(ctx, `${ctx.code}-S1`)).plannedName).toBe("Alice Wang-Bob Lee-Cara Lin_Carol Chen-Dan Wu_2026-11-30.mp4");
    const person = suffix => snapshot.people.find(entry => entry.code === `${ctx.code}-${suffix}`);
    expect(person("C")).toMatchObject({ covered: true, coveredFrom: START + 9 * MIN, seatChanges: [{ at: START + 8 * MIN, from: "R2", to: "R1", seat: "assigned" }], evidence: { kind: "consent", status: "granted" } });
    expect(person("O")).toMatchObject({ covered: true, roomRoles: ["observer"], joins: [START + 10 * MIN], leaves: [START + 12 * MIN], evidence: { kind: "notice" } });
    expect(person("T")).toMatchObject({ covered: true, coveredTo: START + 15 * MIN });
    expect(snapshot.rosterChanges.map(entry => entry.member)).toEqual([`${ctx.code}-C`, `${ctx.code}-O`]);
  });
});

describe("18.5: archived only when everything holds; failures listed and retried safely", () => {
  const jobsOnDisk = ctx => JSON.parse(readFileSync(path.join(directory, `filing-${ctx.code.slice("TEST-MF".length)}.json`), "utf8")).jobs;
  const failing = async () => { throw new Error("synthetic download failure"); };
  const fileWith = (ctx, drive, download) => async now => (await processJobs({
    store: ctx.store, now, workerId: "filing", handlers: {
      file_recording: input => fileRecording({ store: ctx.store, drive, download, rootFolderId: drive.rootFolderId, ...input }),
      delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await ctx.store.completeJob({ jobId: job.id, leaseVersion })) ? "DONE" : "LEASE_LOST" }),
    },
  })).filter(result => String(result.jobId).startsWith("file:"));
  const good = async (record, { start, end }) => syntheticContent(record.providerFileId, start, end);

  test("a filing that keeps failing is FAILED, listed for owners and never deletes Zoom's copy; an owner's retry (with a reason) files it once; a second retry, a held one or one without a reason is refused", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-R1`, START + 2 * MIN, START + 20 * MIN);
    let now = START + 60 * MIN;
    for (let i = 0; i < 8; i += 1) { await fileWith(ctx, drive, failing)(now); now += 31 * MIN; }
    expect((await recordOf(ctx, `${ctx.code}-R1`)).status).toBe("FAILED");
    expect(Object.keys(jobsOnDisk(ctx)).filter(id => id === `delete-vendor:${ctx.code}-R1`)).toEqual([]);
    let listed = (await listBlockFilings({ store: ctx.store, now })).find(entry => entry.recordingId === `${ctx.code}-R1`);
    expect(listed).toMatchObject({ status: "FAILED", retryable: true, date: "2026-11-30", job: { status: "dead" } });
    expect((await retryBlockFiling({ store: ctx.store, providerFileId: `${ctx.code}-R1`, actor: "owner@example.test", reason: "", now })).body).toMatchObject({ code: "REASON_REQUIRED" });
    expect((await retryBlockFiling({ store: ctx.store, providerFileId: `${ctx.code}-R1`, actor: "owner@example.test", reason: "Drive was down; retry", now })).status).toBe(200);
    expect((await fileWith(ctx, drive, good)(now + MIN)).filter(result => result.jobId === `file:${ctx.code}-R1`).map(result => result.status)).toEqual(["STORED"]);
    expect(drive.activeFiles().filter(entry => entry.appProperties.providerFileId === `${ctx.code}-R1`)).toHaveLength(1);
    listed = (await listBlockFilings({ store: ctx.store, now })).find(entry => entry.recordingId === `${ctx.code}-R1`);
    expect(listed).toMatchObject({ status: "ARCHIVED", retryable: false });
    expect((await ctx.store.eventsFor([ctx.lesson.id])).find(event => event.type === "p1.filing_retry")).toMatchObject({ actor: "owner@example.test", reason: "Drive was down; retry", providerFileId: `${ctx.code}-R1` });
    expect((await retryBlockFiling({ store: ctx.store, providerFileId: `${ctx.code}-R1`, actor: "owner@example.test", reason: "again", now })).body).toMatchObject({ code: "ALREADY_ARCHIVED" });
    // A recording held for a missing consent is never sent on by a retry.
    const held = await room({ without: ["B"] });
    await completed(held, `${held.code}-R2`, START + 2 * MIN, START + 20 * MIN);
    expect((await retryBlockFiling({ store: held.store, providerFileId: `${held.code}-R2`, actor: "owner@example.test", reason: "please", now })).body).toMatchObject({ code: "HELD" });
  });

  test("two owners retry the same failed filing at once: it is requeued once", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-R3`, START + 2 * MIN, START + 20 * MIN);
    let now = START + 60 * MIN;
    for (let i = 0; i < 8; i += 1) { await fileWith(ctx, drive, failing)(now); now += 31 * MIN; }
    const answers = await Promise.all(["a", "b"].map(who => retryBlockFiling({ store: ctx.store, providerFileId: `${ctx.code}-R3`, actor: `${who}@example.test`, reason: "retry it", now })));
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 409]);
    expect((await ctx.store.eventsFor([ctx.lesson.id])).filter(event => event.type === "p1.filing_retry")).toHaveLength(1);
  });

  test("a parent folder shared with anyone, or with someone outside the allowed domains: the copy never counts as archived", async () => {
    const ctx = await room();
    const drive = createDrive();
    drive.share(drive.rootFolderId, { type: "anyone", role: "reader" });
    await completed(ctx, `${ctx.code}-P1`, START + 2 * MIN, START + 20 * MIN);
    expect((await fileWith(ctx, drive, good)(START + 60 * MIN)).map(result => result.status)).not.toContain("STORED");
    expect((await recordOf(ctx, `${ctx.code}-P1`)).status).not.toBe("STORED");
    vi.stubEnv("CLASSROOM_DRIVE_ALLOWED_DOMAINS", "example.test");
    try {
      const other = await room();
      const drive2 = createDrive();
      drive2.share(drive2.rootFolderId, { type: "user", role: "reader", emailAddress: "someone@elsewhere.invalid" });
      await completed(other, `${other.code}-P2`, START + 2 * MIN, START + 20 * MIN);
      expect((await fileWith(other, drive2, good)(START + 60 * MIN)).map(result => result.status)).not.toContain("STORED");
      const inside = await room();
      const drive3 = createDrive();
      drive3.share(drive3.rootFolderId, { type: "user", role: "reader", emailAddress: "staff@example.test" });
      await completed(inside, `${inside.code}-P3`, START + 2 * MIN, START + 20 * MIN);
      expect((await fileWith(inside, drive3, good)(START + 60 * MIN)).map(result => result.status)).toEqual(["STORED"]);
    } finally {
      vi.stubEnv("CLASSROOM_DRIVE_ALLOWED_DOMAINS", "");
    }
  });

  test("the upload finished but writing the result failed: the next run finds the copy and records it, without a second upload", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-D1`, START + 2 * MIN, START + 20 * MIN);
    const finishFiling = ctx.store.finishFiling;
    let crashed = false;
    ctx.store.finishFiling = async input => { if (!crashed) { crashed = true; throw new Error("synthetic database failure"); } return finishFiling(input); };
    try {
      await fileWith(ctx, drive, good)(START + 60 * MIN).catch(() => null);
    } finally {
      ctx.store.finishFiling = finishFiling;
    }
    expect(crashed).toBe(true);
    expect((await recordOf(ctx, `${ctx.code}-D1`)).status).not.toBe("STORED");
    const second = await fileWith(ctx, drive, good)(START + 120 * MIN);
    expect(second.filter(result => result.jobId === `file:${ctx.code}-D1`).map(result => result.status)).toEqual(["STORED"]);
    expect(drive.activeFiles().filter(entry => entry.appProperties.providerFileId === `${ctx.code}-D1`)).toHaveLength(1);
  });
});
