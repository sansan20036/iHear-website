import { describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { applyClassroomEntry, applyClassroomSwitch, CLASSROOM_SWITCH_LINE, readClassroomEntrySwitch } from "../scripts/classroom-entry.mjs";
import { classroomEntryAccess } from "../lib/classroom-entry";
import { JOIN_KEY_PATTERN, LESSON_ID_PATTERN, parseStudentLink, studentRoomPath } from "../lib/classroom-link";
import { classroomLocaleOf, htmlLangOf, LOCALE_NAMES } from "../lib/classroom-locale";
import { homeCopy } from "../app/classroom/classroom-home-copy";
import { roomCopy, vendorCopy } from "../app/classroom/[lessonId]/classroom-copy";

// The home page's way into the online classroom (D2, 2026-11-07), offline: the one release switch
// for the home page and the header, the entries in three languages, a pasted personal link read
// safely, the classroom pages in Simplified Chinese too, and who may preview before it opens.
const root = process.cwd();
const source = file => readFile(path.join(root, file), "utf8");
const START = "<!-- classroom-entry:start -->";
const END = "<!-- classroom-entry:end -->";

describe("one release switch for the home page entries and the header", () => {
  // P3 D2 (2026-11-12): the owner decided that teachers and students find the classroom on the
  // home page, so the switch is on in this commit of its own; switching it off again is rolling
  // that deployment back (or this commit reverted), never an address parameter.
  test("it is on in the repository: the classroom entries are open to everyone (P3 D2, the owner's decision)", async () => {
    expect(JSON.parse(await source("data/classroom-entry.json"))).toEqual({ released: true });
    expect(await readClassroomEntrySwitch(root)).toBe(true);
  });

  test("the switch file is kept in the repository, so every build reads the same switch", async () => {
    // data/* holds local runtime data and is left out of Git; the switch must be let back in.
    const ignore = (await source(".gitignore")).split(/\r?\n/);
    expect(ignore).toContain("data/*");
    expect(ignore.indexOf("!data/classroom-entry.json")).toBeGreaterThan(ignore.indexOf("data/*"));
  });

  test("the home page holds two entries, the hero button and a footer link, to /classroom only and in three languages", async () => {
    const html = await source("index.html");
    expect(html.split(START)).toHaveLength(3);
    expect(html.split(END)).toHaveLength(3);
    const blocks = html.split(START).slice(1).map(part => part.split(END)[0]);
    for (const block of blocks) {
      expect([...block.matchAll(/<a\b[^>]*>/g)]).toHaveLength(1);
      expect(block).toMatch(/<a\b[^>]*\bhref="\/classroom"[^>]*\bdata-classroom-entry=/);
      expect(block).not.toMatch(/target=|https?:/);
      expect(block).toContain('<span lang="en">Online Classroom</span>');
      expect(block).toContain('<span lang="zh-Hant">線上教室</span>');
      expect(block).toContain('<span lang="zh-Hans">线上教室</span>');
      // Never an editable or translated slot: nothing about it reaches the content catalog.
      expect(block).not.toMatch(/data-i18n|data-editable/);
    }
    expect(blocks[0]).toContain("btn");
    expect(html.indexOf(START)).toBeGreaterThan(html.indexOf('class="hero-ctas"'));
    expect(html.lastIndexOf(START)).toBeGreaterThan(html.indexOf("<footer"));
  });

  test("switched off, the built home page has no classroom entry and nothing else changes", async () => {
    const html = await source("index.html");
    const off = applyClassroomEntry(html, false);
    for (const fragment of ["/classroom", "classroom-entry", "線上教室", "线上教室", "Online Classroom"]) expect(off).not.toContain(fragment);
    const withoutBlocks = html.split(/\r?\n/).filter((line, index, lines) => {
      const before = lines.slice(0, index + 1).join("\n");
      return before.split(START).length === before.split(END).length && !line.includes(END);
    }).join("\n");
    expect(off.split(/\r?\n/).join("\n")).toBe(withoutBlocks);
    for (const page of ["about.html", "team.html", "academy.html"]) {
      const other = await source(page);
      expect(applyClassroomEntry(other, false)).toBe(other);
      expect(applyClassroomEntry(other, true)).toBe(other);
    }
  });

  test("switched on, both entries stay and only the markers go", async () => {
    const on = applyClassroomEntry(await source("index.html"), true);
    expect(on.match(/href="\/classroom"/g)).toHaveLength(2);
    expect(on).not.toContain("classroom-entry:");
  });

  test.each([
    ["a start without an end", `<p>${START}<a href="/classroom">x</a></p>`],
    ["an end without a start", `<p><a href="/classroom">x</a>${END}</p>`],
    ["one block inside another", `${START}${START}<a href="/classroom">x</a>${END}${END}`],
  ])("%s stops the build", (_name, html) => {
    expect(() => applyClassroomEntry(html, false)).toThrow(/classroom entry/i);
    expect(() => applyClassroomEntry(html, true)).toThrow(/classroom entry/i);
  });

  test("a classroom link outside the markers stops a build that is switched off", () => {
    expect(() => applyClassroomEntry('<p><a href="/classroom">x</a></p>', false)).toThrow(/outside/i);
    expect(() => applyClassroomEntry('<p><a class="x" href="/classroom/L-1">x</a></p>', false)).toThrow(/outside/i);
  });

  test("the header's switch is set from the same file, and a script without exactly one switch stops the build", async () => {
    const auth = await source("assets/auth.js");
    expect(auth.split(CLASSROOM_SWITCH_LINE)).toHaveLength(2);
    expect(applyClassroomSwitch(auth, false)).toBe(auth);
    const on = applyClassroomSwitch(auth, true);
    expect(on).toContain("const CLASSROOM_ENTRY_RELEASED = true;");
    expect(on).not.toContain(CLASSROOM_SWITCH_LINE);
    expect(() => applyClassroomSwitch("(function(){})();", true)).toThrow(/switch/i);
    expect(() => applyClassroomSwitch(`${auth}\n${CLASSROOM_SWITCH_LINE}`, true)).toThrow(/switch/i);
  });

  test("the build applies both, from the switch file", async () => {
    const prepare = await source("scripts/prepare-public.mjs");
    expect(prepare).toContain("readClassroomEntrySwitch(root)");
    expect(prepare).toMatch(/applyClassroomEntry\(/);
    expect(prepare).toMatch(/applyClassroomSwitch\(/);
  });
});

describe("a pasted personal link is read on the page, never followed", () => {
  const ORIGIN = "https://www.ihearus.org";
  const LESSON = "L-0123456789abcdef0123456789abcdef";
  const KEY = "Abc_def-ghijklmnopqrstuvwxyz0123456789ABCDE";

  test("the key and lesson formats are the ones the site issues", () => {
    expect(KEY).toMatch(JOIN_KEY_PATTERN);
    expect(LESSON).toMatch(LESSON_ID_PATTERN);
  });

  test.each([
    ["the link as given (#k=)", `${ORIGIN}/classroom/${LESSON}#k=${KEY}`],
    ["the older ?k= form", `${ORIGIN}/classroom/${LESSON}?k=${KEY}`],
    ["the address without the site", `/classroom/${LESSON}#k=${KEY}`],
    ["with spaces around it", `  ${ORIGIN}/classroom/${LESSON}#k=${KEY}\n`],
  ])("accepts %s", (_name, input) => {
    const link = parseStudentLink(input, ORIGIN);
    expect(link).toEqual({ lessonId: LESSON, key: KEY });
    expect(studentRoomPath(link)).toBe(`/classroom/${LESSON}#k=${KEY}`);
  });

  test.each([
    ["another site", `https://evil.example/classroom/${LESSON}#k=${KEY}`],
    ["a look-alike host", `https://www.ihearus.org.evil.example/classroom/${LESSON}#k=${KEY}`],
    ["a name before @", `https://www.ihearus.org@evil.example/classroom/${LESSON}#k=${KEY}`],
    ["the same host over plain http", `http://www.ihearus.org/classroom/${LESSON}#k=${KEY}`],
    ["a protocol-relative address", `//evil.example/classroom/${LESSON}#k=${KEY}`],
    ["backslashes", `https:\\\\evil.example\\classroom\\${LESSON}#k=${KEY}`],
    ["javascript:", "javascript:alert(1)//classroom/"],
    ["data:", `data:text/html,<a href="/classroom/${LESSON}#k=${KEY}">`],
    ["another page", `${ORIGIN}/admin/classrooms#k=${KEY}`],
    ["a way out of /classroom", `${ORIGIN}/classroom/../admin#k=${KEY}`],
    ["an encoded way out", `${ORIGIN}/classroom/%2e%2e/admin#k=${KEY}`],
    ["a deeper path", `${ORIGIN}/classroom/${LESSON}/x#k=${KEY}`],
    ["a lesson with odd characters", `${ORIGIN}/classroom/L_<x>#k=${KEY}`],
    ["no key", `${ORIGIN}/classroom/${LESSON}`],
    ["a short key", `${ORIGIN}/classroom/${LESSON}#k=abc`],
    ["a key with other characters", `${ORIGIN}/classroom/${LESSON}#k=${KEY.slice(0, 42)}%2F`],
    ["two keys", `${ORIGIN}/classroom/${LESSON}?k=${KEY}#k=${KEY}`],
    ["something besides the key", `${ORIGIN}/classroom/${LESSON}#k=${KEY}&next=https://evil.example`],
    ["a redirect parameter", `${ORIGIN}/classroom/${LESSON}?next=https://evil.example#k=${KEY}`],
    ["spaces inside", `${ORIGIN}/classroom/${LESSON} #k=${KEY}`],
    ["an address without its scheme", `www.ihearus.org/classroom/${LESSON}#k=${KEY}`],
    ["nothing", ""],
    ["not text", 42],
    ["far too long", `${ORIGIN}/classroom/${LESSON}#k=${KEY}${"a".repeat(600)}`],
  ])("refuses %s", (_name, input) => {
    expect(parseStudentLink(input, ORIGIN)).toBeNull();
  });

  test("whatever is pasted, the only place it can lead is a classroom on this site", () => {
    const samples = ["https://evil.example", "/classroom/", "/classroom/%0d%0a", `/classroom/${LESSON}#k=${KEY}`, `${ORIGIN}/classroom/${LESSON}?k=${KEY}`, "\u0000", "/\\evil.example"];
    for (const input of samples) {
      const link = parseStudentLink(input, ORIGIN);
      if (link) expect(studentRoomPath(link)).toMatch(/^\/classroom\/[A-Za-z0-9-]{1,36}#k=[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("the classroom pages in English, Traditional and Simplified Chinese", () => {
  // Characters written differently in the two scripts; each side must not use the other's.
  const TRADITIONAL_ONLY = "這們來時間課學師連線網錄視訊設備裝開關進檔說請帳號後確認權點對還應麼現頁讀選擇顯嘗結傳試輸畫資與為從過電腦機麥風聲個會經沒須啟斷錯誤狀態動證處鐘頭鏡攝暫載標錄驗";
  const SIMPLIFIED_ONLY = "这们来时间课学师连线网录视讯设备装开关进档说请帐号后确认权点对还应么现页读选择显尝结传试输画资与为从过电脑机麦风声个会经没须启断错误状态动证处钟头镜摄暂载标验";
  const sampleCheck = { sdkVersion: "2.6.0", audio: true, video: false, screenShare: true };
  const strings = value => typeof value === "string" ? [value] : typeof value === "function" ? strings(value(sampleCheck)) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const shape = value => typeof value === "function" ? "function" : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])])) : typeof value;

  test.each([["the entry page", homeCopy], ["the room", roomCopy], ["the room's video tools", vendorCopy]])("%s has the same wording keys in all three languages", (_name, copy) => {
    expect(Object.keys(copy).sort()).toEqual(["en", "zhHans", "zhHant"]);
    expect(shape(copy.zhHant)).toEqual(shape(copy.en));
    expect(shape(copy.zhHans)).toEqual(shape(copy.en));
  });

  test.each([["the entry page", homeCopy], ["the room", roomCopy], ["the room's video tools", vendorCopy]])("%s keeps each Chinese script to its own characters", (_name, copy) => {
    const hans = strings(copy.zhHans).join("");
    const hant = strings(copy.zhHant).join("");
    expect([...hans].filter(char => TRADITIONAL_ONLY.includes(char))).toEqual([]);
    expect([...hant].filter(char => SIMPLIFIED_ONLY.includes(char))).toEqual([]);
    expect(hans).not.toBe(hant);
  });

  test("the language follows the site's choice, and otherwise the browser, as the site's own pages do", () => {
    expect(classroomLocaleOf("en", "zh-TW")).toBe("en");
    expect(classroomLocaleOf("zhTW", "en-US")).toBe("zhHant");
    expect(classroomLocaleOf("zhCN", "en-US")).toBe("zhHans");
    expect(classroomLocaleOf(null, "zh-TW")).toBe("zhHant");
    expect(classroomLocaleOf(null, "zh-HK")).toBe("zhHant");
    expect(classroomLocaleOf(null, "zh-Hant")).toBe("zhHant");
    expect(classroomLocaleOf(null, "zh-CN")).toBe("zhHans");
    expect(classroomLocaleOf(null, "zh")).toBe("zhHans");
    expect(classroomLocaleOf(null, "en-GB")).toBe("en");
    expect(classroomLocaleOf("something", "fr")).toBe("en");
    expect([htmlLangOf("en"), htmlLangOf("zhHant"), htmlLangOf("zhHans")]).toEqual(["en", "zh-Hant", "zh-Hans"]);
    expect(LOCALE_NAMES).toEqual({ en: "English", zhHant: "繁體中文", zhHans: "简体中文" });
  });
});

describe("who may preview the classroom entry before it opens", () => {
  test("once it is open, nobody needs a preview and nothing is looked up", async () => {
    const isTutor = vi.fn();
    expect(await classroomEntryAccess({ released: true, email: "tutor@example.test", isAdmin: false, isTutor })).toEqual({ released: true, preview: false, signedIn: true });
    expect(isTutor).not.toHaveBeenCalled();
  });

  test("before it opens: nobody signed out, administrators and the lessons' tutors yes, anyone else no", async () => {
    const isTutor = vi.fn(async email => email === "tutor@example.test");
    expect(await classroomEntryAccess({ released: false, email: null, isAdmin: false, isTutor })).toEqual({ released: false, preview: false, signedIn: false });
    expect(isTutor).not.toHaveBeenCalled();
    expect(await classroomEntryAccess({ released: false, email: "owner@example.test", isAdmin: true, isTutor })).toEqual({ released: false, preview: true, signedIn: true });
    expect(isTutor).not.toHaveBeenCalled();
    expect(await classroomEntryAccess({ released: false, email: "tutor@example.test", isAdmin: false, isTutor })).toEqual({ released: false, preview: true, signedIn: true });
    expect(await classroomEntryAccess({ released: false, email: "someone@example.test", isAdmin: false, isTutor })).toEqual({ released: false, preview: false, signedIn: true });
  });

  test("if the lessons cannot be read, only administrators may preview", async () => {
    const isTutor = vi.fn(async () => { throw new Error("database unavailable"); });
    expect(await classroomEntryAccess({ released: false, email: "tutor@example.test", isAdmin: false, isTutor })).toEqual({ released: false, preview: false, signedIn: true });
    expect(await classroomEntryAccess({ released: false, email: "owner@example.test", isAdmin: true, isTutor })).toEqual({ released: false, preview: true, signedIn: true });
  });
});
