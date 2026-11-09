import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { blockManageView, blockWhere, createClassroomBlock, manageBlock } from '../lib/classroom-blocks';
import { joinClassroom } from '../lib/classroom-service';
import { createPostgresClassroomStore } from '../lib/classroom-store';
import { buildSessionTokenClaims, signSessionToken } from '../tools/recording-pathway/classroom/eligibility.mjs';

// P3-Multi B4 (2026-11-09): load on PostgreSQL from the members' "where am I" questions and from
// entering, on a localhost-only disposable PostgreSQL 17 (draft 029 applied here only), with the
// server's pool held to 15 connections like the production pool. It counts the database queries
// each kind of request makes and times requests one by one and under concurrency. Synthetic data
// only. What it measures is this machine, not Supabase: the report extrapolates with stated
// assumptions. Run by itself: npm run test:classroom:multi-load (Docker needed).
const container = `ihear-load-${randomUUID()}`;
const password = 'isolated-load-test-only';
const MIN = 60_000;
const BLOCKS = 6, ROOMS = 4, STUDENTS = 30;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let started = false, port, workspace, root;
const clients = [];
let queries = 0;
const url = database => `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
const results = { startedAt: new Date().toISOString(), synthetic: true, pool: 15, blocks: BLOCKS, roomsPerBlock: ROOMS, studentsPerBlock: STUDENTS, scenarios: {} };

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=classroom-load', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  root = postgres(url('postgres'), { ssl: false, max: 2, prepare: false, connect_timeout: 2, onnotice: () => {} });
  clients.push(root);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await root`SELECT 1`; break; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  await root.unsafe('CREATE DATABASE classroom_load');
  workspace = await mkdtemp(path.join(os.tmpdir(), 'ihear-load-migrations-'));
  await mkdir(path.join(workspace, 'db', 'migrations'), { recursive: true });
  for (const file of (await readdir('db/migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name))) await copyFile(path.join('db', 'migrations', file), path.join(workspace, 'db', 'migrations', file));
  const migrated = spawnSync(process.execPath, [path.resolve('scripts/migrate-database.mjs')], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), POSTGRES_URL: url('classroom_load'), DATABASE_URL: '', POSTGRES_SSL: 'disable' },
  });
  if (migrated.status !== 0) throw new Error(`Migration runner failed: ${migrated.stderr}`);
  const setup = postgres(url('classroom_load'), { ssl: false, max: 2, prepare: false, onnotice: () => {} });
  clients.push(setup);
  await setup.unsafe(await readFile(path.join('db', 'multiroom', '029_classroom_multiroom.sql'), 'utf8'));
}, 180000);

afterAll(async () => {
  results.finishedAt = new Date().toISOString();
  await mkdir('output/load', { recursive: true });
  await writeFile(path.join('output', 'load', 'classroom-multi-load.json'), `${JSON.stringify(results, null, 2)}\n`);
  for (const client of clients) await client.end({ timeout: 2 });
  if (started) docker(['rm', '--force', '--volumes', container]);
  if (workspace && (await realpath(workspace)).startsWith(await realpath(os.tmpdir()))) await rm(workspace, { recursive: true, force: true });
}, 60000);

const provider = {
  name: 'synthetic', webhookSecret: null,
  sessionToken: ({ lesson, participant, now, generation = 0 }) => ({ token: signSessionToken(buildSessionTokenClaims({ lesson, participant, appKey: 'load', now, generation }), 'load-secret-not-real'), issuedAt: now, expiresAt: now + 30 * MIN }),
  startRecording: async () => ({ ok: true, httpStatus: 202 }), stopRecording: async () => ({ ok: true, httpStatus: 202 }), endSession: async () => ({ ok: true, httpStatus: 204 }),
  removeUser: async () => ({ ok: false, httpStatus: 501 }), snapshot: async () => null, download: async () => Buffer.alloc(0), deleteRecording: async () => ({ ok: false, httpStatus: 501 }),
};
const drive = { kind: 'local', rootFolderId: 'root' };
const START = Date.parse('2026-12-01T08:00:00Z');
// Production runs the functions in Vercel's default region (no region set in vercel.json: iad1,
// Washington) against the database in Tokyo; every query then waits one network round trip. A
// localhost proxy that holds each packet for half of RTT_MS in each direction stands in for that
// distance (RTT_MS is an assumption, 推測, not a measurement of production).
const RTT_MS = Number(process.env.IHEAR_LOAD_RTT_MS || 150);
const INSTANCES = 4;
async function latencyProxy(targetPort, oneWayMs) {
  const sockets = new Set();
  const server = net.createServer(client => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client); sockets.add(upstream);
    const pipe = (from, to) => from.on('data', chunk => { setTimeout(() => { if (!to.destroyed) to.write(chunk); }, oneWayMs); });
    pipe(client, upstream); pipe(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) { socket.on('error', close); socket.on('close', close); }
  });
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => { server.close(resolve); }); } };
}
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10 : null; };
const summary = times => ({ count: times.length, p50: percentile(times, 50), p95: percentile(times, 95), p99: percentile(times, 99), max: Math.round(Math.max(...times) * 10) / 10 });

describe('P3-Multi load on PostgreSQL (B4)', () => {
  test('blocks of 30 students: queries per request, latency one by one and under load, mass entry and a reconnect storm', async () => {
    // The server's pool, as in production: 15 connections; every query counted.
    const sql = postgres(url('classroom_load'), { ssl: false, max: 15, prepare: false, onnotice: () => {}, debug: () => { queries += 1; } });
    clients.push(sql);
    const store = createPostgresClassroomStore(sql);
    const blocks = [];
    for (let b = 1; b <= BLOCKS; b += 1) {
      const code = `TEST-LOAD${b}`;
      const labels = Array.from({ length: ROOMS }, (_, index) => `R${index + 1}`);
      const members = [{ code: `${code}-M`, role: 'manager', englishName: 'Mia Manager', email: `load-m${b}@example.test` },
        ...labels.map((label, index) => ({ code: `${code}-T${index + 1}`, role: 'lead_tutor', englishName: `Tutor ${String.fromCharCode(65 + index)}`, email: `load-t${b}-${index + 1}@example.test` })),
        ...Array.from({ length: STUDENTS }, (_, index) => ({ code: `${code}-S${index + 1}`, role: 'student', englishName: `Student ${String.fromCharCode(65 + (index % 26))}${index >= 26 ? String.fromCharCode(65 + Math.floor(index / 26)) : ''}` }))];
      const assignments = [...labels.map((label, index) => ({ member: `${code}-T${index + 1}`, room: label })), ...Array.from({ length: STUDENTS }, (_, index) => ({ member: `${code}-S${index + 1}`, room: labels[index % ROOMS] }))];
      // 30 students in 4 rooms would be 8 per room with the tutor: within 10.
      const created = await createClassroomBlock({ store, actor: 'load-owner@example.test', now: START - 60 * MIN, input: { code, date: '2026-12-01', time: '16:00', minutes: 60, rooms: labels, members, assignments } });
      const block = await store.block(created.block.blockId);
      const manager = { email: `load-m${b}@example.test`, owner: false };
      await joinClassroom({ store, provider, lessonId: block.lobbyId, sessionEmail: manager.email, now: START });
      for (const [action, input] of [['open_lobby', {}], ['start_breakout', { confirm: true }]]) {
        await manageBlock({ store, provider, drive, blockId: block.id, principal: manager, action, input: { version: (await store.block(block.id)).version, ...input }, now: START });
      }
      blocks.push({ block, keys: created.studentLinks.map(entry => new URLSearchParams(entry.link.split('#')[1]).get('k')) });
    }
    const statusesOf = list => Object.fromEntries([...new Set(list)].map(status => [status, list.filter(entry => entry === status).length]));
    const measure = async (name, fn, count) => {
      const before = queries;
      const times = [];
      const statuses = [];
      for (let i = 0; i < count; i += 1) { const t = performance.now(); statuses.push((await fn(i)).status); times.push(performance.now() - t); }
      results.scenarios[name] = { ...summary(times), queriesPerRequest: Math.round(((queries - before) / count) * 10) / 10, statuses: statusesOf(statuses) };
    };
    const { block, keys } = blocks[0];
    await measure('full where (one by one)', i => blockWhere({ store, blockId: block.id, key: keys[i % keys.length], now: START + MIN }), 60);
    const version = (await store.block(block.id)).version;
    await measure('cheap where (one by one)', i => blockWhere({ store, blockId: block.id, key: keys[i % keys.length], since: version, now: START + MIN }), 60);
    // Student k sits in room k mod 4.
    await measure('join a room (one by one)', i => joinClassroom({ store, provider, lessonId: block.roomIds[i % keys.length % ROOMS], key: keys[i % keys.length], now: START + MIN }), 30);
    const manager = { email: 'load-m1@example.test', owner: false };
    await measure('manager console (one by one)', () => blockManageView({ store, blockId: block.id, principal: manager, now: START + MIN }), 20);

    // Steady polling: every member of every block asking at once, one full answer per five.
    const everyone = blocks.flatMap(({ block: item, keys: list }) => list.map((key, index) => ({ blockId: item.id, key, roomId: item.roomIds[index % ROOMS] })));
    const versions = new Map(await Promise.all(blocks.map(async ({ block: item }) => [item.id, (await store.block(item.id)).version])));
    const concurrent = async (name, calls) => {
      const before = queries;
      const times = [];
      const errors = [];
      const statuses = [];
      const t0 = performance.now();
      await Promise.all(calls.map(async call => {
        const t = performance.now();
        try { const answer = await call(); statuses.push(answer.status); if (answer.status !== 200) errors.push(answer.body?.code ?? answer.status); } catch (error) { errors.push(String(error.message ?? error).slice(0, 80)); }
        times.push(performance.now() - t);
      }));
      const seconds = (performance.now() - t0) / 1000;
      results.scenarios[name] = { ...summary(times), wallSeconds: Math.round(seconds * 100) / 100, requestsPerSecond: Math.round(calls.length / seconds), queries: queries - before, statuses: statusesOf(statuses), errors: [...new Set(errors)].slice(0, 5) };
      return errors;
    };
    expect(await concurrent(`steady polling: ${everyone.length} members at once (1 full in 5)`, everyone.map((entry, index) => () => blockWhere({ store, blockId: entry.blockId, key: entry.key, ...(index % 5 ? { since: versions.get(entry.blockId) } : {}), now: START + MIN })))).toEqual([]);
    // Mass entry: one block's 30 students entering their rooms in the same moment.
    expect(await concurrent('mass entry: 30 students of one block join at once', keys.map((key, index) => () => joinClassroom({ store, provider, lessonId: blocks[1].block.roomIds[index % ROOMS], key: blocks[1].keys[index], now: START + MIN })))).toEqual([]);
    // Reconnect storm: every student everywhere loses the connection at once and comes back: a full
    // question and a fresh entry each (a new token), all in the same moment.
    expect(await concurrent(`reconnect storm: ${everyone.length} students ask fully and join again at once`, everyone.flatMap(entry => [
      () => blockWhere({ store, blockId: entry.blockId, key: entry.key, now: START + 2 * MIN }),
      () => joinClassroom({ store, provider, lessonId: entry.roomId, key: entry.key, now: START + 2 * MIN }),
    ]))).toEqual([]);
    // Safety under load: a link revoked in the middle of a storm stops that student at the next door.
    const target = blocks[2];
    const revoked = target.block.members.find(member => member.code === 'TEST-LOAD3-S1');
    const managerOf3 = { email: 'load-m3@example.test', owner: false };
    const storm = everyone.filter(entry => entry.blockId !== target.block.id).map(entry => () => blockWhere({ store, blockId: entry.blockId, key: entry.key, now: START + 3 * MIN }));
    const [revoke] = await Promise.all([
      manageBlock({ store, provider, drive, blockId: target.block.id, principal: managerOf3, action: 'revoke_link', input: { version: (await store.block(target.block.id)).version, member: revoked.code }, now: START + 3 * MIN }),
      ...storm.map(call => call()),
    ]);
    expect(revoke.status).toBe(200);
    expect((await joinClassroom({ store, provider, lessonId: target.block.roomIds[0], key: target.keys[0], now: START + 3 * MIN })).status).toBe(403);
    expect((await blockWhere({ store, blockId: target.block.id, key: target.keys[0], now: START + 3 * MIN })).status).toBe(403);
    // The cheap question no longer says "unchanged" to anyone in that block: the version moved.
    expect((await blockWhere({ store, blockId: target.block.id, key: target.keys[1], since: versions.get(target.block.id), now: START + 3 * MIN })).body.unchanged).toBeUndefined();

    // The same requests across a long round trip (RTT_MS), from INSTANCES server instances that each
    // hold 3 connections, as lib/classroom-store.ts does (max: 3).
    const proxy = await latencyProxy(Number(port), RTT_MS / 2);
    let pools = [];
    try {
      pools = Array.from({ length: INSTANCES }, () => postgres(`postgres://postgres:${password}@127.0.0.1:${proxy.port}/classroom_load`, { ssl: false, max: 3, prepare: false, onnotice: () => {}, debug: () => { queries += 1; } }));
      await Promise.all(pools.flatMap(pool => [pool`SELECT 1`, pool`SELECT 1`, pool`SELECT 1`]));
      const far = pools.map(pool => createPostgresClassroomStore(pool));
      // Calibration: postgres.js with prepare: false (as production, behind the transaction pooler)
      // first asks the server to describe any query with parameters, then runs it: two round trips.
      const calibrate = async (name, fn) => { const t = performance.now(); for (let i = 0; i < 5; i += 1) await fn(); results.calibration[name] = Math.round((performance.now() - t) / 5); };
      results.calibration = {};
      await calibrate('ms per query without parameters', () => pools[0]`SELECT 1`);
      await calibrate('ms per query with parameters', () => pools[0]`SELECT ${'x'}::text AS v`);
      const tag = name => `${name} — RTT ${RTT_MS} ms, ${INSTANCES}×3 connections`;
      const one = blocks[3];
      const v3 = (await far[0].block(one.block.id)).version;
      await measure(tag('full where (one by one)'), i => blockWhere({ store: far[0], blockId: one.block.id, key: one.keys[i], now: START + 4 * MIN }), 8);
      await measure(tag('cheap where (one by one)'), i => blockWhere({ store: far[0], blockId: one.block.id, key: one.keys[i], since: v3, now: START + 4 * MIN }), 8);
      await measure(tag('join a room (one by one)'), i => joinClassroom({ store: far[0], provider, lessonId: one.block.roomIds[i % ROOMS], key: one.keys[i], now: START + 4 * MIN }), 8);
      await measure(tag('manager console (one by one)'), () => blockManageView({ store: far[0], blockId: one.block.id, principal: { email: 'load-m4@example.test', owner: false }, now: START + 4 * MIN }), 4);
      // Steady polling of two blocks (60 students), one full answer in five, spread over the instances.
      const two = [blocks[3], blocks[4]].flatMap(({ block: item, keys: list }) => list.map((key, index) => ({ blockId: item.id, key, roomId: item.roomIds[index % ROOMS] })));
      const latest = new Map(await Promise.all([blocks[3], blocks[4]].map(async ({ block: item }) => [item.id, (await store.block(item.id)).version])));
      expect(await concurrent(tag('steady polling: 60 students at once (1 full in 5)'), two.map((entry, index) => () => blockWhere({ store: far[index % INSTANCES], blockId: entry.blockId, key: entry.key, ...(index % 5 ? { since: latest.get(entry.blockId) } : {}), now: START + 4 * MIN })))).toEqual([]);
      expect(await concurrent(tag('mass entry: 30 students of one block join at once'), blocks[4].keys.map((key, index) => () => joinClassroom({ store: far[index % INSTANCES], provider, lessonId: blocks[4].block.roomIds[index % ROOMS], key, now: START + 4 * MIN })))).toEqual([]);
      expect(await concurrent(tag('reconnect storm: 60 students ask fully and join again at once'), two.flatMap((entry, index) => [
        () => blockWhere({ store: far[index % INSTANCES], blockId: entry.blockId, key: entry.key, now: START + 5 * MIN }),
        () => joinClassroom({ store: far[index % INSTANCES], provider, lessonId: entry.roomId, key: entry.key, now: START + 5 * MIN }),
      ]))).toEqual([]);
    } finally {
      await Promise.all(pools.map(pool => pool.end({ timeout: 2 })));
      await proxy.close();
    }
    results.rttMs = RTT_MS;
    results.instances = INSTANCES;
    for (const [name, value] of Object.entries(results.scenarios)) console.log(`LOAD ${name}: ${JSON.stringify(value)}`);
    // The cheap question is one query; a full answer stays well under the old ~22.
    expect(results.scenarios['cheap where (one by one)'].queriesPerRequest).toBeLessThanOrEqual(1);
    expect(results.scenarios['full where (one by one)'].queriesPerRequest).toBeLessThan(12);
    results.totalQueries = queries;
  }, 600000);
});
