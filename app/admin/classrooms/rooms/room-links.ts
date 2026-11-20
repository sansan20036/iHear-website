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

// A room with somebody: let in, or waiting to be.
export const occupied = (room: { inRoom: readonly unknown[]; waiting: readonly unknown[] }) => room.inRoom.length > 0 || room.waiting.length > 0;

// The rooms to show: all of them or only those with somebody, narrowed by what was typed (any part
// of the name, capitals or not), in the natural order.
export function roomsToShow<Room extends { label: string; inRoom: readonly unknown[]; waiting: readonly unknown[] }>(rooms: readonly Room[], { onlyOccupied, search }: { onlyOccupied: boolean; search: string }): Room[] {
  const wanted = search.trim().toLowerCase().replace(/\s+/g, " ");
  return rooms.filter((room) => (!onlyOccupied || occupied(room)) && (!wanted || room.label.toLowerCase().includes(wanted))).sort(naturalByLabel);
}

// What the bulk form asks the server for: a run of numbers after a prefix (whole numbers from 1), or
// null when the form is not filled in right. The server checks everything again.
export function bulkRange(prefix: string, from: string, to: string): { prefix: string; from: number; to: number } | null {
  const first = Number(from), last = Number(to);
  if (!prefix.trim() || !/^\d{1,4}$/.test(from.trim()) || !/^\d{1,4}$/.test(to.trim())) return null;
  if (first < 1 || last < first) return null;
  return { prefix, from: first, to: last };
}
