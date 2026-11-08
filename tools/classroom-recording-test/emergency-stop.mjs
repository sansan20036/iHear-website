// The independent emergency stop for the local P1 recording test (2026-11-08).
//
// A Zoom cloud recording keeps running at Zoom when the test's own server (recording-test.mjs)
// crashes or is closed: stopping a local process stops nothing at Zoom. This script needs neither
// that server nor the site. It reads only the env file (for the Zoom API key) and, if given, the
// test's data folder, and talks to Zoom's REST API itself:
//   1. Which sessions: each --session <id>, and every Zoom session of the lessons in
//      --data <folder> (the classroom.json the test's server wrote): the ones Zoom confirmed, and
//      the ones the tutor's page reported unless the server found them to be another lesson's.
//      A session Zoom already said had ended is left out unless --all is given.
//   2. PATCH /videosdk/sessions/{id}/events {"method":"recording.stop"} for each.
//   3. With --end, PUT /videosdk/sessions/{id}/status {"action":"end"} as well: ending the session
//      always ends its recording, whatever happened to the stop.
//   4. GET /videosdk/sessions/{id}?type=live afterwards, to say whether the session is still live.
//      Only that (Zoom no longer reports it live) counts as confirmed: Zoom answers the stop and
//      the end with 202, which means accepted, not done.
// Without --yes it only lists what it would send, and sends nothing.
// It prints lesson codes, a shortened session id and HTTP statuses: never a key, token or link.
//
// Usage:
//   node tools/classroom-recording-test/emergency-stop.mjs --env <file> --data <folder>             (list only)
//   node tools/classroom-recording-test/emergency-stop.mjs --env <file> --data <folder> --yes --end
//   node tools/classroom-recording-test/emergency-stop.mjs --env <file> --session <id> --yes --end
// Options: --lesson <code> (only that lesson), --all (also sessions Zoom said had ended),
//   --auth jwt (the default, the token the site makes) | api-key (Zoom's x-api-key header),
//   --api-base http://127.0.0.1:<port>/v2 (the local stand-in, for tests only).
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hideInOutput, readVendorEnv } from '../classroom-trial/env-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ZOOM = 'https://api.zoom.us/v2';
const TRUSTED_SOURCES = new Set(['zoom_webhook', 'zoom_api']);

export function parseArgs(argv) {
  const args = { sessions: [], yes: false, end: false, all: false, auth: 'jwt' };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next == null || next.startsWith('--')) throw new Error(`${name} needs a value`);
      return next;
    };
    if (name === '--env') args.env = value();
    else if (name === '--data') args.data = value();
    else if (name === '--session') args.sessions.push(value());
    else if (name === '--lesson') args.lesson = value();
    else if (name === '--auth') args.auth = value();
    else if (name === '--api-base') args.apiBase = value();
    else if (name === '--yes') args.yes = true;
    else if (name === '--end') args.end = true;
    else if (name === '--all') args.all = true;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!args.env) throw new Error('Give --env <file outside the repository> with the Zoom API key');
  if (!args.data && !args.sessions.length) throw new Error('Give --data <the test\'s data folder> or --session <id>');
  if (!['jwt', 'api-key'].includes(args.auth)) throw new Error('--auth is jwt or api-key');
  // Zoom itself, or the local stand-in for tests: a key is never sent anywhere else.
  if (args.apiBase && !/^http:\/\/127\.0\.0\.1:\d{2,5}\/v2$/.test(args.apiBase)) throw new Error('--api-base may name only the local stand-in, http://127.0.0.1:<port>/v2');
  return args;
}

// The same token the site's Zoom adapter makes (lib/classroom-vendors/zoom-video-sdk.ts).
export function apiToken(apiKey, apiSecret, now) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: apiKey, iat, exp: iat + 3600 })}`;
  return `${body}.${createHmac('sha256', apiSecret).update(body).digest('base64url')}`;
}

// As the site's adapter (zoomSessionPath, "session" rule): encoded twice when the id begins with
// "/" or contains "//", otherwise once.
export function sessionPathOf(id) {
  const once = encodeURIComponent(id);
  return id.startsWith('/') || id.includes('//') ? encodeURIComponent(once) : once;
}

const short = id => (id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`);

// The sessions to stop, from the test's data folder: each lesson's Zoom sessions, confirmed ones
// and reported ones the server did not find to be another lesson's.
export function sessionsFromData(folder, { lesson = null, all = false } = {}) {
  const file = path.join(folder, 'classroom.json');
  if (!existsSync(file)) throw new Error(`No classroom.json in ${folder}: is it the test's data folder?`);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const events = Object.values(state.events ?? {});
  const found = [];
  for (const entry of state.lessons ?? []) {
    if (lesson && entry.code !== lesson) continue;
    const mine = events.filter(event => event.lessonId === entry.id);
    const trusted = mine.filter(event => event.providerSessionId && (TRUSTED_SOURCES.has(event.source) || event.type === 'server.session_verified')).map(event => String(event.providerSessionId));
    const rejected = new Set(mine.filter(event => event.type === 'server.session_rejected').map(event => String(event.reportedSessionId)));
    const reported = mine.filter(event => event.type === 'host.session' && event.reportedSessionId).map(event => String(event.reportedSessionId)).filter(id => !rejected.has(id));
    const ended = new Set(mine.filter(event => event.type === 'session.ended' || (event.type === 'server.session_verified' && event.ended === true)).map(event => String(event.providerSessionId)));
    for (const id of [...new Set([...trusted, ...reported])]) {
      if (!all && ended.has(id)) continue;
      found.push({ lessonCode: entry.code, sessionId: id, basis: trusted.includes(id) ? 'confirmed' : 'reported' });
    }
  }
  return found;
}

async function call(fetchImpl, base, method, pathname, headers, body) {
  try {
    const response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  } catch {
    return 0;
  }
}

export async function emergencyStop(args, { fetchImpl = globalThis.fetch, now = Date.now(), log = console.log } = {}) {
  const settings = readVendorEnv(args.env, root);
  if (settings.CLASSROOM_PROVIDER !== 'zoom-video-sdk') throw new Error('The env file is not for the Zoom Video SDK');
  hideInOutput(settings);
  const targets = [
    ...args.sessions.map(id => ({ lessonCode: '(given)', sessionId: id, basis: 'given' })),
    ...(args.data ? sessionsFromData(args.data, { lesson: args.lesson ?? null, all: args.all }) : []),
  ].filter((target, index, list) => list.findIndex(other => other.sessionId === target.sessionId) === index);
  if (!targets.length) {
    log('No Zoom session to stop: none is recorded in the data folder (or each one ended). If a recording may still run, give --session <id> from the Zoom console.');
    return { sent: false, results: [] };
  }
  const base = args.apiBase ?? ZOOM;
  const headers = args.auth === 'api-key'
    ? { 'x-api-key': settings.ZOOM_VIDEO_SDK_API_KEY }
    : { authorization: `Bearer ${apiToken(settings.ZOOM_VIDEO_SDK_API_KEY, settings.ZOOM_VIDEO_SDK_API_SECRET, now)}` };
  if (!args.yes) {
    log('Would send (nothing sent; add --yes to send):');
    for (const target of targets) log(`  ${target.lessonCode}  session ${short(target.sessionId)} (${target.basis}): stop recording${args.end ? ', end session' : ''}`);
    return { sent: false, results: targets.map(target => ({ ...target })) };
  }
  const results = [];
  for (const target of targets) {
    const sessionPath = `/videosdk/sessions/${sessionPathOf(target.sessionId)}`;
    const stop = await call(fetchImpl, base, 'PATCH', `${sessionPath}/events`, headers, { method: 'recording.stop' });
    const end = args.end ? await call(fetchImpl, base, 'PUT', `${sessionPath}/status`, headers, { action: 'end' }) : null;
    const live = await call(fetchImpl, base, 'GET', `${sessionPath}?type=live`, headers, null);
    const result = { lessonCode: target.lessonCode, session: short(target.sessionId), basis: target.basis, stop, end, stillLive: live === 200 ? true : live === 404 || live === 400 ? false : null };
    results.push(result);
    // 202 means Zoom accepted the request, not that recording stopped.
    const answered = status => (!status ? 'no answer' : status >= 200 && status < 300 ? `${status} (accepted, not a confirmation)` : String(status));
    log(`  ${result.lessonCode}  session ${result.session} (${result.basis}): stop ${answered(stop)}${end == null ? '' : `, end ${answered(end)}`}, still live: ${result.stillLive == null ? `unknown (${live || 'no answer'})` : result.stillLive ? 'yes' : 'no'}`);
  }
  if (args.data) {
    const record = path.join(args.data, `emergency-stop-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(record, `${JSON.stringify({ at: new Date(now).toISOString(), end: args.end, results }, null, 2)}\n`, 'utf8');
  }
  return { sent: true, results };
}

// Done only when Zoom no longer reports the session as live: a session that is not live cannot
// be recording. A 202 to the stop or the end only means Zoom accepted the request, so it never
// counts as done on its own (without --end a live session stays live and stays unconfirmed).
export const settled = result => result.stillLive === false;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { sent, results } = await emergencyStop(args);
    if (sent) {
      const open = results.filter(result => !settled(result));
      console.log(open.length
        ? `NOT CONFIRMED for ${open.length} session(s): Zoom accepted the request but still reports the session live, or did not answer. Run again with --end, or end it in the Zoom console (Platform Studio), and check the recordings list there.`
        : 'CONFIRMED: Zoom no longer reports any of these sessions as live, so none can still be recording. Check the recordings list in the Zoom console.');
      process.exitCode = open.length ? 1 : 0;
    }
  } catch (error) {
    console.error(`Emergency stop not run: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
