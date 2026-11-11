// Shared helpers for the classroom preflight tools (2026-11-10). Nothing here prints or returns a
// secret: files are read in this process only, output goes through redact(), and errors name a
// setting or a line number, never a value.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A settings file the owner keeps outside the repository and outside OneDrive (which copies its
// folders to the cloud). NAME=value lines, # comments. Values are never echoed.
export function readSettingsFile(file, { allowed = null, root = REPO_ROOT } = {}) {
  const resolved = path.resolve(file);
  if (!path.relative(root, resolved).startsWith('..')) throw new Error('The settings file must be outside the repository');
  if (/[\\/]OneDrive[^\\/]*[\\/]/i.test(resolved)) throw new Error('The settings file must not be in a OneDrive folder');
  const settings = {};
  readFileSync(resolved, 'utf8').replace(/^﻿/, '').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
    if (!match) throw new Error(`Line ${index + 1} of the settings file is not NAME=value`);
    if (allowed && !allowed.has(match[1])) throw new Error(`The settings file may not hold ${match[1]}`);
    if (match[1] in settings) throw new Error(`${match[1]} appears twice in the settings file`);
    settings[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  });
  return settings;
}

// Every value long enough to be a secret is replaced, then anything shaped like a link, an email,
// a JWT or a long identifier.
export function redactor(values = []) {
  const hidden = values.filter(v => typeof v === 'string' && v.length >= 6).sort((a, b) => b.length - a.length);
  return text => hidden.reduce((out, v) => out.split(v).join('[hidden]'), String(text))
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[^\s"',;<>()]+@[^\s"',;<>()]+/g, '[email]')
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]');
}

// The Video SDK REST token the site itself uses (lib/classroom-vendors/zoom-video-sdk.ts):
// iss = API key, HS256 with the API secret, valid ten minutes here.
export function zoomApiToken(apiKey, apiSecret, now = Date.now()) {
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iss: apiKey, iat, exp: iat + 600 })}`;
  return `${body}.${createHmac('sha256', apiSecret).update(body).digest('base64url')}`;
}

// Read-only Zoom REST: GET only, by construction.
export function zoomGetter({ apiKey, apiSecret, apiBase = 'https://api.zoom.us/v2', fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  if (!/^https:\/\/api\.zoom\.us\/v2$|^http:\/\/127\.0\.0\.1:\d{2,5}\/v2$/.test(apiBase)) throw new Error('The API base must be Zoom\'s or a local stand-in');
  return async (pathname, params = {}) => {
    const url = new URL(`${apiBase}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${zoomApiToken(apiKey, apiSecret)}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  };
}

// A Zoom session id shortened for display (enough to tell sessions apart, not to address one).
export const shortSession = id => (typeof id === 'string' && id.length > 8 ? `${id.slice(0, 6)}…` : '[?]');
// Our own identifiers only (lib/classroom-*.ts shortId: a prefix + 32 hex, e.g. a lesson's L-…),
// or a TEST- code. Anything else is shown as not ours.
export const ownKey = key => (typeof key === 'string' && /^[A-Z]{1,2}-[0-9a-f]{32}$|^TEST-[A-Za-z0-9-]{1,36}$/.test(key) ? key : key ? '[not ours]' : null);

export function parseArgs(argv, spec) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!name.startsWith('--')) { args._.push(name); continue; }
    const key = name.slice(2);
    if (!(key in spec)) throw new Error(`Unknown option ${name}`);
    if (spec[key] === 'flag') args[key] = true;
    else if (spec[key] === 'list') { (args[key] ??= []).push(argv[++i]); }
    else args[key] = argv[++i];
    if (spec[key] !== 'flag' && (argv[i] === undefined || argv[i].startsWith('--'))) throw new Error(`${name} needs a value`);
  }
  return args;
}
