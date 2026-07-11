import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ContentPages = Record<string, Record<string, string>>;

export type ContentStore = {
  version: number;
  updatedAt: string;
  updatedBy?: string;
  pages: ContentPages;
};

const contentPath = path.join(process.cwd(), "content.json");

function emptyStore(): ContentStore {
  return {
    version: 1,
    updatedAt: "",
    pages: {},
  };
}

function normalizeStore(value: unknown): ContentStore {
  const store = value && typeof value === "object" ? (value as Partial<ContentStore>) : {};
  const pages = store.pages && typeof store.pages === "object" ? store.pages : {};

  return {
    version: Number(store.version || 1),
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : "",
    updatedBy: typeof store.updatedBy === "string" ? store.updatedBy : undefined,
    pages,
  };
}

export async function readContentStore() {
  try {
    const raw = await readFile(contentPath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyStore();
    throw error;
  }
}

export async function writeContentStore(store: ContentStore) {
  await writeFile(contentPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function updateContentItem(params: {
  page: string;
  key: string;
  value: string;
  updatedBy: string;
}) {
  const store = await readContentStore();
  const pageContent = store.pages[params.page] ?? {};

  pageContent[params.key] = params.value;
  store.pages[params.page] = pageContent;
  store.updatedAt = new Date().toISOString();
  store.updatedBy = params.updatedBy;

  await writeContentStore(store);
  return store;
}
