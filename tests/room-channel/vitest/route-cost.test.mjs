import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// What one request to the room channel's route costs when everything is on PostgreSQL: the
// request limit, the check of who is asking, and the channel itself (2026-11-23). A measurement,
// not a rule: it only fails when something does not work. A disposable local PostgreSQL that this
// file creates and removes; it never loads .env and never reaches a hosted database.
//   ROOM_CHANNEL_PG=1 npx vitest run tests/room-channel/vitest/route-cost.test.mjs
// Without ROOM_CHANNEL_PG=1 it does nothing. It says nothing about the production site: there the
// database is elsewhere and every statement is a trip over a network.
const asked = process.env.ROOM_CHANNEL_PG === "1";
vi.mock("../../../auth.js", () => ({ auth: vi.fn() }));

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const container = `ihear-room-channel-route-${randomUUID()}`;
const password = "isolated-room-channel-route-only";
const docker = args => execFileSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
const ORIGIN = "http://localhost:3000";
const START = Date.now();
const OWNER = { email: "rooms-owner@example.test", owner: true };
const spread = values => { const sorted = [...values].sort((a, b) => a - b); const at = share => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] * 10) / 10; return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) }; };
let started = false, counter = null;

describe.skipIf(!asked)("the room channel's route on PostgreSQL: what a request costs", () => {
  let channelRoute, rooms, store, drive, sql;
  beforeAll(async () => {
    docker(["run", "--detach", "--pull=never", "--name", container, "--label", "ihear-test=room-channel", "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${password}`, "postgres:17-alpine"]);
    started = true;
    const port = docker(["port", container, "5432/tcp"]).match(/^127\.0\.0\.1:(\d+)$/m)?.[1];
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    const { default: postgres } = await import("postgres");
    sql = postgres(url, { ssl: false, max: 2, prepare: false, connect_timeout: 3, onnotice: () => {} });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) { try { await sql`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 500); }); } }
    expect(ready).toBe(true);
    const files = readdirSync(path.join(ROOT, "db", "migrations")).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name) && name.split("_", 1)[0] <= "030").sort();
    for (const name of files) await sql.begin(tx => tx.unsafe(readFileSync(path.join(ROOT, "db", "migrations", name), "utf8")));
    await sql.begin(tx => tx.unsafe(readFileSync(path.join(ROOT, "db", "room-channel", "031_classroom_room_channel.sql"), "utf8")));
    // How many statements the database is sent, whoever sends them: its own count of calls.
    await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`.catch(() => undefined);
    counter = async () => Number((await sql`SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()`)[0].n);
    vi.stubEnv("POSTGRES_URL", url);
    vi.stubEnv("POSTGRES_SSL", "disable");
    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "");
    vi.stubEnv("CLASSROOM_DRIVE", "local");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("CLASSROOM_FIXED_ROOMS", "on");
    for (const name of ["CLASSROOM_ROOM_BOARD", "CLASSROOM_ROOM_CHAT", "CLASSROOM_ROOM_SHARE_TURN"]) vi.stubEnv(name, "on");
    ({ classroomStore: store } = await import("../../../lib/classroom-store"));
    store = store();
    drive = (await import("../../../lib/classroom-drive")).classroomDrive();
    rooms = await import("../../../lib/classroom-fixed-rooms");
    channelRoute = await import("../../../app/api/classroom/[lessonId]/room-channel/route");
  }, 180_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    if (started) { try { docker(["rm", "--force", "--volumes", container]); } catch { /* shown by docker ps */ } }
  });

  test("a look and a stroke through the route: time, and how many times the database is asked", async () => {
    const provider = { name: "synthetic", webhookSecret: null, sessionToken: () => ({ token: "x", issuedAt: 0, expiresAt: 0 }), startRecording: async () => ({ ok: true, httpStatus: 202 }), stopRecording: async () => ({ ok: true, httpStatus: 202 }), endSession: async () => ({ ok: true, httpStatus: 204 }), removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, observe: async () => ({ live: false, recording: null }), download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }) };
    const manage = (action, input = {}) => rooms.manageFixedRoom({ store, provider, drive, principal: OWNER, action, input, now: Date.now() });
    const created = await manage("create", { label: "Cost 1" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const room = { id: created.body.room.id, key: new URLSearchParams(created.body.link.split("#")[1]).get("k") };
    const people = [];
    for (const name of ["Kyle", "Ann", "Bo"]) {
      const request = await rooms.requestEntry({ store, roomId: room.id, key: room.key, name, now: Date.now() });
      expect((await manage("admit", { room: room.id, request: request.body.requestId })).status).toBe(200);
      people.push({ ticket: request.body.ticket, requestId: request.body.requestId });
    }
    const lessonId = (await rooms.requestStatus({ store, roomId: room.id, requestId: people[0].requestId, ticket: people[0].ticket, now: Date.now() })).body.lessonId;
    const post = async body => {
      const began = performance.now();
      const response = await channelRoute.POST(new Request(`${ORIGIN}/api/classroom/${lessonId}/room-channel`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "203.0.113.10" }, body: JSON.stringify(body) }), { params: Promise.resolve({ lessonId }) });
      const answer = await response.json();
      return { status: response.status, answer, ms: performance.now() - began };
    };
    // Warm up (connections, first plans), then measure one after another: nothing else is asking.
    // The very first request of a new server process is answered 503 by the several-bucket request
    // limit (lib/rate-limit.ts: a new database client's first query cannot carry an array with the
    // client library in use; found by this measurement, 2026-11-24). It is counted here, not hidden.
    let firstRefused = 0;
    for (let n = 0; n < 10; n += 1) { const warm = await post({ key: people[0].ticket, cursors: { board: 0, chat: 0, turn: 0 } }); if (n === 0 && warm.status === 503) firstRefused += 1; else expect(warm.status, JSON.stringify(warm.answer)).toBe(200); }
    // The database counts its own transactions (a statement sent alone is one; BEGIN…COMMIT is one),
    // but an idle connection hands its count in only after about ten seconds: so wait before reading.
    const settled = async () => { await new Promise(resolve => { setTimeout(resolve, 11_500); }); return counter(); };
    const measure = async (count, make) => {
      const before = await settled();
      const times = [];
      for (let n = 0; n < count; n += 1) { const result = await post(make(n)); expect(result.status, JSON.stringify(result.answer)).toBe(200); times.push(result.ms); }
      // The counter's own first reading is one transaction: taken off.
      return { ...spread(times), databaseTransactionsEach: Math.round(((await settled()) - before - 1) / count * 10) / 10 };
    };
    let seq = 0;
    const look = await measure(150, () => ({ key: people[1].ticket, cursors: { board: seq, chat: 0, turn: 0 } }));
    const write = await measure(150, n => ({ key: people[0].ticket, cursors: { board: n }, send: [{ part: "board", input: { kind: "stroke", op: `s${n}`, line: `l${n}`, part: 0, points: [[n, n], [n + 5, n + 5]], color: 1, width: 2, done: true } }] }));
    seq = 150;
    const result = { measuredAt: new Date(START).toISOString(), what: "one person after another, through the route's own code (no HTTP server, no Next.js), on a disposable local PostgreSQL", firstRequestOfTheProcessRefusedByTheLimit: firstRefused, lookMs: look, strokeMs: write };
    console.log(`ROUTE COST ${JSON.stringify(result)}`);
    if (process.env.ROOM_CHANNEL_COST_OUT) writeFileSync(process.env.ROOM_CHANNEL_COST_OUT, `${JSON.stringify(result, null, 2)}\n`);
    expect(look.n).toBe(150);
  }, 300_000);
});
