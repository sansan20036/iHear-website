import { describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Every API route handler, read from the source (2026-11-10): a Google sign-in is never enough to
// change anything. Each handler that changes data must check that the person is an administrator
// (authorizeAdminRequest, or isAllowedAdmin / resolveAdminPrincipal, which read the administrator
// list), answer 405, or be one of the few public entry points below with its own named protection.
// A new route, or a new public read, fails this test until someone decides how it is protected.
const ADMIN_GUARD = /authorizeAdminRequest\(|isAllowedAdmin\(|resolveAdminPrincipal\(|currentAdminPrincipal\(|await authorized\(/;
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Public entry points that change something, and the protection each one must keep.
const OWN_PROTECTION = {
  'academy-inquiry/route.ts POST': [/enforceRateLimit\(/, 'public inquiry form: rate limit, no storage'],
  'auth/clear-stale/route.ts POST': [/enforceRateLimit\(/, 'clears stale sign-in cookies of the caller only'],
  'team-access/route.ts POST': [/NextResponse\.redirect\(/, 'old password form: only redirects'],
  'classroom/[lessonId]/host-events/route.ts POST': [/isSameOrigin\(/, 'classroom (closed): tutor session, same origin'],
  'classroom/[lessonId]/join/route.ts POST': [/isSameOrigin\(/, 'classroom (closed): personal link or tutor session'],
  'classroom/[lessonId]/status/route.ts POST': [/isSameOrigin\(/, 'classroom (closed): participant session'],
  'classroom/blocks/[blockId]/choice/route.ts POST': [/isSameOrigin\(/, 'classroom (closed): participant session'],
  'classroom/blocks/[blockId]/manage/route.ts POST': [/isSameOrigin\(/, 'classroom (closed): tutor session'],
  'classroom/blocks/[blockId]/where/route.ts POST': [/isSameOrigin\(/, 'classroom (closed): participant session'],
  'classroom/lcic/callback/route.ts POST': [/verifyLcicCallback\(/, 'vendor callback: signature'],
  'recordings/zoom/webhook/route.ts POST': [/ingestWebhook\(|answerWhileClosed\(/, 'Zoom webhook: signature and timestamp'],
};
// Reads that anyone may make (published content, health, bootstraps), or that check their own caller.
const PUBLIC_READS = new Set([
  'academy-content/route.ts GET', 'classroom/blocks/[blockId]/manage/route.ts GET', 'classroom/entry/route.ts GET',
  'classroom/my-lessons/route.ts GET', 'classroom/scheduled-tick/route.ts GET', 'content/get/route.ts GET', 'health/route.ts GET',
  'home-calendar/route.ts GET', 'live-revisions/route.ts GET', 'resource-topics/[id]/route.ts GET',
  'resource-topics/route.ts GET', 'resources/[id]/route.ts GET', 'resources/route.ts GET', 'site-layout/bootstrap/route.ts GET',
  'site-layout/route.ts GET', 'site-media/[slot]/image/route.ts GET', 'site-media/route.ts GET', 'site-metrics/route.ts GET',
  'site-theme/bootstrap/route.ts GET', 'site-theme/route.ts GET',
]);

async function routeFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await routeFiles(path.join(directory, entry.name), relative));
    else if (entry.name === 'route.ts') files.push(relative);
  }
  return files.sort();
}

const handlers = [];
for (const file of await routeFiles(path.resolve('app/api'))) {
  const source = await readFile(path.join('app/api', file), 'utf8');
  const starts = [...source.matchAll(/^export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm)];
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    const next = source.slice(match.index + 1).search(/^export /m);
    handlers.push({ file, method: match[1], body: source.slice(match.index, next >= 0 ? Math.min(end, match.index + 1 + next) : end), source });
  });
}

describe('API authorization inventory', () => {
  test('the inventory is not empty and covers the admin console, content and classroom routes', () => {
    expect(handlers.length).toBeGreaterThan(80);
    expect(handlers.some(handler => handler.file.startsWith('admin/'))).toBe(true);
  });

  test('every handler that changes data checks for an administrator, answers 405, or keeps its own named protection', () => {
    const unprotected = [];
    for (const { file, method, body, source } of handlers.filter(handler => MUTATING.includes(handler.method))) {
      const key = `${file} ${method}`;
      if (/methodNotAllowed\(\)/.test(body)) continue;
      if (ADMIN_GUARD.test(body)) {
        // A local helper (e.g. authorized()) must itself read the administrator list.
        if (/await authorized\(/.test(body) && !/isAllowedAdmin\(|authorizeAdminRequest\(/.test(source)) unprotected.push(`${key}: helper without an administrator check`);
        continue;
      }
      const own = OWN_PROTECTION[key];
      if (!own) unprotected.push(`${key}: no administrator check and not a known public entry point`);
      else if (!own[0].test(body)) unprotected.push(`${key}: lost its protection (${own[1]})`);
    }
    expect(unprotected).toEqual([]);
  });

  test('every admin-console read checks for an administrator; any other read is a reviewed public one', () => {
    const problems = [];
    for (const { file, method, body } of handlers.filter(handler => handler.method === 'GET')) {
      const key = `${file} ${method}`;
      if (/methodNotAllowed\(\)/.test(body)) continue;
      if (file.startsWith('admin/') && !ADMIN_GUARD.test(body)) problems.push(`${key}: admin read without an administrator check`);
      if (!file.startsWith('admin/') && !ADMIN_GUARD.test(body) && !PUBLIC_READS.has(key)) problems.push(`${key}: unreviewed public read`);
    }
    expect(problems).toEqual([]);
  });

  test('the allow-lists name only handlers that exist and are not already administrator-checked', () => {
    const byKey = new Map(handlers.map(handler => [`${handler.file} ${handler.method}`, handler]));
    const stale = [...Object.keys(OWN_PROTECTION), ...PUBLIC_READS].filter(key => !byKey.has(key) || ADMIN_GUARD.test(byKey.get(key).body));
    expect(stale).toEqual([]);
  });

  test('a Google sign-in alone grants nothing: the session only carries whether the list says administrator', async () => {
    const auth = await readFile('auth.js', 'utf8');
    expect(auth).toMatch(/providers: \[Google\]/);
    expect(auth).not.toMatch(/authorization:|scope:/);
    expect(auth).toMatch(/session\.user\.isAdmin = Boolean\(principal\)/);
    const admins = await readFile('lib/admins.ts', 'utf8');
    expect(admins).toMatch(/export async function isAllowedAdmin\(email: unknown\) \{\s*return Boolean\(await resolveAdminPrincipal\(email\)\);/);
  });
});
