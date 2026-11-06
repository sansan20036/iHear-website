import entrySwitch from "../data/classroom-entry.json";

// The online classroom's release switch, as the server reads it (D2, 2026-11-07): the same file
// the build reads for the home page and header entries (scripts/classroom-entry.mjs).
export const CLASSROOM_ENTRY_RELEASED: boolean = entrySwitch.released === true;

export type ClassroomEntryAccess = { released: boolean; preview: boolean; signedIn: boolean };

// Who may see the classroom entries before they open to everyone: only staff the server itself
// confirms. That is an administrator (Auth.js's session callback marks them on every read) or the
// tutor of a lesson in the coming two weeks. A preview parameter in an address only asks; this
// decides, and says nothing else about the person.
export async function classroomEntryAccess(input: {
  released: boolean;
  email: string | null;
  isAdmin: boolean;
  isTutor: (email: string) => Promise<boolean>;
}): Promise<ClassroomEntryAccess> {
  const signedIn = Boolean(input.email);
  if (input.released) return { released: true, preview: false, signedIn };
  if (!input.email) return { released: false, preview: false, signedIn: false };
  if (input.isAdmin) return { released: false, preview: true, signedIn: true };
  try {
    return { released: false, preview: (await input.isTutor(input.email)) === true, signedIn: true };
  } catch {
    // The lessons could not be read: no tutor previews, and nothing more is said.
    return { released: false, preview: false, signedIn: true };
  }
}
