// A personal lesson link pasted on /classroom (D2, 2026-11-07). It is read in the browser and never
// followed: the page goes only to a classroom on this site, an address it builds itself from the
// two checked parts. Nothing is sent anywhere, and the key never goes into a request address.

// The lesson IDs the room page accepts, and the keys the site issues (32 random bytes, base64url).
export const LESSON_ID_PATTERN = /^[A-Za-z0-9-]{1,36}$/;
export const JOIN_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LENGTH = 512;

export type StudentLink = { lessonId: string; key: string };

export function parseStudentLink(input: unknown, origin: string): StudentLink | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  // No spaces or backslashes inside: browsers quietly drop or turn them into something else.
  if (!text || text.length > MAX_LENGTH || /[\s\\\u0000-\u001f]/.test(text)) return null;
  let site: URL;
  try {
    site = new URL(origin);
  } catch {
    return null;
  }
  // Only this site's own address, or a path on it; never "//another.site" or another scheme.
  if (!text.startsWith("/classroom/") && !text.startsWith(`${site.origin}/classroom/`)) return null;
  let url: URL;
  try {
    url = new URL(text, site.origin);
  } catch {
    return null;
  }
  if (url.origin !== site.origin || url.username || url.password) return null;
  const lessonId = /^\/classroom\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!lessonId || !LESSON_ID_PATTERN.test(lessonId)) return null;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const keys = [...fragment.getAll("k"), ...url.searchParams.getAll("k")];
  const others = [...fragment.keys(), ...url.searchParams.keys()].filter(name => name !== "k");
  if (keys.length !== 1 || others.length || !JOIN_KEY_PATTERN.test(keys[0])) return null;
  return { lessonId, key: keys[0] };
}

// Where a checked link leads: this site's room, with the key behind # as the site issues it.
export const studentRoomPath = (link: StudentLink) => `/classroom/${link.lessonId}#k=${link.key}`;
