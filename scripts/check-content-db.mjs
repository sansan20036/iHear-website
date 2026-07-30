import nextEnv from "@next/env";
import postgres from "postgres";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("POSTGRES_URL or DATABASE_URL is not configured.");
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
  connect_timeout: 10,
});

try {
  const [table] = await sql`
    SELECT to_regclass('public.content_overrides')::text AS table_name
  `;
  const rowCount = table.table_name
    ? Number((await sql`SELECT COUNT(*)::INTEGER AS count FROM content_overrides`)[0].count)
    : 0;
  const [rls] = table.table_name
    ? await sql`
        SELECT relrowsecurity AS enabled
        FROM pg_class
        WHERE oid = 'public.content_overrides'::regclass
      `
    : [{ enabled: false }];
  const columns = table.table_name
    ? await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'content_overrides'
        ORDER BY ordinal_position
      `
    : [];
  const primaryKey = table.table_name
    ? await sql`
        SELECT array_agg(attribute.attname ORDER BY key_column.position)::text AS columns
        FROM pg_index AS idx
        CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS key_column(attribute_number, position)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = idx.indrelid
          AND attribute.attnum = key_column.attribute_number
        WHERE idx.indrelid = 'public.content_overrides'::regclass
          AND idx.indisprimary
      `
    : [];

  console.log(JSON.stringify({
    connected: true,
    table: table.table_name || null,
    rowCount,
    rowLevelSecurity: Boolean(rls.enabled),
    columns: columns.map((column) => column.column_name),
    primaryKey: primaryKey[0]?.columns || null,
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
