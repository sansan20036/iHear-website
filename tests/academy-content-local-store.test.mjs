import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultAcademyContent } from "../lib/academy-content-types";

const root = path.resolve("output", "academy-content-local-tests");
let directory;
let store;
const file = () => path.join(directory, "academy-content.json");

beforeEach(async () => {
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(path.join(root, "store-"));
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "VERCEL", "NETLIFY", "CONTEXT"]) vi.stubEnv(key, "");
  vi.stubEnv("IHEAR_FORCE_FILE_STORE", "1");
  vi.stubEnv("IHEAR_TEST_DATA_DIR", directory);
  vi.resetModules();
  store = await import("../lib/academy-content-store");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const resolved = await realpath(directory);
  const allowed = await realpath(root);
  if (!resolved.startsWith(allowed + path.sep)) throw new Error("Refusing cleanup outside isolated test root");
  await rm(resolved, { recursive: true, force: true });
});

function update(config = defaultAcademyContent(), expectedVersion = 1) {
  return { config, expectedVersion, updatedBy: "editor@example.com", updatedByRole: "editor" };
}

describe("Academy content isolated durable local storage", () => {
  test("read-only local preview returns the P0 defaults without creating a file", async () => {
    expect(await store.readAcademyContent()).toMatchObject({ config: defaultAcademyContent(), recordVersion: 1 });
    await expect(readFile(file(), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  test("persists prices, both languages and the audit entry atomically across module reloads", async () => {
    const config = defaultAcademyContent();
    config.pricing.rates.TWD["60"].college = 1500;
    config.content.zhHant["pricing.card.tutor.college"] = "大學生或成人導師😀";
    config.content.en["hero.cta"] = "Meet your tutor";
    const result = await store.updateAcademyContent(update(config));
    expect(result.recordVersion).toBe(2);
    vi.resetModules();
    const restarted = await import("../lib/academy-content-store");
    expect(await restarted.readAcademyContent()).toEqual(result);
    const document = JSON.parse(await readFile(file(), "utf8"));
    expect(document.record).toEqual(result);
    expect(document.record.config.content.zhHant["hero.cta"]).toBe(defaultAcademyContent().content.zhHant["hero.cta"]);
    expect(document.activity).toHaveLength(1);
    expect(document.activity[0]).toMatchObject({ actorEmail: "editor@example.com", actorRole: "editor", action: "academy.content.updated", entityType: "academy", entityId: "academy_content_v2", entityVersion: 2 });
    expect(document.activity[0].changedFields).toEqual(["pricing.TWD.60.college", "zhHant.pricing.card.tutor.college", "en.hero.cta"]);
  });

  test("two concurrent writers with one expected version produce exactly one saved document and audit", async () => {
    const a = defaultAcademyContent(), b = defaultAcademyContent();
    a.pricing.rates.USD["45"].highschool = 26; b.pricing.rates.USD["45"].highschool = 27;
    const outcomes = await Promise.allSettled([store.updateAcademyContent(update(a)), store.updateAcademyContent(update(b))]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected");
    expect(rejected.reason).toBeInstanceOf(store.AcademyContentConflictError);
    const document = JSON.parse(await readFile(file(), "utf8"));
    expect(document.record.recordVersion).toBe(2);
    expect(document.activity).toHaveLength(1);
    expect([26, 27]).toContain(document.record.config.pricing.rates.USD["45"].highschool);
  });

  test("a stale save cannot change the file or append an audit event", async () => {
    await store.updateAcademyContent(update());
    const before = await readFile(file(), "utf8");
    await expect(store.updateAcademyContent(update())).rejects.toBeInstanceOf(store.AcademyContentConflictError);
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  test("an invalid document is rejected as a whole and nothing is written", async () => {
    const config = defaultAcademyContent();
    config.content.en["hero.cta"] = "Changed";
    config.pricing.rates.TWD["45"].college = -1;
    await expect(store.updateAcademyContent(update(config))).rejects.toMatchObject({ name: "AcademyContentValidationError", field: "pricing.rates.TWD.45.college" });
    await expect(readFile(file(), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  test("published text survives a template that gained a field: the new field reads its default", async () => {
    const config = defaultAcademyContent();
    config.content.en["hero.cta"] = "Saved text";
    delete config.content.en["footer.tagline"];
    await writeFile(file(), JSON.stringify({ record: { config, recordVersion: 4, updatedAt: "2026-10-24T00:00:00.000Z", updatedBy: "owner@example.com" }, activity: [] }), "utf8");
    const read = await store.readAcademyContent();
    expect(read.recordVersion).toBe(4);
    expect(read.config.content.en["hero.cta"]).toBe("Saved text");
    expect(read.config.content.en["footer.tagline"]).toBe(defaultAcademyContent().content.en["footer.tagline"]);
  });

  test.each([
    "{invalid",
    JSON.stringify({ record: { config: { bad: true }, recordVersion: 1, updatedAt: "2026-10-24", updatedBy: "someone" }, activity: [] }),
    JSON.stringify({ record: { config: { ...defaultAcademyContent(), pricing: { rates: { ...defaultAcademyContent().pricing.rates, USD: { 45: { highschool: 0, college: 34 }, 60: { highschool: 34, college: 45 } } } } }, recordVersion: 1, updatedAt: "2026-10-24", updatedBy: "someone" }, activity: [] }),
  ])("invalid persistent state is unavailable and is never silently replaced (%#)", async raw => {
    await writeFile(file(), raw, "utf8");
    await expect(store.readAcademyContent()).rejects.toBeInstanceOf(store.AcademyContentUnavailableError);
    await expect(store.updateAcademyContent(update())).rejects.toBeInstanceOf(store.AcademyContentUnavailableError);
    expect(await readFile(file(), "utf8")).toBe(raw);
  });

  test("a lock held by another process fails closed instead of overwriting", async () => {
    await store.updateAcademyContent(update());
    const before = await readFile(file(), "utf8");
    await writeFile(`${file()}.lock`, "", "utf8");
    const config = defaultAcademyContent();
    config.content.en["hero.cta"] = "Blocked";
    await expect(store.updateAcademyContent(update(config, 2))).rejects.toBeInstanceOf(store.AcademyContentUnavailableError);
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  test("hosted environments with no database cannot read or save default content", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.resetModules();
    const hosted = await import("../lib/academy-content-store");
    await expect(hosted.readAcademyContent()).rejects.toBeInstanceOf(hosted.AcademyContentUnavailableError);
    await expect(hosted.updateAcademyContent(update())).rejects.toBeInstanceOf(hosted.AcademyContentUnavailableError);
    await expect(readFile(file(), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  test("a valid effective actor role is required rather than assumed", async () => {
    const input = update(); delete input.updatedByRole;
    await expect(store.updateAcademyContent(input)).rejects.toMatchObject({ name: "AcademyContentValidationError", field: "updatedBy" });
    await expect(store.updateAcademyContent({ ...update(), updatedByRole: "visitor" })).rejects.toMatchObject({ name: "AcademyContentValidationError" });
    await expect(store.updateAcademyContent({ ...update(), updatedBy: " " })).rejects.toMatchObject({ name: "AcademyContentValidationError" });
    await expect(readFile(file(), "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });
});
