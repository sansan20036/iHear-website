import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { classroomDrive } from "../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../lib/classroom-provider";
import { runClassroomTick } from "../../../../lib/classroom-service";
import { classroomStore } from "../../../../lib/classroom-store";
import { NO_STORE_HEADERS } from "../../../../lib/response-headers";

export const dynamic = "force-dynamic";
// The tick stops starting new work this long before the platform would stop the function.
export const maxDuration = 60;
const MARGIN_MS = 10_000;

const digest = (value: string) => createHash("sha256").update(value).digest();

// The scheduled tick. A scheduler (Vercel Cron, or the database's pg_cron calling out) sends
// `Authorization: Bearer <CRON_SECRET>` every minute; this runs the same tick as the overview and
// the tutor's heartbeat, but gives filing most of the function's time. Nothing depends on one
// call finishing: jobs are stored and leased, a recording that does not fit carries on in the
// next call, and a call that is stopped mid-way only loses its lease. Without CRON_SECRET (at
// least 32 characters) the route answers 503 and does nothing.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  if (secret.length < 32) return NextResponse.json({ error: "Not configured" }, { status: 503, headers: NO_STORE_HEADERS });
  const given = request.headers.get("authorization") || "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  let provider;
  let drive;
  try {
    provider = classroomProvider();
    drive = classroomDrive();
  } catch {
    return NextResponse.json({ error: "The classroom is not available yet", code: "PROVIDER_UNAVAILABLE" }, { status: 503, headers: NO_STORE_HEADERS });
  }
  try {
    const summary = await runClassroomTick({
      store: classroomStore(),
      provider,
      drive,
      now: Date.now(),
      workerId: `scheduled-${randomUUID().slice(0, 8)}`,
      maxJobs: 50,
      filingBudgetMs: maxDuration * 1000 - MARGIN_MS,
      filingSafetyMs: 15_000,
    });
    return NextResponse.json({ ok: true, ...summary }, { status: 200, headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "The tick did not finish; the next one carries on" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
