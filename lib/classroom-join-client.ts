// The classroom page's call to the protected join check (POST /api/classroom/<id>/join), used to
// enter and to reconnect. Reconnecting always asks again: the server checks the lesson, the
// roster, the person and the time window as it did at entry, and signs a new session token. The
// page never reuses the token it was given before; Zoom's lasts 30 minutes, a lesson up to 4 hours
// (R-1, 2026-11-06).

import type { ClassroomMediaAdapter, MediaRole } from "./classroom-media";

export type JoinedSession = { kind?: "sdk" | "embed"; token?: string; sessionName?: string; embedUrl?: string; recordingDisabled?: boolean; expiresAt: string };
export type JoinAnswer =
  | { ok: true; provider: string; lesson: { code: string; startsAt: string; endsAt: string }; role: MediaRole; participantCode: string; session: JoinedSession | null }
  | { ok: false; code: string };
export type RejoinResult = { ok: true; session: JoinedSession } | { ok: false; code: string };

// The same request as entering: the personal key when there is one, nothing the server decides
// (role, person, token). A refusal keeps the server's code for the page's message.
export async function requestJoin(lessonId: string, joinKey: string | null, fetcher: typeof fetch = fetch): Promise<JoinAnswer> {
  try {
    const response = await fetcher(`/api/classroom/${encodeURIComponent(lessonId)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(joinKey ? { key: joinKey } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.ok) {
      return { ok: true, provider: data.provider, lesson: data.lesson, role: data.role, participantCode: data.participantCode, session: data.session ?? null };
    }
    const code = response.status === 429 ? "RATE_LIMITED" : typeof data?.code === "string" ? data.code : "UNAVAILABLE";
    return { ok: false, code: code === "NOT_ON_ROSTER" && joinKey ? "NOT_ON_ROSTER_LINK" : code };
  } catch {
    return { ok: false, code: "UNAVAILABLE" };
  }
}

// One reconnect per room at a time: a second press while one is running gets the same result.
const rejoining = new WeakMap<ClassroomMediaAdapter, Promise<RejoinResult>>();

// Reconnecting the room: a new answer from the join check, then the room joined with its token.
// It never joins in place of someone else (the answer must name the same person and role), and an
// answer without a token is not joined (there is no older token to fall back on).
export function rejoinRoom(
  adapter: Pick<ClassroomMediaAdapter, "join">,
  ask: () => Promise<JoinAnswer>,
  room: { lessonCode: string; participantCode: string; role: MediaRole },
): Promise<RejoinResult> {
  const key = adapter as ClassroomMediaAdapter;
  const running = rejoining.get(key);
  if (running) return running;
  const attempt = (async (): Promise<RejoinResult> => {
    const answer = await ask();
    if (!answer.ok) return { ok: false, code: answer.code };
    if (answer.role !== room.role || answer.participantCode !== room.participantCode) return { ok: false, code: "IDENTITY_UNVERIFIED" };
    const session = answer.session;
    if (!session || !(session.token || session.embedUrl)) return { ok: false, code: "UNAVAILABLE" };
    try {
      await adapter.join({ sessionToken: session.token ?? "", sessionName: session.sessionName, embedUrl: session.embedUrl, ...room });
    } catch {
      // The adapter has told the page "failed"; the next press asks for a new token again.
      return { ok: false, code: "CONNECT_FAILED" };
    }
    return { ok: true, session };
  })().finally(() => rejoining.delete(key));
  rejoining.set(key, attempt);
  return attempt;
}
