import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { ProcessedSiteMediaVariant } from "./site-media-image";
import type { SiteMediaSlot, SiteMediaVariant } from "./site-media-types";

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

export async function removeSiteMediaObjects(paths: string[]) {
  if (!paths.length) return;
  const { error } = await client().storage.from(bucket).remove(paths);
  if (error) throw new SiteMediaStorageError(error.message);
}

export async function uploadSiteMediaVariants(
  slot: SiteMediaSlot,
  processed: ProcessedSiteMediaVariant[],
): Promise<SiteMediaVariant[]> {
  const expectedWidths = [480, 800, 1200];
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
  const storage = client().storage.from(bucket);
  const versionId = randomUUID();
  const uploaded: string[] = [];
  const variants: SiteMediaVariant[] = [];

  try {
    for (const variant of processed) {
      const storagePath = `${slotPrefix(slot)}/${versionId}/${variant.width}.webp`;
      const { error } = await storage.upload(storagePath, variant.buffer, {
        contentType: variant.mimeType,
        cacheControl: "31536000",
        upsert: false,
      });
      if (error) throw new SiteMediaStorageError(error.message);
      uploaded.push(storagePath);
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
