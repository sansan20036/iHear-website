// The Classroom 2.0 lobby's rules (2026-11-13): how the pre-class screen and /classroom describe a
// lesson's door as time passes, the lesson's time in the visitor's own time zone and in Taipei's,
// which of a tutor's lessons comes next, and what a refused device check means. No network, no
// storage: the server stays the one that decides at the door (POST /api/classroom/<id>/join).

export type DoorState = "before" | "open" | "ended" | "cancelled";
// While the door is open: before the lesson starts, during it, or in the minutes after it ends.
export type OpenStage = "early" | "live" | "overtime";

export type LessonTimes = { startsAt: string; endsAt: string; opensAt: string; closesAt: string };

// The door now, from the times the server gave. The server's own state wins for a cancelled lesson
// (it never reopens) and for one that ended; otherwise the page follows the clock, so a student
// who is early sees the door open without reloading, and the entry check decides at the door.
export function doorAt(times: LessonTimes, serverState: DoorState, now: number): { state: DoorState; stage: OpenStage | null; msToOpen: number; msToStart: number; msToClose: number } {
  const opens = Date.parse(times.opensAt), starts = Date.parse(times.startsAt), ends = Date.parse(times.endsAt), closes = Date.parse(times.closesAt);
  const base = { msToOpen: Math.max(0, opens - now), msToStart: Math.max(0, starts - now), msToClose: Math.max(0, closes - now) };
  if (serverState === "cancelled") return { state: "cancelled", stage: null, ...base };
  if (serverState === "ended" || now > closes) return { state: "ended", stage: null, ...base };
  if (now < opens) return { state: "before", stage: null, ...base };
  return { state: "open", stage: now < starts ? "early" : now <= ends ? "live" : "overtime", ...base };
}

// A wait in whole days, hours and minutes, rounded up to the minute ("in 1 minute" until it is time).
export function waitParts(ms: number) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60, totalMinutes: minutes };
}

export type ZonedTimes = { date: string; range: string; zone: string };

// The lesson's date and time in one time zone, with the zone's short name ("GMT+8", "EST"...).
export function zonedTimes(intlLocale: string, timeZone: string, startsAt: string, endsAt: string): ZonedTimes {
  const start = new Date(startsAt), end = new Date(endsAt);
  const date = new Intl.DateTimeFormat(intlLocale, { timeZone, year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(start);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const zone = new Intl.DateTimeFormat(intlLocale, { timeZone, timeZoneName: "short" }).formatToParts(start).find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  return { date, range: `${clock.format(start)}–${clock.format(end)}`, zone };
}

// Whether the visitor's clock reads the lesson's times as Taipei's does (so one line is enough).
export function sameWallClock(timeZone: string, startsAt: string, endsAt: string) {
  const read = (zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return [startsAt, endsAt].every((iso) => read(timeZone).format(new Date(iso)) === read("Asia/Taipei").format(new Date(iso)));
}

// The visitor's own time zone, if the browser says; otherwise Taipei's.
export function viewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei";
  } catch {
    return "Asia/Taipei";
  }
}

export type TutorLesson = { lessonId: string; code: string; startsAt: string; endsAt: string; opensAt: string; closesAt: string; state: DoorState };

// The lesson a tutor needs next: one whose door is open now (the earliest), else the next to open.
// Ended and cancelled lessons never come next.
export function nextLessonOf<T extends TutorLesson>(lessons: readonly T[], now: number): T | null {
  const live = lessons.filter((lesson) => doorAt(lesson, lesson.state, now).state === "open").sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  if (live.length) return live[0];
  const coming = lessons.filter((lesson) => doorAt(lesson, lesson.state, now).state === "before").sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt));
  return coming[0] ?? null;
}

// The pre-class screen's reading of POST /api/classroom/<id>/preview (lib/classroom-preview.ts).
// Only definite answers from the server change what the screen offers: the lesson does not exist,
// this link or sign-in is not on its roster, or the classroom is closed. Anything else (a slow
// network, a rate limit, a lesson entered through its block) leaves the door to the entry check.
export type PreviewData = {
  ok: true; lesson: LessonTimes & { code: string }; state: DoorState; role: "tutor" | "student"; participantCode: string;
  with?: { role: "tutor" | "student"; codes: string[] };
};
export type PreviewView = { kind: "loading" } | { kind: "ready"; data: PreviewData } | { kind: "refused"; code: string } | { kind: "unknown"; quiet?: boolean };

export function previewViewOf(status: number, data: unknown, hasKey: boolean): PreviewView {
  const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const lesson = body.lesson as Record<string, unknown> | undefined;
  const times = lesson && ["code", "startsAt", "endsAt", "opensAt", "closesAt"].every((name) => typeof lesson[name] === "string");
  if (status === 200 && body.ok === true && times && ["before", "open", "ended", "cancelled"].includes(String(body.state))
    && (body.role === "tutor" || body.role === "student") && typeof body.participantCode === "string"
    && (body.with === undefined || (typeof body.with === "object" && body.with !== null && Array.isArray((body.with as { codes?: unknown }).codes)))) {
    return { kind: "ready", data: body as unknown as PreviewData };
  }
  const code = typeof body.code === "string" ? body.code : "";
  if (status === 404 && code === "LESSON_NOT_FOUND") return { kind: "refused", code };
  if (status === 403 && code === "NOT_ON_ROSTER") return { kind: "refused", code: hasKey ? "NOT_ON_ROSTER_LINK" : "NOT_ON_ROSTER" };
  if (status === 503 && code === "PROVIDER_UNAVAILABLE") return { kind: "refused", code };
  // A block's Lobby or room: entered through its block; at this address the entry check decides.
  if (status === 409 && code === "BLOCK_LESSON") return { kind: "unknown", quiet: true };
  return { kind: "unknown" };
}

// What went wrong when a device check asked the browser for the camera or the microphone.
export type DeviceCheckProblem = "denied" | "missing" | "busy" | "unsupported" | "error";
export function deviceProblemOf(error: unknown): DeviceCheckProblem {
  const name = typeof error === "object" && error && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "missing";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  if (name === "TypeError" || name === "NotSupportedError") return "unsupported";
  return "error";
}

// Whether this browser has what the classroom needs: a secure page, camera and microphone access,
// WebRTC and WebAssembly (the video service's web SDK runs on both).
export function browserReadiness(env: { isSecureContext?: boolean; mediaDevices?: unknown; RTCPeerConnection?: unknown; WebAssembly?: unknown }) {
  const missing: string[] = [];
  if (env.isSecureContext === false) missing.push("secure");
  if (!env.mediaDevices) missing.push("media");
  if (!env.RTCPeerConnection) missing.push("webrtc");
  if (!env.WebAssembly) missing.push("wasm");
  return { ready: missing.length === 0, missing };
}

// The loudness of a short stretch of microphone samples (time-domain bytes around 128), from 0 to 1.
export function levelOf(samples: ArrayLike<number>) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = (samples[index] - 128) / 128;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}
