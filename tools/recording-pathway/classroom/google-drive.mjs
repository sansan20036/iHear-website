// Google Drive (API v3) behind the interface the filing worker uses (see lib/classroom-drive.ts).
// It follows Drive's "Upload file data" guide for resumable uploads: a session is opened with
// the file's metadata and size, chunks are sent with Content-Range, a 308 answer's Range header
// says how much Drive holds (inclusive), and an empty PUT with "Content-Range: bytes */*" asks
// for the session's state. Answers are turned into the worker's outcomes by
// classifyDriveResponse and driveUploadState, so a 4xx on a session ends it and a 5xx is
// resumed. Searches read every page. Only what the drive.file scope allows is used: the folders
// and files this app creates.
//
// Not yet run against Google: test A1 (docs/a1-drive-test-runbook.md) checks it with a test
// account. Tokens come from `accessToken()` and are never logged; nor are session URIs.
import { classifyDriveResponse, driveUploadState, FAILURE, FilingError } from './recording-filing.mjs';

const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,parents,appProperties,size,md5Checksum,createdTime,trashed';
const MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', mov: 'video/quicktime' };
// A value inside a Drive query: quotes and backslashes escaped.
export const driveQuote = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const toFile = file => ({
  id: file.id,
  name: file.name,
  parentId: file.parents?.[0] ?? null,
  appProperties: file.appProperties ?? {},
  size: Number(file.size ?? 0),
  md5: file.md5Checksum ?? null,
  createdTime: Date.parse(file.createdTime),
  trashed: Boolean(file.trashed),
});

/**
 * @param {{ accessToken: () => Promise<string>, rootFolderId?: string, apiBase?: string,
 *   fetchImpl?: typeof fetch, onAnswer?: ((answer: { operation: string, status: number, range: string | null }) => void) | null }} options
 */
export function createGoogleDrive({ accessToken, rootFolderId = 'root', apiBase = 'https://www.googleapis.com', fetchImpl = globalThis.fetch, onAnswer = null }) {
  async function request(method, url, { body = undefined, headers = {}, operation }) {
    let response;
    try {
      response = await fetchImpl(url, { method, body, redirect: 'manual', headers: { Authorization: `Bearer ${await accessToken()}`, ...headers } });
    } catch (error) {
      if (error instanceof FilingError) throw error;
      throw new FilingError(FAILURE.TRANSIENT, `no answer from Drive (${error?.cause?.code ?? error?.name ?? 'network'})`);
    }
    onAnswer?.({ operation, status: response.status, range: response.headers.get('range') });
    return response;
  }
  async function fail(response, operation) {
    let reason = '';
    try {
      const body = await response.json();
      reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
    } catch {
      // not JSON
    }
    const failure = classifyDriveResponse({ status: response.status, reason, retryAfter: response.headers.get('retry-after'), operation: operation === 'session' ? 'session' : 'other' });
    throw new FilingError(failure.code, `Drive answered ${response.status}${reason ? ` (${reason})` : ''} to ${operation}`, failure);
  }
  async function api(method, path, operation, { query = {}, json = undefined } = {}) {
    const url = new URL(`${apiBase}/drive/v3/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await request(method, url, {
      operation,
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: json === undefined ? {} : { 'Content-Type': 'application/json; charset=UTF-8' },
    });
    if (!response.ok) await fail(response, operation);
    return response.status === 204 ? null : response.json();
  }
  async function search(q, fields, operation) {
    const files = [];
    let pageToken = null;
    do {
      const page = await api('GET', 'files', operation, { query: { q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces: 'drive', ...(pageToken ? { pageToken } : {}) } });
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);
    return files;
  }

  // Folders found or made by this process. Drive's search can lag, so a folder created a moment
  // ago may not be found again yet; remembering it keeps one process from making a second one.
  const folders = new Map();
  const findFolders = async (parentId, name) => (await search(`name = ${driveQuote(name)} and ${driveQuote(parentId)} in parents and mimeType = '${FOLDER}' and trashed = false`, 'id,createdTime', 'findFolder'))
    .sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime) || a.id.localeCompare(b.id)).map(folder => folder.id);

  return {
    rootFolderId,
    findFolders,
    async whoAmI() {
      const about = await api('GET', 'about', 'about', { query: { fields: 'user(emailAddress)' } });
      return about?.user?.emailAddress ?? null;
    },
    async quota() {
      const quota = (await api('GET', 'about', 'quota', { query: { fields: 'storageQuota(limit,usage)' } }))?.storageQuota ?? {};
      return { limit: quota.limit == null ? null : Number(quota.limit), usage: Number(quota.usage ?? 0) };
    },
    // The oldest folder with this name, or a new one. Two processes creating it at the same
    // moment (or one creating it while search still lags) can make two; once search shows both,
    // everyone keeps using the oldest.
    async ensureFolder(parentId, name) {
      const key = `${parentId}/${name}`;
      if (folders.has(key)) return folders.get(key);
      const id = (await findFolders(parentId, name))[0]
        ?? (await api('POST', 'files', 'createFolder', { query: { fields: 'id' }, json: { name, mimeType: FOLDER, parents: [parentId] } })).id;
      folders.set(key, id);
      return id;
    },
    // With drive.file this lists only the files this app created there.
    async listNames(folderId) {
      return (await search(`${driveQuote(folderId)} in parents and trashed = false`, 'name', 'listNames')).map(file => file.name);
    },
    async findByAppProperty(key, value) {
      return (await search(`appProperties has { key=${driveQuote(key)} and value=${driveQuote(value)} } and trashed = false`, FILE_FIELDS, 'findByAppProperty')).map(toFile);
    },
    async getFile(id) {
      const url = new URL(`${apiBase}/drive/v3/files/${encodeURIComponent(id)}`);
      url.searchParams.set('fields', FILE_FIELDS);
      const response = await request('GET', url, { operation: 'getFile' });
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, 'getFile');
      return toFile(await response.json());
    },
    async startUpload({ name, parentId, size, appProperties }) {
      const type = MIME[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()] ?? 'application/octet-stream';
      const url = new URL(`${apiBase}/upload/drive/v3/files`);
      url.searchParams.set('uploadType', 'resumable');
      url.searchParams.set('fields', 'id');
      const response = await request('POST', url, {
        operation: 'startUpload',
        body: JSON.stringify({ name, parents: [parentId], appProperties, mimeType: type }),
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(size) },
      });
      if (response.status !== 200) await fail(response, 'startUpload');
      const location = response.headers.get('location');
      if (!location) throw new FilingError(FAILURE.TRANSIENT, 'Drive opened no upload session');
      return location;
    },
    async uploadStatus(uri) {
      const response = await request('PUT', uri, { operation: 'session', body: Buffer.alloc(0), headers: { 'Content-Range': 'bytes */*' } });
      const fileId = response.status === 200 || response.status === 201 ? (await response.json()).id : null;
      return driveUploadState({ status: response.status, range: response.headers.get('range'), fileId });
    },
    async uploadChunk(uri, { offset, bytes, total }) {
      const range = bytes.length ? `bytes ${offset}-${offset + bytes.length - 1}/${total}` : `bytes */${total}`;
      const response = await request('PUT', uri, { operation: 'session', body: bytes, headers: { 'Content-Range': range } });
      if (response.status === 308) return { received: driveUploadState({ status: 308, range: response.headers.get('range') }).received, fileId: null };
      if (response.status === 200 || response.status === 201) return { received: total, fileId: (await response.json()).id };
      return fail(response, 'session');
    },
    async trash(id) {
      await api('PATCH', `files/${encodeURIComponent(id)}`, 'trash', { query: { fields: 'id' }, json: { trashed: true } });
    },
    // Test cleanup only: permanently deletes a file or folder this app created.
    async remove(id) {
      await api('DELETE', `files/${encodeURIComponent(id)}`, 'remove');
    },
  };
}
