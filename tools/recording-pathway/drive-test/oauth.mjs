// OAuth for test A1 only: a Desktop-app client in the P1 test account's own Google Cloud project,
// the drive.file scope and nothing else. Google's guide for installed apps: a loopback redirect
// (http://127.0.0.1:<port>), PKCE with S256, refresh tokens always returned; a Desktop app is a
// public client, so the client secret is not a real secret, but the refresh token is.
// The token file goes into a folder that only the current Windows user can read, and the folder
// is locked down before anything is written. Tokens are never printed or logged.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { FAILURE, FilingError } from '../classroom/recording-filing.mjs';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
});

// Only the current user (not inherited groups) may open the folder. Checked afterwards.
export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true });
  if (process.platform !== 'win32') return;
  const user = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${os.userInfo().username}`;
  const set = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true });
  if (set.status !== 0) throw new Error(`could not restrict ${dir}: ${set.stderr || set.stdout}`);
  const show = spawnSync('icacls', [dir], { encoding: 'utf8', windowsHide: true });
  const others = show.stdout.split(/\r?\n/).slice(0, -2).map(line => line.replace(dir, '').trim()).filter(Boolean)
    .filter(line => !line.toLowerCase().startsWith(user.toLowerCase()) && !line.toLowerCase().startsWith(os.userInfo().username.toLowerCase()));
  if (others.length) throw new Error(`${dir} is still open to: ${others.join('; ')}`);
}

// The client file as downloaded from Google Auth Platform > Clients (Desktop app).
export async function readClient(clientFile) {
  const json = JSON.parse(await readFile(clientFile, 'utf8'));
  const client = json.installed ?? json;
  if (!client.client_id) throw new Error('not a Desktop-app OAuth client file');
  return { clientId: client.client_id, clientSecret: client.client_secret ?? '' };
}

const base64url = bytes => Buffer.from(bytes).toString('base64url');

/**
 * Signs in with the loopback flow and saves the refresh token. `openUrl` gets the consent URL
 * (print it, or open it in the test account's browser profile); nothing else is printed.
 * @param {{ clientFile: string, tokenFile: string, endpoints?: { authorize: string, token: string },
 *   openUrl: (url: string) => void | Promise<void>, fetchImpl?: typeof fetch, timeoutMs?: number }} input
 */
export async function authorize({ clientFile, tokenFile, endpoints = GOOGLE, openUrl, fetchImpl = globalThis.fetch, timeoutMs = 10 * 60_000 }) {
  const client = await readClient(clientFile);
  await ensurePrivateDir(path.dirname(tokenFile));
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(16));
  let finish;
  const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/') {
      response.writeHead(404).end();
      return;
    }
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
    response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(ok ? 'iHear A1: sign-in received. You can close this tab.' : 'iHear A1: sign-in failed or was cancelled.');
    if (ok) finish.resolve(url.searchParams.get('code'));
    else finish.reject(new Error(`sign-in refused: ${url.searchParams.get('error') ?? 'state mismatch'}`));
  });
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => finish.reject(new Error('sign-in timed out')), timeoutMs);
  try {
    const consent = new URL(endpoints.authorize);
    for (const [key, value] of Object.entries({
      client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', scope: DRIVE_FILE_SCOPE,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      state, access_type: 'offline', prompt: 'consent',
    })) consent.searchParams.set(key, value);
    await openUrl(consent.toString());
    const code = await done;
    const response = await fetchImpl(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.refresh_token) throw new Error(`token exchange failed: ${body.error ?? response.status}`);
    const scopes = String(body.scope ?? '').split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== DRIVE_FILE_SCOPE) {
      await revokeToken({ token: body.refresh_token, endpoint: endpoints.revoke ?? GOOGLE.revoke, fetchImpl }).catch(() => undefined);
      throw new Error(`refused: the grant has scopes other than drive.file (${scopes.join(' ')})`);
    }
    await writeFile(tokenFile, `${JSON.stringify({ refresh_token: body.refresh_token, scope: body.scope, obtainedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    return { scope: body.scope };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

// Access tokens from the saved refresh token, renewed a minute before they expire. A refused
// refresh (revoked, expired after 7 days in Testing) is DRIVE_AUTH: filing pauses. With
// `requireScope`, a grant whose scopes are not exactly that one is refused the same way, both as
// saved and as Google states it on each refresh, so a broader grant is never used.
// With `grant` (the approved production grant, 2026-11-09) the client and the refresh token come
// from the site's configuration instead of the two files, and Google's answer must state the
// scope, which must be exactly the one allowed: nothing is assumed about a grant not seen.
/** @param {{ clientFile?: string, tokenFile?: string, grant?: { clientId: string, clientSecret: string, refreshToken: string } | null, endpoint?: string, fetchImpl?: typeof fetch, requireScope?: string | null }} input */
export function tokenProvider({ clientFile, tokenFile, grant = null, endpoint = GOOGLE.token, fetchImpl = globalThis.fetch, requireScope = null }) {
  let cached = null;
  const exactly = scope => String(scope ?? '').split(/\s+/).filter(Boolean).join(' ') === requireScope;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const client = grant ? { clientId: grant.clientId, clientSecret: grant.clientSecret } : await readClient(clientFile);
    const saved = grant ? { refresh_token: grant.refreshToken, scope: requireScope } : JSON.parse(await readFile(tokenFile, 'utf8'));
    const refreshToken = saved.refresh_token;
    if (requireScope && !exactly(saved.scope)) throw new FilingError(FAILURE.DRIVE_AUTH, 'the saved grant is not limited to the one scope allowed');
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
      });
    } catch {
      throw new FilingError(FAILURE.TRANSIENT, 'no answer from the token endpoint');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new FilingError(response.status === 400 || response.status === 401 ? FAILURE.DRIVE_AUTH : FAILURE.TRANSIENT, `token refresh refused (${body.error ?? response.status})`);
    if (requireScope && body.scope != null && !exactly(body.scope)) throw new FilingError(FAILURE.DRIVE_AUTH, 'the refreshed token carries scopes beyond the one allowed');
    if (grant && requireScope && body.scope == null) throw new FilingError(FAILURE.DRIVE_AUTH, 'Google did not state the scope of the production grant');
    cached = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 0) * 1000 };
    return cached.token;
  };
}

// Google's revoke endpoint; revoking the refresh token also ends its access tokens.
export async function revokeToken({ token, endpoint = GOOGLE.revoke, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
  return response.status;
}

// Revokes the saved grant, checks that a refresh is now refused, then deletes the token file.
export async function revokeSaved({ clientFile, tokenFile, endpoints = GOOGLE, fetchImpl = globalThis.fetch }) {
  const { refresh_token: refreshToken } = JSON.parse(await readFile(tokenFile, 'utf8'));
  const revokeStatus = await revokeToken({ token: refreshToken, endpoint: endpoints.revoke, fetchImpl });
  let refreshRefused = false;
  try {
    await tokenProvider({ clientFile, tokenFile, endpoint: endpoints.token, fetchImpl })();
  } catch (error) {
    refreshRefused = error instanceof FilingError && error.code === FAILURE.DRIVE_AUTH;
  }
  if (refreshRefused) await rm(tokenFile, { force: true });
  return { revokeStatus, refreshRefused, tokenFileDeleted: refreshRefused };
}
