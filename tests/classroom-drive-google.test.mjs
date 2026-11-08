import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { classroomDrive, ClassroomDriveUnavailableError, GOOGLE_TEST_ROOT_NAME, googleClassroomDrive } from "../lib/classroom-drive";
import { FAILURE, FilingError, fileRecording, processJobs } from "../tools/recording-pathway/classroom/recording-filing.mjs";
import { storeEvent } from "../tools/recording-pathway/classroom/webhook-ingest.mjs";
import { authorize, DRIVE_FILE_SCOPE } from "../tools/recording-pathway/drive-test/oauth.mjs";
import { startMockDrive } from "../tools/recording-pathway/drive-test/mock-drive-server.mjs";
import { createClassroomStore, syntheticContent } from "../tools/recording-pathway/test/fake-classroom-store.mjs";

// The website's Google Drive destination for the local recording test (lib/classroom-drive.ts),
// against the local stand-in of Google's sign-in and Drive (mock-drive-server.mjs, 127.0.0.1).
// No Google account, credential or network is used; the grant is the stand-in's, made with the
// same Desktop-client sign-in the A1 test used. Synthetic data only.

const START = Date.parse("2026-11-03T02:00:00Z");
const MIN = 60_000;
const lesson = {
  id: "L-TEST-G1", code: "TEST-G1", date: "2026-11-03", startsAt: new Date(START).toISOString(), endsAt: new Date(START + 60 * MIN).toISOString(),
  participants: [{ id: "P-TEST-T01", code: "TEST-T01", role: "tutor" }, { id: "P-TEST-S01", code: "TEST-S01", role: "student" }],
};
const SIZE = 300_000; // more than one 256 KiB chunk
let mock;
let dir;
let env;

beforeAll(async () => {
  mock = await startMockDrive({ pageSize: 2 });
  dir = await mkdtemp(path.join(os.tmpdir(), "ihear-google-drive-test-"));
  const clientFile = path.join(dir, "client.json");
  const tokenFile = path.join(dir, "token.json");
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: "mock-client.apps.googleusercontent.com", client_secret: "mock-not-secret" } }));
  await authorize({ clientFile, tokenFile, endpoints: mock.endpoints, openUrl: async url => { await fetch(url); } });
  env = { CLASSROOM_GOOGLE_CLIENT_FILE: clientFile, CLASSROOM_GOOGLE_TOKEN_FILE: tokenFile, CLASSROOM_GOOGLE_API_BASE: mock.url, CLASSROOM_GOOGLE_TOKEN_ENDPOINT: mock.endpoints.token };
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await mock?.close();
  await rm(dir, { recursive: true, force: true });
});

async function storedRecording(id) {
  const store = createClassroomStore({ lessons: [lesson] });
  await store.transaction(tx => storeEvent(tx, { source: "server", type: "server.recording_eligibility", lessonId: lesson.id, occurredAt: START - 15 * MIN, receivedAt: START - 15 * MIN, key: "decide", eligible: true }));
  const fact = {
    source: "zoom_api", type: "session.recording_completed", provider: "synthetic", lessonId: lesson.id, providerSessionId: "s-1", occurredAt: START + 59 * MIN, receivedAt: START + 70 * MIN,
    files: [{ providerFileId: id, kind: "composite", extension: "mp4", size: SIZE, status: "completed", recordingStart: START + MIN, recordingEnd: START + 59 * MIN }],
  };
  await store.transaction(tx => storeEvent(tx, { ...fact, key: `session.recording_completed:s-1:${id}` }));
  return store;
}
// The filing jobs' results (the vendor-copy job a STORED filing leaves is not this test's subject).
const fileWith = async (store, drive) => (await processJobs({
  store, now: START + 71 * MIN, workerId: "w", handlers: {
    file_recording: input => fileRecording({ store, drive, download: async (record, { start, end }) => syntheticContent(record.providerFileId, start, end), rootFolderId: drive.rootFolderId, options: { chunkBytes: 256 * 1024 }, ...input }),
    delete_vendor_copy: async ({ job, leaseVersion }) => ({ status: (await store.completeJob({ jobId: job.id, leaseVersion })) ? "DONE" : "LEASE_LOST" }),
  },
})).filter(result => String(result.jobId).startsWith("file:"));
const filesIn = () => [...mock.files.values()].filter(file => !file.trashed);

describe("Google Drive for the local recording test", () => {
  test("a recording is filed into the test folder the app creates, in its month and lesson folders, with P1's name, byte for byte", async () => {
    const drive = googleClassroomDrive(env);
    const store = await storedRecording("SYN-G-1");
    expect((await fileWith(store, drive)).map(result => result.status)).toEqual(["STORED"]);
    const roots = filesIn().filter(file => file.name === GOOGLE_TEST_ROOT_NAME);
    expect(roots).toMatchObject([{ parentId: "root", mimeType: "application/vnd.google-apps.folder" }]);
    const month = filesIn().find(file => file.name === "[iHear] 11.2026.Zoom Recordings");
    expect(month.parentId).toBe(roots[0].id);
    // The lesson's own folder, its date and code, inside the month's.
    const lessonFolder = filesIn().find(file => file.name === "2026-11-03_TEST-G1");
    expect(lessonFolder).toMatchObject({ parentId: month.id, mimeType: "application/vnd.google-apps.folder" });
    const video = filesIn().find(file => file.appProperties.providerFileId === "SYN-G-1");
    expect(video).toMatchObject({ name: "2026-11-03_TEST-S01_TEST-T01_P01.mp4", parentId: lessonFolder.id, size: SIZE, appProperties: { providerFileId: "SYN-G-1", lessonId: lesson.id } });
    expect(video.md5).toBe(createHash("md5").update(syntheticContent("SYN-G-1", 0, SIZE)).digest("hex"));
    expect(store.fileRecord("SYN-G-1")).toMatchObject({ status: "STORED", driveFileId: video.id });
    // The STORED record says where the copy went, with Drive's own checksum, for the overview.
    expect(store.events().find(event => event.type === "p1.filing" && event.status === "STORED")).toMatchObject({
      name: "2026-11-03_TEST-S01_TEST-T01_P01.mp4", folder: "[iHear] 11.2026.Zoom Recordings / 2026-11-03_TEST-G1", size: SIZE, md5: video.md5, driveFileId: video.id, destination: "google",
    });
    // A second recording, from a new process: the same test folder, found again rather than made twice.
    expect((await fileWith(await storedRecording("SYN-G-2"), googleClassroomDrive(env))).map(result => result.status)).toEqual(["STORED"]);
    expect(filesIn().filter(file => file.name === GOOGLE_TEST_ROOT_NAME)).toHaveLength(1);
  });

  test("P3-Multi: with a parent folder named by configuration (never in the code), recordings go under that folder; a malformed id is refused", async () => {
    // A folder standing in for the one iHear chose (synthetic; the real id stays in configuration).
    const helper = googleClassroomDrive(env);
    const parent = await helper.ensureFolder(helper.rootFolderId, "iHear chosen folder (synthetic)");
    const drive = googleClassroomDrive({ ...env, CLASSROOM_DRIVE_PARENT_FOLDER_ID: parent });
    expect((await fileWith(await storedRecording("SYN-G-P"), drive)).map(result => result.status)).toEqual(["STORED"]);
    const video = filesIn().find(file => file.appProperties.providerFileId === "SYN-G-P");
    const lessonFolder = filesIn().find(file => file.id === video.parentId);
    const month = filesIn().find(file => file.id === lessonFolder.parentId);
    expect(month).toMatchObject({ name: "[iHear] 11.2026.Zoom Recordings", parentId: parent });
    expect(() => googleClassroomDrive({ ...env, CLASSROOM_DRIVE_PARENT_FOLDER_ID: "not an id!" })).toThrow(/not a Drive folder id/);
  });

  test("only a grant of exactly drive.file is used: a broader one pauses filing (DRIVE_AUTH), it does not fail it", async () => {
    // A token file that says it holds more than drive.file.
    const wide = path.join(dir, "token-wide.json");
    const saved = JSON.parse(await (await import("node:fs/promises")).readFile(env.CLASSROOM_GOOGLE_TOKEN_FILE, "utf8"));
    await writeFile(wide, JSON.stringify({ ...saved, scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive` }));
    const widened = googleClassroomDrive({ ...env, CLASSROOM_GOOGLE_TOKEN_FILE: wide });
    const refused = await widened.quota().catch(error => error);
    expect([refused instanceof FilingError, refused.code]).toEqual([true, FAILURE.DRIVE_AUTH]);
    const results = await fileWith(await storedRecording("SYN-G-3"), widened);
    expect(results.map(result => [result.status, result.reason])).toEqual([["BLOCKED", FAILURE.DRIVE_AUTH]]);
    // Google answering a refresh with more scopes than were asked for: refused the same way.
    const answersWide = async (url, init) => {
      const response = await fetch(url, init);
      if (!String(url).endsWith("/token")) return response;
      const body = await response.json();
      return new Response(JSON.stringify({ ...body, scope: `${body.scope} https://www.googleapis.com/auth/drive.readonly` }), { status: response.status, headers: { "content-type": "application/json" } });
    };
    const answered = await googleClassroomDrive(env, { fetchImpl: answersWide }).quota().catch(error => error);
    expect([answered instanceof FilingError, answered.code]).toEqual([true, FAILURE.DRIVE_AUTH]);
  });

  test("it is refused on a hosted site, with grant files inside the site or in OneDrive, with another address than Google's or the local stand-in's, or a folder not marked as a test", () => {
    const refused = (changes, message) => expect(() => googleClassroomDrive({ ...env, ...changes })).toThrow(message);
    refused({ VERCEL: "1" }, ClassroomDriveUnavailableError);
    refused({ VERCEL_ENV: "preview" }, /local recording test/);
    refused({ CLASSROOM_GOOGLE_CLIENT_FILE: undefined }, /CLASSROOM_GOOGLE_CLIENT_FILE/);
    refused({ CLASSROOM_GOOGLE_TOKEN_FILE: "token.json" }, /full path/);
    refused({ CLASSROOM_GOOGLE_TOKEN_FILE: path.join(process.cwd(), "data", "token.json") }, /outside the site's folder/);
    refused({ CLASSROOM_GOOGLE_TOKEN_FILE: path.join(os.homedir(), "OneDrive", "token.json") }, /OneDrive/);
    refused({ CLASSROOM_GOOGLE_API_BASE: "https://drive.example.invalid" }, /Only Google itself or the local stand-in/);
    refused({ CLASSROOM_GOOGLE_TOKEN_ENDPOINT: "http://127.0.0.2:9000/token" }, /Only Google itself or the local stand-in/);
    refused({ CLASSROOM_DRIVE_ROOT_NAME: "iHear 錄影" }, /\[測試\]/);
  });

  test("the website picks it with CLASSROOM_DRIVE=google, and names nothing when no destination is set", () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NETLIFY", "");
    vi.stubEnv("CLASSROOM_DRIVE", "google");
    expect(classroomDrive().rootFolderId).toBe("google-test-root");
    vi.stubEnv("CLASSROOM_DRIVE", "");
    expect(() => classroomDrive()).toThrow(/No recording destination/);
  });
});
