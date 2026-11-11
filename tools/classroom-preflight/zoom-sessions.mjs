// Read-only: the Video SDK account's sessions and recordings (2026-11-10). GET requests only.
// Prints a shortened session id, our own session key (a lesson id or TEST- code; anything else is
// "[not ours]"), times, counts and recording file types and sizes: never a name, an address, a
// link, a download token or a full id.
//
//   node tools/classroom-preflight/zoom-sessions.mjs --env <zoom.env> [--days 7] [--recordings] [--json <out>]
//
// --recordings also lists each past session's recording files (GET /videosdk/sessions/{id}/recordings).
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ownKey, parseArgs, readSettingsFile, redactor, shortSession, zoomGetter } from './common.mjs';

const day = d => d.toISOString().slice(0, 10);

/** Every session of one type in a range, following Zoom's page tokens. */
export async function listSessions(get, { type, from, to, maxPages = 10 }) {
  const sessions = [];
  let next = '';
  for (let page = 0; page < maxPages; page++) {
    const { status, json } = await get('/videosdk/sessions', { type, from, to, page_size: 300, ...(next ? { next_page_token: next } : {}) });
    if (status !== 200) return { status, code: json?.code ?? null, sessions };
    sessions.push(...(Array.isArray(json?.sessions) ? json.sessions : []));
    next = json?.next_page_token || '';
    if (!next) break;
  }
  return { status: 200, code: null, sessions };
}

/** What may be shown of a session. */
export function describeSession(s) {
  return {
    session: shortSession(s.id),
    key: ownKey(s.session_key),
    start: typeof s.start_time === 'string' ? s.start_time : null,
    end: typeof s.end_time === 'string' ? s.end_time : null,
    duration: typeof s.duration === 'string' || typeof s.duration === 'number' ? s.duration : null,
    users: Number.isFinite(s.user_count) ? s.user_count : null,
    recordingSize: Number.isFinite(s.recording_size) ? s.recording_size : null,
    hasRecording: typeof s.has_recording === 'boolean' ? s.has_recording : (Number(s.recording_size) > 0 ? true : null),
  };
}

/** What may be shown of a session's recording files. */
export function describeRecordings(json) {
  const files = Array.isArray(json?.recording_files) ? json.recording_files : [];
  return files.map(f => ({ type: typeof f.recording_type === 'string' ? f.recording_type : null, fileType: typeof f.file_type === 'string' ? f.file_type : null, size: Number.isFinite(f.file_size) ? f.file_size : null, status: typeof f.status === 'string' ? f.status : null }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { env: 'value', days: 'value', recordings: 'flag', json: 'value', 'api-base': 'value' });
  if (!args.env) throw new Error('Give --env <zoom.env outside the repository>');
  const env = readSettingsFile(args.env);
  const redact = redactor(Object.values(env));
  const get = zoomGetter({ apiKey: env.ZOOM_VIDEO_SDK_API_KEY, apiSecret: env.ZOOM_VIDEO_SDK_API_SECRET, ...(args['api-base'] ? { apiBase: args['api-base'] } : {}) });
  const days = Math.min(30, Math.max(1, Number(args.days ?? 7) || 7));
  const range = { from: day(new Date(Date.now() - (days - 1) * 86400_000)), to: day(new Date()) };
  const out = { at: new Date().toISOString(), range };
  for (const type of ['live', 'past']) {
    const result = await listSessions(get, { type, ...range });
    out[type] = { status: result.status, code: result.code, count: result.sessions.length, sessions: result.sessions.map(describeSession) };
    if (args.recordings && type === 'past') {
      for (const [index, s] of result.sessions.entries()) {
        // Zoom's rule for the recordings call: an id with "/" is encoded twice (zoomSessionPath).
        const once = encodeURIComponent(s.id);
        const { status, json } = await get(`/videosdk/sessions/${s.id.includes('/') ? encodeURIComponent(once) : once}/recordings`);
        out.past.sessions[index].recordings = status === 200 ? describeRecordings(json) : { status, code: json?.code ?? null };
      }
    }
  }
  console.log(redact(`Zoom sessions ${range.from}..${range.to} (read only)`));
  for (const type of ['live', 'past']) {
    const r = out[type];
    console.log(redact(`${type}: HTTP ${r.status}${r.code ? ` code ${r.code}` : ''}, ${r.count} session(s)`));
    for (const s of r.sessions) console.log(redact(`  ${s.session} key=${s.key ?? '-'} start=${s.start ?? '-'} end=${s.end ?? '-'} users=${s.users ?? '-'} recording=${s.hasRecording ?? '-'}${s.recordings ? ` files=${JSON.stringify(s.recordings)}` : ''}`));
  }
  if (args.json) writeFileSync(args.json, `${redact(JSON.stringify(out, null, 2))}\n`);
  process.exitCode = out.live.status === 200 && out.past.status === 200 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(`zoom-sessions: ${error.message}`); process.exitCode = 2; });
