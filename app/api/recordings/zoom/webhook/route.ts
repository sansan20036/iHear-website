import { after, NextResponse } from "next/server";

import { classroomDrive } from "../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { runClassroomTick } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { answerWhileClosed, ingestWebhook } from "../../../../../tools/recording-pathway/classroom/webhook-ingest.mjs";

export const dynamic = "force-dynamic";

// The lesson a verified delivery is about, if it names one of ours.
function lessonOf(rawBody: string) {
  try {
    const key = JSON.parse(rawBody)?.payload?.object?.session_key;
    return typeof key === "string" && /^[A-Za-z0-9-]{1,36}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

// Zoom's notifications. The signature is checked against the raw body, the minimized event is
// stored in one transaction with its follow-up jobs, and only then is the answer 200. A storage
// problem answers 503 so Zoom delivers again; a bad signature answers 401 and stores nothing.
// Once answered, the lesson's work (decisions, filing) runs after the response, so a finished
// recording is filed without waiting for the next heartbeat or overview refresh.
export async function POST(request: Request) {
  let secret: string | null = null;
  try {
    secret = classroomProvider().webhookSecret;
  } catch {
    secret = null;
  }
  // The classroom closed (no provider set) but Zoom's Secret Token configured: only Zoom's URL
  // validation is answered, so the event subscription can be created and stays validated before
  // the classroom opens; nothing is stored (webhook-ingest.mjs answerWhileClosed).
  const closedSecret = !secret && !process.env.CLASSROOM_PROVIDER ? (process.env.ZOOM_VIDEO_SDK_WEBHOOK_SECRET || "").trim() : "";
  if (!secret && !closedSecret) return NextResponse.json({ error: "Not configured" }, { status: 503, headers: NO_STORE_HEADERS });
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());
  if (!secret) {
    const closed = answerWhileClosed({ headers, rawBody, secret: closedSecret, now: Date.now() });
    return NextResponse.json(closed.body, { status: closed.status, headers: NO_STORE_HEADERS });
  }
  const store = classroomStore();
  const result = await ingestWebhook({ headers, rawBody, secret, now: Date.now(), store });
  const lessonId = result.status === 200 && "stored" in result.body ? lessonOf(rawBody) : null;
  if (lessonId) {
    after(async () => {
      try {
        await runClassroomTick({ store, provider: classroomProvider(), drive: classroomDrive(), now: Date.now(), lessonIds: [lessonId], workerId: `webhook-${lessonId}` });
      } catch {
        // Nothing is lost: the stored jobs wait for the next heartbeat, overview refresh or delivery.
      }
    });
  }
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS });
}
