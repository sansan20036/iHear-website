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

async function inspectTable(tableName) {
  const [table] = await sql`
    SELECT to_regclass(${`public.${tableName}`})::text AS table_name
  `;
  if (!table.table_name) return { table: null, rowCount: 0, rowLevelSecurity: false, columns: [], primaryKey: null };

  const [count] = await sql.unsafe(`SELECT COUNT(*)::INTEGER AS count FROM public.${tableName}`);
  const [rls] = await sql`
    SELECT relrowsecurity AS enabled FROM pg_class WHERE oid = ${`public.${tableName}`}::regclass
  `;
  const columns = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
    ORDER BY ordinal_position
  `;
  const primaryKey = await sql`
    SELECT array_agg(attribute.attname ORDER BY key_column.position)::text AS columns
    FROM pg_index AS idx
    CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS key_column(attribute_number, position)
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = idx.indrelid AND attribute.attnum = key_column.attribute_number
    WHERE idx.indrelid = ${`public.${tableName}`}::regclass AND idx.indisprimary
  `;
  return {
    table: table.table_name,
    rowCount: Number(count.count),
    rowLevelSecurity: Boolean(rls.enabled),
    columns: columns.map((column) => column.column_name),
    primaryKey: primaryKey[0]?.columns || null,
  };
}

try {
  const legacy = await inspectTable("content_overrides");
  const localized = await inspectTable("localized_content_overrides");
  const healthy = Boolean(
    legacy.table && localized.table && legacy.rowLevelSecurity && localized.rowLevelSecurity &&
    localized.columns.includes("locale") && localized.primaryKey === "{page,key,locale}"
  );
  console.log(JSON.stringify({ connected: true, healthy, legacy, localized }, null, 2));
  if (!healthy) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    connected: false,
    code: error?.code || "",
    message: error?.message || "Database connection failed",
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
