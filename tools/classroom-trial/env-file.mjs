// The trial's vendor-key file (2026-10-30), read the same way by the trial server and the local
// join check. Nothing here prints or returns a value: errors and the --check summary name a
// setting and the kind of problem only, never a value, its length or any part of a line.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The only settings the file may hold: the classroom provider and its vendor keys.
export const VENDOR_KEYS = new Set([
  'CLASSROOM_PROVIDER',
  'ZOOM_VIDEO_SDK_KEY', 'ZOOM_VIDEO_SDK_SECRET', 'ZOOM_VIDEO_SDK_API_KEY', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET',
  'LCIC_SDK_APP_ID', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'LCIC_CALLBACK_KEY', 'LCIC_API_HOST',
]);
// What each provider's adapter needs set.
const REQUIRED = {
  'zoom-video-sdk': ['ZOOM_VIDEO_SDK_KEY', 'ZOOM_VIDEO_SDK_SECRET', 'ZOOM_VIDEO_SDK_API_KEY', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET'],
  'tencent-lcic': ['LCIC_SDK_APP_ID', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'LCIC_CALLBACK_KEY'],
};
// Round 1 makes no Zoom REST call and receives no webhook or LCIC callback, so these may be local
// placeholders (the adapters still want them set).
const UNUSED_IN_ROUND_1 = new Set(['ZOOM_VIDEO_SDK_API_KEY', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET', 'LCIC_CALLBACK_KEY']);
// Values that must never reach a browser, a log or a file the trial writes.
export const SECRET_KEYS = ['ZOOM_VIDEO_SDK_SECRET', 'ZOOM_VIDEO_SDK_API_SECRET', 'ZOOM_VIDEO_SDK_WEBHOOK_SECRET', 'TENCENTCLOUD_SECRET_KEY', 'LCIC_CALLBACK_KEY'];
// Next.js loads these from the site folder by itself, after the trial server has cleared the shell.
const NEXT_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

export function checkSiteFolder(root) {
  const found = NEXT_ENV_FILES.filter(name => existsSync(path.join(root, name)));
  if (found.length) throw new Error(`Next.js would load ${found.join(', ')} from the site folder; run the trial from a checkout without them`);
}

export function readVendorEnv(file, root) {
  const resolved = path.resolve(file);
  if (!path.relative(root, resolved).startsWith('..')) throw new Error('The env file must be outside the repository');
  // OneDrive (the Desktop and Documents on this computer) copies its files to the cloud.
  if (/[\\/]OneDrive[^\\/]*[\\/]/i.test(resolved)) throw new Error('The env file must not be in a OneDrive folder, which copies it to the cloud');
  const settings = {};
  readFileSync(resolved, 'utf8').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
    // The line number only: the line itself may be a pasted key.
    if (!match) throw new Error(`Line ${index + 1} of the env file is not NAME=value`);
    if (!VENDOR_KEYS.has(match[1])) throw new Error(`The env file may hold only the classroom's vendor settings, not ${match[1]}`);
    settings[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  });
  const required = REQUIRED[settings.CLASSROOM_PROVIDER];
  if (!required) throw new Error('CLASSROOM_PROVIDER must be zoom-video-sdk or tencent-lcic');
  const empty = required.filter(name => !settings[name]);
  if (empty.length) throw new Error(`Fill in ${empty.join(', ')} in the env file`);
  return settings;
}

// A safety net under code that never prints a value anyway: every value from the file except the
// provider's name and the LCIC host is replaced in whatever this process prints, Next.js's own
// messages and error stacks included.
export function hideInOutput(settings) {
  const values = Object.entries(settings).filter(([name, value]) => !['CLASSROOM_PROVIDER', 'LCIC_API_HOST'].includes(name) && value.length >= 8).map(([, value]) => value);
  if (!values.length) return;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => write(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? values.reduce((text, value) => text.split(value).join('[hidden]'), String(chunk)) : chunk, ...rest);
  }
}

// The --check summary: each setting's name and whether it looks usable.
export function describeVendorEnv(settings) {
  const required = REQUIRED[settings.CLASSROOM_PROVIDER];
  const lines = [`CLASSROOM_PROVIDER: ${settings.CLASSROOM_PROVIDER}`];
  for (const name of required) {
    const plain = /^[A-Za-z0-9._-]+$/.test(settings[name]);
    lines.push(`${name}: filled${UNUSED_IN_ROUND_1.has(name) ? ' (not used in round 1)' : ''}${plain ? '' : '; it has spaces or other unexpected characters'}`);
  }
  const pairs = required.flatMap((name, index) => required.slice(index + 1).filter(other => settings[other] === settings[name]).map(other => `${name} and ${other} hold the same value`));
  return { lines: [...lines, ...pairs], ok: pairs.length === 0 && lines.every(line => !line.includes('unexpected')) };
}
