// Read-only: the Video SDK account's recording settings (2026-11-10). One GET of Zoom's Account
// Settings API (GET /accounts/me/settings), which Zoom's Video SDK reference says the Video SDK
// API key and secret authorize. Prints setting names with true/false, numbers and short enum
// words only (never text that could hold an address or a name) and how each compares with what
// the first adult pilot needs (planning/2026-11-10-…-readiness-audit.md 1.3).
//
//   node tools/classroom-preflight/zoom-settings.mjs --env <zoom.env outside the repo> [--json <out>]
//
// Changing a setting is never done here: this tool sends GET only.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, readSettingsFile, redactor, zoomGetter } from './common.mjs';

const SAFE_WORD = /^[a-z_]{1,24}$/;
const shown = value => (typeof value === 'boolean' || typeof value === 'number' ? value
  : typeof value === 'string' && SAFE_WORD.test(value) ? value
    : value === null ? null : Array.isArray(value) ? `[list of ${value.length}]` : typeof value === 'object' ? '{…}' : '[text]');

// What the pilot needs, by the setting names Zoom's Accounts API documents for its recording
// object. A name Zoom does not return is reported as not returned, never assumed.
export const EXPECT = [
  { name: 'cloud_recording', want: v => v === true, need: 'ON: hosts may record to the cloud (without it nothing records)' },
  { name: 'auto_recording', want: v => v === 'none' || v === false, need: 'none/OFF: recording only when the server starts it after the consent check' },
  { name: 'save_chat_text', want: v => v === false, need: 'OFF recommended: the notice says nothing about chat', soft: true },
  { name: 'recording_audio_transcript', want: v => v === false, need: 'OFF: the notice covers no transcript', soft: true },
  { name: 'auto_delete_cmr', want: null, need: 'iHear decides (retention); must outlast filing' },
  { name: 'auto_delete_cmr_days', want: null, need: 'iHear decides (days)' },
  { name: 'display_participant_name', want: null, need: 'iHear decides; the classroom joins with participant codes, not names' },
  { name: 'host_delete_cloud_recording', want: null, need: 'information' },
];
// Anything about participants starting or asking for a recording, or recording without the host:
// shown for a human to read against the portal.
const REVIEW = /participant.*record|record.*participant|host.*(absent|not_present|leave)|without_host|request.*record|record.*request|allow_.*record/i;

/** Rows comparing the settings answer with the pilot's needs. */
export function assessSettings(json) {
  const recording = json && typeof json === 'object' ? json.recording : undefined;
  const rows = [];
  if (!recording || typeof recording !== 'object') return { rows: [{ name: 'recording', value: 'not returned', verdict: 'UNKNOWN', need: 'the answer has no recording settings' }], recordingKeys: [], review: [] };
  for (const item of EXPECT) {
    if (!(item.name in recording)) { rows.push({ name: item.name, value: 'not returned', verdict: 'UNKNOWN', need: item.need }); continue; }
    const value = shown(recording[item.name]);
    const verdict = item.want === null ? 'INFO' : item.want(recording[item.name]) ? 'OK' : item.soft ? 'CHECK' : 'FAIL';
    rows.push({ name: item.name, value, verdict, need: item.need });
  }
  const review = [];
  const all = {};
  for (const [section, object] of Object.entries(json)) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    all[section] = Object.fromEntries(Object.entries(object).map(([key, value]) => [key, shown(value)]));
    if (section === 'recording') continue;
    for (const [key, value] of Object.entries(object)) if (REVIEW.test(key) || /chat|caption|transcript|record|summary|archiv/i.test(key)) review.push({ name: `${section}.${key}`, value: shown(value) });
  }
  for (const key of Object.keys(recording).sort()) if (!EXPECT.some(item => item.name === key)) review.push({ name: `recording.${key}`, value: shown(recording[key]) });
  return { rows, recordingKeys: Object.keys(recording).sort(), review, all };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { env: 'value', json: 'value', 'api-base': 'value' });
  if (!args.env) throw new Error('Give --env <zoom.env outside the repository>');
  const env = readSettingsFile(args.env);
  const redact = redactor(Object.values(env));
  const get = zoomGetter({ apiKey: env.ZOOM_VIDEO_SDK_API_KEY, apiSecret: env.ZOOM_VIDEO_SDK_API_SECRET, ...(args['api-base'] ? { apiBase: args['api-base'] } : {}) });
  const { status, json } = await get('/accounts/me/settings');
  if (status !== 200) {
    console.log(redact(`GET /accounts/me/settings -> HTTP ${status}, Zoom code ${json?.code ?? '-'}: ${String(json?.message ?? '').slice(0, 160)}`));
    process.exitCode = 1;
    return;
  }
  const { rows, recordingKeys, review, all } = assessSettings(json);
  console.log(`GET /accounts/me/settings -> HTTP 200 (read only); sections: ${Object.keys(json).sort().join(', ')}`);
  for (const row of rows) console.log(redact(`${row.verdict.padEnd(7)} recording.${row.name} = ${JSON.stringify(row.value)}  (${row.need})`));
  if (review.length) { console.log('For a person to read against the portal:'); for (const r of review) console.log(redact(`  ${r.name} = ${JSON.stringify(r.value)}`)); }
  console.log(`recording settings returned: ${recordingKeys.length}; other sections: ${Object.entries(all).filter(([s]) => s !== 'recording').map(([s, o]) => `${s} (${Object.keys(o).length})`).join(', ')}`);
  if (args.json) writeFileSync(args.json, `${redact(JSON.stringify({ at: new Date().toISOString(), status, rows, review, recordingKeys, all }, null, 2))}\n`);
  process.exitCode = rows.some(r => r.verdict === 'FAIL') ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(`zoom-settings: ${error.message}`); process.exitCode = 2; });
