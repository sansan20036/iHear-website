// The live webhook checked from outside without ever storing anything (2026-11-10), for use
// while the classroom is OPEN as well as closed. Every request it sends is Zoom's URL validation
// (endpoint.url_validation), which the route answers before any storage, or a request whose
// signature or timestamp is wrong, which the route refuses (401) before reading the body. It never
// signs any other event: the signed TEST events of the closed-mode check would be STORED once the
// classroom is open (tools/recording-pathway/classroom/webhook-ingest.mjs ingestWebhook).
//
//   node tools/classroom-preflight/webhook-safe-check.mjs --env <zoom.env> [--endpoint <url>] [--json <out>]
//
// The Secret Token is read from the env file in this process only and never printed.
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, readSettingsFile } from './common.mjs';

export const DEFAULT_ENDPOINT = 'https://www.ihearus.org/api/recordings/zoom/webhook';
export const ONLY_EVENT = 'endpoint.url_validation';
const ZOOM_LIMIT_MS = 3000;

const sign = (secret, at, raw) => `v0=${createHmac('sha256', secret).update(`v0:${Math.floor(at / 1000)}:${raw}`).digest('hex')}`;

/** The one kind of body this tool sends. Anything else is refused before a request is made. */
export function validationBody(plainToken, now = Date.now()) {
  const body = { event: ONLY_EVENT, event_ts: now, payload: { plainToken } };
  if (body.event !== ONLY_EVENT) throw new Error('This check sends Zoom\'s URL validation only');
  return JSON.stringify(body);
}

/**
 * The checks, in order. fetchImpl(url, init) is fetch, or a stand-in in tests. Returns results
 * with statuses, timings and pass/fail; never a secret or a token.
 */
export async function runSafeChecks({ endpoint = DEFAULT_ENDPOINT, secret, fetchImpl = globalThis.fetch, now = () => Date.now(), validations = 3 }) {
  if (!secret) throw new Error('No Secret Token');
  const results = [];
  const send = async (label, raw, headers) => {
    if (JSON.parse(raw).event !== ONLY_EVENT) throw new Error('refused: only URL validation bodies are sent');
    const started = performance.now();
    const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'iHear webhook safe check', ...headers }, body: raw, redirect: 'manual' });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { label, status: response.status, ms: Math.round(performance.now() - started), json };
  };
  const record = (r, pass, note) => results.push({ label: r.label, status: r.status, ms: r.ms, pass: Boolean(pass), note });
  for (let i = 1; i <= validations; i++) {
    const at = now();
    const plainToken = `ihear-safe-check-${at}-${i}`;
    const raw = validationBody(plainToken, at);
    const r = await send(`url_validation #${i}`, raw, { 'x-zm-request-timestamp': String(Math.floor(at / 1000)), 'x-zm-signature': sign(secret, at, raw) });
    const right = r.status === 200 && r.json?.plainToken === plainToken && r.json?.encryptedToken === createHmac('sha256', secret).update(plainToken).digest('hex');
    record(r, right && r.ms < ZOOM_LIMIT_MS, right ? (r.ms < ZOOM_LIMIT_MS ? 'answer right, within 3 s' : 'answer right but slower than Zoom allows') : 'WRONG ANSWER');
  }
  const at = now();
  const raw = validationBody(`ihear-safe-check-refusal-${at}`, at);
  const refusals = [
    ['no signature headers', {}],
    ['wrong signature', { 'x-zm-request-timestamp': String(Math.floor(at / 1000)), 'x-zm-signature': `v0=${'0'.repeat(64)}` }],
    ['signed with another secret', { 'x-zm-request-timestamp': String(Math.floor(at / 1000)), 'x-zm-signature': sign(`${secret}-not-this-one`, at, raw) }],
    ['timestamp 6 minutes old', { 'x-zm-request-timestamp': String(Math.floor((at - 6 * 60_000) / 1000)), 'x-zm-signature': sign(secret, at - 6 * 60_000, raw) }],
  ];
  for (const [label, headers] of refusals) {
    const r = await send(label, raw, headers);
    record(r, r.status === 401, r.status === 401 ? 'refused' : 'NOT REFUSED');
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { env: 'value', endpoint: 'value', json: 'value' });
  if (!args.env) throw new Error('Give --env <zoom.env outside the repository>');
  const endpoint = args.endpoint ?? DEFAULT_ENDPOINT;
  if (!/^https:\/\/www\.ihearus\.org\/api\/recordings\/zoom\/webhook$|^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/api\/recordings\/zoom\/webhook$/.test(endpoint)) throw new Error('The endpoint is the live www address or a local server');
  const secret = readSettingsFile(args.env).ZOOM_VIDEO_SDK_WEBHOOK_SECRET;
  const results = await runSafeChecks({ endpoint, secret });
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${String(r.status).padEnd(3)} ${String(r.ms).padStart(5)} ms  ${r.label}: ${r.note}`);
  const passed = results.filter(r => r.pass).length;
  console.log(`${passed}/${results.length} passed; only URL validation was signed, so nothing can have been stored`);
  if (args.json) writeFileSync(args.json, `${JSON.stringify({ at: new Date().toISOString(), endpoint, results }, null, 2).split(secret).join('[hidden]')}\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(`webhook-safe-check: ${error.message}`); process.exitCode = 2; });
