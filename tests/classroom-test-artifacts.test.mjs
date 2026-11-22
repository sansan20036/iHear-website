import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

// Classroom 3.0 round 4 (2026-11-21): no whole link (a fixed room's, a lesson's or a block's key) is
// left in the repository or in a picture a browser check takes. The links themselves are synthetic
// in every check; this keeps the habit for when they are not.
describe("whole links never end up in test pictures or in the repository", () => {
  test("TA-1: every classroom browser check takes its pictures through screenshotSafely, which masks the places where admin pages show a whole link", async () => {
    const checks = (await readdir("tests")).filter((name) => /^classroom.*\.smoke\.mjs$/.test(name));
    expect(checks.length).toBeGreaterThan(10);
    for (const name of checks) {
      const text = await readFile(`tests/${name}`, "utf8");
      expect(text.match(/\.screenshot\(/g) ?? [], name).toEqual([]);
    }
    const helper = await readFile("tests/helpers/academy-smoke.mjs", "utf8");
    expect(helper).toContain("export const LINK_ON_SCREEN = '.classroom-link code, [data-student-link] code, [data-room-link] code';");
    expect(helper).toContain("page.screenshot({ ...options, mask: [...(options.mask ?? []), page.locator(LINK_ON_SCREEN)] })");
    // Those are the places: the one-to-one lesson's link box, the students' links of a block (made
    // by hand or by a schedule import), a fixed room's link. No other page shows a link in <code>.
    expect(await readFile("app/admin/classrooms/page.tsx", "utf8")).toMatch(/className="classroom-link"[\s\S]{0,300}<code>\{linkBox\.url\}<\/code>/);
    expect(await readFile("app/admin/classrooms/blocks/page.tsx", "utf8")).toMatch(/data-student-link=\{entry\.code\}>\{entry\.code\}：<code>/);
    expect(await readFile("app/admin/classrooms/schedule/page.tsx", "utf8")).toMatch(/data-student-link=\{entry\.code\}>\{entry\.code\}：<code>/);
    expect(await readFile("app/admin/classrooms/rooms/page.tsx", "utf8")).toMatch(/<div role="status" data-room-link>[\s\S]{0,300}<code>/);
    // GitHub CI runs this in a container where the checkout belongs to another user: git then refuses
    // the repository ("dubious ownership") unless told it is safe, which only the command line or the
    // global settings may say. Only this read of our own checkout is told so.
    const shown = execFileSync("git", ["-c", "safe.directory=*", "grep", "-lE", "<code>", "--", "app/*.tsx"], { encoding: "utf8" }).trim().split("\n").map((line) => line.replace(/\\/g, "/")).sort();
    expect(shown).toEqual(["app/admin/classrooms/blocks/page.tsx", "app/admin/classrooms/page.tsx", "app/admin/classrooms/rooms/page.tsx", "app/admin/classrooms/schedule/page.tsx", "app/auth-error/auth-error-client.tsx"]);
  });

  test("TA-3: a check that fails while a link is in an error message leaves no key: every classroom check writes its report through redactLinks and ends a failure through withoutLinkKeys", async () => {
    const { redactLinks, withoutLinkKeys } = await import("./helpers/academy-smoke.mjs");
    const key = "mPSwoqLycXbmNDYCtoJjEBMM0dZYCtIrNb0fbASP_rY";
    expect(redactLinks(`navigating to "http://localhost:3242/classroom/L-1#k=${key}"`)).toBe('navigating to "http://localhost:3242/classroom/L-1#k=[redacted]"');
    expect(redactLinks(`/classroom/r/FR-1?k=${key}&k=${key} ticket=${key}`)).toBe("/classroom/r/FR-1?k=[redacted]&k=[redacted] ticket=[redacted]");
    expect(redactLinks("a test word #k=new stays")).toBe("a test word #k=new stays");
    // What Playwright throws when a page does not load: the address in the message, the call log apart.
    const timeout = Object.assign(new Error(`page.goto: Timeout 15000ms exceeded.\n  - navigating to "http://localhost:3242/classroom/L-1#k=${key}"`), { name: "TimeoutError", log: [`  - navigating to "http://localhost:3242/classroom/L-1#k=${key}"`] });
    const clean = withoutLinkKeys(timeout);
    expect(clean.message).toContain("#k=[redacted]");
    expect(clean.message).not.toContain(key);
    expect(clean.stack).not.toContain(key);
    expect(Object.keys(clean)).toEqual([]);
    const checks = (await readdir("tests")).filter((name) => /^classroom.*\.smoke\.mjs$/.test(name));
    for (const name of checks) {
      const text = await readFile(`tests/${name}`, "utf8");
      const writes = (text.match(/JSON\.stringify\(report, null, 2\)/g) ?? []).length;
      expect(writes, name).toBeGreaterThan(0);
      expect((text.match(/redactLinks\(JSON\.stringify\(report, null, 2\)\)/g) ?? []).length, name).toBe(writes);
      expect(text, name).not.toMatch(/throw failure\b|console\.error\(failure\)/);
    }
  });

  test("TA-2: no file the repository holds carries a whole link's key (behind #k= or ?k=)", () => {
    let found = "";
    try {
      // safe.directory: see TA-1 (GitHub CI's container).
      found = execFileSync("git", ["-c", "safe.directory=*", "grep", "-nIE", "[#?]k=[A-Za-z0-9_-]{43}"], { encoding: "utf8" });
    } catch (error) {
      // git grep answers 1 when nothing matches.
      if (error.status !== 1) throw error;
    }
    expect(found).toBe("");
  });
});
