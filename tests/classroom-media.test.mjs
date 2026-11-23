import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";

import {
  createMediaAdapter, FIXED_ROOM_SCENARIOS, hostReportFor, MEDIA_PROVIDERS, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
} from "../lib/classroom-media";
import { entryEndedBy, reasonShown, rejoinRoom, requestJoin } from "../lib/classroom-join-client";
import { roomCopy as copy } from "../app/classroom/[lessonId]/classroom-copy";

// The browser side of the classroom's video provider, with the synthetic stand-in only. Passing
// shows the page gets the states a video SDK reports, and the tutor's reports follow from them.
// It says nothing about any real SDK: no camera, microphone or network is touched.

const joinInput = { sessionToken: "synthetic-token", lessonCode: "TEST-M1", participantCode: "TEST-MT1", role: "tutor" };

function recorded(adapter) {
  const events = [];
  adapter.subscribe(event => events.push(event));
  return events;
}
// The connection's own events, without the people, devices and the rest told alongside.
const connectionsOf = events => events.filter(event => event.type === "connection").map(event => event.state);

// Classroom 2.0: a small stand-in for the page, enough for the tiles the adapter draws.
function fakeDom() {
  const doc = {
    createElement(tag) {
      const element = {
        tag, className: "", hidden: false, children: [], attributes: {}, nodeType: 1, ownerDocument: doc, parentNode: null,
        append(...nodes) { for (const node of nodes) { node.parentNode = element; element.children.push(node); } },
        replaceChildren(...nodes) { for (const child of element.children) child.parentNode = null; element.children = []; element.append(...nodes); },
        remove() { if (element.parentNode) element.parentNode.children = element.parentNode.children.filter(child => child !== element); element.parentNode = null; },
        setAttribute(name, value) { element.attributes[name] = String(value); },
      };
      return element;
    },
  };
  return { doc, root: doc.createElement("div"), column: doc.createElement("div") };
}

describe("the provider-neutral media adapter", () => {
  test("the synthetic stand-in never claims real media; the two candidates have adapters; others are unknown", () => {
    expect(MEDIA_PROVIDERS).toEqual(["synthetic", "zoom-video-sdk", "tencent-lcic"]);
    const synthetic = createMediaAdapter("synthetic", { connectDelayMs: 0 });
    expect(synthetic).toBeInstanceOf(SyntheticMediaAdapter);
    // Sharing and the whiteboard are played as states only (Classroom 2.0): still no real media.
    expect(synthetic.capabilities).toEqual({ realMedia: false, screenShare: true, whiteboard: true, observable: true, chat: true, raiseHand: true });
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
    expect(connectionsOf(events)).toEqual(["connecting", "connected", "disconnected"]);
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
    expect(events.filter(event => event.type === "connection" || event.type === "remote").map(event => (event.type === "connection" ? event.state : `remote:${event.present}:${event.camera}`))).toEqual([
      "connecting", "connected", "remote:true:true", "remote:true:false", "reconnecting", "connected", "remote:false:false", "failed",
    ]);
    await adapter.join(joinInput);
    expect(adapter.state.connection).toBe("connected");
    for (const scenario of SYNTHETIC_SCENARIOS) expect(() => adapter.simulate(scenario)).not.toThrow();
  });

  // 2026-11-20: as Zoom's adapter does (its client is released and a new one joins), joining again
  // after a failure starts with the camera and microphone off, so the page can offer them again.
  test("RJ-4: joining again after a failure starts with both devices off and says so first; Zoom's own reconnect keeps them; a blocked device stays blocked", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const events = recorded(adapter);
    const told = () => events.filter(event => event.type === "connection" || event.type === "device").map(event => (event.type === "connection" ? event.state : `${event.kind}:${event.state}`));
    await adapter.join(joinInput);
    await adapter.setDevice("camera", true);
    await adapter.setDevice("microphone", true);
    adapter.simulate("network-drop");
    adapter.simulate("network-restore");
    expect(adapter.state.devices).toEqual({ camera: "on", microphone: "on" });
    adapter.simulate("connection-failed");
    events.length = 0;
    await adapter.join(joinInput);
    expect(told()).toEqual(["camera:off", "microphone:off", "connecting", "connected"]);
    expect(adapter.state.devices).toEqual({ camera: "off", microphone: "off" });
    // A device the browser blocks stays blocked through joining again.
    adapter.simulate("camera-denied");
    await adapter.setDevice("microphone", true);
    adapter.simulate("connection-failed");
    await adapter.join(joinInput);
    expect(adapter.state.devices).toEqual({ camera: "denied", microphone: "off" });
  });

  // 2026-11-20: hearing the room in the test classroom, as the page needs it: "Turn on sound" or the
  // microphone joins the sound; a blocked microphone or blocked playback fails it; every new join
  // (after a failure, after leaving) starts silent; Zoom's own short reconnect keeps it.
  test("SB-9: the synthetic sound: joined by Turn on sound or the microphone, failed when blocked, silent again after a failure or leaving", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const events = recorded(adapter);
    const sounds = () => events.filter(event => event.type === "sound").map(event => (event.problem ? `${event.state}:${event.problem}` : event.state));
    expect(await adapter.joinSound()).toBe(false);
    await adapter.join(joinInput);
    expect(await adapter.joinSound()).toBe(true);
    expect(adapter.state.devices.microphone).toBe("off");
    adapter.simulate("network-drop");
    adapter.simulate("network-restore");
    adapter.simulate("connection-failed");
    await adapter.join(joinInput);
    expect(sounds()).toEqual(["on", "off"]);
    // The microphone brings the sound as well.
    await adapter.setDevice("microphone", true);
    expect(sounds().at(-1)).toBe("on");
    await adapter.leave();
    expect(sounds().at(-1)).toBe("off");
    // Blocked playback, then a blocked microphone (Zoom's muted join needs it), then both restored.
    await adapter.join(joinInput);
    adapter.simulate("sound-blocked");
    expect(await adapter.joinSound()).toBe(false);
    adapter.simulate("devices-restored");
    adapter.simulate("microphone-unavailable");
    expect(await adapter.joinSound()).toBe(false);
    adapter.simulate("devices-restored");
    expect(await adapter.joinSound()).toBe(true);
    expect(sounds().slice(-3)).toEqual(["failed:autoplay", "failed:capture", "on"]);
  });

  test("the tutor reports connection changes in the existing report vocabulary, and joins only with a user key", () => {
    const at = 1;
    expect(hostReportFor({ type: "connection", state: "connected", at })).toEqual({ type: "connection", state: "Connected" });
    expect(hostReportFor({ type: "connection", state: "reconnecting", at })).toEqual({ type: "connection", state: "Reconnecting" });
    expect(hostReportFor({ type: "connection", state: "disconnected", at })).toEqual({ type: "connection", state: "Closed" });
    expect(hostReportFor({ type: "connection", state: "failed", at })).toEqual({ type: "connection", state: "Fail" });
    expect(hostReportFor({ type: "connection", state: "connecting", at })).toBeNull();
    expect(hostReportFor({ type: "device", kind: "camera", state: "on", at })).toBeNull();
    // The vendor's session id, as is; the page sends it only when its join answer asked for it.
    expect(hostReportFor({ type: "session", sessionId: "oiFKKKL/RyGdm9W1r1Ll6w==", at })).toEqual({ type: "session", sessionId: "oiFKKKL/RyGdm9W1r1Ll6w==" });
    // The synthetic room has no real other person, so it never invents a join.
    expect(hostReportFor({ type: "remote", present: true, camera: true, microphone: true, userKey: null, at })).toBeNull();
    expect(hostReportFor({ type: "remote", present: true, camera: true, microphone: true, userKey: "P-1", at })).toEqual({ type: "user_added", userKey: "P-1" });
    expect(hostReportFor({ type: "remote", present: false, camera: false, microphone: false, userKey: "P-1", at })).toEqual({ type: "user_removed", userKey: "P-1" });
    // "Turn on sound" is never reported.
    expect(hostReportFor({ type: "sound", state: "on", at })).toBeNull();
  });

  // 2026-11-12: chat and raised hands. Nothing is saved, and none of it is reported to iHear.
  test("chat and raised hands in the synthetic room stay on this page: a tutor raises no hand, only a tutor lowers one, leaving clears them", async () => {
    const student = new SyntheticMediaAdapter({ connectDelayMs: 0, now: () => 5 });
    const events = recorded(student);
    expect(await student.sendChat("before joining")).toBe(false);
    await student.join({ ...joinInput, role: "student", participantCode: "TEST-MS1" });
    expect(await student.sendChat("   ")).toBe(false);
    expect(await student.sendChat("  TEST: hello\u0000 ")).toBe(true);
    student.simulate("remote-chat");
    expect(events.filter(event => event.type === "chat").map(event => event.line)).toEqual([
      { id: "synthetic-1", from: "self", name: "", text: "TEST: hello", at: 5 },
      { id: "synthetic-2", from: "tutor", name: "", text: expect.stringContaining("TEST"), at: 5 },
    ]);
    expect(await student.setHand(true)).toBe(true);
    expect(events.filter(event => event.type === "hands").at(-1).raised).toEqual([{ id: "self", name: "", self: true }]);
    expect(await student.lowerHand("self")).toBe(false);
    await student.leave();
    expect(events.filter(event => event.type === "hands").at(-1).raised).toEqual([]);
    for (const event of events.filter(item => item.type === "chat" || item.type === "hands")) expect(hostReportFor(event)).toBeNull();

    const tutor = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const tutorEvents = recorded(tutor);
    await tutor.join(joinInput);
    expect(await tutor.setHand(true)).toBe(false);
    tutor.simulate("remote-raises-hand");
    expect(tutorEvents.filter(event => event.type === "hands").at(-1).raised).toEqual([{ id: "remote", name: "", self: false }]);
    expect(await tutor.lowerHand("remote")).toBe(true);
    expect(tutorEvents.filter(event => event.type === "hands").at(-1).raised).toEqual([]);
    tutor.simulate("remote-chat");
    expect(tutorEvents.filter(event => event.type === "chat").at(-1).line.from).toBe("student");
  });

  // Classroom 2.0 (2026-11-12): who is in the test room, their tiles, the played share and
  // whiteboard, a group of test students and a voice. None of it is reported to iHear.
  test("2.0: the test room tells the page who is here (its own code, the other person, a group of test students)", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0, now: () => 7 });
    const events = recorded(adapter);
    const peopleOf = () => events.filter(event => event.type === "people").at(-1)?.people ?? [];
    await adapter.join({ ...joinInput, role: "student", participantCode: "TEST-MS1" });
    expect(peopleOf()).toEqual([{ id: "self", name: "TEST-MS1", host: false, self: true, camera: false, microphone: false, video: "off" }]);
    adapter.simulate("remote-joins");
    await adapter.setDevice("camera", true);
    expect(peopleOf()).toEqual([
      { id: "remote", name: "", host: true, self: false, camera: true, microphone: true, video: "shown" },
      { id: "self", name: "TEST-MS1", host: false, self: true, camera: true, microphone: false, video: "shown" },
    ]);
    adapter.simulate("group-joins");
    expect(peopleOf().map(person => person.id)).toEqual(["remote", "TEST-S02", "TEST-S03", "TEST-S04", "TEST-S05", "TEST-S06", "self"]);
    expect(peopleOf().filter(person => !person.camera).map(person => person.name)).toEqual(["TEST-S04"]);
    expect(events.filter(event => event.type === "remote").at(-1)).toMatchObject({ present: true, others: 6 });
    adapter.simulate("group-leaves");
    expect(peopleOf()).toHaveLength(2);
    expect(events.filter(event => event.type === "remote").at(-1).others).toBeUndefined();
    await adapter.leave();
    expect(peopleOf()).toEqual([]);
    for (const event of events.filter(item => item.type === "people" || item.type === "speaking")) expect(hostReportFor(event)).toBeNull();
  });

  test("2.0: given a column, the test room draws one tile per person (no picture), marked self or host, and takes them away as people leave", async () => {
    const dom = fakeDom();
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    adapter.mount(dom.root, dom.column);
    expect(dom.root.children).toEqual([]);
    const [container] = dom.column.children;
    expect(container.className).toBe("classroom-media-videos synthetic");
    await adapter.join(joinInput);
    adapter.simulate("remote-joins");
    const tiles = () => container.children.map(cell => [cell.attributes["data-person"], cell.className, cell.attributes["data-host"], cell.attributes["data-video"]]);
    expect(tiles()).toEqual([["self", "classroom-media-tile self", "true", "off"], ["remote", "classroom-media-tile remote", "false", "shown"]]);
    adapter.simulate("remote-camera-off");
    expect(tiles()[1][3]).toBe("off");
    adapter.simulate("remote-leaves");
    expect(tiles().map(([id]) => id)).toEqual(["self"]);
    await adapter.leave();
    expect(container.children).toEqual([]);
    // Without a column nothing is drawn, as before 2.0.
    const lone = fakeDom();
    new SyntheticMediaAdapter({ connectDelayMs: 0 }).mount(lone.root);
    expect([lone.root.children, lone.column.children]).toEqual([[], []]);
  });

  test("2.0: the tutor's share and whiteboard, and the other side's, are played as states only; a failure or leaving ends them", async () => {
    const shown = events => events.filter(event => event.type === "share" || event.type === "whiteboard").map(event => `${event.type}:${event.state}`);
    const tutor = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const tutorEvents = recorded(tutor);
    expect(await tutor.setScreenShare(true)).toBe(false);
    await tutor.join(joinInput);
    expect(await tutor.setScreenShare(true)).toBe(true);
    expect(await tutor.setWhiteboard(true)).toBe(true);
    expect(await tutor.setScreenShare(false)).toBe(false);
    tutor.simulate("connection-failed");
    expect(shown(tutorEvents)).toEqual(["share:sending", "whiteboard:presenting", "share:none", "whiteboard:none"]);
    const student = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const studentEvents = recorded(student);
    await student.join({ ...joinInput, role: "student", participantCode: "TEST-MS1" });
    expect(await student.setWhiteboard(true)).toBe(false);
    student.simulate("remote-shares-screen");
    student.simulate("remote-opens-whiteboard");
    student.simulate("remote-closes-whiteboard");
    student.simulate("remote-opens-whiteboard");
    await student.leave();
    expect(shown(studentEvents)).toEqual(["share:receiving", "whiteboard:viewing", "whiteboard:none", "whiteboard:viewing", "share:none", "whiteboard:none"]);
  });

  test("2.0: a voice rings the other person's tile for a moment, and only while they are in the room", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0, speakingMs: 100 });
      const events = recorded(adapter);
      const rings = () => events.filter(event => event.type === "speaking").map(event => event.ids);
      await adapter.join(joinInput);
      adapter.simulate("remote-speaks");
      expect(rings()).toEqual([]);
      adapter.simulate("remote-joins");
      adapter.simulate("remote-speaks");
      expect(rings()).toEqual([["remote"]]);
      vi.advanceTimersByTime(100);
      expect(rings()).toEqual([["remote"], []]);
      adapter.simulate("remote-speaks");
      adapter.simulate("remote-leaves");
      expect(rings()).toEqual([["remote"], [], ["remote"], []]);
    } finally {
      vi.useRealTimers();
    }
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

  test("D-14: a fixed room's reconnect joins again as a fixed room, with the same teaching tools as on entering", async () => {
    const { joins, adapter } = roomAdapter();
    expect((await rejoinRoom(adapter, async () => answer("fresh.jwt.token"), { ...room, equalTools: true })).ok).toBe(true);
    expect(joins).toEqual([{ sessionToken: "fresh.jwt.token", sessionName: "ihear-l-test-m1", embedUrl: undefined, ...room, equalTools: true }]);
  });
});

// D-14 (2026-11-21): a fixed room has no host, and everyone in it gets the same teaching tools as
// far as Zoom allows an ordinary participant. The test classroom plays Zoom's answers; which of them
// real Zoom gives without a host is still to be seen in a real session.
describe("D-14: a fixed room's teaching tools in the test classroom", () => {
  const roomJoin = { ...joinInput, role: "student", participantCode: "TEST-MS1", equalTools: true };
  const toolsOf = events => events.filter(event => event.type === "tools").map(({ share, whiteboard }) => ({ share, whiteboard }));
  const boardOf = events => events.filter(event => event.type === "whiteboard").at(-1)?.state ?? "none";

  test("everyone may share, one at a time; the whiteboard opens only with Zoom's yes and never over someone else's; one's own board can always be closed; leaving makes it unknown again", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const events = recorded(adapter);
    await adapter.join(roomJoin);
    expect(toolsOf(events)).toEqual([{ share: true, whiteboard: false }]);
    expect(await adapter.setWhiteboard(true)).toBe(false);
    // Someone else shares: nobody takes it over; it ends, and this person shares.
    adapter.simulate("remote-shares-screen");
    expect(toolsOf(events).at(-1)).toEqual({ share: false, whiteboard: false });
    expect(await adapter.setScreenShare(true)).toBe(false);
    adapter.simulate("remote-stops-sharing");
    expect(toolsOf(events).at(-1)).toEqual({ share: true, whiteboard: false });
    expect(await adapter.setScreenShare(true)).toBe(true);
    expect(toolsOf(events).at(-1)).toEqual({ share: true, whiteboard: false });
    expect(await adapter.setScreenShare(false)).toBe(false);
    // Zoom says yes to everyone: the whiteboard opens, but not over someone else's.
    adapter.simulate("board-for-everyone");
    expect(toolsOf(events).at(-1)).toEqual({ share: true, whiteboard: true });
    adapter.simulate("remote-opens-whiteboard");
    expect(await adapter.setWhiteboard(true)).toBe(false);
    expect(boardOf(events)).toBe("viewing");
    adapter.simulate("remote-closes-whiteboard");
    expect(await adapter.setWhiteboard(true)).toBe(true);
    expect(boardOf(events)).toBe("presenting");
    // A reconnect keeps the last answer (nothing is told meanwhile).
    const told = toolsOf(events).length;
    adapter.simulate("network-drop");
    adapter.simulate("network-restore");
    expect(toolsOf(events).length).toBe(told);
    // Zoom now says host only: this person's own board still closes.
    adapter.simulate("board-host-only");
    expect(toolsOf(events).at(-1)).toEqual({ share: true, whiteboard: false });
    expect(await adapter.setWhiteboard(false)).toBe(false);
    expect(boardOf(events)).toBe("none");
    await adapter.leave();
    expect(toolsOf(events).at(-1)).toEqual({ share: null, whiteboard: null });
    // What the page is told about the tools is never reported to iHear.
    expect(hostReportFor({ type: "tools", share: true, whiteboard: true, at: 1 })).toBeNull();
  });

  test("a lesson's room is told nothing about tools and keeps its rules: a student opens no whiteboard even after the played yes; the tutor presents as before", async () => {
    const adapter = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const events = recorded(adapter);
    await adapter.join({ ...joinInput, role: "student", participantCode: "TEST-MS2" });
    adapter.simulate("board-for-everyone");
    expect(await adapter.setWhiteboard(true)).toBe(false);
    expect(events.some(event => event.type === "tools")).toBe(false);
    const tutor = new SyntheticMediaAdapter({ connectDelayMs: 0 });
    const tutorEvents = recorded(tutor);
    await tutor.join(joinInput);
    expect(await tutor.setWhiteboard(true)).toBe(true);
    tutor.simulate("remote-shares-screen");
    expect(await tutor.setScreenShare(true)).toBe(true);
    expect(tutorEvents.some(event => event.type === "tools")).toBe(false);
  });

  test("the two played answers are scenarios of the fixed rooms' test classroom only", () => {
    expect([...FIXED_ROOM_SCENARIOS].sort()).toEqual(["board-for-everyone", "board-host-only"]);
    expect([...FIXED_ROOM_SCENARIOS].every(scenario => SYNTHETIC_SCENARIOS.includes(scenario))).toBe(true);
  });
});

// P3-Auth (2026-11-08): when the page leaves the room by itself. Only the server's refusal of
// this person counts; anything that may pass (network, 503, rate limit, the door closing while a
// lesson runs over) keeps the lesson going. Leaving relies on the page cooperating.
describe("leaving the room when the entry has ended", () => {
  const student = { role: "student", hasKey: true };
  const tutor = { role: "tutor", hasKey: false };

  test("the student leaves when the lesson is cancelled or the personal link was revoked or replaced", () => {
    expect(entryEndedBy({ status: 403, code: "LESSON_CANCELLED" }, student)).toBe("LESSON_CANCELLED");
    expect(entryEndedBy({ status: 403, code: "NOT_ON_ROSTER" }, student)).toBe("LINK_REVOKED");
    expect(entryEndedBy({ status: 403, code: "NOT_ON_ROSTER" }, { role: "student", hasKey: false })).toBe("NOT_ON_ROSTER");
    expect(entryEndedBy({ status: 403, code: "IDENTITY_UNVERIFIED" }, student)).toBe("IDENTITY_UNVERIFIED");
    expect(entryEndedBy({ status: 404, code: "LESSON_NOT_FOUND" }, student)).toBe("LESSON_NOT_FOUND");
  });

  test("the tutor leaves only when the lesson is cancelled", () => {
    expect(entryEndedBy({ status: 403, code: "LESSON_CANCELLED" }, tutor)).toBe("LESSON_CANCELLED");
    for (const code of ["FORBIDDEN", "OUTSIDE_JOIN_WINDOW", "NOT_ON_ROSTER"]) expect(entryEndedBy({ status: 403, code }, tutor)).toBeNull();
  });

  test("nothing that may pass makes anyone leave", () => {
    const passing = [
      { status: 200, code: undefined }, { status: 403, code: "OUTSIDE_JOIN_WINDOW" }, { status: 429, code: "RATE_LIMITED" },
      { status: 503, code: "PROVIDER_UNAVAILABLE" }, { status: 503, code: "LESSON_CANCELLED" }, { status: 0, code: undefined },
      { status: 403, code: undefined }, { status: 403, code: { toString: () => "LESSON_CANCELLED" } },
    ];
    for (const answer of passing) for (const person of [student, tutor]) expect(entryEndedBy(answer, person), JSON.stringify(answer)).toBeNull();
  });
});

// P2 (2026-11-23): a fixed room says being taken out and the lesson's end in its own words; a
// one-to-one lesson keeps its wording, and every other reason is the same in both.
describe("the words a fixed room shows when the entry has ended", () => {
  test("FX-1: in a fixed room, being taken out and the lesson's end have their own message keys", () => {
    for (const code of ["LINK_REVOKED", "NOT_ON_ROSTER_LINK", "NOT_ON_ROSTER"]) expect(reasonShown(code, true), code).toBe("FIXED_ROOM_TAKEN_OUT");
    expect(reasonShown("LESSON_CANCELLED", true)).toBe("FIXED_ROOM_ENDED");
  });

  test("FX-2: a one-to-one lesson keeps the server's code; other reasons are unchanged in a fixed room", () => {
    for (const code of ["LINK_REVOKED", "NOT_ON_ROSTER_LINK", "NOT_ON_ROSTER", "LESSON_CANCELLED", "OTHER_TAB"]) expect(reasonShown(code, false), code).toBe(code);
    for (const code of ["OTHER_TAB", "TAKEN_OVER", "UNAVAILABLE", "RATE_LIMITED", "LESSON_NOT_FOUND", ""]) expect(reasonShown(code, true), code).toBe(code);
  });

  test("FX-3: both messages exist in the three languages, and none of them sends the person to iHear for a new link", () => {
    for (const locale of ["en", "zhHant", "zhHans"]) {
      const reasons = copy[locale].reasons;
      for (const key of ["FIXED_ROOM_TAKEN_OUT", "FIXED_ROOM_ENDED"]) {
        expect(typeof reasons[key], `${locale} ${key}`).toBe("string");
        expect(reasons[key].length, `${locale} ${key}`).toBeGreaterThan(10);
        expect(reasons[key], `${locale} ${key}`).not.toMatch(/iHear|personal link|個人連結|个人链接/);
      }
    }
  });

  test("FX-4: the classroom page shows the fixed room's words wherever it says why the entry ended", async () => {
    const source = await readFile("app/classroom/[lessonId]/classroom-entry.tsx", "utf8");
    expect(source).toContain("const shownReason = reasonShown(reason, fixedRoom);");
    expect(source).toMatch(/<ClassroomPrejoin[\s\S]{0,200}reason=\{shownReason\}/);
    expect(source).toContain("text.reasons[shownReason] ?? text.reasons.UNAVAILABLE");
    expect(source).toContain("text.reasons[reasonShown(rejoinProblem, fixedRoom)]");
    expect(source).not.toMatch(/text\.reasons\[reason\]/);
  });

  test("FX-6: raised hands in a fixed room (the user, 2026-11-24): on; everyone there sees the others' hands; only a tutor is offered to lower someone else's", async () => {
    const source = await readFile("app/classroom/[lessonId]/classroom-entry.tsx", "utf8");
    expect(source).toContain("raiseHand: current.capabilities.raiseHand, sound:");
    expect(source).not.toMatch(/raiseHand: current\.capabilities\.raiseHand && !joined\.fixedRoom/);
    expect(source).toContain('const seesHands = isTutor || (phase === "joined" && joined?.fixedRoom === true);');
    expect(source).toContain("const fresh = seesHands ? newHands(handsBefore.current, hands) : [];");
    for (const shown of ["{seesHands && othersHands.length > 0 && (", "seesHands ? othersHands.length : 0", "badge: seesHands && othersHands.length > 0"]) expect(source, shown).toContain(shown);
    // Every button that lowers someone else's hand is the tutor's alone.
    const lowering = [...source.matchAll(/onClick=\{\(\) => void lowerHand\(hand\.id\)\}/g)].map((match) => source.slice(Math.max(0, match.index - 220), match.index));
    expect(lowering.length).toBe(2);
    for (const before of lowering) {
      expect(before.lastIndexOf("isTutor && "), before).toBeGreaterThanOrEqual(0);
      expect(before.lastIndexOf("isTutor && "), before).toBeGreaterThan(before.lastIndexOf("seesHands && "));
    }
  });

  test("FX-7: a fixed room's page says \"ends in … minutes\" from 10 minutes before the lesson's planned end, the server's latest end (an extension moves it) over the join answer's, on a clock that moves while in the room", async () => {
    const source = await readFile("app/classroom/[lessonId]/classroom-entry.tsx", "utf8");
    expect(source).toContain("const TIME_LEFT_NOTE_MINUTES = 10;");
    expect(source).toContain('if (typeof data.endsAt === "string" && Number.isFinite(Date.parse(data.endsAt))) setLessonEndsAt(data.endsAt);');
    expect(source).toContain('const endsAtMs = fixedRoomJoined ? Date.parse(lessonEndsAt ?? joined?.lesson.endsAt ?? "") : NaN;');
    expect(source).toContain("const showTimeLeft = minutesLeft != null && minutesLeft > 0 && minutesLeft <= TIME_LEFT_NOTE_MINUTES;");
    expect(source).toContain("const timer = setInterval(() => setNowTick(Date.now()), CLOCK_MS);");
    expect(source).toMatch(/\{showTimeLeft && <p className="classroom-room-problem" role="status" data-time-left=\{minutesLeft\}>\{text\.timeLeft\(minutesLeft\)\}<\/p>\}/);
    for (const locale of ["en", "zhHant", "zhHans"]) {
      expect(copy[locale].timeLeft(5), locale).toMatch(/5/);
      for (const key of ["LESSON_TIME_UP", "FIXED_ROOM_TIME_UP"]) expect(typeof copy[locale].reasons[key], `${locale} ${key}`).toBe("string");
    }
  });

  test("FX-5: the page counts its moves to another session of the lesson (only a new session name counts) and shows the count on its connection state", async () => {
    const source = await readFile("app/classroom/[lessonId]/classroom-entry.tsx", "utf8");
    expect(source).toContain("if (result.session.sessionName && result.session.sessionName !== session.current?.sessionName) setRoomMoves((moves) => moves + 1);");
    expect(source.indexOf("setRoomMoves((moves) => moves + 1)")).toBeLessThan(source.indexOf("session.current = result.session;"));
    expect(source).toMatch(/className=\{`classroom-room-connection [^`]+`\} role="status" data-room-moves=\{roomMoves\}/);
  });
});
