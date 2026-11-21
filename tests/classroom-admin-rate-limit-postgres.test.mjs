import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

// R-8 (2026-11-08) on the shared store the site uses in production: the API rate limits are
// counted in PostgreSQL (migration 009), so every server instance sees the same count. This
// checks that the classroom overview's tick and the owner's changes are counted apart there too,
// exactly, under concurrency, and come back after their minute. A localhost-only disposable
// PostgreSQL, created and removed by this test; it never loads .env or reaches a hosted database.
// Synthetic identifiers only.
const container = `ihear-r8-limit-${randomUUID()}`;
const password = 'isolated-rate-limit-test-only';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let started = false, port, sql, limiter;

beforeAll(async () => {
  docker(['run', '--detach', '--pull=never', '--name', container, '--label', 'ihear-test=rate-limit', '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17-alpine']);
  started = true;
  port = docker(['port', container, '5432/tcp']).match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Expected a localhost-only PostgreSQL port');
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  sql = postgres(url, { ssl: false, max: 2, prepare: false, connect_timeout: 2, onnotice: () => {} });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    try { await sql`SELECT 1`; ready = true; } catch { await new Promise(resolve => { setTimeout(resolve, 300); }); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  await sql.unsafe(readFileSync('db/migrations/009_api_rate_limits.sql', 'utf8'));
  // The limiter reads its database address when it is loaded: point it at this server only.
  vi.stubEnv('IHEAR_FORCE_FILE_STORE', '');
  vi.stubEnv('POSTGRES_URL', url);
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('POSTGRES_SSL', 'disable');
  limiter = await import('../lib/rate-limit');
}, 120000);

afterAll(async () => {
  await globalThis.ihearRateLimitSql?.end({ timeout: 2 });
  await sql?.end({ timeout: 2 });
  vi.unstubAllEnvs();
  if (started) docker(['rm', '--force', '--volumes', container]);
}, 30000);

const request = () => new Request('http://localhost/api/admin/classrooms/tick', { method: 'POST' });
const consume = (policy, identifier) => limiter.enforceRateLimit(request(), { ...policy, identifier });
const allowed = decisions => decisions.filter(decision => !decision.limited).length;
const rows = async () => (await sql`SELECT request_count FROM public.api_rate_limits ORDER BY request_count`).map(row => Number(row.request_count));

describe('R-8 on PostgreSQL: the tick and admin changes are counted apart', () => {
  test('90 ticks and 45 changes at once for one owner: exactly 60 and 30 allowed, in two separate counters; the refused ones answer 429', async () => {
    const { classroomTick, adminMutation } = limiter.RATE_LIMIT_POLICIES;
    const owner = 'r8-pg-owner-1@example.test';
    const [ticks, changes] = await Promise.all([
      Promise.all(Array.from({ length: 90 }, () => consume(classroomTick, owner))),
      Promise.all(Array.from({ length: 45 }, () => consume(adminMutation, owner))),
    ]);
    expect(allowed(ticks)).toBe(classroomTick.limit);
    expect(allowed(changes)).toBe(adminMutation.limit);
    const refused = ticks.find(decision => decision.limited);
    expect(refused.response.status).toBe(429);
    expect(Number(refused.response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await rows()).toEqual([45, 90]);
  });

  test('a spent tick allowance leaves the changes\' counter as it was, and another owner has counters of their own', async () => {
    const { classroomTick, adminMutation } = limiter.RATE_LIMIT_POLICIES;
    await sql`DELETE FROM public.api_rate_limits`;
    const owner = 'r8-pg-owner-2@example.test';
    for (let n = 0; n < classroomTick.limit + 5; n += 1) await consume(classroomTick, owner);
    expect((await consume(adminMutation, owner)).limited).toBe(false);
    expect(await rows()).toEqual([1, classroomTick.limit + 5]);
    expect((await consume(classroomTick, 'r8-pg-owner-3@example.test')).limited).toBe(false);
    expect(await rows()).toEqual([1, 1, classroomTick.limit + 5]);
  });

  test('after its minute, a refused counter starts again from one; the other counter is untouched', async () => {
    const { classroomTick, adminMutation } = limiter.RATE_LIMIT_POLICIES;
    await sql`DELETE FROM public.api_rate_limits`;
    const owner = 'r8-pg-owner-4@example.test';
    for (let n = 0; n < classroomTick.limit; n += 1) await consume(classroomTick, owner);
    for (let n = 0; n < 3; n += 1) await consume(adminMutation, owner);
    expect((await consume(classroomTick, owner)).limited).toBe(true);
    // The tick's window is over (moved back, as the database clock decides); the changes' is not.
    await sql`UPDATE public.api_rate_limits SET window_started_at = NOW() - INTERVAL '61 seconds', updated_at = NOW() WHERE request_count > 3`;
    const again = await consume(classroomTick, owner);
    expect(again.limited).toBe(false);
    expect(again.result.remaining).toBe(classroomTick.limit - 1);
    expect(await rows()).toEqual([1, 3]);
  });
});

// P3-Multi B4 (2026-11-09): a classroom poll counts the shared allowance (everyone behind one
// address) and the person's own in one statement. Same limits as two separate checks; refused when
// either is used up; many people sharing one address at the same moment neither deadlock nor lose a count.
describe('B4 on PostgreSQL: two allowances counted in one statement', () => {
  const pair = (person, { perPlace = 1200, perPerson = 60 } = {}) => limiter.enforceRateLimits(request(), [
    { scope: 'b4-where', limit: perPlace, windowSeconds: 60, identifier: '203.0.113.9:block-1' },
    { scope: 'b4-where-person', limit: perPerson, windowSeconds: 60, identifier: `203.0.113.9:block-1:${person}` },
  ]);

  test('one statement per request; a person who used up their own allowance is refused while others behind the same address go on', async () => {
    await sql`DELETE FROM public.api_rate_limits`;
    for (let n = 0; n < 5; n += 1) expect((await pair('p1', { perPerson: 5 })).limited).toBe(false);
    const refused = await pair('p1', { perPerson: 5 });
    expect(refused.limited).toBe(true);
    expect(refused.response.status).toBe(429);
    expect((await pair('p2', { perPerson: 5 })).limited).toBe(false);
    // The shared counter saw all seven; the two people six and one.
    expect(await rows()).toEqual([1, 6, 7]);
  });

  test('the shared allowance used up: everyone behind that address is refused', async () => {
    await sql`DELETE FROM public.api_rate_limits`;
    for (let n = 0; n < 3; n += 1) expect((await pair(`q${n}`, { perPlace: 3 })).limited).toBe(false);
    expect((await pair('q9', { perPlace: 3 })).limited).toBe(true);
  });

  test('120 people behind one address at the same moment, twice each: no deadlock, exact counts', async () => {
    await sql`DELETE FROM public.api_rate_limits`;
    const decisions = await Promise.all(Array.from({ length: 240 }, (_, n) => pair(`r${n % 120}`)));
    expect(decisions.every(decision => !decision.limited)).toBe(true);
    const counts = await rows();
    expect(counts.at(-1)).toBe(240);
    expect(counts.slice(0, -1).every(count => count === 2)).toBe(true);
    expect(counts).toHaveLength(121);
  });

  test('buckets with different windows are refused as a configuration error (503), never half-counted', async () => {
    await sql`DELETE FROM public.api_rate_limits`;
    const bad = await limiter.enforceRateLimits(request(), [
      { scope: 'b4-a', limit: 5, windowSeconds: 60, identifier: 'x' },
      { scope: 'b4-b', limit: 5, windowSeconds: 600, identifier: 'x' },
    ]);
    expect(bad.limited).toBe(true);
    expect(bad.response.status).toBe(503);
    expect(await rows()).toEqual([]);
  });
});

// Hotfix (2026-11-21): a count that is within its allowance must never be refused as unavailable.
// Both statements set updated_at = NOW(), and NOW() is when the statement's transaction began. The
// table checks updated_at >= window_started_at (migration 009). Two ways the window can start after a
// counting statement began: (1) several server instances, each with a connection of its own (max: 1
// in lib/rate-limit.ts), count the same bucket at once, and the one that takes the row first is not
// the one that began first (a window reset, or the very first row); (2) the database's clock steps
// back. Either way the check refused the row, the limiter failed closed, and the request got 503.
describe('hotfix on PostgreSQL: a window that starts after the counting statement began', () => {
  const instances = [];
  // A connection made as lib/rate-limit.ts makes its own: one per server instance.
  const instancesFor = count => {
    while (instances.length < count) instances.push(postgres(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`, { max: 1, prepare: false, ssl: false, connect_timeout: 10, idle_timeout: 20, onnotice: () => {} }));
    return instances.slice(0, count);
  };
  // Each call is counted through one instance in turn (the limiter takes its connection before its
  // first await), all at the same moment. The instances are connected first, so that opening a
  // connection on a busy computer is never part of the burst (a connection that times out is
  // refused as unavailable, by design, and would hide what is tested here).
  const viaInstances = async (count, calls) => {
    const own = globalThis.ihearRateLimitSql;
    const pool = instancesFor(count);
    await Promise.all(pool.map(client => client`SELECT 1`));
    try {
      return await Promise.all(calls.map((call, index) => { globalThis.ihearRateLimitSql = pool[index % count]; return call(); }));
    } finally {
      globalThis.ihearRateLimitSql = own;
    }
  };
  const statusOf = decision => (decision.limited ? decision.response.status : 200);
  const tally = decisions => decisions.reduce((counts, decision) => ({ ...counts, [statusOf(decision)]: (counts[statusOf(decision)] ?? 0) + 1 }), {});
  const bucket = async key => (await sql`SELECT request_count, updated_at >= window_started_at AS ordered FROM public.api_rate_limits WHERE bucket_key = ${key}`)[0];
  const lateWindow = key => sql`INSERT INTO public.api_rate_limits (bucket_key, window_started_at, request_count, updated_at)
    VALUES (${key}, NOW() + INTERVAL '2 seconds', 1, NOW() + INTERVAL '2 seconds')`;
  const expiredWindow = key => sql`INSERT INTO public.api_rate_limits (bucket_key, window_started_at, request_count, updated_at)
    VALUES (${key}, NOW() - INTERVAL '2 minutes', 5, NOW() - INTERVAL '2 minutes')`;
  const keyOf = (policy, identifier) => limiter.hashRateLimitIdentifier(policy.scope, identifier);

  afterAll(async () => { await Promise.all(instances.map(client => client.end({ timeout: 2 }))); });

  test('H-1: one allowance, a window that starts after the statement began: counted, allowed, the row in order', async () => {
    const policy = { scope: 'hotfix-late', limit: 10, windowSeconds: 60 };
    const key = keyOf(policy, 'h1');
    await lateWindow(key);
    const decision = await limiter.enforceRateLimit(request(), { ...policy, identifier: 'h1' });
    expect(statusOf(decision)).toBe(200);
    expect(await bucket(key)).toEqual({ request_count: 2, ordered: true });
  });

  test('H-2: several allowances in one statement, the same', async () => {
    const policy = { scope: 'hotfix-late', limit: 10, windowSeconds: 60 };
    const [first, second] = [keyOf(policy, 'h2-a'), keyOf(policy, 'h2-b')];
    await lateWindow(first);
    const decision = await limiter.enforceRateLimits(request(), [{ ...policy, identifier: 'h2-a' }, { ...policy, identifier: 'h2-b' }]);
    expect(statusOf(decision)).toBe(200);
    expect(await bucket(first)).toEqual({ request_count: 2, ordered: true });
    expect(await bucket(second)).toEqual({ request_count: 1, ordered: true });
  });

  test('H-3: 8 server instances, a window that resets under a burst of 40, 15 times: every request within its allowance is allowed, none answered 503', async () => {
    const policy = { scope: 'hotfix-reset', limit: 1000, windowSeconds: 60 };
    let total = 0, unavailable = 0, wrongCounts = 0;
    for (let round = 0; round < 15; round += 1) {
      const identifier = `h3-${round}`;
      const key = keyOf(policy, identifier);
      await expiredWindow(key);
      const decisions = await viaInstances(8, Array.from({ length: 40 }, () => () => limiter.enforceRateLimit(request(), { ...policy, identifier })));
      total += decisions.length;
      unavailable += tally(decisions)[503] ?? 0;
      const row = await bucket(key);
      if (row.request_count !== 40 || !row.ordered) wrongCounts += 1;
    }
    console.log(`H-3: ${unavailable} of ${total} requests within their allowance were answered 503; rounds with a wrong count: ${wrongCounts}`);
    expect(unavailable).toBe(0);
    expect(wrongCounts).toBe(0);
  }, 120_000);

  test('H-4: 8 server instances, a new bucket under a burst of 40, 15 times: the same', async () => {
    const policy = { scope: 'hotfix-first', limit: 1000, windowSeconds: 60 };
    let total = 0, unavailable = 0, wrongCounts = 0;
    for (let round = 0; round < 15; round += 1) {
      const identifier = `h4-${round}`;
      const decisions = await viaInstances(8, Array.from({ length: 40 }, () => () => limiter.enforceRateLimit(request(), { ...policy, identifier })));
      total += decisions.length;
      unavailable += tally(decisions)[503] ?? 0;
      const row = await bucket(keyOf(policy, identifier));
      if (row.request_count !== 40 || !row.ordered) wrongCounts += 1;
    }
    console.log(`H-4: ${unavailable} of ${total} requests within their allowance were answered 503; rounds with a wrong count: ${wrongCounts}`);
    expect(unavailable).toBe(0);
    expect(wrongCounts).toBe(0);
  }, 120_000);

  test('H-5: over the limit through 8 instances, at a window reset and on a new bucket: exactly the limit allowed, the rest 429, none 503; nothing more passes', async () => {
    const policy = { scope: 'hotfix-over', limit: 30, windowSeconds: 60 };
    for (const [identifier, prepare] of [['h5-reset', expiredWindow], ['h5-new', null]]) {
      const key = keyOf(policy, identifier);
      if (prepare) await prepare(key);
      const decisions = await viaInstances(8, Array.from({ length: 120 }, () => () => limiter.enforceRateLimit(request(), { ...policy, identifier })));
      expect(tally(decisions), identifier).toEqual({ 200: 30, 429: 90 });
      expect(await bucket(key), identifier).toEqual({ request_count: 120, ordered: true });
      // Past the limit, one more is refused.
      const after = await limiter.enforceRateLimit(request(), { ...policy, identifier });
      expect(statusOf(after), identifier).toBe(429);
    }
  }, 120_000);

  test('H-6: several allowances through 8 instances: 120 people behind one address with a shared allowance of 50: exactly 50 allowed, 70 refused 429, none 503', async () => {
    const shared = { scope: 'hotfix-address', limit: 50, windowSeconds: 60, identifier: '203.0.113.7' };
    const person = { scope: 'hotfix-person', limit: 5, windowSeconds: 60 };
    await expiredWindow(keyOf(shared, shared.identifier));
    const decisions = await viaInstances(8, Array.from({ length: 120 }, (_, index) => () => limiter.enforceRateLimits(request(), [shared, { ...person, identifier: `h6-${index}` }])));
    expect(tally(decisions)).toEqual({ 200: 50, 429: 70 });
    expect(await bucket(keyOf(shared, shared.identifier))).toEqual({ request_count: 120, ordered: true });
  }, 120_000);

  test('H-7: a database that cannot be reached is still refused as unavailable (503), for one allowance and for several: the fix opens nothing', async () => {
    const own = globalThis.ihearRateLimitSql;
    const unreachable = postgres('postgres://postgres:unused@127.0.0.1:1/postgres', { max: 1, prepare: false, ssl: false, connect_timeout: 2, onnotice: () => {} });
    globalThis.ihearRateLimitSql = unreachable;
    try {
      const policy = { scope: 'hotfix-down', limit: 10, windowSeconds: 60 };
      expect(statusOf(await limiter.enforceRateLimit(request(), { ...policy, identifier: 'h7' }))).toBe(503);
      expect(statusOf(await limiter.enforceRateLimits(request(), [{ ...policy, identifier: 'h7-a' }, { ...policy, identifier: 'h7-b' }]))).toBe(503);
    } finally {
      globalThis.ihearRateLimitSql = own;
      await unreachable.end({ timeout: 1 });
    }
  }, 30_000);
});
