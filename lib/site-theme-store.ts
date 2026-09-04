import postgres from "postgres";

import type { SiteThemeId, SiteThemeSetting } from "./site-theme-types";

type SiteThemeRow = {
  value: string;
  record_version: number;
  updated_at: Date | string;
  updated_by: string;
};

export class SiteThemeConfigurationError extends Error {
  constructor() {
    super("Site theme persistence is not configured");
    this.name = "SiteThemeConfigurationError";
  }
}

export class SiteThemeConflictError extends Error {
  constructor() {
    super("Another administrator changed the site theme");
    this.name = "SiteThemeConflictError";
  }
}

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1"
  ? ""
  : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const isHostedProduction =
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);

const globalForSiteTheme = globalThis as typeof globalThis & {
  ihearSiteThemeSql?: ReturnType<typeof postgres>;
  ihearFallbackSiteTheme?: SiteThemeSetting;
};

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForSiteTheme.ihearSiteThemeSql) {
    globalForSiteTheme.ihearSiteThemeSql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
      connect_timeout: 5,
    });
  }
  return globalForSiteTheme.ihearSiteThemeSql;
}

function fallbackSetting() {
  if (!globalForSiteTheme.ihearFallbackSiteTheme) {
    globalForSiteTheme.ihearFallbackSiteTheme = {
      theme: "warm",
      recordVersion: 1,
      updatedAt: new Date(0).toISOString(),
      updatedBy: "local-fallback",
    };
  }
  return globalForSiteTheme.ihearFallbackSiteTheme;
}

function fromRow(row: SiteThemeRow): SiteThemeSetting {
  return {
    theme: row.value as SiteThemeId,
    recordVersion: Number(row.record_version),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
  };
}

function configurationError(error: unknown) {
  const code = (error as { code?: string }).code;
  return code === "42P01" || code === "42703";
}

export async function readSiteTheme(): Promise<SiteThemeSetting> {
  const sql = sqlClient();
  if (!sql) {
    if (isHostedProduction) throw new SiteThemeConfigurationError();
    return { ...fallbackSetting() };
  }
  try {
    const rows = await sql<SiteThemeRow[]>`
      SELECT value, record_version, updated_at, updated_by
      FROM public.site_settings
      WHERE key = 'site_theme'
      LIMIT 1
    `;
    if (!rows[0]) throw new SiteThemeConfigurationError();
    return fromRow(rows[0]);
  } catch (error) {
    if (configurationError(error)) throw new SiteThemeConfigurationError();
    throw error;
  }
}

export async function updateSiteTheme(params: {
  theme: SiteThemeId;
  expectedVersion: number;
  updatedBy: string;
}): Promise<SiteThemeSetting> {
  const sql = sqlClient();
  if (!sql) {
    if (isHostedProduction) throw new SiteThemeConfigurationError();
    const current = fallbackSetting();
    if (current.recordVersion !== params.expectedVersion) throw new SiteThemeConflictError();
    globalForSiteTheme.ihearFallbackSiteTheme = {
      theme: params.theme,
      recordVersion: current.recordVersion + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: params.updatedBy,
    };
    return { ...globalForSiteTheme.ihearFallbackSiteTheme };
  }
  try {
    const rows = await sql<SiteThemeRow[]>`
      UPDATE public.site_settings
      SET value = ${params.theme},
          record_version = record_version + 1,
          updated_at = clock_timestamp(),
          updated_by = ${params.updatedBy}
      WHERE key = 'site_theme' AND record_version = ${params.expectedVersion}
      RETURNING value, record_version, updated_at, updated_by
    `;
    if (!rows[0]) throw new SiteThemeConflictError();
    return fromRow(rows[0]);
  } catch (error) {
    if (configurationError(error)) throw new SiteThemeConfigurationError();
    throw error;
  }
}
