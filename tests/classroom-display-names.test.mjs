import { describe, expect, test } from "vitest";

import { distinctName, NAME_COLUMNS_MAX, shownNameIsSafe, typedNameOf } from "../lib/classroom-display-names";
import { entryNameOf, rosterNameOf } from "../lib/classroom-names";

// Round 16 (2026-11-24, the user): a typed name in Traditional Chinese, Simplified Chinese or English,
// after checking Zoom Video SDK 2.6.0 (it refuses only an empty name and cuts at 200 UTF-16 units
// without a word; the rule keeps every name far below that). Real Zoom is not tried here.
describe("display names: Chinese and English (round 16)", () => {
  test("DN-1: English, Traditional and Simplified Chinese, mixed, and rare characters are taken as typed", () => {
    for (const name of ["Kyle", "Kyle B", "J. R. Smith", "O'Brien", "王小明", "王晓明", "陳大文", "陈大文", "陳 Amy", "陳Amy", "約翰·史密斯", "𠮷田", "小".repeat(20), "K".repeat(40)]) {
      expect(typedNameOf(name), name).toBe(name);
    }
  });

  test("DN-2: tidied the same way everywhere: NFKC (full-width letters, ideographic and no-break spaces, look-alike radicals), quotes and middle dots, spaces trimmed and made one", () => {
    expect(typedNameOf("  Ann  ")).toBe("Ann");
    expect(typedNameOf("Ｋｙｌｅ")).toBe("Kyle");
    expect(typedNameOf("　王　　小明 ")).toBe("王 小明");
    expect(typedNameOf("約翰・史密斯")).toBe("約翰·史密斯");
    expect(typedNameOf("約翰•史密斯")).toBe("約翰·史密斯");
    expect(typedNameOf("O’Brien")).toBe("O'Brien");
    expect(typedNameOf("⼈")).toBe("人");
  });

  test("DN-3: refused, never quietly changed: control, format, bidi and zero-width characters, lone surrogates, combining marks, other scripts, digits, brackets, emoji, a typed mark, two separators, too long", () => {
    const refused = [
      "", "   ", "1Kyle", "Kyle2", "Kyle_B", "Mary-Jane", "<img src=x>", "Kyle\u0000", "Kyle\nB", "Kyle\tB", "Ky\u200Ble", "\u202EelyK", "王\u2066小明",
      "e\u0301", "\u041Ayle", "\u039Ayle", "やまだ", "김민수", "ㄅㄆ", "Kyle😀", "王小明😀", "王小明（2）", "王小明(2)", "Kyle..", "Kyle .B", "Kyle ' B", "·王",
      "小".repeat(21), "K".repeat(41), "Kyle\uD83D", "\uD83DKyle", "〇", "々木", ".Kyle",
      // At a name's ends: trim() would quietly drop these; the rule refuses them instead.
      "Kyle\n", "\tKyle", "\uFEFFKyle", "王小明\r", "\u200EKyle", "Kyle\u2028",
    ];
    for (const name of refused) expect(typedNameOf(name), JSON.stringify(name)).toBeNull();
    for (const notText of [undefined, null, 42, {}, ["Kyle"]]) expect(typedNameOf(notText)).toBeNull();
  });

  test("DN-4: length is counted in columns (a Chinese character is 2), so 20 Chinese characters or 40 letters, and every name stays under 100 bytes", () => {
    expect(NAME_COLUMNS_MAX).toBe(40);
    expect(typedNameOf("王".repeat(19) + " A")).toBe("王".repeat(19) + " A");
    expect(typedNameOf("王".repeat(20) + " A")).toBeNull();
    // 20 of the rarest (4 bytes each in UTF-8) are 80 bytes: allowed, and far below Zoom's cut of 200 UTF-16 units.
    const rare = "𠮷".repeat(20);
    expect(typedNameOf(rare)).toBe(rare);
    expect(rare.length).toBe(40);
  });

  test("DN-5: the same name twice gets the server's mark: \" B\" to \" Z\" without Chinese, \"（2）\" to \"（26）\" with it; capitals and separators do not make a new name; Traditional and Simplified stay apart", () => {
    expect(distinctName("Kyle", [])).toBe("Kyle");
    expect(distinctName("Kyle", ["kyle"])).toBe("Kyle B");
    expect(distinctName("Kyle", ["Kyle", "Kyle B"])).toBe("Kyle C");
    expect(distinctName("kyle.", ["Kyle"])).toBe("kyle. B");
    expect(distinctName("王小明", ["王小明"])).toBe("王小明（2）");
    expect(distinctName("王小明", ["王小明", "王小明（2）"])).toBe("王小明（3）");
    expect(distinctName("王 小明", ["王小明"])).toBe("王 小明（2）");
    expect(distinctName("陈大文", ["陳大文"])).toBe("陈大文");
    expect(distinctName("陳 Amy", ["陳Amy"])).toBe("陳 Amy（2）");
    const allLatin = ["Kyle", ...Array.from({ length: 25 }, (_, i) => `Kyle ${String.fromCharCode(66 + i)}`)];
    expect(distinctName("Kyle", allLatin)).toBeNull();
    const allHan = ["王小明", ...Array.from({ length: 25 }, (_, i) => `王小明（${i + 2}）`)];
    expect(distinctName("王小明", allHan)).toBeNull();
  });

  test("DN-6: a name read back is safe only if the server could have made it: a typed name, or one with the mark of its own script", () => {
    for (const name of ["Kyle", "Kyle B", "K".repeat(40) + " Z", "王小明", "王小明（2）", "王小明（26）", "陳 Amy（2）", "王小明 B"]) expect(shownNameIsSafe(name), name).toBe(true);
    for (const name of ["王小明（1）", "王小明（27）", "王小明（02）", "Kyle（2）", "K".repeat(41) + " Z", "王小明（2）（3）", "<b>王</b>", "", "   ", undefined, 7]) {
      expect(shownNameIsSafe(name), JSON.stringify(name)).toBe(false);
    }
  });

  test("DN-7: the door takes the display rule; a room's list of students (names in Drive's file names) keeps English letters only", () => {
    expect(entryNameOf("王小明")).toBe("王小明");
    expect(entryNameOf(" Ｋｙｌｅ ")).toBe("Kyle");
    expect(rosterNameOf("Kyle")).toBe("Kyle");
    expect(rosterNameOf("王小明")).toBeNull();
    expect(rosterNameOf("陳 Amy")).toBeNull();
  });
});
