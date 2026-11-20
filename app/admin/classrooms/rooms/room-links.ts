// Classroom 3.0 round 3 (2026-11-21): small pure helpers of the fixed rooms' admin page, for an owner
// with many rooms (the iHear teacher asked for 100, named Room1, Room2, …). The list of links becomes
// a CSV file in the browser only: it is never sent back to the server, stored or logged.

export type LinkRow = { label: string; link: string };

// Room2 before Room10: a number inside a name counts as a number.
export const naturalByLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" });

// One line per room: its name and its whole address, in the rooms' natural order. A room's name
// starts with a letter or a digit and an address with "http" (the server's rules), so no cell can be
// read as a formula; every cell is quoted all the same.
export function linksCsv(origin: string, rows: readonly LinkRow[]): string {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [...rows].sort(naturalByLabel).map((row) => `${cell(row.label)},${cell(`${origin}${row.link}`)}`);
  return `${["Room,Link", ...lines].join("\r\n")}\r\n`;
}

// The server gives new links for at most this many rooms at a time (BULK_MAX in
// lib/classroom-fixed-rooms.ts); the page asks for more in parts.
export const EXPORT_AT_ONCE = 100;
export function chunks<Item>(items: readonly Item[], size: number): Item[][] {
  const parts: Item[][] = [];
  for (let start = 0; start < items.length; start += Math.max(1, Math.floor(size))) parts.push(items.slice(start, start + Math.max(1, Math.floor(size))));
  return parts;
}

// A link the server gave for one room, with the link's version (its generation): the server keeps
// only each link's hash, so this is the only copy there is.
export type MadeLink = { room: string; label: string; link: string; generation: number };
// One answer as the page got it. status: the HTTP status (0 or missing: no status known).
export type PartAnswer = { ok: boolean; status?: number; data: Record<string, unknown> };

// What one answer says, before anything is looked at again (Classroom 3.0 round 4, 2026-11-21):
// - "answered": the server says what it did for each room it was asked about;
// - "refused": refused whole before anything was changed: a 4xx that carries the server's own code
//   (every bulk refusal is decided before the first change; so are sign-in and rate limits);
// - "unknown": no answer at all (the connection dropped, a time-out), a server error, or an answer
//   that cannot be read. The server may have changed some of these rooms anyway, and their new
//   links are then lost: only a look at the rooms afterwards (linkStates) tells which. Never
//   treated as "not done", never retried by itself.
export function partOutcome(answer: PartAnswer | null, listed: "links" | "rooms" | "changed"): "answered" | "refused" | "unknown" {
  if (!answer) return "unknown";
  if (answer.ok) return Array.isArray(answer.data?.[listed]) ? "answered" : "unknown";
  const status = Number(answer.status ?? 0);
  return status >= 400 && status < 500 && typeof answer.data?.code === "string" ? "refused" : "unknown";
}

export type ExportResult = {
  made: MadeLink[];
  // Rooms whose links this run did not change: the server said so, its part was refused whole, or
  // their part was never sent because the run stopped before it.
  notChanged: string[];
  // Rooms of a part whose outcome is not known.
  unknown: string[];
  problem: { kind: "refused"; data: Record<string, unknown> } | { kind: "unknown" } | null;
};

const listed = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]).filter((entry) => entry !== null && typeof entry === "object") : []);

// Every room's link anew, in parts the server takes. The run stops at the first part that is
// refused or whose outcome is not known (the parts after it are not sent: a person decides what
// next, never this loop). The links of the parts done before are always given back, because they
// exist nowhere else. A room is only ever taken from the answer about its own part, by its id.
// Never throws.
export async function exportInParts<Room extends { id: string; label: string }>(rooms: readonly Room[], sendPart: (ids: string[]) => Promise<PartAnswer>, size: number = EXPORT_AT_ONCE): Promise<ExportResult> {
  const made: MadeLink[] = [];
  const notChanged: string[] = [];
  const unknown: string[] = [];
  const parts = chunks(rooms, size);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const later = parts.slice(index + 1).flat().map((room) => room.label);
    let answer: PartAnswer | null = null;
    try { answer = await sendPart(part.map((room) => room.id)); } catch { answer = null; }
    const outcome = partOutcome(answer, "links");
    if (outcome === "refused") {
      notChanged.push(...part.map((room) => room.label), ...later);
      return { made, notChanged, unknown, problem: { kind: "refused", data: answer?.data ?? {} } };
    }
    if (outcome === "unknown") {
      unknown.push(...part.map((room) => room.label));
      notChanged.push(...later);
      return { made, notChanged, unknown, problem: { kind: "unknown" } };
    }
    const mine = new Map(part.map((room) => [room.id, room]));
    const seen = new Set<string>();
    for (const entry of listed(answer!.data.links)) {
      const room = mine.get(String(entry.room));
      const generation = Number(entry.generation);
      if (!room || seen.has(room.id) || typeof entry.link !== "string" || !Number.isInteger(generation) || generation < 1) continue;
      made.push({ room: room.id, label: room.label, link: entry.link, generation });
      seen.add(room.id);
    }
    const note = (entries: unknown, into: string[]) => {
      for (const entry of listed(entries)) {
        const room = mine.get(String(entry.room));
        if (room && !seen.has(room.id)) { into.push(room.label); seen.add(room.id); }
      }
    };
    note(answer!.data.failed, notChanged);
    note(answer!.data.notAttempted, notChanged);
    note(answer!.data.unknown, unknown);
    // A room of this part the answer does not account for: its outcome is not known.
    for (const room of part) if (!seen.has(room.id)) unknown.push(room.label);
    if (unknown.length) {
      notChanged.push(...later);
      return { made, notChanged, unknown, problem: { kind: "unknown" } };
    }
  }
  return { made, notChanged, unknown, problem: null };
}

// Where each room asked about stands, once the rooms have been read again from the server: what
// was received is compared with each link's version now, and with the version before the run.
// - "done": the link received is the room's link now;
// - "replacedAgain": a link was received, but the room's link has been replaced since: it no
//   longer works and is left out of the list;
// - "lost": the room's link was replaced (by this run or anyone) and its new link was never
//   received: the link handed out before no longer works;
// - "unchanged": the room's link is the one it had before the run: that link still works;
// - "notCreated": asked to be made, and there is no such room;
// - "unknown": the rooms could not be read again (current is null), or what was read makes no sense.
export type RoomLinkState = "done" | "replacedAgain" | "lost" | "unchanged" | "notCreated" | "unknown";
const keyOf = (label: string) => label.toLowerCase();
export function linkStates({ asked, baseline, made, current }: {
  asked: readonly string[];
  baseline: Readonly<Record<string, number>>;
  made: Readonly<Record<string, MadeLink>>;
  current: Readonly<Record<string, number>> | null;
}): Record<string, RoomLinkState> {
  const states: Record<string, RoomLinkState> = {};
  for (const label of asked) {
    const key = keyOf(label);
    const got = made[key];
    if (!current) { states[key] = got ? "done" : "unknown"; continue; }
    const now = current[key];
    if (now === undefined) { states[key] = got || baseline[key] !== undefined ? "unknown" : "notCreated"; continue; }
    if (got) { states[key] = got.generation === now ? "done" : got.generation < now ? "replacedAgain" : "unknown"; continue; }
    const before = baseline[key] ?? 0;
    states[key] = now > before ? "lost" : now === before ? "unchanged" : "unknown";
  }
  return states;
}

// Label (lower case) → link version, from the rooms as the server lists them.
export const generationsOf = (rooms: readonly { label: string; linkGeneration: number }[]) => Object.fromEntries(rooms.map((room) => [keyOf(room.label), room.linkGeneration]));

// The links received so far with the new ones added: per room, the newest link wins.
export function mergeMade(old: Readonly<Record<string, MadeLink>>, added: readonly MadeLink[]): Record<string, MadeLink> {
  const merged: Record<string, MadeLink> = { ...old };
  for (const entry of added) {
    const key = keyOf(entry.label);
    if (!merged[key] || merged[key].generation < entry.generation) merged[key] = entry;
  }
  return merged;
}

// The list to download: only the links that are the rooms' links now ("done"; before the rooms
// could be read again, the links received), in the natural order.
export function rowsToExport(made: Readonly<Record<string, MadeLink>>, states: Readonly<Record<string, RoomLinkState>>): LinkRow[] {
  return Object.entries(made).filter(([key]) => states[key] === "done").map(([, entry]) => ({ label: entry.label, link: entry.link })).sort(naturalByLabel);
}

// The rooms asked about, by where they stand, in the natural order; complete only when every one is done.
export function summaryOf(asked: readonly string[], states: Readonly<Record<string, RoomLinkState>>) {
  const by = (state: RoomLinkState) => asked.filter((label) => states[keyOf(label)] === state).sort((a, b) => naturalByLabel({ label: a }, { label: b }));
  const done = by("done");
  return { done, replacedAgain: by("replacedAgain"), lost: by("lost"), unchanged: by("unchanged"), notCreated: by("notCreated"), unknown: by("unknown"), complete: asked.length > 0 && done.length === asked.length };
}

// A room with somebody: let in, or waiting to be.
export const occupied = (room: { inRoom: readonly unknown[]; waiting: readonly unknown[] }) => room.inRoom.length > 0 || room.waiting.length > 0;

// The rooms to show: all of them or only those with somebody, narrowed by what was typed (any part
// of the name, capitals or not), in the natural order.
export function roomsToShow<Room extends { label: string; inRoom: readonly unknown[]; waiting: readonly unknown[] }>(rooms: readonly Room[], { onlyOccupied, search }: { onlyOccupied: boolean; search: string }): Room[] {
  const wanted = search.trim().toLowerCase().replace(/\s+/g, " ");
  return rooms.filter((room) => (!onlyOccupied || occupied(room)) && (!wanted || room.label.toLowerCase().includes(wanted))).sort(naturalByLabel);
}

// A name as the server keeps it (the same tidying as lib/classroom-fixed-rooms.ts cleanLabel), so
// the page can tell afterwards which of the rooms it asked for exist.
export const labelOf = (label: string) => label.normalize("NFC").trim().replace(/\s+/g, " ");
export const labelsOfRange = ({ prefix, from, to }: { prefix: string; from: number; to: number }) => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => labelOf(`${prefix}${from + index}`));

// What the bulk form asks the server for: a run of numbers after a prefix (whole numbers from 1), or
// null when the form is not filled in right. The server checks everything again.
export function bulkRange(prefix: string, from: string, to: string): { prefix: string; from: number; to: number } | null {
  const first = Number(from), last = Number(to);
  if (!prefix.trim() || !/^\d{1,4}$/.test(from.trim()) || !/^\d{1,4}$/.test(to.trim())) return null;
  if (first < 1 || last < first) return null;
  return { prefix, from: first, to: last };
}
