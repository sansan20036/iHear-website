import { describe, expect, test } from "vitest";

// One page per person and lesson (2026-11-19). On the production site the tutor was in one lesson
// up to three times at once (Zoom's record of the session): the student heard one tab and saw none.
// The one-to-one room now takes a Web Lock per lesson and person; a second tab is refused until the
// person continues there, and the first tab, which loses the lock, leaves. These tests drive the
// lock with a stand-in of the browser's LockManager (ifAvailable and steal as the Web Locks spec has them).
const { claimLessonTab, lessonTabName, personTag } = await import("../lib/classroom-tab");
const { roomCopy, vendorCopy } = await import("../app/classroom/[lessonId]/classroom-copy");

function fakeLocks() {
  const held = new Map();
  return {
    held,
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const current = held.get(name);
        if (current && options.ifAvailable) { Promise.resolve(callback(null)).then(resolve, reject); return; }
        if (current && options.steal) { held.delete(name); current.reject(Object.assign(new Error("The lock was stolen"), { name: "AbortError" })); }
        const entry = { reject };
        held.set(name, entry);
        Promise.resolve(callback({ name })).then(value => { if (held.get(name) === entry) held.delete(name); resolve(value); }, reject);
      });
    },
  };
}
const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

describe("one page per person and lesson", () => {
  test("the first tab holds the lesson; a second is refused; after leaving, another tab may enter", async () => {
    const locks = fakeLocks();
    const name = lessonTabName("L-1", "student-key");
    const first = await claimLessonTab(name, { locks });
    expect(first).not.toBeNull();
    expect(await claimLessonTab(name, { locks })).toBeNull();
    first.release();
    await tick();
    expect(await claimLessonTab(name, { locks })).not.toBeNull();
  });

  test("'Continue in this tab' takes the lesson over, and the first tab learns it lost it", async () => {
    const locks = fakeLocks();
    const name = lessonTabName("L-1", null);
    const first = await claimLessonTab(name, { locks });
    let firstLost = false;
    void first.lost.then(() => { firstLost = true; });
    const second = await claimLessonTab(name, { locks, steal: true });
    await tick();
    expect([second !== null, firstLost]).toEqual([true, true]);
    // The second keeps it: a third, without taking over, is refused.
    expect(await claimLessonTab(name, { locks })).toBeNull();
  });

  test("other lessons and other people are not affected", async () => {
    const locks = fakeLocks();
    expect(await claimLessonTab(lessonTabName("L-1", "a"), { locks })).not.toBeNull();
    expect(await claimLessonTab(lessonTabName("L-2", "a"), { locks })).not.toBeNull();
    expect(await claimLessonTab(lessonTabName("L-1", "b"), { locks })).not.toBeNull();
    expect(await claimLessonTab(lessonTabName("L-1", null), { locks })).not.toBeNull();
  });

  test("a browser without Web Locks enters as before (nothing is kept, nothing is lost)", async () => {
    const claim = await claimLessonTab("ihear-lesson:L-1:staff", { locks: null });
    expect(claim).not.toBeNull();
    let lost = false;
    void claim.lost.then(() => { lost = true; });
    claim.release();
    await tick();
    expect(lost).toBe(false);
  });

  test("the lock's name carries no personal key, only a short tag (staff for a signed-in tutor)", () => {
    const key = "Zx9-personal-key-0123456789abcdefghijklmnopqrstuvw";
    const name = lessonTabName("L-abc", key);
    expect(name).not.toContain(key);
    expect(name).toBe(`ihear-lesson:L-abc:${personTag(key)}`);
    expect(personTag(key)).toMatch(/^[0-9a-f]{1,8}$/);
    expect(personTag(key)).toBe(personTag(key));
    expect(personTag(null)).toBe("staff");
  });
});

describe("the room's words for these (English, Traditional and Simplified Chinese)", () => {
  const locales = ["en", "zhHant", "zhHans"];
  test("every language has the new messages, reasons and test scenarios", () => {
    for (const locale of locales) {
      const text = roomCopy[locale];
      for (const key of ["continueHere", "elsewhere", "zoomOut", "zoomIn", "zoomFit", "materialFullscreen", "materialFullscreenExit", "readingTip"]) expect(String(text[key] ?? "").length, `${locale}.${key}`).toBeGreaterThan(0);
      expect(text.zoomLevel(150)).toContain("150%");
      for (const reason of ["OTHER_TAB", "TAKEN_OVER"]) expect(String(text.reasons[reason] ?? "").length, `${locale}.reasons.${reason}`).toBeGreaterThan(0);
      for (const scenario of ["self-elsewhere", "self-elsewhere-ends"]) expect(String(text.scenario[scenario] ?? "").length, `${locale}.scenario.${scenario}`).toBeGreaterThan(0);
    }
    // The way back names the button it offers.
    expect(roomCopy.zhHant.reasons.OTHER_TAB).toContain(roomCopy.zhHant.continueHere);
    expect(roomCopy.zhHans.reasons.OTHER_TAB).toContain(roomCopy.zhHans.continueHere);
    expect(roomCopy.en.reasons.OTHER_TAB).toContain(roomCopy.en.continueHere);
  });
  test("each language in its own script", () => {
    const words = locale => { const t = roomCopy[locale]; return [t.continueHere, t.elsewhere, t.zoomOut, t.zoomIn, t.zoomFit, t.materialFullscreen, t.readingTip, t.reasons.OTHER_TAB, t.reasons.TAKEN_OVER].join(" "); };
    expect(words("en")).not.toMatch(/\p{Script=Han}/u);
    expect(words("zhHant")).not.toMatch(/[这个页标签设备进们说时间开关请显视频务]/u);
    expect(words("zhHans")).not.toMatch(/[這個頁標籤設備進們說時間開關請顯視頻螢務]/u);
    // vendorCopy exists in all three, as before.
    expect(Object.keys(vendorCopy).sort()).toEqual(["en", "zhHans", "zhHant"]);
  });
});
