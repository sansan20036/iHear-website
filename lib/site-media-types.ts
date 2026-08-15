export const SITE_MEDIA_SLOTS = [
  "home.hero",
  "services.tutoring",
  "services.outreach",
  "global.volunteers",
] as const;
export type SiteMediaSlot = (typeof SITE_MEDIA_SLOTS)[number];

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

export type SiteMediaAsset = {
  slot: SiteMediaSlot;
  alt: SiteMediaAlt;
  focalX: 0 | 50 | 100;
  focalY: 0 | 50 | 100;
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
  return typeof value === "string" && SITE_MEDIA_SLOTS.includes(value as SiteMediaSlot);
}

export function publicSiteMediaAsset(asset: SiteMediaAsset): PublicSiteMediaAsset {
  const variants = asset.variants
    .slice()
    .sort((left, right) => left.width - right.width)
    .map(({ storagePath: _storagePath, ...variant }) => variant);
  const largest = variants.at(-1);
  return {
    slot: asset.slot,
    alt: asset.alt,
    focalX: asset.focalX,
    focalY: asset.focalY,
    recordVersion: asset.recordVersion,
    updatedAt: asset.updatedAt,
    variants,
    src: largest?.url || "",
    srcSet: variants.map((variant) => `${variant.url} ${variant.pixelWidth}w`).join(", "),
  };
}
