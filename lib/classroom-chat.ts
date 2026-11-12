// In-class chat and raised hands (2026-11-12): the rules the room page and its media adapters share,
// kept apart so they are tested without a browser.
//
// Nothing here is saved anywhere (the owner's decision: chat is not kept). Chat lines and raised
// hands live in the open room page only and go when it is left; the server never sees them.
// A raised hand travels as a small message on Zoom's command channel, and only the tutor (the
// session's host) may lower someone else's hand.

export const CHAT_MAX_LENGTH = 500;
// The lines a page keeps on screen; older ones drop off.
export const CHAT_MAX_LINES = 200;
// The longest name shown (names in the room are participant codes, never students' names).
const NAME_MAX_LENGTH = 40;

export type ChatFrom = "self" | "tutor" | "student";
export type ChatLine = { id: string; from: ChatFrom; name: string; text: string; at: number };
export type RaisedHand = { id: string; name: string; self: boolean };

// A message as it may be sent or shown: line breaks kept, other control characters dropped,
// trimmed, and cut at CHAT_MAX_LENGTH characters (never inside an emoji). Null when nothing is left.
export function chatTextOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
  if (!text) return null;
  return [...text].slice(0, CHAT_MAX_LENGTH).join("");
}

// A name to show beside a line or a hand: a short plain string, or nothing.
export function chatNameOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\u0000-\u001F\u007F]/g, "").trim()].slice(0, NAME_MAX_LENGTH).join("");
}

// The page's lines with one more: a line already shown is not shown twice, and only the newest
// CHAT_MAX_LINES stay.
export function appendChat(lines: readonly ChatLine[], line: ChatLine, max = CHAT_MAX_LINES): readonly ChatLine[] {
  if (lines.some(item => item.id === line.id)) return lines;
  const next = [...lines, line];
  return next.length > max ? next.slice(next.length - max) : next;
}

// A raised hand on the command channel: {"ihear":1,"hand":true} raises the sender's own hand,
// {"ihear":1,"hand":false} lowers it, and {"ihear":1,"hand":false,"for":<Zoom user id>} lowers
// another person's (the receiving pages accept that only from the host).
export type HandCommand = { hand: boolean; for?: number };

export function handCommand(up: boolean, forUser?: number): string {
  return JSON.stringify(forUser === undefined ? { ihear: 1, hand: up } : { ihear: 1, hand: false, for: forUser });
}

// Anything else on the channel, or anything malformed, is not ours and is ignored.
export function parseHandCommand(text: unknown): HandCommand | null {
  if (typeof text !== "string" || text.length > 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { ihear, hand, for: target, ...rest } = value as Record<string, unknown>;
  if (ihear !== 1 || typeof hand !== "boolean" || Object.keys(rest).length > 0) return null;
  if (target === undefined) return { hand };
  // Only a lowering may name someone else.
  if (hand || typeof target !== "number" || !Number.isSafeInteger(target) || target < 0) return null;
  return { hand: false, for: target };
}
