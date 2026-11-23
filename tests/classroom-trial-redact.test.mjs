import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import { makeRedactor } from "../tools/classroom-trial/redact.mjs";

// W1 review (2026-11-23): the trial tools' one rule for what must not leak. The finding: a browser
// error that quoted a socket address (wss://…?…) kept its query in report.json, because the old copies
// hid a query only after http(s)://, and the report itself was never checked. All values below are
// made up for the test.
const SECRET = "S3cr3tValueForTheTest0123456789";
const make = (extra = []) => {
  const hidden = new Set([SECRET, ...extra]);
  return { hidden, ...makeRedactor({ secrets: [SECRET], hidden }) };
};

describe("redact: nothing that can carry a credential is kept", () => {
  test("RD-1: a socket address keeps only its host (path, query and fragment go), for wss:// and ws://", () => {
    const { redact } = make();
    const line = "WebSocket connection to 'wss://zoomsjc1.cloud.zoom.us/wc/media/123456?type=m&cid=AbCdEf012345&rwcAuth=Zm9vYmFyYmF6cXV4MTIz' failed";
    const out = redact(line);
    expect(out).toContain("wss://zoomsjc1.cloud.zoom.us/[hidden]");
    for (const gone of ["rwcAuth", "Zm9vYmFyYmF6cXV4MTIz", "AbCdEf012345", "/wc/media"]) expect(out).not.toContain(gone);
    expect(redact("ws://127.0.0.1:9000/socket/abc?t=0123456789abcdef")).toBe("ws://127.0.0.1:9000/[hidden]");
  });

  test("RD-2: any other address keeps its path but not its query or fragment", () => {
    const { redact } = make();
    expect(redact("https://source.zoom.us/2.6.0/lib/av/x.js?sig=abcdefgh12345")).toBe("https://source.zoom.us/2.6.0/lib/av/x.js?[hidden]");
    expect(redact("http://localhost:3330/classroom/r/FR-0123#k=abcdefghijklmnopqrstuvwxyz")).toBe("http://localhost:3330/classroom/r/FR-0123?[hidden]");
    expect(redact("blob:https://example.test/abc?x=1")).toContain("?[hidden]");
    // Not only http(s): any scheme's query and fragment go, also short ones the parameter rule keeps.
    expect(redact("chrome-extension://abcdefgh/page.html?a=1#frag")).toBe("chrome-extension://abcdefgh/page.html?[hidden]");
  });

  test("RD-3: a parameter's long value is hidden anywhere in the text; a short one stays", () => {
    const { redact } = make();
    const out = redact("join failed: token=abcdefgh12345 and k=0123456789abcdef, n=12, size: 20");
    expect(out).toBe("join failed: token=[hidden] and k=[hidden], n=12, size: 20");
  });

  test("RD-4: secrets and the run's tokens become [hidden], the longest first; a JWT-shaped value becomes [token]", () => {
    const { redact, hidden } = make(["abc12345"]);
    hidden.add("abc12345XYZ987");
    expect(redact("a abc12345XYZ987 b abc12345 c")).toBe("a [hidden] b [hidden] c");
    expect(redact(`x ${SECRET} y`)).toBe("x [hidden] y");
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjowfQ.c2lnbmF0dXJlMDEyMw")).toBe("[token]");
  });
});

describe("leaks and residue: what the tools count as found", () => {
  test("RD-5: leaks finds a secret, plain or inside a token's base64url parts, and nothing else", () => {
    const { leaks } = make();
    expect(leaks(`before ${SECRET} after`)).toBe(true);
    const claims = Buffer.from(JSON.stringify({ key: SECRET })).toString("base64url");
    expect(leaks(`eyJhbGciOiJIUzI1NiJ9.${claims}.c2lnbmF0dXJlMDEyMw`)).toBe(true);
    expect(leaks("nothing to see here, wss://host/[hidden]")).toBe(false);
  });

  test("RD-6: residue flags what redaction must have removed, and passes a redacted report", () => {
    const { redact, residue } = make();
    const raw = "Zoom: WebSocket wss://zoom.example/wc?rwcAuth=Zm9vYmFyYmF6cXV4MTIz closed; retry token=abcdefgh12345";
    expect(residue(raw)).toBe(true);
    expect(residue(redact(raw))).toBe(false);
    expect(residue("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjowfQ.c2lnbmF0dXJlMDEyMw")).toBe(true);
    const report = { participantMinutes: 3.2, hosts: ["127.0.0.1:3331", "source.zoom.us"], consoleProblems: [redact(raw)], findings: { reconnectSeconds: 14 } };
    expect(residue(JSON.stringify(report, null, 2))).toBe(false);
  });

  test("RD-7: the old rule's gap is closed: before this module a wss:// query was kept", () => {
    const oldRedact = (text) => String(text).replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/g, "$1?[hidden]");
    const line = "wss://zoom.example/wc/media?rwcAuth=Zm9vYmFyYmF6cXV4MTIz";
    expect(oldRedact(line)).toContain("Zm9vYmFyYmF6cXV4MTIz");
    expect(make().redact(line)).not.toContain("Zm9vYmFyYmF6cXV4MTIz");
  });
});

describe("both trial tools use this one rule", () => {
  test("RD-8: fixed-room-check and local-join-check import redact.mjs, keep no copy of their own, and check the report and the server log before writing them", async () => {
    for (const name of ["fixed-room-check.mjs", "local-join-check.mjs"]) {
      const source = await readFile(`tools/classroom-trial/${name}`, "utf8");
      expect(source, name).toContain("from './redact.mjs'");
      expect(source, name).not.toMatch(/const redact = text =>/);
      expect(source, name).not.toMatch(/const TOKEN = \//);
      expect(source, name).toMatch(/residue\(JSON\.stringify\(report\)\)\) found\.reportFile \+= 1/);
      expect(source, name).toMatch(/residue\(serverLog\)\) found\.serverOutput \+= 1/);
      expect(source.indexOf("residue(JSON.stringify(report))"), name).toBeLessThan(source.indexOf("writeFileSync(path.join(runDir, 'report.json')"));
    }
  });

  test("RD-9: on real Zoom a person counts from being let in; someone who never connects stops counting", async () => {
    const source = await readFile("tools/classroom-trial/fixed-room-check.mjs", "utf8");
    const letIn = source.indexOf("name: '讓他進入', exact: true }).click();");
    expect(letIn).toBeGreaterThan(0);
    expect(source.slice(letIn, letIn + 600)).toContain("if (!rehearsal) markConnected(who);");
    expect(source).toMatch(/error => \{ markGone\(who\); report\.findings\[`\$\{who\}Connect`\] = 'did not connect';/);
  });

  test("RD-10: after a removal the others must have moved to the room's new session (data-room-moves) before 已連線 counts; a few seconds pass before the owner ends a real lesson", async () => {
    const source = await readFile("tools/classroom-trial/fixed-room-check.mjs", "utf8");
    const removal = source.slice(source.indexOf("TestC is taken out"), source.indexOf("the owner ends the lesson: everyone leaves"));
    expect(removal).toContain("getAttribute('data-room-moves')");
    expect(removal).toMatch(/expect\.poll\(\(\) => movesOf\(who\), \{ timeout: 90_000 \}\)\.toBeGreaterThan\(before\[who\]\)/);
    expect(removal).toContain("throw new Error('not everyone left in the room moved to its new session')");
    const end = source.slice(source.indexOf("the owner ends the lesson: everyone leaves"));
    expect(end.indexOf("if (!rehearsal) await pause(5_000);")).toBeGreaterThan(0);
    expect(end.indexOf("if (!rehearsal) await pause(5_000);")).toBeLessThan(end.indexOf("'結束這次上課' }).click()"));
  });

  // W1 re-test (2026-11-23): the limits may be lowered for a shorter run, never raised, and a bad value
  // stops the tool before anything starts (no folder, no server, no browser).
  // Every run here has --check-args: even if a limit check were broken, nothing would start.
  // Round 15 (2026-11-24): the test runs the tool 7 times (each loads Playwright first), which took
  // 7.5 s under a full regression's load and passed vitest's 5 s default. So the test as a whole may
  // take 2 minutes, while each run is still held to its own 30 s and must END BY ITSELF with exactly
  // the expected exit code: a run that hangs (killed by the timeout: error and signal set), crashes,
  // or exits otherwise fails here. A longer wait therefore hides nothing.
  test("RD-11: --limit-minutes and --limit-participant-minutes take only a value above 0 and at most 18 and 55; anything else stops the tool before it starts; --check-args says the limits and starts nothing", () => {
    const run = (...words) => spawnSync(process.execPath, ["tools/classroom-trial/fixed-room-check.mjs", "--rehearsal", "--check-args", ...words], { encoding: "utf8", timeout: 30_000 });
    const endedByItself = (answer, label) => {
      expect(answer.error, label).toBeUndefined();
      expect(answer.signal, label).toBeNull();
    };
    for (const [name, value, most] of [["limit-minutes", "19", 18], ["limit-minutes", "0", 18], ["limit-minutes", "abc", 18], ["limit-participant-minutes", "56", 55], ["limit-participant-minutes", "-1", 55]]) {
      const answer = run(`--${name}`, value);
      endedByItself(answer, `${name} ${value}`);
      expect(answer.status, `${name} ${value}`).toBe(1);
      expect(`${answer.stdout}${answer.stderr}`, `${name} ${value}`).toContain(`--${name} takes more than 0 and at most ${most}`);
      expect(`${answer.stdout}${answer.stderr}`, `${name} ${value}`).not.toContain("arguments OK");
    }
    const lowered = run("--limit-minutes", "6", "--limit-participant-minutes", "18", "--removal-only");
    endedByItself(lowered, "lowered");
    expect(lowered.status).toBe(0);
    expect(lowered.stdout).toContain("arguments OK: rehearsal; limits 6 minutes, 18 participant-minutes; steps removal only. Nothing was started.");
    const defaults = run();
    endedByItself(defaults, "defaults");
    expect(defaults.status).toBe(0);
    expect(defaults.stdout).toContain("limits 18 minutes, 55 participant-minutes; steps all.");
  }, 120_000);

  test("RD-12: the limits are read before the run's folder is made; --removal-only skips exactly the five optional real steps and keeps the door, connecting, the removal and the end", async () => {
    const source = await readFile("tools/classroom-trial/fixed-room-check.mjs", "utf8");
    expect(source).toContain("lowered('limit-minutes', 18) * 60_000");
    expect(source).toContain("const LIMIT_PARTICIPANT_MINUTES = lowered('limit-participant-minutes', 55);");
    expect(source.indexOf("lowered('limit-participant-minutes', 55)")).toBeLessThan(source.indexOf("mkdirSync(runDir"));
    expect(source.split("await optional('").length - 1).toBe(5);
    for (const name of ["Zoom\\'s version in the page", "whiteboard: who has the button, and whether it opens for the others", "sharing: TestA shares, TestB\\'s share waits, TestA stops", "a dropped connection comes back (TestA offline 10 seconds)", "TestB leaves and enters again without being let in again"]) {
      expect(source, name).toContain(`await optional('${name}'`);
    }
    for (const kept of ["the three ask at the door, wait, are let in by the owner and enter", "the three connect to the real Zoom session", "TestC is taken out: their page leaves; the others move to a new session and come back", "the owner ends the lesson: everyone leaves"]) {
      expect(source, kept).toContain(`await check('${kept}'`);
    }
    expect(source).toContain("if (!removalOnly) return check(name, action, options);");
  });
});
