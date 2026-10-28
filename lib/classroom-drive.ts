import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { FAILURE, FilingError } from "../tools/recording-pathway/classroom/recording-filing.mjs";

// Where finished recordings are filed. Until a test account's authorization is approved there
// is only a local folder standing in for Google Drive, with the behaviour the filing logic
// depends on: appProperties to find an upload again, resumable sessions that take a file in
// chunks and say how much they hold, a storage quota (CLASSROOM_DRIVE_LOCAL_QUOTA_BYTES, to
// try a full Drive locally) and a trash. The Google Drive adapter (drive.file scope, a folder
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
};

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
  throw new ClassroomDriveUnavailableError(kind === "google"
    ? "The Google Drive adapter is added after a test account's authorization is approved"
    : "No recording destination is configured");
}
