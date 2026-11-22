import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAllBeforeWriting } from "./helpers/read-before-write.mjs";

// Gate B round 10 (2026-11-22): the recordings' retention, policy neutral and off. How long recordings
// are kept and whether they are deleted are iHear's decision: unset, nothing is ever due; set, an
// owner previews and applies exactly the plan previewed; each deletion is recorded; a copy whose Drive
// record does not name the recording is never deleted. Synthetic only (the file store, a fake Drive).
// Round 12 (2026-11-22, the user): a period never reaches the original one-to-one classroom's
// recordings by accident. It names the kinds of recording it covers (no default); only a person the
// site names may apply it; a permanent deletion needs its own yes; and after a deletion every list
// says DELETED, never "ARCHIVED 歸檔完成".
const directory = await mkdtemp(path.join(os.tmpdir(), "ihear-retention-"));
const { createFileClassroomStore, RECORDING_KIND_NAMES, RETENTION_FACT_TYPES } = await import("../lib/classroom-store");
const { previewRetention, retentionActivityStatus, runRetention } = await import("../lib/classroom-retention");
const { filingStateOf } = await import("../lib/classroom-blocks");
const { filingLabel } = await import("../lib/classroom-filing-labels");
// @ts-ignore
const { planRetention, retentionPolicy, retentionStateOf, RECORDING_KINDS, RETENTION_EVENTS, DELETED_EVENT, DELETE_FAILED_EVENT, DELETE_STARTED_EVENT, DELETE_BLOCKED_EVENT } = await import("../tools/recording-pathway/classroom/retention.mjs");
// @ts-ignore
const { createDrive } = await import("../tools/recording-pathway/test/fake-classroom-store.mjs");
// @ts-ignore
const { checkMetadata } = await import("../tools/classroom-preflight/env-check.mjs");

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

const DAY = 86_400_000;
const NOW = Date.parse("2027-03-01T12:00:00Z");
const OWNER = "owner@example.test";
const OTHER = "another-owner@example.test";

// A period set as an owner would set it (round 12): days, the kinds it covers, who may apply it.
function setPolicy({ days = "30", mode = null, scope = "fixed-room", deleters = `${OWNER},${OTHER}` } = {}) {
  vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", days);
  if (mode != null) vi.stubEnv("CLASSROOM_RECORDING_RETENTION_MODE", mode);
  if (scope != null) vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", scope);
  if (deleters != null) vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", deleters);
}

describe("the retention policy (configuration only)", () => {
  test("RT-1: unset, nothing is ever due; anything but a whole number of days from 1 to 3650 is refused, never guessed; the mode is trash unless set to remove", () => {
    expect(retentionPolicy({})).toEqual({ days: null, mode: null, scope: [], deleters: [], problem: "RETENTION_NOT_SET" });
    expect(retentionPolicy({ CLASSROOM_RECORDING_RETENTION_DAYS: "  " }).problem).toBe("RETENTION_NOT_SET");
    for (const bad of ["0", "-1", "1.5", "30d", "abc", "3651", "99999", "1e3"]) expect(retentionPolicy({ CLASSROOM_RECORDING_RETENTION_DAYS: bad }).problem, bad).toBe("RETENTION_INVALID");
    const scoped = { CLASSROOM_RECORDING_RETENTION_DAYS: "30", CLASSROOM_RECORDING_RETENTION_SCOPE: "fixed-room" };
    expect(retentionPolicy(scoped)).toEqual({ days: 30, mode: "trash", scope: ["fixed-room"], deleters: [], problem: null });
    expect(retentionPolicy({ ...scoped, CLASSROOM_RECORDING_RETENTION_DAYS: "3650", CLASSROOM_RECORDING_RETENTION_MODE: "remove" })).toMatchObject({ days: 3650, mode: "remove", problem: null });
    expect(retentionPolicy({ ...scoped, CLASSROOM_RECORDING_RETENTION_MODE: "delete" }).problem).toBe("RETENTION_MODE_INVALID");
  });

  test("RT-1b: round 12: a period names the kinds of recording it covers (no default, so never a one-to-one recording by accident) and who may apply it; the store and the shared logic name the same kinds and facts", () => {
    const days = { CLASSROOM_RECORDING_RETENTION_DAYS: "30" };
    expect(retentionPolicy(days).problem).toBe("RETENTION_SCOPE_NOT_SET");
    expect(retentionPolicy({ ...days, CLASSROOM_RECORDING_RETENTION_SCOPE: " , " }).problem).toBe("RETENTION_SCOPE_NOT_SET");
    for (const bad of ["all", "*", "one to one", "fixed-rooms", "recordings", "fixed-room,everything"]) expect(retentionPolicy({ ...days, CLASSROOM_RECORDING_RETENTION_SCOPE: bad }).problem, bad).toBe("RETENTION_SCOPE_INVALID");
    expect(retentionPolicy({ ...days, CLASSROOM_RECORDING_RETENTION_SCOPE: " Fixed-Room, block ,fixed-room" }).scope).toEqual(["block", "fixed-room"]);
    expect(retentionPolicy({ ...days, CLASSROOM_RECORDING_RETENTION_SCOPE: "one-to-one" }).scope).toEqual(["one-to-one"]);
    const scoped = { ...days, CLASSROOM_RECORDING_RETENTION_SCOPE: "fixed-room" };
    expect(retentionPolicy({ ...scoped, CLASSROOM_RECORDING_RETENTION_DELETERS: " Owner@Example.Test ,b@example.test" }).deleters).toEqual(["b@example.test", "owner@example.test"]);
    for (const bad of ["owner", "a@b", "a@b.c d@e.f", "@example.test"]) expect(retentionPolicy({ ...scoped, CLASSROOM_RECORDING_RETENTION_DELETERS: bad }).problem, bad).toBe("RETENTION_DELETERS_INVALID");
    expect([...RECORDING_KIND_NAMES]).toEqual([...RECORDING_KINDS]);
    expect([...RETENTION_FACT_TYPES].sort()).toEqual([...RETENTION_EVENTS].sort());
  });

  test("RT-2: only a filed copy of a kind in scope, with a Drive file of its own, filed before the cutoff, is due; held, quarantined, failed, not filed, without a lesson, already deleted, of another kind or of no known kind never; the plan's digest follows what is due and its scope", () => {
    const policy = { days: 30, mode: "trash", scope: ["fixed-room"], deleters: [], problem: null };
    const old = NOW - 31 * DAY, recent = NOW - 29 * DAY;
    const fixed = { kind: "fixed-room" };
    const records = [
      { ...fixed, providerFileId: "A", lessonId: "L1", status: "STORED", driveFileId: "d-A", filedAt: old, plannedName: "a.mp4" },
      { ...fixed, providerFileId: "B", lessonId: "L1", status: "STORED", driveFileId: "d-B", filedAt: recent },
      { ...fixed, providerFileId: "C", lessonId: "L1", status: "QUARANTINED", driveFileId: "d-C", filedAt: old },
      { ...fixed, providerFileId: "D", lessonId: "L1", status: "FAILED", driveFileId: null, filedAt: old },
      { ...fixed, providerFileId: "E", lessonId: "L1", status: "STORED", driveFileId: "d-E", filedAt: old, hold: "CONSENT" },
      { ...fixed, providerFileId: "F", lessonId: null, status: "STORED", driveFileId: "d-F", filedAt: old },
      { ...fixed, providerFileId: "G", lessonId: "L1", status: "STORED", driveFileId: "d-G", filedAt: old },
      { ...fixed, providerFileId: "H", lessonId: "L1", status: "STORED", driveFileId: "d-H", filedAt: null },
      { ...fixed, providerFileId: "I", lessonId: "L1", status: "PENDING", driveFileId: null, filedAt: null },
      // Round 12: a one-to-one lesson's copy, and one whose kind is not known: never due here.
      { kind: "one-to-one", providerFileId: "K", lessonId: "L2", status: "STORED", driveFileId: "d-K", filedAt: old },
      { providerFileId: "U", lessonId: "L3", status: "STORED", driveFileId: "d-U", filedAt: old },
    ];
    const plan = planRetention({ records, deletedIds: new Set(["G"]), policy, now: NOW });
    expect(plan.due.map(item => [item.providerFileId, item.kind])).toEqual([["A", "fixed-room"]]);
    expect(plan.kept).toEqual([
      { providerFileId: "E", reason: "HELD" }, { providerFileId: "F", reason: "NO_LESSON" }, { providerFileId: "H", reason: "NO_FILED_TIME" },
      { providerFileId: "K", reason: "OUT_OF_SCOPE" }, { providerFileId: "U", reason: "UNKNOWN_KIND" },
    ]);
    expect(plan).toMatchObject({ scope: ["fixed-room"], byKind: { "fixed-room": 1 } });
    expect(plan.digest).toMatch(/^[0-9a-f]{24}$/);
    expect(planRetention({ records, deletedIds: new Set(["G"]), policy, now: NOW }).digest).toBe(plan.digest);
    expect(planRetention({ records, deletedIds: new Set(), policy, now: NOW }).digest).not.toBe(plan.digest);
    expect(planRetention({ records, deletedIds: new Set(["G"]), policy: { ...policy, mode: "remove" }, now: NOW }).digest).not.toBe(plan.digest);
    // The same copies due under another scope are another plan.
    const wider = planRetention({ records, deletedIds: new Set(["G"]), policy: { ...policy, scope: ["block", "fixed-room"] }, now: NOW });
    expect(wider.due.map(item => item.providerFileId)).toEqual(["A"]);
    expect(wider.digest).not.toBe(plan.digest);
    // The one-to-one copy only where the scope names it.
    expect(planRetention({ records, deletedIds: new Set(["G"]), policy: { ...policy, scope: ["fixed-room", "one-to-one"] }, now: NOW }).due.map(item => item.providerFileId)).toEqual(["A", "K"]);
    expect(planRetention({ records, policy: { days: null, mode: null, scope: [], deleters: [], problem: "RETENTION_NOT_SET" }, now: NOW })).toMatchObject({ problem: "RETENTION_NOT_SET", due: [], digest: null });
    // A copy a person must look at first (its Drive record named another recording, or Drive did not
    // show it) is never due: listed as such, by the facts or by the store's flag.
    const needsPerson = planRetention({ records: [...records, { ...fixed, providerFileId: "J", lessonId: "L1", status: "STORED", driveFileId: "d-J", filedAt: old, retentionBlocked: true }], deletedIds: new Set(["G"]), blockedIds: new Set(["A"]), policy, now: NOW });
    expect(needsPerson.due).toEqual([]);
    expect(needsPerson.kept.filter(item => item.reason === "NEEDS_PERSON").map(item => item.providerFileId)).toEqual(["A", "J"]);
  });

  test("RT-3: the period, its mode, its scope, who may apply it and the fixed rooms' file-name rule are never allowed in production (each is iHear's decision first)", () => {
    for (const key of ["CLASSROOM_RECORDING_RETENTION_DAYS", "CLASSROOM_RECORDING_RETENTION_MODE", "CLASSROOM_RECORDING_RETENTION_SCOPE", "CLASSROOM_RECORDING_RETENTION_DELETERS", "CLASSROOM_FIXED_ROOM_FILE_NAMES"]) {
      const findings = checkMetadata([{ key, type: "sensitive", target: ["production"] }], "pilot");
      expect(findings.some(entry => entry.code === "FORBIDDEN_IN_PRODUCTION" && entry.name === key), key).toBe(true);
    }
  });

  test("RT-13: round 12: the one rule for a recording's retention state: deleted beats everything; a person is needed when Drive could not confirm the copy; a start with no outcome is under way; a start after a failure is a new attempt; only the server's facts count", () => {
    const fact = (type, at, extra = {}) => ({ source: "server", type, providerFileId: "X", occurredAt: at, ...extra });
    expect(retentionStateOf([])).toEqual({ state: null });
    expect(retentionStateOf([fact(DELETE_STARTED_EVENT, 1)])).toMatchObject({ state: "DELETING", at: 1 });
    expect(retentionStateOf([fact(DELETE_STARTED_EVENT, 1), fact(DELETE_FAILED_EVENT, 1, { reason: "DRIVE_REFUSED" })])).toMatchObject({ state: "DELETE_FAILED", reason: "DRIVE_REFUSED" });
    expect(retentionStateOf([fact(DELETE_STARTED_EVENT, 1), fact(DELETE_FAILED_EVENT, 1), fact(DELETE_STARTED_EVENT, 2)])).toMatchObject({ state: "DELETING", at: 2 });
    expect(retentionStateOf([fact(DELETE_FAILED_EVENT, 1, { reason: "NOT_VISIBLE" }), fact(DELETE_BLOCKED_EVENT, 1, { reason: "NOT_VISIBLE" })])).toMatchObject({ state: "NEEDS_PERSON", reason: "NOT_VISIBLE" });
    expect(retentionStateOf([fact(DELETE_BLOCKED_EVENT, 1), fact(DELETED_EVENT, 3, { outcome: "ALREADY_IN_TRASH" })])).toEqual({ state: "DELETED", outcome: "TRASHED", at: 3 });
    expect(retentionStateOf([fact(DELETED_EVENT, 3, { outcome: "REMOVED" })])).toMatchObject({ state: "DELETED", outcome: "REMOVED" });
    // A page or a vendor never says a copy was deleted; neither does another kind of fact.
    expect(retentionStateOf([{ ...fact(DELETED_EVENT, 3, { outcome: "REMOVED" }), source: "host_sdk" }, { ...fact(DELETED_EVENT, 3), source: "zoom_webhook" }, fact("p1.filing", 4, { status: "STORED" })])).toEqual({ state: null });
    // The words every list uses.
    expect(filingLabel({ status: "ARCHIVED", retention: null })).toBe("ARCHIVED 歸檔完成");
    expect(filingLabel({ status: "STORED" })).toBe("ARCHIVED 歸檔完成");
    expect(filingLabel({ status: "DELETED", retention: { state: "DELETED", outcome: "REMOVED" } })).toBe("DELETED 已依保存期限刪除（已永久刪除）");
    expect(filingLabel({ status: "FAILED", retention: null })).toBe("FAILED");
    expect(filingStateOf({ status: "STORED" }, [])).toEqual({ status: "STORED", retention: null });
    expect(retentionActivityStatus([])).toBe("nothing_deleted");
    expect(retentionActivityStatus([{ outcome: "TRASHED" }, { outcome: "ALREADY_IN_TRASH" }, { outcome: "REMOVED" }])).toBe("deleted");
    expect(retentionActivityStatus([{ outcome: "TRASHED" }, { outcome: "TRASHED", note: "NOT_RECORDED" }])).toBe("partly_deleted");
    expect(retentionActivityStatus([{ outcome: "NOT_VISIBLE" }, { outcome: "DRIVE_REFUSED" }])).toBe("nothing_deleted");
  });
});

describe("retention with the store and a Drive", () => {
  let stores = 0, lessons = 0;
  // Each test its own store (copies left by another test never count).
  const freshStore = () => { stores += 1; return createFileClassroomStore(path.join(directory, `classroom-${stores}.json`)); };
  // A lesson of one kind with filed copies: each a STORED record and its copy in the Drive, named by
  // appProperties. Its kind as the site records it (round 12): a fixed room's lesson has a scheduling
  // fact naming the room; a block room belongs to a block; a one-to-one lesson has neither.
  async function filed(store, drive, copies, kind = "fixed-room") {
    lessons += 1;
    const lessonId = `L-retention-${lessons}`;
    const scheduled = {
      source: "server", type: "server.lesson_scheduled", key: `server.lesson_scheduled:${lessonId}`, lessonId, timeZone: "America/New_York", occurredAt: NOW - 500 * DAY, receivedAt: NOW - 500 * DAY,
      ...(kind === "fixed-room" ? { fixedRoomId: `FR-${String(lessons).padStart(32, "0")}` } : {}),
    };
    await store.createLesson({
      id: lessonId, code: `RET-${lessons}`, date: "2027-01-01", startsAt: "2027-01-01T15:00:00.000Z", endsAt: "2027-01-01T16:00:00.000Z", cancelled: false,
      createdBy: OWNER, createdAt: "2026-12-31T00:00:00.000Z", participants: [],
      ...(kind === "block" ? { blockId: `B-retention-${lessons}`, roomKind: "room", roomLabel: "R1" } : {}),
    }, kind === "block" ? [] : [scheduled]);
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
  const retentionFactsOf = async (store, lessonIds) => (await store.eventsFor(lessonIds)).filter(event => RETENTION_EVENTS.includes(event.type));

  test("RT-4: unset, the preview and the apply both refuse and nothing changes; a period that names no kind of recording deletes nothing either", async () => {
    const store = freshStore(), drive = createDrive();
    const { ids } = await filed(store, drive, [["old", NOW - 400 * DAY]]);
    expect((await previewRetention({ store, now: NOW })).body.code).toBe("RETENTION_NOT_SET");
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: "anything" })).body.code).toBe("RETENTION_NOT_SET");
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DAYS", "0");
    expect((await previewRetention({ store, now: NOW })).body.code).toBe("RETENTION_INVALID");
    setPolicy({ scope: null });
    expect((await previewRetention({ store, now: NOW, actor: OWNER })).body.code).toBe("RETENTION_SCOPE_NOT_SET");
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: "anything" })).body.code).toBe("RETENTION_SCOPE_NOT_SET");
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
  });

  test("RT-5: set to 30 days for the fixed rooms: the preview lists what is due and changes nothing; an apply without the preview's digest, or after what is due changed, deletes nothing; with it, each due copy goes to the trash, the attempt and the deletion are recorded once; a second apply finds nothing due", async () => {
    setPolicy();
    const store = freshStore(), drive = createDrive();
    const { lessonId, ids } = await filed(store, drive, [["old", NOW - 31 * DAY], ["recent", NOW - 10 * DAY]]);
    const preview = await previewRetention({ store, now: NOW, actor: OWNER });
    expect(preview.status).toBe(200);
    expect(dueOf(preview, lessonId)).toEqual(["old"]);
    expect(preview.body).toMatchObject({ days: 30, mode: "trash", scope: ["fixed-room"], byKind: { "fixed-room": 1 }, permanent: false, mayApply: true, truncated: false });
    expect(preview.body.due.find(item => item.recordingId === ids.old.providerFileId)).toMatchObject({ kind: "fixed-room" });
    expect((await previewRetention({ store, now: NOW })).body.mayApply).toBe(false);
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: undefined })).body.code).toBe("PLAN_CHANGED");
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: "0".repeat(24) })).body.code).toBe("PLAN_CHANGED");
    const later = await filed(store, drive, [["also-old", NOW - 45 * DAY]]);
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest })).body.code).toBe("PLAN_CHANGED");
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
    const again = await previewRetention({ store, now: NOW, actor: OWNER });
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: again.body.digest });
    expect(applied.status).toBe(200);
    expect(outcomesOf(applied, lessonId)).toEqual({ old: "TRASHED" });
    expect(outcomesOf(applied, later.lessonId)).toEqual({ "also-old": "TRASHED" });
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(true);
    expect((await drive.getFile(ids.recent.fileId)).trashed).toBe(false);
    const facts = await store.eventsFor([lessonId]);
    expect(facts.filter(event => event.type === DELETED_EVENT)).toEqual([expect.objectContaining({ source: "server", providerFileId: ids.old.providerFileId, driveFileId: ids.old.fileId, recordingKind: "fixed-room", scope: ["fixed-room"], mode: "trash", days: 30, actor: OWNER, outcome: "TRASHED", planDigest: again.body.digest })]);
    expect(facts.filter(event => event.type === DELETE_STARTED_EVENT)).toEqual([expect.objectContaining({ providerFileId: ids.old.providerFileId, actor: OWNER, planDigest: again.body.digest })]);
    const after = await previewRetention({ store, now: NOW, actor: OWNER });
    expect([...dueOf(after, lessonId), ...dueOf(after, later.lessonId)]).toEqual([]);
  });

  test("RT-6: a copy whose Drive record names another recording, or that Drive does not show, is never deleted and needs a person (left out of later plans, listed as such); a Drive that refuses or cannot be read is said and tried again; mode remove deletes for good, and only with permanent: true", async () => {
    setPolicy({ mode: "remove" });
    const store = freshStore(), drive = createDrive();
    const { lessonId, ids } = await filed(store, drive, [["foreign", NOW - 60 * DAY, false], ["refused", NOW - 59 * DAY], ["unread", NOW - 58 * DAY], ["unseen", NOW - 57 * DAY], ["removed", NOW - 56 * DAY]]);
    await drive.remove(ids.unseen.fileId);
    const realRemove = drive.remove.bind(drive);
    drive.remove = async id => { if (id === ids.refused.fileId) throw new Error("synthetic Drive refusal"); return realRemove(id); };
    const realGet = drive.getFile.bind(drive);
    drive.getFile = async id => { if (id === ids.unread.fileId) throw new Error("synthetic Drive read failure"); return realGet(id); };
    const preview = await previewRetention({ store, now: NOW, actor: OWNER });
    expect(preview.body).toMatchObject({ mode: "remove", permanent: true });
    const unconfirmed = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    expect([unconfirmed.status, unconfirmed.body.code]).toEqual([409, "PERMANENT_NOT_CONFIRMED"]);
    expect(await realGet(ids.removed.fileId)).not.toBeNull();
    expect(await retentionFactsOf(store, [lessonId])).toEqual([]);
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest, permanent: true });
    expect(outcomesOf(applied, lessonId)).toEqual({ foreign: "NOT_THIS_RECORDING", refused: "DRIVE_REFUSED", unread: "NOT_CHECKED", unseen: "NOT_VISIBLE", removed: "REMOVED" });
    expect(await realGet(ids.foreign.fileId)).not.toBeNull();
    expect(await realGet(ids.refused.fileId)).not.toBeNull();
    expect(await realGet(ids.removed.fileId)).toBeNull();
    const facts = await store.eventsFor([lessonId]);
    const short = event => event.providerFileId.slice(lessonId.length + 1);
    expect(facts.filter(event => event.type === DELETED_EVENT).map(short)).toEqual(["removed"]);
    expect(facts.filter(event => event.type === DELETE_FAILED_EVENT).map(event => [short(event), event.reason]).sort()).toEqual([["foreign", "NOT_THIS_RECORDING"], ["refused", "DRIVE_REFUSED"], ["unread", "NOT_CHECKED"], ["unseen", "NOT_VISIBLE"]]);
    expect(facts.filter(event => event.type === DELETE_BLOCKED_EVENT).map(short).sort()).toEqual(["foreign", "unseen"]);
    const next = await previewRetention({ store, now: NOW, actor: OWNER });
    expect(dueOf(next, lessonId).sort()).toEqual(["refused", "unread"]);
    expect(next.body.kept.filter(item => item.recordingId.startsWith(lessonId)).map(item => [item.recordingId.slice(lessonId.length + 1), item.reason]).sort()).toEqual([["foreign", "NEEDS_PERSON"], ["unseen", "NEEDS_PERSON"]]);
  });

  test("RT-7: two applies of the same plan at the same moment record each deletion once", async () => {
    setPolicy();
    const store = freshStore(), drive = createDrive();
    const { lessonId } = await filed(store, drive, [["twice", NOW - 90 * DAY]]);
    const preview = await previewRetention({ store, now: NOW, actor: OWNER });
    const [a, b] = readAllBeforeWriting([store, store]);
    const both = await Promise.all([a, b].map(each => runRetention({ store: each, drive, now: NOW, actor: OWNER, confirm: preview.body.digest })));
    for (const answer of both) expect(answer.status).toBe(200);
    expect((await store.eventsFor([lessonId])).filter(event => event.type === DELETED_EVENT)).toHaveLength(1);
  });

  // Review finding 1: the deleted copies stayed in every later batch, so after the first batch nothing
  // was ever due again.
  test("RT-8: more due than one batch holds: the preview says so; each apply takes the next oldest; deleted copies never fill a later batch, so every due copy is reached", async () => {
    setPolicy();
    const store = freshStore(), drive = createDrive();
    const names = ["a", "b", "c", "d", "e"];
    const { lessonId, ids } = await filed(store, drive, names.map((name, index) => [name, NOW - (90 - index) * DAY]));
    const seen = [];
    for (const expected of [["a", "b"], ["c", "d"], ["e"]]) {
      const preview = await previewRetention({ store, now: NOW, actor: OWNER, limit: 2 });
      expect(dueOf(preview, lessonId)).toEqual(expected);
      expect(preview.body.truncated).toBe(expected.length === 2);
      const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest, limit: 2 });
      expect(Object.values(outcomesOf(applied, lessonId))).toEqual(expected.map(() => "TRASHED"));
      seen.push(...expected);
    }
    expect(seen).toEqual(names);
    for (const name of names) expect((await drive.getFile(ids[name].fileId)).trashed).toBe(true);
    const done = await previewRetention({ store, now: NOW, actor: OWNER, limit: 2 });
    expect(done.body).toMatchObject({ due: [], truncated: false });
  });

  // Review finding 5: a failed write after Drive deleted the copy must not stop the run or lose who did it.
  test("RT-9: the deletion's record cannot be written after Drive deleted the copy: said for that copy, the others go on; who started it is recorded before Drive is asked; the next apply records the copy in the trash", async () => {
    setPolicy();
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
    const preview = await previewRetention({ store, now: NOW, actor: OWNER });
    const applied = await runRetention({ store: failing, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    expect(applied.status).toBe(200);
    expect(applied.body.results.filter(entry => entry.recordingId.startsWith(lessonId))).toEqual([
      { recordingId: ids.first.providerFileId, outcome: "TRASHED", note: "NOT_RECORDED" },
      { recordingId: ids.second.providerFileId, outcome: "TRASHED" },
    ]);
    expect(retentionActivityStatus(applied.body.results)).toBe("partly_deleted");
    const started = (await store.eventsFor([lessonId])).filter(event => event.type === DELETE_STARTED_EVENT && event.providerFileId === ids.first.providerFileId);
    expect(started).toEqual([expect.objectContaining({ actor: OWNER, planDigest: preview.body.digest })]);
    // Until its deletion is recorded the copy is not called archived: under way, not confirmed.
    const [row] = (await store.filings([lessonId])).filter(entry => entry.record.providerFileId === ids.first.providerFileId);
    expect(filingStateOf(row.record, row.retention)).toMatchObject({ status: "STORED", retention: { state: "DELETING" } });
    const next = await previewRetention({ store, now: NOW, actor: OWNER });
    expect(dueOf(next, lessonId)).toEqual(["first"]);
    const second = await runRetention({ store, drive, now: NOW, actor: OTHER, confirm: next.body.digest });
    expect(outcomesOf(second, lessonId)).toEqual({ first: "ALREADY_IN_TRASH" });
    expect((await store.eventsFor([lessonId])).filter(event => event.type === DELETED_EVENT).map(event => [event.providerFileId, event.outcome]).sort()).toEqual([[ids.first.providerFileId, "ALREADY_IN_TRASH"], [ids.second.providerFileId, "TRASHED"]]);
  });

  test("RT-10: round 12: a period covers only the kinds it names: with the fixed rooms named, a one-to-one lesson's copy and a block room's copy, however old, are never due and never touched; each kind only when named; the plan says each copy's kind; a plan seen under another scope is never applied", async () => {
    const store = freshStore(), drive = createDrive();
    const one = await filed(store, drive, [["one", NOW - 400 * DAY]], "one-to-one");
    const block = await filed(store, drive, [["block", NOW - 400 * DAY]], "block");
    const fixed = await filed(store, drive, [["fixed", NOW - 400 * DAY]], "fixed-room");
    const mine = preview => preview.body.due.filter(item => [one, block, fixed].some(entry => item.recordingId.startsWith(`${entry.lessonId}-`))).map(item => [item.recordingId.split("-").at(-1), item.kind]).sort();
    setPolicy({ scope: "fixed-room" });
    const fixedOnly = await previewRetention({ store, now: NOW, actor: OWNER });
    expect(mine(fixedOnly)).toEqual([["fixed", "fixed-room"]]);
    expect(fixedOnly.body).toMatchObject({ scope: ["fixed-room"], byKind: { "fixed-room": 1 }, mayApply: true });
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "block,fixed-room");
    expect(mine(await previewRetention({ store, now: NOW, actor: OWNER }))).toEqual([["block", "block"], ["fixed", "fixed-room"]]);
    // The plan seen with the fixed rooms only is not the plan under this scope: refused, nothing deleted.
    expect((await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: fixedOnly.body.digest })).body.code).toBe("PLAN_CHANGED");
    expect(await retentionFactsOf(store, [one.lessonId, block.lessonId, fixed.lessonId])).toEqual([]);
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "fixed-room");
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: fixedOnly.body.digest });
    expect(applied.status).toBe(200);
    expect((await drive.getFile(fixed.ids.fixed.fileId)).trashed).toBe(true);
    for (const entry of [one.ids.one, block.ids.block]) expect((await drive.getFile(entry.fileId)).trashed).toBe(false);
    expect(await retentionFactsOf(store, [one.lessonId, block.lessonId])).toEqual([]);
    // The original one-to-one lessons only when named, and then by themselves.
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_SCOPE", "one-to-one");
    expect(mine(await previewRetention({ store, now: NOW, actor: OWNER }))).toEqual([["one", "one-to-one"]]);
  });

  test("RT-11: round 12: an owner may preview, but only a person the site names may apply; nobody when none is named; addresses compare without case; a plan that deletes for good needs permanent: true in the apply", async () => {
    const store = freshStore(), drive = createDrive();
    const { lessonId, ids } = await filed(store, drive, [["old", NOW - 60 * DAY]]);
    setPolicy({ deleters: null });
    const preview = await previewRetention({ store, now: NOW, actor: OWNER });
    expect(preview.body).toMatchObject({ ok: true, mayApply: false });
    const nobody = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    expect([nobody.status, nobody.body.code]).toEqual([403, "NOT_A_DELETER"]);
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_DELETERS", OTHER);
    const notThisOwner = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    expect([notThisOwner.status, notThisOwner.body.code]).toEqual([403, "NOT_A_DELETER"]);
    expect((await previewRetention({ store, now: NOW, actor: OTHER.toUpperCase() })).body.mayApply).toBe(true);
    expect((await drive.getFile(ids.old.fileId)).trashed).toBe(false);
    expect(await retentionFactsOf(store, [lessonId])).toEqual([]);
    vi.stubEnv("CLASSROOM_RECORDING_RETENTION_MODE", "remove");
    const removing = await previewRetention({ store, now: NOW, actor: OTHER });
    expect(removing.body).toMatchObject({ mode: "remove", permanent: true, mayApply: true });
    const unconfirmed = await runRetention({ store, drive, now: NOW, actor: OTHER, confirm: removing.body.digest });
    expect([unconfirmed.status, unconfirmed.body.code]).toEqual([409, "PERMANENT_NOT_CONFIRMED"]);
    expect(await drive.getFile(ids.old.fileId)).not.toBeNull();
    const confirmed = await runRetention({ store, drive, now: NOW, actor: OTHER.toUpperCase(), confirm: removing.body.digest, permanent: true });
    expect(confirmed.body.results).toEqual([{ recordingId: ids.old.providerFileId, outcome: "REMOVED" }]);
    expect(await drive.getFile(ids.old.fileId)).toBeNull();
  });

  test("RT-12: round 12: after an apply every list says what became of each copy: DELETED (never ARCHIVED) for one deleted, needs a person when Drive could not confirm it, the failure said for one Drive refused; the row keeps its filing status and the deletion's own record says the copy is gone; the activity record says some were deleted", async () => {
    setPolicy();
    const store = freshStore(), drive = createDrive();
    const { lessonId, ids } = await filed(store, drive, [["gone", NOW - 70 * DAY], ["foreign", NOW - 69 * DAY, false], ["refused", NOW - 68 * DAY]]);
    const realTrash = drive.trash.bind(drive);
    drive.trash = async id => { if (id === ids.refused.fileId) throw new Error("synthetic Drive refusal"); return realTrash(id); };
    const preview = await previewRetention({ store, now: NOW, actor: OWNER });
    const applied = await runRetention({ store, drive, now: NOW, actor: OWNER, confirm: preview.body.digest });
    expect(outcomesOf(applied, lessonId)).toEqual({ gone: "TRASHED", foreign: "NOT_THIS_RECORDING", refused: "DRIVE_REFUSED" });
    expect(retentionActivityStatus(applied.body.results)).toBe("partly_deleted");
    const rows = Object.fromEntries((await store.filings([lessonId])).map(row => [row.record.providerFileId.slice(lessonId.length + 1), row]));
    expect(rows.gone.record.status).toBe("STORED");
    const shown = Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, filingStateOf(row.record, row.retention)]));
    expect(shown.gone).toMatchObject({ status: "DELETED", retention: { state: "DELETED", outcome: "TRASHED" } });
    expect(shown.foreign).toMatchObject({ status: "STORED", retention: { state: "NEEDS_PERSON", reason: "NOT_THIS_RECORDING" } });
    expect(shown.refused).toMatchObject({ status: "STORED", retention: { state: "DELETE_FAILED", reason: "DRIVE_REFUSED" } });
    expect(filingLabel(shown.gone)).toBe("DELETED 已依保存期限刪除（在 Google Drive 垃圾桶，一段時間內還能救回）");
    expect(filingLabel({ ...shown.foreign, status: "ARCHIVED" })).toBe("需要人工確認：保存期限刪除時Drive 上的檔案不是這個錄影，檔案現況不明");
    expect(filingLabel({ ...shown.refused, status: "ARCHIVED" })).toBe("ARCHIVED 歸檔完成（上次保存期限刪除沒有完成：Drive 拒絕刪除）");
    for (const entry of [shown.gone, shown.foreign]) expect(filingLabel(entry)).not.toMatch(/ARCHIVED/);
    expect((await drive.getFile(ids.gone.fileId)).trashed).toBe(true);
    expect((await drive.getFile(ids.refused.fileId)).trashed).toBe(false);
  });
});
