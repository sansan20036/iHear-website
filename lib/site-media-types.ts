export const SITE_MEDIA_SLOTS = [
  "home.hero",
  "services.tutoring",
  "services.outreach",
  "global.volunteers",
  "impact.learners.chart",
  "impact.tutors.chart",
  "team.zoe-lu.avatar",
  "team.daniel-hollis.avatar",
  "team.howard-ren.avatar",
] as const;
export type TeamAvatarSlot = `team.${string}.avatar`;
export type SiteMediaSlot = (typeof SITE_MEDIA_SLOTS)[number] | TeamAvatarSlot | `gallery.${string}`;

export type SiteMediaAlt = {
  en: string;
  zhHant: string;
  zhHans: string;
};

export type SiteMediaVariant = {
  width: number;
  pixelWidth: number;
  pixelHeight: number;
  byteSize: number;
  mimeType: "image/webp";
  url: string;
  storagePath: string;
};

export type ProcessedSiteMediaVariant = {
  width: number;
  pixelWidth: number;
  pixelHeight: number;
  byteSize: number;
  mimeType: "image/webp";
  buffer: Buffer;
};

export type SiteMediaAsset = {
  slot: SiteMediaSlot;
  alt: SiteMediaAlt;
  focalX: number;
  focalY: number;
  zoom: number;
  recordVersion: number;
  updatedAt: string;
  updatedBy: string;
  variants: SiteMediaVariant[];
};

export type PublicSiteMediaVariant = Omit<SiteMediaVariant, "storagePath">;
export type PublicSiteMediaAsset = Omit<SiteMediaAsset, "updatedBy" | "variants"> & {
  src: string;
  srcSet: string;
  variants: PublicSiteMediaVariant[];
};

export function isSiteMediaSlot(value: unknown): value is SiteMediaSlot {
  if (typeof value !== "string" || value.length > 100) return false;
  if (SITE_MEDIA_SLOTS.includes(value as (typeof SITE_MEDIA_SLOTS)[number])) return true;
  return /^team\.[a-z0-9]+(?:-[a-z0-9]+)*\.avatar$/.test(value) || /^gallery\.[0-9a-f-]{36}$/.test(value);
}

export function publicSiteMediaAsset(asset: SiteMediaAsset): PublicSiteMediaAsset {
  const variants = asset.variants
    .slice()
    .sort((left, right) => left.width - right.width)
    .map(({ storagePath, ...variant }) => ({
      ...variant,
      // Uploads use unique object paths, including after a slot is deleted and
      // recreated. Bind long-lived caches to that exact image, not only a row version.
      url: `/api/site-media/${encodeURIComponent(asset.slot)}/image?width=${variant.width}&v=${asset.recordVersion}&asset=${encodeURIComponent(storagePath)}`,
    }));
  const largest = variants.at(-1);
  return {
    slot: asset.slot,
    alt: asset.alt,
    focalX: asset.focalX,
    focalY: asset.focalY,
    zoom: asset.zoom,
    recordVersion: asset.recordVersion,
    updatedAt: asset.updatedAt,
    variants,
    src: largest?.url || "",
    srcSet: variants.map((variant) => `${variant.url} ${variant.pixelWidth}w`).join(", "),
  };
}
