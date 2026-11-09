import { after, NextResponse } from "next/server";

import { classroomDrive } from "../../../../../lib/classroom-drive";
import { classroomProvider } from "../../../../../lib/classroom-provider";
import { runClassroomTick } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { fileRoomRegistry, tencentLcicConfig, verifyLcicCallback } from "../../../../../lib/classroom-vendors/tencent-lcic";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { minimizeLcicCallback } from "../../../../../tools/recording-pathway/classroom/lcic-callback.mjs";
// @ts-ignore - shared classroom logic, plain JavaScript tested with node --test.
import { ingestFacts } from "../../../../../tools/recording-pathway/classroom/webhook-ingest.mjs";

export const dynamic = "force-dynamic";

// Tencent LCIC's callbacks (configured in the LCIC console). Like Zoom's notices: verified
// (md5 of the callback key and the expiry), minimized, stored with their follow-up jobs in one
// transaction, and only then answered with LCIC's success body. A storage problem answers 503;
// whether LCIC delivers again after that is not documented (to be checked in the trial).
export async function POST(request: Request) {
  const config = tencentLcicConfig(process.env);
  if (!config) return NextResponse.json({ error: "Not configured" }, { status: 503, headers: NO_STORE_HEADERS });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const problem = verifyLcicCallback(body, config, Date.now());
  if (problem) return NextResponse.json({ error: problem }, { status: 401, headers: NO_STORE_HEADERS });
  const rooms = fileRoomRegistry();
  const facts = await minimizeLcicCallback(body, {
    lookup: async (roomId: number) => {
      const found = await rooms.lessonOfRoom(roomId);
      return found ? { lessonId: found.lessonId, users: found.room.users } : null;
    },
    receivedAt: Date.now(),
  });
  if (facts.length) {
    const store = classroomStore();
    const result = await ingestFacts({ store, facts });
    if (result.status !== 200) return NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS });
    const lessonId = facts[0].lessonId as string;
    after(async () => {
      try {
        await runClassroomTick({ store, provider: classroomProvider(), drive: classroomDrive(), now: Date.now(), lessonIds: [lessonId], workerId: `lcic-${lessonId}` });
      } catch {
        // The stored jobs wait for the next heartbeat or overview refresh.
      }
    });
  }
  return NextResponse.json({ error_code: 0 }, { headers: NO_STORE_HEADERS });
}
