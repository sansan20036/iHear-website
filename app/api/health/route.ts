import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { checkApplicationHealth } from "../../../lib/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vercel-CDN-Cache-Control": "no-store",
};

export async function GET() {
  const requestId = randomUUID();

  try {
    const result = await checkApplicationHealth();
    if (!result.ok) {
      console.error("Health check reported an unavailable dependency", {
        requestId,
        reason: "reason" in result ? result.reason : "schema_not_ready",
      });
      return NextResponse.json(
        {
          status: "unavailable",
          version: 1,
          checks: { application: "ok", database: "unavailable" },
          requestId,
          timestamp: new Date().toISOString(),
        },
        {
          status: 503,
          headers: { ...NO_STORE_HEADERS, "X-Health-Request-Id": requestId },
        },
      );
    }

    return NextResponse.json(
      {
        status: "ok",
        version: 1,
        checks: { application: "ok", database: "ok" },
        requestId,
        timestamp: new Date().toISOString(),
      },
      { headers: { ...NO_STORE_HEADERS, "X-Health-Request-Id": requestId } },
    );
  } catch (error) {
    console.error("Health check database probe failed", {
      requestId,
      name: error instanceof Error ? error.name : "UnknownError",
      code:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "",
    });
    return NextResponse.json(
      {
        status: "unavailable",
        version: 1,
        checks: { application: "ok", database: "unavailable" },
        requestId,
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: { ...NO_STORE_HEADERS, "X-Health-Request-Id": requestId },
      },
    );
  }
}
