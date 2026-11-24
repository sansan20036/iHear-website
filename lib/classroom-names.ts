// Classroom 3.0 (2026-11-21): the rules for a first name in a fixed room (lib/classroom-fixed-rooms.ts).
// Taken out of the permanent entry (lib/classroom-entry-door.ts on integration/classroom-3.0) so the
// fixed rooms can be released without it. A name is never an identity check.
//
// Round 16 (2026-11-24, the user: names in Traditional Chinese, Simplified Chinese and English): two
// rules now, because the two names go to different places.
//   - The name a person types at the door is for showing only (the teacher's list, Zoom, the room's
//     own chat): lib/classroom-display-names.ts, Chinese or English.
//   - A student's first name on a room's list (Gate B, the teacher types it) also names files in
//     Drive, so it keeps the files' rule: English letters (FILE_NAME_SAFE). Chinese there waits for its
//     own decision about file names.

import { FILE_NAME_SAFE } from "../tools/recording-pathway/classroom/block-naming.mjs";
import { distinctName, typedNameOf } from "./classroom-display-names";

export { distinctName };

// The longest name on a room's list (FILE_NAME_SAFE allows 60; room is left for " B" and the like).
const NAME_MAX = 40;

// The name typed at a fixed room's door: Chinese or English, see lib/classroom-display-names.ts.
export const entryNameOf = (raw: unknown): string | null => typedNameOf(raw);

// A student's first name on a room's list: spaces tidied; English letters first, then letters,
// spaces, . and ' (the block's rule for names in Drive's file names: "-" and "_" separate a file
// name's parts).
export function rosterNameOf(raw: unknown): string | null {
  const name = String(raw ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!name || name.length > NAME_MAX || !FILE_NAME_SAFE.test(name)) return null;
  return name;
}
