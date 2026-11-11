// Production environment check for the classroom (2026-11-10). Names and shapes only: no value,
// length or part of a value is ever printed.
//
//   node tools/classroom-preflight/env-check.mjs --profile closed --metadata <vercel-env.json>
//   node tools/classroom-preflight/env-check.mjs --profile pilot  --metadata <vercel-env.json>
//   node tools/classroom-preflight/env-check.mjs --profile pilot  --values <pilot.env> [--zoom-env <zoom.env>]
//   node tools/classroom-preflight/env-check.mjs --profile lessons --metadata <vercel-env.json>
//   node tools/classroom-preflight/env-check.mjs --profile lessons --values <lessons.env> [--zoom-env <zoom.env>]
//
// --metadata: Vercel's env listing without values (GET /v10/projects/<id>/env?decrypt=false, or a
//   filtered copy of it): only key, type and target are read.
// --values: the file the owner prepares before anything is uploaded (outside the repository and
//   OneDrive). Its switches must have their exact values and its secrets a plausible shape.
// --zoom-env: the local zoom.env the live webhook was checked with; the five Zoom values in
//   --values must be the same ones (compared in this process, never shown).
// Profiles:
//   closed - today's production: the webhook's Secret Token only, the classroom closed.
//   pilot  - the first one-to-one adult pilot lesson (planning/2026-11-10-…-readiness-audit.md 1.6).
//   lessons - the closed trial's real lessons with nothing recorded (P3-MVP, 2026-11-11): the
//            classroom open with Zoom, and none of the settings that record or file may be there
//            (consent versions, Drive). Without them production records no consent
//            (lib/classroom-consent-gate.ts), so no lesson is recorded and nothing is filed.
// Exit 0 only when nothing is wrong.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseArgs, readSettingsFile } from './common.mjs';

export const PILOT_CONSENT_VERSION = 'ihear-adult-pilot-consent-v1';

// name -> exact value (switches) or a shape rule (secrets and identifiers).
export const PILOT_REQUIRED = {
  CLASSROOM_PROVIDER: { exact: 'zoom-video-sdk' },
  ZOOM_VIDEO_SDK_KEY: { secret: true },
  ZOOM_VIDEO_SDK_SECRET: { secret: true },
  ZOOM_VIDEO_SDK_API_KEY: { secret: true },
  ZOOM_VIDEO_SDK_API_SECRET: { secret: true },
  ZOOM_VIDEO_SDK_WEBHOOK_SECRET: { secret: true },
  CLASSROOM_PILOT_CONSENT: { exact: '1' },
  CLASSROOM_CONSENT_VERSION: { exact: PILOT_CONSENT_VERSION },
  CLASSROOM_STAFF_NOTICE_VERSION: { exact: PILOT_CONSENT_VERSION },
  CLASSROOM_DRIVE: { exact: 'google' },
  CLASSROOM_DRIVE_GRANT: { exact: 'production' },
  CLASSROOM_GOOGLE_CLIENT_ID: { pattern: /^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/, why: 'NOT_A_GOOGLE_CLIENT_ID' },
  CLASSROOM_GOOGLE_CLIENT_SECRET: { secret: true },
  CLASSROOM_GOOGLE_REFRESH_TOKEN: { secret: true, min: 30, max: 512, chars: /^[A-Za-z0-9._/-]+$/ },
  CLASSROOM_DRIVE_PARENT_FOLDER_ID: { pattern: /^[A-Za-z0-9_-]{20,80}$/, why: 'NOT_A_DRIVE_FOLDER_ID' },
};
export const PILOT_RECOMMENDED = { CLASSROOM_SESSION_REPORTS: { exact: 'verify' } };
export const PILOT_OPTIONAL = {
  CRON_SECRET: { secret: true, min: 32 },
  CLASSROOM_DRIVE_ALLOWED_DOMAINS: { pattern: /^[a-z0-9.-]+\.[a-z]{2,}(,[a-z0-9.-]+\.[a-z]{2,})*$/, why: 'NOT_A_DOMAIN_LIST' },
};
// The lessons profile: the provider and Zoom's five values, nothing that records or files.
const ZOOM_REQUIRED = ['CLASSROOM_PROVIDER', 'ZOOM_VIDEO_SDK_KEY', 'ZOOM_VIDEO_SDK_SECRET', 'ZOOM_VIDEO_SDK_API_KEY', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET'];
export const LESSONS_REQUIRED = Object.fromEntries(ZOOM_REQUIRED.map(name => [name, PILOT_REQUIRED[name]]));
export const RECORDING_SETTINGS = Object.keys({ ...PILOT_REQUIRED, ...PILOT_OPTIONAL }).filter(name => !ZOOM_REQUIRED.includes(name) && name !== 'CRON_SECRET');
const PROFILES = {
  pilot: { required: PILOT_REQUIRED, recommended: PILOT_RECOMMENDED, optional: PILOT_OPTIONAL, absent: [] },
  lessons: { required: LESSONS_REQUIRED, recommended: PILOT_RECOMMENDED, optional: { CRON_SECRET: PILOT_OPTIONAL.CRON_SECRET }, absent: RECORDING_SETTINGS },
};
// Never in production: they delete vendor copies, open block recording, or exist for local and
// synthetic tests only (each is refused or meaningless there, and some would change behaviour).
export const FORBIDDEN = [
  'CLASSROOM_VENDOR_DELETION', 'CLASSROOM_MULTI_RECORDING', 'CLASSROOM_TRIAL_CONSENT',
  'CLASSROOM_SYNTHETIC_SECRET', 'CLASSROOM_WEBHOOK_SECRET', 'CLASSROOM_DRIVE_ROOT_NAME',
  'CLASSROOM_GOOGLE_CLIENT_FILE', 'CLASSROOM_GOOGLE_TOKEN_FILE', 'CLASSROOM_GOOGLE_API_BASE',
  'CLASSROOM_GOOGLE_TOKEN_ENDPOINT', 'CLASSROOM_DRIVE_LOCAL_QUOTA_BYTES', 'ZOOM_API_BASE',
  'LCIC_MIDCLASS_STOP_VERIFIED', 'LCIC_SDK_APP_ID', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY',
  'LCIC_CALLBACK_KEY', 'LCIC_API_HOST', 'IHEAR_TEST_DATA_DIR', 'IHEAR_FORCE_FILE_STORE',
];
const CLASSROOM_NAME = /^(CLASSROOM_|ZOOM_|LCIC_|TENCENTCLOUD_|CRON_SECRET$|IHEAR_TEST_DATA_DIR$|IHEAR_FORCE_FILE_STORE$)/;
const PLACEHOLDER = /placeholder|not[-_ ]?used|round[-_ ]?1|example|changeme|dummy|fake|test[-_]?only|xxxx|todo|replace|your[-_ ]|<|>/i;
const ZOOM_NAMES = ['ZOOM_VIDEO_SDK_KEY', 'ZOOM_VIDEO_SDK_SECRET', 'ZOOM_VIDEO_SDK_API_KEY', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET'];

const entriesOf = metadata => {
  const list = Array.isArray(metadata) ? metadata : metadata?.envs;
  if (!Array.isArray(list)) throw new Error('The metadata is not a Vercel env listing');
  return list.map(e => ({ key: String(e.key), type: String(e.type ?? ''), target: Array.isArray(e.target) ? e.target.map(String) : [String(e.target ?? '')] }));
};

/** Vercel's listing against a profile. Findings name a variable and a reason code only. */
export function checkMetadata(metadata, profile) {
  const entries = entriesOf(metadata);
  const findings = [];
  const add = (level, name, code) => findings.push({ level, name, code });
  const production = entries.filter(e => e.target.includes('production'));
  const byName = new Map(production.map(e => [e.key, e]));
  for (const e of entries) if (CLASSROOM_NAME.test(e.key) && e.target.some(t => t !== 'production')) add('error', e.key, 'NOT_PRODUCTION_ONLY');
  for (const name of FORBIDDEN) if (byName.has(name)) add('error', name, 'FORBIDDEN_IN_PRODUCTION');
  if (profile === 'closed') {
    if (!byName.has('ZOOM_VIDEO_SDK_WEBHOOK_SECRET')) add('error', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET', 'MISSING');
    for (const e of production) if (CLASSROOM_NAME.test(e.key) && e.key !== 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET' && !FORBIDDEN.includes(e.key)) add('error', e.key, 'OPENS_OR_CONFIGURES_THE_CLASSROOM');
  } else if (PROFILES[profile]) {
    const { required, recommended, optional, absent } = PROFILES[profile];
    for (const [name, rule] of Object.entries(required)) {
      const e = byName.get(name);
      if (!e) add('error', name, 'MISSING');
      else if (rule.secret && e.type !== 'sensitive') add('error', name, 'SECRET_NOT_SENSITIVE');
    }
    for (const name of Object.keys(recommended)) if (!byName.has(name)) add('warn', name, 'RECOMMENDED_MISSING');
    for (const name of absent) if (byName.has(name)) add('error', name, 'RECORDS_OR_FILES');
    const known = new Set([...Object.keys(required), ...Object.keys(recommended), ...Object.keys(optional), ...absent, ...FORBIDDEN]);
    for (const e of production) if (CLASSROOM_NAME.test(e.key) && !known.has(e.key)) add('error', e.key, 'UNKNOWN_CLASSROOM_SETTING');
    if (byName.has('CRON_SECRET') && byName.get('CRON_SECRET').type !== 'sensitive') add('error', 'CRON_SECRET', 'SECRET_NOT_SENSITIVE');
  } else throw new Error('Profile is closed, pilot or lessons');
  return findings;
}

/** The owner's values file against the pilot (default) or lessons profile. Never returns a value. */
export function checkValues(values, { zoomEnv = null, profile = 'pilot' } = {}) {
  if (!PROFILES[profile]) throw new Error('A values file is checked against the pilot or lessons profile');
  const { required, recommended, optional, absent } = PROFILES[profile];
  const findings = [];
  const add = (level, name, code) => findings.push({ level, name, code });
  const rules = { ...required, ...recommended, ...optional };
  for (const name of Object.keys(values)) {
    if (FORBIDDEN.includes(name)) add('error', name, 'FORBIDDEN_IN_PRODUCTION');
    else if (absent.includes(name)) add('error', name, 'RECORDS_OR_FILES');
    else if (!(name in rules)) add('error', name, `NOT_A_${profile.toUpperCase()}_SETTING`);
  }
  for (const [name, rule] of Object.entries(rules)) {
    const value = values[name];
    const isRequired = name in required;
    if (value === undefined || value === '') { if (isRequired) add('error', name, 'MISSING'); else if (name in recommended) add('warn', name, 'RECOMMENDED_MISSING'); continue; }
    if (rule.exact !== undefined && value !== rule.exact) add('error', name, 'WRONG_VALUE');
    if (rule.pattern && !rule.pattern.test(value)) add('error', name, rule.why);
    if (rule.secret) {
      if (PLACEHOLDER.test(value)) add('error', name, 'LOOKS_LIKE_A_PLACEHOLDER');
      if (!(rule.chars ?? /^[A-Za-z0-9._-]+$/).test(value)) add('error', name, 'UNEXPECTED_CHARACTERS');
      if (value.length < (rule.min ?? 16) || value.length > (rule.max ?? 256)) add('error', name, 'IMPLAUSIBLE_LENGTH');
    }
  }
  const secrets = Object.entries(rules).filter(([, r]) => r.secret).map(([n]) => n).filter(n => values[n]);
  for (const a of secrets) if (secrets.some(b => b !== a && values[a] === values[b])) add('error', a, 'SAME_AS_ANOTHER_SECRET');
  if (zoomEnv) for (const name of ZOOM_NAMES) if (values[name] && values[name] !== zoomEnv[name]) add('error', name, 'DIFFERS_FROM_THE_CHECKED_ZOOM_ENV');
  return findings;
}

export function summary(findings) {
  const errors = findings.filter(f => f.level === 'error').length;
  const warnings = findings.filter(f => f.level === 'warn').length;
  return { errors, warnings, lines: findings.map(f => `${f.level === 'error' ? 'FAIL' : 'WARN'} ${f.name}: ${f.code}`) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { profile: 'value', metadata: 'value', values: 'value', 'zoom-env': 'value' });
  if (!['closed', 'pilot', 'lessons'].includes(args.profile)) throw new Error('Give --profile closed|pilot|lessons');
  if (!args.metadata && !args.values) throw new Error('Give --metadata <file> and/or --values <file>');
  const findings = [];
  if (args.metadata) findings.push(...checkMetadata(JSON.parse(readFileSync(args.metadata, 'utf8').replace(/^﻿/, '')), args.profile));
  if (args.values) {
    if (!PROFILES[args.profile]) throw new Error('--values is checked against the pilot or lessons profile');
    const zoomEnv = args['zoom-env'] ? readSettingsFile(args['zoom-env']) : null;
    findings.push(...checkValues(readSettingsFile(args.values), { zoomEnv, profile: args.profile }));
  }
  const { errors, warnings, lines } = summary(findings);
  for (const line of lines) console.log(line);
  console.log(`${errors ? 'NOT READY' : 'PASS'} (${args.profile}): ${errors} problem(s), ${warnings} warning(s)${args.metadata ? '; metadata checked' : ''}${args.values ? '; values file checked' : ''}`);
  process.exitCode = errors ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(`env-check: ${error.message}`); process.exitCode = 2; });
