export const IMPACT_STATUSES = ["draft", "published", "archived"] as const;
export const IMPACT_KINDS = ["event", "metrics"] as const;

export type ImpactStatus = (typeof IMPACT_STATUSES)[number];
export type ImpactKind = (typeof IMPACT_KINDS)[number];

export type ImpactDescriptions = {
  zhHant: string;
  zhHans: string;
  en: string;
};

export type ImpactMilestone = {
  id: string;
  kind: ImpactKind;
  period: string;
  volunteers: number;
  volunteersPlus: boolean;
  students: number;
  studentsPlus: boolean;
  sessions: number;
  sessionsPlus: boolean;
  countries: number;
  countryNames: ImpactDescriptions;
  title: ImpactDescriptions;
  description: ImpactDescriptions;
  status: ImpactStatus;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  archivedAt?: string;
  archivedBy?: string;
  archivedFromStatus?: "draft" | "published";
};

export type ImpactMilestoneInput = Pick<
  ImpactMilestone,
  | "period"
  | "kind"
  | "volunteers"
  | "volunteersPlus"
  | "students"
  | "studentsPlus"
  | "sessions"
  | "sessionsPlus"
  | "countries"
  | "countryNames"
  | "title"
  | "description"
  | "status"
  | "sortOrder"
>;

export type ImpactMilestoneUpdateInput = ImpactMilestoneInput & {
  version: number;
};

export class ImpactValidationError extends Error {
  issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super("Invalid impact milestone");
    this.name = "ImpactValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCount(
  value: unknown,
  field: string,
  issues: Record<string, string>,
) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000_000) {
    issues[field] = "Must be an integer between 0 and 10,000,000";
    return 0;
  }
  return value;
}

function parseBoolean(
  value: unknown,
  field: string,
  issues: Record<string, string>,
) {
  if (typeof value !== "boolean") {
    issues[field] = "Must be true or false";
    return false;
  }
  return value;
}

function parseCountries(
  value: unknown,
  kind: ImpactKind,
  status: ImpactStatus,
  issues: Record<string, string>,
) {
  const countries = value == null ? 0 : Number(value);
  const maximum = 250;

  if (!Number.isInteger(countries) || countries < 0 || countries > maximum) {
    issues.countries = `Must be an integer between 0 and ${maximum}`;
    return 0;
  }
  if (kind === "event" && countries !== 0) {
    issues.countries = "Journey events cannot include country metrics";
  }
  if (kind === "metrics" && status === "published" && countries < 1) {
    issues.countries = "Published impact metrics must include at least one country";
  }
  return countries;
}

function parseCountryNames(
  value: unknown,
  kind: ImpactKind,
  status: ImpactStatus,
  issues: Record<string, string>,
): ImpactDescriptions {
  const source = isRecord(value) ? value : {};
  const result: ImpactDescriptions = { zhHant: "", zhHans: "", en: "" };

  for (const locale of Object.keys(result) as Array<keyof ImpactDescriptions>) {
    const text = typeof source[locale] === "string" ? source[locale].trim() : "";
    if (text.length > 500) {
      issues[`countryNames.${locale}`] = "Must be 500 characters or fewer";
    }
    if (kind === "event" && text) {
      issues[`countryNames.${locale}`] = "Journey events cannot include country names";
    }
    if (kind === "metrics" && status === "published" && !text) {
      issues[`countryNames.${locale}`] = "Required before publishing";
    }
    result[locale] = text;
  }

  return result;
}

function parseDescription(
  value: unknown,
  status: ImpactStatus,
  issues: Record<string, string>,
): ImpactDescriptions {
  const source = isRecord(value) ? value : {};
  const result: ImpactDescriptions = { zhHant: "", zhHans: "", en: "" };

  for (const locale of Object.keys(result) as Array<keyof ImpactDescriptions>) {
    const text = typeof source[locale] === "string" ? source[locale].trim() : "";
    if (text.length > 2_000) issues[`description.${locale}`] = "Must be 2,000 characters or fewer";
    if (status === "published" && !text) issues[`description.${locale}`] = "Required before publishing";
    result[locale] = text;
  }

  if (status === "draft" && !Object.values(result).some(Boolean)) {
    issues.description = "Add at least one language before saving a draft";
  }

  return result;
}

function parseTitle(
  value: unknown,
  kind: ImpactKind,
  status: ImpactStatus,
  issues: Record<string, string>,
): ImpactDescriptions {
  const source = isRecord(value) ? value : {};
  const result: ImpactDescriptions = { zhHant: "", zhHans: "", en: "" };

  for (const locale of Object.keys(result) as Array<keyof ImpactDescriptions>) {
    const text = typeof source[locale] === "string" ? source[locale].trim() : "";
    if (text.length > 200) issues[`title.${locale}`] = "Must be 200 characters or fewer";
    if (kind === "event" && status === "published" && !text) {
      issues[`title.${locale}`] = "Required before publishing";
    }
    result[locale] = text;
  }

  if (kind === "event" && status === "draft" && !Object.values(result).some(Boolean)) {
    issues.title = "Add at least one title before saving a draft";
  }

  return result;
}

export function parseImpactMilestoneInput(
  value: unknown,
  options: { requireVersion?: boolean } = {},
): ImpactMilestoneInput | ImpactMilestoneUpdateInput {
  const source = isRecord(value) ? value : {};
  const issues: Record<string, string> = {};
  const period = typeof source.period === "string" ? source.period.trim() : "";

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    issues.period = "Use YYYY-MM";
  }

  const status = IMPACT_STATUSES.includes(source.status as ImpactStatus)
    ? (source.status as ImpactStatus)
    : "draft";
  if (!IMPACT_STATUSES.includes(source.status as ImpactStatus)) {
    issues.status = "Must be draft, published, or archived";
  }
  const kind = IMPACT_KINDS.includes(source.kind as ImpactKind)
    ? (source.kind as ImpactKind)
    : "metrics";
  if (!IMPACT_KINDS.includes(source.kind as ImpactKind)) {
    issues.kind = "Must be event or metrics";
  }

  const defaultSortOrder = /^\d{4}-\d{2}$/.test(period)
    ? Number(period.replace("-", ""))
    : 0;
  const sortOrder = source.sortOrder == null ? defaultSortOrder : Number(source.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 99_999_999) {
    issues.sortOrder = "Must be a positive integer";
  }

  const parsed: ImpactMilestoneInput = {
    kind,
    period,
    volunteers: parseCount(source.volunteers, "volunteers", issues),
    volunteersPlus: parseBoolean(source.volunteersPlus, "volunteersPlus", issues),
    students: parseCount(source.students, "students", issues),
    studentsPlus: parseBoolean(source.studentsPlus, "studentsPlus", issues),
    sessions: parseCount(source.sessions, "sessions", issues),
    sessionsPlus: parseBoolean(source.sessionsPlus, "sessionsPlus", issues),
    countries: parseCountries(source.countries, kind, status, issues),
    countryNames: parseCountryNames(source.countryNames, kind, status, issues),
    title: parseTitle(source.title, kind, status, issues),
    description: parseDescription(source.description, status, issues),
    status,
    sortOrder: Number.isInteger(sortOrder) ? sortOrder : defaultSortOrder,
  };

  if (options.requireVersion) {
    const version = Number(source.version);
    if (!Number.isInteger(version) || version < 1) issues.version = "A valid version is required";
    if (Object.keys(issues).length) throw new ImpactValidationError(issues);
    return { ...parsed, version };
  }

  if (Object.keys(issues).length) throw new ImpactValidationError(issues);
  return parsed;
}

export function publicImpactMilestone(milestone: ImpactMilestone) {
  return {
    id: milestone.id,
    kind: milestone.kind,
    period: milestone.period,
    volunteers: milestone.volunteers,
    volunteersPlus: milestone.volunteersPlus,
    students: milestone.students,
    studentsPlus: milestone.studentsPlus,
    sessions: milestone.sessions,
    sessionsPlus: milestone.sessionsPlus,
    countries: milestone.countries,
    countryNames: milestone.countryNames,
    title: milestone.title,
    description: milestone.description,
    status: milestone.status,
    sortOrder: milestone.sortOrder,
    version: milestone.version,
    updatedAt: milestone.updatedAt,
  };
}
