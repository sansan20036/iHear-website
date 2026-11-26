import postgres from "postgres";

// Round 18c (the server load check on the online test site, 2026-11-27 02:02–02:09): while 100
// simulated people came in, 205 answers failed, all with the database pooler's
// "(EMAXCONN) max client connections reached, limit: 200" (Vercel's runtime log, read 02:30): the
// room channel 183, the lesson's status 13, the door 3, health 3, live revisions 2. Once everyone was
// in, none. Each server instance had opened its own pool for the rate limit (1), the lessons (3), the
// room channel (2) and the live revisions (2), and only the rate limit's ever closed when idle; as
// Vercel added instances for the burst, their connections passed the pooler's 200 client connections
// (production's database is the same plan, so the same limit).
// So these four now share ONE pool per instance, and a connection idle for 10 s is closed, so
// instances left over from a burst give their connections back. The health probe keeps its own
// (one connection, already closed when idle) so that it still says whether the database answers.
const SHARED_MAX = 3;
const IDLE_SECONDS = 10;
const CONNECT_SECONDS = 10;

const globalForSharedSql = globalThis as typeof globalThis & { ihearSharedSql?: postgres.Sql };

export function sharedSql(databaseUrl: string): postgres.Sql {
  globalForSharedSql.ihearSharedSql ??= postgres(databaseUrl, {
    max: SHARED_MAX,
    prepare: false,
    ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
    onnotice: () => undefined,
    idle_timeout: IDLE_SECONDS,
    connect_timeout: CONNECT_SECONDS,
  });
  return globalForSharedSql.ihearSharedSql;
}
