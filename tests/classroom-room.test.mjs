import { describe, expect, test } from "vitest";

import { connectionStep, devicesToOffer, HAND_NOTICE_MS, initialsOf, newHands, orderPeople, personLabel, soundOffered, spotlightOf, stageModeOf } from "../lib/classroom-room";
import { SYNTHETIC_SCENARIOS } from "../lib/classroom-media";

const { roomCopy } = await import("../app/classroom/[lessonId]/classroom-copy");

// Classroom 2.0 (2026-11-12): the room's layout rules, from the media state alone. Synthetic people
// with test codes only; nothing here touches a page, an SDK or the network.

const words = { tutor: "小老師", student: "學生" };
const person = (id, extra = {}) => ({ id, name: id, host: false, self: false, camera: true, microphone: true, video: "shown", ...extra });

describe("Classroom 2.0: what the room shows", () => {
  test("the stage shows the whiteboard, else the shared screen, else the people; Tencent's classroom is its own page", () => {
    expect(stageModeOf("zoom-video-sdk", "none", "none")).toBe("people");
    expect(stageModeOf("zoom-video-sdk", "receiving", "none")).toBe("share");
    expect(stageModeOf("zoom-video-sdk", "sending", "none")).toBe("share");
    expect(stageModeOf("zoom-video-sdk", "receiving", "viewing")).toBe("board");
    expect(stageModeOf("synthetic", "none", "presenting")).toBe("board");
    expect(stageModeOf("tencent-lcic", "receiving", "viewing")).toBe("embed");
  });

  test("a raised hand is told once, never to the page that raised it, and a hand raised again after lowering is told again", () => {
    const one = { id: "2", name: "TEST-S01", self: false };
    const own = { id: "1", name: "", self: true };
    expect(newHands([], [one, own])).toEqual([one]);
    expect(newHands([one], [one])).toEqual([]);
    expect(newHands([one], [])).toEqual([]);
    expect(newHands([], [one])).toEqual([one]);
    // A few seconds on top of the stage (3 to 5, as decided), then the counts keep it.
    expect(HAND_NOTICE_MS).toBeGreaterThanOrEqual(3_000);
    expect(HAND_NOTICE_MS).toBeLessThanOrEqual(5_000);
  });

  test("the tutor comes first, then raised hands in the order they went up, then the others by code, and this page's own person last", () => {
    const people = [person("TEST-S03"), person("me", { self: true, name: "TEST-S01" }), person("TEST-S02"), person("TEST-T01", { host: true }), person("TEST-S04")];
    expect(orderPeople(people).map(item => item.id)).toEqual(["TEST-T01", "TEST-S02", "TEST-S03", "TEST-S04", "me"]);
    const hands = [{ id: "TEST-S04", name: "TEST-S04", self: false }, { id: "TEST-S03", name: "TEST-S03", self: false }];
    expect(orderPeople(people, hands).map(item => item.id)).toEqual(["TEST-T01", "TEST-S04", "TEST-S03", "TEST-S02", "me"]);
    // The tutor's own page: the tutor is this page's person, so last.
    const tutorsView = [person("TEST-T01", { host: true, self: true }), person("TEST-S01")];
    expect(orderPeople(tutorsView).map(item => item.id)).toEqual(["TEST-S01", "TEST-T01"]);
    expect(people.map(item => item.id)).toEqual(["TEST-S03", "me", "TEST-S02", "TEST-T01", "TEST-S04"]);
  });

  test("a tile says the role and the participant code, never more; the short mark is the end of the code", () => {
    expect(personLabel(person("TEST-T01", { host: true }), words)).toBe("小老師 TEST-T01");
    expect(personLabel(person("TEST-S01"), words)).toBe("學生 TEST-S01");
    // The test room does not know the other person's code.
    expect(personLabel(person("remote", { name: "" }), words)).toBe("學生");
    expect(initialsOf(person("TEST-S01"), words)).toBe("S01");
    expect(initialsOf(person("x", { name: "abcd" }), words)).toBe("ABC");
    expect(initialsOf(person("remote", { name: "", host: true }), words)).toBe("小");
    expect(initialsOf(person("remote", { name: "" }), { tutor: "Tutor", student: "Student" })).toBe("S");
  });

  test("a person enlarged on this page stays enlarged only while they are in the room", () => {
    const people = [person("TEST-S01"), person("TEST-S02")];
    expect(spotlightOf("TEST-S02", people)).toBe("TEST-S02");
    expect(spotlightOf("TEST-S09", people)).toBeNull();
    expect(spotlightOf(null, people)).toBeNull();
  });
});

// 2026-11-20: after a reconnect the camera and microphone are off, and the one-to-one room now says
// so. The connection's states as the page hears them, one at a time (the adapters never repeat one).
const replay = (states) => {
  let lost = false, before = "idle";
  const backs = [];
  for (const state of states) {
    const step = connectionStep(lost, before, state);
    lost = step.lost;
    before = state;
    backs.push(step.back);
  }
  return { backs, lost };
};

describe("after a reconnect: what the room offers to turn on again", () => {
  test("RJ-1: the first join is no reconnect; Zoom's own reconnect, a failure with joining again, and a move are", () => {
    expect(replay(["connecting", "connected"]).backs).toEqual([false, false]);
    // Zoom reconnects by itself.
    expect(replay(["connecting", "connected", "reconnecting", "connected"]).backs).toEqual([false, false, false, true]);
    // Zoom gives up; the page (or "Connect again") joins again.
    expect(replay(["connecting", "connected", "failed", "connecting", "connected"]).backs).toEqual([false, false, false, false, true]);
    // Reconnecting, then failing, then joined again: offered once.
    expect(replay(["connecting", "connected", "reconnecting", "failed", "connecting", "connected"]).backs.filter(Boolean)).toHaveLength(1);
    // A move to another room (D-5) joins again straight from "connected".
    expect(replay(["connecting", "connected", "connecting", "connected"]).backs).toEqual([false, false, false, true]);
    // A first join that failed and was tried again: nothing was on before, nothing is offered.
    expect(replay(["connecting", "failed", "connecting", "connected"]).backs).toEqual([false, false, false, false]);
    // Still down at the end: lost, not back.
    expect(replay(["connecting", "connected", "failed"])).toEqual({ backs: [false, false, false], lost: true });
  });

  test("RJ-2: only what the person had turned on and is off now; the microphone first", () => {
    const off = { camera: "off", microphone: "off" };
    expect(devicesToOffer(null, off)).toEqual([]);
    expect(devicesToOffer({ camera: false, microphone: false }, off)).toEqual([]);
    expect(devicesToOffer({ camera: true, microphone: true }, off)).toEqual(["microphone", "camera"]);
    expect(devicesToOffer({ camera: true, microphone: false }, off)).toEqual(["camera"]);
    expect(devicesToOffer({ camera: false, microphone: true }, off)).toEqual(["microphone"]);
    // On or starting needs nothing; blocked or failed has its own help and its own "Try again".
    for (const state of ["on", "starting", "denied", "unavailable", "failed"]) {
      expect(devicesToOffer({ camera: true, microphone: true }, { camera: state, microphone: state }), state).toEqual([]);
    }
    expect(devicesToOffer({ camera: true, microphone: true }, { camera: "on", microphone: "off" })).toEqual(["microphone"]);
  });

  test("RJ-3: the offer in all three languages names what is off, each in its own script", () => {
    for (const locale of ["en", "zhHant", "zhHans"]) {
      const text = roomCopy[locale];
      for (const key of ["both", "camera", "microphone"]) expect(String(text.rejoinDevices?.[key] ?? "").length, `${locale}.rejoinDevices.${key}`).toBeGreaterThan(0);
      for (const key of ["rejoinTurnOn", "rejoinNotNow"]) expect(String(text[key] ?? "").length, `${locale}.${key}`).toBeGreaterThan(0);
      const says = (value, word) => value.toLowerCase().includes(word.toLowerCase());
      expect(says(text.rejoinDevices.camera, text.camera) && !says(text.rejoinDevices.camera, text.microphone), `${locale} camera`).toBe(true);
      expect(says(text.rejoinDevices.microphone, text.microphone) && !says(text.rejoinDevices.microphone, text.camera), `${locale} microphone`).toBe(true);
      expect(says(text.rejoinDevices.both, text.camera) && says(text.rejoinDevices.both, text.microphone), `${locale} both`).toBe(true);
    }
    // The question names the button that answers it.
    for (const locale of ["zhHant", "zhHans"]) for (const key of ["both", "camera", "microphone"]) expect(roomCopy[locale].rejoinDevices[key]).toContain(roomCopy[locale].rejoinTurnOn);
    const words = (locale) => { const t = roomCopy[locale]; return [...Object.values(t.rejoinDevices), t.rejoinTurnOn, t.rejoinNotNow].join(" "); };
    expect(words("en")).not.toMatch(/\p{Script=Han}/u);
    expect(words("zhHant")).not.toMatch(/[这个页标签设备进们说时间开关请显视频务连线摄头对听吗启]/u);
    expect(words("zhHans")).not.toMatch(/[這個頁標籤設備進們說時間開關請顯視頻螢務連線攝頭對聽嗎啟]/u);
  });
});

// 2026-11-20: "Turn on sound" — nobody heard the room before pressing the microphone.
describe("Turn on sound: when the room offers it, and what it says", () => {
  const base = { connected: true, canJoin: true, sound: "off", microphone: "off", micOffered: false };
  test("SB-10: offered while connected and silent, by an adapter that can; not when the microphone (or an offer to turn it on) brings the sound", () => {
    expect(soundOffered(base)).toBe(true);
    expect(soundOffered({ ...base, sound: "joining" })).toBe(true);
    expect(soundOffered({ ...base, sound: "failed" })).toBe(true);
    expect(soundOffered({ ...base, sound: "on" })).toBe(false);
    expect(soundOffered({ ...base, connected: false })).toBe(false);
    expect(soundOffered({ ...base, canJoin: false })).toBe(false);
    expect(soundOffered({ ...base, microphone: "on" })).toBe(false);
    expect(soundOffered({ ...base, microphone: "starting" })).toBe(false);
    expect(soundOffered({ ...base, micOffered: true })).toBe(false);
    // A blocked microphone: the sound is still offered, and its failure is explained.
    for (const microphone of ["denied", "unavailable", "failed"]) expect(soundOffered({ ...base, microphone }), microphone).toBe(true);
  });

  test("SB-11: the words in all three languages, each in its own script; they promise a muted microphone and name the button", () => {
    for (const locale of ["en", "zhHant", "zhHans"]) {
      const text = roomCopy[locale];
      for (const key of ["off", "short", "capture", "autoplay", "error", "turnOn", "joining"]) expect(String(text.sound?.[key] ?? "").length, `${locale}.sound.${key}`).toBeGreaterThan(0);
      // The phone's short line is short, and still promises the muted microphone.
      expect([...text.sound.short].length, `${locale}.sound.short`).toBeLessThanOrEqual(60);
      for (const key of ["off", "capture", "autoplay", "error"]) expect(text.sound[key], `${locale}.sound.${key} names the button`).toContain(text.sound.turnOn);
      // Every test scenario has its button label.
      for (const scenario of SYNTHETIC_SCENARIOS) expect(String(text.scenario[scenario] ?? "").length, `${locale}.scenario.${scenario}`).toBeGreaterThan(0);
    }
    for (const key of ["off", "short"]) {
      expect(roomCopy.en.sound[key]).toMatch(/microphone stays muted/);
      expect(roomCopy.zhHant.sound[key]).toContain("麥克風會保持靜音");
      expect(roomCopy.zhHans.sound[key]).toContain("麦克风会保持静音");
    }
    const words = (locale) => [...Object.values(roomCopy[locale].sound), roomCopy[locale].scenario["sound-blocked"]].join(" ");
    expect(words("en")).not.toMatch(/\p{Script=Han}/u);
    expect(words("zhHant")).not.toMatch(/[这个页标签设备进们说时间开关请显视频务连线摄头对听吗启声没浏览挡试启置刷]/u);
    expect(words("zhHans")).not.toMatch(/[這個頁標籤設備進們說時間開關請顯視頻螢務連線攝頭對聽嗎啟聲沒瀏覽擋試設]/u);
  });
});
