import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CLASSROOM_CAPABILITIES, classroomDeviceOf, deviceLimits } from "../lib/classroom-capabilities";
import { LcicEmbedAdapter, LCIC_FRAME_PERMISSIONS, MediaAdapterUnavailableError, ZoomVideoSdkMediaAdapter } from "../lib/classroom-media";
import { ClassroomProviderUnavailableError, classroomProvider } from "../lib/classroom-provider";
import { isTestLesson, LcicApiError, lcicStatusOf, memoryRoomRegistry, tc3Sign, tencentLcicConfig, tencentLcicProvider, verifyLcicCallback } from "../lib/classroom-vendors/tencent-lcic";
import { zoomApiToken, zoomVideoSdkConfig, zoomVideoSdkProvider } from "../lib/classroom-vendors/zoom-video-sdk";

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
  const provider = (answer = () => ({ status: 202, body: "" }), sessionId = "sess-TEST-1") => {
    const fake = fakeTransport(answer);
    return { ...fake, provider: zoomVideoSdkProvider(config, { transport: fake.transport, sessionIdOf: async () => sessionId, now: () => NOW }) };
  };

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
    expect(await none.provider.removeUser(lesson, student.id)).toEqual({ ok: false, httpStatus: 501 });
    expect(await none.provider.deleteRecording({ providerFileId: "f-1" })).toEqual({ ok: false, httpStatus: 501 });
    expect(none.requests).toEqual([]);
  });

  test("a recording range is downloaded from the address listed for the file, with a Range header", async () => {
    const { provider: zoom, requests } = provider((request) => request.url.endsWith("/recordings")
      ? { status: 200, body: JSON.stringify({ recording_files: [{ id: "f-video", download_url: "https://zoom.example.invalid/rec/f-video" }] }) }
      : { status: 206, body: "", bytes: Buffer.alloc(16, 7) });
    const bytes = await zoom.download({ providerFileId: "f-video", lessonId: lesson.id, status: "PENDING" }, { start: 16, end: 32 });
    expect(bytes.length).toBe(16);
    expect(requests[1]).toMatchObject({ method: "GET", url: "https://zoom.example.invalid/rec/f-video", headers: { Range: "bytes=16-31" } });
    const insecure = provider((request) => request.url.endsWith("/recordings") ? { status: 200, body: JSON.stringify({ recording_files: [{ id: "f-video", download_url: "http://plain.example.invalid/f" }] }) } : { status: 206, body: "" });
    await expect(insecure.provider.download({ providerFileId: "f-video", lessonId: lesson.id, status: "PENDING" }, { start: 0, end: 16 })).rejects.toThrow(/not available/);
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
  const lcic = ({ allowed = false, verified = false, answer } = {}) => {
    let created = 0;
    const standard = request => {
      const action = request.headers["X-TC-Action"];
      const response = action === "CreateRoom" ? { RoomId: 345678 + created++, RequestId: "r" } : answers[action](request.body);
      return { status: 200, body: JSON.stringify({ Response: response }) };
    };
    const fake = fakeTransport(answer ? request => answer(request, standard) : standard);
    const rooms = memoryRoomRegistry();
    const recordingAllowed = async () => (typeof allowed === "function" ? allowed() : allowed);
    return { ...fake, rooms, provider: tencentLcicProvider(config, { transport: fake.transport, rooms, recordingAllowed, midClassStopVerified: verified, now: () => NOW }) };
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

  test("deleting a recording deletes the room's files (DeleteRecord); another vendor's file id is not sent", async () => {
    const { provider, requests } = lcic();
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
  // A small stand-in for the page: elements remember their class, children and whether hidden.
  function fakeDom() {
    const doc = {
      createElement(tag) {
        const element = {
          tag, className: "", hidden: false, children: [], nodeType: 1, ownerDocument: doc,
          append(...nodes) { element.children.push(...nodes); },
          replaceChildren(...nodes) { element.children = [...nodes]; },
          remove() { element.removed = true; },
        };
        return element;
      },
    };
    return { doc, root: doc.createElement("div") };
  }
  function fakeZoom({ joinError = null, videoError = null, shareError = null, canBoard = true, sharingAtJoin = 0 } = {}) {
    const calls = [];
    const handlers = new Map();
    const users = [{ userId: 1, userIdentity: "P-TEST-T01" }];
    const stream = {
      startAudio: async () => calls.push("startAudio"), muteAudio: async () => calls.push("muteAudio"), unmuteAudio: async () => calls.push("unmuteAudio"),
      startVideo: async () => { calls.push("startVideo"); if (videoError) throw videoError; }, stopVideo: async () => calls.push("stopVideo"),
      attachVideo: async (userId) => { calls.push(`attach:${userId}`); return { nodeType: 1, tag: `video:${userId}` }; }, detachVideo: async (userId) => calls.push(`detach:${userId}`),
      isStartShareScreenWithVideoElement: () => true,
      startShareScreen: async (target) => { calls.push(`share:${target.tag}`); if (shareError) throw shareError; },
      stopShareScreen: async () => calls.push("stopShare"),
      getActiveShareUserId: () => sharingAtJoin,
      attachShareView: async (userId) => { calls.push(`shareView:${userId}`); return { nodeType: 1, tag: `shared:${userId}` }; },
      detachShareView: async (userId) => calls.push(`shareViewOff:${userId}`),
    };
    const whiteboard = {
      isWhiteboardEnabled: () => true, canStartWhiteboard: () => canBoard,
      startWhiteboardScreen: async (element) => calls.push(`board:${element.className}`), stopWhiteboardScreen: async () => calls.push("boardOff"),
      startWhiteboardView: async (element, userId) => calls.push(`boardView:${userId}`), stopWhiteboardView: async () => calls.push("boardViewOff"),
      exportWhiteboard: async (format, name) => calls.push(`export:${format}:${name}`),
    };
    const client = {
      init: async (...args) => calls.push(["init", ...args.slice(0, 2)].join(":")),
      join: async (...args) => { calls.push(["join", ...args].join(":")); if (joinError) throw joinError; },
      leave: async () => calls.push("leave"), getMediaStream: () => stream, getWhiteboardClient: () => whiteboard,
      getCurrentUserInfo: () => ({ userId: 1 }), getAllUser: () => users,
      on: (name, handler) => handlers.set(name, handler), off: (name) => { calls.push(`off:${name}`); handlers.delete(name); },
    };
    const sdk = {
      VERSION: "2.6.0", createClient: () => client,
      checkSystemRequirements: () => ({ audio: true, video: true, screen: false }), checkFeatureRequirements: () => ({ unSupportFeatures: ["screenShare"] }),
    };
    return { calls, handlers, users, sdk };
  }
  const zoomJoin = { sessionToken: "synthetic.jwt.token", sessionName: "ihear-l-test-v01", lessonCode: "TEST-V01", participantCode: "TEST-T01", role: "tutor" };
  // Zoom calls its handlers without waiting; let their asynchronous work finish.
  const settle = () => new Promise(resolve => { setTimeout(resolve, 0); });
  const recorded = adapter => { const events = []; adapter.subscribe(event => events.push(event)); return events; };
  const joined = async (options) => {
    const zoom = fakeZoom(options), dom = fakeDom();
    const adapter = new ZoomVideoSdkMediaAdapter(async () => zoom.sdk, () => 1);
    const events = recorded(adapter);
    adapter.mount(dom.root);
    await adapter.join(zoomJoin);
    const [share, whiteboard, videos, ownShare] = dom.root.children;
    return { zoom, adapter, events, share, whiteboard, videos, ownShare };
  };

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
    expect(videos.children.map(child => child.tag)).toEqual(["video:1"]);
  });

  test("Zoom: videos and a shared screen go into separate <video-player-container>s, as Zoom requires", async () => {
    const { share, whiteboard, videos, ownShare } = await joined();
    expect([share.tag, whiteboard.tag, videos.tag, ownShare.tag]).toEqual(["video-player-container", "div", "video-player-container", "div"]);
    expect([share.className, whiteboard.className, videos.className, ownShare.className]).toEqual(["classroom-zoom-share", "classroom-zoom-whiteboard", "classroom-zoom-videos", "classroom-zoom-own-share"]);
    expect([share.hidden, whiteboard.hidden, videos.hidden, ownShare.hidden]).toEqual([true, true, false, true]);
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

  test("Zoom: leaving ends the share and the whiteboard on this page too", async () => {
    const { adapter, events, share, whiteboard } = await joined({ sharingAtJoin: 2 });
    await adapter.setWhiteboard(true);
    await adapter.leave();
    expect(events.slice(-3).map(event => [event.type, event.state])).toEqual([["share", "none"], ["whiteboard", "none"], ["connection", "disconnected"]]);
    expect([share.hidden, whiteboard.hidden, share.children]).toEqual([true, true, []]);
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
