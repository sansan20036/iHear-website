// The name a person types at a fixed room's door, as the iHear teacher sees it and Zoom shows it
// (the user, 2026-11-24 evening: Traditional Chinese, Simplified Chinese and English, after checking
// what the Zoom Video SDK really allows; until then only English letters were accepted and anything
// else showed the person's code). One rule for the server (the door, the read-back of the name it
// recorded) and the page (its second check before Zoom gets the name), so this file imports nothing.
//
// What Zoom Video SDK 2.6.0 does with the name given to client.join (its bundle and its docs, read
// 2026-11-24; real Zoom not yet tried with a Chinese name):
//   - refuses only a missing or empty name (5013); every character passes, none is changed;
//   - cuts a name longer than 200 UTF-16 units without a word, which can split an emoji or a rare
//     character in two;
//   - sends it as UTF-8, so Chinese arrives as typed; everyone in the session sees it (the list of
//     people, chat, the whiteboard's "Following" line and cursor labels, Zoom's own records).
// So the server, not Zoom, decides what a name may hold, and keeps it far below Zoom's cut.
//
// The rule (after RFC 8266, the nickname profile, and the "Latin + Han" set of Unicode UTS #39):
//   1. NFKC: full-width letters become ordinary ones, the ideographic and no-break spaces become an
//      ordinary space, look-alike radicals become the character they look like (⼈ -> 人);
//   2. ’ ‘ ʼ become ', the middle dots ・ ‧ • become · (約翰·史密斯);
//   3. refused, not quietly taken out: control and format characters (line breaks, tabs, the bidi
//      and zero-width ones), lone surrogates, private use, unassigned code points, combining marks;
//   4. spaces trimmed and runs of them made one;
//   5. only English letters, Chinese characters (Unified_Ideograph: both scripts, the rare ones too),
//      and between them a space, ., ' or · (". " as in "J. R. Smith"); it starts with a letter or a
//      Chinese character; digits, brackets, emoji and other scripts are refused, so nobody can type a
//      "（2）" the server adds or pass off a Cyrillic "К" as an English "K";
//   6. at most 40 columns, a Chinese character counting 2 (20 Chinese characters, or 40 letters, as
//      before), and at most 100 bytes of UTF-8.
// Traditional and Simplified are never folded together (陳 and 陈 are two names).
//
// A name is for showing only: never an identity, never a file name (a room's list of students keeps
// the file-name rule of lib/classroom-names.ts, for Drive).

export const NAME_COLUMNS_MAX = 40;
const NAME_BYTES_MAX = 100;
const SEPARATORS = " .'·";
// Built at run time: the site's TypeScript target (ES2017) predates \p{...} in a regular expression literal.
const HAN = new RegExp("\\p{Unified_Ideograph}", "u");
const REFUSED = new RegExp("[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{M}]", "u");
const SHAPE = new RegExp("^[A-Za-z\\p{Unified_Ideograph}][A-Za-z\\p{Unified_Ideograph} .'·]*$", "u");
// What the server adds to tell two people apart: " B" to " Z" after a name without Chinese,
// "（2）" to "（26）" after one with Chinese.
const LATIN_MARK = / [A-Z]$/;
const HAN_MARK = /（([2-9]|1[0-9]|2[0-6])）$/;

const columnsOf = (name: string) => Array.from(name).reduce((sum, char) => sum + (HAN.test(char) ? 2 : 1), 0);
const bytesOf = (name: string) => new TextEncoder().encode(name).length;

// Two separators together are refused, except ". " ("J. R. Smith").
function separatorsTogether(name: string) {
  const chars = Array.from(name);
  for (let i = 1; i < chars.length; i += 1) {
    if (SEPARATORS.includes(chars[i - 1]) && SEPARATORS.includes(chars[i]) && !(chars[i - 1] === "." && chars[i] === " ")) return true;
  }
  return false;
}

/** The typed name, made tidy, when the rule allows it; null when it does not. */
export function typedNameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const mapped = raw.normalize("NFKC").replace(/[’‘ʼ]/g, "'").replace(/[・‧•]/g, "·");
  if (REFUSED.test(mapped)) return null;
  const name = mapped.trim().replace(/ +/g, " ");
  if (!name || !SHAPE.test(name) || separatorsTogether(name)) return null;
  if (columnsOf(name) > NAME_COLUMNS_MAX || bytesOf(name) > NAME_BYTES_MAX) return null;
  return name;
}

export const hasChinese = (name: string) => HAN.test(name);

// Two names are the same name when they differ only in capitals and separators ("Kyle" and "kyle.",
// "王小明" and "王 小明"): the second person gets a mark, so the teacher can tell them apart.
const sameKey = (name: string) => name.toLowerCase().replace(/[ .'·]/g, "");

/** The name as shown: the typed one, or with a mark when someone present or waiting has it already; null when every mark is taken. */
export function distinctName(name: string, taken: readonly string[]): string | null {
  const used = new Set(taken.map(sameKey));
  if (!used.has(sameKey(name))) return name;
  const candidates = hasChinese(name)
    ? Array.from({ length: 25 }, (_, i) => `${name}（${i + 2}）`)
    : Array.from({ length: 25 }, (_, i) => `${name} ${String.fromCharCode(66 + i)}`);
  return candidates.find((candidate) => !used.has(sameKey(candidate))) ?? null;
}

/** Whether a name read back is still one the server could have made: a typed name, or one with the mark its script gets. */
export function shownNameIsSafe(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (typedNameOf(raw) === raw) return true;
  const han = HAN_MARK.exec(raw);
  const mark = han ?? LATIN_MARK.exec(raw);
  if (!mark) return false;
  const base = raw.slice(0, mark.index);
  return typedNameOf(base) === base && hasChinese(base) === Boolean(han);
}
