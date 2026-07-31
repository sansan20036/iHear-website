import postgres from "postgres";

type HealthSql = ReturnType<typeof postgres>;
type HealthRow = { ready: boolean };

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const globalForHealth = globalThis as typeof globalThis & {
  ihearHealthSql?: HealthSql;
};

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForHealth.ihearHealthSql) {
    globalForHealth.ihearHealthSql = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
      connect_timeout: 5,
      idle_timeout: 10,
      max_lifetime: 60 * 5,
    });
  }
  return globalForHealth.ihearHealthSql;
}

export async function checkApplicationHealth() {
  const sql = sqlClient();
  if (!sql) return { ok: false as const, reason: "database_not_configured" as const };

  const startedAt = Date.now();
  const [row] = await sql<HealthRow[]>`
    SELECT (
      to_regclass('public.content_overrides') IS NOT NULL
      AND to_regclass('public.impact_milestones') IS NOT NULL
      AND to_regclass('public.impact_milestone_settings') IS NOT NULL
      AND to_regclass('public.team_people') IS NOT NULL
      AND to_regclass('public.team_profiles') IS NOT NULL
      AND to_regclass('public.site_content_revisions') IS NOT NULL
      AND to_regclass('public.api_rate_limits') IS NOT NULL
      AND to_regclass('public.schema_migrations') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.schema_migrations
        WHERE version = '009'
      )
    ) AS ready
  `;

  return {
    ok: Boolean(row?.ready),
    latencyMs: Math.max(0, Date.now() - startedAt),
  } as const;
}
