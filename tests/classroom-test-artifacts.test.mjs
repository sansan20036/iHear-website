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
    const shown = execFileSync("git", ["grep", "-lE", "<code>", "--", "app/*.tsx"], { encoding: "utf8" }).trim().split("\n").map((line) => line.replace(/\\/g, "/")).sort();
    expect(shown).toEqual(["app/admin/classrooms/blocks/page.tsx", "app/admin/classrooms/page.tsx", "app/admin/classrooms/rooms/page.tsx", "app/admin/classrooms/schedule/page.tsx", "app/auth-error/auth-error-client.tsx"]);
  });

  test("TA-2: no file the repository holds carries a whole link's key (behind #k= or ?k=)", () => {
    let found = "";
    try {
      found = execFileSync("git", ["grep", "-nIE", "[#?]k=[A-Za-z0-9_-]{43}"], { encoding: "utf8" });
    } catch (error) {
      // git grep answers 1 when nothing matches.
      if (error.status !== 1) throw error;
    }
    expect(found).toBe("");
  });
});
