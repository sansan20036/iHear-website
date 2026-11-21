// Classroom 3.0 (2026-11-21): the rules for a first name a person types to enter a classroom, shared
// by the fixed rooms (lib/classroom-fixed-rooms.ts). Taken out of the permanent entry
// (lib/classroom-entry-door.ts on integration/classroom-3.0), unchanged, so the fixed rooms can be
// released without it. A name is for showing and file names only, never an identity check.

import { FILE_NAME_SAFE } from "../tools/recording-pathway/classroom/block-naming.mjs";

// The longest name a person types (FILE_NAME_SAFE allows 60; room is left for " B" and the like).
const NAME_MAX = 40;

// The first name as typed: spaces tidied; English letters first, then letters, spaces, . and '
// (the block's rule for names in Drive's file names: "-" and "_" separate a file name's parts).
export function entryNameOf(raw: unknown): string | null {
  const name = String(raw ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!name || name.length > NAME_MAX || !FILE_NAME_SAFE.test(name)) return null;
  return name;
}

// A second "Kyle" in the same place is shown as "Kyle B", a third "Kyle C" (letters only, as names
// in file names allow); the owner can tell them apart in their list.
export function distinctName(name: string, taken: readonly string[]): string | null {
  const used = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let letter = 66; letter <= 90; letter += 1) {
    const candidate = `${name} ${String.fromCharCode(letter)}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}
