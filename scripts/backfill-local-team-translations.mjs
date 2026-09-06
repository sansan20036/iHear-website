import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  TRANSLATION_GLOSSARY_VERSION,
  convertZhHantToZhHans,
  finishProtectedTranslation,
  googleTranslateToZhHant,
  protectTranslationText,
  sha256,
} from "../lib/translation-core.ts";

const LOCALIZED_FIELDS = [
  "role",
  "schoolDisplay",
  "languages",
  "strengths",
  "summary",
  "bio",
  "hobbies",
];
const FIELD_LIMITS = {
  role: 500,
  schoolDisplay: 300,
  languages: 500,
  strengths: 1_000,
  summary: 2_000,
  bio: 5_000,
  hobbies: 2_000,
};
const APPLY = process.argv.includes("--apply");
const ACTOR = "local-translation-backfill@ihear.local";
const workspace = process.cwd();
const teamPath = path.join(workspace, "data", "team-profiles.json");
const statePath = path.join(workspace, "data", "translation-states.json");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function addOrReplaceState(states, resourceId, field, locale, sourceHash, now) {
  const resource = { type: "team", scope: "", id: resourceId };
  const index = states.findIndex((item) =>
    item?.resource?.type === "team"
    && item.resource.scope === ""
    && item.resource.id === resourceId
    && item.field === field
    && item.locale === locale
  );
  const next = {
    resource,
    field,
    locale,
    sourceHash,
    origin: "machine",
    glossaryVersion: TRANSLATION_GLOSSARY_VERSION,
    updatedAt: now,
    updatedBy: ACTOR,
  };
  if (index >= 0) states[index] = next;
  else states.push(next);
}

function chunks(jobs, maximumItems = 100, maximumCharacters = 20_000) {
  const result = [];
  let current = [];
  let characters = 0;
  for (const job of jobs) {
    const size = job.protectedValue.source.length;
    if (current.length && (current.length >= maximumItems || characters + size > maximumCharacters)) {
      result.push(current);
      current = [];
      characters = 0;
    }
    current.push(job);
    characters += size;
  }
  if (current.length) result.push(current);
  return result;
}

async function main() {
  const envPath = path.join(workspace, ".env.local");
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  // This maintenance task intentionally never reads DATABASE_URL. It can only
  // update the ignored local JSON replica under data/.
  process.env.IHEAR_FORCE_FILE_STORE = "1";

  const store = await readJson(teamPath, null);
  if (!store || !Array.isArray(store.people) || !Array.isArray(store.profiles)) {
    throw new Error("Local Team data is unavailable. Start the local site once before running this command.");
  }

  const people = new Map(store.people.map((person) => [person.id, person]));
  const missing = [];
  const googleJobs = [];
  for (const profile of store.profiles) {
    const person = people.get(profile.personId);
    for (const field of LOCALIZED_FIELDS) {
      const value = profile[field];
      if (!value?.en?.trim()) continue;
      const missingLocales = ["zhHant", "zhHans"].filter((locale) => !value[locale]?.trim());
      if (!missingLocales.length) continue;
      missing.push({ profile, field, value, missingLocales });
      if (missingLocales.includes("zhHant")) {
        googleJobs.push({
          profile,
          field,
          value,
          missingLocales,
          protectedValue: protectTranslationText(value.en, [person?.name || "", profile.school || ""]),
        });
      }
    }
  }

  const affectedProfiles = new Set(missing.map((item) => item.profile.id));
  const missingCells = missing.reduce((total, item) => total + item.missingLocales.length, 0);
  console.log(`Local Team audit: ${affectedProfiles.size} profile(s), ${missingCells} missing translation cell(s).`);
  if (!missing.length) return;
  if (!APPLY) {
    console.log("Dry run only. Add --apply to translate and update the local JSON replica.");
    return;
  }

  for (const batch of chunks(googleJobs)) {
    const translated = await googleTranslateToZhHant(
      batch.map((job) => job.protectedValue.source),
      batch.map((job) => job.protectedValue),
    );
    batch.forEach((job, index) => {
      try {
        job.generated = finishProtectedTranslation(job.protectedValue, translated[index]);
      } catch (error) {
        const expected = job.protectedValue.placeholders.map((item) => item.token);
        const observed = translated[index].match(/⟦[^⟧]*⟧/gu) || [];
        const tokenDiagnostics = expected.map((token) => {
          const nonce = token.match(/IH_([A-Z0-9]{10})_/u)?.[1] || "";
          return {
            noncePreserved: Boolean(nonce && translated[index].includes(nonce)),
            ihMarkerPreserved: translated[index].includes("IH"),
            leftBracketPreserved: translated[index].includes("⟦"),
            rightBracketPreserved: translated[index].includes("⟧"),
          };
        });
        console.error(`Placeholder integrity failed for ${job.profile.id}.${job.field}.`);
        console.error(`Expected placeholders: ${JSON.stringify(expected)}`);
        console.error(`Observed placeholders: ${JSON.stringify(observed)}`);
        console.error(`Token diagnostics: ${JSON.stringify(tokenDiagnostics)}`);
        throw error;
      }
    });
  }

  const states = await readJson(statePath, []);
  if (!Array.isArray(states)) throw new Error("Local translation state file has an invalid format.");
  const now = new Date().toISOString();
  for (const item of missing) {
    const matchingJob = googleJobs.find((job) => job.profile.id === item.profile.id && job.field === item.field);
    if (item.missingLocales.includes("zhHant")) item.value.zhHant = matchingJob.generated.zhHant;
    if (item.missingLocales.includes("zhHans")) {
      item.value.zhHans = matchingJob?.generated?.zhHans || convertZhHantToZhHans(item.value.zhHant);
    }
    for (const locale of item.missingLocales) {
      if (!item.value[locale] || item.value[locale].length > FIELD_LIMITS[item.field]) {
        throw new Error(`${item.profile.id}.${item.field}.${locale} is empty or exceeds its field limit.`);
      }
      addOrReplaceState(
        states,
        item.profile.id,
        item.field,
        locale,
        locale === "zhHant" ? sha256(item.value.en) : sha256(item.value.zhHant),
        now,
      );
    }
  }

  for (const profile of store.profiles) {
    if (!affectedProfiles.has(profile.id)) continue;
    profile.version = Number(profile.version || 0) + 1;
    profile.updatedAt = now;
    profile.updatedBy = ACTOR;
  }

  const stamp = now.replace(/[:.]/g, "-");
  const backupDirectory = path.join(workspace, "backups", `local-team-translation-${stamp}`);
  await mkdir(backupDirectory, { recursive: true });
  await copyFile(teamPath, path.join(backupDirectory, "team-profiles.json"));
  try {
    await copyFile(statePath, path.join(backupDirectory, "translation-states.json"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(teamPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await writeFile(statePath, `${JSON.stringify(states, null, 2)}\n`, "utf8");
  console.log(`Updated ${affectedProfiles.size} local Team profile(s).`);
  console.log(`Backup created at ${path.relative(workspace, backupDirectory)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
