import type { PublicSiteMediaAsset, SiteMediaAlt, SiteMediaAsset } from './site-media-types';
import type { TranslationStateWrite } from './translation-types';

export const GALLERY_IDS = ['tutoring', 'outreach', 'home', 'stories', 'impact', 'home-banner'] as const;
export type GalleryId = typeof GALLERY_IDS[number];
export const GALLERY_LIMIT = 20;
export const GALLERY_TITLE_LIMIT = 120;
export type GalleryItem = {
  id: string; kind: 'photo' | 'youtube'; hidden: boolean; caption: SiteMediaAlt;
  // Optional in stored/legacy payloads; readers expose missing titles as null.
  title?: SiteMediaAlt | null;
  assetSlot?: string; videoId?: string;
};
export type Gallery = { id: GalleryId; version: number; items: GalleryItem[]; updatedBy: string; updatedAt: string };
export type GalleryAsset = { asset: SiteMediaAsset; states: TranslationStateWrite[] };
export type PublicGalleryItem = Omit<GalleryItem, 'title'> & { title: SiteMediaAlt | null; image?: PublicSiteMediaAsset; altStates?: TranslationStateWrite[] };
export type PublicGallery = Omit<Gallery, 'updatedBy' | 'items'> & { items: PublicGalleryItem[] };
export const emptyCaption = (): SiteMediaAlt => ({ en: '', zhHant: '', zhHans: '' });
export const isGalleryId = (value: unknown): value is GalleryId => GALLERY_IDS.includes(value as GalleryId);
export const isOperationId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const galleryAssetSlot = (id: string) => `gallery.${id}` as const;
export function normalizeGallery(gallery: Gallery): Gallery {
  return { ...gallery, items: gallery.items.map(item => ({ ...item, title: item.title ?? null })) };
}
export function initialGallery(id: GalleryId): Gallery {
  const item: GalleryItem = { id: `initial-${id}`, kind: 'photo', hidden: false, caption: emptyCaption() };
  if (id === 'home-banner') { item.assetSlot = 'home.hero'; item.title = null; }
  else if (id === 'tutoring' || id === 'outreach') item.assetSlot = `services.${id}`;
  else { item.kind = 'youtube'; item.videoId = 'LsQWwDBLKUc'; }
  return { id, version: 0, items: id === 'impact' ? [] : [item], updatedBy: '', updatedAt: '' };
}
