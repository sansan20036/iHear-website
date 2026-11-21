import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAllBeforeWriting } from "./helpers/read-before-write.mjs";

// Gate B round 10 (2026-11-22): the recordings' retention, policy neutral and off. How long recordings
// are kept and whether they are deleted are iHear's decision: unset, nothing is ever due; set, an
// owner previews and applies exactly the plan previewed; each deletion is recorded; a copy whose Drive
// record does not name the recording is never deleted. Synthetic only (the file store, a fake Drive).
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-retention-"));
const { createFileClassroomStore } = await import("../lib/classroom-store");
const { previewRetention, runRetention } = await import("../lib/classroom-retention");
// @ts-ignore
const { planRetention, retentionPolicy, DELETED_EVENT, DELETE_FAILED_EVENT } = await import("../tools/recording-pathway/classroom/retention.mjs");
// @ts-ignore
const { createDrive } = await import("../tools/recording-pathway/test/fake-classroom-store.mjs");
// @ts-ignore
const { checkMetadata } = await import("../tools/classroom-preflight/env-check.mjs");

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

const DAY = 86_400_000;
const NOW = Date.parse("2027-03-01T12:00:00Z");
const OWNER = "owner@example.test";

describe("the retention policy (configuration only)", () => {
  test("RT-1: unset, nothing is ever due; anything but a whole number of days from 1 to 3650 is refused, never guessed; the mode is trash unless set to remove", () => {
    expect(retentionPolicy({})).toEqual({ days: null, mode: null, problem: "RETENTION_NOT_SET" });
    expect(retentionPolicy({ CLASSROOM_RECORDING_RETENTION_DAYS: "  " }).problem).toBe("RETENTION_NOT_SET");
    for (const bad of ["0", "-1", "1.5", "30d", "abc", "3651", "99999", "1e3"]) expect(retentionPolicy({ CLASSROOM_RECORDING_RETENTION_DAYS: bad }).problem, bad).toBe("RETENTION_INVALID");
    expect(retentionPolicy({ CLASSROOM_RECORDING_RETENTION_DAYS: "30" })).toEqual({ days: 30, mode: "trash", problem: null });
    expect(retentionPolicy({ CLASSROOM_RECORDING_RETENTION_DAYS: "3650", CLASSROOM_RECORDING_RETENTION_MODE: "remove" })).toEqual({ days: 3650, mode: "remove", problem: null });
    expect(retentionPolicy({ CLASSROOM_RECORDING_RETENTION_DAYS: "30", CLASSROOM_RECORDING_RETENTION_MODE: "delete" }).problem).toBe("RETENTION_MODE_INVALID");
  });

  test("RT-2: only a filed copy with a Drive file of its own, filed before the cutoff, is due; held, quarantined, failed, not filed, without a lesson or already deleted never; the plan's digest follows what is due", () => {
    const policy = { days: 30, mode: "trash", problem: null };
    const old = NOW - 31 * DAY, recent = NOW - 29 * DAY;
    const records = [
      { providerFileId: "A", lessonId: "L1", status: "STORED", driveFileId: "d-A", filedAt: old, plannedName: "a.mp4" },
      { providerFileId: "B", lessonId: "L1", status: "STORED", driveFileId: "d-B", filedAt: recent },
      { providerFileId: "C", lessonId: "L1", status: "QUARANTINED", driveFileId: "d-C", filedAt: old },
      { providerFileId: "D", lessonId: "L1", status: "FAILED", driveFileId: null, filedAt: old },
      { providerFileId: "E", lessonId: "L1", status: "STORED", driveFileId: "d-E", filedAt: old, hold: "CONSENT" },
      { providerFileId: "F", lessonId: null, status: "STORED", driveFileId: "d-F", filedAt: old },
      { providerFileId: "G", lessonId: "L1", status: "STORED", driveFileId: "d-G", filedAt: old },
      { providerFileId: "H", lessonId: "L1", status: "STORED", driveFileId: "d-H", filedAt: null },
      { providerFileId: "I", lessonId: "L1", status: "PENDING", driveFileId: null, filedAt: null },
    ];
    const plan = planRetention({ records, deletedIds: new Set(["G"]), policy, now: NOW });
    expect(plan.due.map(item => item.providerFileId)).toEqual(["A"]);
    expect(plan.kept).toEqual([{ providerFileId: "E", reason: "HELD" }, { providerFileId: "F", reason: "NO_LESSON" }, { providerFileId: "H", reason: "NO_FILED_TIME" }]);
    expect(plan.digest).toMatch(/^[0-9a-f]{24}$/);
    expect(planRetention({ records, deletedIds: new Set(["G"]), policy, now: NOW }).digest).toBe(plan.digest);
    expect(planRetention({ records, deletedIds: new Set(), policy, now: NOW }).digest).not.toBe(plan.digest);
    expect(planRetention({ records, deletedIds: new Set(["G"]), policy: { ...policy, mode: "remove" }, now: NOW }).digest).not.toBe(plan.digest);
    expect(planRetention({ records, policy: { days: null, mode: null, problem: "RETENTION_NOT_SET" }, now: NOW })).toMatchObject({ problem: "RETENTION_NOT_SET", due: [], digest: null });
  });

  test("RT-3: the period, its mode and the fixed rooms' file-name rule are never allowed in production (each is iHear's decision first)", () => {
    for (const key of ["CLASSROOM_RECORDING_RETENTION_DAYS", "CLASSROOM_RECORDING_RETENTION_MODE", "CLASSROOM_FIXED_ROOM_FILE_NAMES"]) {
      const findings = checkMetadata([{ key, type: "sensitive", target: ["production"] }], "pilot");
      expect(findings.some(entry => entry.code === "FORBIDDEN_IN_PRODUCTION" && entry.name === key), key).toBe(true);
    }
  });
});

describe("retention with the store and a Drive", () => {
  const store = createFileClassroomStore(path.join(directory, "classroom.json"));
  let lessons = 0;
  // A lesson with filed copies: each a STORED record and its copy in the Drive, named by appProperties.
  async function filed(drive, copies) {
    lessons += 1;
    const lessonId = `L-retention-${lessons}`;
    await store.createLesson({
      id: lessonId, code: `RET-${lessons}`, date: "2027-01-01", startsAt: "2027-01-01T15:00:00.000Z", endsAt: "2027-01-01T16:00:00.000Z", cancelled: false,
      createdBy: OWNER, createdAt: "2026-12-31T00:00:00.000Z", participants: [],
    }, []);
    const ids = {};
    for (const [name, filedAt, owned = true] of copies) {
      const providerFileId = `${lessonId}-${name}`;
      const uri = await drive.startUpload({ name: `${name}.mp4`, parentId: drive.rootFolderId, size: 3, appProperties: { providerFileId: owned ? providerFileId : "someone-else", lessonId } });
      const { fileId } = await drive.uploadChunk(uri, { offset: 0, bytes: Buffer.from("abc"), total: 3 });
      await store.transaction(async tx => {
        await tx.insertFileRecord({ providerFileId, lessonId, status: "PENDING", provider: "synthetic", extension: "mp4", size: 3, plannedName: `${name}.mp4` });
        await tx.updateFileRecord(providerFileId, { status: "STORED", driveFileId: fileId, filedAt });
      });
      ids[name] = { providerFileId, fileId };
    }
    return { lessonId, ids };
  }

  test("RT-4: unset, the preview and the apply both refuse and nothing changes", async () => {
    const drive = createDrive();
    const { ids } = await filed(drive, [["old", NOW - 400 * DAY]]);
    expect((await previewRetention({ store, now: NOW })).body.code).toBe("RETENTION_NOT_SET");
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: "anything" })).body.code).toBe("RETENTION_NOT_SET");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "0");
    expect((await previewRetention({ store, now: NOW })).body.code).toBe("RETENTION_INVALID");
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
  });

  test("RT-5: set to 30 days: the preview lists what is due and changes nothing; an apply without the preview's digest, or after what is due changed, deletes nothing; with it, each due copy goes to the trash and its deletion is recorded once; a second apply finds nothing due", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    const drive = createDrive();
    const { lessonId, ids } = await filed(drive, [["old", NOW - 31 * DAY], ["recent", NOW - 10 * DAY]]);
    const preview = await previewRetention({ store, now: NOW });
    expect(preview.status).toBe(200);
    const ours = preview.body.due.filter(item => item.recordingId.startsWith(lessonId));
    expect(ours.map(item => item.recordingId)).toEqual([ids.old.providerFileId]);
    expect(preview.body).toMatchObject({ days: 30, mode: "trash" });
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: undefined })).body.code).toBe("PLAN_CHANGED");
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: "0".repeat(24) })).body.code).toBe("PLAN_CHANGED");
    // What is due changed after the preview (another copy came due): the old digest deletes nothing.
    const later = await filed(drive, [["also-old", NOW - 45 * DAY]]);
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest })).body.code).toBe("PLAN_CHANGED");
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
    const again = await previewRetention({ store, now: NOW });
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: again.body.digest });
    expect(applied.status).toBe(200);
    const outcomes = Object.fromEntries(applied.body.results.map(entry => [entry.providerFileId, entry.outcome]));
    expect(outcomes[ids.old.providerFileId]).toBe("TRASHED");
    expect(outcomes[later.ids["also-old"].providerFileId]).toBe("TRASHED");
    expect(outcomes[ids.recent.providerFileId]).toBeUndefined();
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(true);
    expect((await drive.getFile(ids.recent.fileId)).trashed).toBe(false);
    const facts = (await store.eventsFor([lessonId])).filter(event => event.type === DELETED_EVENT);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ source: "server", providerFileId: ids.old.providerFileId, driveFileId: ids.old.fileId, mode: "trash", days: 30, actor: OWNER, outcome: "TRASHED", planDigest: again.body.digest });
    const after = await previewRetention({ store, now: NOW });
    expect(after.body.due.filter(item => item.recordingId.startsWith(lessonId) || item.recordingId.startsWith(later.lessonId))).toEqual([]);
  });

  test("RT-6: a copy whose Drive record names another recording is never deleted (said as such, tried again next time); a Drive that refuses or cannot be read is said, nothing recorded as deleted; a copy already gone is recorded as such; mode remove deletes for good", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_MODE", "remove");
    const drive = createDrive();
    const { lessonId, ids } = await filed(drive, [["foreign", NOW - 60 * DAY, false], ["refused", NOW - 59 * DAY], ["unread", NOW - 58 * DAY], ["gone", NOW - 57 * DAY], ["removed", NOW - 56 * DAY]]);
    await drive.remove(ids.gone.fileId);
    const realRemove = drive.remove.bind(drive);
    drive.remove = async id => { if (id === ids.refused.fileId) throw new Error("synthetic Drive refusal"); return realRemove(id); };
    const realGet = drive.getFile.bind(drive);
    drive.getFile = async id => { if (id === ids.unread.fileId) throw new Error("synthetic Drive read failure"); return realGet(id); };
    const preview = await previewRetention({ store, now: NOW });
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    const outcomes = Object.fromEntries(applied.body.results.filter(entry => entry.providerFileId.startsWith(lessonId)).map(entry => [entry.providerFileId.slice(lessonId.length + 1), entry.outcome]));
    expect(outcomes).toEqual({ foreign: "NOT_THIS_RECORDING", refused: "DRIVE_REFUSED", unread: "NOT_CHECKED", gone: "ALREADY_GONE", removed: "REMOVED" });
    expect(await realGet(ids.foreign.fileId)).not.toBeNull();
    expect(await realGet(ids.refused.fileId)).not.toBeNull();
    expect(await realGet(ids.removed.fileId)).toBeNull();
    const facts = await store.eventsFor([lessonId]);
    expect(facts.filter(event => event.type === DELETED_EVENT).map(event => event.providerFileId.slice(lessonId.length + 1)).sort()).toEqual(["gone", "removed"]);
    expect(facts.filter(event => event.type === DELETE_FAILED_EVENT).map(event => [event.providerFileId.slice(lessonId.length + 1), event.reason]).sort()).toEqual([["foreign", "NOT_THIS_RECORDING"], ["refused", "DRIVE_REFUSED"], ["unread", "NOT_CHECKED"]]);
    const next = await previewRetention({ store, now: NOW });
    expect(next.body.due.filter(item => item.recordingId.startsWith(lessonId)).map(item => item.recordingId.slice(lessonId.length + 1)).sort()).toEqual(["foreign", "refused", "unread"]);
  });

  test("RT-7: two applies of the same plan at the same moment record each deletion once", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    const drive = createDrive();
    const { lessonId } = await filed(drive, [["twice", NOW - 90 * DAY]]);
    const preview = await previewRetention({ store, now: NOW });
    const [a, b] = readAllBeforeWriting([store, store]);
    const both = await Promise.all([a, b].map(each => runRetention({ store: each, drive, now: NOW, actor: OWNER, confirm: preview.body.digest })));
    for (const answer of both) expect(answer.status).toBe(200);
    expect((await store.eventsFor([lessonId])).filter(event => event.type === DELETED_EVENT)).toHaveLength(1);
  });
});
