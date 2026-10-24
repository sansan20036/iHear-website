import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Where finished recordings are filed. Week 1 has only a local folder standing in for Google
// Drive, with the behaviour the filing logic depends on: appProperties to find an upload
// again, resumable uploads that continue where they stopped, and a trash. The Google Drive
// adapter (drive.file scope, a folder the app creates) is added once a test account's
// authorization is approved.

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

export type ClassroomDrive = {
  rootFolderId: string;
  ensureFolder(parentId: string, name: string): Promise<string>;
  listNames(folderId: string): Promise<string[]>;
  findByAppProperty(key: string, value: string): Promise<DriveFile[]>;
  startUpload(meta: { name: string; parentId: string; size: number; appProperties: Record<string, string> }): Promise<string>;
  sessionAlive(uri: string): Promise<boolean>;
  upload(uri: string, bytes: Buffer): Promise<void>;
  finishUpload(uri: string): Promise<string>;
  trash(id: string): Promise<void>;
};

export class ClassroomDriveUnavailableError extends Error {}

type DriveIndex = {
  ids: number;
  folders: Record<string, string>;
  files: Record<string, DriveFile>;
  sessions: Record<string, { meta: { name: string; parentId: string; size: number; appProperties: Record<string, string> }; received: number; fileId: string | null }>;
};

export function createLocalDrive(directory: string): ClassroomDrive {
  const indexPath = path.join(directory, "index.json");
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
  return {
    rootFolderId: "root",
    ensureFolder: (parentId, name) => run((index) => {
      const key = `${parentId}/${name}`;
      index.folders[key] ??= `folder-${++index.ids}`;
      return index.folders[key];
    }),
    listNames: (folderId) => run((index) => Object.values(index.files).filter((file) => !file.trashed && file.parentId === folderId).map((file) => file.name), false),
    findByAppProperty: (key, value) => run((index) => Object.values(index.files).filter((file) => !file.trashed && file.appProperties[key] === value).map((file) => ({ ...file })), false),
    startUpload: (meta) => run((index) => {
      const uri = `local-upload://session-${++index.ids}`;
      index.sessions[uri] = { meta, received: 0, fileId: null };
      return uri;
    }),
    sessionAlive: (uri) => run((index) => Boolean(index.sessions[uri]), false),
    upload: (uri, bytes) => run(async (index) => {
      const session = index.sessions[uri];
      if (!session) throw new Error("upload session not found");
      await writeFile(path.join(directory, "files", encodeURIComponent(uri)), bytes);
      session.received = bytes.length;
    }),
    // Completing a finished session again returns the same file, as Drive does.
    finishUpload: (uri) => run((index) => {
      const session = index.sessions[uri];
      if (!session) throw new Error("upload session not found");
      if (!session.fileId) {
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
      }
      return session.fileId;
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
    return createLocalDrive(path.join(directory, "synthetic-drive"));
  }
  throw new ClassroomDriveUnavailableError(kind === "google"
    ? "The Google Drive adapter is added after a test account's authorization is approved"
    : "No recording destination is configured");
}
