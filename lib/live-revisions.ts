import postgres from "postgres";

export type LiveContentScope = "content" | "impact" | "team";

export type LiveRevision = {
  revision: string;
  updatedAt: string;
};

export type LiveRevisions = Record<LiveContentScope, LiveRevision>;

type RevisionRow = {
  scope: LiveContentScope;
  revision: string | number | bigint;
  updated_at: Date | string;
};

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const isHostedProduction =
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);

const globalForLiveRevisions = globalThis as typeof globalThis & {
  ihearLiveRevisionSql?: ReturnType<typeof postgres>;
  ihearFallbackLiveRevisions?: LiveRevisions;
};

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForLiveRevisions.ihearLiveRevisionSql) {
    globalForLiveRevisions.ihearLiveRevisionSql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
    });
  }
  return globalForLiveRevisions.ihearLiveRevisionSql;
}

function fallbackRevisions() {
  if (!globalForLiveRevisions.ihearFallbackLiveRevisions) {
    const now = new Date().toISOString();
    globalForLiveRevisions.ihearFallbackLiveRevisions = {
      content: { revision: "1", updatedAt: now },
      impact: { revision: "1", updatedAt: now },
      team: { revision: "1", updatedAt: now },
    };
  }
  return globalForLiveRevisions.ihearFallbackLiveRevisions;
}

function fromRows(rows: RevisionRow[]): LiveRevisions {
  const revisions = {} as LiveRevisions;
  for (const row of rows) {
    revisions[row.scope] = {
      revision: String(row.revision),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
  for (const scope of ["content", "impact", "team"] as const) {
    if (!revisions[scope]) throw new Error(`Missing live revision scope: ${scope}`);
  }
  return revisions;
}

export async function getLiveRevisions(): Promise<LiveRevisions> {
  const sql = sqlClient();
  if (!sql) {
    if (isHostedProduction) throw new Error("Live revision persistence is not configured");
    return structuredClone(fallbackRevisions());
  }
  const rows = await sql<RevisionRow[]>`
    SELECT scope, revision, updated_at
    FROM site_content_revisions
    ORDER BY scope
  `;
  return fromRows(rows);
}

export async function revisionAfterMutation(scope: LiveContentScope): Promise<LiveRevision> {
  const sql = sqlClient();
  if (!sql) {
    if (isHostedProduction) throw new Error("Live revision persistence is not configured");
    const revisions = fallbackRevisions();
    const next = String(Number(revisions[scope].revision) + 1);
    revisions[scope] = { revision: next, updatedAt: new Date().toISOString() };
    return { ...revisions[scope] };
  }
  const rows = await sql<RevisionRow[]>`
    SELECT scope, revision, updated_at
    FROM site_content_revisions
    WHERE scope = ${scope}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error(`Missing live revision scope: ${scope}`);
  return {
    revision: String(rows[0].revision),
    updatedAt: new Date(rows[0].updated_at).toISOString(),
  };
}
