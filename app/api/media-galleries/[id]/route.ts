import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authorizeAdminRequest, isSameOrigin } from '../../../../lib/admin-auth';
import { GalleryError, getGalleryAsset, listGalleries, mutateGallery, operationStatus } from '../../../../lib/media-gallery-store';
import { emptyCaption, galleryAssetSlot, isGalleryId, isOperationId, type GalleryAsset, type GalleryItem } from '../../../../lib/media-gallery-types';
import { publicGalleries } from '../../../../lib/media-gallery-public';
import { youtubeVideoId } from '../../../../assets/youtube';
import { processSiteMediaImage, MULTIPART_MAX_BYTES, SiteMediaImageError } from '../../../../lib/site-media-image';
import { removeSiteMediaObjects, uploadSiteMediaVariants } from '../../../../lib/site-media-storage';
import { enforceRateLimit, RATE_LIMIT_POLICIES } from '../../../../lib/rate-limit';
import { manualTranslationWrites, manualTranslationUpdateWrites, verifyTranslationReceipt, TranslationReceiptError } from '../../../../lib/translation-core';
import { readTranslationStates } from '../../../../lib/translation-state';
import { NO_STORE_HEADERS } from '../../../../lib/response-headers';
import type { SiteMediaAlt } from '../../../../lib/site-media-types';
import { listSiteMediaAssets } from '../../../../lib/site-media-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
const response = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: NO_STORE_HEADERS });
function localized(value: unknown, required = false): SiteMediaAlt {
  if (!value || typeof value !== 'object') throw new GalleryError('Invalid description');
  const input = value as Record<string, unknown>;
  const result = emptyCaption();
  for (const key of ['en', 'zhHant', 'zhHans'] as const) {
    if (typeof input[key] !== 'string') throw new GalleryError('Invalid description');
    result[key] = input[key].trim();
    if (result[key].length > 300 || (required && result[key].length < 2)) throw new GalleryError(required ? 'Each photo description needs 2–300 characters in all three languages' : 'Caption must be 300 characters or fewer');
  }
  return result;
}
export async function GET(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request);
  if ('response' in access) return access.response;
  const { id } = await context.params;
  const op = new URL(request.url).searchParams.get('operationId');
  if (!isGalleryId(id) || !isOperationId(op)) return response({ error: 'Invalid request' }, 400);
  try {
    const saved = await operationStatus(op, id, access.principal.email);
    return response({ committed: !!saved, item: saved ? (await publicGalleries((await listGalleries()).filter(g => g.id === id), true))[0] : null });
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  if (error instanceof GalleryError || error instanceof SiteMediaImageError) return response({ error: error.message }, error.status);
  if (error instanceof TranslationReceiptError) return response({ error: error.message, code: error.code }, 409);
  console.error('Gallery operation failed', error);
  return response({ error: 'Could not confirm the save. Retry to check its status.' }, 503);
}
export async function POST(request: Request, context: Context) {
  const access = await authorizeAdminRequest(request);
  if ('response' in access) return access.response;
  if (!isSameOrigin(request)) return response({ error: 'Cross-origin request blocked' }, 403);
  const { id } = await context.params;
  if (!isGalleryId(id)) return response({ error: 'Unknown gallery' }, 404);
  const upload = request.headers.get('content-type')?.startsWith('multipart/form-data');
  const policy = upload ? RATE_LIMIT_POLICIES.galleryUpload : RATE_LIMIT_POLICIES.adminMutation;
  const decision = await enforceRateLimit(request, { ...policy, identifier: access.principal.email });
  if (decision.limited) return decision.response;
  let paths: string[] = [];
  let submitted = false;
  try {
    if (Number(request.headers.get('content-length') || 0) > (upload ? MULTIPART_MAX_BYTES : 32_768)) throw new GalleryError('Request too large', 413);
    let body: Record<string, any>;
    let file: File | null = null;
    try {
      if (upload) {
        const form = await request.formData();
        body = JSON.parse(String(form.get('metadata')));
        const candidate = form.get('file');
        if (!(candidate instanceof File)) throw new GalleryError('Choose a photo');
        file = candidate;
      } else body = await request.json();
    } catch { throw new GalleryError('Invalid upload or JSON body'); }
    if (!body || !isOperationId(body.operationId) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw new GalleryError('Reload before saving');
    if (!['put', 'remove', 'move'].includes(body.action)) throw new GalleryError('Invalid operation');
    const actor = access.principal.email;
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).update(file ? Buffer.from(await file.arrayBuffer()) : '').digest('hex');
    const previous = await operationStatus(body.operationId, id, actor);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new GalleryError('Operation ID was already used', 409);
      return response({ ok: true, replayed: true, item: (await publicGalleries((await listGalleries()).filter(g => g.id === id), true))[0] });
    }
    const current = (await listGalleries()).find(g => g.id === id);
    if (!current || current.version !== body.expectedVersion) throw new GalleryError('This gallery was changed by another administrator', 409);
    let item: GalleryItem | undefined;
    let asset: GalleryAsset | undefined;
    if (body.action === 'put') {
      const source = body.item;
      if (!source || typeof source.id !== 'string' || source.id.length > 80 || typeof source.hidden !== 'boolean') throw new GalleryError('Invalid media item');
      const existing = current.items.find(i => i.id === source.id);
      if (!existing && source.id !== body.operationId) throw new GalleryError('New items must use their operation ID');
      item = { id: source.id, kind: source.kind, hidden: source.hidden, caption: localized(source.caption) };
      if (source.kind === 'youtube') {
        const videoId = youtubeVideoId(source.url);
        if (!videoId || file) throw new GalleryError('Enter a valid YouTube video URL');
        item.videoId = videoId;
      } else if (source.kind === 'photo') {
        if (file || body.alt) {
          const alt = localized(body.alt, true);
          const slot = galleryAssetSlot(body.operationId);
          const oldAsset = existing?.assetSlot ? (existing.assetSlot.startsWith('gallery.') ? (await getGalleryAsset(existing.assetSlot))?.asset : (await listSiteMediaAssets()).find(a => a.slot === existing.assetSlot)) : null;
          const resource = { type: 'media' as const, scope: '', id: existing?.assetSlot || slot, version: oldAsset?.recordVersion || 0 };
          let states;
          if (body.translationReceipt) states = verifyTranslationReceipt({ receipt: body.translationReceipt, email: actor, resource, fields: { alt } });
          else if (oldAsset) {
            const previousStates = await readTranslationStates(resource);
            const changed = manualTranslationUpdateWrites({ alt }, { alt: oldAsset.alt });
            // Assets are immutable, so copy unchanged provenance to the new asset too.
            states = manualTranslationWrites({ alt }).map(fallback => changed.find(s => s.locale === fallback.locale) || previousStates.find(s => s.locale === fallback.locale) || { ...fallback, origin: 'protected_legacy' as const });
          } else states = manualTranslationWrites({ alt });
          let variants;
          if (file) {
            variants = await uploadSiteMediaVariants(slot, await processSiteMediaImage(file, { avatar: false }));
            paths = variants.map(v => v.storagePath);
          } else {
            if (!existing?.assetSlot) throw new GalleryError('Upload a photo first');
            if (!oldAsset) throw new GalleryError('To change the original photo description, upload its replacement');
            variants = oldAsset.variants;
          }
          asset = { asset: { slot, alt, variants, focalX: 50, focalY: 50, zoom: 100, recordVersion: 1, updatedBy: actor, updatedAt: new Date().toISOString() }, states };
          item.assetSlot = slot;
        } else {
          if (!existing || existing.kind !== 'photo') throw new GalleryError('Upload a photo first');
          item.assetSlot = existing.assetSlot;
        }
      } else throw new GalleryError('Unsupported media type');
    } else if (file || typeof body.itemId !== 'string' || (body.action === 'move' && ![-1, 1].includes(body.direction))) throw new GalleryError('Invalid media operation');
    submitted = true;
    const result = await mutateGallery({ id, actor, operationId: body.operationId, fingerprint, expectedVersion: body.expectedVersion, action: body.action, item, itemId: body.itemId, direction: body.direction, asset });
    if (result.replayed && paths.length) {
      const saved = await getGalleryAsset(galleryAssetSlot(body.operationId));
      const retained = new Set(saved?.asset.variants.map(v => v.storagePath));
      await removeSiteMediaObjects(paths.filter(p => !retained.has(p))).catch(() => undefined);
    }
    return response({ ok: true, ...result, item: (await publicGalleries([result.gallery], true))[0], gallery: undefined });
  } catch (error) {
    // Unknown transaction outcomes are not proof of rollback. Preserve their objects;
    // the operation status endpoint makes retries safe after a lost response.
    if (paths.length && (!submitted || error instanceof GalleryError || /^23/.test(String((error as { code?: string }).code || '')))) {
      await removeSiteMediaObjects(paths).catch(cleanup => console.error('Uncommitted gallery upload cleanup failed', cleanup));
    }
    return failure(error);
  }
}
