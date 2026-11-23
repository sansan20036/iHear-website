// A local measurement of the room channel (2026-11-23): how long an exchange takes, how soon a
// stroke reaches the other people of a room, whether everyone ends with the same picture, what a
// reconnection costs, and what the load is on this process and on a local PostgreSQL.
//
// What it is: simulated people, in THIS process, calling the service directly (no browser, no
// HTTP, no Next.js, no Zoom), over the store in memory or over a disposable local PostgreSQL that
// it creates and removes (never a hosted database; it never loads .env).
// What it is NOT: the production site. There is no network between a person and the server here,
// no serverless start-up, and the database is on this computer. A result here says how much work
// the logic and the queries are; it says nothing about latency from a student's home, from
// mainland China, or under the production database's limits.
//
//   node tools/room-channel-measure/measure.mjs --store memory [--rooms 1] [--people 10] [--drawers 2]
//        [--poll-ms 500] [--seconds 20] [--pool 2] [--label text] [--json out.json]
//        [--long-away <seconds>]   one person per room stays away that long (to need a fresh picture)
//   node tools/room-channel-measure/measure.mjs --store postgres …    (needs Docker and postgres:17-alpine)
//   node tools/room-channel-measure/measure.mjs --plan standard --store memory|postgres --json out.json
//        a fixed list of runs (rooms x drawers x poll interval), one table at the end
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { BOARD_LIMITS, moveOn, pictureFrom, shown } from '../../lib/room-channel/board.mjs';
import { createRoomChannel } from '../../lib/room-channel/service.mjs';
import { TURN_LIMITS } from '../../lib/room-channel/share-turn.mjs';
import { createMemoryStore } from '../../lib/room-channel/store-memory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']] : pairs), []));
const run = promisify(execFile);
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const ON = { board: true, chat: true, turn: true };
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

// A list of times, read at a few places.
function spread(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, p99: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = share => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted.at(-1)), mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) };
}

// A disposable local PostgreSQL with production's structure (migrations up to 030) and the draft tables.
async function startPostgres(pool) {
  const { default: postgres } = await import('postgres');
  const { createPostgresStore } = await import('../../lib/room-channel/store-postgres.mjs');
  const container = `ihear-room-channel-measure-${randomUUID()}`;
  const password = 'isolated-room-channel-measure-only';
  const docker = list => execFileSync('docker', list, { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=room-channel', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  const port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/m)?.[1];
  const sql = postgres(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`, { ssl: false, max: pool, prepare: false, connect_timeout: 3, onnotice: () => {} });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) { try { await sql`SELECT 1`; ready = true; } catch { await pause(500); } }
  if (!ready) { docker(['rm', '--force', '--volumes', container]); throw new Error('The disposable PostgreSQL did not become ready'); }
  const files = readdirSync(path.join(ROOT, 'db', 'migrations')).filter(name => /^\d+_[a-z0-9_]+\.sql$/i.test(name) && name.split('_', 1)[0] <= '030').sort();
  for (const name of files) await sql.begin(tx => tx.unsafe(readFileSync(path.join(ROOT, 'db', 'migrations', name), 'utf8')));
  await sql.begin(tx => tx.unsafe(readFileSync(path.join(ROOT, 'db', 'room-channel', '031_classroom_room_channel.sql'), 'utf8')));
  const usage = async () => {
    try { const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}};{{.MemUsage}}', container], { windowsHide: true, timeout: 15_000 }); const [cpu, memory] = stdout.trim().split(';'); return { cpuPercent: Number.parseFloat(cpu), memory: memory.split('/')[0].trim() }; } catch { return null; }
  };
  return {
    sql, usage,
    async fresh(lessons) {
      await sql`TRUNCATE public.classroom_room_channel, public.classroom_room_board_lines, public.classroom_room_board_parts, public.classroom_room_board_ops`;
      await sql`DELETE FROM public.classroom_lessons WHERE created_by = 'room-channel-measure'`;
      for (const [index, id] of lessons.entries()) await sql`INSERT INTO public.classroom_lessons (id, code, lesson_date, starts_at, ends_at, created_by) VALUES (${id}, ${`MEASURE-${index}`}, '2027-01-15', '2027-01-15T08:00:00Z', '2027-01-15T11:00:00Z', 'room-channel-measure')`;
      return createPostgresStore(sql);
    },
    async stop() { await sql.end({ timeout: 5 }).catch(() => undefined); try { docker(['rm', '--force', '--volumes', container]); } catch { /* left for docker ps to show */ } },
  };
}

// One run: `rooms` rooms of `people` people; in each room `drawers` of them draw (a line of ten
// parts over two seconds, one part every 200 ms, then a rest of one to three seconds), everyone asks for news every pollMs (twice as often
// while the board is busy), a few messages are written, one person per room holds the share turn,
// and some people drop out for a few seconds and come back.
async function oneRun({ label, store, rooms, people, drawers, pollMs, seconds, postgres = null, longAway = 0 }) {
  const channel = createRoomChannel(store);
  const startedAt = Date.now();
  const stopAt = startedAt + seconds * 1000;
  const lessons = Array.from({ length: rooms }, (_, index) => ({ id: `M-${index}`, roomId: `FR-M-${index}`, scheduledEnd: startedAt + 3 * 3_600_000, endedAt: null, people: Array.from({ length: people }, (_unused, person) => `P-${index}-${person}`) }));
  const times = { poll: [], write: [], reach: [], catchUp: [] };
  const counts = { exchanges: 0, polls: 0, writes: 0, strokesSent: 0, refused: {}, entries: 0, freshPictures: 0, bytesNoNews: [], bytesNews: [], errors: 0, drops: 0 };
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpuBefore = process.cpuUsage();
  const storeBefore = { ...store.calls };
  const databaseSamples = [];
  let random = 12345;
  const rand = () => { random = (random * 1103515245 + 12345) & 0x7fffffff; return random / 0x7fffffff; };

  const clients = [];
  for (const lesson of lessons) {
    for (const [index, id] of lesson.people.entries()) {
      clients.push({ lesson, who: { id, name: id, member: true }, draws: index < drawers, holdsTurn: index === 0, picture: pictureFrom({ seq: 0, lines: [], undo: null }), chat: 0, lastNews: 0, line: 0, cameBackAt: 0, serial: 0, claimed: false, longAway: longAway > 0 && index === people - 1 });
    }
  }
  const take = (client, answer, sentAt, now) => {
    if (!answer.ok) { counts.errors += 1; return; }
    for (const reply of answer.sent) if (!reply.ok) counts.refused[reply.error] = (counts.refused[reply.error] ?? 0) + 1;
    const board = answer.board;
    if (board?.ok) {
      if (board.fresh) { client.picture = pictureFrom(board.picture); counts.freshPictures += 1; client.lastNews = now; }
      else {
        for (const entry of board.entries) {
          moveOn(client.picture, entry);
          counts.entries += 1;
          // From the moment the server took the stroke to the moment this person has it. Their own
          // strokes are not counted (they see those at once on their own page).
          if (entry.by !== client.who.id && entry.at >= client.cameBackAt) times.reach.push(now - entry.at);
        }
        if (board.entries.length) client.lastNews = now;
      }
    }
    if (answer.chat?.ok) client.chat = answer.chat.seq;
    if (client.cameBackAt && board?.ok && sentAt >= client.cameBackAt) { times.catchUp.push(now - client.cameBackAt); client.cameBackAt = 0; }
  };
  const talk = async (client, send) => {
    const sentAt = Date.now(), began = performance.now();
    let answer = null;
    try { answer = await channel.exchange({ lesson: client.lesson, who: client.who, on: ON, cursors: { board: client.picture.seq, chat: client.chat, turn: 0 }, send, now: sentAt }); } catch { counts.errors += 1; return; }
    const took = performance.now() - began;
    counts.exchanges += 1;
    if (send.length) { counts.writes += 1; times.write.push(took); } else { counts.polls += 1; times.poll.push(took); }
    const bytes = JSON.stringify(answer).length;
    if (answer.board?.entries?.length || answer.board?.fresh) counts.bytesNews.push(bytes); else counts.bytesNoNews.push(bytes);
    take(client, answer, sentAt, Date.now());
  };

  // What each simulated person does until the run is over.
  const live = clients.map(async client => {
    await pause(rand() * pollMs);
    let nextStroke = Date.now() + rand() * 2000, strokeLeft = 0, nextMessage = Date.now() + 5000 + rand() * 20_000, nextBeat = Date.now() + rand() * 1000, nextDrop = client.longAway ? Date.now() + 3000 : Date.now() + 6000 + rand() * 20_000;
    while (Date.now() < stopAt) {
      const now = Date.now();
      if (now >= nextDrop && !client.draws) {
        // A dropped connection: nothing for 3 to 8 seconds (one person per room for much longer,
        // when asked for), then back from where the page had reached.
        const away = client.longAway ? longAway * 1000 : 3000 + rand() * 5000;
        counts.drops += 1;
        await pause(Math.min(away, Math.max(0, stopAt - now)));
        client.cameBackAt = Date.now();
        nextDrop = Infinity;
        continue;
      }
      const send = [];
      if (client.draws) {
        if (strokeLeft === 0 && now >= nextStroke) { strokeLeft = 10; client.line += 1; }
        if (strokeLeft > 0) {
          const part = 10 - strokeLeft;
          const x = Math.floor(rand() * 9000), y = Math.floor(rand() * 9000);
          send.push({ part: 'board', input: { kind: 'stroke', op: `s${client.serial += 1}`, line: `l${client.line}`, part, points: Array.from({ length: 12 }, (_unused, index) => [x + index * 10, y + index * 7]), color: 1, width: 2, done: strokeLeft === 1 } });
          counts.strokesSent += 1;
          strokeLeft -= 1;
          if (strokeLeft === 0) nextStroke = now + 1000 + rand() * 2000;
        }
      }
      if (now >= nextMessage) { send.push({ part: 'chat', input: { op: `m${client.serial += 1}`, text: `message ${client.serial} from ${client.who.id}` } }); nextMessage = now + 15_000 + rand() * 20_000; }
      if (client.holdsTurn && now >= nextBeat) { send.push({ part: 'turn', action: client.claimed ? 'beat' : 'claim' }); client.claimed = true; nextBeat = now + TURN_LIMITS.beatEveryMs; }
      await talk(client, send);
      // A person who is drawing sends a part every 200 ms; the others ask every pollMs, and twice
      // as often while something was new in the last two seconds.
      const wait = client.draws && strokeLeft > 0 ? 200 : Date.now() - client.lastNews < 2000 ? pollMs / 2 : pollMs;
      await pause(wait);
    }
    // One last look, so that everyone has everything before the pictures are compared.
    await talk(client, []);
  });
  const sampler = (async () => { while (Date.now() < stopAt) { await pause(2000); if (postgres) { const sample = await postgres.usage(); if (sample) databaseSamples.push(sample); } } })();
  await Promise.all([...live, sampler]);
  for (const client of clients) await talk(client, []);

  // Does everyone have what the server holds?
  let same = 0;
  for (const lesson of lessons) {
    const whole = await store.picture(lesson.id);
    const server = whole ? Object.entries(whole.lines).filter(([, line]) => line.clearedBy === null).sort(([, a], [, b]) => a.beganSeq - b.beganSeq).map(([key, line]) => ({ line: key, by: line.by, color: line.color, width: line.width, points: line.points, done: line.done })) : [];
    const expected = JSON.stringify(server);
    for (const client of clients.filter(entry => entry.lesson === lesson)) if (JSON.stringify(shown(client.picture)) === expected) same += 1;
  }
  loop.disable();
  const cpu = process.cpuUsage(cpuBefore);
  const elapsed = (Date.now() - startedAt) / 1000;
  const calls = Object.fromEntries(Object.entries(store.calls).map(([name, value]) => [name, value - (storeBefore[name] ?? 0)]));
  const held = await store.stats(Date.now());
  return {
    label, rooms, people: rooms * people, drawers: rooms * drawers, pollMs, seconds: round(elapsed),
    exchangesPerSecond: round(counts.exchanges / elapsed), writesPerSecond: round(counts.writes / elapsed), strokePartsPerSecond: round(counts.strokesSent / elapsed),
    pollMs_: spread(times.poll), writeMs: spread(times.write),
    // From the server taking a stroke to another person having it: in this process, with no network.
    reachMs: spread(times.reach), catchUpAfterDropMs: spread(times.catchUp), drops: counts.drops, freshPictures: counts.freshPictures,
    samePictureAsServer: `${same}/${clients.length}`, errors: counts.errors, refused: counts.refused,
    answerBytes: { noNews: spread(counts.bytesNoNews).p50, withNews: spread(counts.bytesNews) },
    storeCallsPerSecond: Object.fromEntries(Object.entries(calls).map(([name, value]) => [name, round(value / elapsed)])),
    thisProcess: { cpuPercentOfOneCore: round((cpu.user + cpu.system) / 10_000 / elapsed), eventLoopDelayMs: { mean: round(loop.mean / 1e6), p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6) }, heapMb: round(process.memoryUsage().heapUsed / 1048576) },
    database: postgres ? { cpuPercent: spread(databaseSamples.map(sample => sample.cpuPercent)), memory: databaseSamples.at(-1)?.memory ?? null } : null,
    held: { lines: held.lines, operations: held.operations },
  };
}

const PLANS = {
  // rooms, people in each, drawers in each, poll interval
  standard: [[1, 10, 1, 500], [1, 10, 3, 500], [1, 10, 10, 500], [5, 10, 2, 500], [10, 10, 1, 500], [10, 10, 3, 500], [10, 10, 3, 250], [10, 10, 3, 1000], [10, 10, 10, 500]],
  quick: [[1, 10, 2, 500], [10, 10, 3, 500]],
  // The runs where the number of database connections decides.
  busy: [[1, 10, 10, 500], [10, 10, 1, 500], [10, 10, 3, 500], [10, 10, 10, 500]],
};
const longAway = Number(args['long-away'] ?? 0);

const storeKind = args.store === 'postgres' ? 'postgres' : 'memory';
const seconds = Number(args.seconds ?? 20), pool = Number(args.pool ?? 2);
const plan = args.plan ? PLANS[args.plan] : [[Number(args.rooms ?? 1), Number(args.people ?? 10), Number(args.drawers ?? 2), Number(args['poll-ms'] ?? 500)]];
if (!plan) throw new Error(`--plan is one of: ${Object.keys(PLANS).join(', ')}`);
console.log(`room channel measurement: ${storeKind}${storeKind === 'postgres' ? ` (a disposable local PostgreSQL, ${pool} connections)` : ''}, ${plan.length} run(s) of ${seconds} s. Simulated people in this process: no browser, no network, no Zoom.`);
const postgres = storeKind === 'postgres' ? await startPostgres(pool) : null;
const results = [];
try {
  for (const [rooms, people, drawers, pollMs] of plan) {
    const store = postgres ? await postgres.fresh(Array.from({ length: rooms }, (_, index) => `M-${index}`)) : createMemoryStore();
    const result = await oneRun({ label: `${storeKind}${args.label ? ` ${args.label}` : ''}`, store, rooms, people, drawers, pollMs, seconds, postgres, longAway });
    results.push(result);
    console.log(`${String(result.people).padStart(3)} people in ${String(rooms).padStart(2)} room(s), ${String(result.drawers).padStart(3)} drawing, asking every ${String(pollMs).padStart(4)} ms: ${String(result.exchangesPerSecond).padStart(6)} exchanges/s; a write ${result.writeMs.p50}/${result.writeMs.p95}/${result.writeMs.p99} ms, a look ${result.pollMs_.p50}/${result.pollMs_.p95}/${result.pollMs_.p99} ms (p50/p95/p99); a stroke reaches the others in ${result.reachMs.p50}/${result.reachMs.p95}/${result.reachMs.p99} ms; same picture ${result.samePictureAsServer}; errors ${result.errors}; refused ${JSON.stringify(result.refused)}; this process ${result.thisProcess.cpuPercentOfOneCore}% of a core${result.database ? `; database ${result.database.cpuPercent.p50}% CPU, ${result.database.memory}` : ''}`);
  }
} finally {
  await postgres?.stop();
}
if (args.json) { writeFileSync(path.resolve(String(args.json)), `${JSON.stringify({ measuredAt: new Date().toISOString(), store: storeKind, pool: storeKind === 'postgres' ? pool : null, limits: { recentKept: BOARD_LIMITS.recentKept, perSender: BOARD_LIMITS.perSender }, results }, null, 2)}\n`); console.log(`written: ${path.resolve(String(args.json))}`); }
