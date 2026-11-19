// Classroom 2.0 (2026-11-12): what the room shows, decided from the media state alone (no page, no
// SDK), so the rules can be tested without a browser. The page (app/classroom/[lessonId]) draws it.

import type { RaisedHand } from "./classroom-chat";
import type { ConnectionState, DeviceKind, DeviceState, RoomPerson } from "./classroom-media";

// What fills the main stage: the people (nobody shares), the shared screen, the whiteboard, or the
// vendor's whole classroom page (LCIC). The whiteboard wins when both are on.
export type StageMode = "people" | "share" | "board" | "embed";

export function stageModeOf(provider: string, share: string, whiteboard: string): StageMode {
  if (provider === "tencent-lcic") return "embed";
  if (whiteboard !== "none") return "board";
  if (share !== "none") return "share";
  return "people";
}

// How long a raised hand is told on top of the stage before it folds into the counts (the
// participants button and the list keep it until the hand is lowered).
export const HAND_NOTICE_MS = 4_500;

// The hands raised since the last list: each is told once. A page's own hand is never told to it.
export function newHands(before: readonly RaisedHand[], now: readonly RaisedHand[]): RaisedHand[] {
  const known = new Set(before.map((hand) => hand.id));
  return now.filter((hand) => !hand.self && !known.has(hand.id));
}

// The order of the tiles and of the participants list: the tutor first, then raised hands in the
// order they went up, then everyone else by code, and this page's own person last.
export function orderPeople(people: readonly RoomPerson[], hands: readonly RaisedHand[] = []): RoomPerson[] {
  const raised = new Map(hands.map((hand, index) => [hand.id, index]));
  const rank = (person: RoomPerson) => (person.self ? 3 : person.host ? 0 : raised.has(person.id) ? 1 : 2);
  return [...people].sort((a, b) =>
    rank(a) - rank(b)
    || (raised.get(a.id) ?? 0) - (raised.get(b.id) ?? 0)
    || a.name.localeCompare(b.name, "en")
    || a.id.localeCompare(b.id, "en"));
}

// "Tutor TEST-T01" / "Student TEST-S01": the role in the page's language and the participant code
// (never a name). The test room does not know the other person's code; then only the role shows.
export function personLabel(person: RoomPerson, words: { tutor: string; student: string }): string {
  const role = person.host ? words.tutor : words.student;
  return person.name ? `${role} ${person.name}` : role;
}

// The short mark on a tile without video: the end of the code ("TEST-S01" → "S01"), else the role's
// first letter.
export function initialsOf(person: RoomPerson, words: { tutor: string; student: string }): string {
  const tail = person.name.split("-").pop()?.trim() ?? "";
  if (tail) return tail.slice(0, 3).toUpperCase();
  return [...(person.host ? words.tutor : words.student)][0] ?? "?";
}

// A person to enlarge on this page only: kept while they are here, dropped when they leave.
export function spotlightOf(current: string | null, people: readonly RoomPerson[]): string | null {
  return current && people.some((person) => person.id === current) ? current : null;
}

// After a reconnect (2026-11-20): joining again starts with the camera and microphone off (Zoom's
// client is released and a new one joins), and the one-to-one room said nothing; with the automatic
// reconnect the failure shows for only a few seconds, so the person may not notice they are muted.
// The room follows its connection: "lost" once a connected room is no longer connected (Zoom's own
// reconnect, a failure, a move to another room), "back" when it is connected again after that.
export function connectionStep(lost: boolean, before: ConnectionState, now: ConnectionState): { lost: boolean; back: boolean } {
  if (now === "connected") return { lost: false, back: lost };
  return { lost: lost || before === "connected", back: false };
}

// What to offer to turn on again once back: what the person had turned on with their own presses
// and is off now. A blocked or failed device is not offered (it has its own help and its own "Try
// again"); one starting or on needs nothing. The microphone comes first: its sound needs the press.
export function devicesToOffer(wanted: Readonly<Record<DeviceKind, boolean>> | null, devices: Readonly<Record<DeviceKind, DeviceState>>): DeviceKind[] {
  if (!wanted) return [];
  return (["microphone", "camera"] as const).filter((kind) => wanted[kind] && devices[kind] === "off");
}
