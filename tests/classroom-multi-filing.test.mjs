import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// P3-Multi (2026-11-09, 18.3–18.5): a block room's recordings in Drive, with the file store and the
// stand-in Drive. Each recording is named by the people it covers and the New York date of the
// scheduled start, keeps its own participant snapshot, is never written over another file, and is
// only reported as filed when the copy is in its own folder with its own name. Synthetic only.
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-multi-filing-"));
vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
vi.stubEnv("VERCEL_ENV", "");
const { classroomStore } = await import("../lib/classroom-store");
const { createClassroomBlock } = await import("../lib/classroom-blocks");
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

const store = classroomStore();
const MIN = 60_000;
// Taipei 09:00 on 1 December 2026 = New York 20:00 on 30 November (EST).
const START = Date.parse("2026-12-01T01:00:00Z");
let blocks = 0;

async function room() {
  blocks += 1;
  const code = `TEST-MF${blocks}`;
  const created = await createClassroomBlock({
    store, actor: "filing-owner@example.test", now: START - 60 * MIN,
    input: {
      code, date: "2026-12-01", time: "09:00", minutes: 60, rooms: ["R1"],
      members: [
        { code: `${code}-M`, role: "manager", englishName: "Mia Manager", email: `fm${blocks}@example.test` },
        { code: `${code}-T`, role: "lead_tutor", englishName: "Carol Chen", email: `ft${blocks}@example.test` },
        { code: `${code}-U`, role: "co_tutor", englishName: "Dan Wu", email: `fu${blocks}@example.test` },
        { code: `${code}-A`, role: "student", englishName: "Alice Wang" },
        { code: `${code}-B`, role: "student", englishName: "Bob Lee" },
      ],
      assignments: [`${code}-T`, `${code}-U`, `${code}-A`, `${code}-B`].map(member => ({ member, room: "R1" })),
    },
  });
  const block = await store.block(created.block.blockId);
  const lesson = await store.lesson(block.roomIds[0]);
  const row = suffix => lesson.participants.find(entry => entry.code === `${code}-${suffix}`).id;
  // Everyone joins; the room's own decision allows recording (as its consent check would).
  let n = 0;
  const fact = async (type, at, fields) => { n += 1; await store.transaction(tx => storeEvent(tx, { source: "zoom_webhook", type, lessonId: lesson.id, occurredAt: at, receivedAt: at, key: `${type}:${lesson.id}:${at}:${n}`, ...fields })); };
  await fact("server.recording_eligibility", START, { source: "server", eligible: true, reason: "ALL_CONSENTED", count: 0 });
  for (const suffix of ["T", "U", "A", "B"]) await fact("session.user_joined", START + MIN, { providerSessionId: "ZS-F", participantId: row(suffix) });
  return { code, block, lesson, row, fact };
}
const completed = (ctx, id, from, to) => ctx.fact("session.recording_completed", to + 5 * MIN, {
  source: "zoom_api", provider: "synthetic", providerSessionId: "ZS-F", sessionName: `ihear-${ctx.lesson.id.toLowerCase()}`,
  files: [{ providerFileId: id, kind: "composite", extension: "mp4", size: 1000, status: "completed", recordingStart: from, recordingEnd: to }],
});
const file = drive => async (now) => (await processJobs({
  store, now, workerId: "filing", handlers: {
    file_recording: input => fileRecording({ store, drive, download: async (record, { start, end }) => syntheticContent(record.providerFileId, start, end), rootFolderId: drive.rootFolderId, ...input }),
    delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await store.completeJob({ jobId: job.id, leaseVersion })) ? "DONE" : "LEASE_LOST" }),
  },
})).filter(result => String(result.jobId).startsWith("file:"));
const recordOf = id => store.fileRecord(id);

describe("a block room's recordings in Drive", () => {
  test("named students_tutors_New-York-date, filed in the New York month's folder and the room's folder; a second recording gets _P02; each keeps its own snapshot", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-F1`, START + 2 * MIN, START + 20 * MIN);
    // Bob leaves; the second recording covers Alice and both tutors only.
    await ctx.fact("session.user_left", START + 25 * MIN, { providerSessionId: "ZS-F", participantId: ctx.row("B") });
    await completed(ctx, `${ctx.code}-F2`, START + 30 * MIN, START + 50 * MIN);
    expect((await recordOf(`${ctx.code}-F1`)).plannedName).toBe("Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30.mp4");
    expect((await recordOf(`${ctx.code}-F2`)).plannedName).toBe("Alice Wang_Carol Chen+Dan Wu_2026-11-30.mp4");
    const snapshots = (await store.eventsFor([ctx.lesson.id])).filter(event => event.type === "p1.recording_snapshot");
    expect(snapshots.map(event => event.snapshot.recordingId).sort()).toEqual([`${ctx.code}-F1`, `${ctx.code}-F2`]);
    const first = snapshots.find(event => event.snapshot.recordingId === `${ctx.code}-F1`).snapshot;
    expect(first).toMatchObject({ blockCode: ctx.code, roomLabel: "R1", providerSessionId: "ZS-F", date: "2026-11-30", decision: { eligible: true }, hold: null });
    const results = await file(drive)(START + 60 * MIN);
    expect(results.map(result => result.status)).toEqual(["STORED", "STORED"]);
    const month = drive.ensureFolder(drive.rootFolderId, "[iHear] 11.2026.Zoom Recordings");
    const folder = drive.ensureFolder(month, `2026-11-30_${ctx.code}-R1`);
    const names = drive.listNamesNow ? drive.listNamesNow(folder) : await drive.listNames(folder);
    expect([...names].sort()).toEqual(["Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30.mp4", "Alice Wang_Carol Chen+Dan Wu_2026-11-30.mp4"]);
  });

  test("a third recording with the same people as the first gets the next part, and a file already there with that name (not ours) is never written over", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-G1`, START + 2 * MIN, START + 10 * MIN);
    await completed(ctx, `${ctx.code}-G2`, START + 12 * MIN, START + 20 * MIN);
    expect((await recordOf(`${ctx.code}-G2`)).plannedName).toBe("Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30_P02.mp4");
    const month = drive.ensureFolder(drive.rootFolderId, "[iHear] 11.2026.Zoom Recordings");
    const folder = drive.ensureFolder(month, `2026-11-30_${ctx.code}-R1`);
    const theirs = drive.addFile({ name: "Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30.mp4", parentId: folder, appProperties: { providerFileId: "someone-else" }, size: 5 });
    const results = await file(drive)(START + 60 * MIN);
    expect(results.map(result => result.status)).toEqual(["STORED", "STORED"]);
    const names = await drive.listNames(folder);
    expect(names.filter(name => name === "Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30.mp4")).toHaveLength(1);
    expect(drive.trashedFiles().map(entry => entry.id)).not.toContain(theirs);
    expect(names).toContain("Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30_P02.mp4");
  });

  test("18.5: a copy of the recording found outside its own folder is never reported as filed, and nothing is deleted", async () => {
    const ctx = await room();
    const drive = createDrive();
    await completed(ctx, `${ctx.code}-H1`, START + 2 * MIN, START + 20 * MIN);
    const elsewhere = drive.ensureFolder(drive.rootFolderId, "somewhere-else");
    const stray = drive.addFile({ name: "Alice Wang+Bob Lee_Carol Chen+Dan Wu_2026-11-30.mp4", parentId: elsewhere, appProperties: { providerFileId: `${ctx.code}-H1` }, size: 1000 });
    const results = await file(drive)(START + 60 * MIN);
    expect(results.map(result => result.status)).not.toContain("STORED");
    expect((await recordOf(`${ctx.code}-H1`)).status).not.toBe("STORED");
    expect(drive.trashedFiles().map(entry => entry.id)).not.toContain(stray);
  });
});
