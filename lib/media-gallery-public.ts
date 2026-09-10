import { listSiteMediaAssets } from './site-media-store';
import { publicSiteMediaAsset, type PublicSiteMediaAsset } from './site-media-types';
import { getGalleryAssets } from './media-gallery-store';
import type { Gallery, PublicGallery } from './media-gallery-types';
import { readTranslationStates } from './translation-state';

function fallback(slot: string): PublicSiteMediaAsset | undefined {
  if (slot !== 'services.tutoring' && slot !== 'services.outreach') return;
  const tutoring = slot === 'services.tutoring';
  const name = tutoring ? 'tutoring-student' : 'seminar';
  return {
    slot, alt: tutoring ? { en: 'Young student focused on a writing exercise', zhHant: '年輕學生專注進行書寫練習', zhHans: '年轻学生专注进行书写练习' } : { en: 'Speaker presenting a hearing health seminar to a room', zhHant: '講者向現場聽眾進行聽力健康講座', zhHans: '讲者向现场听众进行听力健康讲座' },
    focalX: 50, focalY: 50, zoom: 100, recordVersion: 0, updatedAt: '',
    src: `/assets/images/${name}-1200.webp`, srcSet: [480, 800, 1200].map(w => `/assets/images/${name}-${w}.webp ${w}w`).join(', '), variants: [],
  };
}
export async function publicGalleries(galleries: Gallery[], admin = false): Promise<PublicGallery[]> {
  const visible = galleries.map(g => ({ ...g, items: g.items.filter(item => admin || !item.hidden) }));
  const slots = [...new Set(visible.flatMap(g => g.items.map(i => i.assetSlot || '')).filter(s => s.startsWith('gallery.')))];
  const [legacy, galleryAssets] = await Promise.all([
    visible.some(g => g.items.some(i => i.assetSlot?.startsWith('services.'))) ? listSiteMediaAssets() : Promise.resolve([]),
    getGalleryAssets(slots),
  ]);
  const assets = new Map([...legacy, ...galleryAssets.map(a => a.asset)].map(a => [a.slot, publicSiteMediaAsset(a)]));
  const states = new Map(galleryAssets.map(a => [a.asset.slot as string, a.states]));
  if (admin) await Promise.all(legacy.filter(a => a.slot.startsWith('services.')).map(async a => { states.set(a.slot, await readTranslationStates({ type: 'media', scope: '', id: a.slot })); }));
  return visible.map(({ updatedBy: _actor, ...g }) => ({ ...g, items: g.items.map(item => {
    if (item.kind === 'youtube') return item;
    return { ...item, image: assets.get(item.assetSlot as any) || fallback(item.assetSlot || ''), ...(admin ? { altStates: states.get(item.assetSlot || '') || [] } : {}) };
  }) }));
}
