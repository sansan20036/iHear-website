import { beforeEach, describe, expect, test, vi } from "vitest";

const postgres = vi.hoisted(() => vi.fn());

vi.mock("postgres", () => ({ default: postgres }));
vi.mock("../lib/translation-state", () => ({
  saveTranslationStates: vi.fn(),
  upsertTranslationStatesInTransaction: vi.fn(),
}));

describe("team profile PostgreSQL ordering", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/ihear");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "0");
    delete globalThis.ihearTeamSql;
    postgres.mockReset();
  });

  test("uses a JSON recordset for one atomic bulk update", async () => {
    const queries = [];
    const json = vi.fn((value) => ({ serialized: value }));
    const tx = vi.fn(async (strings, ...values) => {
      if (!strings?.raw) throw new TypeError("SQL must be called as a tagged template");
      const text = strings.join("?");
      queries.push({ text, values });
      if (text.includes("SELECT id, version")) {
        return [
          { id: "tutor-amber", version: 4 },
          { id: "tutor-tristan", version: 2 },
        ];
      }
      return [];
    });
    tx.json = json;
    const sql = Object.assign(vi.fn(), {
      begin: vi.fn((callback) => callback(tx)),
    });
    postgres.mockReturnValue(sql);

    const { reorderTeamProfiles } = await import("../lib/team-store");
    await reorderTeamProfiles("tutor", [
      { id: "tutor-amber", version: 4 },
      { id: "tutor-tristan", version: 2 },
    ], "admin@example.com");

    expect(sql.begin).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith([
      { id: "tutor-amber", sort_order: 10 },
      { id: "tutor-tristan", sort_order: 20 },
    ]);
    const update = queries.find((query) => query.text.includes("UPDATE team_profiles"));
    expect(update?.text).toContain("jsonb_to_recordset");
    expect(update?.text).toContain("AS ordering(id TEXT, sort_order INTEGER)");
    expect(update?.text).toContain("profile.section");
    expect(update?.text).toContain("profile.deleted_at IS NULL");
  });
});

describe("team translation provenance on update", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/ihear");
    vi.stubEnv("POSTGRES_URL", "");
    vi.stubEnv("IHEAR_FORCE_FILE_STORE", "0");
    delete globalThis.ihearTeamSql;
  });

  async function fixture() {
    const { TEAM_LOCALIZED_FIELDS } = await import("../lib/team-types");
    const row = { id: "tutor-test", person_id: "person-test", section: "tutor", status: "published", profile_version: 2, person_version: 2 };
    const input = { name: "New name", initials: "NN", consentConfirmed: true, profileVersion: 1, personVersion: 1 };
    for (const field of TEAM_LOCALIZED_FIELDS) {
      input[field] = { en: "Hello", zhHant: "你好", zhHans: "你好" };
      const prefix = field === "schoolDisplay" ? "school_display" : field;
      row[`${prefix}_en`] = "Hello";
      row[`${prefix}_zh_hant`] = "你好";
      row[`${prefix}_zh_hans`] = "你好";
    }
    const queries = [];
    const tx = vi.fn(async (strings) => {
      const text = strings.join("?");
      queries.push(text);
      if (text.includes("FOR UPDATE")) return [row];
      return [{ id: "tutor-test" }];
    });
    tx.unsafe = vi.fn().mockResolvedValue([row]);
    postgres.mockReturnValue({ begin: vi.fn((callback) => callback(tx)) });
    const store = await import("../lib/team-store");
    const states = await import("../lib/translation-state");
    return { input, queries, tx, store, states };
  }

  test("saving a name change does not relabel any Chinese as manual", async () => {
    const { input, store, states, tx, queries } = await fixture();
    await store.updateTeamProfile("tutor-test", input, "test@example.org");
    expect(queries[0]).toContain("FOR UPDATE");
    expect(states.upsertTranslationStatesInTransaction).toHaveBeenCalledWith(
      tx, { type: "team", scope: "", id: "tutor-test" }, [], "test@example.org",
    );
  });

  test("only the edited Chinese field receives manual provenance", async () => {
    const { input, store, states } = await fixture();
    input.role.zhHant = "您好";
    await store.updateTeamProfile("tutor-test", input, "test@example.org");
    expect(states.upsertTranslationStatesInTransaction.mock.calls[0][2]).toEqual([
      expect.objectContaining({ field: "role", locale: "zhHant", origin: "manual" }),
    ]);
  });

  test("rejects stale Chinese before any database update when English changed without a receipt", async () => {
    const { input, store, states, queries } = await fixture();
    input.role.en = "World";
    await expect(store.updateTeamProfile("tutor-test", input, "test@example.org"))
      .rejects.toMatchObject({ code: "TRANSLATION_RECEIPT_INVALID" });
    expect(queries.some((text) => /UPDATE team_/.test(text))).toBe(false);
    expect(states.upsertTranslationStatesInTransaction).not.toHaveBeenCalled();
  });

  test("keeps verified preview provenance when saving newly translated English", async () => {
    const { input, store, states } = await fixture();
    input.role = { en: "World", zhHant: "世界", zhHans: "世界" };
    const writes = [{ field: "role", locale: "zhHant", origin: "machine", sourceHash: "verified", glossaryVersion: "test" }];
    await store.updateTeamProfile("tutor-test", input, "test@example.org", writes);
    expect(states.upsertTranslationStatesInTransaction.mock.calls[0][2]).toEqual(writes);
  });
});
