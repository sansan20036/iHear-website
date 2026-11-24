import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { classroomStore } from "../../../../lib/classroom-store";
import { NO_STORE_HEADERS } from "../../../../lib/response-headers";
import { roomChannelLesson } from "../../../../lib/room-channel/caller";
import { roomChannel } from "../../../../lib/room-channel/channel";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const digest = (value: string) => createHash("sha256").update(value).digest();

// The room channel's scheduled sweep (local integration only, 2026-11-23; scheduled by nobody
// yet: a schedule is a production setting and stays a proposal until the user approves it).
// A scheduler sends `Authorization: Bearer <CRON_SECRET>`, as for the classroom's own tick, every
// few minutes (lib/room-channel/retention.mjs: sweepEveryMs). It deletes every whiteboard, chat
// and share turn that is past its time, gives up what an old clear took, and closes the lessons
// that are over. It works whatever the three switches say: what was stored while a switch was on
// must still be deleted after the switch is turned off.
//
// The answer says what was done and what is still held. "overdue" should be 0 after every run: a
// number above 0, or a run that does not happen, means stored content is outliving its time.
// Without CRON_SECRET (at least 32 characters) the route answers 503 and does nothing.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  if (secret.length < 32) return NextResponse.json({ error: "Not configured" }, { status: 503, headers: NO_STORE_HEADERS });
  const given = request.headers.get("authorization") || "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  try {
    const store = classroomStore();
    const now = Date.now();
    const summary = await roomChannel().sweep({
      now,
      limit: 200,
      // A lesson that no longer exists (or is no fixed room's lesson) is closed as of now; one that
      // cannot be read just now is left as it is and counted (lessonsNotRead).
      lessonFacts: async (lessonId: string) => {
        const found = await roomChannelLesson(store, lessonId, now);
        return found ? { endedAt: found.facts.endedAt, scheduledEnd: found.facts.scheduledEnd } : { gone: true };
      },
    });
    return NextResponse.json({ ok: true, ...summary }, { status: 200, headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: "The sweep did not finish; the next one carries on" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
