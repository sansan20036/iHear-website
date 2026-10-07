import { listGalleries } from './media-gallery-store';
import { publicGalleries } from './media-gallery-public';
import type { PublicSiteMediaAsset, SiteMediaAlt } from './site-media-types';

export const HOME_BANNER_DEADLINE_MS = 1_000;
export type HomeBannerItem = {
  id: string; kind: 'photo'; hidden: false; assetSlot: string;
  title: SiteMediaAlt | null; caption: SiteMediaAlt; image: PublicSiteMediaAsset;
};
export type HomeBannerSnapshot = {
  schemaVersion: 1; galleryId: 'home-banner'; state: 'ready' | 'empty' | 'error';
  version: number | null; updatedAt: string | null; items: HomeBannerItem[];
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid banner text');
  return value;
}
function localized(value: unknown): SiteMediaAlt {
  if (!record(value)) throw new Error('Invalid banner translations');
  return { en: text(value.en), zhHant: text(value.zhHant), zhHans: text(value.zhHans) };
}
function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error('Invalid banner image metadata');
  return value;
}
function imageUrl(value: unknown): string {
  const url = text(value);
  // The existing public image resolver emits same-origin, root-relative URLs.
  // Reject schemes, protocol-relative URLs, backslashes and URL control bytes.
  if (!url.startsWith('/') || url.startsWith('//') || /[\s\\\u0000-\u001f\u007f]/.test(url) || new URL(url, 'https://banner.invalid').origin !== 'https://banner.invalid') throw new Error('Invalid banner image URL');
  return url;
}
function imageMetadata(value: unknown, slot: string): PublicSiteMediaAsset {
  if (!record(value) || value.slot !== slot || !integer(value.recordVersion) || !Array.isArray(value.variants)) throw new Error('Invalid banner image');
  const srcSet = text(value.srcSet);
  if (!srcSet || srcSet.split(',').some(entry => {
    const match = /^(\S+) ([1-9]\d*)w$/.exec(entry.trim());
    if (!match) return true;
    imageUrl(match[1]);
    return false;
  })) throw new Error('Invalid banner responsive image');
  const variants = value.variants.map(variant => {
    if (!record(variant) || !integer(variant.width, 1) || !integer(variant.pixelWidth, 1) || !integer(variant.pixelHeight, 1) || !integer(variant.byteSize) || variant.mimeType !== 'image/webp') throw new Error('Invalid banner image variant');
    return { width: variant.width, pixelWidth: variant.pixelWidth, pixelHeight: variant.pixelHeight, byteSize: variant.byteSize, mimeType: 'image/webp' as const, url: imageUrl(variant.url) };
  });
  const src = imageUrl(value.src);
  // The only CP1 resolver fallback has no variant dimensions. Its bundled
  // original is 1200 x 799; a missing custom asset is an error, never a seed.
  if (!variants.length && !(slot === 'home.hero' && src === '/assets/images/hero-classroom-1200.webp')) throw new Error('Missing banner image dimensions');
  return {
    slot: slot as PublicSiteMediaAsset['slot'], alt: localized(value.alt),
    focalX: number(value.focalX, 0, 100), focalY: number(value.focalY, 0, 100), zoom: number(value.zoom, 100, 250),
    recordVersion: value.recordVersion, updatedAt: text(value.updatedAt), src, srcSet, variants,
  };
}
function projectSnapshot(value: unknown): HomeBannerSnapshot {
  if (!record(value) || value.id !== 'home-banner' || !integer(value.version) || !Array.isArray(value.items) || value.items.length > 20) throw new Error('Invalid banner gallery');
  const items = value.items.filter(item => !record(item) || item.hidden !== true).map(item => {
    if (!record(item) || item.kind !== 'photo' || item.hidden !== false || typeof item.assetSlot !== 'string' || !item.assetSlot || typeof item.id !== 'string' || !item.id) throw new Error('Invalid banner item');
    return {
      id: item.id, kind: 'photo' as const, hidden: false as const, assetSlot: item.assetSlot,
      title: item.title == null ? null : localized(item.title), caption: localized(item.caption), image: imageMetadata(item.image, item.assetSlot),
    };
  });
  // Copy only the public contract. Unexpected operation/actor/storage fields
  // cannot leak from a malformed store or a future projection extension.
  return { schemaVersion: 1, galleryId: 'home-banner', state: items.length ? 'ready' : 'empty', version: value.version, updatedAt: text(value.updatedAt), items };
}
const errorSnapshot = (): HomeBannerSnapshot => ({ schemaVersion: 1, galleryId: 'home-banner', state: 'error', version: null, updatedAt: null, items: [] });

async function readPublicBanner(): Promise<unknown> {
  const galleries = (await listGalleries()).filter(gallery => gallery.id === 'home-banner');
  if (galleries.length !== 1) throw new Error('Missing banner gallery');
  return (await publicGalleries(galleries))[0];
}

/** Bound this optional section independently of the rest of the homepage.
 * The file/PG store interfaces do not accept an AbortSignal. This deadline
 * stops waiting, not the underlying reads; both late outcomes are consumed.
 * No shared PostgreSQL client is terminated or borrowed connection cancelled.
 */
export async function loadHomeBanner(reader: () => Promise<unknown> = readPublicBanner): Promise<HomeBannerSnapshot> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (snapshot: HomeBannerSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(snapshot);
    };
    const timer = setTimeout(() => finish(errorSnapshot()), HOME_BANNER_DEADLINE_MS);
    Promise.resolve().then(reader).then(value => {
      try { finish(projectSnapshot(value)); } catch { finish(errorSnapshot()); }
    }, () => finish(errorSnapshot()));
  });
}
