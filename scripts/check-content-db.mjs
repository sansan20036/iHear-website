import nextEnv from "@next/env";
import postgres from "postgres";
import { readFile } from "node:fs/promises";

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
  const catalog = JSON.parse(await readFile(new URL("../data/content-slots.json", import.meta.url), "utf8"));
  const rows = localized.table ? await sql`SELECT page, key, locale, value FROM public.localized_content_overrides` : [];
  const byIdentity = new Map(rows.map((row) => [`${row.page}\u0000${row.key}\u0000${row.locale}`, row.value]));
  const expected = catalog.slots.flatMap((slot) => ["en", "zhHant", "zhHans"].map((locale) => ({ page: slot.page, key: slot.key, locale })));
  const missing = expected.filter((item) => !byIdentity.has(`${item.page}\u0000${item.key}\u0000${item.locale}`));
  const blank = expected.filter((item) => !String(byIdentity.get(`${item.page}\u0000${item.key}\u0000${item.locale}`) || "").trim());
  const legacyMappings = [
    { source: ["/", "i18n:prog1_h", "en"], target: ["/__global__", "programs.services.tutoring.title", "en"] },
    { source: ["/about", "section:nth-of-type(1)>div:nth-of-type(1)>div:nth-of-type(1)>h2:nth-of-type(1)", "zhHant"], target: ["/about", "about.mission.heading", "zhHant"] },
    { source: ["/team", "i18n:tlnote_h", "en"], target: ["/team", "team.leadership_note.heading", "en"] },
    { source: ["/team", "i18n:tlnote_p", "en"], target: ["/team", "team.leadership_note.body", "en"] },
  ];
  const preservedLegacyMappings = legacyMappings.filter(({ source, target }) => byIdentity.get(source.join("\u0000")) === byIdentity.get(target.join("\u0000"))).length;
  const catalogCheck = { logicalSlots: catalog.slots.length, expectedLocalizedRows: expected.length, presentLocalizedRows: expected.length - missing.length, missing: missing.length, blank: blank.length, preservedLegacyMappings };
  const healthy = Boolean(
    legacy.table && localized.table && legacy.rowLevelSecurity && localized.rowLevelSecurity &&
    localized.columns.includes("locale") && localized.primaryKey === "{page,key,locale}" &&
    !missing.length && !blank.length && preservedLegacyMappings === legacyMappings.length
  );
  console.log(JSON.stringify({ connected: true, healthy, legacy, localized, catalog: catalogCheck }, null, 2));
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
