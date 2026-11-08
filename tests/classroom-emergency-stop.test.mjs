import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { apiToken, emergencyStop, parseArgs, sessionPathOf, sessionsFromData, settled } from "../tools/classroom-recording-test/emergency-stop.mjs";

// The independent emergency stop (2026-11-08), against a local stand-in for Zoom's REST API. Test
// keys only; the stand-in records what reaches it. It says nothing about real Zoom's answers.
const KEY = "test-api-key-not-real-0001";
const SECRET = "test-api-secret-not-real-0001";
const NOW = Date.parse("2026-11-29T08:30:00Z");
let dir;
let envFile;
let server;
let base;
const requests = [];
let answers = { PATCH: 202, PUT: 204, GET: 404 };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ihear-emergency-stop-"));
  envFile = path.join(dir, "zoom-recording.env");
  await writeFile(envFile, [
    "CLASSROOM_PROVIDER=zoom-video-sdk",
    "ZOOM_VIDEO_SDK_KEY=test-sdk-key-not-real-01",
    "ZOOM_VIDEO_SDK_SECRET=test-sdk-secret-not-real-01",
    `ZOOM_VIDEO_SDK_API_KEY=${KEY}`,
    `ZOOM_VIDEO_SDK_API_SECRET=${SECRET}`,
    "ZOOM_VIDEO_SDK_WEBHOOK_SECRET=test-webhook-secret-not-real",
  ].join("\n"));
  server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null, apiKey: request.headers["x-api-key"] ?? null, body });
      response.writeHead(answers[request.method] ?? 500, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise(resolve => { server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/v2`;
});
afterAll(async () => {
  await new Promise(resolve => { server.close(resolve); });
  await rm(dir, { recursive: true, force: true });
});

// A data folder as the test's server leaves it: one lesson with a confirmed session, a reported
// one, another lesson's (refused) and an ended one.
async function dataFolder(name) {
  const folder = path.join(dir, name);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(folder, { recursive: true });
  const event = (key, fields) => [key, { lessonId: "L-1", occurredAt: NOW, receivedAt: NOW, key, ...fields }];
  await writeFile(path.join(folder, "classroom.json"), JSON.stringify({
    lessons: [{ id: "L-1", code: "TEST-R1" }, { id: "L-2", code: "TEST-R2" }],
    events: Object.fromEntries([
      event("v", { source: "server", type: "server.session_verified", providerSessionId: "abc//def==", reportedSessionId: "abc//def==" }),
      event("r", { source: "host_sdk", type: "host.session", reportedSessionId: "/slash-first" }),
      event("x", { source: "host_sdk", type: "host.session", reportedSessionId: "another-lessons" }),
      event("x2", { source: "server", type: "server.session_rejected", reportedSessionId: "another-lessons" }),
      event("old", { source: "zoom_webhook", type: "session.started", providerSessionId: "ended-one" }),
      event("old2", { source: "zoom_webhook", type: "session.ended", providerSessionId: "ended-one" }),
      ["o", { lessonId: "L-2", source: "zoom_api", type: "api.snapshot", providerSessionId: "other-lesson-session", occurredAt: NOW, receivedAt: NOW, key: "o" }],
    ]),
  }));
  return folder;
}

describe("the independent emergency stop", () => {
  test("finds a lesson's confirmed and reported sessions, never a refused one, and an ended one only with --all", async () => {
    const folder = await dataFolder("find");
    const found = sessionsFromData(folder, { lesson: "TEST-R1" });
    expect(found).toEqual([
      { lessonCode: "TEST-R1", sessionId: "abc//def==", basis: "confirmed" },
      { lessonCode: "TEST-R1", sessionId: "/slash-first", basis: "reported" },
    ]);
    expect(sessionsFromData(folder, { lesson: "TEST-R1", all: true }).map(entry => entry.sessionId)).toContain("ended-one");
    expect(sessionsFromData(folder).map(entry => entry.lessonCode)).toEqual(["TEST-R1", "TEST-R1", "TEST-R2"]);
  });

  test("without --yes it lists what it would send and sends nothing", async () => {
    const folder = await dataFolder("dry");
    requests.length = 0;
    const lines = [];
    const outcome = await emergencyStop(parseArgs(["--env", envFile, "--data", folder, "--lesson", "TEST-R1", "--end", "--api-base", base]), { now: NOW, log: line => lines.push(line) });
    expect(outcome.sent).toBe(false);
    expect(requests).toEqual([]);
    expect(lines.join("\n")).toMatch(/nothing sent/);
  });

  test("with --yes --end: stop, end and a live check per session, with the site's token and Zoom's path encoding; nothing secret printed or kept", async () => {
    const folder = await dataFolder("send");
    requests.length = 0;
    answers = { PATCH: 202, PUT: 204, GET: 404 };
    const lines = [];
    const outcome = await emergencyStop(parseArgs(["--env", envFile, "--data", folder, "--lesson", "TEST-R1", "--yes", "--end", "--api-base", base]), { now: NOW, log: line => lines.push(line) });
    expect(outcome.sent).toBe(true);
    // "abc//def==" holds "//", "/slash-first" begins with "/": both encoded twice (the site's rule).
    const twice = id => encodeURIComponent(encodeURIComponent(id));
    expect(sessionPathOf("abc//def==")).toBe(twice("abc//def=="));
    expect(sessionPathOf("plain-id")).toBe("plain-id");
    expect(requests.map(entry => `${entry.method} ${entry.url}`)).toEqual([
      `PATCH /v2/videosdk/sessions/${twice("abc//def==")}/events`,
      `PUT /v2/videosdk/sessions/${twice("abc//def==")}/status`,
      `GET /v2/videosdk/sessions/${twice("abc//def==")}?type=live`,
      `PATCH /v2/videosdk/sessions/${twice("/slash-first")}/events`,
      `PUT /v2/videosdk/sessions/${twice("/slash-first")}/status`,
      `GET /v2/videosdk/sessions/${twice("/slash-first")}?type=live`,
    ]);
    expect(JSON.parse(requests[0].body)).toEqual({ method: "recording.stop" });
    expect(JSON.parse(requests[1].body)).toEqual({ action: "end" });
    // The token the site's adapter makes: HS256 over the API key, signed with the API secret.
    const token = requests[0].authorization.replace(/^Bearer /, "");
    const [head, payload, signature] = token.split(".");
    expect(createHmac("sha256", SECRET).update(`${head}.${payload}`).digest("base64url")).toBe(signature);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: KEY, exp: Math.floor(NOW / 1000) + 3600 });
    expect(token).toBe(apiToken(KEY, SECRET, NOW));
    expect(outcome.results.every(settled)).toBe(true);
    expect(outcome.results.map(result => [result.lessonCode, result.stop, result.end, result.stillLive])).toEqual([["TEST-R1", 202, 204, false], ["TEST-R1", 202, 204, false]]);
    // What it printed and the record it kept: codes, shortened ids and statuses only.
    const record = (await readdir(folder)).find(name => name.startsWith("emergency-stop-"));
    const kept = await readFile(path.join(folder, record), "utf8");
    for (const text of [lines.join("\n"), kept]) {
      for (const secret of [KEY, SECRET, token, "abc//def==", "/slash-first"]) expect(text).not.toContain(secret);
    }
  });

  test("Zoom's documented alternative: the API key in x-api-key, and no bearer token", async () => {
    requests.length = 0;
    await emergencyStop(parseArgs(["--env", envFile, "--session", "given-session", "--yes", "--auth", "api-key", "--api-base", base]), { now: NOW, log: () => {} });
    expect(requests.map(entry => [entry.method, entry.apiKey, entry.authorization])).toEqual([["PATCH", KEY, null], ["GET", KEY, null]]);
  });

  test("a stop Zoom only accepted (202), with the session still live, is NOT reported as done: 202 is not a confirmation", async () => {
    answers = { PATCH: 202, PUT: 204, GET: 200 };
    requests.length = 0;
    const lines = [];
    const outcome = await emergencyStop(parseArgs(["--env", envFile, "--session", "accepted-only", "--yes", "--api-base", base]), { now: NOW, log: line => lines.push(line) });
    expect(outcome.results).toMatchObject([{ stop: 202, end: null, stillLive: true }]);
    expect(settled(outcome.results[0])).toBe(false);
    expect(lines.join("\n")).toContain("202 (accepted, not a confirmation)");
    // Even an accepted end is not done while Zoom still reports the session live.
    expect(settled({ stop: 202, end: 204, stillLive: true })).toBe(false);
    expect(settled({ stop: 202, end: 204, stillLive: null })).toBe(false);
    answers = { PATCH: 202, PUT: 204, GET: 404 };
  });

  test("a stop Zoom refused, with the session still live and no end asked for, is not settled", async () => {
    answers = { PATCH: 400, PUT: 204, GET: 200 };
    requests.length = 0;
    const outcome = await emergencyStop(parseArgs(["--env", envFile, "--session", "still-live", "--yes", "--api-base", base]), { now: NOW, log: () => {} });
    expect(outcome.results).toMatchObject([{ stop: 400, end: null, stillLive: true }]);
    expect(settled(outcome.results[0])).toBe(false);
    answers = { PATCH: 202, PUT: 204, GET: 404 };
  });

  test("refuses to run without its inputs, to send a key anywhere but Zoom or the local stand-in, or with an env file inside the site", async () => {
    expect(() => parseArgs(["--data", dir])).toThrow(/--env/);
    expect(() => parseArgs(["--env", envFile])).toThrow(/--data|--session/);
    expect(() => parseArgs(["--env", envFile, "--session", "s", "--api-base", "https://example.invalid/v2"])).toThrow(/local stand-in/);
    expect(() => parseArgs(["--env", envFile, "--session", "s", "--auth", "basic"])).toThrow(/jwt or api-key/);
    const inside = path.join(process.cwd(), "data", "zoom.env");
    await expect(emergencyStop(parseArgs(["--env", inside, "--session", "s"]), { log: () => {} })).rejects.toThrow(/outside the repository/);
  });
});
