import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { ProcessedSiteMediaVariant, SiteMediaSlot, SiteMediaVariant } from "./site-media-types";

export class SiteMediaStorageConfigurationError extends Error {
  constructor() {
    super("Supabase Storage is not configured");
    this.name = "SiteMediaStorageConfigurationError";
  }
}

export class SiteMediaStorageError extends Error {
  constructor(message = "Could not store the image") {
    super(message);
    this.name = "SiteMediaStorageError";
  }
}

const supabaseUrl = process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const bucket = process.env.SUPABASE_STORAGE_BUCKET || "site-media";
const useLocalStorage = process.env.IHEAR_FORCE_FILE_STORE === "1";
const localPublicRoot = path.join(process.cwd(), "public");
const localStorageRoot = path.join(localPublicRoot, "uploads", "site-media");
const globalForSiteMediaStorage = globalThis as typeof globalThis & {
  ihearSiteMediaSupabase?: SupabaseClient;
};

function client() {
  if (!supabaseUrl || !serviceRoleKey) throw new SiteMediaStorageConfigurationError();
  if (!globalForSiteMediaStorage.ihearSiteMediaSupabase) {
    globalForSiteMediaStorage.ihearSiteMediaSupabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return globalForSiteMediaStorage.ihearSiteMediaSupabase;
}

function slotPrefix(slot: SiteMediaSlot) {
  return slot.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

function exactArrayBuffer(buffer: Buffer) {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes.buffer;
}

async function verifyStoredSiteMediaObject(storagePath: string, expected: Buffer) {
  const stored = await readSiteMediaObject(storagePath);
  if (stored.byteLength !== expected.byteLength || !stored.equals(expected)) {
    throw new SiteMediaStorageError("The stored image bytes did not match the generated image");
  }
}

export function expectedSiteMediaWidths(slot: SiteMediaSlot) {
  return slot.startsWith("team.") && slot.endsWith(".avatar")
    ? [480, 800]
    : [480, 800, 1200];
}

export async function removeSiteMediaObjects(paths: string[]) {
  if (!paths.length) return;
  if (useLocalStorage) {
    await Promise.all(paths.map(async (storagePath) => {
      if (!storagePath.startsWith("local:")) return;
      const resolved = path.resolve(localPublicRoot, storagePath.slice("local:".length));
      if (!resolved.startsWith(`${localStorageRoot}${path.sep}`)) {
        throw new SiteMediaStorageError("The local image path is invalid");
      }
      await unlink(resolved).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }));
    return;
  }
  const { error } = await client().storage.from(bucket).remove(paths);
  if (error) throw new SiteMediaStorageError(error.message);
}

export async function readSiteMediaObject(storagePath: string) {
  if (useLocalStorage) {
    if (!storagePath.startsWith("local:")) throw new SiteMediaStorageError("The local image path is invalid");
    const resolved = path.resolve(localPublicRoot, storagePath.slice("local:".length));
    if (!resolved.startsWith(`${localStorageRoot}${path.sep}`)) {
      throw new SiteMediaStorageError("The local image path is invalid");
    }
    try {
      return await readFile(resolved);
    } catch (error) {
      throw new SiteMediaStorageError((error as Error)?.message);
    }
  }
  const { data, error } = await client().storage.from(bucket).download(storagePath);
  if (error || !data) throw new SiteMediaStorageError(error?.message || "Could not read the image");
  return Buffer.from(await data.arrayBuffer());
}

async function uploadLocalSiteMediaVariants(
  slot: SiteMediaSlot,
  versionId: string,
  processed: ProcessedSiteMediaVariant[],
): Promise<SiteMediaVariant[]> {
  const prefix = slotPrefix(slot);
  const directory = path.join(localStorageRoot, prefix, versionId);
  const uploaded: string[] = [];
  await mkdir(directory, { recursive: true });
  try {
    const variants: SiteMediaVariant[] = [];
    for (const variant of processed) {
      const relativePath = `uploads/site-media/${prefix}/${versionId}/${variant.width}.webp`;
      const filePath = path.join(localPublicRoot, ...relativePath.split("/"));
      await writeFile(filePath, variant.buffer, { flag: "wx" });
      uploaded.push(filePath);
      variants.push({
        width: variant.width,
        pixelWidth: variant.pixelWidth,
        pixelHeight: variant.pixelHeight,
        byteSize: variant.byteSize,
        mimeType: variant.mimeType,
        url: `/${relativePath}`,
        storagePath: `local:${relativePath}`,
      });
    }
    return variants;
  } catch (error) {
    await Promise.all(uploaded.map((filePath) => unlink(filePath).catch(() => undefined)));
    throw new SiteMediaStorageError((error as Error)?.message);
  }
}

export async function uploadSiteMediaVariants(
  slot: SiteMediaSlot,
  processed: ProcessedSiteMediaVariant[],
): Promise<SiteMediaVariant[]> {
  const expectedWidths = expectedSiteMediaWidths(slot);
  const actualWidths = processed.map((variant) => variant.width).sort((left, right) => left - right);
  if (
    actualWidths.length !== expectedWidths.length
    || actualWidths.some((width, index) => width !== expectedWidths[index])
    || processed.some((variant) => (
      variant.mimeType !== "image/webp"
      || variant.byteSize < 1
      || variant.byteSize > 1024 * 1024
      || variant.pixelWidth < 1
      || variant.pixelHeight < 1
    ))
  ) {
    throw new SiteMediaStorageError("The responsive image set is invalid");
  }
  const versionId = randomUUID();
  if (useLocalStorage) {
    return uploadLocalSiteMediaVariants(slot, versionId, processed);
  }
  const storage = client().storage.from(bucket);
  const uploaded: string[] = [];
  const variants: SiteMediaVariant[] = [];

  try {
    for (const variant of processed) {
      const storagePath = `${slotPrefix(slot)}/${versionId}/${variant.width}.webp`;
      // Pass an exact ArrayBuffer instead of a Node Buffer. Some serverless fetch
      // adapters can coerce Buffer bodies to UTF-8 text, replacing binary bytes
      // with EF BF BD and leaving a 200 response that browsers cannot decode.
      const { error } = await storage.upload(storagePath, exactArrayBuffer(variant.buffer), {
        contentType: variant.mimeType,
        cacheControl: "31536000",
        upsert: false,
      });
      if (error) throw new SiteMediaStorageError(error.message);
      uploaded.push(storagePath);
      await verifyStoredSiteMediaObject(storagePath, variant.buffer);
      const { data } = storage.getPublicUrl(storagePath);
      variants.push({
        width: variant.width,
        pixelWidth: variant.pixelWidth,
        pixelHeight: variant.pixelHeight,
        byteSize: variant.byteSize,
        mimeType: variant.mimeType,
        url: data.publicUrl,
        storagePath,
      });
    }
    return variants;
  } catch (error) {
    if (uploaded.length) {
      await storage.remove(uploaded).catch(() => undefined);
    }
    throw error;
  }
}
