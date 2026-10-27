import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

import { academyFieldRegistry } from "../scripts/generate-academy-fields.mjs";
import { migrationChecksum } from "../scripts/migration-checksum.mjs";
import {
  ACADEMY_CONTENT_MAX_CHARACTERS,
  ACADEMY_PRICE_LIMITS,
  P0_ACADEMY_RATES,
  academyFields,
  academyPackagePrice,
  academyPackageSaving,
  defaultAcademyContent,
  parseAcademyContentConfig,
  readStoredAcademyContent,
} from "../lib/academy-content-types";
import { academyChangedFields } from "../lib/academy-content-store";

const clone = value => structuredClone(value);
function rejection(value, parse = parseAcademyContentConfig) {
  try { parse(value); } catch (error) { return { field: error.field, code: error.code, status: error.status }; }
  throw new Error("expected the document to be rejected");
}

describe("Academy field registry", () => {
  test("data/academy-fields.json matches the course templates exactly", async () => {
    const generated = await academyFieldRegistry(process.cwd());
    expect(JSON.parse(await readFile("data/academy-fields.json", "utf8"))).toEqual(generated);
  });

  test("each page keeps its own field list, defaults and the pricing FAQ split", () => {
    expect(academyFields("en")).toHaveLength(137);
    expect(academyFields("zhHant")).toHaveLength(132);
    for (const locale of ["en", "zhHant"]) {
      const ids = academyFields(locale).map(field => field.id);
      expect(ids).toEqual(expect.arrayContaining(["pricing.card.tutor.highschool", "pricing.card.tutor.college", "faq.item7.answerLead", "faq.item7.answerNote"]));
      expect(ids).not.toContain("faq.item7.answer");
      // The inquiry form replaced the mailto card: its text, fields and privacy notice must match
      // the code, so none is editable. The paragraph beside it is a new field, so the text
      // published for the old mailto version (start.body) does not hide the new wording.
      expect(ids).toContain("start.formBody");
      expect(ids.filter(id => id === "start.body" || id.startsWith("start.inquiry."))).toEqual([]);
      for (const field of academyFields(locale)) expect(field.default.length).toBeGreaterThan(0);
    }
    expect(academyFields("en").find(field => field.id === "subjects.title")).toMatchObject({ kind: "multiline", default: "Your goal.\nOur starting point." });
    expect(academyFields("zhHant").find(field => field.id === "pricing.card.tutor.college")).toMatchObject({ kind: "single", default: "大學生導師" });
  });
});

describe("Academy price model", () => {
  test("the eight P0 single-session prices and their ten-session prices", () => {
    expect(P0_ACADEMY_RATES).toEqual({
      TWD: { 45: { highschool: 800, college: 1000 }, 60: { highschool: 1000, college: 1400 } },
      USD: { 45: { highschool: 25, college: 34 }, 60: { highschool: 34, college: 45 } },
    });
    const packages = { TWD: { 45: [7200, 9000], 60: [9000, 12600] }, USD: { 45: [225, 306], 60: [306, 405] } };
    for (const [currency, durations] of Object.entries(packages)) {
      for (const [duration, [highschool, college]] of Object.entries(durations)) {
        expect(academyPackagePrice(P0_ACADEMY_RATES[currency][duration].highschool)).toBe(highschool);
        expect(academyPackagePrice(P0_ACADEMY_RATES[currency][duration].college)).toBe(college);
      }
    }
    expect(academyPackageSaving(1400)).toBe(1400);
  });

  test("every whole-number price gives a whole-number ten-session price (no rounding)", () => {
    for (let rate = 1; rate <= 5000; rate++) expect(Number.isInteger(academyPackagePrice(rate))).toBe(true);
    expect(academyPackagePrice(ACADEMY_PRICE_LIMITS.TWD.max)).toBe(900_000);
  });

  test.each([
    ["a decimal", 34.5, "price_not_whole"],
    ["a negative price", -1, "price_range"],
    ["zero", 0, "price_range"],
    ["NaN", Number.NaN, "price_not_whole"],
    ["infinity", Number.POSITIVE_INFINITY, "price_not_whole"],
    ["a numeric string", "34", "price_not_whole"],
    ["an empty value", null, "price_not_whole"],
    ["more than the US$ maximum", 5001, "price_range"],
  ])("rejects %s", (_name, value, code) => {
    const config = defaultAcademyContent();
    config.pricing.rates.USD["60"].college = value;
    expect(rejection(config)).toMatchObject({ field: "pricing.rates.USD.60.college", code });
  });

  test("accepts each currency's range limits and keeps NT$ and US$ independent", () => {
    const config = defaultAcademyContent();
    config.pricing.rates.TWD["45"].highschool = ACADEMY_PRICE_LIMITS.TWD.max;
    config.pricing.rates.USD["45"].highschool = ACADEMY_PRICE_LIMITS.USD.min;
    const parsed = parseAcademyContentConfig(config);
    expect(parsed.pricing.rates.TWD["45"].highschool).toBe(100_000);
    expect(parsed.pricing.rates.USD["45"].highschool).toBe(1);
    expect(parsed.pricing.rates.TWD["60"].college).toBe(1400);
    config.pricing.rates.TWD["45"].highschool = ACADEMY_PRICE_LIMITS.TWD.max + 1;
    expect(rejection(config)).toMatchObject({ code: "price_range" });
  });

  test("prices, durations, tutors and currencies cannot be added or removed", () => {
    const extra = defaultAcademyContent();
    extra.pricing.rates.TWD["90"] = { highschool: 1, college: 1 };
    expect(rejection(extra)).toMatchObject({ field: "pricing.rates.TWD.90", code: "unsupported_field" });
    const missing = defaultAcademyContent();
    delete missing.pricing.rates.USD["45"].college;
    expect(rejection(missing)).toMatchObject({ field: "pricing.rates.USD.45.college", code: "missing_field" });
    const currency = defaultAcademyContent();
    currency.pricing.rates.EUR = clone(currency.pricing.rates.USD);
    expect(rejection(currency)).toMatchObject({ code: "unsupported_field" });
  });
});

describe("Academy page text", () => {
  test("defaults validate and round-trip", () => {
    const config = defaultAcademyContent();
    expect(parseAcademyContentConfig(config)).toEqual(config);
    expect(readStoredAcademyContent(config)).toEqual(config);
  });

  test.each([
    ["an empty value", "hero.eyebrow", "   ", "required"],
    ["a line break in a one-line field", "hero.cta", "Find\nyour tutor", "single_line"],
    ["a NUL character", "hero.lead", "A\u0000B", "unsupported_character"],
    ["a lone surrogate", "hero.lead", "A\ud800B", "unsupported_character"],
    ["a non-string value", "hero.lead", 42, "not_text"],
    ["text over the limit", "hero.cta", "x".repeat(201), "too_long"],
  ])("rejects %s", (_name, id, value, code) => {
    const config = defaultAcademyContent();
    config.content.en[id] = value;
    expect(rejection(config)).toMatchObject({ field: `content.en.${id}`, code });
  });

  test("normalizes line endings and outer spaces but keeps meaningful line breaks", () => {
    const config = defaultAcademyContent();
    config.content.zhHant["subjects.title"] = "  第一行  \r\n第二行\t ";
    expect(parseAcademyContentConfig(config).content.zhHant["subjects.title"]).toBe("第一行\n第二行");
  });

  test("markup is stored as plain text, never interpreted", () => {
    const config = defaultAcademyContent();
    config.content.en["hero.lead"] = '<script>alert("x")</script> & <b>bold</b>';
    expect(parseAcademyContentConfig(config).content.en["hero.lead"]).toBe('<script>alert("x")</script> & <b>bold</b>');
  });

  test("a submitted document must contain exactly the current fields of both pages", () => {
    const missing = defaultAcademyContent();
    delete missing.content.zhHant["faq.item1.question"];
    expect(rejection(missing)).toMatchObject({ field: "content.zhHant.faq.item1.question", code: "missing_field" });
    const unknown = defaultAcademyContent();
    unknown.content.en["hero.unknown"] = "x";
    expect(rejection(unknown)).toMatchObject({ field: "content.en.hero.unknown", code: "unsupported_field" });
    const locale = defaultAcademyContent();
    locale.content.zhHans = clone(locale.content.zhHant);
    expect(rejection(locale)).toMatchObject({ field: "content.zhHans", code: "unsupported_field" });
    expect(rejection({ ...defaultAcademyContent(), schemaVersion: 1 })).toMatchObject({ code: "invalid_request" });
    expect(rejection({ ...defaultAcademyContent(), extra: true })).toMatchObject({ field: "config.extra", code: "unsupported_field" });
  });

  test("the complete document has a storage limit", () => {
    const config = defaultAcademyContent();
    for (const locale of ["en", "zhHant"]) {
      for (const field of academyFields(locale)) config.content[locale][field.id] = "字".repeat(field.maxLength);
    }
    expect(rejection(config)).toMatchObject({ field: "config", code: "too_large" });
    expect(ACADEMY_CONTENT_MAX_CHARACTERS).toBe(60_000);
  });

  test("published data tolerates fields the templates gained or lost, never invalid values", () => {
    const stored = defaultAcademyContent();
    delete stored.content.en["hero.eyebrow"];
    stored.content.en["hero.removed"] = "old text";
    const read = readStoredAcademyContent(stored);
    expect(read.content.en["hero.eyebrow"]).toBe(academyFields("en").find(field => field.id === "hero.eyebrow").default);
    expect(read.content.en).not.toHaveProperty("hero.removed");
    stored.content.en["hero.lead"] = "";
    expect(() => readStoredAcademyContent(stored)).toThrow();
    const prices = defaultAcademyContent();
    prices.pricing.rates.TWD["60"].college = 0;
    expect(() => readStoredAcademyContent(prices)).toThrow();
  });
});

describe("Academy audit field names", () => {
  test("lists each changed price and text, and groups large edits by block within 80 entries", () => {
    const before = defaultAcademyContent();
    const small = clone(before);
    small.pricing.rates.TWD["45"].highschool = 850;
    small.content.zhHant["faq.item7.question"] = "新的問題";
    expect(academyChangedFields(before, small)).toEqual(["pricing.TWD.45.highschool", "zhHant.faq.item7.question"]);
    const large = clone(before);
    for (const locale of ["en", "zhHant"]) for (const field of academyFields(locale)) large.content[locale][field.id] += " (edited)";
    const fields = academyChangedFields(before, large);
    expect(fields.length).toBeLessThanOrEqual(80);
    expect(fields).toContain("zhHant.faq.item7");
    expect(fields).toContain("en.hero");
  });
});

describe("Academy migrations", () => {
  test("025 is the reviewed file, byte for byte after line-ending normalization", async () => {
    // The checksum recorded for the reviewed 025 candidate (2026-10-22 release gates).
    expect(migrationChecksum(await readFile("db/migrations/025_academy_pricing.sql", "utf8")))
      .toBe("1c0e2ff792c8a51dd377f4ccc0038c0a8802d93298be378faea5a04d9fd603de");
  });

  test("026 seeds exactly the P0 prices and page text, only when absent", async () => {
    const sql = await readFile("db/migrations/026_academy_content_v2.sql", "utf8");
    const seed = /\$seed\$(.*)\$seed\$/s.exec(sql)?.[1];
    expect(seed).toBeTruthy();
    const config = JSON.parse(seed);
    expect(readStoredAcademyContent(config)).toEqual(defaultAcademyContent());
    expect(config.pricing.rates).toEqual(P0_ACADEMY_RATES);
    expect(Array.from(seed).length).toBeLessThan(ACADEMY_CONTENT_MAX_CHARACTERS);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.site_settings WHERE key = 'academy_content_v2'\)/);
    expect(sql).toContain("ON CONFLICT (key) DO NOTHING");
    expect(sql).not.toMatch(/UPDATE\s+public\.site_settings/i);
    // Only the untouched 025 seed is removed; an edited row is kept.
    expect(sql).toMatch(/DELETE FROM public\.site_settings\s+WHERE key = 'academy_pricing_v1' AND updated_by = 'migration-025' AND record_version = 1;/);
  });
});
