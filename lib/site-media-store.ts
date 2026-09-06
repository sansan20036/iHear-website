import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import type { SiteMediaAlt, SiteMediaAsset, SiteMediaSlot, SiteMediaVariant } from "./site-media-types";
import { saveTranslationStates, upsertTranslationStatesInTransaction } from "./translation-state";
import type { TranslationStateWrite } from "./translation-types";

export class SiteMediaConfigurationError extends Error {
  constructor() {
    super("Site media persistence is not configured");
    this.name = "SiteMediaConfigurationError";
  }
}

export class SiteMediaConflictError extends Error {
  constructor() {
    super("This image was changed by another administrator");
    this.name = "SiteMediaConflictError";
  }
}

type AssetRow = {
  slot: SiteMediaSlot;
  alt_en: string;
  alt_zh_hant: string;
  alt_zh_hans: string;
  focal_x: number;
  focal_y: number;
  zoom: number;
  record_version: number;
  updated_at: Date | string;
  updated_by: string;
};

type VariantRow = {
  slot: SiteMediaSlot;
  width: number;
  pixel_width: number;
  pixel_height: number;
  byte_size: number;
  mime_type: "image/webp";
  public_url: string;
  storage_path: string;
};

type SiteMediaFileStore = { assets: SiteMediaAsset[] };

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1"
  ? ""
  : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const isHostedProduction = process.env.NODE_ENV === "production" && Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);
const shouldBootstrapSchema = !isHostedProduction || process.env.IHEAR_AUTO_BOOTSTRAP_DB === "1";
const filePath = path.join(process.cwd(), "data", "site-media.json");
const globalForSiteMedia = globalThis as typeof globalThis & {
  ihearSiteMediaSql?: ReturnType<typeof postgres>;
  ihearSiteMediaSchemaReady?: Promise<void>;
};
let fileQueue: Promise<unknown> = Promise.resolve();

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForSiteMedia.ihearSiteMediaSql) {
    globalForSiteMedia.ihearSiteMediaSql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
    });
  }
  return globalForSiteMedia.ihearSiteMediaSql;
}

function assertPersistence() {
  if (!databaseUrl && isHostedProduction) throw new SiteMediaConfigurationError();
}

async function ensureSchema() {
  const sql = sqlClient();
  if (!sql) return;
  // Hosted environments are migrated before deployment. Re-running DDL on every
  // cold start adds several database round trips to image uploads and can push a
  // request past the serverless timeout.
  if (!shouldBootstrapSchema) return;
  if (!globalForSiteMedia.ihearSiteMediaSchemaReady) {
    globalForSiteMedia.ihearSiteMediaSchemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS public.site_media_assets (
          slot TEXT PRIMARY KEY,
          alt_en TEXT NOT NULL,
          alt_zh_hant TEXT NOT NULL,
          alt_zh_hans TEXT NOT NULL,
          focal_x SMALLINT NOT NULL,
          focal_y SMALLINT NOT NULL,
          zoom SMALLINT NOT NULL DEFAULT 100,
          record_version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          CONSTRAINT site_media_assets_slot_length CHECK (char_length(slot) BETWEEN 1 AND 100),
          CONSTRAINT site_media_assets_alt_length CHECK (
            char_length(alt_en) BETWEEN 2 AND 300
            AND char_length(alt_zh_hant) BETWEEN 2 AND 300
            AND char_length(alt_zh_hans) BETWEEN 2 AND 300
          ),
          CONSTRAINT site_media_assets_focal_range CHECK (
            focal_x BETWEEN 0 AND 100 AND focal_y BETWEEN 0 AND 100
          ),
          CONSTRAINT site_media_assets_zoom_range CHECK (zoom BETWEEN 100 AND 250),
          CONSTRAINT site_media_assets_version_positive CHECK (record_version >= 1),
          CONSTRAINT site_media_assets_actor_length CHECK (
            char_length(created_by) BETWEEN 1 AND 320
            AND char_length(updated_by) BETWEEN 1 AND 320
          ),
          CONSTRAINT site_media_assets_timestamp_order CHECK (updated_at >= created_at)
        )
      `;
      await sql`ALTER TABLE public.site_media_assets ADD COLUMN IF NOT EXISTS zoom SMALLINT NOT NULL DEFAULT 100`;
      await sql`ALTER TABLE public.site_media_assets DROP CONSTRAINT IF EXISTS site_media_assets_focal_grid`;
      await sql`ALTER TABLE public.site_media_assets DROP CONSTRAINT IF EXISTS site_media_assets_focal_range`;
      await sql`ALTER TABLE public.site_media_assets ADD CONSTRAINT site_media_assets_focal_range CHECK (focal_x BETWEEN 0 AND 100 AND focal_y BETWEEN 0 AND 100)`;
      await sql`ALTER TABLE public.site_media_assets DROP CONSTRAINT IF EXISTS site_media_assets_zoom_range`;
      await sql`ALTER TABLE public.site_media_assets ADD CONSTRAINT site_media_assets_zoom_range CHECK (zoom BETWEEN 100 AND 250)`;
      await sql`
        CREATE TABLE IF NOT EXISTS public.site_media_variants (
          slot TEXT NOT NULL,
          width INTEGER NOT NULL,
          pixel_width INTEGER NOT NULL,
          pixel_height INTEGER NOT NULL,
          byte_size INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          public_url TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          CONSTRAINT site_media_variants_pkey PRIMARY KEY (slot, width),
          CONSTRAINT site_media_variants_slot_fkey FOREIGN KEY (slot)
            REFERENCES public.site_media_assets(slot) ON DELETE CASCADE,
          CONSTRAINT site_media_variants_width_allowed CHECK (width IN (480, 800, 1200)),
          CONSTRAINT site_media_variants_dimensions_positive CHECK (
            pixel_width > 0 AND pixel_height > 0
          ),
          CONSTRAINT site_media_variants_byte_size_range CHECK (byte_size BETWEEN 1 AND 1048576),
          CONSTRAINT site_media_variants_mime_webp CHECK (mime_type = 'image/webp'),
          CONSTRAINT site_media_variants_public_url_https CHECK (public_url LIKE 'https://%'),
          CONSTRAINT site_media_variants_storage_path_length CHECK (
            char_length(storage_path) BETWEEN 1 AND 500
          ),
          CONSTRAINT site_media_variants_storage_path_unique UNIQUE (storage_path)
        )
      `;
      await sql`ALTER TABLE public.site_media_assets ENABLE ROW LEVEL SECURITY`;
      await sql`ALTER TABLE public.site_media_variants ENABLE ROW LEVEL SECURITY`;
    })();
  }
  await globalForSiteMedia.ihearSiteMediaSchemaReady;
}

function fromRows(assetRows: AssetRow[], variantRows: VariantRow[]) {
  return assetRows.map((row) => ({
    slot: row.slot,
    alt: { en: row.alt_en, zhHant: row.alt_zh_hant, zhHans: row.alt_zh_hans },
    focalX: Number(row.focal_x),
    focalY: Number(row.focal_y),
    zoom: Number(row.zoom || 100),
    recordVersion: Number(row.record_version),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
    variants: variantRows
      .filter((variant) => variant.slot === row.slot)
      .map((variant) => ({
        width: Number(variant.width),
        pixelWidth: Number(variant.pixel_width),
        pixelHeight: Number(variant.pixel_height),
        byteSize: Number(variant.byte_size),
        mimeType: variant.mime_type,
        url: variant.public_url,
        storagePath: variant.storage_path,
      }))
      .sort((left, right) => left.width - right.width),
  } satisfies SiteMediaAsset));
}

async function readFileStore(): Promise<SiteMediaFileStore> {
  try {
    const store = JSON.parse(await readFile(filePath, "utf8")) as SiteMediaFileStore;
    store.assets = (store.assets || []).map((asset) => ({ ...asset, zoom: Number(asset.zoom || 100) }));
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { assets: [] };
    throw error;
  }
}

async function mutateFile<T>(callback: (store: SiteMediaFileStore) => T | Promise<T>) {
  const operation = fileQueue.then(async () => {
    const store = await readFileStore();
    const result = await callback(store);
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    return result;
  });
  fileQueue = operation.catch(() => undefined);
  return operation as Promise<T>;
}

export async function listSiteMediaAssets(): Promise<SiteMediaAsset[]> {
  assertPersistence();
  const sql = sqlClient();
  if (!sql) return (await readFileStore()).assets;
  await ensureSchema();
  const [assets, variants] = await Promise.all([
    sql<AssetRow[]>`SELECT * FROM public.site_media_assets ORDER BY slot`,
    sql<VariantRow[]>`SELECT * FROM public.site_media_variants ORDER BY slot, width`,
  ]);
  return fromRows(assets, variants);
}

export async function replaceSiteMediaAsset(params: {
  slot: SiteMediaSlot;
  alt: SiteMediaAlt;
  focalX: number;
  focalY: number;
  zoom: number;
  expectedVersion: number;
  updatedBy: string;
  variants: SiteMediaVariant[];
  translationStates?: TranslationStateWrite[];
}) {
  assertPersistence();
  const sql = sqlClient();
  if (!sql) {
    const result = await mutateFile((store) => {
      const existingIndex = store.assets.findIndex((asset) => asset.slot === params.slot);
      const existing = store.assets[existingIndex];
      if ((existing?.recordVersion || 0) !== params.expectedVersion) throw new SiteMediaConflictError();
      const now = new Date().toISOString();
      const asset: SiteMediaAsset = {
        slot: params.slot,
        alt: params.alt,
        focalX: params.focalX,
        focalY: params.focalY,
        zoom: params.zoom,
        recordVersion: params.expectedVersion + 1,
        updatedAt: now,
        updatedBy: params.updatedBy,
        variants: params.variants,
      };
      if (existingIndex >= 0) store.assets[existingIndex] = asset;
      else store.assets.push(asset);
      return { asset, previousStoragePaths: existing?.variants.map((variant) => variant.storagePath) || [] };
    });
    await saveTranslationStates({ type: "media", scope: "", id: params.slot }, params.translationStates || [], params.updatedBy);
    return result;
  }

  await ensureSchema();
  try {
    return await sql.begin(async (tx) => {
      const [existing] = await tx<AssetRow[]>`
        SELECT * FROM public.site_media_assets WHERE slot = ${params.slot} FOR UPDATE
      `;
      if (Number(existing?.record_version || 0) !== params.expectedVersion) throw new SiteMediaConflictError();
      const previousVariants = existing
        ? await tx<VariantRow[]>`SELECT * FROM public.site_media_variants WHERE slot = ${params.slot}`
        : [];

      if (existing) {
        await tx`
          UPDATE public.site_media_assets SET
            alt_en = ${params.alt.en}, alt_zh_hant = ${params.alt.zhHant}, alt_zh_hans = ${params.alt.zhHans},
            focal_x = ${params.focalX}, focal_y = ${params.focalY}, zoom = ${params.zoom},
            record_version = record_version + 1, updated_at = NOW(), updated_by = ${params.updatedBy}
          WHERE slot = ${params.slot}
        `;
        await tx`DELETE FROM public.site_media_variants WHERE slot = ${params.slot}`;
      } else {
        await tx`
          INSERT INTO public.site_media_assets (
            slot, alt_en, alt_zh_hant, alt_zh_hans, focal_x, focal_y, zoom, created_by, updated_by
          ) VALUES (
            ${params.slot}, ${params.alt.en}, ${params.alt.zhHant}, ${params.alt.zhHans},
            ${params.focalX}, ${params.focalY}, ${params.zoom}, ${params.updatedBy}, ${params.updatedBy}
          )
        `;
      }

      for (const variant of params.variants) {
        await tx`
          INSERT INTO public.site_media_variants (
            slot, width, pixel_width, pixel_height, byte_size, mime_type, public_url, storage_path
          ) VALUES (
            ${params.slot}, ${variant.width}, ${variant.pixelWidth}, ${variant.pixelHeight},
            ${variant.byteSize}, ${variant.mimeType}, ${variant.url}, ${variant.storagePath}
          )
        `;
      }
      await upsertTranslationStatesInTransaction(tx, { type: "media", scope: "", id: params.slot }, params.translationStates || [], params.updatedBy);
      const [assetRows, variantRows] = await Promise.all([
        tx<AssetRow[]>`SELECT * FROM public.site_media_assets WHERE slot = ${params.slot}`,
        tx<VariantRow[]>`SELECT * FROM public.site_media_variants WHERE slot = ${params.slot} ORDER BY width`,
      ]);
      return {
        asset: fromRows(assetRows, variantRows)[0],
        previousStoragePaths: previousVariants.map((variant) => variant.storage_path),
      };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new SiteMediaConflictError();
    throw error;
  }
}

export async function updateSiteMediaAssetMetadata(params: {
  slot: SiteMediaSlot;
  alt: SiteMediaAlt;
  focalX: number;
  focalY: number;
  zoom: number;
  expectedVersion: number;
  updatedBy: string;
  translationStates?: TranslationStateWrite[];
}) {
  assertPersistence();
  const sql = sqlClient();
  if (!sql) {
    const result = await mutateFile((store) => {
      const index = store.assets.findIndex((asset) => asset.slot === params.slot);
      const existing = store.assets[index];
      if (!existing || existing.recordVersion !== params.expectedVersion) throw new SiteMediaConflictError();
      const asset: SiteMediaAsset = {
        ...existing,
        alt: params.alt,
        focalX: params.focalX,
        focalY: params.focalY,
        zoom: params.zoom,
        recordVersion: existing.recordVersion + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: params.updatedBy,
      };
      store.assets[index] = asset;
      return asset;
    });
    await saveTranslationStates({ type: "media", scope: "", id: params.slot }, params.translationStates || [], params.updatedBy);
    return result;
  }

  await ensureSchema();
  return sql.begin(async (tx) => {
    const [existing] = await tx<AssetRow[]>`
      SELECT * FROM public.site_media_assets WHERE slot = ${params.slot} FOR UPDATE
    `;
    if (!existing || Number(existing.record_version) !== params.expectedVersion) throw new SiteMediaConflictError();
    await tx`
      UPDATE public.site_media_assets SET
        alt_en = ${params.alt.en}, alt_zh_hant = ${params.alt.zhHant}, alt_zh_hans = ${params.alt.zhHans},
        focal_x = ${params.focalX}, focal_y = ${params.focalY}, zoom = ${params.zoom},
        record_version = record_version + 1, updated_at = NOW(), updated_by = ${params.updatedBy}
      WHERE slot = ${params.slot}
    `;
    await upsertTranslationStatesInTransaction(tx, { type: "media", scope: "", id: params.slot }, params.translationStates || [], params.updatedBy);
    const [assetRows, variantRows] = await Promise.all([
      tx<AssetRow[]>`SELECT * FROM public.site_media_assets WHERE slot = ${params.slot}`,
      tx<VariantRow[]>`SELECT * FROM public.site_media_variants WHERE slot = ${params.slot} ORDER BY width`,
    ]);
    return fromRows(assetRows, variantRows)[0];
  });
}

export async function deleteSiteMediaAsset(slot: SiteMediaSlot, expectedVersion: number) {
  assertPersistence();
  const sql = sqlClient();
  if (!sql) {
    return mutateFile((store) => {
      const index = store.assets.findIndex((asset) => asset.slot === slot);
      const existing = store.assets[index];
      if (!existing || existing.recordVersion !== expectedVersion) throw new SiteMediaConflictError();
      store.assets.splice(index, 1);
      return existing.variants.map((variant) => variant.storagePath);
    });
  }
  await ensureSchema();
  return sql.begin(async (tx) => {
    const [existing] = await tx<AssetRow[]>`
      SELECT * FROM public.site_media_assets WHERE slot = ${slot} FOR UPDATE
    `;
    if (!existing || Number(existing.record_version) !== expectedVersion) throw new SiteMediaConflictError();
    const variants = await tx<VariantRow[]>`SELECT * FROM public.site_media_variants WHERE slot = ${slot}`;
    await tx`DELETE FROM public.site_media_assets WHERE slot = ${slot}`;
    return variants.map((variant) => variant.storage_path);
  });
}
