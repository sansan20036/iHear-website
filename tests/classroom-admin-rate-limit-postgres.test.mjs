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
