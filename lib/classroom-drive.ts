import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { createGoogleDrive } from "../tools/recording-pathway/classroom/google-drive.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { FAILURE, FilingError } from "../tools/recording-pathway/classroom/recording-filing.mjs";
// @ts-ignore - the test sign-in's token handling (Desktop client, drive.file only), tested with node --test.
import { DRIVE_FILE_SCOPE, GOOGLE, tokenProvider } from "../tools/recording-pathway/drive-test/oauth.mjs";

// Where finished recordings are filed: a local folder standing in for Google Drive (local), or
// Google Drive itself for the local recording test (google). The stand-in keeps the behaviour the
// filing logic depends on: appProperties to find an upload again, resumable sessions that take a
// file in chunks and say how much they hold, a storage quota (CLASSROOM_DRIVE_LOCAL_QUOTA_BYTES,
// to try a full Drive locally) and a trash. The Google Drive adapter (drive.file scope, a folder
// the app creates) maps Drive's answers with classifyDriveResponse.

export type DriveFile = {
  id: string;
  name: string;
  parentId: string;
  appProperties: Record<string, string>;
  size: number;
  md5: string | null;
  createdTime: number;
  trashed: boolean;
};

export type UploadStatus = { state: "active"; received: number } | { state: "complete"; fileId: string } | { state: "gone" };

export type ClassroomDrive = {
  // Which Drive this is, recorded with each filed copy: Google Drive, or the local stand-in that
  // synthetic tests use (never shown as Google Drive).
  kind: "local" | "google";
  rootFolderId: string;
  quota(): Promise<{ limit: number | null; usage: number }>;
  ensureFolder(parentId: string, name: string): Promise<string>;
  listNames(folderId: string): Promise<string[]>;
  findByAppProperty(key: string, value: string): Promise<DriveFile[]>;
  // Read directly by id: Drive's search can lag behind a file that was just uploaded.
  getFile(id: string): Promise<DriveFile | null>;
  startUpload(meta: { name: string; parentId: string; size: number; appProperties: Record<string, string> }): Promise<string>;
  uploadStatus(uri: string): Promise<UploadStatus>;
  // Like Drive, a chunk that does not start where the session stands writes nothing, and the
  // answer says where the session stands.
  uploadChunk(uri: string, chunk: { offset: number; bytes: Buffer; total: number }): Promise<{ received: number; fileId: string | null }>;
  trash(id: string): Promise<void>;
  // Deletes a copy this app made for good (Drive's trash still lets everyone who had access open
  // it): used only for a copy that turned out to be shared beyond the recording policy.
  remove(id: string): Promise<void>;
  // 18.5 (P3-Multi): who can open the file or folder, its own and inherited access, to check
  // against the recording policy before anything is uploaded into it and before a copy counts as
  // archived (2026-11-10: every recording).
  permissions(id: string): Promise<DrivePermission[]>;
};
export type DrivePermission = { type: string; role: string; domain?: string | null; emailAddress?: string | null };

export class ClassroomDriveUnavailableError extends Error {}

type UploadSession = {
  meta: { name: string; parentId: string; size: number; appProperties: Record<string, string> };
  received: number;
  fileId: string | null;
};
type DriveIndex = {
  ids: number;
  folders: Record<string, string>;
  files: Record<string, DriveFile>;
  sessions: Record<string, UploadSession>;
};

export function createLocalDrive(directory: string, { quotaLimit = null }: { quotaLimit?: number | null } = {}): ClassroomDrive {
  const indexPath = path.join(directory, "index.json");
  const sessionPath = (uri: string) => path.join(directory, "files", encodeURIComponent(uri));
  let queue: Promise<unknown> = Promise.resolve();
  async function load(): Promise<DriveIndex> {
    try {
      return JSON.parse(await readFile(indexPath, "utf8")) as DriveIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ids: 0, folders: {}, files: {}, sessions: {} };
      throw error;
    }
  }
  function run<T>(fn: (index: DriveIndex) => Promise<T> | T, write = true): Promise<T> {
    const operation = queue.then(async () => {
      await mkdir(path.join(directory, "files"), { recursive: true });
      const index = await load();
      const result = await fn(index);
      if (write) await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      return result;
    });
    queue = operation.catch(() => undefined);
    return operation;
  }
  const usage = (index: DriveIndex) => Object.values(index.files).filter((file) => !file.trashed).reduce((sum, file) => sum + file.size, 0);
  return {
    kind: "local",
    rootFolderId: "root",
    quota: () => run((index) => ({ limit: quotaLimit, usage: usage(index) }), false),
    ensureFolder: (parentId, name) => run((index) => {
      const key = `${parentId}/${name}`;
      index.folders[key] ??= `folder-${++index.ids}`;
      return index.folders[key];
    }),
    listNames: (folderId) => run((index) => Object.values(index.files).filter((file) => !file.trashed && file.parentId === folderId).map((file) => file.name), false),
    findByAppProperty: (key, value) => run((index) => Object.values(index.files).filter((file) => !file.trashed && file.appProperties[key] === value).map((file) => ({ ...file })), false),
    getFile: (id) => run((index) => (index.files[id] ? { ...index.files[id] } : null), false),
    startUpload: (meta) => run(async (index) => {
      const uri = `local-upload://session-${++index.ids}`;
      index.sessions[uri] = { meta, received: 0, fileId: null };
      await writeFile(sessionPath(uri), Buffer.alloc(0));
      return uri;
    }),
    uploadStatus: (uri) => run((index): UploadStatus => {
      const session = index.sessions[uri];
      if (!session) return { state: "gone" };
      return session.fileId ? { state: "complete", fileId: session.fileId } : { state: "active", received: session.received };
    }, false),
    uploadChunk: (uri, { offset, bytes, total }) => run(async (index) => {
      const session = index.sessions[uri];
      if (!session) throw new FilingError(FAILURE.SESSION_GONE, "upload session not found");
      if (session.fileId) return { received: session.received, fileId: session.fileId };
      if (offset !== session.received) return { received: session.received, fileId: null };
      if (quotaLimit != null && usage(index) + session.received + bytes.length > quotaLimit) {
        // As Drive's upload guide says, a 4xx ends the session; the upload starts again later.
        delete index.sessions[uri];
        throw new FilingError(FAILURE.DRIVE_QUOTA, "the local Drive stand-in is full", { restartSession: true });
      }
      await appendFile(sessionPath(uri), bytes);
      session.received += bytes.length;
      if (session.received < total) return { received: session.received, fileId: null };
      const id = `local-file-${++index.ids}`;
      index.files[id] = {
        id,
        name: session.meta.name,
        parentId: session.meta.parentId,
        appProperties: { ...session.meta.appProperties },
        size: session.received,
        md5: null,
        createdTime: index.ids,
        trashed: false,
      };
      session.fileId = id;
      return { received: session.received, fileId: id };
    }),
    trash: (id) => run((index) => {
      if (index.files[id]) index.files[id].trashed = true;
    }),
    remove: (id) => run((index) => {
      delete index.files[id];
    }),
    // The local stand-in shares nothing: only its owner can open a file.
    permissions: async () => [{ type: "user", role: "owner", emailAddress: null }],
  };
}

// The folder the recording test files into, under the test account's My Drive. Its name says
// it is a test, so nothing filed there is mistaken for a real lesson's recording.
export const GOOGLE_TEST_ROOT_NAME = "[測試] iHear P1 錄影測試";
// Stands for that folder until its id is known: the filing worker passes it back to ensureFolder.
const GOOGLE_ROOT = "google-test-root";

// A file the test's grant lives in: named in the environment, outside the site's folder (so it
// is never committed) and outside OneDrive (which copies files to the cloud).
function privateFile(env: Record<string, string | undefined>, name: string, siteFolder: string) {
  const value = env[name];
  if (!value || !path.isAbsolute(value)) throw new ClassroomDriveUnavailableError(`Set ${name} to the full path of the file`);
  const resolved = path.resolve(value);
  if (!path.relative(siteFolder, resolved).startsWith("..")) throw new ClassroomDriveUnavailableError(`${name} must be outside the site's folder`);
  if (/[\\/]OneDrive[^\\/]*[\\/]/i.test(resolved)) throw new ClassroomDriveUnavailableError(`${name} must not be in a OneDrive folder`);
  return resolved;
}

// The Drive folder iHear chose for recordings (P3-Multi, 2026-11-09), from configuration only: the
// id is never written into the code or the repository (which is public). Null when not set (the
// test folder is used). Caution, not yet tried against Google: with the drive.file grant the app
// may only write into a folder it created itself or one opened to it, so a folder iHear made needs
// that access arranged (and approved) before a real run; the stand-in does not enforce this.
export function driveParentFolderId(env: Record<string, string | undefined>) {
  const value = (env.CLASSROOM_DRIVE_PARENT_FOLDER_ID || "").trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(value)) throw new ClassroomDriveUnavailableError("CLASSROOM_DRIVE_PARENT_FOLDER_ID is not a Drive folder id");
  return value;
}

// Google's address, or the local stand-in's (tools/recording-pathway/drive-test/mock-drive-server.mjs)
// for tests; no other address is accepted, so a token is never sent anywhere else.
function googleAddress(value: string | undefined, google: string) {
  if (!value) return google;
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}(\/[A-Za-z0-9/_-]*)?$/.test(value)) throw new ClassroomDriveUnavailableError("Only Google itself or the local stand-in may be named");
  return value;
}

/**
 * Google Drive for the local P1 recording test only (2026-10-31). The grant is a test account's,
 * made with a Desktop OAuth client for drive.file and nothing else (the A1 sign-in,
 * tools/recording-pathway/drive-test); its two files (the client file as Google gives it, and the
 * token file the sign-in wrote) are named by CLASSROOM_GOOGLE_CLIENT_FILE and
 * CLASSROOM_GOOGLE_TOKEN_FILE. Recordings go into a folder this app creates
 * (CLASSROOM_DRIVE_ROOT_NAME, starting "[測試]"), so nothing else in that Drive is visible to it.
 * A grant that is not exactly drive.file pauses filing (DRIVE_AUTH). Never on a hosted site until
 * a production grant is approved.
 *
 * The approved production grant (2026-11-09): only with CLASSROOM_DRIVE_GRANT=production, the
 * site (Vercel included) takes the OAuth client and the folder owner's refresh token from its
 * encrypted configuration (CLASSROOM_GOOGLE_CLIENT_ID, CLASSROOM_GOOGLE_CLIENT_SECRET,
 * CLASSROOM_GOOGLE_REFRESH_TOKEN), files only under CLASSROOM_DRIVE_PARENT_FOLDER_ID, and uses the
 * grant only while Google states it is exactly drive.file. Nothing else changes.
 */
export function googleClassroomDrive(env: Record<string, string | undefined>, { fetchImpl = globalThis.fetch, siteFolder = process.cwd() }: { fetchImpl?: typeof fetch; siteFolder?: string } = {}): ClassroomDrive {
  const production = env.CLASSROOM_DRIVE_GRANT === "production";
  if ((env.VERCEL || env.VERCEL_ENV || env.NETLIFY) && !production) throw new ClassroomDriveUnavailableError("Google Drive filing runs only in the local recording test until a production grant is approved");
  const endpoint = googleAddress(env.CLASSROOM_GOOGLE_TOKEN_ENDPOINT, GOOGLE.token);
  let accessToken: () => Promise<string>;
  if (production) {
    const [clientId, clientSecret, refreshToken] = ["CLASSROOM_GOOGLE_CLIENT_ID", "CLASSROOM_GOOGLE_CLIENT_SECRET", "CLASSROOM_GOOGLE_REFRESH_TOKEN"].map((name) => (env[name] || "").trim());
    if (!clientId || !clientSecret || !refreshToken) throw new ClassroomDriveUnavailableError("The production grant needs CLASSROOM_GOOGLE_CLIENT_ID, CLASSROOM_GOOGLE_CLIENT_SECRET and CLASSROOM_GOOGLE_REFRESH_TOKEN");
    if (!driveParentFolderId(env)) throw new ClassroomDriveUnavailableError("The production grant files only under the folder named by CLASSROOM_DRIVE_PARENT_FOLDER_ID");
    accessToken = tokenProvider({ grant: { clientId, clientSecret, refreshToken }, fetchImpl, requireScope: DRIVE_FILE_SCOPE, endpoint });
  } else {
    const clientFile = privateFile(env, "CLASSROOM_GOOGLE_CLIENT_FILE", siteFolder);
    const tokenFile = privateFile(env, "CLASSROOM_GOOGLE_TOKEN_FILE", siteFolder);
    accessToken = tokenProvider({ clientFile, tokenFile, fetchImpl, requireScope: DRIVE_FILE_SCOPE, endpoint });
  }
  const rootName = (env.CLASSROOM_DRIVE_ROOT_NAME || GOOGLE_TEST_ROOT_NAME).trim();
  if (!production && (!rootName.startsWith("[測試] ") || rootName.length > 100)) throw new ClassroomDriveUnavailableError("The test folder's name starts with \"[測試] \"");
  const drive = createGoogleDrive({ accessToken, fetchImpl, apiBase: googleAddress(env.CLASSROOM_GOOGLE_API_BASE, "https://www.googleapis.com") });
  // The folder recordings go under: the parent folder named by configuration (P3-Multi, 第五部分 8),
  // or else the test folder, found or made once (and again after a failure).
  const parentId = driveParentFolderId(env);
  let root: Promise<string> | null = null;
  const rootId = () => {
    root ??= (parentId ? Promise.resolve(parentId) : drive.ensureFolder("root", rootName)).catch((error: unknown) => { root = null; throw error; });
    return root;
  };
  return {
    kind: "google",
    rootFolderId: GOOGLE_ROOT,
    quota: () => drive.quota(),
    ensureFolder: async (parentId, name) => drive.ensureFolder(parentId === GOOGLE_ROOT ? await rootId() : parentId, name),
    listNames: (folderId) => drive.listNames(folderId),
    findByAppProperty: (key, value) => drive.findByAppProperty(key, value),
    getFile: (id) => drive.getFile(id),
    startUpload: (meta) => drive.startUpload(meta),
    // The adapter's answers have these shapes (driveUploadState; a chunk either moves or throws).
    uploadStatus: (uri) => drive.uploadStatus(uri) as Promise<UploadStatus>,
    uploadChunk: (uri, chunk) => drive.uploadChunk(uri, chunk) as Promise<{ received: number; fileId: string | null }>,
    trash: (id) => drive.trash(id),
    remove: (id) => drive.remove(id),
    // The chosen folder is checked by its own id, before anything is made in it.
    permissions: async (id) => drive.permissions(id === GOOGLE_ROOT ? await rootId() : id),
  };
}

export function classroomDrive(): ClassroomDrive {
  const kind = process.env.CLASSROOM_DRIVE || "";
  if (kind === "local") {
    if (process.env.VERCEL_ENV === "production") throw new ClassroomDriveUnavailableError("The local Drive stand-in never runs in production");
    const directory = process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), "data");
    const quota = Number(process.env.CLASSROOM_DRIVE_LOCAL_QUOTA_BYTES || "");
    return createLocalDrive(path.join(directory, "synthetic-drive"), { quotaLimit: Number.isFinite(quota) && quota > 0 ? quota : null });
  }
  if (kind === "google") return googleClassroomDrive(process.env);
  throw new ClassroomDriveUnavailableError("No recording destination is configured");
}
