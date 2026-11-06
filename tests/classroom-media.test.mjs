import { describe, expect, test, vi } from "vitest";

import {
  createMediaAdapter, hostReportFor, MEDIA_PROVIDERS, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
} from "../lib/classroom-media";
import { rejoinRoom, requestJoin } from "../lib/classroom-join-client";

// The browser side of the classroom's video provider, with the synthetic stand-in only. Passing
// shows the page gets the states a video SDK reports, and the tutor's reports follow from them.
// It says nothing about any real SDK: no camera, microphone or network is touched.

const joinInput = { sessionToken: "synthetic-token", lessonCode: "TEST-M1", participantCode: "TEST-MT1", role: "tutor" };

function recorded(adapter) {
  const events = [];
  adapter.subscribe(event => events.push(event));
  return events;
}

describe("the provider-neutral media adapter", () => {
  test("the synthetic stand-in never claims real media; the two candidates have adapters; others are unknown", () => {
    expect(MEDIA_PROVIDERS).toEqual(["synthetic", "zoom-video-sdk", "tencent-lcic"]);
    const synthetic = createMediaAdapter("synthetic", { connectDelayMs: 0 });
    expect(synthetic).toBeInstanceOf(SyntheticMediaAdapter);
    expect(synthetic.capabilities).toEqual({ realMedia: false, screenShare: false, whiteboard: false, observable: true });
    expect(createMediaAdapter("zoom-video-sdk").provider).toBe("zoom-video-sdk");
    expect(createMediaAdapter("tencent-lcic").provider).toBe("tencent-lcic");
    for (const provider of ["tencent-rtc", "agora", ""]) expect(() => createMediaAdapter(provider)).toThrow(MediaAdapterUnavailableError);
    expect(() => createMediaAdapter("")).toThrow(/Unknown video provider/);
  });

  test("joining goes connecting → connected, needs the session token, and leaving reports disconnected", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0, now: () => 1 });
    const events = recorded(adapter);
    await expect(adapter.join({ ...joinInput, sessionToken: "" })).rejects.toThrow(/session token/);
    await adapter.join(joinInput);
    await adapter.join(joinInput);
    await adapter.leave();
    await adapter.leave();
    expect(events.map(event => event.state)).toEqual(["connecting", "connected", "disconnected"]);
  });

  test("leaving while still connecting never ends up connected", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 20 });
    const events = recorded(adapter);
    const joining = adapter.join(joinInput);
    await adapter.leave();
    await joining;
    expect(events.map(event => event.state)).toEqual(["connecting", "disconnected"]);
    expect(adapter.state.connection).toBe("disconnected");
  });

  test("camera and microphone switch on and off; a blocked device stays blocked until it comes back", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    await adapter.join(joinInput);
    expect(await adapter.setDevice("camera", true)).toBe("on");
    expect(await adapter.setDevice("microphone", true)).toBe("on");
    expect(await adapter.setDevice("microphone", false)).toBe("off");
    adapter.simulate("camera-denied");
    adapter.simulate("microphone-unavailable");
    expect(await adapter.setDevice("camera", true)).toBe("denied");
    expect(await adapter.setDevice("microphone", true)).toBe("unavailable");
    adapter.simulate("devices-restored");
    expect(adapter.state.devices).toEqual({ camera: "off", microphone: "off" });
    expect(await adapter.setDevice("camera", true)).toBe("on");
  });

  test("the other person, the network and a failed connection are simulated in a sensible order", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const events = recorded(adapter);
    adapter.simulate("remote-joins");
    adapter.simulate("network-drop");
    expect(events).toEqual([]);
    await adapter.join(joinInput);
    adapter.simulate("remote-joins");
    adapter.simulate("remote-camera-off");
    adapter.simulate("network-drop");
    adapter.simulate("network-restore");
    adapter.simulate("connection-failed");
    expect(events.map(event => (event.type === "connection" ? event.state : `remote:${event.present}:${event.camera}`))).toEqual([
      "connecting", "connected", "remote:true:true", "remote:true:false", "reconnecting", "connected", "remote:false:false", "failed",
    ]);
    await adapter.join(joinInput);
    expect(adapter.state.connection).toBe("connected");
    for (const scenario of SYNTHETIC_SCENARIOS) expect(() => adapter.simulate(scenario)).not.toThrow();
  });

  test("the tutor reports connection changes in the existing report vocabulary, and joins only with a user key", () => {
    const at = 1;
    expect(hostReportFor({ type: "connection", state: "connected", at })).toEqual({ type: "connection", state: "Connected" });
    expect(hostReportFor({ type: "connection", state: "reconnecting", at })).toEqual({ type: "connection", state: "Reconnecting" });
    expect(hostReportFor({ type: "connection", state: "disconnected", at })).toEqual({ type: "connection", state: "Closed" });
    expect(hostReportFor({ type: "connection", state: "failed", at })).toEqual({ type: "connection", state: "Fail" });
    expect(hostReportFor({ type: "connection", state: "connecting", at })).toBeNull();
    expect(hostReportFor({ type: "device", kind: "camera", state: "on", at })).toBeNull();
    // The synthetic room has no real other person, so it never invents a join.
    expect(hostReportFor({ type: "remote", present: true, camera: true, microphone: true, userKey: null, at })).toBeNull();
    expect(hostReportFor({ type: "remote", present: true, camera: true, microphone: true, userKey: "P-1", at })).toEqual({ type: "user_added", userKey: "P-1" });
    expect(hostReportFor({ type: "remote", present: false, camera: false, microphone: false, userKey: "P-1", at })).toEqual({ type: "user_removed", userKey: "P-1" });
  });

  test("the synthetic adapter never touches the network or the browser's devices", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
    try {
      const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
      await adapter.join(joinInput);
      await adapter.setDevice("camera", true);
      for (const scenario of SYNTHETIC_SCENARIOS) adapter.simulate(scenario);
      await adapter.leave();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(globalThis.navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// R-1 (2026-11-06): the room used to reconnect with the session token it got on entry, which Zoom
// accepts for 30 minutes while a lesson lasts up to 4 hours. Reconnecting now asks the protected
// join check again and joins with the new token only.
describe("reconnecting asks the join check again", () => {
  const room = { lessonCode: "TEST-M1", participantCode: "TEST-MT1", role: "tutor" };
  const answer = (token, extra = {}) => ({
    ok: true, provider: "zoom-video-sdk", lesson: { code: "TEST-M1", startsAt: "2026-11-06T09:00:00.000Z", endsAt: "2026-11-06T10:00:00.000Z" },
    role: "tutor", participantCode: "TEST-MT1",
    session: { kind: "sdk", token, sessionName: "ihear-l-test-m1", expiresAt: "2026-11-06T10:30:00.000Z" }, ...extra,
  });
  const roomAdapter = ({ fails = 0 } = {}) => {
    const joins = [];
    let failures = fails;
    return { joins, adapter: { join: async (input) => { joins.push(input); if (failures > 0) { failures -= 1; throw new Error("could not connect"); } } } };
  };
  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  test("RC-3: the join check is asked first and the room joins with its new token and topic", async () => {
    const { joins, adapter } = roomAdapter();
    const ask = vi.fn(async () => answer("fresh.jwt.token"));
    const result = await rejoinRoom(adapter, ask, room);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(joins).toEqual([{ sessionToken: "fresh.jwt.token", sessionName: "ihear-l-test-m1", embedUrl: undefined, ...room }]);
    expect(result).toEqual({ ok: true, session: answer("fresh.jwt.token").session });
  });

  test("RC-3: an answer without a token is not joined; there is no older token to fall back on", async () => {
    const { joins, adapter } = roomAdapter();
    const missing = answer("", {});
    expect(await rejoinRoom(adapter, async () => missing, room)).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await rejoinRoom(adapter, async () => ({ ...missing, session: null }), room)).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(joins).toEqual([]);
  });

  test("RC-3: two presses at once ask once and join once; the next press asks again", async () => {
    const { joins, adapter } = roomAdapter();
    const ask = vi.fn(async () => answer("fresh.jwt.token"));
    const [first, second] = await Promise.all([rejoinRoom(adapter, ask, room), rejoinRoom(adapter, ask, room)]);
    expect([ask.mock.calls.length, joins.length, first, second]).toEqual([1, 1, first, first]);
    await rejoinRoom(adapter, ask, room);
    expect([ask.mock.calls.length, joins.length]).toEqual([2, 2]);
  });

  test("RC-3: if the check now names another person or role, the room is not rejoined in their place", async () => {
    const { joins, adapter } = roomAdapter();
    expect(await rejoinRoom(adapter, async () => answer("t", { role: "student" }), room)).toEqual({ ok: false, code: "IDENTITY_UNVERIFIED" });
    expect(await rejoinRoom(adapter, async () => answer("t", { participantCode: "TEST-OTHER" }), room)).toEqual({ ok: false, code: "IDENTITY_UNVERIFIED" });
    expect(joins).toEqual([]);
  });

  test("RC-4: refusals keep their code and nothing joins: time window, cancelled, signed out, too many tries, closed, unreachable", async () => {
    const cases = [
      [response(403, { code: "OUTSIDE_JOIN_WINDOW" }), null, "OUTSIDE_JOIN_WINDOW"],
      [response(403, { code: "LESSON_CANCELLED" }), null, "LESSON_CANCELLED"],
      // A tutor whose sign-in has ended is no longer on the roster; the page offers to sign in.
      [response(403, { code: "NOT_ON_ROSTER" }), null, "NOT_ON_ROSTER"],
      [response(403, { code: "NOT_ON_ROSTER" }), "student-key", "NOT_ON_ROSTER_LINK"],
      [response(429, { error: "Too many requests" }), null, "RATE_LIMITED"],
      [response(503, { code: "PROVIDER_UNAVAILABLE" }), null, "PROVIDER_UNAVAILABLE"],
      [{ ok: true, status: 200, json: async () => { throw new SyntaxError("not JSON"); } }, null, "UNAVAILABLE"],
      [new Error("offline"), null, "UNAVAILABLE"],
    ];
    for (const [reply, key, code] of cases) {
      const { joins, adapter } = roomAdapter();
      const fetcher = vi.fn(async () => { if (reply instanceof Error) throw reply; return reply; });
      expect(await rejoinRoom(adapter, () => requestJoin("L-TEST", key, fetcher), room)).toEqual({ ok: false, code });
      expect(joins).toEqual([]);
    }
  });

  test("RC-4: the check is the same protected request as entering: POST, the personal key only, nothing the server decides", async () => {
    const fetcher = vi.fn(async () => response(200, answer("fresh.jwt.token")));
    await requestJoin("L-TEST 1", "student-key", fetcher);
    await requestJoin("L-TEST", null, fetcher);
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method, init.headers, init.body])).toEqual([
      ["/api/classroom/L-TEST%201/join", "POST", { "Content-Type": "application/json" }, JSON.stringify({ key: "student-key" })],
      ["/api/classroom/L-TEST/join", "POST", { "Content-Type": "application/json" }, "{}"],
    ]);
    expect(await requestJoin("L-TEST", null, fetcher)).toEqual(answer("fresh.jwt.token"));
  });

  test("RC-4: a good answer that then fails to connect says so, and the next press asks for a new token again", async () => {
    const { joins, adapter } = roomAdapter({ fails: 1 });
    const ask = vi.fn(async () => answer(`token-${ask.mock.calls.length}`));
    expect(await rejoinRoom(adapter, ask, room)).toEqual({ ok: false, code: "CONNECT_FAILED" });
    expect((await rejoinRoom(adapter, ask, room)).ok).toBe(true);
    expect(joins.map(join => join.sessionToken)).toEqual(["token-1", "token-2"]);
  });
});
