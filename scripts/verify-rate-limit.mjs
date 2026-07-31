import { createHash } from "node:crypto";

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

const bucketKey = createHash("sha256")
  .update("ihear-rate-limit-database-verification")
  .digest("hex");
const windowSeconds = 60;
const rollbackMarker = new Error("ROLLBACK_RATE_LIMIT_VERIFICATION");

async function consume(client) {
  const [row] = await client`
    INSERT INTO public.api_rate_limits (
      bucket_key, window_started_at, request_count, updated_at
    ) VALUES (
      ${bucketKey}, NOW(), 1, NOW()
    )
    ON CONFLICT (bucket_key) DO UPDATE SET
      window_started_at = CASE
        WHEN public.api_rate_limits.window_started_at
          <= NOW() - (${windowSeconds} * INTERVAL '1 second')
        THEN NOW()
        ELSE public.api_rate_limits.window_started_at
      END,
      request_count = CASE
        WHEN public.api_rate_limits.window_started_at
          <= NOW() - (${windowSeconds} * INTERVAL '1 second')
        THEN 1
        ELSE public.api_rate_limits.request_count + 1
      END,
      updated_at = NOW()
    RETURNING
      request_count,
      window_started_at + (${windowSeconds} * INTERVAL '1 second') AS reset_at
  `;
  return row;
}

try {
  const [before] = await sql`
    SELECT COUNT(*)::INTEGER AS count
    FROM public.api_rate_limits
    WHERE bucket_key = ${bucketKey}
  `;

  try {
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM public.api_rate_limits WHERE bucket_key = ${bucketKey}`;

      let row;
      for (let request = 1; request <= 11; request += 1) {
        row = await consume(transaction);
        if (Number(row.request_count) !== request) {
          throw new Error(`Expected request count ${request}, received ${row.request_count}`);
        }
      }

      if (new Date(row.reset_at).getTime() <= Date.now()) {
        throw new Error("Rate-limit reset time was not in the future");
      }

      await transaction`
        UPDATE public.api_rate_limits
        SET
          window_started_at = NOW() - INTERVAL '61 seconds',
          updated_at = NOW()
        WHERE bucket_key = ${bucketKey}
      `;
      const resetRow = await consume(transaction);
      if (Number(resetRow.request_count) !== 1) {
        throw new Error(`Expected expired bucket to reset to 1, received ${resetRow.request_count}`);
      }

      throw rollbackMarker;
    });
  } catch (error) {
    if (error !== rollbackMarker) throw error;
  }

  const [after] = await sql`
    SELECT COUNT(*)::INTEGER AS count
    FROM public.api_rate_limits
    WHERE bucket_key = ${bucketKey}
  `;
  if (Number(after.count) !== Number(before.count)) {
    throw new Error("Rate-limit verification transaction did not roll back cleanly");
  }

  console.log(JSON.stringify({
    connected: true,
    atomicIncrement: true,
    expiredWindowReset: true,
    databaseUnchanged: true,
  }));
} catch (error) {
  console.error(JSON.stringify({
    connected: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
