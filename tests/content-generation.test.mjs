import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const htmlFiles = [
  "index.html", "about.html", "programs.html", "impact.html", "team.html",
  "submit-bio.html", "stories.html", "get-involved.html", "academy.html",
  "donate.html", "resources.html", "faq.html", "contact.html",
];
const generatedFiles = [
  ...htmlFiles,
  "data/content-slots.json",
  "data/layout-slots.json",
  "docs/content-slot-inventory.md",
];
const inputFiles = [
  ...generatedFiles,
  "assets/site.js",
  "app/auth-error/auth-error-client.tsx",
  "scripts/generate-content-slots.mjs",
  "scripts/migration-checksum.mjs",
];
const seedFile = "db/migrations/013_content_slots_seed.sql";
let fixture;
let fixtureParent;
let migrationFiles;

const read = (relative) => readFile(path.join(fixture, relative), "utf8");
const write = (relative, contents) => writeFile(path.join(fixture, relative), contents, "utf8");
const catalog = async () => JSON.parse(await read("data/content-slots.json"));
const semanticSlots = (data) => data.slots.map(({ occurrences: _occurrences, ...slot }) => slot);
const snapshot = async (files) => Object.fromEntries(await Promise.all(
  files.map(async (file) => [file, (await readFile(path.join(fixture, file))).toString("base64")]),
));

async function runGenerator(...args) {
  try {
    const result = await execFileAsync(process.execPath, ["scripts/generate-content-slots.mjs", ...args], {
      cwd: fixture,
      timeout: 15_000,
      windowsHide: true,
      encoding: "utf8",
    });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function expectSuccess(result) {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
}

beforeEach(async () => {
  fixtureParent = await realpath(os.tmpdir());
  fixture = await mkdtemp(path.join(fixtureParent, "ihear-content-generation-"));
  migrationFiles = (await readdir(path.join(repository, "db/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `db/migrations/${name}`);
  await Promise.all([...inputFiles, ...migrationFiles].map(async (file) => {
    const destination = path.join(fixture, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repository, file), destination);
  }));
});

afterEach(async () => {
  if (!fixture) return;
  const resolved = await realpath(fixture);
  if (resolved !== path.resolve(fixture)
    || path.dirname(resolved) !== fixtureParent
    || !path.basename(resolved).startsWith("ihear-content-generation-")) {
    throw new Error(`Refusing to remove a path outside the created fixture: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  fixture = undefined;
});

describe("content generation determinism and historical migration protection", () => {
  it("generates byte-identical artifacts repeatedly without changing content semantics or migrations", async () => {
    const originalSlots = semanticSlots(await catalog());
    const originalLayout = JSON.parse(await read("data/layout-slots.json"));
    const originalMigrations = await snapshot(migrationFiles);

    expectSuccess(await runGenerator("--write"));
    const generated = await snapshot(generatedFiles);
    expect(semanticSlots(await catalog())).toEqual(originalSlots);
    expect(JSON.parse(await read("data/layout-slots.json"))).toEqual(originalLayout);
    expectSuccess(await runGenerator("--write"));
    expect(await snapshot(generatedFiles)).toEqual(generated);
    expectSuccess(await runGenerator());
    expect(await snapshot(generatedFiles)).toEqual(generated);
    expect(await snapshot(migrationFiles)).toEqual(originalMigrations);
  });

  it("checks generated text artifacts with CRLF endings without rewriting their bytes", async () => {
    expectSuccess(await runGenerator("--write"));
    for (const file of ["data/content-slots.json", "data/layout-slots.json", "docs/content-slot-inventory.md"]) {
      await write(file, (await read(file)).replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));
    }
    const generated = await snapshot(generatedFiles);

    expectSuccess(await runGenerator());
    expect(await snapshot(generatedFiles)).toEqual(generated);
    expectSuccess(await runGenerator("--write"));
    expect(await snapshot(generatedFiles)).toEqual(generated);
  });

  it("records final HTML line locations for every occurrence, including identical multiline markup", async () => {
    const legacyKey = "cp0_fixture_location";
    const duplicate = `<p data-i18n="${legacyKey}"\ndata-editable-content="stale"\ndata-editable-mode="multiline"\ndata-editable-maxlength="5000">CP0 location fixture</p>`;
    await write("index.html", (await read("index.html")).replace("</main>", `${duplicate}\n\n${duplicate}\n</main>`));

    expectSuccess(await runGenerator("--write"));
    const generated = await catalog();
    const pages = new Map(await Promise.all(htmlFiles.map(async (file) => [file, await read(file)])));
    for (const slot of generated.slots) {
      for (const occurrence of slot.occurrences) {
        if (occurrence.tag === "react") continue;
        const line = pages.get(occurrence.file).split(/\r?\n/)[occurrence.line - 1];
        expect(line, `${slot.key}: ${occurrence.file}:${occurrence.line}`).toContain(`data-i18n="${occurrence.legacyKey}"`);
      }
    }
    const fixtureSlot = generated.slots.find((slot) => slot.occurrences.some((item) => item.legacyKey === legacyKey));
    const expectedLines = [...pages.get("index.html").matchAll(/<p\b[^>]*data-i18n="cp0_fixture_location"[^>]*>/g)]
      .map((match) => pages.get("index.html").slice(0, match.index).split(/\r?\n/).length);
    expect(expectedLines).toHaveLength(2);
    expect(new Set(expectedLines).size).toBe(2);
    expect(fixtureSlot.occurrences.map((item) => item.line)).toEqual(expectedLines);
    expectSuccess(await runGenerator());
  });

  it("updates source defaults and adds slots without regenerating any historical SQL", async () => {
    const original = await catalog();
    const originalMigrations = await snapshot(migrationFiles);
    const editedKey = "home.hero.eyebrow";
    const originalSlot = original.slots.find((slot) => slot.key === editedKey);
    const english = "CP0 edited fixture value";
    await write("index.html", (await read("index.html"))
      .replace(originalSlot.values.en, english)
      .replace("</main>", '<p data-i18n="cp0_fixture_added">CP0 added fixture value</p>\n</main>'));

    expect((await runGenerator()).code).not.toBe(0);
    expectSuccess(await runGenerator("--write"));
    const generated = await catalog();
    const changed = generated.slots.find((slot) => slot.key === editedKey);
    expect(changed.values).toEqual({ ...originalSlot.values, en: english });
    const added = generated.slots.find((slot) => slot.occurrences.some((item) => item.legacyKey === "cp0_fixture_added"));
    expect(added.values).toEqual({ en: "CP0 added fixture value", zhHant: "CP0 added fixture value", zhHans: "CP0 added fixture value" });
    expect(semanticSlots(generated).filter((slot) => slot.key !== editedKey && slot.key !== added.key))
      .toEqual(semanticSlots(original).filter((slot) => slot.key !== editedKey));
    expect(await snapshot(migrationFiles)).toEqual(originalMigrations);
    expectSuccess(await runGenerator());
  });

  it("rejects a tampered historical seed in check and write modes before touching stale artifacts", async () => {
    await write(seedFile, `${await read(seedFile)}\n-- Unapproved fixture change.\n`);
    await write("data/content-slots.json", "stale fixture catalog\n");
    const before = await snapshot([...generatedFiles, ...migrationFiles]);

    for (const args of [[], ["--write"]]) {
      const result = await runGenerator(...args);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/013_content_slots_seed\.sql/);
      expect(await snapshot([...generatedFiles, ...migrationFiles])).toEqual(before);
    }
  });

  it("accepts normalized migration line endings without rewriting the historical file", async () => {
    await write(seedFile, (await read(seedFile)).replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));
    const originalMigrations = await snapshot(migrationFiles);

    expectSuccess(await runGenerator("--write"));
    expectSuccess(await runGenerator());
    expect(await snapshot(migrationFiles)).toEqual(originalMigrations);
  });
});
