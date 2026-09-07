import { createHmac } from "node:crypto";

import { NextResponse } from "next/server";
import postgres from "postgres";


type RateLimitSql = ReturnType<typeof postgres>;
type RateLimitRow = {
  request_count: number;
  reset_at: Date | string;
};

type RateLimitOptions = {
  scope: string;
  limit: number;
  windowSeconds: number;
  identifier?: string;
};

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
  resetAt: string;
};

export type RateLimitDecision =
  | { limited: true; response: NextResponse }
  | { limited: false; result: RateLimitResult };

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1"
  ? ""
  : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const localBuckets = new Map<string, { count: number; windowStartedAt: number }>();
const globalForRateLimit = globalThis as typeof globalThis & {
  ihearRateLimitSql?: RateLimitSql;
};

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForRateLimit.ihearRateLimitSql) {
    globalForRateLimit.ihearRateLimitSql = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
      connect_timeout: 10,
      idle_timeout: 20,
    });
  }
  return globalForRateLimit.ihearRateLimitSql;
}

function rateLimitSecret(override?: string) {
  const secret =
    override ||
    process.env.RATE_LIMIT_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    (process.env.NODE_ENV === "production" ? "" : "ihear-local-rate-limit-only");
  if (!secret) throw new Error("RATE_LIMIT_SECRET or AUTH_SECRET is required");
  return secret;
}

export function clientIp(request: Request) {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const value = forwarded.split(",", 1)[0]?.trim().toLowerCase() || "unknown";
  return value.slice(0, 200);
}

export function hashRateLimitIdentifier(scope: string, identifier: string, secret?: string) {
  return createHmac("sha256", rateLimitSecret(secret))
    .update(`${scope}\u0000${identifier.trim().toLowerCase()}`)
    .digest("hex");
}

function validateOptions(options: RateLimitOptions) {
  if (!/^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(options.scope)) {
    throw new Error("Invalid rate-limit scope");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10_000) {
    throw new Error("Invalid rate-limit request limit");
  }
  if (
    !Number.isInteger(options.windowSeconds) ||
    options.windowSeconds < 1 ||
    options.windowSeconds > 86_400
  ) {
    throw new Error("Invalid rate-limit window");
  }
}

function resultFromCount(count: number, resetAt: Date, limit: number): RateLimitResult {
  const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfter,
    resetAt: resetAt.toISOString(),
  };
}

function consumeLocal(bucketKey: string, options: RateLimitOptions) {
  const now = Date.now();
  const windowMilliseconds = options.windowSeconds * 1000;
  const existing = localBuckets.get(bucketKey);
  const bucket =
    !existing || existing.windowStartedAt + windowMilliseconds <= now
      ? { count: 1, windowStartedAt: now }
      : { count: existing.count + 1, windowStartedAt: existing.windowStartedAt };
  localBuckets.set(bucketKey, bucket);
  return resultFromCount(
    bucket.count,
    new Date(bucket.windowStartedAt + windowMilliseconds),
    options.limit,
  );
}

async function consumeShared(bucketKey: string, options: RateLimitOptions) {
  const sql = sqlClient();
  if (!sql) return consumeLocal(bucketKey, options);

  const [row] = await sql<RateLimitRow[]>`
    INSERT INTO public.api_rate_limits (
      bucket_key, window_started_at, request_count, updated_at
    ) VALUES (
      ${bucketKey}, NOW(), 1, NOW()
    )
    ON CONFLICT (bucket_key) DO UPDATE SET
      window_started_at = CASE
        WHEN public.api_rate_limits.window_started_at
          <= NOW() - (${options.windowSeconds} * INTERVAL '1 second')
        THEN NOW()
        ELSE public.api_rate_limits.window_started_at
      END,
      request_count = CASE
        WHEN public.api_rate_limits.window_started_at
          <= NOW() - (${options.windowSeconds} * INTERVAL '1 second')
        THEN 1
        ELSE public.api_rate_limits.request_count + 1
      END,
      updated_at = NOW()
    RETURNING
      request_count,
      window_started_at + (${options.windowSeconds} * INTERVAL '1 second') AS reset_at
  `;

  return resultFromCount(
    Number(row.request_count),
    new Date(row.reset_at),
    options.limit,
  );
}

export function rateLimitExceededResponse(result: RateLimitResult) {
  return NextResponse.json(
    {
      error: "Too many requests",
      code: "RATE_LIMITED",
      retryAfter: result.retryAfter,
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": String(result.retryAfter),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": String(result.remaining),
        "RateLimit-Reset": String(Math.ceil(new Date(result.resetAt).getTime() / 1000)),
      },
    },
  );
}

function rateLimitHeaders(result: RateLimitResult) {
  return {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(Math.ceil(new Date(result.resetAt).getTime() / 1000)),
  };
}

export function withRateLimitHeaders<T extends Response>(
  response: T,
  decision: RateLimitDecision,
) {
  if (!("result" in decision)) return decision.response;
  for (const [name, value] of Object.entries(rateLimitHeaders(decision.result))) {
    response.headers.set(name, value);
  }
  return response;
}

function unavailableResponse() {
  return NextResponse.json(
    {
      error: "Request protection is temporarily unavailable",
      code: "RATE_LIMIT_UNAVAILABLE",
    },
    {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

export async function enforceRateLimit(request: Request, options: RateLimitOptions) {
  try {
    validateOptions(options);
    const identifier = options.identifier?.trim() || clientIp(request);
    const bucketKey = hashRateLimitIdentifier(options.scope, identifier);
    const result = await consumeShared(bucketKey, options);
    return result.allowed
      ? { limited: false as const, result }
      : { limited: true as const, response: rateLimitExceededResponse(result) };
  } catch (error) {
    console.error("API rate limiting failed", error);
    return { limited: true as const, response: unavailableResponse() };
  }
}

export const RATE_LIMIT_POLICIES = {
  auth: { scope: "auth", limit: 10, windowSeconds: 60 },
  adminMutation: { scope: "admin-mutation", limit: 30, windowSeconds: 60 },
  mediaUpload: { scope: "media-upload", limit: 10, windowSeconds: 600 },
  translation: { scope: "translation", limit: 15, windowSeconds: 60 },
} as const;
