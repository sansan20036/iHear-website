// A local HTTP stand-in for the parts of Google's OAuth and Drive v3 that test A1 uses, written
// from Google's guides, so the adapter, the sign-in and the A1 runner can be checked offline
// before they ever reach Google. Synthetic only; it listens on 127.0.0.1.
// What it follows (and where Google's guide is silent, what it assumes):
// - resumable uploads: a 200 with Location opens a session; chunks carry Content-Range; a 308's
//   Range is inclusive and missing when nothing was received; 200 when complete; 404 for an
//   unknown or expired session; any 4xx ends the session ("restart the upload"); chunks other
//   than the last must be multiples of 256 KiB (else 400). Assumed: a chunk that does not start
//   where the session stands writes nothing and gets a 308 with the current Range.
// - files.list: the three query forms the adapter sends, small pages (pageSize 2) so paging is
//   exercised, and an optional delay before a new file shows in searches.
// - errors in Drive's JSON shape with a reason, e.g. 404 notFound, 401 authError, 403
//   storageQuotaExceeded.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const FOLDER = 'application/vnd.google-apps.folder';
const CHUNK_UNIT = 256 * 1024;
const unquote = text => text.replace(/\\(.)/g, '$1');

export async function startMockDrive({ account = 'synthetic-tester@example.test', quotaLimit = 15 * 1024 ** 3, searchLagMs = 0, pageSize = 2 } = {}) {
  const files = new Map();
  const sessions = new Map();
  const grants = new Map();         // refresh token -> { revoked }
  const accessTokens = new Map();   // access token -> refresh token
  const codes = new Map();          // auth code -> { challenge, redirectUri }
  const faults = { nextChunk: [], nextStatus: [] };
  const log = [];
  let ids = 0;
  let lastCreated = 0;
  let base = '';

  const usage = () => [...files.values()].filter(file => !file.trashed && file.mimeType !== FOLDER).reduce((sum, file) => sum + file.size, 0);
  const json = (response, status, body, headers = {}) => response.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
  const driveError = (response, status, reason, headers = {}) => json(response, status, { error: { code: status, message: reason, errors: [{ domain: 'global', reason, message: reason }] } }, headers);
  const view = file => ({
    kind: 'drive#file', id: file.id, name: file.name, mimeType: file.mimeType, parents: [file.parentId], appProperties: file.appProperties,
    size: file.mimeType === FOLDER ? undefined : String(file.size), md5Checksum: file.md5 ?? undefined, createdTime: new Date(file.createdTime).toISOString(), trashed: file.trashed,
  });
  const pick = (object, fields) => {
    const wanted = String(fields || '').replace(/^.*files\(|\)$/g, '').split(',').map(field => field.trim()).filter(Boolean);
    if (!wanted.length) return object;
    return Object.fromEntries(Object.entries(object).filter(([key]) => wanted.includes(key) || key === 'kind'));
  };
  const range = received => (received > 0 ? { Range: `bytes=0-${received - 1}` } : {});
  const bodyOf = request => new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
  const authorized = request => accessTokens.has(String(request.headers.authorization || '').replace(/^Bearer /, ''))
    && !grants.get(accessTokens.get(String(request.headers.authorization).replace(/^Bearer /, '')))?.revoked;

  function search(q) {
    const strings = [...q.matchAll(/'((?:\\.|[^'\\])*)'/g)].map(match => unquote(match[1]));
    const visible = file => !file.trashed && Date.now() - file.createdTime >= searchLagMs;
    if (q.includes('appProperties has')) {
      const [key, value] = strings;
      return [...files.values()].filter(file => visible(file) && file.appProperties?.[key] === value);
    }
    if (q.startsWith('name = ')) {
      const [name, parent] = strings;
      return [...files.values()].filter(file => visible(file) && file.mimeType === FOLDER && file.name === name && file.parentId === parent);
    }
    const [parent] = strings;
    return [...files.values()].filter(file => visible(file) && file.parentId === parent);
  }

  function createFile({ name, parentId, mimeType, appProperties = {}, content = null }) {
    const id = `mock-file-${++ids}`;
    files.set(id, {
      id, name, parentId, mimeType, appProperties, size: content ? content.length : 0,
      // Never in the future, and unique, so the order of creation is unambiguous.
      md5: content ? createHash('md5').update(content).digest('hex') : null, createdTime: (lastCreated = Math.max(Date.now(), lastCreated + 1)), trashed: false,
    });
    return files.get(id);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, base);
    const body = await bodyOf(request);
    log.push({ method: request.method, path: url.pathname });
    try {
      // OAuth -------------------------------------------------------------------------------
      if (url.pathname === '/o/oauth2/v2/auth') {
        // Consent is given at once; the browser is sent back to the loopback redirect.
        const code = randomBytes(8).toString('hex');
        codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirectUri: url.searchParams.get('redirect_uri'), scope: url.searchParams.get('scope') });
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state'));
        response.writeHead(302, { Location: back.toString() }).end();
        return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const form = new URLSearchParams(body.toString());
        if (form.get('grant_type') === 'authorization_code') {
          const grant = codes.get(form.get('code'));
          const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
          if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get('redirect_uri')) return json(response, 400, { error: 'invalid_grant' });
          codes.delete(form.get('code'));
          const refresh = `mock-refresh-${randomBytes(6).toString('hex')}`;
          grants.set(refresh, { revoked: false });
          const access = `mock-access-${randomBytes(6).toString('hex')}`;
          accessTokens.set(access, refresh);
          return json(response, 200, { access_token: access, expires_in: 3599, refresh_token: refresh, scope: grant.scope, token_type: 'Bearer' });
        }
        const refresh = form.get('refresh_token');
        if (!grants.has(refresh) || grants.get(refresh).revoked) return json(response, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const access = `mock-access-${randomBytes(6).toString('hex')}`;
        accessTokens.set(access, refresh);
        return json(response, 200, { access_token: access, expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' });
      }
      if (url.pathname === '/revoke' && request.method === 'POST') {
        const token = new URLSearchParams(body.toString()).get('token');
        const refresh = grants.has(token) ? token : accessTokens.get(token);
        if (!refresh) return json(response, 400, { error: 'invalid_token' });
        grants.get(refresh).revoked = true;
        return json(response, 200, {});
      }

      // Upload sessions (the session URI itself carries the upload) --------------------------
      if (url.pathname === '/upload/drive/v3/files' && request.method === 'PUT') {
        const session = sessions.get(url.searchParams.get('upload_id'));
        if (!session || session.spent) return driveError(response, 404, 'notFound');
        const contentRange = String(request.headers['content-range'] || '');
        const status = /^bytes \*\/(\d+|\*)$/.exec(contentRange);
        if (status) {
          const fault = faults.nextStatus.shift();
          if (fault) return driveError(response, fault.status, fault.reason);
          if (session.fileId) return json(response, 200, view(files.get(session.fileId)));
          return response.writeHead(308, range(session.received)).end();
        }
        const chunk = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
        if (!chunk) return driveError(response, 400, 'badContentRange');
        const [start, end, total] = chunk.slice(1).map(Number);
        const fault = faults.nextChunk.shift();
        if (fault) {
          if (fault.status >= 400 && fault.status < 500) session.spent = true;   // "restart the upload"
          return driveError(response, fault.status, fault.reason, fault.retryAfter ? { 'Retry-After': String(fault.retryAfter) } : {});
        }
        if (session.fileId) return json(response, 200, view(files.get(session.fileId)));
        if (end - start + 1 !== body.length || total !== session.size) return driveError(response, 400, 'badContentRange');
        if (end + 1 < total && body.length % CHUNK_UNIT !== 0) return driveError(response, 400, 'chunkNotMultipleOf256KiB');
        if (start !== session.received) return response.writeHead(308, range(session.received)).end();
        if (usage() + session.received + body.length > quotaLimit) {
          session.spent = true;
          return driveError(response, 403, 'storageQuotaExceeded');
        }
        session.chunks.push(body);
        session.received += body.length;
        if (session.received < total) return response.writeHead(308, range(session.received)).end();
        const file = createFile({ ...session.meta, content: Buffer.concat(session.chunks) });
        session.fileId = file.id;
        return json(response, 200, view(file));
      }

      // Everything else needs a valid access token. ------------------------------------------
      if (!authorized(request)) return driveError(response, 401, 'authError');
      if (url.pathname === '/upload/drive/v3/files' && request.method === 'POST' && url.searchParams.get('uploadType') === 'resumable') {
        const meta = JSON.parse(body.toString() || '{}');
        const size = Number(request.headers['x-upload-content-length']);
        const id = randomBytes(12).toString('base64url');
        sessions.set(id, { size, received: 0, chunks: [], fileId: null, spent: false, meta: { name: meta.name, parentId: meta.parents?.[0], mimeType: meta.mimeType, appProperties: meta.appProperties ?? {} } });
        return response.writeHead(200, { Location: `${base}/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` }).end();
      }
      if (url.pathname === '/drive/v3/about') {
        return json(response, 200, { user: { emailAddress: account }, storageQuota: { limit: String(quotaLimit), usage: String(usage()) } });
      }
      if (url.pathname === '/drive/v3/files' && request.method === 'GET') {
        const all = search(url.searchParams.get('q') ?? '').sort((a, b) => a.createdTime - b.createdTime);
        const offset = Number(url.searchParams.get('pageToken') || 0);
        const page = all.slice(offset, offset + pageSize);
        return json(response, 200, { files: page.map(file => pick(view(file), url.searchParams.get('fields'))), ...(offset + pageSize < all.length ? { nextPageToken: String(offset + pageSize) } : {}) });
      }
      if (url.pathname === '/drive/v3/files' && request.method === 'POST') {
        const meta = JSON.parse(body.toString() || '{}');
        return json(response, 200, { id: createFile({ name: meta.name, parentId: meta.parents?.[0], mimeType: meta.mimeType, appProperties: meta.appProperties }).id });
      }
      // Who can open a file (P3-Multi, 18.5): its owner, plus any sharing set on it or on a folder
      // above it (Drive passes a folder's sharing on to what is inside). Tests set `sharing` on a
      // stand-in file or folder to share it.
      const permissionsMatch = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(url.pathname);
      if (permissionsMatch && request.method === 'GET') {
        const file = files.get(decodeURIComponent(permissionsMatch[1]));
        if (!file) return driveError(response, 404, 'notFound');
        const permissions = [{ type: 'user', role: 'owner', emailAddress: 'mock-owner@example.test' }];
        for (let at = file, hops = 0; at && hops < 50; at = files.get(at.parentId), hops += 1) permissions.push(...(at.sharing ?? []));
        return json(response, 200, { permissions });
      }
      const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (fileMatch) {
        const file = files.get(decodeURIComponent(fileMatch[1]));
        if (!file) return driveError(response, 404, 'notFound');
        if (request.method === 'GET') return json(response, 200, pick(view(file), url.searchParams.get('fields')));
        if (request.method === 'PATCH') {
          Object.assign(file, { trashed: Boolean(JSON.parse(body.toString() || '{}').trashed) });
          return json(response, 200, { id: file.id });
        }
        if (request.method === 'DELETE') {
          for (const child of [...files.values()].filter(entry => entry.parentId === file.id)) files.delete(child.id);
          files.delete(file.id);
          return response.writeHead(204).end();
        }
      }
      return driveError(response, 404, 'notFound');
    } catch (error) {
      return driveError(response, 500, `mockError: ${error.message}`);
    }
  });
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    endpoints: { authorize: `${base}/o/oauth2/v2/auth`, token: `${base}/token`, revoke: `${base}/revoke` },
    files,
    sessions,
    faults,
    log,
    // Another app's (or a person's) file: drive.file cannot see it, but it takes up space.
    addForeignUsage(bytes) {
      createFile({ name: 'someone-else.bin', parentId: 'elsewhere', mimeType: 'application/octet-stream', content: Buffer.alloc(bytes) });
    },
    close: () => new Promise(resolve => { server.close(resolve); }),
  };
}
