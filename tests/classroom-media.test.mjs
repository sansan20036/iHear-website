import { describe, expect, test, vi } from "vitest";

import {
  createMediaAdapter, hostReportFor, MEDIA_PROVIDERS, MediaAdapterUnavailableError, SYNTHETIC_SCENARIOS, SyntheticMediaAdapter,
} from "../lib/classroom-media";

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
  test("only the synthetic stand-in exists; the three candidates say they are not built yet, and it never claims real media", () => {
    expect(MEDIA_PROVIDERS).toEqual(["synthetic", "tencent-rtc", "agora", "zoom-video-sdk"]);
    const synthetic = createMediaAdapter("synthetic", { connectDelayMs: 0 });
    expect(synthetic).toBeInstanceOf(SyntheticMediaAdapter);
    expect(synthetic.capabilities).toEqual({ realMedia: false, screenShare: false });
    for (const provider of ["tencent-rtc", "agora", "zoom-video-sdk"]) {
      expect(() => createMediaAdapter(provider)).toThrow(MediaAdapterUnavailableError);
      expect(() => createMediaAdapter(provider)).toThrow(/not built yet/);
    }
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
