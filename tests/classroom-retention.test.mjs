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
const { planRetention, retentionPolicy, DELETED_EVENT, DELETE_FAILED_EVENT, DELETE_STARTED_EVENT, DELETE_BLOCKED_EVENT } = await import("../tools/recording-pathway/classroom/retention.mjs");
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
    // A copy a person must look at first (its Drive record named another recording, or Drive did not
    // show it) is never due: listed as such, by the facts or by the store's flag.
    const needsPerson = planRetention({ records: [...records, { providerFileId: "J", lessonId: "L1", status: "STORED", driveFileId: "d-J", filedAt: old, retentionBlocked: true }], deletedIds: new Set(["G"]), blockedIds: new Set(["A"]), policy, now: NOW });
    expect(needsPerson.due).toEqual([]);
    expect(needsPerson.kept.filter(item => item.reason === "NEEDS_PERSON").map(item => item.providerFileId)).toEqual(["A", "J"]);
  });

  test("RT-3: the period, its mode and the fixed rooms' file-name rule are never allowed in production (each is iHear's decision first)", () => {
    for (const key of ["CLASSROOM_RECORDING_RETENTION_DAYS", "CLASSROOM_RECORDING_RETENTION_MODE", "CLASSROOM_FIXED_ROOM_FILE_NAMES"]) {
      const findings = checkMetadata([{ key, type: "sensitive", target: ["production"] }], "pilot");
      expect(findings.some(entry => entry.code === "FORBIDDEN_IN_PRODUCTION" && entry.name === key), key).toBe(true);
    }
  });
});

describe("retention with the store and a Drive", () => {
  let stores = 0, lessons = 0;
  // Each test its own store (copies left by another test never count).
  const freshStore = () => { stores += 1; return createFileClassroomStore(path.join(directory, `classroom-${stores}.json`)); };
  // A lesson with filed copies: each a STORED record and its copy in the Drive, named by appProperties.
  async function filed(store, drive, copies) {
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
  const outcomesOf = (answer, lessonId) => Object.fromEntries(answer.body.results.filter(entry => entry.recordingId.startsWith(lessonId)).map(entry => [entry.recordingId.slice(lessonId.length + 1), entry.outcome]));
  const dueOf = (preview, lessonId) => preview.body.due.filter(item => item.recordingId.startsWith(lessonId)).map(item => item.recordingId.slice(lessonId.length + 1));

  test("RT-4: unset, the preview and the apply both refuse and nothing changes", async () => {
    const store = freshStore(), drive = createDrive();
    const { ids } = await filed(store, drive, [["old", NOW - 400 * DAY]]);
    expect((await previewRetention({ store, now: NOW })).body.code).toBe("RETENTION_NOT_SET");
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: "anything" })).body.code).toBe("RETENTION_NOT_SET");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "0");
    expect((await previewRetention({ store, now: NOW })).body.code).toBe("RETENTION_INVALID");
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
  });

  test("RT-5: set to 30 days: the preview lists what is due and changes nothing; an apply without the preview's digest, or after what is due changed, deletes nothing; with it, each due copy goes to the trash, the attempt and the deletion are recorded once; a second apply finds nothing due", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    const store = freshStore(), drive = createDrive();
    const { lessonId, ids } = await filed(store, drive, [["old", NOW - 31 * DAY], ["recent", NOW - 10 * DAY]]);
    const preview = await previewRetention({ store, now: NOW });
    expect(preview.status).toBe(200);
    expect(dueOf(preview, lessonId)).toEqual(["old"]);
    expect(preview.body).toMatchObject({ days: 30, mode: "trash", truncated: false });
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: undefined })).body.code).toBe("PLAN_CHANGED");
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: "0".repeat(24) })).body.code).toBe("PLAN_CHANGED");
    const later = await filed(store, drive, [["also-old", NOW - 45 * DAY]]);
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest })).body.code).toBe("PLAN_CHANGED");
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
    const again = await previewRetention({ store, now: NOW });
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: again.body.digest });
    expect(applied.status).toBe(200);
    expect(outcomesOf(applied, lessonId)).toEqual({ old: "TRASHED" });
    expect(outcomesOf(applied, later.lessonId)).toEqual({ "also-old": "TRASHED" });
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(true);
    expect((await drive.getFile(ids.recent.fileId)).trashed).toBe(false);
    const facts = await store.eventsFor([lessonId]);
    expect(facts.filter(event => event.type === DELETED_EVENT)).toEqual([expect.objectContaining({ source: "server", providerFileId: ids.old.providerFileId, driveFileId: ids.old.fileId, mode: "trash", days: 30, actor: OWNER, outcome: "TRASHED", planDigest: again.body.digest })]);
    expect(facts.filter(event => event.type === DELETE_STARTED_EVENT)).toEqual([expect.objectContaining({ providerFileId: ids.old.providerFileId, actor: OWNER, planDigest: again.body.digest })]);
    const after = await previewRetention({ store, now: NOW });
    expect([...dueOf(after, lessonId), ...dueOf(after, later.lessonId)]).toEqual([]);
  });

  test("RT-6: a copy whose Drive record names another recording, or that Drive does not show, is never deleted and needs a person (left out of later plans, listed as such); a Drive that refuses or cannot be read is said and tried again; mode remove deletes for good", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_MODE", "remove");
    const store = freshStore(), drive = createDrive();
    const { lessonId, ids } = await filed(store, drive, [["foreign", NOW - 60 * DAY, false], ["refused", NOW - 59 * DAY], ["unread", NOW - 58 * DAY], ["unseen", NOW - 57 * DAY], ["removed", NOW - 56 * DAY]]);
    await drive.remove(ids.unseen.fileId);
    const realRemove = drive.remove.bind(drive);
    drive.remove = async id => { if (id === ids.refused.fileId) throw new Error("synthetic Drive refusal"); return realRemove(id); };
    const realGet = drive.getFile.bind(drive);
    drive.getFile = async id => { if (id === ids.unread.fileId) throw new Error("synthetic Drive read failure"); return realGet(id); };
    const preview = await previewRetention({ store, now: NOW });
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    expect(outcomesOf(applied, lessonId)).toEqual({ foreign: "NOT_THIS_RECORDING", refused: "DRIVE_REFUSED", unread: "NOT_CHECKED", unseen: "NOT_VISIBLE", removed: "REMOVED" });
    expect(await realGet(ids.foreign.fileId)).not.toBeNull();
    expect(await realGet(ids.refused.fileId)).not.toBeNull();
    expect(await realGet(ids.removed.fileId)).toBeNull();
    const facts = await store.eventsFor([lessonId]);
    const short = event => event.providerFileId.slice(lessonId.length + 1);
    expect(facts.filter(event => event.type === DELETED_EVENT).map(short)).toEqual(["removed"]);
    expect(facts.filter(event => event.type === DELETE_FAILED_EVENT).map(event => [short(event), event.reason]).sort()).toEqual([["foreign", "NOT_THIS_RECORDING"], ["refused", "DRIVE_REFUSED"], ["unread", "NOT_CHECKED"], ["unseen", "NOT_VISIBLE"]]);
    expect(facts.filter(event => event.type === DELETE_BLOCKED_EVENT).map(short).sort()).toEqual(["foreign", "unseen"]);
    const next = await previewRetention({ store, now: NOW });
    expect(dueOf(next, lessonId).sort()).toEqual(["refused", "unread"]);
    expect(next.body.kept.filter(item => item.recordingId.startsWith(lessonId)).map(item => [item.recordingId.slice(lessonId.length + 1), item.reason]).sort()).toEqual([["foreign", "NEEDS_PERSON"], ["unseen", "NEEDS_PERSON"]]);
  });

  test("RT-7: two applies of the same plan at the same moment record each deletion once", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    const store = freshStore(), drive = createDrive();
    const { lessonId } = await filed(store, drive, [["twice", NOW - 90 * DAY]]);
    const preview = await previewRetention({ store, now: NOW });
    const [a, b] = readAllBeforeWriting([store, store]);
    const both = await Promise.all([a, b].map(each => runRetention({ store: each, drive, now: NOW, actor: OWNER, confirm: preview.body.digest })));
    for (const answer of both) expect(answer.status).toBe(200);
    expect((await store.eventsFor([lessonId])).filter(event => event.type === DELETED_EVENT)).toHaveLength(1);
  });

  // Review finding 1: the deleted copies stayed in every later batch, so after the first batch nothing
  // was ever due again.
  test("RT-8: more due than one batch holds: the preview says so; each apply takes the next oldest; deleted copies never fill a later batch, so every due copy is reached", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    const store = freshStore(), drive = createDrive();
    const names = ["a", "b", "c", "d", "e"];
    const { lessonId, ids } = await filed(store, drive, names.map((name, index) => [name, NOW - (90 - index) * DAY]));
    const seen = [];
    for (const expected of [["a", "b"], ["c", "d"], ["e"]]) {
      const preview = await previewRetention({ store, now: NOW, limit: 2 });
      expect(dueOf(preview, lessonId)).toEqual(expected);
      expect(preview.body.truncated).toBe(expected.length === 2);
      const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest, limit: 2 });
      expect(Object.values(outcomesOf(applied, lessonId))).toEqual(expected.map(() => "TRASHED"));
      seen.push(...expected);
    }
    expect(seen).toEqual(names);
    for (const name of names) expect((await drive.getFile(ids[name].fileId)).trashed).toBe(true);
    const done = await previewRetention({ store, now: NOW, limit: 2 });
    expect(done.body).toMatchObject({ due: [], truncated: false });
  });

  // Review finding 5: a failed write after Drive deleted the copy must not stop the run or lose who did it.
  test("RT-9: the deletion's record cannot be written after Drive deleted the copy: said for that copy, the others go on; who started it is recorded before Drive is asked; the next apply records the copy in the trash", async () => {
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "30");
    const store = freshStore(), drive = createDrive();
    const { lessonId, ids } = await filed(store, drive, [["first", NOW - 80 * DAY], ["second", NOW - 79 * DAY]]);
    const failing = new Proxy(store, {
      get(target, property) {
        if (property === "transaction") return async work => target.transaction(async tx => work(new Proxy(tx, {
          get(inner, name) {
            if (name === "insertEvent") return async event => { if (event.type === DELETED_EVENT && event.providerFileId === ids.first.providerFileId) throw new Error("synthetic store failure"); return inner.insertEvent(event); };
            const value = inner[name];
            return typeof value === "function" ? value.bind(inner) : value;
          },
        })));
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const preview = await previewRetention({ store, now: NOW });
    const applied = await runRetention({ store: failing, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    expect(applied.status).toBe(200);
    expect(applied.body.results.filter(entry => entry.recordingId.startsWith(lessonId))).toEqual([
      { recordingId: ids.first.providerFileId, outcome: "TRASHED", note: "NOT_RECORDED" },
      { recordingId: ids.second.providerFileId, outcome: "TRASHED" },
    ]);
    const started = (await store.eventsFor([lessonId])).filter(event => event.type === DELETE_STARTED_EVENT && event.providerFileId === ids.first.providerFileId);
    expect(started).toEqual([expect.objectContaining({ actor: OWNER, planDigest: preview.body.digest })]);
    const next = await previewRetention({ store, now: NOW });
    expect(dueOf(next, lessonId)).toEqual(["first"]);
    const second = await runRetention({ store, drive, now: NOW, actor: "another-owner@example.test", confirm: next.body.digest });
    expect(outcomesOf(second, lessonId)).toEqual({ first: "ALREADY_IN_TRASH" });
    expect((await store.eventsFor([lessonId])).filter(event => event.type === DELETED_EVENT).map(event => [event.providerFileId, event.outcome]).sort()).toEqual([[ids.first.providerFileId, "ALREADY_IN_TRASH"], [ids.second.providerFileId, "TRASHED"]]);
  });
});

