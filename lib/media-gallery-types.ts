import type { PublicSiteMediaAsset, SiteMediaAlt, SiteMediaAsset } from './site-media-types';
import type { TranslationStateWrite } from './translation-types';

export const GALLERY_IDS = ['tutoring', 'outreach', 'home', 'stories', 'impact'] as const;
export type GalleryId = typeof GALLERY_IDS[number];
export const GALLERY_LIMIT = 20;
export type GalleryItem = {
  id: string; kind: 'photo' | 'youtube'; hidden: boolean; caption: SiteMediaAlt;
  assetSlot?: string; videoId?: string;
};
export type Gallery = { id: GalleryId; version: number; items: GalleryItem[]; updatedBy: string; updatedAt: string };
export type GalleryAsset = { asset: SiteMediaAsset; states: TranslationStateWrite[] };
export type PublicGalleryItem = GalleryItem & { image?: PublicSiteMediaAsset; altStates?: TranslationStateWrite[] };
export type PublicGallery = Omit<Gallery, 'updatedBy' | 'items'> & { items: PublicGalleryItem[] };
export const emptyCaption = (): SiteMediaAlt => ({ en: '', zhHant: '', zhHans: '' });
export const isGalleryId = (value: unknown): value is GalleryId => GALLERY_IDS.includes(value as GalleryId);
export const isOperationId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const galleryAssetSlot = (id: string) => `gallery.${id}` as const;
export function initialGallery(id: GalleryId): Gallery {
  const item: GalleryItem = { id: `initial-${id}`, kind: 'photo', hidden: false, caption: emptyCaption() };
  if (id === 'tutoring' || id === 'outreach') item.assetSlot = `services.${id}`;
  else { item.kind = 'youtube'; item.videoId = 'LsQWwDBLKUc'; }
  return { id, version: 0, items: id === 'impact' ? [] : [item], updatedBy: '', updatedAt: '' };
}
