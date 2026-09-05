export const TEAM_SECTIONS = ["leader", "tutor"] as const;
export const TEAM_STATUSES = ["draft", "published"] as const;
export const TEAM_LOCALIZED_FIELDS = [
  "role",
  "schoolDisplay",
  "languages",
  "strengths",
  "summary",
  "bio",
  "hobbies",
] as const;

export type TeamSection = (typeof TEAM_SECTIONS)[number];
export type TeamStatus = (typeof TEAM_STATUSES)[number];
export type TeamLocalizedField = (typeof TEAM_LOCALIZED_FIELDS)[number];
export type LocalizedText = { en: string; zhHant: string; zhHans: string };

export type TeamPersonSeed = {
  id: string;
  name: string;
  initials: string;
  publicationConsentAt: string;
  publicationConsentBy: string;
};

export type TeamProfileSeed = {
  id: string;
  personId: string;
  section: TeamSection;
  status: TeamStatus;
  sortOrder: number;
  school: string;
  grade: string;
  showSchool: boolean;
  showGrade: boolean;
  role: LocalizedText;
  schoolDisplay: LocalizedText;
  languages: LocalizedText;
  strengths: LocalizedText;
  summary: LocalizedText;
  bio: LocalizedText;
  hobbies: LocalizedText;
};

export type TeamProfile = TeamProfileSeed & {
  name: string;
  initials: string;
  publicationConsentAt: string | null;
  profileVersion: number;
  personVersion: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt: string | null;
  deletedBy: string | null;
};

export type TeamProfileInput = Omit<
  TeamProfileSeed,
  "id" | "personId" | "sortOrder"
> & {
  personId?: string;
  name: string;
  initials: string;
  consentConfirmed: boolean;
  sortOrder?: number;
};

export type TeamProfileUpdateInput = TeamProfileInput & {
  profileVersion: number;
  personVersion: number;
};

export class TeamValidationError extends Error {
  issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super("Invalid team profile");
    this.name = "TeamValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(
  value: unknown,
  field: string,
  issues: Record<string, string>,
  maximum: number,
) {
  const parsed = typeof value === "string" ? value.trim() : "";
  if (parsed.length > maximum) issues[field] = `Must be ${maximum} characters or fewer`;
  return parsed;
}

function localized(
  value: unknown,
  field: string,
  issues: Record<string, string>,
  maximum: number,
): LocalizedText {
  const source = isRecord(value) ? value : {};
  return {
    en: text(source.en, `${field}.en`, issues, maximum),
    zhHant: text(source.zhHant, `${field}.zhHant`, issues, maximum),
    zhHans: text(source.zhHans, `${field}.zhHans`, issues, maximum),
  };
}

export function parseTeamProfileInput(
  value: unknown,
  options: { requireVersion?: boolean } = {},
): TeamProfileInput | TeamProfileUpdateInput {
  const source = isRecord(value) ? value : {};
  const issues: Record<string, string> = {};
  const section = TEAM_SECTIONS.includes(source.section as TeamSection)
    ? (source.section as TeamSection)
    : "tutor";
  const status = TEAM_STATUSES.includes(source.status as TeamStatus)
    ? (source.status as TeamStatus)
    : "draft";

  if (!TEAM_SECTIONS.includes(source.section as TeamSection)) issues.section = "Invalid section";
  if (!TEAM_STATUSES.includes(source.status as TeamStatus)) issues.status = "Invalid status";

  const parsed: TeamProfileInput = {
    personId:
      typeof source.personId === "string" && source.personId.trim()
        ? source.personId.trim()
        : undefined,
    name: text(source.name, "name", issues, 160),
    initials: text(source.initials, "initials", issues, 8).toUpperCase(),
    consentConfirmed: source.consentConfirmed === true,
    section,
    status,
    sortOrder:
      source.sortOrder == null ? undefined : Number(source.sortOrder),
    school: text(source.school, "school", issues, 300),
    grade: text(source.grade, "grade", issues, 40),
    showSchool: source.showSchool === true,
    showGrade: source.showGrade === true,
    role: localized(source.role, "role", issues, 500),
    schoolDisplay: localized(source.schoolDisplay, "schoolDisplay", issues, 300),
    languages: localized(source.languages, "languages", issues, 500),
    strengths: localized(source.strengths, "strengths", issues, 1_000),
    summary: localized(source.summary, "summary", issues, 2_000),
    bio: localized(source.bio, "bio", issues, 5_000),
    hobbies: localized(source.hobbies, "hobbies", issues, 2_000),
  };

  if (!parsed.name) issues.name = "Name is required";
  if (!parsed.initials) issues.initials = "Initials are required";
  if (parsed.showSchool && !parsed.school) issues.school = "School is required when public";
  if (parsed.showGrade && !parsed.grade) issues.grade = "Grade is required when public";
  if (
    parsed.sortOrder != null &&
    (!Number.isInteger(parsed.sortOrder) || parsed.sortOrder < 0 || parsed.sortOrder > 1_000_000)
  ) {
    issues.sortOrder = "Sort order must be a positive integer";
  }

  if (status === "published") {
    if (!parsed.consentConfirmed) issues.consentConfirmed = "Confirm publication consent";
    const requiredFields = new Set<TeamLocalizedField>([
      "role",
      "bio",
      ...(section === "tutor" ? (["summary"] as TeamLocalizedField[]) : []),
    ]);
    for (const field of TEAM_LOCALIZED_FIELDS) {
      const localizedValue = parsed[field];
      const requiresCompleteTranslation = requiredFields.has(field)
        || Boolean(localizedValue.en || localizedValue.zhHant || localizedValue.zhHans);
      if (!requiresCompleteTranslation) continue;
      if (!localizedValue.en) issues[`${field}.en`] = "English content is required before publishing";
      if (!localizedValue.zhHant) issues[`${field}.zhHant`] = "Traditional Chinese translation is required before publishing";
      if (!localizedValue.zhHans) issues[`${field}.zhHans`] = "Simplified Chinese translation is required before publishing";
    }
  }

  if (options.requireVersion) {
    const profileVersion = Number(source.profileVersion);
    const personVersion = Number(source.personVersion);
    if (!Number.isInteger(profileVersion) || profileVersion < 1) {
      issues.profileVersion = "A valid profile version is required";
    }
    if (!Number.isInteger(personVersion) || personVersion < 1) {
      issues.personVersion = "A valid person version is required";
    }
    if (Object.keys(issues).length) throw new TeamValidationError(issues);
    return { ...parsed, profileVersion, personVersion };
  }

  if (Object.keys(issues).length) throw new TeamValidationError(issues);
  return parsed;
}

export function publicTeamProfile(profile: TeamProfile) {
  return {
    id: profile.id,
    personId: profile.personId,
    section: profile.section,
    status: "published" as const,
    name: profile.name,
    initials: profile.initials,
    school: profile.showSchool ? profile.school : "",
    grade: profile.showGrade ? profile.grade : "",
    showSchool: profile.showSchool,
    showGrade: profile.showGrade,
    role: profile.role,
    schoolDisplay: profile.schoolDisplay,
    languages: profile.languages,
    strengths: profile.strengths,
    summary: profile.summary,
    bio: profile.bio,
    hobbies: profile.hobbies,
    sortOrder: profile.sortOrder,
    profileVersion: profile.profileVersion,
    personVersion: profile.personVersion,
    updatedAt: profile.updatedAt,
  };
}
