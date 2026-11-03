// Which kind of database connection this instance uses, written once to the runtime log so a release
// can confirm the production connection mode without anyone reading the connection string. Only one
// of DATABASE_MODES is ever written: never the URL, its host, user, password, port or query, and never
// an error message (a URL parse error repeats its input). It runs no query and changes no response.

export const DATABASE_MODES = ["transaction-pooler", "session-pooler", "direct", "local", "none", "unknown"] as const;
export type DatabaseMode = (typeof DATABASE_MODES)[number];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The URL the lib/*-store.ts modules connect with, by the same rule. */
export function configuredDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  return env.IHEAR_FORCE_FILE_STORE === "1" ? "" : env.POSTGRES_URL || env.DATABASE_URL || "";
}

/**
 * The connection mode a URL selects, judged from its host and port only. A URL without a host or port
 * falls back to PGHOST and PGPORT, then localhost and 5432, as postgres.js does. Anything not
 * recognised, including several hosts or another port, is "unknown": the mode is never guessed.
 */
export function databaseModeOf(url: string, env: NodeJS.ProcessEnv = process.env): DatabaseMode {
  if (!url) return "none";
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "unknown"; }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return "unknown";
  const host = (parsed.hostname || env.PGHOST || "localhost").toLowerCase();
  const port = parsed.port || env.PGPORT || "5432";
  if (host.includes(",")) return "unknown";
  if (host.endsWith(".pooler.supabase.com")) return port === "6543" ? "transaction-pooler" : port === "5432" ? "session-pooler" : "unknown";
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) return port === "5432" ? "direct" : "unknown";
  if (LOCAL_HOSTS.has(host)) return "local";
  return "unknown";
}

const globalForMode = globalThis as typeof globalThis & { ihearDatabaseModeLogged?: boolean };

/** Writes `ihear-db-mode=<mode>` to the log once per instance. Never throws. */
export function logDatabaseModeOnce() {
  try {
    if (globalForMode.ihearDatabaseModeLogged) return;
    globalForMode.ihearDatabaseModeLogged = true;
    const mode = databaseModeOf(configuredDatabaseUrl());
    console.info(`ihear-db-mode=${DATABASE_MODES.includes(mode) ? mode : "unknown"}`);
  } catch {
    // A diagnostic must never affect the page.
  }
}
