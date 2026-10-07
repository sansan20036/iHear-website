import { mkdir, readFile, rename, unlink, writeFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { GALLERY_IDS, GALLERY_LIMIT, initialGallery, normalizeGallery, type Gallery, type GalleryAsset, type GalleryId, type GalleryItem } from './media-gallery-types';
import { upsertTranslationStatesInTransaction } from './translation-state';

export class GalleryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
// A definite rejection, unlike a database timeout with an unknown commit outcome.
export class GalleryNotCommittedError extends GalleryError {
  constructor(readonly cause: unknown) {
    super('Gallery could not be saved. Please retry.', 503);
    this.name = 'GalleryNotCommittedError';
  }
}
type Operation = { galleryId: GalleryId; actor: string; fingerprint: string };
type Store = { galleries: Partial<Record<GalleryId, Gallery>>; assets: Record<string, GalleryAsset>; operations: Record<string, Operation> };
const filePath = path.join(process.env.IHEAR_FORCE_FILE_STORE === '1' && process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), 'data'), 'media-galleries.json');
const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === '1' ? '' : process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
const globalStore = globalThis as typeof globalThis & { ihearGallerySql?: ReturnType<typeof postgres>; ihearGallerySchemaV2?: Promise<void> };
function client() {
  if (!databaseUrl) {
    if (process.env.NODE_ENV === 'production' && process.env.VERCEL) throw new GalleryError('Gallery storage is not configured', 503);
    return null;
  }
  return globalStore.ihearGallerySql ||= postgres(databaseUrl, { max: 2, prepare: false, ssl: process.env.POSTGRES_SSL === 'disable' ? false : 'require' });
}
async function ready() {
  const sql = client();
  if (sql && !(process.env.NODE_ENV === 'production' && process.env.VERCEL)) {
    globalStore.ihearGallerySchemaV2 ||= (async () => {
      // Local PostgreSQL uses the same tracked schema; deployment runs migrations separately.
      const [ddl, upgrade] = await Promise.all([
        readFile(path.join(process.cwd(), 'db/migrations/019_media_galleries.sql'), 'utf8'),
        readFile(path.join(process.cwd(), 'db/migrations/024_home_banner_gallery.sql'), 'utf8'),
      ]);
      await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('ihear-media-gallery-schema'))`;
        const exists = await tx`SELECT to_regclass('public.media_galleries') AS name`;
        if (!exists[0].name) await tx.unsafe(ddl);
        const constraints = await tx`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid='public.media_galleries'::regclass AND conname='media_galleries_id_check' AND contype='c'`;
        // Migration 024 changes the check and seeds in one transaction. Once its
        // check exists, an intentionally empty gallery must stay empty on restart.
        if (!constraints[0]?.definition.includes("'home-banner'")) await tx.unsafe(upgrade);
      });
    })().catch(error => { globalStore.ihearGallerySchemaV2 = undefined; throw error; });
    await globalStore.ihearGallerySchemaV2;
  }
  return sql;
}
async function readStore(): Promise<Store> {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { galleries: {}, assets: {}, operations: {} }; throw error; }
}
async function mutateFile<T>(fn: (store: Store) => T): Promise<T> {
  const lock = `${filePath}.lock`;
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new GalleryError('Gallery is busy; retry shortly', 503);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    try {
      const store = await readStore();
      const result = fn(store);
      await writeFile(temporary, JSON.stringify(store), 'utf8');
      // Windows readers, antivirus and OneDrive may briefly hold the destination.
      // Retry the atomic rename while retaining our writer lock; never truncate it.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, filePath); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code || '') || attempt >= 10) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(250, 30 * (attempt + 1))));
        }
      }
      committed = true;
      return result;
    } finally {
      await unlink(temporary).catch(() => undefined);
      await rmdir(lock);
    }
  } catch (error) {
    // Cleanup can fail after rename succeeded. Do not mark that saved operation
    // as rejected: the route must retain its photos and allow status-based replay.
    if (committed || error instanceof GalleryError) throw error;
    throw new GalleryNotCommittedError(error);
  }
}
function fromRow(row: any): Gallery {
  return { id: row.id, version: Number(row.version), items: row.items, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by };
}
function initializeHomeBanner(store: Store) {
  // Absence means a pre-CP1 file. A persisted empty gallery is administrator data.
  if (!Object.prototype.hasOwnProperty.call(store.galleries, 'home-banner')) store.galleries['home-banner'] = initialGallery('home-banner');
}
export async function listGalleries(): Promise<Gallery[]> {
  const sql = await ready();
  if (!sql) {
    let store = await readStore();
    if (!Object.prototype.hasOwnProperty.call(store.galleries, 'home-banner')) {
      // Re-read under the writer lock so concurrent initialization cannot restore
      // a seed over a gallery that another administrator has already cleared.
      store = await mutateFile(current => { initializeHomeBanner(current); return current; });
    }
    return GALLERY_IDS.map(id => normalizeGallery(store.galleries[id] || initialGallery(id)));
  }
  const rows = await sql`SELECT * FROM public.media_galleries ORDER BY id`;
  return rows.map(row => normalizeGallery(fromRow(row)));
}
export async function getGalleryAsset(slot: string): Promise<GalleryAsset | null> {
  const sql = await ready();
  if (!sql) return (await readStore()).assets[slot] || null;
  const rows = await sql`SELECT payload FROM public.media_gallery_assets WHERE slot=${slot}`;
  return rows[0]?.payload as GalleryAsset || null;
}
export async function getGalleryAssets(slots: string[]): Promise<GalleryAsset[]> {
  if (!slots.length) return [];
  const sql = await ready();
  if (!sql) { const store = await readStore(); return slots.map(slot => store.assets[slot]).filter(Boolean); }
  const rows = await sql`SELECT payload FROM public.media_gallery_assets WHERE slot IN ${sql(slots)}`;
  return rows.map(row => row.payload as GalleryAsset);
}
export async function operationStatus(id: string, galleryId: GalleryId, actor: string): Promise<Operation | null> {
  const sql = await ready();
  let operation: Operation | undefined;
  if (!sql) operation = (await readStore()).operations[id];
  else {
    const rows = await sql`SELECT * FROM public.media_gallery_operations WHERE id=${id}`;
    if (rows[0]) operation = { galleryId: rows[0].gallery_id, actor: rows[0].actor, fingerprint: rows[0].fingerprint };
  }
  if (operation && (operation.galleryId !== galleryId || operation.actor !== actor)) throw new GalleryError('Operation belongs to another request', 409);
  return operation || null;
}
type Mutation = {
  id: GalleryId; operationId: string; actor: string; fingerprint: string; expectedVersion: number;
  action: 'put' | 'remove' | 'move'; item?: GalleryItem; itemId?: string; direction?: -1 | 1; asset?: GalleryAsset;
};
function apply(gallery: Gallery, input: Mutation): Gallery {
  if (gallery.version !== input.expectedVersion) throw new GalleryError('This gallery was changed by another administrator', 409);
  const items = gallery.items.slice();
  const index = items.findIndex(item => item.id === (input.item?.id || input.itemId));
  if (input.action === 'put') {
    if (!input.item) throw new GalleryError('Missing media item');
    // Older clients omit title entirely. Preserve an existing title unless the
    // caller explicitly supplied a replacement or null to clear it.
    const item = input.item.title === undefined && index >= 0 && items[index].title !== undefined
      ? { ...input.item, title: items[index].title } : input.item;
    if (index < 0) items.push(item); else items[index] = item;
  } else {
    if (index < 0) throw new GalleryError('Media item no longer exists', 409);
    if (input.action === 'remove') items.splice(index, 1);
    else {
      const target = index + (input.direction || 0);
      if (target < 0 || target >= items.length) throw new GalleryError('Invalid position');
      [items[index], items[target]] = [items[target], items[index]];
    }
  }
  if (items.length > GALLERY_LIMIT) throw new GalleryError('Each gallery can contain at most 20 items');
  return { ...gallery, items, version: gallery.version + 1, updatedBy: input.actor, updatedAt: new Date().toISOString() };
}
export async function mutateGallery(input: Mutation): Promise<{ gallery: Gallery; replayed: boolean }> {
  const checkReplay = (operation: Operation) => {
    if (operation.galleryId !== input.id || operation.actor !== input.actor || operation.fingerprint !== input.fingerprint) throw new GalleryError('Operation ID was already used for a different request', 409);
  };
  const sql = await ready();
  if (!sql) return mutateFile(store => {
    initializeHomeBanner(store);
    const current = store.galleries[input.id] || initialGallery(input.id);
    const operation = store.operations[input.operationId];
    if (operation) { checkReplay(operation); return { gallery: normalizeGallery(current), replayed: true }; }
    const gallery = apply(current, input);
    if (input.asset) store.assets[input.asset.asset.slot] = input.asset;
    store.galleries[input.id] = gallery;
    store.operations[input.operationId] = { galleryId: input.id, actor: input.actor, fingerprint: input.fingerprint };
    return { gallery: normalizeGallery(gallery), replayed: false };
  });
  return sql.begin(async tx => {
    // Serializes duplicate retries even if they target different galleries.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${input.operationId}))`;
    const rows = await tx`SELECT * FROM public.media_galleries WHERE id=${input.id} FOR UPDATE`;
    if (!rows[0]) throw new GalleryError('Unknown gallery', 404);
    const current = fromRow(rows[0]);
    const operations = await tx`SELECT * FROM public.media_gallery_operations WHERE id=${input.operationId}`;
    if (operations[0]) {
      checkReplay({ galleryId: operations[0].gallery_id, actor: operations[0].actor, fingerprint: operations[0].fingerprint });
      return { gallery: normalizeGallery(current), replayed: true };
    }
    const gallery = apply(current, input);
    if (input.asset) {
      await tx`INSERT INTO public.media_gallery_assets(slot,payload) VALUES (${input.asset.asset.slot},${tx.json(input.asset as any)})`;
      await upsertTranslationStatesInTransaction(tx, { type: 'media', scope: '', id: input.asset.asset.slot }, input.asset.states, input.actor);
    }
    await tx`UPDATE public.media_galleries SET items=${tx.json(gallery.items as any)}, version=${gallery.version}, updated_by=${input.actor}, updated_at=NOW() WHERE id=${input.id}`;
    await tx`INSERT INTO public.media_gallery_operations(id,gallery_id,actor,fingerprint) VALUES (${input.operationId},${input.id},${input.actor},${input.fingerprint})`;
    return { gallery: normalizeGallery(gallery), replayed: false };
  });
}
