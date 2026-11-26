import { NextResponse } from "next/server";

import { isSameOrigin } from "../../../../../lib/admin-auth";
import { fixedRoomsEnabled } from "../../../../../lib/classroom-fixed-rooms";
import { personAndPlaceLimit } from "../../../../../lib/classroom-rate-limit";
import { classroomStatus } from "../../../../../lib/classroom-service";
import { classroomStore } from "../../../../../lib/classroom-store";
import { withRateLimitHeaders } from "../../../../../lib/rate-limit";
import { NO_STORE_HEADERS } from "../../../../../lib/response-headers";
import { roomChannelCaller } from "../../../../../lib/room-channel/caller";
import { roomChannel } from "../../../../../lib/room-channel/channel";
// @ts-ignore - the room channel's own code, plain JavaScript tested with node --test.
import { paceOfSite } from "../../../../../lib/room-channel/pace.mjs";
// @ts-ignore - the room channel's own code, plain JavaScript tested with node --test.
import { anyOn, roomChannelSwitches } from "../../../../../lib/room-channel/switches.mjs";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ lessonId: string }> };

// A request carries at most 16 things to send, each at most 8 KB (lib/room-channel/service.mjs,
// board.mjs); anything larger is not read further.
const BODY_MAX = 160_000;
// A page asks a few times a second while someone draws, and sends its own strokes in the same
// requests. Per minute: one person, and everyone behind one network address in this lesson (a
// class may share one). Working figures until the measurement settles them.
const PER_PERSON = 900;
const PER_PLACE = 9_000;

const plain = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

// The room channel of a fixed room's lesson (local integration only, 2026-11-23): the room's own
// whiteboard, public chat and share turn, each behind its own switch, all OFF unless set
// (lib/room-channel/switches.mjs). While none is on, or fixed rooms are off, this answers 404.
//
// One request is a person's whole exchange: what they send, then what is new for them after the
// places they have reached ({ key, cursors: { board, chat, turn }, send: [...] }). Who they are is
// decided from their personal key alone (the ticket their page got at the room's door), with the
// same check as entering the classroom, on every request; the body never says who is asking, and
// the chat has no field for a receiver. Same origin only; limited per person and per address.
export async function POST(request: Request, context: Context) {
  const on = roomChannelSwitches();
  if (!fixedRoomsEnabled() || !anyOn(on)) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403, headers: NO_STORE_HEADERS });
  const { lessonId } = await context.params;
  const text = await request.text().catch(() => "");
  if (text.length > BODY_MAX) return NextResponse.json({ error: "Too large", code: "TOO_LARGE" }, { status: 413, headers: NO_STORE_HEADERS });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!body) return NextResponse.json({ error: "Not a request", code: "NOT_AN_OBJECT" }, { status: 400, headers: NO_STORE_HEADERS });
  const key = typeof body.key === "string" ? body.key.slice(0, 200) : null;
  const decision = await personAndPlaceLimit(request, { scope: "classroom-room-channel", place: lessonId, person: key, perPerson: PER_PERSON, perPlace: PER_PLACE });
  if (decision.limited) return decision.response;
  const respond = (result: unknown, status: number) => withRateLimitHeaders(NextResponse.json(result, { status, headers: NO_STORE_HEADERS }), decision);
  try {
    const now = Date.now();
    const caller = await roomChannelCaller({ store: classroomStore(), lessonId, key, now, named: on.turn === true });
    if (!caller.ok) return respond({ error: caller.status === 404 ? "Not found" : "You are not in this classroom", code: caller.code }, caller.status);
    const result = await roomChannel().exchange({ lesson: caller.lesson, who: caller.who, on, cursors: plain(body.cursors), send: Array.isArray(body.send) ? body.send : [], now });
    // lessonStatus (2026-11-27): a page that asks for it ({ status: true }, every 15 seconds) gets
    // the lesson's status in this answer, exactly as the status route would answer this person now
    // ({ status, body }), so that it needs no request of its own for it. Only when asked: it reads
    // what the status route reads.
    const lessonStatus = body.status === true ? await classroomStatus({ store: classroomStore(), lessonId, key, sessionEmail: null, now }).then(({ status, body: said }) => ({ status, body: said }), () => ({ status: 503, body: { error: "The classroom is temporarily unavailable" } })) : null;
    // you: the person asking, as the room knows them (their place on the lesson's list), so a page
    // knows its own lines and its own turn. on: which parts this classroom offers now. people: with
    // the share turn, who is in the lesson now and the name the room shows for each (the turn can
    // be handed to one of them, and to nobody else). pace: how long a page waits before it asks
    // again and how far apart a pen's batches go (lib/room-channel/pace.mjs): said in every answer,
    // so the site can change it without a new page.
    return respond({ ...result, you: caller.who.id, on, pace: paceOfSite(), ...(caller.people ? { people: caller.people } : {}), ...(lessonStatus ? { lessonStatus } : {}) }, result.ok === true ? 200 : 400);
  } catch {
    return respond({ error: "The classroom is temporarily unavailable" }, 503);
  }
}
