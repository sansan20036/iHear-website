export const SITE_THEME_IDS = ["warm", "ocean", "sage", "lavender", "slate"] as const;

export type SiteThemeId = (typeof SITE_THEME_IDS)[number];

export type SiteThemePalette = {
  page: string;
  surface: string;
  subtle: string;
};

export const SITE_THEME_PALETTES: Record<SiteThemeId, SiteThemePalette> = {
  warm: { page: "#FAF7F2", surface: "#FFFFFF", subtle: "#F0EAE1" },
  ocean: { page: "#F2F6FA", surface: "#FFFFFF", subtle: "#E5EEF8" },
  sage: { page: "#F1F5F2", surface: "#FFFFFF", subtle: "#E2ECE4" },
  lavender: { page: "#F6F3F8", surface: "#FFFFFF", subtle: "#EDE7F2" },
  slate: { page: "#F4F5F7", surface: "#FFFFFF", subtle: "#E8EAEF" },
};

export type SiteThemeSetting = {
  theme: SiteThemeId;
  recordVersion: number;
  updatedAt: string;
  updatedBy: string;
};

export type PublicSiteThemeSetting = Omit<SiteThemeSetting, "updatedBy">;

export function isSiteThemeId(value: unknown): value is SiteThemeId {
  return typeof value === "string" && SITE_THEME_IDS.includes(value as SiteThemeId);
}

export function publicSiteThemeSetting(setting: SiteThemeSetting): PublicSiteThemeSetting {
  const { updatedBy: _updatedBy, ...publicSetting } = setting;
  return publicSetting;
}
