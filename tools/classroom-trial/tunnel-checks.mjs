// Checks around the Cloudflare Quick Tunnel (2026-10-30): which cloudflared to run, whether it
// is new enough for --allowed-mail, and whether the open tunnel stops a visitor at Cloudflare's
// email PIN before anything reaches this computer.
import { existsSync } from 'node:fs';
import path from 'node:path';

// cloudflared learned --allowed-mail in 2026.9.2 (its release notes, 2026-09-22). The flag is hidden
// from `cloudflared tunnel --help`, so the version is what to check.
export const ALLOWED_MAIL_SINCE = '2026.9.2';

// The copy installed for the trial (its checksum and Cloudflare's signature checked), else one on PATH.
export function cloudflaredPath(given) {
  if (given) return given;
  const installed = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'iHear-classroom-trial', 'cloudflared', 'cloudflared.exe') : '';
  return installed && existsSync(installed) ? installed : 'cloudflared';
}

export const versionOf = text => /\b(\d{4})\.(\d+)\.(\d+)\b/.exec(String(text))?.slice(1).map(Number) ?? null;

export function newEnough(version, since = ALLOWED_MAIL_SINCE) {
  const wanted = versionOf(since);
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) if (version[index] !== wanted[index]) return version[index] > wanted[index];
  return true;
}

// One anonymous request to the tunnel's address, as a browser makes it:
//   'open'    the trial server answered (its own X-iHear-Trial header): no PIN stood in the way.
//   'gated'   Cloudflare answered instead: a redirect to its email-PIN sign-in, a refusal, or its
//             own sign-in page.
//   'unknown' anything else, such as an address that does not work yet: ask again.
export function gateVerdict({ status, headers, body = '' }) {
  const header = name => String((typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) ?? '');
  if (header('x-ihear-trial')) return 'open';
  if ([301, 302, 303, 307, 308].includes(status) && /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(header('location'))) return 'gated';
  if (status === 401 || status === 403) return 'gated';
  if (status === 200 && /cloudflare/i.test(body) && /e-?mail|one-time|\bPIN\b|\bcode\b/i.test(body)) return 'gated';
  return 'unknown';
}

// Asks the address until Cloudflare's answer is clear, for at most `ms`.
export async function checkGate(address, { ms = 90_000, every = 3_000, request = fetch } = {}) {
  const until = Date.now() + ms;
  let last = 'no answer yet';
  for (;;) {
    try {
      const response = await request(`${address.replace(/\/$/, '')}/admin`, { redirect: 'manual', headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (iHear trial gate check)' } });
      // Always read to the end, so no connection is left open.
      const body = await response.text().catch(() => '');
      const verdict = gateVerdict({ status: response.status, headers: response.headers, body });
      const location = response.headers.get('location');
      last = `${response.status}${location ? ` to ${new URL(location, address).host}` : ''}`;
      if (verdict !== 'unknown') return { verdict, last };
    } catch (error) {
      last = error.cause?.code ?? error.name ?? 'request failed';
    }
    if (Date.now() + every > until) return { verdict: 'unknown', last };
    await new Promise(resolve => { setTimeout(resolve, every); });
  }
}
