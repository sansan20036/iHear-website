import { mkdir, readFile, rename, unlink, writeFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { GALLERY_IDS, GALLERY_LIMIT, initialGallery, type Gallery, type GalleryAsset, type GalleryId, type GalleryItem } from './media-gallery-types';
import { upsertTranslationStatesInTransaction } from './translation-state';

export class GalleryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Operation = { galleryId: GalleryId; actor: string; fingerprint: string };
type Store = { galleries: Partial<Record<GalleryId, Gallery>>; assets: Record<string, GalleryAsset>; operations: Record<string, Operation> };
const filePath = path.join(process.env.IHEAR_FORCE_FILE_STORE === '1' && process.env.IHEAR_TEST_DATA_DIR || path.join(process.cwd(), 'data'), 'media-galleries.json');
const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === '1' ? '' : process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
const globalStore = globalThis as typeof globalThis & { ihearGallerySql?: ReturnType<typeof postgres>; ihearGallerySchema?: Promise<void> };
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
    globalStore.ihearGallerySchema ||= (async () => {
      // Local PostgreSQL uses the same tracked schema; deployment runs migrations separately.
      const ddl = await readFile(path.join(process.cwd(), 'db/migrations/019_media_galleries.sql'), 'utf8');
      const exists = await sql`SELECT to_regclass('public.media_galleries') AS name`;
      if (!exists[0].name) await sql.begin(async tx => { await tx.unsafe(ddl); });
    })();
    await globalStore.ihearGallerySchema;
  }
  return sql;
}
async function readStore(): Promise<Store> {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { galleries: {}, assets: {}, operations: {} }; throw error; }
}
async function mutateFile<T>(fn: (store: Store) => T): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lock = `${filePath}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new GalleryError('Gallery is busy; retry shortly', 503);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
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
    return result;
  } finally {
    await unlink(temporary).catch(() => undefined);
    await rmdir(lock);
  }
}
function fromRow(row: any): Gallery {
  return { id: row.id, version: Number(row.version), items: row.items, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by };
}
export async function listGalleries(): Promise<Gallery[]> {
  const sql = await ready();
  if (!sql) { const store = await readStore(); return GALLERY_IDS.map(id => store.galleries[id] || initialGallery(id)); }
  const rows = await sql`SELECT * FROM public.media_galleries ORDER BY id`;
  return rows.map(fromRow);
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
    if (index < 0) items.push(input.item); else items[index] = input.item;
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
    const current = store.galleries[input.id] || initialGallery(input.id);
    const operation = store.operations[input.operationId];
    if (operation) { checkReplay(operation); return { gallery: current, replayed: true }; }
    const gallery = apply(current, input);
    if (input.asset) store.assets[input.asset.asset.slot] = input.asset;
    store.galleries[input.id] = gallery;
    store.operations[input.operationId] = { galleryId: input.id, actor: input.actor, fingerprint: input.fingerprint };
    return { gallery, replayed: false };
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
      return { gallery: current, replayed: true };
    }
    const gallery = apply(current, input);
    if (input.asset) {
      await tx`INSERT INTO public.media_gallery_assets(slot,payload) VALUES (${input.asset.asset.slot},${tx.json(input.asset as any)})`;
      await upsertTranslationStatesInTransaction(tx, { type: 'media', scope: '', id: input.asset.asset.slot }, input.asset.states, input.actor);
    }
    await tx`UPDATE public.media_galleries SET items=${tx.json(gallery.items as any)}, version=${gallery.version}, updated_by=${input.actor}, updated_at=NOW() WHERE id=${input.id}`;
    await tx`INSERT INTO public.media_gallery_operations(id,gallery_id,actor,fingerprint) VALUES (${input.operationId},${input.id},${input.actor},${input.fingerprint})`;
    return { gallery, replayed: false };
  });
}
