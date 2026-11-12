import { describe, expect, test } from "vitest";

import { appendChat, CHAT_MAX_LENGTH, CHAT_MAX_LINES, chatNameOf, chatTextOf, handCommand, parseHandCommand } from "../lib/classroom-chat";

// In-class chat and raised hands (2026-11-12): the rules shared by the room page and its media
// adapters. Nothing here is saved anywhere; these are the checks on what a line or a hand may be.

const line = (id, extra = {}) => ({ id, from: "student", name: "TEST-S01", text: `line ${id}`, at: 1, ...extra });

describe("a chat line", () => {
  test("is trimmed, keeps line breaks, drops other control characters, and is cut at the maximum without splitting an emoji", () => {
    expect(chatTextOf("  hello  ")).toBe("hello");
    expect(chatTextOf("a\r\nb\rc")).toBe("a\nb\nc");
    expect(chatTextOf("a\u0000b\u0007c\u001bd\u007fe\tf")).toBe("abcdef");
    expect(chatTextOf("x".repeat(CHAT_MAX_LENGTH + 20))).toHaveLength(CHAT_MAX_LENGTH);
    const emoji = "😀".repeat(CHAT_MAX_LENGTH + 1);
    expect([...chatTextOf(emoji)]).toHaveLength(CHAT_MAX_LENGTH);
    expect(chatTextOf(emoji).endsWith("😀")).toBe(true);
  });

  test("with nothing left, or not text at all, is no line", () => {
    for (const value of ["", "   ", "\u0000\u0001", null, undefined, 42, {}, ["hi"]]) expect(chatTextOf(value)).toBeNull();
  });

  test("names are short plain strings, or nothing", () => {
    expect(chatNameOf(" TEST-S01 ")).toBe("TEST-S01");
    expect(chatNameOf("a\u0000b")).toBe("ab");
    expect(chatNameOf("n".repeat(80))).toHaveLength(40);
    for (const value of [null, undefined, 7, {}]) expect(chatNameOf(value)).toBe("");
  });

  test("the page shows each line once and keeps only the newest", () => {
    const one = appendChat([], line("a"));
    expect(one.map(item => item.id)).toEqual(["a"]);
    expect(appendChat(one, line("a", { text: "again" }))).toBe(one);
    let many = [];
    for (let index = 0; index < CHAT_MAX_LINES + 5; index += 1) many = appendChat(many, line(`n${index}`));
    expect(many).toHaveLength(CHAT_MAX_LINES);
    expect(many[0].id).toBe("n5");
    expect(many.at(-1).id).toBe(`n${CHAT_MAX_LINES + 4}`);
  });
});

describe("a raised hand on the command channel", () => {
  test("raising, lowering one's own, and the tutor lowering someone else's read back as sent", () => {
    for (const [sent, read] of [[handCommand(true), { hand: true }], [handCommand(false), { hand: false }], [handCommand(false, 16778240), { hand: false, for: 16778240 }]]) {
      expect(parseHandCommand(sent)).toEqual(read);
    }
    expect(JSON.parse(handCommand(false, 3))).toEqual({ ihear: 1, hand: false, for: 3 });
  });

  test("anything else on the channel is ignored: other messages, other shapes, extra fields, raising someone else's hand", () => {
    for (const text of [
      "hello", "", "null", "[]", "1", '{"hand":true}', '{"ihear":2,"hand":true}', '{"ihear":1,"hand":"yes"}',
      '{"ihear":1,"hand":true,"for":3}', '{"ihear":1,"hand":false,"for":-1}', '{"ihear":1,"hand":false,"for":1.5}', '{"ihear":1,"hand":false,"for":"3"}',
      '{"ihear":1,"hand":true,"extra":1}', '{"ihear":1,"hand":true,"__proto__":{"x":1}}', `{"ihear":1,"hand":true,"pad":"${"x".repeat(300)}"}`,
    ]) expect(parseHandCommand(text), text).toBeNull();
    for (const value of [null, undefined, 1, {}]) expect(parseHandCommand(value)).toBeNull();
  });
});
