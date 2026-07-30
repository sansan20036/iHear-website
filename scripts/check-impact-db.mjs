import nextEnv from "@next/env";
import postgres from "postgres";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
  console.error("POSTGRES_URL or DATABASE_URL is not configured.");
  process.exit(1);
}

const sql = postgres(process.env.POSTGRES_URL || process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
  connect_timeout: 10,
});

try {
  const [table] = await sql`
    SELECT to_regclass('public.impact_milestones')::text AS table_name
  `;
  const rowCount = table.table_name
    ? Number((await sql`SELECT COUNT(*)::int AS count FROM impact_milestones`)[0].count)
    : 0;

  console.log(JSON.stringify({
    connected: true,
    table: table.table_name || null,
    rowCount,
  }));
} catch (error) {
  console.error(JSON.stringify({
    connected: false,
    code: error && error.code ? error.code : "",
    message: error && error.message ? error.message : "Database connection failed",
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
