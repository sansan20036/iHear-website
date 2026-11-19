import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CLASSROOM_CAPABILITIES, classroomDeviceOf, deviceLimits } from "../lib/classroom-capabilities";
import { handCommand } from "../lib/classroom-chat";
import { hostReportFor, LcicEmbedAdapter, LCIC_FRAME_PERMISSIONS, MediaAdapterUnavailableError, ZoomVideoSdkMediaAdapter } from "../lib/classroom-media";
import { ClassroomProviderUnavailableError, classroomProvider } from "../lib/classroom-provider";
import { isTestLesson, LcicApiError, lcicStatusOf, memoryRoomRegistry, tc3Sign, tencentLcicConfig, tencentLcicProvider, verifyLcicCallback } from "../lib/classroom-vendors/tencent-lcic";
import { zoomApiToken, zoomSessionPath, zoomVideoSdkConfig, zoomVideoSdkProvider } from "../lib/classroom-vendors/zoom-video-sdk";
import { roomNameOf } from "../tools/recording-pathway/classroom/eligibility.mjs";
import { FAILURE, FilingError } from "../tools/recording-pathway/classroom/recording-filing.mjs";

// The two vendor adapters (Zoom Video SDK, Tencent LCIC) against stand-ins: every HTTP request
// is recorded by a fake transport and every SDK call by a fake SDK. Passing shows iHear sends what
// the vendors' documentation asks for and handles their answers; it does NOT show the vendors
// accept it. No real key, account or network is used.

const NOW = Date.parse("2026-11-03T01:50:00Z");
const lesson = {
  id: "L-TEST-V01", code: "TEST-V01", date: "2026-11-03", startsAt: "2026-11-03T02:00:00Z", endsAt: "2026-11-03T03:00:00Z", cancelled: false,
  createdBy: "owner@example.test", createdAt: "2026-10-30T00:00:00Z",
  participants: [{ id: "P-TEST-T01", code: "TEST-T01", role: "tutor" }, { id: "P-TEST-S01", code: "TEST-S01", role: "student" }],
};
const [tutor, student] = lesson.participants;
const decode = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
const verifies = (token, secret) => {
  const [head, body, signature] = token.split(".");
  return createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url") === signature;
};
function fakeTransport(answer) {
  const requests = [];
  const transport = async request => { requests.push(request); return answer(request, requests.length); };
  return { requests, transport };
}
afterEach(() => { vi.unstubAllEnvs(); });

describe("Zoom Video SDK, server side", () => {
  const env = { ZOOM_VIDEO_SDK_KEY: "synthetic-sdk-key", ZOOM_VIDEO_SDK_SECRET: "synthetic-sdk-secret-not-real", ZOOM_VIDEO_SDK_API_KEY: "synthetic-api-key", ZOOM_VIDEO_SDK_API_SECRET: "synthetic-api-secret-not-real", ZOOM_VIDEO_SDK_WEBHOOK_SECRET: "synthetic-webhook-not-real" };
  const config = zoomVideoSdkConfig(env);
  // `sessions`: the lesson's trusted sessions, oldest first; a string is one live session.
  const provider = (answer = () => ({ status: 202, body: "" }), sessions = "sess-TEST-1") => {
    const fake = fakeTransport(answer);
    const known = sessions == null ? [] : typeof sessions === "string" ? [{ id: sessions, ended: false, recordingsKnown: false }] : sessions;
    return { ...fake, provider: zoomVideoSdkProvider(config, { transport: fake.transport, sessionsOf: async () => known, now: () => NOW }) };
  };
  const listing = files => ({ status: 200, body: JSON.stringify({ recording_files: files }) });
  const videoFile = (id, extra = {}) => ({ id, download_url: `https://zoom.example.invalid/rec/${id}`, ...extra });

  test("configuration needs all five values", () => {
    expect(config).toMatchObject({ sdkKey: "synthetic-sdk-key", apiBase: "https://api.zoom.us/v2" });
    for (const name of Object.keys(env)) expect(zoomVideoSdkConfig({ ...env, [name]: " " })).toBeNull();
  });

  test("the join token is the Video SDK JWT for this lesson and person, signed with the SDK secret", async () => {
    const { provider: zoom } = provider();
    const prepared = await zoom.prepareJoin({ lesson, participant: tutor, now: NOW });
    expect(prepared.kind).toBe("sdk");
    expect(verifies(prepared.token, env.ZOOM_VIDEO_SDK_SECRET)).toBe(true);
    const claims = decode(prepared.token);
    expect(claims).toMatchObject({ app_key: "synthetic-sdk-key", role_type: 1, session_key: lesson.id, user_key: tutor.id, version: 1, cloud_recording_option: 0 });
    expect(prepared.sessionName).toBe(claims.tpc);
    expect(decode((await zoom.prepareJoin({ lesson, participant: student, now: NOW })).token).role_type).toBe(0);
  });

  test("the REST token is an hour-long JWT from the API key, signed with the API secret", () => {
    const token = zoomApiToken(config, NOW);
    expect(verifies(token, env.ZOOM_VIDEO_SDK_API_SECRET)).toBe(true);
    const claims = decode(token);
    expect(claims.iss).toBe("synthetic-api-key");
    expect(claims.exp - claims.iat).toBe(3600);
  });

  test("recording starts and stops only by the server's PATCH to the session's events", async () => {
    const { provider: zoom, requests } = provider();
    expect(await zoom.startRecording(lesson)).toEqual({ ok: true, httpStatus: 202 });
    expect(await zoom.stopRecording(lesson)).toEqual({ ok: true, httpStatus: 202 });
    expect(requests.map(request => [request.method, request.url, JSON.parse(request.body).method])).toEqual([
      ["PATCH", "https://api.zoom.us/v2/videosdk/sessions/sess-TEST-1/events", "recording.start"],
      ["PATCH", "https://api.zoom.us/v2/videosdk/sessions/sess-TEST-1/events", "recording.stop"],
    ]);
    expect(requests[0].headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(verifies(requests[0].headers.Authorization.slice(7), env.ZOOM_VIDEO_SDK_API_SECRET)).toBe(true);
  });

  test("ending a session is PUT status end; a refusal is reported, never assumed done", async () => {
    const { provider: zoom, requests } = provider(() => ({ status: 400, body: "{}" }));
    expect(await zoom.endSession(lesson)).toEqual({ ok: false, httpStatus: 400 });
    expect([requests[0].method, requests[0].url, JSON.parse(requests[0].body)]).toEqual(["PUT", "https://api.zoom.us/v2/videosdk/sessions/sess-TEST-1/status", { action: "end" }]);
  });

  test("before Zoom reports the session there is nothing to control; undocumented calls answer 501 without a request", async () => {
    const none = provider(undefined, null);
    expect(await none.provider.startRecording(lesson)).toEqual({ ok: false, httpStatus: 409 });
    expect(await none.provider.stopRecording(lesson)).toEqual({ ok: false, httpStatus: 409 });
    expect(await none.provider.endSession(lesson)).toEqual({ ok: false, httpStatus: 409 });
    expect(await none.provider.removeUser(lesson, student.id)).toEqual({ ok: false, httpStatus: 501 });
    expect(await none.provider.deleteRecording({ providerFileId: "f-1" })).toEqual({ ok: false, httpStatus: 501 });
    // Nothing to look up either (the round-1 trial, with no webhook and no confirmed session).
    expect(await none.provider.snapshot(lesson)).toBeNull();
    expect(none.requests).toEqual([]);
  });

  test("a recording range is downloaded from the address listed for the file, with a Range header, and the answer is checked", async () => {
    const { provider: zoom, requests } = provider((request) => request.url.endsWith("/recordings")
      ? listing([videoFile("f-video")])
      : { status: 206, body: "", bytes: Buffer.alloc(16, 7), headers: { "content-range": "bytes 16-31/64" } });
    const record = { providerFileId: "f-video", providerSessionId: "sess-TEST-1", lessonId: lesson.id, status: "PENDING", size: 64 };
    const bytes = await zoom.download(record, { start: 16, end: 32 });
    expect(bytes.length).toBe(16);
    expect(requests.map(request => request.url)).toEqual(["https://api.zoom.us/v2/videosdk/sessions/sess-TEST-1/recordings", "https://zoom.example.invalid/rec/f-video"]);
    expect(requests[1]).toMatchObject({ method: "GET", headers: { Range: "bytes=16-31" } });
    const insecure = provider((request) => request.url.endsWith("/recordings") ? listing([{ id: "f-video", download_url: "http://plain.example.invalid/f" }]) : { status: 206, body: "" });
    await expect(insecure.provider.download(record, { start: 0, end: 16 })).rejects.toThrow(/not available/);
  });

  // --- P-4: session ids in paths --------------------------------------------------------------

  test("session ids go into paths as Zoom's reference asks: twice when the rule for that call says so", async () => {
    // Zoom's own sample id has one "/": the recordings calls want it encoded twice, the others once.
    const sample = "oiFKKKL/RyGdm9W1r1Ll6w==";
    expect(zoomSessionPath(sample, "recordings")).toBe("oiFKKKL%252FRyGdm9W1r1Ll6w%253D%253D");
    expect(zoomSessionPath(sample, "session")).toBe("oiFKKKL%2FRyGdm9W1r1Ll6w%3D%3D");
    // Beginning with "/" or holding "//": twice for every call.
    for (const id of ["/Q4zHkBcRYGrW8q2xZ6wgQ==", "ab//cdEF12=="]) {
      expect(zoomSessionPath(id, "session")).toBe(encodeURIComponent(encodeURIComponent(id)));
      expect(zoomSessionPath(id, "recordings")).toBe(encodeURIComponent(encodeURIComponent(id)));
    }
    // No "/": once.
    for (const id of ["abcDEF123==", "+lead0123=="]) for (const rule of ["session", "recordings"]) expect(zoomSessionPath(id, rule)).toBe(encodeURIComponent(id));
    const answer = request => (request.url.includes("/recordings") ? listing([]) : request.method === "PATCH" ? { status: 202, body: "" } : { status: 404, body: "{}" });
    const { provider: zoom, requests } = provider(answer, sample);
    await zoom.startRecording(lesson);
    await zoom.snapshot(lesson);
    expect(requests.map(request => request.url)).toEqual([
      "https://api.zoom.us/v2/videosdk/sessions/oiFKKKL%2FRyGdm9W1r1Ll6w%3D%3D/events",
      "https://api.zoom.us/v2/videosdk/sessions/oiFKKKL%2FRyGdm9W1r1Ll6w%3D%3D?type=live",
      "https://api.zoom.us/v2/videosdk/sessions/oiFKKKL%2FRyGdm9W1r1Ll6w%3D%3D?type=past",
      "https://api.zoom.us/v2/videosdk/sessions/oiFKKKL%252FRyGdm9W1r1Ll6w%253D%253D/recordings",
    ]);
  });

  // --- P-1: a reported session is used only once Zoom confirms it ---------------------------------

  test("a session id the tutor's page reported is confirmed only when Zoom says the session is this lesson's", async () => {
    const answers = (live, past) => request => (request.url.endsWith("?type=live") ? live : past);
    const ours = { status: 200, body: JSON.stringify({ id: "s-1", session_key: lesson.id, session_name: roomNameOf(lesson.id) }) };
    const live = provider(answers(ours, { status: 500, body: "" }), []);
    // Confirmed with the room name Zoom gave, which tells the room's generation (G-5).
    expect(await live.provider.verifySession(lesson, "s-1")).toEqual({ verified: true, ended: false, name: roomNameOf(lesson.id) });
    expect(live.requests.map(request => request.url)).toEqual(["https://api.zoom.us/v2/videosdk/sessions/s-1?type=live"]);
    // Ended already: Zoom describes it only as a past session.
    const past = provider(answers({ status: 404, body: "{}" }, { status: 200, body: JSON.stringify({ id: "s-1", session_name: roomNameOf(lesson.id) }) }), []);
    expect(await past.provider.verifySession(lesson, "s-1")).toEqual({ verified: true, ended: true, name: roomNameOf(lesson.id) });
    expect(past.requests.map(request => request.url.split("?")[1])).toEqual(["type=live", "type=past"]);
    // Another lesson's session, or one that says nothing about whose it is: refused.
    const other = provider(answers({ status: 200, body: JSON.stringify({ id: "s-9", session_key: "L-OTHER", session_name: roomNameOf(lesson.id) }) }, null), []);
    expect(await other.provider.verifySession(lesson, "s-9")).toEqual({ verified: false, reason: "MISMATCH" });
    const silent = provider(answers({ status: 200, body: JSON.stringify({ id: "s-8" }) }, null), []);
    expect(await silent.provider.verifySession(lesson, "s-8")).toEqual({ verified: false, reason: "MISMATCH" });
    // Unknown to Zoom under either type: refused. No answer, or no access: asked again later.
    expect(await provider(() => ({ status: 404, body: "{}" }), []).provider.verifySession(lesson, "s-7")).toEqual({ verified: false, reason: "NOT_FOUND" });
    const locked = provider(() => ({ status: 401, body: "{}" }), []);
    expect(await locked.provider.verifySession(lesson, "s-6")).toBeNull();
    expect(locked.requests).toHaveLength(1);
    expect(await provider(() => { throw new Error("offline"); }, []).provider.verifySession(lesson, "s-5")).toBeNull();
  });

  // --- P-2: ended sessions ------------------------------------------------------------------------

  test("an ended session is asked about as past, and its recordings are asked for whatever the details say", async () => {
    const files = [videoFile("f-1", { status: "completed" })];
    const answer = request => {
      if (request.url.includes("/recordings")) return listing(files);
      if (request.url.includes("/users")) return { status: 200, body: JSON.stringify({ users: [{ user_key: tutor.id, join_time: "2026-11-03T02:00:00Z", leave_time: "2026-11-03T03:00:00Z" }] }) };
      return request.url.endsWith("?type=past") ? { status: 200, body: JSON.stringify({ id: "s-1", end_time: "2026-11-03T03:00:00Z" }) } : { status: 404, body: "{}" };
    };
    const ended = provider(answer, [{ id: "s-1", ended: true, recordingsKnown: false }]);
    const snapshot = await ended.provider.snapshot(lesson);
    expect(ended.requests.map(request => request.url.replace("https://api.zoom.us/v2/videosdk/sessions/", ""))).toEqual(["s-1?type=past", "s-1/users?type=past", "s-1/recordings"]);
    expect(snapshot).toMatchObject({ providerSessionId: "s-1", details: { end_time: "2026-11-03T03:00:00Z" }, users: [{ user_key: tutor.id }], recordings: files, sessions: [] });
    // Zoom no longer describes the session, but still lists its recordings: they are kept.
    const forgotten = provider(request => (request.url.includes("/recordings") ? listing(files) : { status: 404, body: "{}" }), [{ id: "s-1", ended: true, recordingsKnown: false }]);
    expect(await forgotten.provider.snapshot(lesson)).toMatchObject({ details: null, users: [], recordings: files });
    // Nothing at all answers: no snapshot.
    expect(await provider(() => ({ status: 500, body: "" }), "s-1").provider.snapshot(lesson)).toBeNull();
  });

  // P3-R1 (2026-11-11): has_recording in a session's details (seen on an ended session Zoom recorded).
  test("P3-R1: has_recording — true confirms a start; an ended session's false says nothing was recorded; a live session's false, or none, is no answer", async () => {
    const details = (type, extra) => request => (request.url.endsWith(`?type=${type}`) ? { status: 200, body: JSON.stringify({ id: "s-1", ...extra }) } : { status: 404, body: "{}" });
    const observe = answer => provider(answer, "s-1").provider.observe(lesson, "s-1");
    expect(await observe(details("live", { has_recording: true }))).toEqual({ live: true, recording: null, started: true });
    expect(await observe(details("live", { has_recording: false }))).toEqual({ live: true, recording: null, started: null });
    expect(await observe(details("live", {}))).toEqual({ live: true, recording: null, started: null });
    expect(await observe(details("past", { end_time: "2026-11-03T03:00:00Z", has_recording: true }))).toEqual({ live: false, recording: false, started: true });
    expect(await observe(details("past", { end_time: "2026-11-03T03:00:00Z", has_recording: false }))).toEqual({ live: false, recording: false, started: false });
    expect(await observe(() => ({ status: 500, body: "" }))).toEqual({ live: null, recording: null, started: null });
    // The snapshot passes the details on as they are, has_recording included, for lesson-state to read.
    const live = provider(request => (request.url.includes("/recordings") ? { status: 404, body: "{}" } : request.url.includes("/users") ? { status: 200, body: JSON.stringify({ users: [] }) } : details("live", { has_recording: true })(request)), "s-1");
    expect((await live.provider.snapshot(lesson)).details).toMatchObject({ has_recording: true });
  });

  // --- P-3: a lesson in several sessions ----------------------------------------------------------

  test("a lesson in several sessions: earlier sessions' recordings are asked for until known, each file from its own session", async () => {
    const sessions = [
      { id: "s-1", ended: true, recordingsKnown: false },
      { id: "s-2", ended: true, recordingsKnown: true },
      { id: "s-3", ended: false, recordingsKnown: false },
    ];
    const byId = { "s-1": [videoFile("f-1", { status: "completed" })], "s-2": [videoFile("f-2")], "s-3": [] };
    const answer = request => {
      const id = /sessions\/([^/?]+)/.exec(request.url)?.[1];
      if (request.url.includes("/recordings")) return listing(byId[id]);
      if (request.url.startsWith("https://zoom.example.invalid/")) return { status: 206, body: "", bytes: Buffer.alloc(8, 1), headers: { "content-range": "bytes 0-7/8" } };
      return { status: 200, body: JSON.stringify({ id, session_key: lesson.id }) };
    };
    const { provider: zoom, requests } = provider(answer, sessions);
    const snapshot = await zoom.snapshot(lesson);
    expect(snapshot.providerSessionId).toBe("s-3");
    expect(snapshot.sessions).toEqual([{ providerSessionId: "s-1", recordings: byId["s-1"] }]);
    expect(requests.some(request => request.url.includes("/s-2/recordings"))).toBe(false);
    // A file is fetched from its own session, never from the lesson's latest one.
    requests.length = 0;
    expect((await zoom.download({ providerFileId: "f-1", providerSessionId: "s-1", lessonId: lesson.id, size: 8 }, { start: 0, end: 8 })).length).toBe(8);
    expect(requests.map(request => request.url)).toEqual(["https://api.zoom.us/v2/videosdk/sessions/s-1/recordings", "https://zoom.example.invalid/rec/f-1"]);
    // A record that does not name its session: every known session, the newest first.
    requests.length = 0;
    await zoom.download({ providerFileId: "f-2", lessonId: lesson.id, size: 8 }, { start: 0, end: 8 });
    expect(requests.map(request => request.url.replace("https://api.zoom.us/v2/videosdk/sessions/", ""))).toEqual(["s-3/recordings", "s-2/recordings", "https://zoom.example.invalid/rec/f-2"]);
    // A file no session lists any more is gone: the filing fails for good.
    const gone = await zoom.download({ providerFileId: "f-404", providerSessionId: "s-1", lessonId: lesson.id, size: 8 }, { start: 0, end: 8 }).catch(error => error);
    expect([gone instanceof FilingError, gone.code]).toEqual([true, FAILURE.VENDOR_FILE_GONE]);
  });

  // --- P-5 and P-7: download answers ----------------------------------------------------------------

  test("download answers are told apart, and a file that is not the size Zoom's notice gave is never stored", async () => {
    const record = { providerFileId: "f-1", providerSessionId: "s-1", lessonId: lesson.id, size: 64 };
    const failureOf = async (listed, downloaded) => {
      const { provider: zoom } = provider(request => (request.url.includes("/recordings") ? listed : downloaded), "s-1");
      return zoom.download(record, { start: 0, end: 16 }).then(() => null, error => [error instanceof FilingError, error.code, error.retryAfterMs]);
    };
    const ok = listing([videoFile("f-1")]);
    expect(await failureOf({ status: 401, body: "" }, null)).toEqual([true, FAILURE.VENDOR_AUTH, 0]);
    expect(await failureOf({ status: 429, body: "", headers: { "retry-after": "30" } }, null)).toEqual([true, FAILURE.RATE_LIMITED, 30_000]);
    expect(await failureOf({ status: 503, body: "" }, null)).toEqual([true, FAILURE.TRANSIENT, 0]);
    expect(await failureOf(ok, { status: 404, body: "" })).toEqual([true, FAILURE.VENDOR_FILE_GONE, 0]);
    expect(await failureOf(ok, { status: 403, body: "" })).toEqual([true, FAILURE.VENDOR_AUTH, 0]);
    // Zoom holds a file of another size than its notice said (a size in another unit, say).
    expect(await failureOf(ok, { status: 206, body: "", bytes: Buffer.alloc(16), headers: { "content-range": "bytes 0-15/65536" } })).toEqual([true, FAILURE.SIZE_MISMATCH, 0]);
    expect(await failureOf(ok, { status: 200, body: "", bytes: Buffer.alloc(32) })).toEqual([true, FAILURE.SIZE_MISMATCH, 0]);
    // A part without saying which, or a different part: tried again.
    expect(await failureOf(ok, { status: 206, body: "", bytes: Buffer.alloc(16) })).toEqual([true, FAILURE.TRANSIENT, 0]);
    expect(await failureOf(ok, { status: 206, body: "", bytes: Buffer.alloc(16), headers: { "content-range": "bytes 16-31/64" } })).toEqual([true, FAILURE.TRANSIENT, 0]);
    // The whole file at the notice's size, for a range from byte 0: the range is cut from it.
    const { provider: whole } = provider(request => (request.url.includes("/recordings") ? ok : { status: 200, body: "", bytes: Buffer.alloc(64, 3) }), "s-1");
    expect((await whole.download(record, { start: 0, end: 16 })).length).toBe(16);
  });

  test("the provider refuses to start without its configuration", () => {
    vi.stubEnv("CLASSROOM_PROVIDER", "zoom-video-sdk");
    for (const name of Object.keys(env)) vi.stubEnv(name, "");
    expect(() => classroomProvider()).toThrow(ClassroomProviderUnavailableError);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(classroomProvider().name).toBe("zoom-video-sdk");
  });
});

describe("Tencent LCIC, server side", () => {
  const env = { LCIC_SDK_APP_ID: "1400000000", TENCENTCLOUD_SECRET_ID: "AKIDsyntheticnotreal", TENCENTCLOUD_SECRET_KEY: "synthetic-secret-key-not-real", LCIC_CALLBACK_KEY: "synthetic-callback-key" };
  const config = tencentLcicConfig(env);
  const answers = {
    RegisterUser: (body) => ({ UserId: `lcic-${JSON.parse(body).OriginId}`, RequestId: "r" }),
    LoginUser: (body) => ({ UserId: JSON.parse(body).UserId, Token: `synthetic-login-${JSON.parse(body).UserId}`, RequestId: "r" }),
    StartRecord: () => ({ TaskId: "task-TEST-1", RequestId: "r" }),
    StopRecord: () => ({ RequestId: "r" }), EndRoom: () => ({ RequestId: "r" }),
    KickUserFromRoom: () => ({ RequestId: "r" }), DeleteRecord: () => ({ RequestId: "r" }),
  };
  // Each fake application numbers its rooms from 345678; "answer" may replace Tencent's reply.
  const lcic = ({ allowed = false, verified = false, deletion = false, answer } = {}) => {
    let created = 0;
    const standard = request => {
      const action = request.headers["X-TC-Action"];
      const response = action === "CreateRoom" ? { RoomId: 345678 + created++, RequestId: "r" } : answers[action](request.body);
      return { status: 200, body: JSON.stringify({ Response: response }) };
    };
    const fake = fakeTransport(answer ? request => answer(request, standard) : standard);
    const rooms = memoryRoomRegistry();
    const recordingAllowed = async () => (typeof allowed === "function" ? allowed() : allowed);
    return { ...fake, rooms, provider: tencentLcicProvider(config, { transport: fake.transport, rooms, recordingAllowed, midClassStopVerified: verified, deletionEnabled: deletion, now: () => NOW }) };
  };
  const actions = requests => requests.map(request => request.headers["X-TC-Action"]);
  const tencentError = code => ({ status: 200, body: JSON.stringify({ Response: { Error: { Code: code, Message: "details that may repeat the request" }, RequestId: "r" } }) });

  test("the signature matches Tencent's documented example (payload hash and canonical request)", () => {
    const signed = tc3Sign({
      secretId: "AKIDexample", secretKey: "example-key", service: "cvm", host: "cvm.tencentcloudapi.com", action: "DescribeInstances", version: "2017-03-12", timestamp: 1551113065,
      payload: '{"Limit": 1, "Filters": [{"Values": ["unnamed"], "Name": "instance-name"}]}',
    });
    expect(signed.canonicalRequest.split("\n").at(-1)).toBe("99d58dfbc6745f6747f36bfca17dee5e6881dc0428a0a36f96199342bc5b4907");
    expect(createHash("sha256").update(signed.canonicalRequest).digest("hex")).toBe("2815843035062fffda5fd6f2a44ea8a34818b0dc46f024b8b3786976a3adda7a");
    expect(signed.stringToSign.split("\n").slice(0, 3)).toEqual(["TC3-HMAC-SHA256", "1551113065", "2019-02-25/cvm/tc3_request"]);
    expect(signed.headers.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDexample\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  });

  test("the first entry registers both people by our ids, creates one room that does not record, and logs in", async () => {
    const { provider, requests, rooms } = lcic();
    const prepared = await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    expect(actions(requests)).toEqual(["RegisterUser", "RegisterUser", "CreateRoom", "LoginUser"]);
    expect(JSON.parse(requests[0].body)).toEqual({ SdkAppId: 1400000000, Name: "TEST-T01", OriginId: "P-TEST-T01" });
    expect(JSON.parse(requests[2].body)).toMatchObject({
      Name: "TEST-V01", SdkAppId: 1400000000, StartTime: Date.parse(lesson.startsAt) / 1000, EndTime: Date.parse(lesson.endsAt) / 1000,
      Resolution: 2, MaxMicNumber: 1, SubType: "videodoc", TeacherId: "lcic-P-TEST-T01", DisableRecord: 1,
    });
    expect(requests.every(request => request.url === "https://lcic.intl.tencentcloudapi.com/" && request.headers["X-TC-Version"] === "2022-08-17")).toBe(true);
    expect(prepared).toMatchObject({ kind: "embed", recordingDisabled: true, token: "synthetic-login-lcic-P-TEST-T01" });
    const url = new URL(prepared.embedUrl);
    expect([url.origin, url.pathname, url.searchParams.get("classid"), url.searchParams.get("userid")]).toEqual(["https://www.tencentclass.com", "/latest/class.html", "345678", "lcic-P-TEST-T01"]);
    expect((await rooms.get(lesson.id)).roomId).toBe(345678);
  });

  test("the student's entry reuses the room: no second room, only a login", async () => {
    const { provider, requests } = lcic();
    await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    const before = requests.length;
    const prepared = await provider.prepareJoin({ lesson, participant: student, now: NOW });
    expect(actions(requests.slice(before))).toEqual(["LoginUser"]);
    expect(new URL(prepared.embedUrl).searchParams.get("userid")).toBe("lcic-P-TEST-S01");
  });

  test("a room records only when the server allowed it, and then in manual mode (2): nothing records before StartRecord", async () => {
    const { provider, requests } = lcic({ allowed: true });
    const prepared = await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    expect(JSON.parse(requests[2].body).DisableRecord).toBe(2);
    expect(prepared.recordingDisabled).toBe(false);
  });

  test("real students are never recorded through LCIC until the mid-class stop is verified; TEST- lessons may be", async () => {
    const real = { ...lesson, id: "L-R-001", code: "R-001", participants: [{ id: "P-R-T01", code: "T-001", role: "tutor" }, { id: "P-R-S01", code: "S-001", role: "student" }] };
    const createRoom = requests => JSON.parse(requests.find(request => request.headers["X-TC-Action"] === "CreateRoom").body);
    const unverified = lcic({ allowed: true });
    expect((await unverified.provider.prepareJoin({ lesson: real, participant: real.participants[0], now: NOW })).recordingDisabled).toBe(true);
    expect(createRoom(unverified.requests).DisableRecord).toBe(1);
    const verified = lcic({ allowed: true, verified: true });
    await verified.provider.prepareJoin({ lesson: real, participant: real.participants[0], now: NOW });
    expect(createRoom(verified.requests).DisableRecord).toBe(2);
    expect([isTestLesson(lesson), isTestLesson(real), isTestLesson({ ...real, participants: [tutor, real.participants[1]] })]).toEqual([true, false, false]);
  });

  test("an API error keeps only Tencent's code", async () => {
    const { provider } = lcic({ answer: () => tencentError("AuthFailure.SignatureFailure") });
    const failure = await provider.prepareJoin({ lesson, participant: tutor, now: NOW }).catch(error => error);
    expect(failure).toBeInstanceOf(LcicApiError);
    expect(failure.message).toBe("LCIC RegisterUser failed: AuthFailure.SignatureFailure");
  });

  test("the server starts and stops the recording (StartRecord, then StopRecord with the kept task id); a stop is only 'accepted'", async () => {
    const { provider, requests, rooms } = lcic({ allowed: true });
    await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    const before = requests.length;
    expect(await provider.startRecording(lesson)).toEqual({ ok: true, httpStatus: 202 });
    expect(JSON.parse(requests[before].body)).toEqual({ SdkAppId: 1400000000, RoomId: 345678 });
    expect((await rooms.get(lesson.id)).recordTaskId).toBe("task-TEST-1");
    expect(await provider.stopRecording(lesson)).toEqual({ ok: true, httpStatus: 202 });
    expect(actions(requests.slice(before))).toEqual(["StartRecord", "StopRecord"]);
    expect(JSON.parse(requests.at(-1).body)).toEqual({ SdkAppId: 1400000000, RoomId: 345678, TaskId: "task-TEST-1" });
  });

  test("a room made without recording is never started; a stop with nothing started sends nothing", async () => {
    const { provider, requests } = lcic();
    await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    const before = requests.length;
    expect(await provider.startRecording(lesson)).toEqual({ ok: false, httpStatus: 409 });
    expect(await provider.stopRecording(lesson)).toEqual({ ok: false, httpStatus: 409 });
    expect(requests.length).toBe(before);
  });

  test("StopRecord unavailable on the international service is reported (501), never taken as stopped", async () => {
    const { provider } = lcic({ allowed: true, answer: (request, standard) => (request.headers["X-TC-Action"] === "StopRecord" ? tencentError("InvalidAction") : standard(request)) });
    await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    await provider.startRecording(lesson);
    expect(await provider.stopRecording(lesson)).toEqual({ ok: false, httpStatus: 501 });
    for (const [code, status] of [["UnsupportedOperation", 501], ["ResourceNotFound.Room", 404], ["FailedOperation.ClassEnded", 409], ["FailedOperation.RoomNotEnd", 409], ["UnauthorizedOperation", 403], ["InternalError", 502]]) {
      expect(lcicStatusOf(code)).toBe(status);
    }
  });

  test("ending the class (EndRoom) closes the room; the next entry opens a new room for the same people, decided again", async () => {
    let allowed = true;
    const { provider, requests, rooms } = lcic({ allowed: () => allowed });
    await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    await provider.startRecording(lesson);
    expect(await provider.endSession(lesson)).toEqual({ ok: true, httpStatus: 202 });
    expect([requests.at(-1).headers["X-TC-Action"], JSON.parse(requests.at(-1).body)]).toEqual(["EndRoom", { RoomId: 345678 }]);
    expect((await rooms.get(lesson.id)).endedAt).toBe(NOW);
    expect(await provider.endSession(lesson)).toEqual({ ok: false, httpStatus: 404 });
    // Consent was withdrawn: the new room never records, and has nothing to stop.
    allowed = false;
    const before = requests.length;
    const again = await provider.prepareJoin({ lesson, participant: student, now: NOW });
    expect(actions(requests.slice(before))).toEqual(["CreateRoom", "LoginUser"]);
    expect(JSON.parse(requests[before].body).DisableRecord).toBe(1);
    expect([new URL(again.embedUrl).searchParams.get("classid"), again.recordingDisabled]).toEqual(["345679", true]);
    expect(await provider.stopRecording(lesson)).toEqual({ ok: false, httpStatus: 409 });
  });

  test("removing a person is KickUserFromRoom with LCIC's id for our participant; nobody unknown is sent", async () => {
    const { provider, requests } = lcic();
    await provider.prepareJoin({ lesson, participant: tutor, now: NOW });
    expect(await provider.removeUser(lesson, student.id)).toEqual({ ok: true, httpStatus: 202 });
    expect(JSON.parse(requests.at(-1).body)).toEqual({ RoomId: 345678, SdkAppId: 1400000000, UserId: "lcic-P-TEST-S01", KickType: 2, Duration: 0 });
    const before = requests.length;
    expect(await provider.removeUser(lesson, "P-UNKNOWN")).toEqual({ ok: false, httpStatus: 404 });
    expect(requests.length).toBe(before);
  });

  test("deleting a recording is off unless switched on: nothing is sent", async () => {
    const { provider, requests } = lcic();
    expect(await provider.deleteRecording({ providerFileId: "lcic-345678" })).toEqual({ ok: false, httpStatus: 501 });
    expect(requests).toEqual([]);
  });

  test("switched on, deleting a recording deletes the room's files (DeleteRecord); another vendor's file id is not sent", async () => {
    const { provider, requests } = lcic({ deletion: true });
    expect(await provider.deleteRecording({ providerFileId: "lcic-345678" })).toEqual({ ok: true, httpStatus: 202 });
    expect([requests.at(-1).headers["X-TC-Action"], JSON.parse(requests.at(-1).body)]).toEqual(["DeleteRecord", { RoomId: 345678, SdkAppId: 1400000000 }]);
    const before = requests.length;
    expect(await provider.deleteRecording({ providerFileId: "zoom-file-1" })).toEqual({ ok: false, httpStatus: 404 });
    expect(requests.length).toBe(before);
  });

  test("callbacks are verified as md5(callback key + expiry), Tencent's documented example included", () => {
    const docExample = { callbackKey: "NjFGoDEy", sdkAppId: 1400000000 };
    expect(verifyLcicCallback({ SdkAppId: 1400000000, ExpireTime: 1614151508, Sign: "b9454ab5a85f9b7ad36071f5688ed34d" }, docExample, 1614151500_000)).toBeNull();
    expect(verifyLcicCallback({ SdkAppId: 1400000000, ExpireTime: 1614151508, Sign: "0".repeat(32) }, docExample, 1614151500_000)).toBe("bad signature");
    expect(verifyLcicCallback({ SdkAppId: 1400000000, ExpireTime: 1614151508, Sign: "b9454ab5a85f9b7ad36071f5688ed34d" }, docExample, 1614151509_000)).toBe("expired");
    expect(verifyLcicCallback({ SdkAppId: 1, ExpireTime: 1614151508, Sign: "b9454ab5a85f9b7ad36071f5688ed34d" }, docExample, 1614151500_000)).toBe("wrong application");
  });

  test("the provider needs its configuration and refuses a hosted site until the room table exists", () => {
    vi.stubEnv("CLASSROOM_PROVIDER", "tencent-lcic");
    for (const name of Object.keys(env)) vi.stubEnv(name, "");
    expect(() => classroomProvider()).toThrow(/not configured/);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubEnv("VERCEL", "1");
    expect(() => classroomProvider()).toThrow(/room table/);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NETLIFY", "");
    expect(classroomProvider().name).toBe("tencent-lcic");
  });
});

describe("browser adapters", () => {
  // A small stand-in for the page: elements remember their class, attributes, parent, children and
  // whether hidden; removing one takes it out of its parent (Classroom 2.0's tiles come and go).
  function fakeDom() {
    const doc = {
      createElement(tag) {
        const element = {
          tag, className: "", hidden: false, children: [], attributes: {}, nodeType: 1, ownerDocument: doc, parentNode: null,
          append(...nodes) { for (const node of nodes) { node.parentNode = element; element.children.push(node); } },
          replaceChildren(...nodes) { for (const child of element.children) child.parentNode = null; element.children = []; element.append(...nodes); },
          remove() { element.removed = true; if (element.parentNode) element.parentNode.children = element.parentNode.children.filter(child => child !== element); element.parentNode = null; },
          setAttribute(name, value) { element.attributes[name] = String(value); },
        };
        return element;
      },
    };
    return { doc, root: doc.createElement("div") };
  }
  function fakeZoom({ joinError = null, videoError = null, shareError = null, canBoard = true, boardEnabled = true, boardError = null, boardViewError = null, presenter = null, sharingAtJoin = 0, videoHangs = 0, slowVideo = 0, audioHangs = 0, slowJoin = false, failedJoins = 0, sessionId = "", chatAnswer = null, commandAnswer = null, others = [] } = {}) {
    const calls = [];
    // In-class chat and the command channel (2026-11-12), recorded apart from `calls` so the older
    // checks of the call order stay as they were. A *Answer option stands for Zoom's failure answer.
    const chatSent = [], privileges = [], commandsSent = [];
    const chat = {
      sendToAll: async (text) => { chatSent.push(text); return chatAnswer ?? { id: `m${chatSent.length}`, message: text, sender: { userId: 1, name: "TEST-T01" }, receiver: { userId: 0, name: "" }, timestamp: 1 }; },
      setPrivilege: async (value) => { privileges.push(value); return ""; },
    };
    const command = { send: async (text, target) => { commandsSent.push(target === undefined ? text : [text, target]); return commandAnswer ?? { senderId: 1, text, timestamp: 1 }; } };
    const handlers = new Map();
    // Every listener registered and not yet removed, per event: a second one for the same event
    // means the page would hear Zoom twice.
    const live = new Map();
    // `others`: people already in the session when this page joins (2026-11-18), e.g. with a camera on.
    const users = [{ userId: 1, userIdentity: "P-TEST-T01" }, ...others.map(user => ({ ...user }))];
    // A join() that finishes only when the test says so, as Zoom's can after it reports "Connected".
    let releaseJoin = () => {};
    const joinGate = slowJoin ? new Promise(resolve => { releaseJoin = resolve; }) : null;
    // holdNextJoin(): only the next join() waits, until the function it returns is called.
    let heldJoin = null;
    let joinFailures = failedJoins;
    const created = { clients: 0, destroyed: 0 };
    // The first N starts never answer, as Zoom's did when a device was pressed the moment both had joined.
    const hangs = { video: videoHangs, audio: audioHangs };
    const never = () => new Promise(() => {});
    // The first N video starts answer only when the test says so (releaseVideo), as Zoom's did on a
    // slow computer (real Zoom, 2026-11-18): after the page's deadline, but they did answer.
    let slowVideos = slowVideo, releaseVideo = () => {};
    let capturing = false;
    const qualities = [];
    const stream = {
      startAudio: async () => { calls.push("startAudio"); if (hangs.audio > 0) { hangs.audio -= 1; await never(); } },
      stopAudio: async () => calls.push("stopAudio"), muteAudio: async () => calls.push("muteAudio"), unmuteAudio: async () => calls.push("unmuteAudio"),
      startVideo: async () => {
        calls.push("startVideo");
        if (videoError) throw videoError;
        if (hangs.video > 0) { hangs.video -= 1; await never(); }
        if (slowVideos > 0) { slowVideos -= 1; await new Promise(resolve => { releaseVideo = resolve; }); }
        capturing = true;
      },
      stopVideo: async () => { calls.push("stopVideo"); capturing = false; }, isCapturingVideo: () => capturing,
      attachVideo: async (userId, quality) => {
        calls.push(`attach:${userId}`); qualities.push([userId, quality]);
        const video = { nodeType: 1, tag: `video:${userId}`, parentNode: null, remove() { if (video.parentNode) video.parentNode.children = video.parentNode.children.filter(child => child !== video); video.parentNode = null; } };
        return video;
      },
      detachVideo: async (userId) => calls.push(`detach:${userId}`),
      isStartShareScreenWithVideoElement: () => true,
      startShareScreen: async (target) => { calls.push(`share:${target.tag}`); if (shareError) throw shareError; },
      stopShareScreen: async () => calls.push("stopShare"),
      getActiveShareUserId: () => sharingAtJoin,
      attachShareView: async (userId) => { calls.push(`shareView:${userId}`); return { nodeType: 1, tag: `shared:${userId}` }; },
      detachShareView: async (userId) => calls.push(`shareViewOff:${userId}`),
    };
    // Changed after joining by the reconnect tests (2026-11-18): setPresenter, setSharer, failViews, holdNextView.
    let viewFailures = 0, failingView = null, heldView = null;
    const whiteboard = {
      isWhiteboardEnabled: () => boardEnabled, canStartWhiteboard: () => canBoard,
      startWhiteboardScreen: async (element) => { calls.push(`board:${element.className}`); if (boardError) throw boardError; },
      stopWhiteboardScreen: async () => calls.push("boardOff"),
      startWhiteboardView: async (element, userId) => {
        calls.push(`boardView:${userId}`);
        const held = heldView;
        heldView = null;
        if (held) await held;
        if (viewFailures > 0) { viewFailures -= 1; throw failingView; }
        if (boardViewError) throw boardViewError;
      },
      stopWhiteboardView: async () => calls.push("boardViewOff"),
      exportWhiteboard: async (format, name) => calls.push(`export:${format}:${name}`),
      // `presenter`: who presents a whiteboard when this page joins (2026-11-18); "throws" for a Zoom
      // that throws on the question.
      getWhiteboardPresenter: () => { if (presenter === "throws") throw new Error("whiteboard not ready"); return presenter; },
    };
    const client = {
      init: async (...args) => calls.push(["init", ...args.slice(0, 2)].join(":")),
      join: async (...args) => {
        calls.push(["join", ...args].join(":"));
        const held = heldJoin;
        heldJoin = null;
        if (held) await held;
        if (joinGate) await joinGate;
        if (joinError) throw joinError;
        if (joinFailures > 0) { joinFailures -= 1; throw new Error("join refused"); }
      },
      leave: async () => calls.push("leave"), getMediaStream: () => stream, getWhiteboardClient: () => whiteboard,
      getChatClient: () => chat, getCommandClient: () => command,
      getCurrentUserInfo: () => ({ userId: 1 }), getAllUser: () => users,
      // Video SDK 2.6.0's SessionInfo; Zoom's id of the session once joined.
      getSessionInfo: () => ({ topic: "ihear-l-test-v01", isInMeeting: true, sessionId }),
      on: (name, handler) => { handlers.set(name, handler); if (!live.has(name)) live.set(name, new Set()); live.get(name).add(handler); },
      off: (name, handler) => { calls.push(`off:${name}`); live.get(name)?.delete(handler); if (handlers.get(name) === handler) handlers.delete(name); },
    };
    // Zoom's createClient() returns the same client every time until destroyClient() (its typings).
    const sdk = {
      VERSION: "2.6.0", createClient: () => { created.clients += 1; return client; },
      destroyClient: async () => { calls.push("destroyClient"); created.destroyed += 1; },
      checkSystemRequirements: () => ({ audio: true, video: true, screen: false }), checkFeatureRequirements: () => ({ unSupportFeatures: ["screenShare"] }),
    };
    const listening = () => Object.fromEntries([...live].filter(([, set]) => set.size > 0).map(([name, set]) => [name, set.size]));
    const holdNextJoin = () => { let release; heldJoin = new Promise(resolve => { release = resolve; }); return () => release(); };
    const holdNextView = () => { let release; heldView = new Promise(resolve => { release = resolve; }); return () => release(); };
    const setPresenter = value => { presenter = value; };
    const setSharer = userId => { sharingAtJoin = userId; };
    const failViews = (error, times) => { failingView = error; viewFailures = times; };
    return { calls, handlers, users, sdk, created, listening, holdNextJoin, holdNextView, setPresenter, setSharer, failViews, releaseJoin: () => releaseJoin(), releaseVideo: () => releaseVideo(), qualities, chatSent, privileges, commandsSent };
  }
  const zoomJoin = { sessionToken: "synthetic.jwt.token", sessionName: "ihear-l-test-v01", lessonCode: "TEST-V01", participantCode: "TEST-T01", role: "tutor" };
  // Zoom calls its handlers without waiting; let their asynchronous work finish.
  const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });
  const recorded = adapter => { const events = []; adapter.subscribe(event => events.push(event)); return events; };
  // The videos drawn, tile by tile (Classroom 2.0: each video sits in its person's tile).
  const drawn = videos => videos.children.flatMap(cell => cell.children.map(child => child.tag));
  const joined = async (options, adapterOptions) => {
    const zoom = fakeZoom(options), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1, adapterOptions);
    const events = recorded(adapter);
    adapter.mount(dom.root);
    await adapter.join(zoomJoin);
    const [share, whiteboard, videos, ownShare] = dom.root.children;
    return { zoom, adapter, events, share, whiteboard, videos, ownShare };
  };

  test("P3-Multi: several cameras at once are drawn up to the device's limit (the rest wait for a free tile, the longest-waiting first), from the fourth at 360p, with the headcount", async () => {
    const { zoom, events } = await joined({}, { maxVideos: 4 });
    for (let id = 2; id <= 7; id += 1) zoom.users.push({ userId: id, userIdentity: `P-${id}`, bVideoOn: true });
    for (let id = 2; id <= 7; id += 1) { zoom.handlers.get("peer-video-state-change")({ action: "Start", userId: id }); await settle(); }
    const attached = () => zoom.calls.filter(call => typeof call === "string" && call.startsWith("attach:"));
    expect(attached()).toEqual(["attach:2", "attach:3", "attach:4", "attach:5"]);
    expect(zoom.qualities.map(([, quality]) => quality)).toEqual([3, 3, 3, 2]);
    expect(events.filter(event => event.type === "remote").at(-1)).toMatchObject({ others: 6, videosShown: 4, videosWaiting: 2 });
    // One camera goes off: the longest-waiting video takes its tile.
    zoom.handlers.get("peer-video-state-change")({ action: "Stop", userId: 3 });
    await settle();
    expect(attached().at(-1)).toBe("attach:6");
    expect(events.filter(event => event.type === "remote").at(-1)).toMatchObject({ videosShown: 4, videosWaiting: 1 });
    // A waiting one stops: nothing to detach, one fewer waiting.
    zoom.handlers.get("peer-video-state-change")({ action: "Stop", userId: 7 });
    await settle();
    expect(zoom.calls).not.toContain("detach:7");
    expect(events.filter(event => event.type === "remote").at(-1)).toMatchObject({ videosWaiting: 0 });
  });

  // Classroom 2.0 (2026-11-12): the videos container in a column of its own, one tile per person,
  // the people told to the page, and who is talking. Checked against the stand-in, not real Zoom.
  test("2.0 Zoom: the videos container can sit in a column of its own; every part is placed once, before anything is drawn", async () => {
    const zoom = fakeZoom(), dom = fakeDom(), column = dom.doc.createElement("div");
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    adapter.mount(dom.root, column);
    expect(dom.root.children.map(child => child.className)).toEqual(["classroom-zoom-share", "classroom-zoom-whiteboard", "classroom-zoom-own-share"]);
    expect(column.children.map(child => [child.tag, child.className])).toEqual([["video-player-container", "classroom-zoom-videos"]]);
    await adapter.join(zoomJoin);
    expect(await adapter.setDevice("camera", true)).toBe("on");
    const [videos] = column.children;
    expect(drawn(videos)).toEqual(["video:1"]);
    expect(videos.children[0].parentNode).toBe(videos);
  });

  test("2.0 Zoom: one tile per person, each video inside its person's tile; names are the codes Zoom has; a camera that stops leaves the tile without video", async () => {
    const { zoom, adapter, events, videos } = await joined();
    Object.assign(zoom.users[0], { displayName: "TEST-T01", isHost: true });
    zoom.users.push({ userId: 2, userIdentity: "P-TEST-S01", displayName: "TEST-S01\u0000", bVideoOn: true, audio: "computer", muted: true });
    zoom.handlers.get("user-added")([{ userId: 2 }]);
    zoom.handlers.get("peer-video-state-change")({ action: "Start", userId: 2 });
    await settle();
    const peopleOf = () => events.filter(event => event.type === "people").at(-1).people;
    expect(peopleOf()).toEqual([
      { id: "1", name: "TEST-T01", host: true, self: true, camera: false, microphone: false, video: "off" },
      { id: "2", name: "TEST-S01", host: false, self: false, camera: true, microphone: false, video: "shown" },
    ]);
    const tiles = () => videos.children.map(cell => [cell.attributes["data-person"], cell.className, cell.attributes["data-host"], cell.attributes["data-video"], cell.children.map(child => child.tag)]);
    expect(tiles()).toEqual([["1", "classroom-media-tile self", "true", "off", []], ["2", "classroom-media-tile remote", "false", "shown", ["video:2"]]]);
    // The other camera stops: Zoom's player leaves the page (as Zoom's documentation does after detachVideo); the tile stays.
    zoom.users[1].bVideoOn = false;
    zoom.handlers.get("peer-video-state-change")({ action: "Stop", userId: 2 });
    await settle();
    expect(zoom.calls).toContain("detach:2");
    expect(tiles()[1]).toEqual(["2", "classroom-media-tile remote", "false", "off", []]);
    // Unmuted: the page hears it from Zoom's user list.
    Object.assign(zoom.users[1], { muted: false });
    zoom.handlers.get("user-updated")([{ userId: 2 }]);
    expect(peopleOf()[1].microphone).toBe(true);
    zoom.users.splice(1, 1);
    zoom.handlers.get("user-removed")([{ userId: 2 }]);
    expect(tiles().map(([id]) => id)).toEqual(["1"]);
    await adapter.leave();
    expect([videos.children, peopleOf()]).toEqual([[], []]);
    for (const event of events.filter(item => item.type === "people" || item.type === "speaking")) expect(hostReportFor(event)).toBeNull();
  });

  test("2.0 Zoom: this page's own camera off marks its tile without video (Zoom's player stays, hidden); on again shows it, without drawing it twice", async () => {
    const { zoom, adapter, videos } = await joined();
    await adapter.setDevice("camera", true);
    const self = () => videos.children.find(cell => cell.attributes["data-self"] === "true");
    expect([self().attributes["data-video"], self().children.map(child => child.tag)]).toEqual(["shown", ["video:1"]]);
    await adapter.setDevice("camera", false);
    expect([self().attributes["data-video"], self().children.map(child => child.tag)]).toEqual(["off", ["video:1"]]);
    await adapter.setDevice("camera", true);
    expect([self().attributes["data-video"], self().children.map(child => child.tag)]).toEqual(["shown", ["video:1"]]);
    expect(zoom.calls.filter(call => call === "attach:1")).toHaveLength(1);
  });

  test("2.0 Zoom: a video waiting for a free tile (P3-Multi) is marked so on its person's tile", async () => {
    const { zoom, events } = await joined({}, { maxVideos: 1 });
    for (const id of [2, 3]) zoom.users.push({ userId: id, displayName: `TEST-S0${id}`, bVideoOn: true });
    zoom.handlers.get("user-added")([{ userId: 2 }, { userId: 3 }]);
    for (const id of [2, 3]) { zoom.handlers.get("peer-video-state-change")({ action: "Start", userId: id }); await settle(); }
    expect(events.filter(event => event.type === "people").at(-1).people.map(person => [person.id, person.video])).toEqual([["1", "off"], ["2", "shown"], ["3", "waiting"]]);
  });

  // Real Zoom (2026-11-18): Zoom's report that a camera started did not reach a page that came in
  // afterwards, so the student who came in second (or came back) saw no picture of the tutor's
  // camera until the tutor turned it off and on. A camera Zoom lists as on is drawn on joining.
  const cameraOn = { userId: 2, userIdentity: "P-OTHER", displayName: "TEST-O01", bVideoOn: true, audio: "computer", muted: false };
  test.each(["tutor", "student"])("2.0 Zoom: a camera already on when this page joins (as the %s) is drawn at once; Zoom's late report does not draw it twice", async (role) => {
    const zoom = fakeZoom({ others: [cameraOn, { userId: 3, displayName: "TEST-O02", bVideoOn: false }] }), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    const events = recorded(adapter);
    adapter.mount(dom.root);
    await adapter.join({ ...zoomJoin, role });
    const videos = dom.root.children[2];
    expect(drawn(videos)).toEqual(["video:2"]);
    expect(events.filter(event => event.type === "people").at(-1).people.map(person => [person.id, person.video])).toEqual([["1", "off"], ["2", "shown"], ["3", "off"]]);
    zoom.handlers.get("peer-video-state-change")({ action: "Start", userId: 2 });
    await settle();
    expect(zoom.calls.filter(call => call === "attach:2")).toHaveLength(1);
    expect(drawn(videos)).toEqual(["video:2"]);
  });

  test("2.0 Zoom: joining again draws the other person's camera that stayed on, with no new report from Zoom", async () => {
    const zoom = fakeZoom({ others: [cameraOn] }), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    adapter.mount(dom.root);
    await adapter.join(zoomJoin);
    const videos = dom.root.children[2];
    expect(drawn(videos)).toEqual(["video:2"]);
    await adapter.leave();
    expect(drawn(videos)).toEqual([]);
    await adapter.join({ ...zoomJoin, sessionToken: "fresh.jwt.token" });
    expect(drawn(videos)).toEqual(["video:2"]);
    expect(zoom.calls.filter(call => call === "attach:2")).toHaveLength(2);
  });

  test("2.0 Zoom: cameras already on when this page joins still keep to the device's tile limit (the rest wait)", async () => {
    const zoom = fakeZoom({ others: [2, 3].map(id => ({ userId: id, displayName: `TEST-S0${id}`, bVideoOn: true })) }), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1, { maxVideos: 1 });
    const events = recorded(adapter);
    adapter.mount(dom.root);
    await adapter.join(zoomJoin);
    expect(events.filter(event => event.type === "people").at(-1).people.map(person => [person.id, person.video])).toEqual([["1", "off"], ["2", "shown"], ["3", "waiting"]]);
    expect(zoom.calls.filter(call => typeof call === "string" && call.startsWith("attach:"))).toEqual(["attach:2"]);
  });

  test("2.0 Zoom: who is talking (loudest first) is told once per change, and the ring goes a moment after Zoom's last report", async () => {
    const { zoom, events } = await joined({}, { speakingMs: 30 });
    const rings = () => events.filter(event => event.type === "speaking").map(event => event.ids);
    zoom.handlers.get("active-speaker")([{ userId: 2, displayName: "TEST-S01" }, { userId: 1 }]);
    zoom.handlers.get("active-speaker")([{ userId: 2 }, { userId: 1 }]);
    expect(rings()).toEqual([["2", "1"]]);
    await new Promise(resolve => { setTimeout(resolve, 60); });
    expect(rings()).toEqual([["2", "1"], []]);
    zoom.handlers.get("active-speaker")("not a list");
    expect(rings()).toEqual([["2", "1"], []]);
  });


  test("Zoom: joins the token's topic with the participant code as the name; the other person's key comes from Zoom", async () => {
    const { zoom, events, videos, adapter } = await joined();
    expect(zoom.calls.slice(0, 2)).toEqual(["init:en-US:Global", "join:ihear-l-test-v01:synthetic.jwt.token:TEST-T01"]);
    zoom.users.push({ userId: 2, userIdentity: "P-TEST-S01", bVideoOn: true, audio: "computer", muted: false });
    zoom.handlers.get("user-added")([{ userId: 2 }]);
    expect(events.filter(event => event.type === "connection").map(event => event.state)).toEqual(["connecting", "connected"]);
    expect(events.at(-1)).toMatchObject({ type: "remote", present: true, camera: true, microphone: true, userKey: "P-TEST-S01" });
    zoom.handlers.get("connection-change")({ state: "Reconnecting" });
    expect(events.at(-1)).toMatchObject({ type: "connection", state: "reconnecting" });
    expect(await adapter.setDevice("camera", true)).toBe("on");
    expect(drawn(videos)).toEqual(["video:1"]);
  });

  test("Zoom: once joined, the page says which Zoom session it is in (getSessionInfo), and nothing when Zoom does not say", async () => {
    const withId = await joined({ sessionId: "oiFKKKL/RyGdm9W1r1Ll6w==" });
    const reported = withId.events.filter(event => event.type === "session");
    expect(reported).toEqual([{ type: "session", sessionId: "oiFKKKL/RyGdm9W1r1Ll6w==", at: 1 }]);
    // After Zoom has given the media stream: the id comes with the room, not before it.
    expect(withId.events.findIndex(event => event.type === "session")).toBeGreaterThan(withId.events.findIndex(event => event.type === "connection" && event.state === "connected"));
    expect((await joined()).events.some(event => event.type === "session")).toBe(false);
  });

  test("Zoom: videos and a shared screen go into separate <video-player-container>s, as Zoom requires", async () => {
    const { share, whiteboard, videos, ownShare } = await joined();
    expect([share.tag, whiteboard.tag, videos.tag, ownShare.tag]).toEqual(["video-player-container", "div", "video-player-container", "div"]);
    expect([share.className, whiteboard.className, videos.className, ownShare.className]).toEqual(["classroom-zoom-share", "classroom-zoom-whiteboard", "classroom-zoom-videos", "classroom-zoom-own-share"]);
    expect([share.hidden, whiteboard.hidden, videos.hidden, ownShare.hidden]).toEqual([true, true, false, true]);
  });

  // In-class chat and raised hands (2026-11-12). Nothing is saved, and none of it is reported to iHear.
  const studentJoined = async (options) => {
    const zoom = fakeZoom(options), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    const events = recorded(adapter);
    adapter.mount(dom.root);
    // This page (Zoom user 1) is the student's; the tutor, Zoom's host, is user 2.
    zoom.users.push({ userId: 2, userIdentity: "P-TEST-T01", displayName: "TEST-T01", isHost: true });
    await adapter.join({ ...zoomJoin, participantCode: "TEST-S01", role: "student" });
    return { zoom, adapter, events };
  };
  const linesOf = events => events.filter(event => event.type === "chat").map(({ line }) => [line.id, line.from, line.name, line.text]);
  const handsOf = events => events.filter(event => event.type === "hands").at(-1)?.raised ?? [];
  const notReported = events => { for (const event of events.filter(item => item.type === "chat" || item.type === "hands")) expect(hostReportFor(event)).toBeNull(); };

  test("Zoom chat: the tutor's page allows only public chat; a line goes to everyone and shows once; others' lines say tutor or student; files and empty lines are not shown", async () => {
    const { zoom, adapter, events } = await joined();
    await settle();
    expect(zoom.privileges).toEqual([5]);
    expect(await adapter.sendChat("  TEST: hello  ")).toBe(true);
    expect(zoom.chatSent).toEqual(["TEST: hello"]);
    const message = zoom.handlers.get("chat-on-message");
    // Zoom may deliver this page's own line back to it: shown once.
    message({ id: "m1", message: "TEST: hello", sender: { userId: 1, name: "TEST-T01" }, timestamp: 2 });
    zoom.users.push({ userId: 2, userIdentity: "P-TEST-S01", displayName: "TEST-S01" });
    message({ id: "m2", message: "TEST: hi\u0000", sender: { userId: 2, name: "TEST-S01" }, timestamp: 3 });
    message({ id: "m3", message: "a file", file: { name: "x.pdf" }, sender: { userId: 2, name: "TEST-S01" }, timestamp: 4 });
    message({ id: "m4", message: "   ", sender: { userId: 2, name: "TEST-S01" }, timestamp: 5 });
    message({ id: "m2", message: "TEST: hi", sender: { userId: 2, name: "TEST-S01" }, timestamp: 3 });
    message(null);
    expect(linesOf(events)).toEqual([["zoom-m1", "self", "", "TEST: hello"], ["zoom-m2", "student", "TEST-S01", "TEST: hi"]]);
    notReported(events);
  });

  test("Zoom chat: a student's page sets no chat privilege and sees the tutor's lines as the tutor's; a refused or empty line, or a room not joined, is not sent", async () => {
    const { zoom, adapter, events } = await studentJoined({ chatAnswer: { type: "INVALID_OPERATION", reason: "chat is off", errorCode: 7 } });
    await settle();
    expect(zoom.privileges).toEqual([]);
    zoom.handlers.get("chat-on-message")({ id: "t1", message: "TEST: welcome", sender: { userId: 2, name: "TEST-T01" }, timestamp: 2 });
    expect(linesOf(events)).toEqual([["zoom-t1", "tutor", "TEST-T01", "TEST: welcome"]]);
    expect(await adapter.sendChat("TEST: hello")).toBe(false);
    expect(await adapter.sendChat("   ")).toBe(false);
    expect(linesOf(events)).toHaveLength(1);
    expect(await new ZoomVideoSdkMediaAdapter(async () => zoom.sdk).sendChat("TEST: hello")).toBe(false);
  });

  test("Zoom raised hands: a student's hand goes to everyone, is told again to someone new, and comes down when the tutor lowers it; nobody else can lower it", async () => {
    const { zoom, adapter, events } = await studentJoined();
    expect(await adapter.setHand(true)).toBe(true);
    expect(zoom.commandsSent).toEqual([handCommand(true)]);
    expect(handsOf(events)).toEqual([{ id: "1", name: "", self: true }]);
    // Someone joins: they hear the raised hand too.
    zoom.handlers.get("user-added")([{ userId: 3 }]);
    expect(zoom.commandsSent).toEqual([handCommand(true), handCommand(true)]);
    // Another student cannot lower it; the tutor (Zoom's host) can.
    zoom.users.push({ userId: 3, displayName: "TEST-S02" });
    zoom.handlers.get("command-channel-message")({ senderId: 3, text: handCommand(false, 1) });
    expect(handsOf(events)).toEqual([{ id: "1", name: "", self: true }]);
    zoom.handlers.get("command-channel-message")({ senderId: 2, text: handCommand(false, 1) });
    expect(handsOf(events)).toEqual([]);
    zoom.handlers.get("user-added")([{ userId: 4 }]);
    expect(zoom.commandsSent).toHaveLength(2);
    // The student lowers it themselves too, and never lowers anyone else's.
    expect(await adapter.setHand(true)).toBe(true);
    expect(await adapter.setHand(false)).toBe(true);
    expect(zoom.commandsSent.slice(-2)).toEqual([handCommand(true), handCommand(false)]);
    expect(await adapter.lowerHand("3")).toBe(false);
    notReported(events);
  });

  test("Zoom raised hands: the tutor raises none, sees each student's hand with their code, lowers it for everyone; a student who leaves takes theirs along; the rest of the channel is ignored", async () => {
    const { zoom, adapter, events } = await joined();
    expect(await adapter.setHand(true)).toBe(false);
    zoom.users.push({ userId: 2, displayName: "TEST-S01" }, { userId: 3, displayName: "TEST-S02" });
    const command = zoom.handlers.get("command-channel-message");
    command({ senderId: 2, text: handCommand(true) });
    command({ senderId: 3, text: handCommand(true) });
    for (const text of ["hello", '{"ihear":1,"hand":true,"for":2}', "", null]) command({ senderId: 3, text });
    command({ text: handCommand(true) });
    expect(handsOf(events)).toEqual([{ id: "2", name: "TEST-S01", self: false }, { id: "3", name: "TEST-S02", self: false }]);
    expect(await adapter.lowerHand("2")).toBe(true);
    expect(zoom.commandsSent).toEqual([handCommand(false, 2)]);
    expect(handsOf(events)).toEqual([{ id: "3", name: "TEST-S02", self: false }]);
    expect(await adapter.lowerHand("2")).toBe(false);
    zoom.handlers.get("user-removed")([{ userId: 3 }]);
    expect(handsOf(events)).toEqual([]);
    // Leaving clears whatever is still raised.
    command({ senderId: 2, text: handCommand(true) });
    await adapter.leave();
    expect(handsOf(events)).toEqual([]);
    notReported(events);
  });

  test("Zoom raised hands: a command Zoom refuses is not taken as sent", async () => {
    const { adapter, events } = await studentJoined({ commandAnswer: { type: "INVALID_OPERATION", reason: "channel not ready", errorCode: 7 } });
    expect(await adapter.setHand(true)).toBe(false);
    expect(handsOf(events)).toEqual([]);
  });

  test("Zoom: microphone starts audio once, then mutes; the camera starts video and shows it; a refusal is 'denied'", async () => {
    const { zoom, adapter } = await joined({ videoError: Object.assign(new Error("no"), { name: "NotAllowedError" }) });
    expect(await adapter.setDevice("microphone", true)).toBe("on");
    expect(await adapter.setDevice("microphone", false)).toBe("off");
    expect(await adapter.setDevice("microphone", true)).toBe("on");
    expect(zoom.calls.filter(call => /Audio/.test(call))).toEqual(["startAudio", "muteAudio", "unmuteAudio"]);
    expect(await adapter.setDevice("camera", true)).toBe("denied");
    await adapter.leave();
    expect(zoom.calls).toContain("leave");
    expect(zoom.handlers.size).toBe(0);
  });

  test("Zoom devices: a start Zoom never answers ends 'failed' after the deadline; pressing again gives it one more deadline, then clears it and starts", async () => {
    const { zoom, adapter, events, videos } = await joined({ videoHangs: 1 }, { deviceStartMs: 20 });
    expect(await adapter.setDevice("camera", true)).toBe("failed");
    expect(events.filter(event => event.type === "device")).toEqual([
      { type: "device", kind: "camera", state: "starting", at: 1 },
      { type: "device", kind: "camera", state: "failed", problem: "timeout", at: 1 },
    ]);
    expect(await adapter.setDevice("camera", true)).toBe("on");
    expect(zoom.calls.filter(call => /Video|attach/.test(call))).toEqual(["startVideo", "stopVideo", "startVideo", "attach:1"]);
    expect(drawn(videos)).toEqual(["video:1"]);
  });

  test("Zoom devices: Zoom's own report settles a press whose call never answers; late reports count and draw one video", async () => {
    const waiting = await joined({ videoHangs: 1 }, { deviceStartMs: 5_000 });
    const pressed = waiting.adapter.setDevice("camera", true);
    await settle();
    waiting.zoom.handlers.get("video-capturing-change")({ state: "Started" });
    expect(await pressed).toBe("on");
    expect(drawn(waiting.videos)).toEqual(["video:1"]);
    // After the deadline: a report still turns the camera on, however many come, with one video.
    const late = await joined({ videoHangs: 1 }, { deviceStartMs: 20 });
    expect(await late.adapter.setDevice("camera", true)).toBe("failed");
    late.zoom.handlers.get("video-capturing-change")({ state: "Started" });
    late.zoom.handlers.get("video-capturing-change")({ state: "Started" });
    await settle();
    // The video is drawn after the device is on (Classroom 2.0 then tells who is shown): the last device event.
    expect(late.events.filter(event => event.type === "device").at(-1)).toMatchObject({ type: "device", kind: "camera", state: "on" });
    expect(drawn(late.videos)).toEqual(["video:1"]);
    late.zoom.handlers.get("video-capturing-change")({ state: "Stopped" });
    expect(late.events.at(-1)).toMatchObject({ type: "device", kind: "camera", state: "off" });
  });

  // Real Zoom on a slow computer (2026-11-18): the tutor's camera answered after the deadline, and
  // each "Try again" stopped that start and failed at once, although the camera came on later.
  test("Zoom devices: a start Zoom answers after the deadline turns the camera on by itself, without starting it again", async () => {
    const { zoom, adapter, events, videos } = await joined({ slowVideo: 1 }, { deviceStartMs: 20 });
    expect(await adapter.setDevice("camera", true)).toBe("failed");
    expect(events.filter(event => event.type === "device").at(-1)).toMatchObject({ kind: "camera", state: "failed", problem: "timeout" });
    zoom.releaseVideo();
    await settle(); await settle();
    expect(events.filter(event => event.type === "device").at(-1)).toMatchObject({ kind: "camera", state: "on" });
    expect(zoom.calls.filter(call => /Video|attach/.test(call))).toEqual(["startVideo", "attach:1"]);
    expect(drawn(videos)).toEqual(["video:1"]);
  });

  test("Zoom devices: “Try again” while Zoom is still starting waits for that start instead of stopping it", async () => {
    const { zoom, adapter, events, videos } = await joined({ slowVideo: 1 }, { deviceStartMs: 50 });
    expect(await adapter.setDevice("camera", true)).toBe("failed");
    const again = adapter.setDevice("camera", true);
    await settle();
    expect(events.filter(event => event.type === "device").at(-1)).toMatchObject({ kind: "camera", state: "starting" });
    zoom.releaseVideo();
    expect(await again).toBe("on");
    expect(zoom.calls.filter(call => /Video|attach/.test(call))).toEqual(["startVideo", "attach:1"]);
    expect(drawn(videos)).toEqual(["video:1"]);
    // Pressed again or left meanwhile: a late answer to an older press changes nothing.
    const left = await joined({ slowVideo: 1 }, { deviceStartMs: 20 });
    expect(await left.adapter.setDevice("camera", true)).toBe("failed");
    await left.adapter.leave();
    left.zoom.releaseVideo();
    await settle(); await settle();
    expect(left.events.filter(event => event.type === "device").at(-1)).toMatchObject({ kind: "camera", state: "off" });
    expect(left.zoom.calls.filter(call => /attach/.test(call))).toEqual([]);
  });

  test("Zoom devices: a capture failure, paused sound, a blocked permission and a busy camera each end the press as they should", async () => {
    const capture = await joined({ videoHangs: 1 }, { deviceStartMs: 5_000 });
    const pressed = capture.adapter.setDevice("camera", true);
    await settle();
    capture.zoom.handlers.get("video-capturing-change")({ state: "Failed" });
    expect(await pressed).toBe("failed");
    expect(capture.events.at(-1)).toMatchObject({ type: "device", kind: "camera", state: "failed", problem: "capture" });
    // Zoom's auto-play failure: pressing again restarts the audio.
    const sound = await joined({ audioHangs: 1 }, { deviceStartMs: 5_000 });
    const speaking = sound.adapter.setDevice("microphone", true);
    await settle();
    sound.zoom.handlers.get("auto-play-audio-failed")();
    expect(await speaking).toBe("failed");
    expect(sound.events.at(-1)).toMatchObject({ type: "device", kind: "microphone", state: "failed", problem: "autoplay" });
    // At once: only a start that ran past the deadline gets one more deadline before starting over.
    const pressedAgain = Date.now();
    expect(await sound.adapter.setDevice("microphone", true)).toBe("on");
    expect(Date.now() - pressedAgain).toBeLessThan(1_000);
    expect(sound.zoom.calls.filter(call => /Audio/.test(call))).toEqual(["startAudio", "stopAudio", "startAudio"]);
    const blocked = await joined({ videoHangs: 1 }, { deviceStartMs: 5_000 });
    const asking = blocked.adapter.setDevice("camera", true);
    await settle();
    blocked.zoom.handlers.get("device-permission-change")({ name: "camera", state: "denied" });
    expect(await asking).toBe("denied");
    const busy = await joined({ videoError: Object.assign(new Error("Could not start video source"), { name: "NotReadableError" }) });
    expect(await busy.adapter.setDevice("camera", true)).toBe("failed");
    expect(busy.events.at(-1)).toMatchObject({ type: "device", kind: "camera", state: "failed", problem: "busy" });
  });

  test("Zoom devices: the room counts as connected only once join() gives the media stream; a press made sooner waits", async () => {
    const zoom = fakeZoom({ slowJoin: true }), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1, { deviceStartMs: 5_000 });
    const events = recorded(adapter);
    adapter.mount(dom.root);
    const joining = adapter.join(zoomJoin);
    await settle();
    // Zoom says "Connected" while its join() is still running: the room is not connected yet.
    zoom.handlers.get("connection-change")({ state: "Connected" });
    expect(events.map(event => [event.type, event.state])).toEqual([["connection", "connecting"]]);
    const pressed = adapter.setDevice("camera", true);
    await settle();
    expect(events.at(-1)).toMatchObject({ type: "device", kind: "camera", state: "starting" });
    zoom.releaseJoin();
    await joining;
    expect(await pressed).toBe("on");
    expect(events.filter(event => event.type === "connection").map(event => event.state)).toEqual(["connecting", "connected"]);
    // A join that fails meanwhile ends the waiting press at once, with the message and "Try again".
    const failing = fakeZoom({ slowJoin: true, joinError: new Error("join refused") });
    const lost = new ZoomVideoSdkMediaAdapter(async () => failing.sdk, () => 1, { deviceStartMs: 5_000 });
    const lostEvents = recorded(lost);
    const attempt = lost.join(zoomJoin).catch(() => "join failed");
    await settle();
    const waiting = lost.setDevice("microphone", true);
    await settle();
    failing.releaseJoin();
    expect([await attempt, await waiting]).toEqual(["join failed", "failed"]);
    expect(lostEvents.filter(event => event.type === "device").map(event => event.state)).toEqual(["starting", "failed"]);
  });

  test("Zoom devices: leaving ends a press still waiting, and the room starts again with both off", async () => {
    const { adapter } = await joined({ audioHangs: 1 }, { deviceStartMs: 5_000 });
    const speaking = adapter.setDevice("microphone", true);
    await settle();
    await adapter.leave();
    expect(await speaking).toBe("off");
  });

  // R-2 (2026-11-06): after Zoom reported the session failed, join() returned at once because the
  // old client was still set, so "Connect again" did nothing on real Zoom. The synthetic stand-in
  // never showed it. Joining again must really join, with the new token, from a released client.
  const freshJoin = { ...zoomJoin, sessionToken: "fresh.jwt.token" };
  const joinsOf = zoom => zoom.calls.filter(call => call.startsWith("join:"));
  const connections = events => events.filter(event => event.type === "connection").map(event => event.state);
  const onePerEvent = zoom => Object.values(zoom.listening()).every(count => count === 1);

  test("RC-1 Zoom reconnect: after Zoom reports Fail, joining again joins the session again, with the new token", async () => {
    const { zoom, adapter, events } = await joined();
    zoom.handlers.get("connection-change")({ state: "Fail" });
    expect(connections(events)).toEqual(["connecting", "connected", "failed"]);
    await adapter.join(freshJoin);
    expect(joinsOf(zoom)).toEqual(["join:ihear-l-test-v01:synthetic.jwt.token:TEST-T01", "join:ihear-l-test-v01:fresh.jwt.token:TEST-T01"]);
    expect(connections(events)).toEqual(["connecting", "connected", "failed", "connecting", "connected"]);
    // The same after Zoom closes the session (ended or removed by the host).
    zoom.handlers.get("connection-change")({ state: "Closed", reason: "ended by host" });
    await adapter.join({ ...zoomJoin, sessionToken: "third.jwt.token" });
    expect(joinsOf(zoom).at(-1)).toBe("join:ihear-l-test-v01:third.jwt.token:TEST-T01");
  });

  test("RC-2 Zoom reconnect: the failed client is released first, listeners are never doubled, and no leave is reported", async () => {
    const { zoom, adapter, events } = await joined();
    const once = zoom.listening();
    expect(onePerEvent(zoom)).toBe(true);
    zoom.handlers.get("connection-change")({ state: "Fail" });
    const before = zoom.calls.length;
    await adapter.join(freshJoin);
    const rejoin = zoom.calls.slice(before);
    const at = name => rejoin.findIndex(call => call === name || call.startsWith(`${name}:`));
    // Listeners off, the client left and destroyed, and only then a new client initialised and joined.
    expect(at("off")).toBeGreaterThanOrEqual(0);
    expect(at("leave")).toBeGreaterThan(at("off"));
    expect(at("destroyClient")).toBeGreaterThan(at("leave"));
    expect(at("init")).toBeGreaterThan(at("destroyClient"));
    expect(at("join")).toBeGreaterThan(at("init"));
    expect(zoom.listening()).toEqual(once);
    // A reconnect is not the tutor leaving: the page is never told "disconnected" (iHear would hear "Closed").
    expect(connections(events)).not.toContain("disconnected");
    for (const token of ["a.jwt.token", "b.jwt.token"]) {
      zoom.handlers.get("connection-change")({ state: "Fail" });
      await adapter.join({ ...zoomJoin, sessionToken: token });
    }
    expect(zoom.listening()).toEqual(once);
    expect(zoom.created).toEqual({ clients: 4, destroyed: 3 });
  });

  test("RC-2 Zoom: two joins at once (a double click) make one client and one join; a room that is up or reconnecting by itself is left alone", async () => {
    const zoom = fakeZoom(), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    adapter.mount(dom.root);
    await Promise.all([adapter.join(zoomJoin), adapter.join(zoomJoin)]);
    expect([zoom.created.clients, joinsOf(zoom).length, onePerEvent(zoom)]).toEqual([1, 1, true]);
    await adapter.join(freshJoin);
    zoom.handlers.get("connection-change")({ state: "Reconnecting" });
    await adapter.join(freshJoin);
    expect(joinsOf(zoom).length).toBe(1);
    // After a failure, two presses of "Connect again" at once still join once.
    zoom.handlers.get("connection-change")({ state: "Fail" });
    await Promise.all([adapter.join(freshJoin), adapter.join(freshJoin)]);
    expect([zoom.created.clients, joinsOf(zoom).length, onePerEvent(zoom)]).toEqual([2, 2, true]);
  });

  test("RC-2 Zoom: a join that fails releases its client, so trying again starts clean and joins", async () => {
    const zoom = fakeZoom({ failedJoins: 1 }), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    const events = recorded(adapter);
    adapter.mount(dom.root);
    await expect(adapter.join(zoomJoin)).rejects.toThrow("join refused");
    expect([zoom.listening(), zoom.calls.slice(-2)]).toEqual([{}, ["leave", "destroyClient"]]);
    await adapter.join(freshJoin);
    expect(joinsOf(zoom).at(-1)).toBe("join:ihear-l-test-v01:fresh.jwt.token:TEST-T01");
    expect(onePerEvent(zoom)).toBe(true);
    expect(connections(events)).toEqual(["connecting", "failed", "connecting", "connected"]);
  });

  test("RC-2 Zoom: an ordinary leave releases and destroys the client; entering again joins once, one listener each", async () => {
    const { zoom, adapter, events } = await joined();
    await adapter.leave();
    expect([zoom.calls.slice(-2), zoom.listening()]).toEqual([["leave", "destroyClient"], {}]);
    await adapter.join(freshJoin);
    expect([joinsOf(zoom).length, onePerEvent(zoom)]).toEqual([2, true]);
    expect(connections(events)).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
  });

  test("RC-2 Zoom: leaving while a reconnect is still joining leaves nobody behind in the session", async () => {
    const { zoom, adapter, events } = await joined();
    zoom.handlers.get("connection-change")({ state: "Fail" });
    const release = zoom.holdNextJoin();
    const rejoining = adapter.join(freshJoin).catch(() => "refused");
    await settle();
    await adapter.leave();
    release();
    await rejoining;
    await settle();
    // Leaving released and destroyed the client; the join that finished afterwards is left again at
    // once (not destroyed again: that could destroy a newer room's client). Never "connected".
    expect(zoom.calls.slice(-3)).toEqual(["leave", "destroyClient", "leave"]);
    expect(connections(events).at(-1)).toBe("disconnected");
    expect(zoom.listening()).toEqual({});
  });

  test("RC-2 Zoom: a new room waits until the previous one has released Zoom's shared client", async () => {
    const zoom = fakeZoom();
    const first = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    first.mount(fakeDom().root);
    await first.join(zoomJoin);
    const second = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    second.mount(fakeDom().root);
    const leaving = first.leave();
    await second.join(freshJoin);
    await leaving;
    const order = zoom.calls.filter(call => /^(destroyClient|init|join)/.test(call)).map(call => call.split(":")[0]);
    expect(order).toEqual(["init", "join", "destroyClient", "init", "join"]);
    expect(onePerEvent(zoom)).toBe(true);
  });

  test("Zoom: the system check is Zoom's own answer for this browser, without joining", async () => {
    const zoom = fakeZoom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    expect(await adapter.systemCheck()).toEqual({ sdkVersion: "2.6.0", audio: true, video: true, screenShare: false, unsupported: ["screenShare"] });
    expect(zoom.calls).toEqual([]);
  });

  test("Zoom outside a browser: the official package is not loaded, joining fails and says so; a topic is required", async () => {
    const adapter = new ZoomVideoSdkMediaAdapter();
    const events = recorded(adapter);
    await expect(adapter.join(zoomJoin)).rejects.toThrow(MediaAdapterUnavailableError);
    expect(events.map(event => event.state)).toEqual(["connecting", "failed"]);
    await expect(adapter.join({ ...zoomJoin, sessionName: undefined })).rejects.toThrow(/session name/);
  });

  test("Zoom materials: the tutor shares a screen; a cancelled picker shares nothing; stopping ends it", async () => {
    const cancelled = await joined({ shareError: Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }) });
    expect(await cancelled.adapter.setScreenShare(true)).toBe(false);
    expect([cancelled.ownShare.hidden, cancelled.events.some(event => event.type === "share")]).toEqual([true, false]);
    const { zoom, adapter, events, ownShare } = await joined();
    expect(await adapter.setScreenShare(true)).toBe(true);
    expect(zoom.calls).toContain("share:video");
    expect([ownShare.hidden, events.at(-1)]).toEqual([false, { type: "share", state: "sending", at: 1 }]);
    expect(await adapter.setScreenShare(false)).toBe(false);
    expect([zoom.calls.at(-1), ownShare.hidden, events.at(-1).state]).toEqual(["stopShare", true, "none"]);
    // The browser's own "stop sharing" button.
    await adapter.setScreenShare(true);
    zoom.handlers.get("passively-stop-share")({});
    expect(events.at(-1)).toMatchObject({ type: "share", state: "none" });
  });

  test("Zoom materials: the other person's share is shown while it runs, including one already running at entry", async () => {
    const { zoom, events, share } = await joined();
    zoom.handlers.get("active-share-change")({ state: "Active", userId: 2 }); await settle();
    expect([share.hidden, share.children.map(child => child.tag), events.at(-1).state]).toEqual([false, ["shared:2"], "receiving"]);
    zoom.handlers.get("active-share-change")({ state: "Inactive", userId: 2 }); await settle();
    expect([zoom.calls.at(-1), share.hidden, share.children, events.at(-1).state]).toEqual(["shareViewOff:2", true, [], "none"]);
    const running = await joined({ sharingAtJoin: 2 });
    expect([running.share.hidden, running.events.at(-1)]).toEqual([false, { type: "share", state: "receiving", at: 1 }]);
  });

  // A real lesson (2026-11-18): the tutor shows one material, stops, then shows the next, with the
  // camera and microphone on all along; a student who comes back during a share sees it again.
  test("Zoom materials: sharing again after a stop works, and the camera and microphone stay as they were", async () => {
    const { zoom, adapter, events, ownShare } = await joined();
    expect(await adapter.setDevice("camera", true)).toBe("on");
    expect(await adapter.setDevice("microphone", true)).toBe("on");
    const devices = () => events.filter(event => event.type === "device").map(event => `${event.kind}:${event.state}`);
    const before = devices();
    for (let round = 1; round <= 2; round += 1) {
      expect(await adapter.setScreenShare(true)).toBe(true);
      expect([ownShare.hidden, events.at(-1)]).toEqual([false, { type: "share", state: "sending", at: 1 }]);
      expect(await adapter.setScreenShare(false)).toBe(false);
      expect([ownShare.hidden, events.at(-1).state]).toEqual([true, "none"]);
    }
    expect(zoom.calls.filter(call => call === "share:video")).toHaveLength(2);
    expect(devices()).toEqual(before);
  });

  test("Zoom materials: the student sees the next share after a stop, and a running share again after coming back", async () => {
    const { zoom, adapter, events, share } = await joined({ sharingAtJoin: 2 });
    const shareState = () => events.filter(event => event.type === "share").at(-1).state;
    expect(shareState()).toBe("receiving");
    zoom.handlers.get("active-share-change")({ state: "Inactive", userId: 2 }); await settle();
    expect([share.hidden, shareState()]).toEqual([true, "none"]);
    zoom.handlers.get("active-share-change")({ state: "Active", userId: 2 }); await settle();
    expect([share.hidden, share.children.map(child => child.tag), shareState()]).toEqual([false, ["shared:2"], "receiving"]);
    await adapter.leave();
    expect(share.hidden).toBe(true);
    await adapter.join({ ...zoomJoin, sessionToken: "fresh.jwt.token" });
    expect([share.hidden, shareState()]).toEqual([false, "receiving"]);
    expect(zoom.calls.filter(call => call === "shareView:2")).toHaveLength(3);
  });

  test("Zoom whiteboard: the tutor presents and can export a PDF; refused when Zoom says it cannot start; the student views it", async () => {
    const refused = await joined({ canBoard: false });
    expect([await refused.adapter.setWhiteboard(true), refused.whiteboard.hidden]).toEqual([false, true]);
    const { zoom, adapter, events, whiteboard } = await joined();
    expect(await adapter.setWhiteboard(true)).toBe(true);
    expect([zoom.calls.at(-1), whiteboard.hidden, events.at(-1).state]).toEqual(["board:classroom-zoom-whiteboard", false, "presenting"]);
    await adapter.exportWhiteboard("iHear-TEST-V01");
    expect(zoom.calls.at(-1)).toBe("export:pdf:iHear-TEST-V01");
    expect(await adapter.setWhiteboard(false)).toBe(false);
    expect([zoom.calls.at(-1), whiteboard.hidden, events.at(-1).state]).toEqual(["boardOff", true, "none"]);
    const viewer = await joined();
    viewer.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 1 }); await settle();
    expect([viewer.zoom.calls.at(-1), viewer.whiteboard.hidden, viewer.events.at(-1).state]).toEqual(["boardView:1", false, "viewing"]);
    viewer.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Stop", userId: 1 }); await settle();
    expect([viewer.zoom.calls.at(-1), viewer.whiteboard.hidden, viewer.events.at(-1).state]).toEqual(["boardViewOff", true, "none"]);
  });

  // Real Zoom (2026-11-18): the tutor's page could not start the board, yet the student saw it, a board
  // the tutor could neither see nor close. A start that fails here is closed for everyone too.
  test("Zoom whiteboard: a board this page could not open is closed for everyone, so the tutor can press again", async () => {
    const { zoom, adapter, events, whiteboard } = await joined({ boardError: new Error("whiteboard failed") });
    expect(await adapter.setWhiteboard(true)).toBe(false);
    expect(zoom.calls.slice(-2)).toEqual(["board:classroom-zoom-whiteboard", "boardOff"]);
    expect([whiteboard.hidden, whiteboard.children]).toEqual([true, []]);
    expect(events.filter(event => event.type === "whiteboard").map(event => event.state)).not.toContain("presenting");
  });

  // Zoom's whiteboard guide (2026-11-18): a page that comes in later may miss the report that a board
  // started, so on joining it asks who presents. Real Zoom showed the same gap for cameras.
  test("Zoom whiteboard: a board already open when this page joins, or joins again, is viewed at once", async () => {
    const { zoom, adapter, events, whiteboard } = await joined({ presenter: { userId: 2, displayName: "TEST-T01" } });
    expect(zoom.calls.filter(call => call === "boardView:2")).toHaveLength(1);
    expect([whiteboard.hidden, events.filter(event => event.type === "whiteboard").at(-1).state]).toEqual([false, "viewing"]);
    // Zoom's own late report of the same board does not view it twice; its Stop closes it.
    zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
    expect(zoom.calls.filter(call => call === "boardView:2")).toHaveLength(1);
    zoom.handlers.get("peer-whiteboard-state-change")({ action: "Stop", userId: 2 }); await settle();
    expect(whiteboard.hidden).toBe(true);
    // Opened again: viewed again.
    zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
    expect(zoom.calls.filter(call => call === "boardView:2")).toHaveLength(2);
    await adapter.leave();
    await adapter.join({ ...zoomJoin, sessionToken: "fresh.jwt.token" });
    expect(zoom.calls.filter(call => call === "boardView:2")).toHaveLength(3);
    expect(events.filter(event => event.type === "whiteboard").at(-1).state).toBe("viewing");
  });

  test("Zoom whiteboard: nothing to view when nobody presents or this page presents; a failing question never stops the entry", async () => {
    for (const presenter of [null, { userId: 1 }, "throws"]) {
      const { zoom, events } = await joined({ presenter });
      expect(zoom.calls.some(call => typeof call === "string" && call.startsWith("boardView:"))).toBe(false);
      expect(events.filter(event => event.type === "connection").at(-1).state).toBe("connected");
    }
  });

  test("Zoom whiteboard: a board the other person opened but this page cannot show is said, not swallowed, with Zoom's code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { zoom, events, whiteboard } = await joined({ boardViewError: new Error("view failed") });
      zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
      expect(events.filter(event => event.type === "whiteboard").at(-1)).toMatchObject({ state: "none", problem: "view", code: null });
      expect([whiteboard.hidden, whiteboard.children]).toEqual([true, []]);
      const coded = await joined({ boardViewError: { type: "INVALID_PARAMETERS", reason: "presenter https://zoom.example/?token=secret", errorCode: 8005 } });
      warn.mockClear();
      coded.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
      expect(coded.events.filter(event => event.type === "whiteboard").at(-1)).toEqual({ type: "whiteboard", state: "none", problem: "view", code: 8005, at: 1 });
      expect(warn.mock.calls.map(args => args.join(" "))).toEqual(["[classroom] whiteboard view failed: Zoom error 8005"]);
    } finally {
      warn.mockRestore();
    }
  });

  // Zoom's whiteboard error codes (2026-11-18): kept as numbers, so a failure is never a guess, and
  // nothing else of Zoom's answer (its words, a link, a token) reaches the page or the console.
  test("Zoom whiteboard: a start Zoom refuses keeps only Zoom's code (8000–8006), never Zoom's words, links or tokens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const secret = "aaaaaaaaaa.bbbbbbbbbb.cccccccccc";
      for (const code of [8000, 8001, 8002, 8003, 8004, 8005, 8006]) {
        const { adapter, events } = await joined({ boardError: { type: "INVALID_OPERATION", reason: `see https://zoom.example/x?token=${secret}`, errorCode: code } });
        warn.mockClear();
        expect(await adapter.setWhiteboard(true)).toBe(false);
        const boards = events.filter(event => event.type === "whiteboard");
        expect(boards.at(-1)).toEqual({ type: "whiteboard", state: "none", problem: "start", code, at: 1 });
        expect(warn.mock.calls.map(args => args.join(" "))).toEqual([`[classroom] whiteboard start failed: Zoom error ${code}`]);
        expect(JSON.stringify([boards, warn.mock.calls])).not.toMatch(/token|https|zoom\.example|INVALID_OPERATION|aaaaaaaaaa/);
      }
      // Not Zoom's shape (an Error, a string): no code, and none of its words either.
      for (const boardError of [new Error("boom at https://x.example/?token=t"), "plain failure"]) {
        const { adapter, events } = await joined({ boardError });
        warn.mockClear();
        expect(await adapter.setWhiteboard(true)).toBe(false);
        expect(events.filter(event => event.type === "whiteboard").at(-1)).toEqual({ type: "whiteboard", state: "none", problem: "start", code: null, at: 1 });
        expect(warn.mock.calls.map(args => args.join(" "))).toEqual(["[classroom] whiteboard start failed"]);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("Zoom whiteboard: not tried during a screen share, sent or received (Zoom's 8002), nor when the account has none (8000) or Zoom says this page cannot start one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = zoom => zoom.calls.some(call => typeof call === "string" && call.startsWith("board:"));
    try {
      const sending = await joined();
      expect(await sending.adapter.setScreenShare(true)).toBe(true);
      expect(await sending.adapter.setWhiteboard(true)).toBe(false);
      expect([started(sending.zoom), sending.whiteboard.hidden]).toEqual([false, true]);
      expect(sending.events.at(-1)).toEqual({ type: "whiteboard", state: "none", problem: "start", code: 8002, at: 1 });
      // The share goes on.
      expect([sending.ownShare.hidden, sending.events.filter(event => event.type === "share").at(-1).state]).toEqual([false, "sending"]);
      const receiving = await joined({ sharingAtJoin: 2 });
      expect(await receiving.adapter.setWhiteboard(true)).toBe(false);
      expect([started(receiving.zoom), receiving.events.filter(event => event.type === "whiteboard").at(-1).code]).toEqual([false, 8002]);
      const off = await joined({ boardEnabled: false });
      expect(await off.adapter.setWhiteboard(true)).toBe(false);
      expect([started(off.zoom), off.events.filter(event => event.type === "whiteboard").at(-1).code]).toEqual([false, 8000]);
      const cannot = await joined({ canBoard: false });
      expect(await cannot.adapter.setWhiteboard(true)).toBe(false);
      expect([started(cannot.zoom), cannot.events.filter(event => event.type === "whiteboard").at(-1)]).toEqual([false, { type: "whiteboard", state: "none", problem: "start", code: null, at: 1 }]);
      // After the share stops, the whiteboard starts as before.
      expect(await sending.adapter.setScreenShare(false)).toBe(false);
      expect(await sending.adapter.setWhiteboard(true)).toBe(true);
      expect(sending.events.at(-1)).toMatchObject({ type: "whiteboard", state: "presenting" });
    } finally {
      warn.mockRestore();
    }
  });

  // Zoom opens no whiteboard during a screen share (its 8002), so the two are left apart (2026-11-18).
  test("Zoom: leaving ends the share and the whiteboard on this page too", async () => {
    const sharing = await joined({ sharingAtJoin: 2 });
    await sharing.adapter.leave();
    expect(sharing.events.slice(-2).map(event => [event.type, event.state])).toEqual([["share", "none"], ["connection", "disconnected"]]);
    expect([sharing.share.hidden, sharing.share.children]).toEqual([true, []]);
    const presenting = await joined();
    expect(await presenting.adapter.setWhiteboard(true)).toBe(true);
    await presenting.adapter.leave();
    expect(presenting.events.slice(-2).map(event => [event.type, event.state])).toEqual([["whiteboard", "none"], ["connection", "disconnected"]]);
    expect(presenting.whiteboard.hidden).toBe(true);
  });

  // Zoom reconnecting by itself (2026-11-18, real Zoom W6): after 30 s offline the student was back in
  // 4 s, but 6 s later the whiteboard area was blank while the page still showed the board (whether it
  // came back later is unknown). After Zoom's Reconnecting → Connected the page asks Zoom again what it
  // missed. The check runs on its own; `reconnect` lets it finish (the adapters here wait 0 ms before
  // asking Zoom a second time, unless a test says otherwise).
  const fast = { resyncRetryMs: 0 };
  const reconnect = async (zoom, { finish = true } = {}) => {
    zoom.handlers.get("connection-change")({ state: "Reconnecting" });
    zoom.handlers.get("connection-change")({ state: "Connected" });
    if (finish) for (let round = 0; round < 20; round += 1) await settle();
  };
  const callsSince = (zoom, from) => zoom.calls.slice(from).filter(call => typeof call === "string");
  const boardCalls = (zoom, from) => callsSince(zoom, from).filter(call => /^board/.test(call));
  const boardStates = events => events.filter(event => event.type === "whiteboard").map(event => event.state);
  const quietInfo = () => vi.spyOn(console, "info").mockImplementation(() => {});
  const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

  test("RS-1 Zoom reconnect: a whiteboard still open is viewed again in the same place, once, and the page never leaves the board", async () => {
    const info = quietInfo();
    try {
      const { zoom, events, whiteboard } = await joined({ presenter: { userId: 2 } }, fast);
      expect(boardStates(events)).toEqual(["viewing"]);
      const from = zoom.calls.length;
      await reconnect(zoom);
      // The old view goes first, then the same presenter's board is viewed again: never two at once.
      expect(boardCalls(zoom, from)).toEqual(["boardViewOff", "boardView:2"]);
      // No "none" in between: the page's layout and buttons do not flicker.
      expect([whiteboard.hidden, boardStates(events)]).toEqual([false, ["viewing"]]);
      expect(connections(events).slice(-2)).toEqual(["reconnecting", "connected"]);
      expect(info.mock.calls.map(args => args.join(" "))).toEqual(["[classroom] after reconnect: whiteboard viewing, share none, videos 0"]);
      // Zoom's own late Start of the same board does not view it a third time.
      zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
      expect(zoom.calls.filter(call => call === "boardView:2")).toHaveLength(2);
    } finally {
      info.mockRestore();
    }
  });

  test("RS-2 Zoom reconnect: a board opened during the outage is viewed; one closed during it is closed, only when Zoom says so twice", async () => {
    const info = quietInfo();
    try {
      const missed = await joined({}, fast);
      missed.zoom.setPresenter({ userId: 2 });
      await reconnect(missed.zoom);
      expect([missed.zoom.calls.filter(call => call === "boardView:2").length, missed.whiteboard.hidden, boardStates(missed.events)]).toEqual([1, false, ["viewing"]]);
      const closed = await joined({ presenter: { userId: 2 } }, fast);
      closed.zoom.setPresenter(null);
      const from = closed.zoom.calls.length;
      await reconnect(closed.zoom);
      expect(boardCalls(closed.zoom, from)).toEqual(["boardViewOff"]);
      expect([closed.whiteboard.hidden, closed.whiteboard.children, boardStates(closed.events)]).toEqual([true, [], ["viewing", "none"]]);
      // Zoom's list a moment behind its "Connected": "nobody" first, the presenter again a moment
      // later. The board is never closed; it is viewed again once.
      const lagging = await joined({ presenter: { userId: 2 } }, { resyncRetryMs: 40 });
      lagging.zoom.setPresenter(null);
      const lagFrom = lagging.zoom.calls.length;
      await reconnect(lagging.zoom, { finish: false });
      await settle();
      lagging.zoom.setPresenter({ userId: 2 });
      await wait(80);
      for (let round = 0; round < 10; round += 1) await settle();
      expect(boardCalls(lagging.zoom, lagFrom)).toEqual(["boardViewOff", "boardView:2"]);
      expect([lagging.whiteboard.hidden, boardStates(lagging.events)]).toEqual([false, ["viewing"]]);
    } finally {
      info.mockRestore();
    }
  });

  test("RS-3 Zoom reconnect: cameras on are drawn, those still drawn are not drawn again, and this page's own camera and microphone are left exactly as they were", async () => {
    const info = quietInfo();
    try {
      const { zoom, adapter, events, videos } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01", bVideoOn: true }] }, fast);
      expect(drawn(videos)).toEqual(["video:2"]);
      // The person turned both their own devices on and then off again before the outage.
      expect(await adapter.setDevice("camera", true)).toBe("on");
      expect(await adapter.setDevice("camera", false)).toBe("off");
      expect(await adapter.setDevice("microphone", true)).toBe("on");
      expect(await adapter.setDevice("microphone", false)).toBe("off");
      // Someone else turned a camera on while this page was away; Zoom's Start never reached it.
      zoom.users.push({ userId: 3, userIdentity: "P-TEST-S02", bVideoOn: true });
      const from = zoom.calls.length, eventsFrom = events.length;
      await reconnect(zoom);
      const after = callsSince(zoom, from);
      expect(after.filter(call => call.startsWith("attach:"))).toEqual(["attach:3"]);
      expect(after.filter(call => /Video|Audio|detach/.test(call))).toEqual([]);
      expect(events.slice(eventsFrom).filter(event => event.type === "device")).toEqual([]);
      // This page's own tile (video:1) stays as it was; the others are drawn once each.
      expect(drawn(videos).filter(tag => tag !== "video:1").sort()).toEqual(["video:2", "video:3"]);
      const people = events.filter(event => event.type === "people").at(-1).people;
      expect(people.find(person => person.self)).toMatchObject({ camera: false, microphone: false });
      expect(people.filter(person => !person.self).map(person => [person.id, person.video])).toEqual([["2", "shown"], ["3", "shown"]]);
      // A second reconnect draws nobody twice.
      const again = zoom.calls.length;
      await reconnect(zoom);
      expect(callsSince(zoom, again).filter(call => /attach|Video|Audio/.test(call))).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  test("RS-4 Zoom reconnect: a screen share that started or ended during the outage is shown or closed; this page's own share is left alone", async () => {
    const info = quietInfo();
    const shares = events => events.filter(event => event.type === "share").map(event => event.state);
    try {
      const { zoom, adapter, events, share } = await joined({}, fast);
      zoom.setSharer(2);
      await reconnect(zoom);
      expect([zoom.calls.filter(call => call === "shareView:2").length, share.hidden, shares(events)]).toEqual([1, false, ["receiving"]]);
      zoom.setSharer(0);
      await reconnect(zoom);
      expect([zoom.calls.includes("shareViewOff:2"), share.hidden, shares(events)]).toEqual([true, true, ["receiving", "none"]]);
      // A share closed here no longer keeps the whiteboard from starting (Zoom's 8002).
      expect(await adapter.setWhiteboard(true)).toBe(true);
      const own = await joined({}, fast);
      expect(await own.adapter.setScreenShare(true)).toBe(true);
      const from = own.zoom.calls.length;
      await reconnect(own.zoom);
      expect(callsSince(own.zoom, from).filter(call => /share/i.test(call))).toEqual([]);
      expect([own.ownShare.hidden, shares(own.events).at(-1)]).toEqual([false, "sending"]);
    } finally {
      info.mockRestore();
    }
  });

  test("RS-5 Zoom reconnect: the tutor's own whiteboard is never restarted (that would close it, strokes and all, for everyone)", async () => {
    const info = quietInfo();
    try {
      const { zoom, adapter, events, whiteboard } = await joined({}, fast);
      expect(await adapter.setWhiteboard(true)).toBe(true);
      zoom.setPresenter({ userId: 1 });
      const from = zoom.calls.length;
      await reconnect(zoom);
      expect(boardCalls(zoom, from)).toEqual([]);
      expect([whiteboard.hidden, boardStates(events).at(-1)]).toEqual([false, "presenting"]);
      // Zoom says nobody presents any more (twice): the board is closed on this page; the tutor can open it again.
      zoom.setPresenter(null);
      await reconnect(zoom);
      expect([boardCalls(zoom, from), whiteboard.hidden, boardStates(events).at(-1)]).toEqual([[], true, "none"]);
      expect(await adapter.setWhiteboard(true)).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  test("RS-6 Zoom reconnect errors: a view that fails is tried once more, then said with Zoom's code; a question Zoom cannot answer changes nothing; leaving stops the check", async () => {
    const info = quietInfo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = await joined({ presenter: { userId: 2 } }, fast);
      failing.zoom.failViews({ type: "INVALID_OPERATION", reason: "see https://zoom.example/?token=secret", errorCode: 8003 }, 2);
      const from = failing.zoom.calls.length;
      await reconnect(failing.zoom);
      expect(boardCalls(failing.zoom, from).filter(call => call === "boardView:2")).toHaveLength(2);
      expect(failing.events.filter(event => event.type === "whiteboard").at(-1)).toEqual({ type: "whiteboard", state: "none", problem: "view", code: 8003, at: 1 });
      expect([failing.whiteboard.hidden, failing.whiteboard.children]).toEqual([true, []]);
      expect(warn.mock.calls.map(args => args.join(" "))).toEqual(["[classroom] whiteboard view failed: Zoom error 8003"]);
      expect(JSON.stringify([failing.events, warn.mock.calls, info.mock.calls])).not.toMatch(/token|https|zoom\.example|INVALID_OPERATION/);
      // Zoom's own Start afterwards views it as usual.
      failing.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
      expect(boardStates(failing.events).at(-1)).toBe("viewing");
      // Fails once, works the second time: shown, nothing said, never "none".
      warn.mockClear();
      const flaky = await joined({ presenter: { userId: 2 } }, fast);
      flaky.zoom.failViews(new Error("not ready"), 1);
      await reconnect(flaky.zoom);
      expect([flaky.whiteboard.hidden, boardStates(flaky.events), warn.mock.calls]).toEqual([false, ["viewing"], []]);
      // Fails once, and Zoom's own Start comes before the second try: viewed by that Start, not a third time.
      const overtaken = await joined({ presenter: { userId: 2 } }, { resyncRetryMs: 40 });
      overtaken.zoom.failViews(new Error("not ready"), 1);
      const overtakenFrom = overtaken.zoom.calls.length;
      await reconnect(overtaken.zoom, { finish: false });
      await settle();
      overtaken.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
      await wait(80);
      for (let round = 0; round < 10; round += 1) await settle();
      expect(boardCalls(overtaken.zoom, overtakenFrom).filter(call => call === "boardView:2")).toHaveLength(2);
      expect([overtaken.whiteboard.hidden, boardStates(overtaken.events), warn.mock.calls]).toEqual([false, ["viewing"], []]);
      // Zoom cannot say who presents: the board stays as it is.
      const unsure = await joined({ presenter: { userId: 2 } }, fast);
      unsure.zoom.setPresenter("throws");
      const unsureFrom = unsure.zoom.calls.length;
      await reconnect(unsure.zoom);
      expect([boardCalls(unsure.zoom, unsureFrom), unsure.whiteboard.hidden, boardStates(unsure.events)]).toEqual([[], false, ["viewing"]]);
      // The room is left while the check waits to ask Zoom again: it stops, and nothing is viewed or said.
      const leaving = await joined({ presenter: { userId: 2 } }, { resyncRetryMs: 40 });
      leaving.zoom.setPresenter(null);
      info.mockClear();
      await reconnect(leaving.zoom, { finish: false });
      await settle();
      await leaving.adapter.leave();
      const leftAt = leaving.zoom.calls.length, leftEvents = leaving.events.length;
      await wait(80);
      expect([callsSince(leaving.zoom, leftAt), info.mock.calls, leaving.events.slice(leftEvents)]).toEqual([[], [], []]);
      expect(connections(leaving.events).at(-1)).toBe("disconnected");
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  test("RS-7 Zoom reconnect: one check at a time, none without a Reconnecting before it, and a board closed while Zoom is opening it is not shown", async () => {
    const info = quietInfo();
    try {
      const { zoom, events } = await joined({ presenter: { userId: 2 } }, fast);
      // "Connected" again without a reconnect: nothing is asked or redrawn.
      const quiet = zoom.calls.length;
      zoom.handlers.get("connection-change")({ state: "Connected" });
      for (let round = 0; round < 10; round += 1) await settle();
      expect([callsSince(zoom, quiet), info.mock.calls]).toEqual([[], []]);
      // A second reconnect while the first check is still viewing the board: no second view on top;
      // one more check follows when the first one is done.
      const release = zoom.holdNextView();
      const from = zoom.calls.length;
      await reconnect(zoom);
      expect(boardCalls(zoom, from)).toEqual(["boardViewOff", "boardView:2"]);
      await reconnect(zoom);
      expect(boardCalls(zoom, from)).toEqual(["boardViewOff", "boardView:2"]);
      release();
      for (let round = 0; round < 20; round += 1) await settle();
      expect(boardCalls(zoom, from)).toEqual(["boardViewOff", "boardView:2", "boardViewOff", "boardView:2"]);
      expect(boardStates(events)).toEqual(["viewing"]);
      // Zoom's Stop while its view is still opening: the board is not shown after all.
      const viewer = await joined({}, fast);
      const releaseView = viewer.zoom.holdNextView();
      viewer.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
      viewer.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Stop", userId: 2 }); await settle();
      releaseView();
      for (let round = 0; round < 5; round += 1) await settle();
      expect([boardStates(viewer.events), viewer.whiteboard.hidden, viewer.zoom.calls.at(-1)]).toEqual([[], true, "boardViewOff"]);
      // Zoom's own Start still opening when the reconnect comes: the check leaves it to finish.
      const opening = await joined({}, { resyncRetryMs: 10 });
      const releaseOpening = opening.zoom.holdNextView();
      opening.zoom.setPresenter({ userId: 2 });
      opening.zoom.handlers.get("peer-whiteboard-state-change")({ action: "Start", userId: 2 }); await settle();
      await reconnect(opening.zoom, { finish: false });
      await wait(40);
      for (let round = 0; round < 10; round += 1) await settle();
      releaseOpening();
      for (let round = 0; round < 10; round += 1) await settle();
      expect([opening.zoom.calls.filter(call => call === "boardView:2").length, boardStates(opening.events), opening.whiteboard.hidden]).toEqual([1, ["viewing"], false]);
    } finally {
      info.mockRestore();
    }
  });

  // Cameras after both people are in (2026-11-19, production, iHear's teacher and student): the tutor
  // turned the camera on and saw it, the student heard the tutor but saw no picture. Zoom's record
  // of that session showed the tutor in the room up to three times at once. The page now also looks
  // at Zoom's list of people a moment after it changes, and says when its person is in twice.
  const quick = { videoCheckMs: 0 };
  const peopleChanged = async (zoom, event = "user-updated") => {
    zoom.handlers.get(event)([{ userId: 2 }]);
    for (let round = 0; round < 6; round += 1) await settle();
  };
  const attaches = zoom => zoom.calls.filter(call => typeof call === "string" && call.startsWith("attach:"));

  test("AV-1 a camera turned on after both are in is drawn even when Zoom's 'video started' report never comes, and only once", async () => {
    const { zoom, videos } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01", bVideoOn: false }] }, quick);
    expect(drawn(videos)).toEqual([]);
    // The other person turns the camera on: Zoom's list says so (user-updated), its Start is missed.
    zoom.users[1].bVideoOn = true;
    await peopleChanged(zoom);
    expect([attaches(zoom), drawn(videos)]).toEqual([["attach:2"], ["video:2"]]);
    // Zoom's own late Start of the same camera does not draw it twice.
    zoom.handlers.get("peer-video-state-change")({ action: "Start", userId: 2 }); await settle();
    await peopleChanged(zoom);
    expect(attaches(zoom)).toEqual(["attach:2"]);
  });

  test("AV-1b the usual path is unchanged: Zoom's Start draws the camera at once, the list check adds nothing", async () => {
    const { zoom, videos } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01" }] }, quick);
    zoom.users[1].bVideoOn = true;
    zoom.handlers.get("peer-video-state-change")({ action: "Start", userId: 2 }); await settle();
    expect(drawn(videos)).toEqual(["video:2"]);
    await peopleChanged(zoom);
    expect(attaches(zoom)).toEqual(["attach:2"]);
    // Off again: Zoom's Stop takes the video away.
    zoom.users[1].bVideoOn = false;
    zoom.handlers.get("peer-video-state-change")({ action: "Stop", userId: 2 }); await settle();
    expect(drawn(videos)).toEqual([]);
  });

  test("AV-2 someone who leaves lets go of their video at once (no Stop needed), and a waiting video takes the tile", async () => {
    const { zoom, videos } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01", bVideoOn: true }, { userId: 3, userIdentity: "P-TEST-S02", bVideoOn: true }] }, { ...quick, maxVideos: 1 });
    expect(drawn(videos)).toEqual(["video:2"]);
    // Person 2 leaves without Zoom saying their video stopped.
    zoom.users.splice(1, 1);
    await peopleChanged(zoom, "user-removed");
    expect(zoom.calls).toContain("detach:2");
    expect(drawn(videos)).toEqual(["video:3"]);
  });

  test("AV-3 the page says when its person is in the room from another page or device too, and when that ends", async () => {
    const { zoom, adapter, events } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01" }] }, quick);
    const duplicates = () => events.filter(event => event.type === "duplicate").map(event => event.count);
    expect(duplicates()).toEqual([]);
    // The same participant id (Zoom keeps it as the user key) joins again from another tab.
    zoom.users.push({ userId: 7, userIdentity: "P-TEST-T01" });
    zoom.handlers.get("user-added")([{ userId: 7 }]); await settle();
    expect(duplicates()).toEqual([1]);
    // Someone else changing something does not tell it again.
    zoom.handlers.get("user-updated")([{ userId: 2 }]); await settle();
    expect(duplicates()).toEqual([1]);
    zoom.users.pop();
    zoom.handlers.get("user-removed")([{ userId: 7 }]); await settle();
    expect(duplicates()).toEqual([1, 0]);
    // Leaving while it was 0 says nothing more.
    await adapter.leave();
    expect(duplicates()).toEqual([1, 0]);
  });

  // 2026-11-19, real Zoom: a page that was cut off, or closed without leaving, stays in Zoom's list
  // for minutes. The person who came back was shown twice, and was told "also entered elsewhere".
  test("AV-6 a person Zoom lists twice (the entry a cut-off page left behind, and the one that came back) is one person here: the later entry", async () => {
    const { zoom, events } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01", bVideoOn: true }] }, quick);
    const people = () => events.filter(event => event.type === "people").at(-1).people.map(person => person.id);
    expect(people()).toEqual(["1", "2"]);
    // The student's page is cut off; Zoom keeps entry 2. The student connects again as entry 9.
    zoom.users.push({ userId: 9, userIdentity: "P-TEST-S01", bVideoOn: true });
    await peopleChanged(zoom, "user-added");
    expect(people()).toEqual(["1", "9"]);
    // The video of the entry left behind is let go; the one that came back is drawn.
    expect(zoom.calls).toContain("detach:2");
    expect(zoom.calls).toContain("attach:9");
    // Zoom drops the old entry minutes later: nothing changes on the page.
    zoom.users.splice(1, 1);
    await peopleChanged(zoom, "user-removed");
    expect(people()).toEqual(["1", "9"]);
    // Two different people are of course both shown.
    zoom.users.push({ userId: 12, userIdentity: "P-TEST-S02" });
    await peopleChanged(zoom, "user-added");
    expect(people()).toEqual(["1", "9", "12"]);
  });

  test("AV-7 this page's own earlier join, still in Zoom's list after connecting again, is not \"entered elsewhere\" and is not shown; another device still is", async () => {
    const { zoom, adapter, events } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01" }] }, quick);
    const duplicates = () => events.filter(event => event.type === "duplicate").map(event => event.count);
    const people = () => events.filter(event => event.type === "people").at(-1).people.map(person => person.id);
    // The connection failed; the page connects again (the same session) and Zoom gives it a new id,
    // while the old entry (1) is still listed.
    await adapter.leave();
    const client = zoom.sdk.createClient();
    client.getCurrentUserInfo = () => ({ userId: 5 });
    zoom.users.push({ userId: 5, userIdentity: zoom.users[0].userIdentity });
    await adapter.join(zoomJoin);
    await peopleChanged(zoom, "user-added");
    expect(duplicates().filter(count => count > 0)).toEqual([]);
    expect(people()).toEqual(["2", "5"]);
    // Zoom reconnects by itself and gives a new id again, while the client no longer says the old one
    // (real Zoom probe, 2026-11-19): the entry left behind (5) is still not "elsewhere", and not shown.
    client.getCurrentUserInfo = () => ({ userId: 8 });
    zoom.users.push({ userId: 8, userIdentity: zoom.users[0].userIdentity });
    await peopleChanged(zoom, "user-added");
    expect(duplicates().filter(count => count > 0)).toEqual([]);
    expect(people()).toEqual(["2", "8"]);
    // The same person on a really different page or device is still said.
    zoom.users.push({ userId: 30, userIdentity: zoom.users[0].userIdentity });
    await peopleChanged(zoom, "user-added");
    expect(duplicates().at(-1)).toBe(1);
  });

  test("AV-4 looking at the cameras never touches this page's own camera or microphone, and draws nobody's own video twice", async () => {
    const { zoom, adapter, events } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01", bVideoOn: true }] }, quick);
    expect(await adapter.setDevice("camera", true)).toBe("on");
    expect(await adapter.setDevice("camera", false)).toBe("off");
    const from = zoom.calls.length, eventsFrom = events.length;
    // Even when Zoom's list says this page's own camera is on, the look never draws it (only a press does).
    zoom.users[0].bVideoOn = true;
    await peopleChanged(zoom);
    await peopleChanged(zoom, "user-added");
    expect(zoom.calls.slice(from).filter(call => /Video|Audio|attach:1/.test(String(call)))).toEqual([]);
    expect(events.slice(eventsFrom).filter(event => event.type === "device")).toEqual([]);
    // A page that never turned its camera on: Zoom's list saying it is on draws nothing of its own.
    const fresh = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01" }] }, quick);
    fresh.zoom.users[0].bVideoOn = true;
    await peopleChanged(fresh.zoom);
    expect(fresh.zoom.calls.filter(call => /^attach:1$|startVideo/.test(String(call)))).toEqual([]);
  });

  test("AV-5 the camera look reports to the page (and the tutor's iHear report) only when it changed something", async () => {
    const { zoom, events } = await joined({ others: [{ userId: 2, userIdentity: "P-TEST-S01" }] }, quick);
    const remotes = () => events.filter(event => event.type === "remote").length;
    zoom.handlers.get("user-updated")([{ userId: 2 }]);
    const afterEvent = remotes();
    for (let round = 0; round < 6; round += 1) await settle();
    expect(remotes()).toBe(afterEvent);
    zoom.users[1].bVideoOn = true;
    zoom.handlers.get("user-updated")([{ userId: 2 }]);
    const beforeDraw = remotes();
    for (let round = 0; round < 6; round += 1) await settle();
    expect(remotes()).toBeGreaterThan(beforeDraw);
  });

  test("LCIC: only Tencent's classroom page is placed in the room, with camera and microphone allowed", async () => {
    const created = [];
    const doc = { createElement: (tag) => { const element = { tag, remove: () => { element.removed = true; } }; created.push(element); return element; } };
    let shown = null;
    const container = { replaceChildren: (child) => { shown = child; } };
    const adapter = new LcicEmbedAdapter(doc, () => 1);
    const events = recorded(adapter);
    adapter.mount(container);
    await expect(adapter.join({ embedUrl: "https://evil.example/latest/class.html?classid=1" })).rejects.toThrow(/Not a Tencent LCIC/);
    await adapter.join({ embedUrl: "https://www.tencentclass.com/latest/class.html?classid=345678&userid=u&token=t" });
    expect(shown).toMatchObject({ tag: "iframe", allow: LCIC_FRAME_PERMISSIONS, referrerPolicy: "no-referrer", src: "https://www.tencentclass.com/latest/class.html?classid=345678&userid=u&token=t" });
    expect(adapter.capabilities.observable).toBe(false);
    expect(await adapter.setDevice("camera", true)).toBe("unavailable");
    await adapter.leave();
    expect(created[0].removed).toBe(true);
    expect(events.map(event => event.state)).toEqual(["connecting", "disconnected"]);
  });
});

describe("device limits", () => {
  test.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", 5, "phone"],
    ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", 5, "tablet"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15", 5, "tablet"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15", 0, "desktop"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36", 5, "phone"],
    ["Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", 5, "tablet"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", 0, "desktop"],
  ])("%s → %s", (agent, touch, device) => {
    expect(classroomDeviceOf(agent, touch)).toBe(device);
  });

  test("Zoom on a phone: whiteboard view-only and no screen sharing; LCIC on a phone: unconfirmed; the stand-in is simulated", () => {
    const zoomPhone = Object.fromEntries(deviceLimits("zoom-video-sdk", "phone").map(limit => [limit.name, limit.level]));
    expect(zoomPhone).toMatchObject({ whiteboard: "limited", screenShare: "limited", documents: "limited" });
    expect(zoomPhone.video).toBeUndefined();
    const lcicPhone = Object.fromEntries(deviceLimits("tencent-lcic", "phone").map(limit => [limit.name, limit.level]));
    expect(lcicPhone).toMatchObject({ whiteboard: "unknown", documents: "unknown", screenShare: "none", recording: "limited" });
    expect(deviceLimits("tencent-lcic", "desktop").map(limit => limit.name)).toEqual(["fileTransfer", "recording"]);
    expect(Object.values(CLASSROOM_CAPABILITIES.synthetic).every(row => Object.values(row).every(cell => cell.level === "simulated"))).toBe(true);
  });
});
