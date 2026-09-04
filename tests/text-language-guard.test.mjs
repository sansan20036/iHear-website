import { describe, expect, it } from "vitest";

import { hasRiskyEnglish, inspectChineseField, inspectEnglishSource } from "../assets/text-language-guard.js";

describe("text language guard", () => {
  it("warns when more than twenty percent of English-source letters are Han", () => {
    expect(inspectEnglishSource("This is English 中文中文").warning).toBe(true);
    expect(inspectEnglishSource("The USA").warning).toBe(false);
  });

  it("ignores URLs, email addresses, numbers and protected placeholders", () => {
    expect(inspectEnglishSource("Visit https://例子.example ⟦IH_abc_0⟧ 2026").warning).toBe(false);
  });

  it("warns about long Chinese fields without Han characters", () => {
    expect(inspectChineseField("This sentence was pasted into the wrong field.").missingHan).toBe(true);
    expect(inspectChineseField("iHear").missingHan).toBe(false);
    expect(inspectChineseField("這是一段繁體中文內容").missingHan).toBe(false);
  });

  it("detects common simplified Chinese that should offer conversion", () => {
    expect(inspectChineseField("开发服务器").likelySimplified).toBe(true);
    expect(inspectChineseField("開發伺服器").likelySimplified).toBe(false);
    expect(hasRiskyEnglish(["English", "整段中文內容"])).toBe(true);
  });
});
