// Emergency stop without the site and without a data folder (2026-11-10): finds the account's LIVE
// Zoom sessions (read only), keeps those of one lesson when --lesson is given, and hands them to
// the independent emergency stop (tools/classroom-recording-test/emergency-stop.mjs): stop the
// recording, end the session, then ask Zoom whether it is still live. Only "no longer live" counts
// as confirmed; a 202 is acceptance, not a stop.
//
//   node tools/classroom-preflight/emergency-stop-live.mjs --env <zoom.env> [--lesson L-…]          (lists; sends nothing)
//   node tools/classroom-preflight/emergency-stop-live.mjs --env <zoom.env> --lesson L-… --yes      (stops and ends)
//
// Without --lesson every live session of the account is a target, so --yes then also needs --all-live.
// Prints shortened session ids and our own session keys only.
import { pathToFileURL } from 'node:url';
import { emergencyStop, settled } from '../classroom-recording-test/emergency-stop.mjs';
import { ownKey, parseArgs, readSettingsFile, shortSession, zoomGetter } from './common.mjs';
import { listSessions } from './zoom-sessions.mjs';

const day = d => d.toISOString().slice(0, 10);

/** The live sessions to stop: one lesson's (session_key), or all with allLive. */
export async function liveTargets(get, { lesson = null, now = Date.now() } = {}) {
  const result = await listSessions(get, { type: 'live', from: day(new Date(now - 86400_000)), to: day(new Date(now + 86400_000)) });
  if (result.status !== 200) return { status: result.status, code: result.code, targets: [], others: 0 };
  const live = result.sessions.filter(s => typeof s.id === 'string' && s.id);
  const targets = lesson ? live.filter(s => s.session_key === lesson) : live;
  return { status: 200, code: null, targets, others: live.length - targets.length };
}

export async function run(argv, { fetchImpl = globalThis.fetch, log = console.log, now = Date.now() } = {}) {
  const args = parseArgs(argv, { env: 'value', lesson: 'value', yes: 'flag', 'all-live': 'flag', 'api-base': 'value' });
  if (!args.env) throw new Error('Give --env <zoom.env outside the repository>');
  if (args.lesson && !/^[A-Z]{1,2}-[0-9a-f]{32}$/.test(args.lesson)) throw new Error('--lesson is the lesson id (the session key), L-…');
  if (args.yes && !args.lesson && !args['all-live']) throw new Error('--yes without --lesson stops every live session of the account: add --all-live to mean that');
  const env = readSettingsFile(args.env);
  const get = zoomGetter({ apiKey: env.ZOOM_VIDEO_SDK_API_KEY, apiSecret: env.ZOOM_VIDEO_SDK_API_SECRET, fetchImpl, ...(args['api-base'] ? { apiBase: args['api-base'] } : {}) });
  const { status, code, targets, others } = await liveTargets(get, { lesson: args.lesson ?? null, now });
  if (status !== 200) { log(`Could not list live sessions: HTTP ${status}${code ? ` code ${code}` : ''}. Stop it in the Zoom console instead.`); return { exit: 2 }; }
  log(`Live sessions: ${targets.length} target(s)${args.lesson ? `, ${others} other live session(s) left alone` : ''}`);
  for (const s of targets) log(`  ${shortSession(s.id)} key=${ownKey(s.session_key) ?? '-'}`);
  if (!targets.length) { log('Nothing to stop: Zoom reports no such live session (a session that is not live cannot be recording).'); return { exit: 0, sent: false }; }
  const { sent, results } = await emergencyStop({ env: args.env, sessions: targets.map(s => s.id), yes: Boolean(args.yes), end: true, all: false, auth: 'jwt', ...(args['api-base'] ? { apiBase: args['api-base'] } : {}) }, { fetchImpl, now, log });
  if (!sent) return { exit: 0, sent: false };
  const open = results.filter(r => !settled(r));
  log(open.length ? `NOT CONFIRMED for ${open.length} session(s): end it in the Zoom console now.` : 'CONFIRMED: Zoom no longer reports these sessions live, so none can still be recording.');
  return { exit: open.length ? 1 : 0, sent: true, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).then(({ exit }) => { process.exitCode = exit; }, error => { console.error(`emergency-stop-live: ${error.message}`); process.exitCode = 2; });
}
