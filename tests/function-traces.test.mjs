import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLASSROOM_BUDGET_BYTES, functionTraces, traceProblems } from "../scripts/check-function-traces.mjs";

// P4-B1: a built site's function traces (as Vercel packages them) must not carry what only a
// whole-project trace adds. The checker runs on the real build in `npm run check`; here it runs on
// small made-up builds, so it is known to catch the problem and to pass a clean build.
const sites = [];
afterEach(() => { for (const site of sites.splice(0)) rmSync(site, { recursive: true, force: true }); });

function builtSite(functions) {
  const site = mkdtempSync(path.join(os.tmpdir(), "ihear-traces-"));
  sites.push(site);
  const put = (file, bytes = 10) => { mkdirSync(path.dirname(path.join(site, file)), { recursive: true }); writeFileSync(path.join(site, file), "x".repeat(bytes)); };
  for (const [route, files] of Object.entries(functions)) {
    const fnFile = path.join(".next", "server", "app", route);
    put(fnFile);
    for (const file of files) put(file);
    const relative = files.map((file) => path.relative(path.dirname(path.join(site, fnFile)), path.join(site, file)).split(path.sep).join("/"));
    writeFileSync(path.join(site, `${fnFile}.nft.json`), JSON.stringify({ version: 1, files: relative }));
  }
  return site;
}

const CLEAN = [".next/server/chunks/route.js", "node_modules/next/dist/server.js", "data/classroom-entry.json", ".private/index.html"];

describe("function traces (P4-B1)", () => {
  it("passes functions that carry only what they use", () => {
    const site = builtSite({ "api/recordings/zoom/webhook/route.js": CLEAN, "api/site-media/[slot]/route.js": [...CLEAN, "public/assets/images/hero.jpg"] });
    const functions = functionTraces(site);
    expect(functions.map((fn) => fn.route).sort()).toEqual(["api/recordings/zoom/webhook/route.js", "api/site-media/[slot]/route.js"]);
    expect(functions.find((fn) => fn.route.startsWith("api/recordings")).files).toContain("data/classroom-entry.json");
    expect(traceProblems(functions)).toEqual([]);
  });

  it("names a function that carries the whole project (tests, docs, scripts, the lockfile)", () => {
    for (const stray of ["tests/classroom-api.test.mjs", "docs/notes.md", "scripts/dev.mjs", "package-lock.json", "postman/collection.json"]) {
      const site = builtSite({ "api/recordings/zoom/webhook/route.js": [...CLEAN, stray] });
      const problems = traceProblems(functionTraces(site));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^api\/recordings\/zoom\/webhook\/route\.js carries 1 file/);
      expect(problems[0]).toContain(stray);
    }
  });

  it("allows public/ only in the media routes that serve it", () => {
    const site = builtSite({ "api/classroom/[lessonId]/join/route.js": [...CLEAN, "public/assets/vendor/avatar-segmentation/model.wasm"], "api/media-galleries/[id]/route.js": [...CLEAN, "public/assets/images/a.webp"] });
    const problems = traceProblems(functionTraces(site));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^api\/classroom\/\[lessonId\]\/join\/route\.js carries/);
  });

  it("holds every classroom function to its size budget, and only classroom functions", () => {
    const site = builtSite({ "api/admin/classrooms/tick/route.js": CLEAN, "api/team-profiles/route.js": CLEAN });
    const functions = functionTraces(site);
    expect(traceProblems(functions, { classroomBudgetBytes: 20 })).toEqual([expect.stringMatching(/^api\/admin\/classrooms\/tick\/route\.js carries .* over the classroom budget/)]);
    expect(traceProblems(functions)).toEqual([]);
    expect(CLASSROOM_BUDGET_BYTES).toBe(8 * 1024 * 1024);
  });

  it("refuses a folder that has not been built", () => {
    const site = mkdtempSync(path.join(os.tmpdir(), "ihear-traces-"));
    sites.push(site);
    expect(() => functionTraces(site)).toThrow(/No build found/);
  });
});
