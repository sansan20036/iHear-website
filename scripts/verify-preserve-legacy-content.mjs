import { readFile } from "node:fs/promises";
import path from "node:path";

import nextEnv from "@next/env";
import postgres from "postgres";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("POSTGRES_URL or DATABASE_URL is not configured.");

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
  connect_timeout: 10,
});
const migration = await readFile(
  path.join(process.cwd(), "db", "migrations", "018_preserve_production_legacy_content.sql"),
  "utf8",
);
const rollbackMarker = "IHEAR_PRESERVE_LEGACY_VERIFICATION_ROLLBACK";

const targets = [
  ["/__global__", "shared.prog.subtitle", "en", "/", "i18n:prog_sub"],
  ["/team", "team.roster.title", "en", "/team", "i18n:roster_h"],
  ["/team", "team.roster.subtitle", "en", "/team", "i18n:roster_sub"],
  ["/team", "team.team.intro", "en", "/team", "i18n:team_intro"],
];

async function readPairs(client) {
  const pairs = [];
  for (const [targetPage, targetKey, locale, sourcePage, sourceKey] of targets) {
    const rows = await client`
      SELECT page, key, locale, value, updated_by
      FROM public.localized_content_overrides
      WHERE (page = ${targetPage} AND key = ${targetKey} AND locale = ${locale})
         OR (page = ${sourcePage} AND key = ${sourceKey} AND locale = ${locale})
    `;
    const target = rows.find((row) => row.page === targetPage && row.key === targetKey);
    const source = rows.find((row) => row.page === sourcePage && row.key === sourceKey);
    pairs.push({ targetPage, targetKey, locale, target, source });
  }
  return pairs;
}

try {
  const before = await readPairs(sql);
  if (before.some((pair) => !pair.target || !pair.source)) {
    throw new Error("A legacy source or semantic target is missing.");
  }

  let verified = [];
  try {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
      const after = await readPairs(transaction);
      verified = after.map((pair) => ({
        page: pair.targetPage,
        key: pair.targetKey,
        matchesLegacy: pair.target.value === pair.source.value,
        updatedBy: pair.target.updated_by,
      }));
      if (verified.some((item) => !item.matchesLegacy)) {
        throw new Error("The guarded migration did not preserve every legacy value.");
      }
      throw new Error(rollbackMarker);
    });
  } catch (error) {
    if (error.message !== rollbackMarker) throw error;
  }

  const afterRollback = await readPairs(sql);
  const unchanged = before.every((pair, index) => (
    pair.target.value === afterRollback[index].target.value
      && pair.target.updated_by === afterRollback[index].target.updated_by
  ));
  if (!unchanged) throw new Error("Rollback verification changed production content.");

  console.log(JSON.stringify({
    verified: true,
    simulation: "passed-and-rolled-back",
    databaseUnchanged: true,
    targets: verified,
  }));
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
