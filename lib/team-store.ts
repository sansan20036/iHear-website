import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import { saveTranslationStates, upsertTranslationStatesInTransaction } from "./translation-state";
import { TEAM_LOCALIZED_FIELDS } from "./team-types";
import type { TranslationStateWrite } from "./translation-types";

import { TEAM_PEOPLE_SEED, TEAM_PROFILES_SEED } from "./team-seed";
import type {
  LocalizedText,
  TeamPersonSeed,
  TeamProfile,
  TeamProfileInput,
  TeamProfileSeed,
  TeamProfileUpdateInput,
  TeamSection,
} from "./team-types";

export const TEAM_CACHE_TAG = "team-profiles-v1";

export class TeamConfigurationError extends Error {}
export class TeamNotFoundError extends Error {}
export class TeamConflictError extends Error {}
export class TeamDuplicatePlacementError extends Error {}

type TeamFileStore = {
  people: Array<TeamPersonSeed & { version: number; createdAt: string; updatedAt: string; createdBy: string; updatedBy: string }>;
  profiles: Array<TeamProfileSeed & { version: number; createdAt: string; updatedAt: string; createdBy: string; updatedBy: string }>;
};

type TeamRow = Record<string, unknown> & {
  id: string;
  person_id: string;
  section: TeamSection;
  status: "draft" | "published";
  sort_order: number;
  school: string;
  grade: string;
  show_school: boolean;
  show_grade: boolean;
  name: string;
  initials: string;
  publication_consent_at: Date | string | null;
  profile_version: number;
  person_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  updated_by: string;
  deleted_at: Date | string | null;
  deleted_by: string | null;
};

const databaseUrl = process.env.IHEAR_FORCE_FILE_STORE === "1"
  ? ""
  : process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
const isHostedProduction =
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CONTEXT);
const filePath = path.join(process.cwd(), "data", "team-profiles.json");
const globalForTeam = globalThis as typeof globalThis & {
  ihearTeamSql?: ReturnType<typeof postgres>;
};
let fileQueue: Promise<unknown> = Promise.resolve();

function sqlClient() {
  if (!databaseUrl) return null;
  if (!globalForTeam.ihearTeamSql) {
    globalForTeam.ihearTeamSql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
    });
  }
  return globalForTeam.ihearTeamSql;
}

function assertPersistence() {
  if (!databaseUrl && isHostedProduction) {
    throw new TeamConfigurationError("Team profile persistence is not configured");
  }
}

function iso(value: Date | string | null | undefined) {
  return value == null ? null : new Date(value).toISOString();
}

function locale(row: TeamRow, prefix: string): LocalizedText {
  return {
    en: String(row[`${prefix}_en`] || ""),
    zhHant: String(row[`${prefix}_zh_hant`] || ""),
    zhHans: String(row[`${prefix}_zh_hans`] || ""),
  };
}

function fromRow(row: TeamRow): TeamProfile {
  return {
    id: row.id,
    personId: row.person_id,
    section: row.section,
    status: row.status,
    sortOrder: Number(row.sort_order),
    school: row.school,
    grade: row.grade,
    showSchool: row.show_school,
    showGrade: row.show_grade,
    name: row.name,
    initials: row.initials,
    publicationConsentAt: iso(row.publication_consent_at),
    role: locale(row, "role"),
    schoolDisplay: locale(row, "school_display"),
    languages: locale(row, "languages"),
    strengths: locale(row, "strengths"),
    summary: locale(row, "summary"),
    bio: locale(row, "bio"),
    hobbies: locale(row, "hobbies"),
    profileVersion: Number(row.profile_version),
    personVersion: Number(row.person_version),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    updatedBy: row.updated_by,
    deletedAt: iso(row.deleted_at),
    deletedBy: row.deleted_by || null,
  };
}

const SELECT_COLUMNS = `
  profile.id, profile.person_id, profile.section, profile.status, profile.sort_order,
  profile.school, profile.grade, profile.show_school, profile.show_grade,
  profile.role_en, profile.role_zh_hant, profile.role_zh_hans,
  profile.school_display_en, profile.school_display_zh_hant, profile.school_display_zh_hans,
  profile.languages_en, profile.languages_zh_hant, profile.languages_zh_hans,
  profile.strengths_en, profile.strengths_zh_hant, profile.strengths_zh_hans,
  profile.summary_en, profile.summary_zh_hant, profile.summary_zh_hans,
  profile.bio_en, profile.bio_zh_hant, profile.bio_zh_hans,
  profile.hobbies_en, profile.hobbies_zh_hant, profile.hobbies_zh_hans,
  profile.version AS profile_version, profile.created_at, profile.updated_at, profile.updated_by,
  profile.deleted_at, profile.deleted_by,
  person.name, person.initials, person.publication_consent_at,
  person.version AS person_version
`;

function seedFileStore(): TeamFileStore {
  const now = "2026-07-31T00:00:00.000Z";
  const actor = "ihearprogram@gmail.com";
  return {
    people: TEAM_PEOPLE_SEED.map((person) => ({
      ...person,
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    })),
    profiles: TEAM_PROFILES_SEED.map((profile) => ({
      ...profile,
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    })),
  };
}

async function readFileStore(): Promise<TeamFileStore> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as TeamFileStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return seedFileStore();
    throw error;
  }
}

async function mutateFile<T>(callback: (store: TeamFileStore) => Promise<T>) {
  const operation = fileQueue.then(async () => {
    const store = await readFileStore();
    const result = await callback(store);
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    return result;
  });
  fileQueue = operation.catch(() => undefined);
  return operation as Promise<T>;
}

function fromFile(store: TeamFileStore) {
  return store.profiles.map((profile) => {
    const person = store.people.find((item) => item.id === profile.personId)!;
    return {
      ...profile,
      name: person.name,
      initials: person.initials,
      publicationConsentAt: person.publicationConsentAt,
      profileVersion: profile.version,
      personVersion: person.version,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      updatedBy: profile.updatedBy,
      deletedAt: (profile as TeamProfileSeed & { deletedAt?: string }).deletedAt || null,
      deletedBy: (profile as TeamProfileSeed & { deletedBy?: string }).deletedBy || null,
    } satisfies TeamProfile;
  });
}

export async function listPublishedTeamProfiles() {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    const rows = await sql.unsafe<TeamRow[]>(
      `SELECT ${SELECT_COLUMNS}
       FROM team_profiles AS profile
       JOIN team_people AS person ON person.id = profile.person_id
       WHERE profile.status = 'published' AND profile.deleted_at IS NULL
       ORDER BY profile.section, profile.sort_order, profile.id`,
    );
    return rows.map(fromRow);
  }
  return fromFile(await readFileStore())
    .filter((profile) => profile.status === "published" && !profile.deletedAt)
    .sort((a, b) => a.section.localeCompare(b.section) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export async function listAllTeamProfiles() {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    const rows = await sql.unsafe<TeamRow[]>(
      `SELECT ${SELECT_COLUMNS}
       FROM team_profiles AS profile
       JOIN team_people AS person ON person.id = profile.person_id
       WHERE profile.deleted_at IS NULL
       ORDER BY profile.section, profile.sort_order, profile.id`,
    );
    return rows.map(fromRow);
  }
  return fromFile(await readFileStore()).filter((profile) => !profile.deletedAt).sort(
    (a, b) => a.section.localeCompare(b.section) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
}

export async function listDeletedTeamProfiles() {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    const rows = await sql.unsafe<TeamRow[]>(
      `SELECT ${SELECT_COLUMNS}
       FROM team_profiles AS profile
       JOIN team_people AS person ON person.id = profile.person_id
       WHERE profile.deleted_at IS NOT NULL
       ORDER BY profile.deleted_at DESC, profile.id`,
    );
    return rows.map(fromRow);
  }
  return fromFile(await readFileStore())
    .filter((profile) => Boolean(profile.deletedAt))
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

function newId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

export async function createTeamProfile(input: TeamProfileInput, email: string, translationStates: TranslationStateWrite[] = []) {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    try {
      return await sql.begin(async (tx) => {
        let personId = input.personId;
        if (personId) {
          const [person] = await tx`SELECT id FROM team_people WHERE id = ${personId}`;
          if (!person) throw new TeamNotFoundError("Person not found");
          if (input.consentConfirmed) {
            await tx`
              UPDATE team_people
              SET name = ${input.name}, initials = ${input.initials},
                  publication_consent_at = COALESCE(publication_consent_at, NOW()),
                  publication_consent_by = COALESCE(publication_consent_by, ${email}),
                  updated_at = NOW(), updated_by = ${email}, version = version + 1
              WHERE id = ${personId}
            `;
          }
        } else {
          personId = newId("person");
          await tx`
            INSERT INTO team_people (
              id, name, initials, publication_consent_at, publication_consent_by,
              created_by, updated_by
            ) VALUES (
              ${personId}, ${input.name}, ${input.initials},
              ${input.consentConfirmed ? new Date() : null},
              ${input.consentConfirmed ? email : null}, ${email}, ${email}
            )
          `;
        }
        const id = newId(input.section);
        const sortOrder =
          input.sortOrder ??
          Number((await tx`
            SELECT COALESCE(MAX(sort_order), 0) + 10 AS value
            FROM team_profiles WHERE section = ${input.section} AND deleted_at IS NULL
          `)[0].value);
        await insertProfile(tx, id, personId, input, sortOrder, email);
        await upsertTranslationStatesInTransaction(
          tx,
          { type: "team", scope: "", id },
          translationStates,
          email,
        );
        const rows = await tx.unsafe<TeamRow[]>(
          `SELECT ${SELECT_COLUMNS}
           FROM team_profiles AS profile JOIN team_people AS person ON person.id = profile.person_id
           WHERE profile.id = $1`,
          [id],
        );
        return fromRow(rows[0]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new TeamDuplicatePlacementError("This person already appears in that section");
      }
      throw error;
    }
  }

  const created = await mutateFile(async (store) => {
    let person = input.personId ? store.people.find((item) => item.id === input.personId) : undefined;
    const now = new Date().toISOString();
    if (!person) {
      person = {
        id: newId("person"),
        name: input.name,
        initials: input.initials,
        publicationConsentAt: input.consentConfirmed ? now : "",
        publicationConsentBy: input.consentConfirmed ? email : "",
        version: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: email,
        updatedBy: email,
      };
      store.people.push(person);
    }
    if (store.profiles.some((item) => item.personId === person!.id && item.section === input.section)) {
      throw new TeamDuplicatePlacementError("This person already appears in that section");
    }
    const profile = {
      ...input,
      id: newId(input.section),
      personId: person.id,
      sortOrder:
        input.sortOrder ??
        Math.max(0, ...store.profiles.filter((item) => item.section === input.section).map((item) => item.sortOrder)) + 10,
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: email,
      updatedBy: email,
      deletedAt: null,
      deletedBy: null,
    };
    store.profiles.push(profile);
    return fromFile(store).find((item) => item.id === profile.id)!;
  });
  await saveTranslationStates({ type: "team", scope: "", id: created.id }, translationStates, email);
  return created;
}

async function insertProfile(
  tx: postgres.TransactionSql,
  id: string,
  personId: string,
  input: TeamProfileInput,
  sortOrder: number,
  email: string,
) {
  await tx`
    INSERT INTO team_profiles (
      id, person_id, section, status, sort_order, school, grade, show_school, show_grade,
      role_en, role_zh_hant, role_zh_hans,
      school_display_en, school_display_zh_hant, school_display_zh_hans,
      languages_en, languages_zh_hant, languages_zh_hans,
      strengths_en, strengths_zh_hant, strengths_zh_hans,
      summary_en, summary_zh_hant, summary_zh_hans,
      bio_en, bio_zh_hant, bio_zh_hans,
      hobbies_en, hobbies_zh_hant, hobbies_zh_hans,
      created_by, updated_by
    ) VALUES (
      ${id}, ${personId}, ${input.section}, ${input.status}, ${sortOrder},
      ${input.school}, ${input.grade}, ${input.showSchool}, ${input.showGrade},
      ${input.role.en}, ${input.role.zhHant}, ${input.role.zhHans},
      ${input.schoolDisplay.en}, ${input.schoolDisplay.zhHant}, ${input.schoolDisplay.zhHans},
      ${input.languages.en}, ${input.languages.zhHant}, ${input.languages.zhHans},
      ${input.strengths.en}, ${input.strengths.zhHant}, ${input.strengths.zhHans},
      ${input.summary.en}, ${input.summary.zhHant}, ${input.summary.zhHans},
      ${input.bio.en}, ${input.bio.zhHant}, ${input.bio.zhHans},
      ${input.hobbies.en}, ${input.hobbies.zhHant}, ${input.hobbies.zhHans},
      ${email}, ${email}
    )
  `;
}

export async function updateTeamProfile(id: string, input: TeamProfileUpdateInput, email: string, translationStates?: TranslationStateWrite[]) {
  assertPersistence();
  const { manualTranslationUpdateWrites } = await import("./translation-core");
  const fields = Object.fromEntries(TEAM_LOCALIZED_FIELDS.map((field) => [field, input[field]]));
  const sql = sqlClient();
  if (sql) {
    return sql.begin(async (tx) => {
      const [current] = await tx`
        SELECT * FROM team_profiles
        WHERE id = ${id} AND version = ${input.profileVersion} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!current) {
        const exists = await tx`SELECT id FROM team_profiles WHERE id = ${id}`;
        if (!exists[0]) throw new TeamNotFoundError("Team profile not found");
        throw new TeamConflictError("Team profile changed");
      }
      const previous = Object.fromEntries(TEAM_LOCALIZED_FIELDS.map((field) => [
        field, locale(current as TeamRow, field === "schoolDisplay" ? "school_display" : field),
      ]));
      const writes = translationStates ?? manualTranslationUpdateWrites(fields, previous);
      const personRows = await tx`
        UPDATE team_people
        SET name = ${input.name}, initials = ${input.initials},
            publication_consent_at = CASE WHEN ${input.consentConfirmed}
              THEN COALESCE(publication_consent_at, NOW()) ELSE publication_consent_at END,
            publication_consent_by = CASE WHEN ${input.consentConfirmed}
              THEN COALESCE(publication_consent_by, ${email}) ELSE publication_consent_by END,
            updated_at = NOW(), updated_by = ${email}, version = version + 1
        WHERE id = ${current.person_id} AND version = ${input.personVersion}
        RETURNING id
      `;
      if (!personRows[0]) throw new TeamConflictError("Person changed");
      const updated = await tx`
        UPDATE team_profiles SET
          section = ${input.section}, status = ${input.status},
          sort_order = ${input.sortOrder ?? 0}, school = ${input.school}, grade = ${input.grade},
          show_school = ${input.showSchool}, show_grade = ${input.showGrade},
          role_en = ${input.role.en}, role_zh_hant = ${input.role.zhHant}, role_zh_hans = ${input.role.zhHans},
          school_display_en = ${input.schoolDisplay.en}, school_display_zh_hant = ${input.schoolDisplay.zhHant},
          school_display_zh_hans = ${input.schoolDisplay.zhHans},
          languages_en = ${input.languages.en}, languages_zh_hant = ${input.languages.zhHant},
          languages_zh_hans = ${input.languages.zhHans},
          strengths_en = ${input.strengths.en}, strengths_zh_hant = ${input.strengths.zhHant},
          strengths_zh_hans = ${input.strengths.zhHans},
          summary_en = ${input.summary.en}, summary_zh_hant = ${input.summary.zhHant},
          summary_zh_hans = ${input.summary.zhHans},
          bio_en = ${input.bio.en}, bio_zh_hant = ${input.bio.zhHant}, bio_zh_hans = ${input.bio.zhHans},
          hobbies_en = ${input.hobbies.en}, hobbies_zh_hant = ${input.hobbies.zhHant},
          hobbies_zh_hans = ${input.hobbies.zhHans},
          updated_at = NOW(), updated_by = ${email}, version = version + 1
        WHERE id = ${id} AND version = ${input.profileVersion} AND deleted_at IS NULL
        RETURNING id
      `;
      if (!updated[0]) throw new TeamConflictError("Team profile changed");
      await upsertTranslationStatesInTransaction(
        tx,
        { type: "team", scope: "", id },
        writes,
        email,
      );
      const rows = await tx.unsafe<TeamRow[]>(
        `SELECT ${SELECT_COLUMNS}
         FROM team_profiles AS profile JOIN team_people AS person ON person.id = profile.person_id
         WHERE profile.id = $1`,
        [id],
      );
      return fromRow(rows[0]);
    });
  }
  let writes = translationStates;
  const result = await mutateFile(async (store) => {
    const profile = store.profiles.find((item) => item.id === id);
    if (!profile) throw new TeamNotFoundError("Team profile not found");
    const person = store.people.find((item) => item.id === profile.personId)!;
    if (profile.version !== input.profileVersion || person.version !== input.personVersion) {
      throw new TeamConflictError("Team profile changed");
    }
    writes ??= manualTranslationUpdateWrites(fields, Object.fromEntries(
      TEAM_LOCALIZED_FIELDS.map((field) => [field, profile[field]]),
    ));
    const now = new Date().toISOString();
    Object.assign(person, {
      name: input.name,
      initials: input.initials,
      publicationConsentAt: input.consentConfirmed ? person.publicationConsentAt || now : person.publicationConsentAt,
      publicationConsentBy: input.consentConfirmed ? person.publicationConsentBy || email : person.publicationConsentBy,
      version: person.version + 1,
      updatedAt: now,
      updatedBy: email,
    });
    Object.assign(profile, {
      ...input,
      personId: profile.personId,
      id,
      sortOrder: input.sortOrder ?? profile.sortOrder,
      version: profile.version + 1,
      updatedAt: now,
      updatedBy: email,
    });
    return fromFile(store).find((item) => item.id === id)!;
  });
  await saveTranslationStates({ type: "team", scope: "", id }, writes || [], email);
  return result;
}

export async function trashTeamProfile(id: string, profileVersion: number, email: string) {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    const rows = await sql`
      UPDATE team_profiles
      SET deleted_at = NOW(), deleted_by = ${email}, version = version + 1,
          updated_at = NOW(), updated_by = ${email}
      WHERE id = ${id} AND version = ${profileVersion} AND deleted_at IS NULL
      RETURNING id
    `;
    if (rows[0]) return id;
    const exists = await sql`SELECT id FROM team_profiles WHERE id = ${id}`;
    if (!exists[0]) throw new TeamNotFoundError("Team profile not found");
    throw new TeamConflictError("Team profile changed");
  }
  return mutateFile(async (store) => {
    const profile = store.profiles.find((item) => item.id === id) as typeof store.profiles[number] & { deletedAt?: string; deletedBy?: string };
    if (!profile) throw new TeamNotFoundError("Team profile not found");
    if (profile.version !== profileVersion || profile.deletedAt) throw new TeamConflictError("Team profile changed");
    const now = new Date().toISOString();
    profile.deletedAt = now;
    profile.deletedBy = email;
    profile.version += 1;
    profile.updatedAt = now;
    profile.updatedBy = email;
    return id;
  });
}

export async function restoreTeamProfile(id: string, profileVersion: number, email: string) {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    const rows = await sql`
      UPDATE team_profiles
      SET deleted_at = NULL, deleted_by = NULL, version = version + 1,
          updated_at = NOW(), updated_by = ${email}
      WHERE id = ${id} AND version = ${profileVersion} AND deleted_at IS NOT NULL
      RETURNING id
    `;
    if (rows[0]) return id;
    const exists = await sql`SELECT id FROM team_profiles WHERE id = ${id}`;
    if (!exists[0]) throw new TeamNotFoundError("Team profile not found");
    throw new TeamConflictError("Team profile changed");
  }
  return mutateFile(async (store) => {
    const profile = store.profiles.find((item) => item.id === id) as typeof store.profiles[number] & { deletedAt?: string; deletedBy?: string };
    if (!profile) throw new TeamNotFoundError("Team profile not found");
    if (profile.version !== profileVersion || !profile.deletedAt) throw new TeamConflictError("Team profile changed");
    const now = new Date().toISOString();
    profile.deletedAt = "";
    profile.deletedBy = "";
    profile.version += 1;
    profile.updatedAt = now;
    profile.updatedBy = email;
    return id;
  });
}

export async function deleteTeamProfile(id: string, profileVersion: number) {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    return sql.begin(async (tx) => {
      const deleted = await tx`
        DELETE FROM team_profiles
        WHERE id = ${id} AND version = ${profileVersion} AND deleted_at IS NOT NULL
        RETURNING person_id
      `;
      if (!deleted[0]) {
        const exists = await tx`SELECT id FROM team_profiles WHERE id = ${id}`;
        if (!exists[0]) throw new TeamNotFoundError("Team profile not found");
        throw new TeamConflictError("Team profile changed");
      }
      const remaining = await tx`
        SELECT id FROM team_profiles WHERE person_id = ${deleted[0].person_id} LIMIT 1
      `;
      if (!remaining[0]) {
        await tx`
          DELETE FROM team_people
          WHERE id = ${deleted[0].person_id}
        `;
      }
      return id;
    });
  }
  return mutateFile(async (store) => {
    const profileIndex = store.profiles.findIndex((item) => item.id === id);
    if (profileIndex < 0) throw new TeamNotFoundError("Team profile not found");
    const profile = store.profiles[profileIndex];
    const person = store.people.find((item) => item.id === profile.personId)!;
    if (profile.version !== profileVersion || !(profile as typeof profile & { deletedAt?: string }).deletedAt) {
      throw new TeamConflictError("Team profile changed");
    }
    store.profiles.splice(profileIndex, 1);
    if (!store.profiles.some((item) => item.personId === person.id)) {
      store.people = store.people.filter((item) => item.id !== person.id);
    }
    return id;
  });
}

export async function reorderTeamProfiles(
  section: TeamSection,
  ordered: Array<{ id: string; version: number }>,
  email: string,
) {
  assertPersistence();
  const sql = sqlClient();
  if (sql) {
    return sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, version FROM team_profiles WHERE section = ${section} AND deleted_at IS NULL ORDER BY sort_order, id FOR UPDATE
      `;
      if (
        rows.length !== ordered.length ||
        rows.some((row) => !ordered.some((item) => item.id === row.id && item.version === Number(row.version)))
      ) {
        throw new TeamConflictError("Team profile order changed");
      }
      const nextOrder = ordered.map((item, index) => ({ id: item.id, sort_order: (index + 1) * 10 }));
      if (nextOrder.length) {
        await tx`
          UPDATE team_profiles AS profile
          SET sort_order = ordering.sort_order, version = profile.version + 1,
              updated_at = NOW(), updated_by = ${email}
          FROM jsonb_to_recordset(${tx.json(nextOrder)}::jsonb)
            AS ordering(id TEXT, sort_order INTEGER)
          WHERE profile.id = ordering.id
            AND profile.section = ${section}
            AND profile.deleted_at IS NULL
        `;
      }
      return true;
    });
  }
  return mutateFile(async (store) => {
    const current = store.profiles.filter((item) => item.section === section && !(item as typeof item & { deletedAt?: string }).deletedAt);
    if (
      current.length !== ordered.length ||
      current.some((profile) => !ordered.some((item) => item.id === profile.id && item.version === profile.version))
    ) {
      throw new TeamConflictError("Team profile order changed");
    }
    const now = new Date().toISOString();
    ordered.forEach((item, index) => {
      const profile = store.profiles.find((candidate) => candidate.id === item.id)!;
      profile.sortOrder = (index + 1) * 10;
      profile.version += 1;
      profile.updatedAt = now;
      profile.updatedBy = email;
    });
    return fromFile(store);
  });
}
